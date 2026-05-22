// NeteaseCloudMusicApi 包装
// - 直接 in-process 调用包导出的函数（不跑独立服务）
// - Cookie 优先级：SQLite prefs.ncm_cookie > 环境变量 NCM_COOKIE
//   登录拿到的 cookie 落库，重启不丢
//
// 公开函数：
//   search / songUrl / lyric / recommend / resolve / resolveMany
//   loginQrKey / loginQrCreate / loginQrCheck / loginStatus / logout
//   getCookie / setCookie / clearCookie / status

import nm from 'NeteaseCloudMusicApi';
import * as state from './state.js';

const ENV_COOKIE = process.env.NCM_COOKIE || '';

export function getCookie() {
  return state.getPref('ncm_cookie') || ENV_COOKIE || '';
}

export function setCookie(cookie) {
  state.setPref('ncm_cookie', cookie);
}

export function clearCookie() {
  state.setPref('ncm_cookie', null);
}

function call(fn, params = {}) {
  const cookie = getCookie();
  return fn({ ...params, ...(cookie ? { cookie } : {}) });
}

// 不带 cookie 的调用（登录前用）
function callAnon(fn, params = {}) {
  return fn(params);
}

export async function status() {
  const cookie = getCookie();
  if (!cookie) return { loggedIn: false };
  try {
    const r = await nm.login_status({ cookie });
    const profile = r.body?.data?.profile ?? r.body?.profile ?? null;
    if (profile?.userId) {
      return {
        loggedIn: true,
        profile: {
          userId: profile.userId,
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl,
        },
      };
    }
  } catch { /* fall through */ }
  return { loggedIn: false };
}

// ---- login (QR) ----

export async function loginQrKey() {
  const r = await callAnon(nm.login_qr_key, {});
  return { unikey: r.body?.data?.unikey ?? null };
}

export async function loginQrCreate(key) {
  const r = await callAnon(nm.login_qr_create, { key, qrimg: true });
  return {
    qrimg: r.body?.data?.qrimg ?? null,
    qrurl: r.body?.data?.qrurl ?? null,
  };
}

// 返回 { code, message, cookie? }
// code: 800 过期 / 801 等待扫码 / 802 等待确认 / 803 登录成功
export async function loginQrCheck(key) {
  const r = await callAnon(nm.login_qr_check, { key });
  return {
    code: r.body?.code ?? null,
    message: r.body?.message ?? '',
    cookie: r.body?.code === 803 ? (r.body?.cookie ?? null) : null,
  };
}

export async function logout() {
  const cookie = getCookie();
  if (cookie) {
    try { await nm.logout({ cookie }); } catch { /* best effort */ }
  }
  clearCookie();
}

// ---- 业务 API ----

export async function search(keywords, { limit = 10 } = {}) {
  const r = await call(nm.search, { keywords, limit });
  if (r.status !== 200) throw new Error(`ncm.search status ${r.status}`);
  const songs = r.body?.result?.songs ?? [];
  return songs.map(s => ({
    id: s.id,
    name: s.name,
    artists: (s.artists ?? []).map(a => a.name),
    album: s.album?.name ?? null,
    duration: s.duration ?? null,
  }));
}

export async function songUrl(id, { level = 'standard' } = {}) {
  const r = await call(nm.song_url_v1, { id: String(id), level });
  if (r.status !== 200) throw new Error(`ncm.song_url status ${r.status}`);
  const d = r.body?.data?.[0];
  return {
    id,
    url: d?.url ?? null,
    br: d?.br ?? 0,
    size: d?.size ?? 0,
    type: d?.type ?? null,
    level: d?.level ?? null,
    locked: !d?.url,
  };
}

export async function lyric(id) {
  const r = await call(nm.lyric, { id: String(id) });
  if (r.status !== 200) throw new Error(`ncm.lyric status ${r.status}`);
  return {
    lrc: r.body?.lrc?.lyric ?? '',
    tlyric: r.body?.tlyric?.lyric ?? '',
  };
}

export async function recommend({ limit = 30 } = {}) {
  if (getCookie()) {
    try {
      const r = await call(nm.recommend_songs);
      const dailySongs = r.body?.data?.dailySongs;
      if (r.status === 200 && Array.isArray(dailySongs)) {
        return dailySongs.map(s => ({
          id: s.id,
          name: s.name,
          artists: (s.ar ?? []).map(a => a.name),
          album: s.al?.name ?? null,
        }));
      }
    } catch { /* fall through to public */ }
  }
  const r = await call(nm.personalized, { limit });
  if (r.status !== 200) return [];
  return (r.body?.result ?? []).map(p => ({
    kind: 'playlist',
    id: p.id,
    name: p.name,
    picUrl: p.picUrl,
  }));
}

export async function resolve(query) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  try {
    const hits = await search(q, { limit: 3 });
    return hits[0] ?? null;
  } catch {
    return null;
  }
}

export async function resolveMany(queries) {
  const out = [];
  for (const q of queries) {
    const top = await resolve(q);
    if (top) out.push({ query: q, ...top, status: 'matched' });
    else out.push({ query: q, status: 'no-match' });
  }
  return out;
}
