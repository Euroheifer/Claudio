// Claudio PWA client

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const escape = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---- big clock ----
function tickClock() {
  const now = new Date();
  $('#clock-time').textContent = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  $('#clock-day').textContent = now.toLocaleDateString('en-US', { weekday: 'long' });
  $('#clock-date').textContent = now.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  }).toUpperCase();
}
tickClock();
setInterval(tickClock, 1000);

// ---- view switching ----
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.view;
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === target));
    if (target === 'profile') loadProfile();
    if (target === 'settings') loadSettings();
  });
});

// ---- WebSocket ----
let ws = null;
let reconnectMs = 1000;

function setStatus(state) { $('#status').dataset.state = state; $('#status').textContent = state; }

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/stream`);
  setStatus('connecting');
  ws.addEventListener('open', () => { setStatus('open'); reconnectMs = 1000; });
  ws.addEventListener('close', () => {
    setStatus('closed');
    setTimeout(connectWS, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, 15000);
  });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  ws.addEventListener('message', ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleEvent(msg);
  });
}

function handleEvent(msg) {
  if (msg.type === 'hello') {
    appendSys('connected');
    return;
  }
  if (msg.type === 'chat' && msg.result) {
    renderResult(msg.result);
    return;
  }
  if (msg.type === 'now') {
    renderNow(msg.track);
    return;
  }
  if (msg.type === 'queue') {
    renderQueue(msg.items ?? []);
    return;
  }
  if (msg.type === 'tick') {
    const ev = msg.ev ?? {};
    if (ev.error) {
      appendSys(`[${ev.kind}] error: ${ev.error}`);
    } else if (ev.result) {
      appendSys(`[scheduler · ${ev.kind}]`);
      renderResult({ kind: 'claude', ...ev.result });
    }
    return;
  }
}

// ---- chat ----
const log = $('#chat-log');
const form = $('#chat-form');
const input = $('#chat-input');

function appendSys(text) {
  const el = document.createElement('div');
  el.className = 'msg sys';
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function appendUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

async function maybeSpeak(text) {
  if (!text || !text.trim()) return;
  try {
    const r = await fetch('/api/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const out = await r.json();
    if (!out.url) return;
    const audio = $('#audio');
    audio.src = out.url;
    _source = { kind: 'say' };
    audio.play().catch(() => { /* autoplay blocked outside user gesture */ });
  } catch { /* ignore */ }
}

function renderResult(result) {
  // dedupe whichever side arrives second (HTTP 响应 与 WS 广播会两边都来)
  if (log.lastChild?.dataset?.fingerprint === fingerprint(result)) return;

  const el = document.createElement('div');
  el.className = 'msg dj';
  el.dataset.fingerprint = fingerprint(result);

  if (result.kind === 'cmd') {
    el.textContent = `→ ${result.action}`;
  } else if (result.kind === 'music') {
    el.innerHTML = `🎵 搜索 <b>${escape(result.query)}</b>`;
  } else if (result.kind === 'claude') {
    const say = escape(result.say || '(无)');
    const plays = (result.play || []).map(s => `<li>${escape(s)}</li>`).join('');
    const reason = result.reason ? `<div class="reason">why: ${escape(result.reason)}</div>` : '';
    el.innerHTML = `
      <div>${say}</div>
      ${plays ? `<ol class="play">${plays}</ol>` : ''}
      ${reason}
    `;
  } else if (result.error) {
    el.classList.replace('dj', 'sys');
    el.textContent = `error: ${result.error}`;
  } else {
    el.textContent = JSON.stringify(result);
  }

  log.appendChild(el);
  log.scrollTop = log.scrollHeight;

  if (result.kind === 'claude' && result.play?.length) {
    renderQueue(result.play);
  }
  if (result.kind === 'claude' && result.say) {
    maybeSpeak(result.say);
  }
}

function fingerprint(r) {
  return `${r.kind}:${r.action ?? ''}:${r.query ?? ''}:${(r.say ?? '').slice(0, 40)}`;
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendUser(text);
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const json = await res.json();
    renderResult(json);
  } catch (err) {
    renderResult({ error: err.message });
  } finally {
    btn.disabled = false;
    input.focus();
  }
});

// ---- now / queue / 播放链 ----
//
// 播放链路状态机：
//   _source = { kind: 'say' }                — 当前正在放 TTS
//             { kind: 'queue', idx: N }      — 当前正在放队列第 N 首
//             null                            — 空闲
// audio.ended 事件触发 advance()：
//   say -> queue[0]
//   queue[i] -> queue[i+1]（到末尾就停）
let _playlist = [];
let _source = null;

function renderNow(track) {
  if (!track || !track.title) {
    $('#now-title').textContent = '—';
    return;
  }
  $('#now-title').textContent = track.artist
    ? `${track.title} — ${track.artist}`
    : track.title;
}

function setPlayerState(s) {
  const stateEl = $('#player-state');
  if (stateEl) stateEl.textContent = s;
  const player = document.querySelector('.player');
  if (player) player.classList.toggle('is-idle', s === 'IDLE' || s === 'PAUSED');
}

// renderQueue 兼容两种形状：未 resolve 的字符串数组（来自 claude 立刻返回的 play[]）
// 和已 resolve 的对象数组（来自 WS / /api/next）
function renderQueue(items) {
  if (!Array.isArray(items)) items = [];
  const looksResolved = items.length > 0 && typeof items[0] === 'object' && items[0] !== null;
  if (looksResolved) {
    renderResolvedQueue(items);
  } else {
    renderRawQueue(items);
  }
}

function renderRawQueue(items) {
  const ol = $('#queue');
  ol.innerHTML = '';
  _playlist = [];
  $('#queue-count').textContent = `${items.length} TRACK${items.length === 1 ? '' : 'S'}`;
  for (const [i, item] of items.entries()) {
    const num = String(i + 1).padStart(2, '0');
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="idx">${num}</span>
      <span class="name muted">${escape(item)}</span>
      <span class="artists muted">resolving…</span>
    `;
    ol.appendChild(li);
  }
}

