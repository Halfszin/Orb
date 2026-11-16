// The Orb panel's lists — tasks, reminders, habits, timers, memory, routines
// and the conversation — and the pure logic around them. No DOM, no Tauri.
//
// shortcut: everything lives in the webview's localStorage (one JSON blob),
// shared by the panel and the island (same origin, `storage` events). Move it
// to a file in Rust if the phone must see these lists too.

export const STORAGE_KEY = "orb.panel.v1";

export interface Task { id: string; text: string; done: boolean; createdAt: number }
export interface Reminder { id: string; text: string; at: number; fired: boolean }
export interface Habit { id: string; text: string; doneOn: string[] }
/** Running: `endsAt` is set. Paused: `left` is set. */
export interface Timer { id: string; label: string; durationMs: number; endsAt: number | null; left: number | null; rang: boolean }
export interface Memory { id: string; text: string }
export type StepKind = "app" | "url" | "music" | "ask";
export interface Step { kind: StepKind; value: string }
export interface Routine { id: string; name: string; steps: Step[] }
export interface ChatMsg { role: "user" | "orb"; text: string; at: number; error?: boolean }

export interface PanelData {
  /** How Orb greets the user ("Olá, Ana!"). */
  name: string;
  tasks: Task[];
  reminders: Reminder[];
  habits: Habit[];
  timers: Timer[];
  memory: Memory[];
  routines: Routine[];
  chat: ChatMsg[];
  /** Earned by finishing tasks and habits; sets Orb's level. */
  xp: number;
}

export const EMPTY: PanelData = {
  name: "", tasks: [], reminders: [], habits: [], timers: [], memory: [], routines: [], chat: [], xp: 0,
};

export const XP_TASK = 10;
export const XP_HABIT = 5;
export const XP_PER_LEVEL = 100;
const CHAT_MAX = 60;

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Whatever was saved, made safe to use: unknown or broken data gives the empty lists. */
export function parse(raw: string | null): PanelData {
  if (!raw) return structuredClone(EMPTY);
  try {
    const v = JSON.parse(raw) as Partial<PanelData>;
    const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
    return {
      name: typeof v.name === "string" ? v.name : "",
      tasks: arr<Task>(v.tasks),
      reminders: arr<Reminder>(v.reminders),
      habits: arr<Habit>(v.habits),
      timers: arr<Timer>(v.timers),
      memory: arr<Memory>(v.memory),
      routines: arr<Routine>(v.routines),
      chat: arr<ChatMsg>(v.chat).slice(-CHAT_MAX),
      xp: Number.isFinite(v.xp) ? Math.max(0, Number(v.xp)) : 0,
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function load(storage: Pick<Storage, "getItem"> = localStorage): PanelData {
  try {
    return parse(storage.getItem(STORAGE_KEY));
  } catch {
    return structuredClone(EMPTY);
  }
}

export function save(d: PanelData, storage: Pick<Storage, "setItem"> = localStorage) {
  d.chat = d.chat.slice(-CHAT_MAX);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(d));
  } catch {
    // Private mode or full storage: the panel still works for this session.
  }
}

/** Local calendar day, "2026-11-16". */
export function dayKey(t: number | Date = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function habitDone(h: Habit, now = Date.now()): boolean {
  return h.doneOn.includes(dayKey(now));
}

/** Ticks today's box (or unticks it); returns the XP change. */
export function toggleHabit(h: Habit, now = Date.now()): number {
  const k = dayKey(now);
  if (h.doneOn.includes(k)) {
    h.doneOn = h.doneOn.filter((d) => d !== k);
    return -XP_HABIT;
  }
  h.doneOn = [...h.doneOn, k].slice(-400);
  return XP_HABIT;
}

/** Days in a row up to today (or up to yesterday while today isn't ticked yet). */
export function streak(h: Habit, now = Date.now()): number {
  const days = new Set(h.doneOn);
  const d = new Date(now);
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(dayKey(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function habitsToday(d: PanelData, now = Date.now()): { done: number; total: number } {
  return { done: d.habits.filter((h) => habitDone(h, now)).length, total: d.habits.length };
}

export function level(xp: number): { level: number; progress: number } {
  const x = Math.max(0, xp);
  return { level: Math.floor(x / XP_PER_LEVEL) + 1, progress: (x % XP_PER_LEVEL) / XP_PER_LEVEL };
}

export function timerLeft(t: Timer, now = Date.now()): number {
  if (t.endsAt != null) return Math.max(0, t.endsAt - now);
  return Math.max(0, t.left ?? t.durationMs);
}

export function startTimer(t: Timer, now = Date.now()) {
  if (t.endsAt != null) return;
  const left = timerLeft(t, now) || t.durationMs;
  t.endsAt = now + left;
  t.left = null;
  t.rang = false;
}

export function pauseTimer(t: Timer, now = Date.now()) {
  if (t.endsAt == null) return;
  t.left = timerLeft(t, now);
  t.endsAt = null;
}

export function resetTimer(t: Timer) {
  t.endsAt = null;
  t.left = null;
  t.rang = false;
}

export type Alarm = { kind: "reminder"; item: Reminder } | { kind: "timer"; item: Timer };

/** What should ring now: reminders that are due and running timers that reached zero. */
export function dueAlarms(d: PanelData, now = Date.now()): Alarm[] {
  const out: Alarm[] = [];
  for (const r of d.reminders) if (!r.fired && r.at <= now) out.push({ kind: "reminder", item: r });
  for (const t of d.timers) if (t.endsAt != null && !t.rang && t.endsAt <= now) out.push({ kind: "timer", item: t });
  return out;
}

/** When the next alarm is due (ms since epoch), or null when nothing waits. */
export function nextAlarmAt(d: PanelData): number | null {
  const times = [
    ...d.reminders.filter((r) => !r.fired).map((r) => r.at),
    ...d.timers.filter((t) => t.endsAt != null && !t.rang).map((t) => t.endsAt as number),
  ];
  return times.length ? Math.min(...times) : null;
}

/** Marks the alarms as rung, so they ring once. */
export function markRung(alarms: Alarm[]) {
  for (const a of alarms) {
    if (a.kind === "reminder") a.item.fired = true;
    else {
      a.item.rang = true;
      a.item.endsAt = null;
      a.item.left = 0;
    }
  }
}

/** "1:05:09", "25:00", "0:42". */
export function clock(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${two(mm)}:${two(ss)}` : `${mm}:${two(ss)}`;
}

/** "25", "1:30", "90s", "2h" → milliseconds (minutes when no unit). */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase().replace(",", ".");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/))) {
    const [a, b, c] = [m[1], m[2], m[3]].map((x) => (x == null ? null : Number(x)));
    return c == null ? ((a as number) * 60 + (b as number)) * 1000 : ((a as number) * 3600 + (b as number) * 60 + c) * 1000;
  }
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(h|min|m|s)?$/))) {
    const n = Number(m[1]);
    const unit = m[2] ?? "min";
    const ms = unit === "h" ? n * 3_600_000 : unit === "s" ? n * 1000 : n * 60_000;
    return ms > 0 ? Math.round(ms) : null;
  }
  return null;
}

export function bytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Only web links open from a routine: no file:, javascript: or custom schemes. */
export function safeUrl(text: string): string | null {
  const s = text.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}
