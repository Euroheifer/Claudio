// 节律调度
// - daily plan-today @ 07:00
// - daily morning-brief @ 09:00
// - hourly mood-check on the top of every hour
// - 通过 onTick 回调把结果广播给 WS 客户端
//
// 关掉定时：SCHEDULER_DISABLED=1（手动 fire 仍可用）

import * as state from './state.js';
import { askClaude } from './claude.js';
import { buildSystemPrompt } from './context.js';

export const TICKS = {
  'plan-today': {
    schedule: { kind: 'daily', hour: 7, minute: 0 },
    prompt:
`现在请规划这一天我们的电台节奏。
读用户语料 + 当前环境，然后回 JSON：
{
  "say": "一段早安开场（≤2句）",
  "play": ["开场推荐 3-5 首，每首 \"歌名 - 艺人\""],
  "reason": "为什么这样开场",
  "segue": "通向 09:00 早间的过渡线索",
  "plan": {
    "morning":   "07-12 段的氛围与方向",
    "noon":      "12-14 段的氛围与方向",
    "afternoon": "14-18 段的氛围与方向",
    "evening":   "18-22 段的氛围与方向",
    "night":     "22-次日 段的氛围与方向"
  }
}`,
  },
  'morning-brief': {
    schedule: { kind: 'daily', hour: 9, minute: 0 },
    prompt:
`现在是 09:00 早间。读用户语料和今天的 plan，给一段不啰嗦的早间开场和几首接下来要播的歌。
回 JSON: {say, play[], reason, segue}`,
  },
  'mood-check': {
    schedule: { kind: 'hourly' },
    prompt:
`整点情绪检查。看最近播放历史 + 当前时段，判断接下来 60 分钟氛围要不要变。
若维持就 play 留空只回 say/reason。回 JSON: {say, play[], reason, segue}`,
  },
  'calendar-hook': {
    schedule: { kind: 'manual' }, // 只能通过 calendarHook(event) 触发
    prompt: '(由 calendarHook 按事件动态生成)',
  },
};

let timers = [];
let nextFires = {};
let onTickCb = () => {};
let started = false;

export function start({ onTick } = {}) {
  if (started) return;
  onTickCb = onTick ?? (() => {});

  if (process.env.SCHEDULER_DISABLED === '1') {
    console.log('[scheduler] disabled by SCHEDULER_DISABLED=1; manual fire() still works');
    started = true;
    return;
  }

  for (const [name, cfg] of Object.entries(TICKS)) {
    if (cfg.schedule.kind === 'daily') {
      scheduleDaily(name, cfg.schedule.hour, cfg.schedule.minute);
    } else if (cfg.schedule.kind === 'hourly') {
      scheduleHourly(name);
    }
    // 'manual' 跳过 — 仅手动 fire
  }
  started = true;
  const summary = Object.entries(nextFires)
    .map(([k, t]) => `${k}=${new Date(t).toLocaleTimeString()}`).join(' · ');
  console.log(`[scheduler] started — next: ${summary}`);
}

export function stop() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  nextFires = {};
  started = false;
}

export function status() {
  const disabled = process.env.SCHEDULER_DISABLED === '1';
  return {
    running: started && !disabled,
    disabled,
    ticks: Object.fromEntries(
      Object.entries(TICKS).map(([name, cfg]) => [
        name,
        {
          schedule: cfg.schedule,
          nextFireAt: nextFires[name] ?? null,
          nextFireIso: nextFires[name] ? new Date(nextFires[name]).toISOString() : null,
        },
      ])
    ),
  };
}

function scheduleDaily(name, hour, minute) {
  const at = nextDaily(hour, minute);
  nextFires[name] = at;
  const t = setTimeout(async () => {
    await safeFire(name);
    scheduleDaily(name, hour, minute);
  }, Math.max(0, at - Date.now()));
  timers.push(t);
}

function scheduleHourly(name) {
  const at = nextTopOfHour();
  nextFires[name] = at;
  const t = setTimeout(async () => {
    await safeFire(name);
    scheduleHourly(name);
  }, Math.max(0, at - Date.now()));
  timers.push(t);
}

function nextDaily(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function nextTopOfHour() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(next.getHours() + 1, 0, 0, 0);
  return next.getTime();
}

async function safeFire(name) {
  try { await fire(name); }
  catch (e) { console.error(`[scheduler] ${name} unexpected error:`, e); }
}

export async function fire(name, override = {}) {
  const cfg = TICKS[name];
  if (!cfg) throw new Error(`unknown tick: ${name}`);

  const prompt = override.prompt ?? cfg.prompt;
  const system = buildSystemPrompt({
    input: prompt,
    env: { scheduledAs: name, ...override.env },
    trail: [`scheduler.${name} @ ${new Date().toISOString()}`],
  });

  console.log(`[scheduler] fire ${name}`);
  let result;
  try {
    result = await askClaude({ prompt, system });
  } catch (e) {
    const errEv = { kind: name, error: e.message, at: Date.now() };
    state.addMessage('scheduler', JSON.stringify(errEv));
    onTickCb(errEv);
    return errEv;
  }

  state.addMessage('scheduler', JSON.stringify({ kind: name, result, at: Date.now() }));

  if (name === 'plan-today' && result.plan) {
    const today = new Date().toISOString().slice(0, 10);
    state.setPlan(today, result.plan);
  }

  const ev = { kind: name, result, at: Date.now() };
  onTickCb(ev);
  return ev;
}

export function listTicks() {
  return Object.keys(TICKS);
}

// 外部日历事件触发即兴播报
// event: { title, starts_at?, minutes_until?, location?, kind?, ...任何额外字段 }
export async function calendarHook(event) {
  const prompt =
`用户的日历事件即将发生：
${JSON.stringify(event, null, 2)}

请根据这个事件的性质调整播报：
- 若是会议/工作开始：放低能量、可以提个温和提示（"还有 X 分钟…"）
- 若是出门/通勤：换适合在外的节奏
- 若是吃饭/休息：放松一点
- 若是睡前：转向 ambient / 慢节奏

回 JSON: {say, play[], reason, segue}`;

  return fire('calendar-hook', { prompt, env: { calendarEvent: event } });
}