function renderResolvedQueue(items) {
  _playlist = items.filter(x => x.status === 'matched');
  const ol = $('#queue');
  ol.innerHTML = '';
  $('#queue-count').textContent = `${items.length} TRACK${items.length === 1 ? '' : 'S'}`;
  for (const [i, item] of items.entries()) {
    const num = String(i + 1).padStart(2, '0');
    const li = document.createElement('li');
    if (item.status === 'matched') {
      li.className = 'matched';
      const idx = _playlist.findIndex(x => x.id === item.id);
      li.dataset.idx = idx;
      li.innerHTML = `
        <span class="idx">${num}</span>
        <span class="name">${escape(item.name)}</span>
        <span class="artists">${escape((item.artists || []).join(', '))}</span>
      `;
      li.title = '点击播放';
      li.addEventListener('click', () => playQueueIdx(idx));
    } else {
      li.innerHTML = `
        <span class="idx">${num}</span>
        <span class="name muted">${escape(item.query)}</span>
        <span class="artists" style="color:var(--err)">未匹配</span>
      `;
    }
    ol.appendChild(li);
  }
  markCurrentInQueue();
}

function markCurrentInQueue() {
  const lis = $$('.queue li');
  lis.forEach((li, i) => {
    const num = String(i + 1).padStart(2, '0');
    const idxEl = li.querySelector('.idx');
    if (!idxEl) return;
    const isCurrent = _source?.kind === 'queue'
      && li.classList.contains('matched')
      && Number(li.dataset.idx) === _source.idx;
    li.classList.toggle('current', isCurrent);
    idxEl.textContent = isCurrent ? '▶' : num;
  });
}

