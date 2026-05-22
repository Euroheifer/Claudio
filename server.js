// 时区：默认新加坡。`export TZ=...` 可覆盖。
// 必须在所有 import 之前设置，确保 Date 全程统一。
process.env.TZ ??= 'Asia/Singapore';

import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as state from './src/state.js';
import { route } from './src/router.js';
import { readUserCorpus } from './src/context.js';
import * as scheduler from './src/scheduler.js';
import * as tts from './src/tts.js';
import * as ncm from './src/ncm.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

state.init();

// 首次启动从 user/*.example.* 复制出 user/*.*（如果还没有）
(function bootstrapUserCorpus() {
  const userDir = path.join(ROOT, 'user');
  if (!fs.existsSync(userDir)) return;
  for (const f of fs.readdirSync(userDir)) {
    if (!f.includes('.example.')) continue;
    const real = f.replace('.example.', '.');
    const realPath = path.join(userDir, real);
    if (!fs.existsSync(realPath)) {
      fs.copyFileSync(path.join(userDir, f), realPath);
      console.log(`[init] created user/${real} from example`);
    }
  }
})();

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.use('/tts', express.static(path.join(ROOT, 'cache/tts')));

app.post('/api/chat', async (req, res) => {
  const { message } = req.body ?? {};
  if (!message) return res.status(400).json({ error: 'message required' });

  state.addMessage('user', message);
  try {
    const result = await route(message);
    state.addMessage('assistant', JSON.stringify(result));
    broadcast({ type: 'chat', result });
    res.json(result);
    if (result.kind === 'claude' && Array.isArray(result.play) && result.play.length) {
      resolveAndBroadcastQueue(result.play);
    }
  } catch (e) {
    console.error('[chat]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/now', (_req, res) => {
  res.json(state.getPref('now_playing'));
});

app.get('/api/next', (_req, res) => {
  res.json(state.getPref('queue') ?? []);
});

app.get('/api/taste', (_req, res) => {
  res.json(readUserCorpus());
});

app.get('/api/plan/today', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.json(state.getPlan(today));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), tts: tts.engineInfo() });
});

// ---- NCM ----
app.get('/api/ncm/status', async (_req, res) => {
  try { res.json(await ncm.status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 登录：拿 QR
app.post('/api/ncm/login/qr', async (_req, res) => {
  try {
    const { unikey } = await ncm.loginQrKey();
    if (!unikey) return res.status(502).json({ error: 'failed to get unikey' });
    const { qrimg } = await ncm.loginQrCreate(unikey);
    res.json({ key: unikey, qrimg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 登录：轮询状态。803 成功时落库并返回 profile
app.get('/api/ncm/login/check', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const r = await ncm.loginQrCheck(String(key));
    if (r.code === 803 && r.cookie) {
      ncm.setCookie(r.cookie);
      const s = await ncm.status();
      return res.json({ code: 803, message: r.message, profile: s.profile ?? null });
    }
    res.json({ code: r.code, message: r.message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ncm/logout', async (_req, res) => {
  try { await ncm.logout(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ncm/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    res.json({ q, hits: await ncm.search(String(q), { limit: 10 }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ncm/song/:id', async (req, res) => {
  try { res.json(await ncm.songUrl(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 音频流代理：替浏览器去 NCM CDN 拿原始流，加 Referer 绕防盗链，原样透传 Range
app.get('/api/ncm/stream/:id', async (req, res) => {
  const id = req.params.id;
  let info;
  try {
    info = await ncm.songUrl(id);
  } catch (e) {
    return res.status(502).json({ error: `songUrl failed: ${e.message}` });
  }
  if (!info.url) {
    return res.status(404).json({
      error: 'no playable url',
      hint: 'song is VIP/region-locked or unavailable; try NCM_COOKIE',
      info,
    });
  }

  const range = req.headers.range;
  let upstream;
  try {
    upstream = await fetch(info.url, {
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0',
        ...(range ? { Range: range } : {}),
      },
    });
  } catch (e) {
    return res.status(502).json({ error: `upstream fetch failed: ${e.message}` });
  }
  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
  }

  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');

  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
});

app.get('/api/ncm/lyric/:id', async (req, res) => {
  try { res.json(await ncm.lyric(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 手动解析 + 广播队列（既是调试入口，也允许外部直接喂 queue）
app.post('/api/queue/resolve', async (req, res) => {
  const { queries } = req.body ?? {};
  if (!Array.isArray(queries)) return res.status(400).json({ error: 'queries[] required' });
  try {
    const items = await ncm.resolveMany(queries);
    state.setPref('queue', items);
    broadcast({ type: 'queue', items });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/say', async (req, res) => {
  const { text } = req.body ?? {};
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const out = await tts.synthesize(text);
    res.json(out);
  } catch (e) {
    console.error('[say]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/scheduler', (_req, res) => {
  res.json(scheduler.status());
});

app.post('/api/scheduler/fire/:name', async (req, res) => {
  try {
    const ev = await scheduler.fire(req.params.name);
    res.json(ev);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 日历 webhook — Feishu / Apple Calendar / 任何外部源都可以 POST 到这里
// TODO: 加签名校验（HMAC 或共享 secret），目前假设 LAN-only
app.post('/api/hook/calendar', async (req, res) => {
  const event = req.body;
  if (!event || typeof event !== 'object' || !event.title) {
    return res.status(400).json({ error: 'event with title required' });
  }
  try {
    const ev = await scheduler.calendarHook(event);
    res.json(ev);
  } catch (e) {
    console.error('[hook/calendar]', e);
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(s);
  }
}

scheduler.start({ onTick: async ev => {
  broadcast({ type: 'tick', ev });
  if (ev.result?.play?.length) {
    resolveAndBroadcastQueue(ev.result.play);
  }
}});

async function resolveAndBroadcastQueue(queries) {
  try {
    const items = await ncm.resolveMany(queries);
    state.setPref('queue', items);
    broadcast({ type: 'queue', items });
  } catch (e) {
    console.error('[resolveQueue]', e);
  }
}

const PORT = process.env.PORT ?? 8080;
server.listen(PORT, () => {
  console.log(`Claudio listening on http://localhost:${PORT}`);
});

const shutdown = () => {
  console.log('\nshutting down...');
  scheduler.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
