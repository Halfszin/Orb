// The island's side of the Orb panel: it rings the panel's reminders and
// timers. The island's window is always on screen, so its timers are never
// throttled the way a hidden page's are; the lists come from the panel through
// the shared localStorage (src/panel/store.ts).

import { emitTo } from "@tauri-apps/api/event";
import { Bridge, IS_TAURI } from "../core/bridge";
import { Sound } from "../core/sound";
import { STORAGE_KEY, dueAlarms, load, markRung, nextAlarmAt, save, type Alarm } from "../panel/store";

const MAX_DELAY = 60_000; // check at least every minute: the PC may have slept

export function alarmText(a: Alarm): string {
  return a.kind === "reminder" ? `Lembrete: ${a.item.text}` : `Timer “${a.item.label}” acabou`;
}

let timer: number | null = null;

function ring() {
  const data = load();
  const due = dueAlarms(data);
  if (due.length) {
    markRung(due);
    save(data);
    Sound.play(due.some((a) => a.kind === "timer") ? "finish" : "approval");
    void Bridge.panelShow().then(() => {
      for (const a of due) if (IS_TAURI) void emitTo("panel", "panel-alarm", { text: alarmText(a) });
    });
  }
  schedule();
}

function schedule() {
  if (timer != null) clearTimeout(timer);
  const at = nextAlarmAt(load());
  const delay = at == null ? MAX_DELAY : Math.max(0, Math.min(MAX_DELAY, at - Date.now()));
  timer = window.setTimeout(ring, delay);
}

export function registerPanelAlarms() {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) schedule();
  });
  schedule();
}