function playQueueIdx(idx) {
  if (idx < 0 || idx >= _playlist.length) {
    _source = null;
    markCurrentInQueue();
    return;
  }
  const item = _playlist[idx];
  const src = `/api/ncm/stream/${item.id}`;
  const audio = $('#audio');
  audio.src = src;
  _source = { kind: 'queue', idx };
  audio.play().catch(e => appendSys(`play failed: ${e.message}`));
  renderNow({ title: item.name, artist: (item.artists || []).join(' / ') });
  markCurrentInQueue();
}

// ---- audio element wiring ----
const _audio = $('#audio');
_audio.volume = 0.8;

_audio.addEventListener('ended', () => {
  if (!_source) { setPlayerState('IDLE'); return; }
  if (_source.kind === 'say') {
    if (_playlist.length) playQueueIdx(0);
    else { _source = null; setPlayerState('IDLE'); }
  } else if (_source.kind === 'queue') {
    playQueueIdx(_source.idx + 1);
  }
});

_audio.addEventListener('play',  () => {
  setPlayerState('PLAYING');
  $('#btn-play').textContent = '❚❚';
});
_audio.addEventListener('pause', () => {
  setPlayerState(_audio.currentTime > 0 && _audio.currentTime < _audio.duration ? 'PAUSED' : 'IDLE');
  $('#btn-play').textContent = '▶';
});

_audio.addEventListener('timeupdate', () => {
  $('#cur-time').textContent = fmtTime(_audio.currentTime);
  const ratio = _audio.duration ? _audio.currentTime / _audio.duration : 0;
  $('#progress-fill').style.width = `${(ratio * 100).toFixed(2)}%`;
});
_audio.addEventListener('loadedmetadata', () => {
  $('#dur-time').textContent = fmtTime(_audio.duration);
});

// transport
$('#btn-play').addEventListener('click', () => {
  if (_audio.paused) {
    if (_audio.src) _audio.play().catch(() => {});
    else if (_playlist.length) playQueueIdx(0);
  } else {
    _audio.pause();
  }
});
$('#btn-prev').addEventListener('click', () => {
  if (_source?.kind === 'queue' && _source.idx > 0) playQueueIdx(_source.idx - 1);
});
$('#btn-next').addEventListener('click', () => {
  if (_source?.kind === 'queue') playQueueIdx(_source.idx + 1);
  else if (_playlist.length) playQueueIdx(0);
});
$('#btn-stop').addEventListener('click', () => {
  _audio.pause();
  _audio.currentTime = 0;
  _source = null;
  setPlayerState('IDLE');
  markCurrentInQueue();
});

