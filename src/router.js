import { askClaude } from './claude.js';
import { buildSystemPrompt } from './context.js';
import * as ncm from './ncm.js';

const CMD_PATTERNS = [
  { re: /^(下一首|跳过|next|skip)\s*$/i,        action: 'next'   },
  { re: /^(上一首|prev|previous)\s*$/i,         action: 'prev'   },
  { re: /^(暂停|pause)\s*$/i,                   action: 'pause'  },
  { re: /^(播放|继续|play|resume)\s*$/i,        action: 'play'   },
  { re: /^(静音|mute)\s*$/i,                    action: 'mute'   },
];

const MUSIC_PREFIXES = [/^搜(歌|索)\s+/, /^播放\s+/, /^来一首\s+/, /^play\s+/i];

export async function route(message, ctx = {}) {
  const text = String(message ?? '').trim();
  if (!text) return { kind: 'noop' };

  for (const { re, action } of CMD_PATTERNS) {
    if (re.test(text)) return { kind: 'cmd', action };
  }

  for (const re of MUSIC_PREFIXES) {
    if (re.test(text)) {
      const query = text.replace(re, '').trim();
      try {
        const hits = await ncm.search(query, { limit: 5 });
        return { kind: 'music', query, hits };
      } catch (e) {
        return { kind: 'music', query, hits: [], error: e.message };
      }
    }
  }

  const system = buildSystemPrompt({ input: text, ...ctx });
  const result = await askClaude({ prompt: text, system });
  return { kind: 'claude', ...result };
}
