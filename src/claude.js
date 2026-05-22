import { spawn } from 'node:child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

export function askClaude({ prompt, system, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json'];
    if (system) args.push('--append-system-prompt', system);
    const cp = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      cp.kill('SIGTERM');
      reject(new Error(`claude timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    cp.stdout.on('data', d => { out += d; });
    cp.stderr.on('data', d => { err += d; });
    cp.on('error', e => { clearTimeout(timer); reject(e); });
    cp.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${err || out}`));
      }
      try {
        const envelope = JSON.parse(out);
        const text = envelope.result ?? envelope.text ?? '';
        const parsed = parseDjResponse(text);
        resolve({ ...parsed, raw: envelope });
      } catch (e) {
        reject(new Error(`parse error: ${e.message}\nstdout: ${out.slice(0, 500)}`));
      }
    });

    cp.stdin.end(prompt ?? '');
  });
}

function parseDjResponse(text) {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidate = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const obj = JSON.parse(candidate);
      return {
        ...obj,
        say: typeof obj.say === 'string' ? obj.say : text,
        play: Array.isArray(obj.play) ? obj.play : [],
        reason: typeof obj.reason === 'string' ? obj.reason : '',
        segue: typeof obj.segue === 'string' ? obj.segue : '',
      };
    } catch {}
  }
  return { say: text, play: [], reason: '', segue: '' };
}
