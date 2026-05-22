// TTS pipeline
// - 优先 Fish Audio（设置 FISH_API_KEY 启用）
// - 回退 macOS `say` + `afconvert`（开发本地能听见声音）
// - 文件按 hash 缓存到 cache/tts/<hash>.<ext>
// - 缓存命中跨重启复用；切换 engine/voice 会自动失效（key 含在 hash 里）

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'cache/tts');

const FISH_API_KEY = process.env.FISH_API_KEY;
const FISH_VOICE_ID = process.env.FISH_VOICE_ID;
const FISH_ENDPOINT = process.env.FISH_ENDPOINT ?? 'https://api.fish.audio/v1/tts';
const SAY_VOICE = process.env.SAY_VOICE ?? 'Tingting'; // macOS 中文女声

mkdirSync(CACHE_DIR, { recursive: true });

const EXT_MIME = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aiff: 'audio/aiff',
  wav: 'audio/wav',
};

export function engineInfo() {
  if (FISH_API_KEY) {
    return { engine: 'fish', voice: FISH_VOICE_ID ?? '(default)' };
  }
  if (existsSync('/usr/bin/say')) {
    return { engine: 'macos-say', voice: SAY_VOICE };
  }
  return { engine: 'none', voice: null };
}

function engineTag() {
  const info = engineInfo();
  return `${info.engine}:${info.voice ?? ''}`;
}

export async function synthesize(text) {
  if (!text || !String(text).trim()) {
    return { hash: null, url: null, file: null, engine: 'noop', cached: false, bytes: 0 };
  }
  const clean = String(text).trim();
  const hash = crypto.createHash('sha256').update(`${engineTag()}::${clean}`).digest('hex').slice(0, 16);

  // cache lookup
  for (const ext of Object.keys(EXT_MIME)) {
    const file = path.join(CACHE_DIR, `${hash}.${ext}`);
    if (existsSync(file)) {
      const stat = await fs.stat(file);
      return {
        hash, file,
        url: `/tts/${hash}.${ext}`,
        mime: EXT_MIME[ext],
        engine: 'cache',
        cached: true,
        bytes: stat.size,
      };
    }
  }

  // fresh
  if (FISH_API_KEY) return synthFish(clean, hash);
  if (existsSync('/usr/bin/say')) return synthMacSay(clean, hash);
  throw new Error('no TTS engine available (set FISH_API_KEY or run on macOS)');
}

async function synthFish(text, hash) {
  const file = path.join(CACHE_DIR, `${hash}.mp3`);
  const body = { text, format: 'mp3' };
  if (FISH_VOICE_ID) body.reference_id = FISH_VOICE_ID;

  const res = await fetch(FISH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FISH_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Fish ${res.status}: ${detail}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(file, buf);
  return {
    hash, file,
    url: `/tts/${hash}.mp3`,
    mime: 'audio/mpeg',
    engine: 'fish',
    cached: false,
    bytes: buf.length,
  };
}

async function synthMacSay(text, hash) {
  const aiff = path.join(CACHE_DIR, `${hash}.aiff`);
  const m4a = path.join(CACHE_DIR, `${hash}.m4a`);
  await runCmd('say', ['-v', SAY_VOICE, '-o', aiff, text]);
  try {
    await runCmd('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, m4a]);
    await fs.unlink(aiff).catch(() => {});
    const stat = await fs.stat(m4a);
    return {
      hash, file: m4a,
      url: `/tts/${hash}.m4a`,
      mime: 'audio/mp4',
      engine: 'macos-say',
      cached: false,
      bytes: stat.size,
    };
  } catch {
    const stat = await fs.stat(aiff);
    return {
      hash, file: aiff,
      url: `/tts/${hash}.aiff`,
      mime: 'audio/aiff',
      engine: 'macos-say',
      cached: false,
      bytes: stat.size,
    };
  }
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    cp.stderr.on('data', d => { err += d; });
    cp.on('error', reject);
    cp.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}
