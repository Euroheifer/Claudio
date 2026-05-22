import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as state from './state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); }
  catch { return ''; }
}

export function readUserCorpus() {
  const dir = path.join(ROOT, 'user');
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.')) continue;
    if (f.includes('.example.')) continue;   // 模板不进 corpus
    out[f] = readSafe(path.join(dir, f));
  }
  return out;
}

export function readPersona() {
  return readSafe(path.join(ROOT, 'prompts/dj-persona.md'));
}

export function buildSystemPrompt({ env = {}, input = '', trail = [] } = {}) {
  const persona = readPersona();
  const corpus = readUserCorpus();
  const corpusBlock = Object.entries(corpus)
    .map(([name, body]) => `### ${name}\n${body}`)
    .join('\n\n');

  const recentPlays = state.getRecentPlays(20);
  const memoryBlock = recentPlays.length
    ? recentPlays.map(p => `- ${p.title ?? '?'} / ${p.artist ?? '?'}`).join('\n')
    : '(none yet)';

  const now = new Date();
  const tz = process.env.TZ ?? 'Asia/Singapore';
  const envBlock = JSON.stringify({
    now: now.toISOString(),
    timezone: tz,
    localTime: now.toLocaleString('sv-SE', { timeZone: tz, hour12: false }), // YYYY-MM-DD HH:MM:SS
    weekday: now.toLocaleString('en-US', { timeZone: tz, weekday: 'long' }),
    ...env,
  }, null, 2);

  const trailBlock = trail.length ? trail.join('\n') : '(none)';

  return [
    `# 1. 角色 / DJ persona\n${persona || '(persona not yet defined)'}`,
    `# 2. 用户品味语料\n${corpusBlock || '(empty)'}`,
    `# 3. 环境\n${envBlock}`,
    `# 4. 已检索记忆 (recent plays)\n${memoryBlock}`,
    `# 5. 当前输入\n${input}`,
    `# 6. 执行轨迹\n${trailBlock}`,
    `# 输出要求\n请回复一个 JSON 对象，键固定为 say / play / reason / segue：\n` +
      `- say: 你这一段要播报的话\n` +
      `- play: 推荐播放的歌曲数组，每项形如 "歌名 - 艺人"\n` +
      `- reason: 这一段的内在动机（不会读给用户）\n` +
      `- segue: 下一段的过渡提示（可空）`,
  ].join('\n\n');
}