// seek
$('#progress-bar').addEventListener('click', e => {
  if (!_audio.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  _audio.currentTime = Math.max(0, Math.min(_audio.duration, ratio * _audio.duration));
});

// volume
$('#vol').addEventListener('input', e => {
  _audio.volume = Math.max(0, Math.min(1, Number(e.target.value) / 100));
});

setPlayerState('IDLE');

async function loadNow() {
  try {
    const [now, next] = await Promise.all([
      fetch('/api/now').then(r => r.json()),
      fetch('/api/next').then(r => r.json()),
    ]);
    if (now) renderNow(now);
    renderQueue(Array.isArray(next) ? next : []);
  } catch {}
}

// ---- profile view ----
async function loadProfile() {
  try {
    const [taste, plan] = await Promise.all([
      fetch('/api/taste').then(r => r.json()),
      fetch('/api/plan/today').then(r => r.json()),
    ]);
    const host = $('#taste');
    host.innerHTML = '';
    for (const [name, body] of Object.entries(taste || {})) {
      const sec = document.createElement('section');
      sec.innerHTML = `<h3>${escape(name)}</h3><pre>${escape(body)}</pre>`;
      host.appendChild(sec);
    }
    if (!Object.keys(taste || {}).length) host.textContent = '(no corpus yet)';
    $('#plan').textContent = plan ? JSON.stringify(plan, null, 2) : 'none';
  } catch (e) {
    $('#taste').textContent = `error: ${e.message}`;
  }
}

// ---- settings view ----
async function loadSettings() {
  $('#set-server').textContent = location.origin;
  $('#set-ws').textContent = ws?.readyState === 1 ? 'open' : 'closed';
  try {
    const h = await fetch('/api/health').then(r => r.json());
    $('#set-uptime').textContent = `${Math.round(h.uptime)}s`;
  } catch {
    $('#set-uptime').textContent = '?';
  }
  refreshNCMLoginState();
}

// ---- NCM 登录 ----
let _ncmPoll = null;

async function refreshNCMLoginState() {
  const stateEl = $('#ncm-state');
  const loginBtn = $('#ncm-login-btn');
  const logoutBtn = $('#ncm-logout-btn');
  const qrWrap = $('#ncm-qr-wrap');
  qrWrap.hidden = true;
  stateEl.textContent = '查询中…';
  try {
    const s = await fetch('/api/ncm/status').then(r => r.json());
    if (s.loggedIn) {
      stateEl.innerHTML = `已登录 · <b>${escape(s.profile?.nickname ?? '?')}</b>`;
      loginBtn.hidden = true;
      logoutBtn.hidden = false;
    } else {
      stateEl.textContent = '未登录';
      loginBtn.hidden = false;
      logoutBtn.hidden = true;
    }
  } catch (e) {
    stateEl.textContent = `查询失败: ${e.message}`;
  }
}

$('#ncm-login-btn').addEventListener('click', startNCMLogin);
$('#ncm-logout-btn').addEventListener('click', async () => {
  $('#ncm-logout-btn').disabled = true;
  try { await fetch('/api/ncm/logout', { method: 'POST' }); }
  finally { $('#ncm-logout-btn').disabled = false; refreshNCMLoginState(); }
});

async function startNCMLogin() {
  const btn = $('#ncm-login-btn');
  btn.disabled = true;
  if (_ncmPoll) clearTimeout(_ncmPoll);
  try {
    const r = await fetch('/api/ncm/login/qr', { method: 'POST' }).then(r => r.json());
    if (!r.qrimg) throw new Error(r.error || 'no qr image');
    $('#ncm-qr').src = r.qrimg;
    $('#ncm-qr-status').textContent = '用网易云 APP 扫码';
    $('#ncm-qr-wrap').hidden = false;
    pollNCMLogin(r.key);
  } catch (e) {
    $('#ncm-qr-status').textContent = `失败: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function pollNCMLogin(key) {
  try {
    const r = await fetch(`/api/ncm/login/check?key=${encodeURIComponent(key)}`).then(r => r.json());
    const status = $('#ncm-qr-status');
    if (r.code === 803) {
      status.textContent = `登录成功 · ${r.profile?.nickname ?? ''}`;
      setTimeout(() => { $('#ncm-qr-wrap').hidden = true; refreshNCMLoginState(); }, 1200);
      return;
    }
    if (r.code === 800) {
      status.innerHTML = '二维码已过期，<a href="#" id="ncm-retry">重新生成</a>';
      $('#ncm-retry')?.addEventListener('click', e => { e.preventDefault(); startNCMLogin(); });
      return;
    }
    if (r.code === 802) status.textContent = '请在手机上确认';
    else if (r.code === 801) status.textContent = '等待扫码';
    else status.textContent = `状态码 ${r.code}`;
    _ncmPoll = setTimeout(() => pollNCMLogin(key), 2000);
  } catch (e) {
    $('#ncm-qr-status').textContent = `轮询失败: ${e.message}`;
  }
}

// ---- service worker ----
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---- boot ----
connectWS();
loadNow();
setInterval(loadNow, 10_000); // 10s prefetch heartbeat (per blueprint)
