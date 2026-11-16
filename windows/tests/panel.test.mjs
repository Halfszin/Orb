// The Orb panel's lists and their logic (src/panel/store.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY, clock, dayKey, dueAlarms, level, markRung, nextAlarmAt, parse, parseDuration, pauseTimer,
  safeUrl, startTimer, streak, timerLeft, toggleHabit, XP_HABIT,
} from "../src/panel/store.ts";
import { alarmText } from "../src/island/panel-alarms.ts";

const DAY = 86_400_000;
const noon = new Date(2026, 10, 16, 12).getTime();

test("broken or foreign data gives empty lists, never a crash", () => {
  assert.deepEqual(parse(null), EMPTY);
  assert.deepEqual(parse("{oops"), EMPTY);
  const d = parse(JSON.stringify({ name: 5, tasks: "x", xp: -3, chat: Array.from({ length: 100 }, (_, i) => ({ role: "user", text: String(i), at: i })) }));
  assert.equal(d.name, "");
  assert.deepEqual(d.tasks, []);
  assert.equal(d.xp, 0);
  assert.equal(d.chat.length, 60);
  assert.equal(d.chat.at(-1).text, "99");
});

test("a habit counts once a day and builds a streak", () => {
  const h = { id: "h", text: "água", doneOn: [] };
  assert.equal(toggleHabit(h, noon - DAY), XP_HABIT);
  assert.equal(toggleHabit(h, noon - 2 * DAY), XP_HABIT);
  // Not ticked yet today: the streak up to yesterday still counts.
  assert.equal(streak(h, noon), 2);
  toggleHabit(h, noon);
  assert.equal(streak(h, noon), 3);
  assert.equal(toggleHabit(h, noon), -XP_HABIT);
  assert.equal(h.doneOn.includes(dayKey(noon)), false);
  assert.equal(streak(h, noon + 2 * DAY), 0);
});

test("levels take 100 XP each", () => {
  assert.deepEqual(level(0), { level: 1, progress: 0 });
  assert.deepEqual(level(140), { level: 2, progress: 0.4 });
});

test("a timer pauses and resumes where it was", () => {
  const t = { id: "t", label: "x", durationMs: 60_000, endsAt: null, left: null, rang: false };
  startTimer(t, 0);
  assert.equal(timerLeft(t, 20_000), 40_000);
  pauseTimer(t, 20_000);
  assert.equal(timerLeft(t, 999_999), 40_000);
  startTimer(t, 100_000);
  assert.equal(t.endsAt, 140_000);
});

test("due reminders and finished timers ring once", () => {
  const d = parse(JSON.stringify({
    reminders: [{ id: "a", text: "ligar", at: 1000, fired: false }, { id: "b", text: "depois", at: 9000, fired: false }],
    timers: [{ id: "t", label: "chá", durationMs: 5000, endsAt: 2000, left: null, rang: false }],
  }));
  assert.equal(nextAlarmAt(d), 1000);
  const due = dueAlarms(d, 5000);
  assert.deepEqual(due.map(alarmText), ["Lembrete: ligar", "Timer “chá” acabou"]);
  markRung(due);
  assert.deepEqual(dueAlarms(d, 5000), []);
  assert.equal(nextAlarmAt(d), 9000);
  assert.equal(timerLeft(d.timers[0], 5000), 0);
});

test("durations and clocks read the way people write them", () => {
  assert.equal(parseDuration("25"), 25 * 60_000);
  assert.equal(parseDuration("1:30"), 90_000);
  assert.equal(parseDuration("1:00:05"), 3_605_000);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("0"), null);
  assert.equal(parseDuration("abc"), null);
  assert.equal(clock(65_000), "1:05");
  assert.equal(clock(3_725_000), "1:02:05");
});

test("routines open web links only", () => {
  assert.equal(safeUrl("youtube.com"), "https://youtube.com/");
  assert.equal(safeUrl("http://a.b/c"), "http://a.b/c");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("file:///C:/Windows"), null);
});
