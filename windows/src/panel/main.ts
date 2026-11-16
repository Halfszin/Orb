// The Orb panel (panel.html): opens under the island when the pointer rests on
// it. A sidebar of sections — Início, Conversa, Memória, Tarefas, Lembretes,
// Hábitos, Timers, Música, Copiados, Rotinas, Meu PC — over the lists in
// store.ts. The island rings reminders and timers (src/island/panel-alarms.ts).
//
// shortcut: the panel's words are Portuguese only, not in the i18n tables;
// move them to t() and src/i18n/extra.json to translate the panel.

import "./panel.css";
import { Bridge, IS_TAURI, onEvent, type PcInfo } from "../core/bridge";
import { Sound } from "../core/sound";
import { IDLE_SPOTIFY, spotifyPosition, type SpotifyState } from "../core/spotify";
import { BotEngine } from "../mochi/engine";
import { h } from "../views/dom";
import { icon } from "./icons";
import {
  STORAGE_KEY, XP_TASK, bytes, clock, dayKey, habitDone, habitsToday, level, load, newId, parseDuration,
  pauseTimer, resetTimer, safeUrl, save, startTimer, streak, timerLeft, toggleHabit,
  type ChatMsg, type PanelData, type Routine, type Step, type StepKind, type Timer,
} from "./store";

type SectionId =
  | "inicio" | "conversa" | "memoria" | "tarefas" | "lembretes" | "habitos"
  | "timers" | "musica" | "copiados" | "rotinas" | "meupc";

const SECTIONS: { id: SectionId; label: string; icon: string; sub: string }[] = [
  { id: "inicio", label: "Início", icon: "home", sub: "" },
  { id: "conversa", label: "Conversa", icon: "chat", sub: "Peça qualquer coisa: abrir um app, tocar música, pesquisar na web." },
  { id: "memoria", label: "Memória", icon: "brain", sub: "O que o Orb sabe sobre você e usa nas respostas." },
  { id: "tarefas", label: "Tarefas", icon: "list", sub: "Cada tarefa concluída dá XP ao Orb." },
  { id: "lembretes", label: "Lembretes", icon: "bell", sub: "O Orb abre o painel e toca um som na hora." },
  { id: "habitos", label: "Hábitos", icon: "drop", sub: "Marque o que você fez hoje. Os dias seguidos viram uma sequência." },
  { id: "timers", label: "Timers", icon: "clock", sub: "Contagens regressivas, com aviso quando acabam." },
  { id: "musica", label: "Música", icon: "music", sub: "O que está tocando no Spotify." },
  { id: "copiados", label: "Copiados", icon: "copy", sub: "Os últimos textos copiados. Ficam só na memória e somem ao fechar o Orb." },
  { id: "rotinas", label: "Rotinas", icon: "bolt", sub: "Uma sequência de ações com um clique." },
  { id: "meupc", label: "Meu PC", icon: "monitor", sub: "Como o computador está agora." },
];

let data: PanelData = load();
let section: SectionId = "inicio";
let shown = !IS_TAURI; // a plain browser (dev preview) shows it at once
let thinking = false;
let music: SpotifyState = { ...IDLE_SPOTIFY };
let artwork: { artUrl: string; dataUrl: string } | null = null;
let clips: string[] = [];
let pc: PcInfo | null = null;
const alarms: string[] = [];
let editingRoutine: Routine | null = null;

const root = document.getElementById("panel")!;

function commit(rerender = true) {
  save(data);
  if (rerender) render();
}

function focusSoon(id: string) {
  requestAnimationFrame(() => (document.getElementById(id) as HTMLInputElement | null)?.focus());
}

// ── Assistant ─────────────────────────────────────────────────────────────────

function pushChat(m: ChatMsg) {
  data.chat.push(m);
  commit();
  requestAnimationFrame(() => document.querySelectorAll(".chat-list").forEach((el) => (el.scrollTop = el.scrollHeight)));
}

/** A few things work without the assistant: "lembre que…", "tarefa: …". */
function localCommand(text: string): string | null {
  let m = text.match(/^lembr[ea](?:-se)?\s+(?:de\s+)?que\s+(.+)$/i);
  if (m) {
    data.memory.push({ id: newId(), text: m[1].trim() });
    return "Pode deixar, vou lembrar disso.";
  }
  m = text.match(/^(?:nova\s+|adicion[ea]r?\s+(?:a\s+)?)?tarefa:?\s+(.+)$/i);
  if (m) {
    data.tasks.push({ id: newId(), text: m[1].trim(), done: false, createdAt: Date.now() });
    return `Tarefa adicionada: ${m[1].trim()}.`;
  }
  return null;
}

async function ask(text: string) {
  const q = text.trim();
  if (!q || thinking) return;
  Sound.play("send");
  data.chat.push({ role: "user", text: q, at: Date.now() });
  const local = localCommand(q);
  if (local) {
    pushChat({ role: "orb", text: local, at: Date.now() });
    return;
  }
  thinking = true;
  bot.setState("thinking");
  commit();
  try {
    const reply = await Bridge.assistantAsk(q, data.memory.map((m) => m.text));
    pushChat({ role: "orb", text: reply, at: Date.now() });
    bot.setState("finished");
  } catch (err) {
    const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Não consegui responder agora.";
    pushChat({ role: "orb", text: msg, at: Date.now(), error: true });
    bot.setState("error");
  } finally {
    thinking = false;
    window.setTimeout(() => bot.setState("idle"), 1800);
    render();
  }
}

function askBox(id: string, placeholder: string): HTMLElement {
  const input = h("input", { id, class: "ask-input", placeholder, autocomplete: "off", maxlength: 4000 }) as HTMLInputElement;
  const go = () => {
    const v = input.value;
    input.value = "";
    void ask(v).then(() => focusSoon(id));
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  const send = h("button", { class: "ask-send", title: "Enviar", "aria-label": "Enviar", onclick: go });
  send.append(icon("send"));
  return h("div", { class: "ask" }, input, send);
}

function chatList(msgs: ChatMsg[], cls = ""): HTMLElement {
  const list = h("div", { class: `chat-list ${cls}` });
  if (!msgs.length) list.append(h("div", { class: "empty", text: "Nenhuma conversa ainda. Diga oi!" }));
  for (const m of msgs) list.append(h("div", { class: `bubble ${m.role}${m.error ? " error" : ""}`, text: m.text }));
  if (thinking) list.append(h("div", { class: "bubble orb typing" }, h("span"), h("span"), h("span")));
  requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  return list;
}

// ── Small building blocks ─────────────────────────────────────────────────────

function iconBtn(name: string, title: string, onclick: () => void, cls = "icon-btn"): HTMLButtonElement {
  const b = h("button", { class: cls, title, "aria-label": title, onclick });
  b.append(icon(name));
  return b;
}

/** A text field with a + button; Enter adds too. */
function adder(id: string, placeholder: string, onAdd: (text: string) => void, extra: HTMLElement[] = []): HTMLElement {
  const input = h("input", { id, placeholder, autocomplete: "off", maxlength: 300 }) as HTMLInputElement;
  const go = () => {
    const v = input.value.trim();
    if (!v) return;
    onAdd(v);
    input.value = "";
    focusSoon(id);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  return h("div", { class: "adder" }, input, ...extra, iconBtn("plus", "Adicionar", go, "add-btn"));
}

function card(title: string | null, ...children: (Node | null | false)[]): HTMLElement {
  return h("div", { class: "card" }, title ? h("div", { class: "card-title", text: title }) : null, ...children);
}

function empty(text: string): HTMLElement {
  return h("div", { class: "empty", text });
}

function bar(fraction: number): HTMLElement {
  const f = Math.max(0, Math.min(1, fraction));
  return h("div", { class: "bar" }, h("div", { class: `bar-fill${f > 0.85 ? " hot" : ""}`, style: `width:${(f * 100).toFixed(1)}%` }));
}

function relative(at: number): string {
  const diff = at - Date.now();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  const when = new Date(at);
  const time = when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const sameDay = dayKey(at) === dayKey();
  const label = sameDay ? `hoje, ${time}` : `${when.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}, ${time}`;
  if (diff < 0) return `${label} · passou`;
  if (min < 60) return `${label} · em ${min} min`;
  return label;
}

// ── Sections ──────────────────────────────────────────────────────────────────

function inicio(): HTMLElement {
  const greet = data.name ? `Olá, ${data.name}!` : "Olá!";
  const nameLink = h("button", { class: "link", text: data.name ? "trocar nome" : "Como devo te chamar?" , onclick: () => {
    const v = window.prompt("Como o Orb deve te chamar?", data.name);
    if (v != null) { data.name = v.trim().slice(0, 40); commit(); }
  } });
  const pending = data.tasks.filter((t) => !t.done).length;
  const upcoming = data.reminders.filter((r) => !r.fired && dayKey(r.at) === dayKey()).length;
  const hab = habitsToday(data);
  const running = data.timers.filter((t) => t.endsAt != null);
  const stat = (n: string, label: string, go: SectionId, ico: string) =>
    h("button", { class: "stat", onclick: () => go_(go) }, icon(ico), h("div", { class: "stat-n", text: n }), h("div", { class: "stat-l", text: label }));
  return h("div", { class: "home" },
    h("div", { class: "hello" }, h("h1", { text: greet }), nameLink),
    h("div", { class: "sub", text: "Escreva, fale ou diga “OK Orb”." }),
    askBox("ask-home", "Escreva ou fale com o Orb…"),
    h("div", { class: "home-grid" },
      card(null, chatList(data.chat.slice(-4), "short")),
      musicCard(true),
    ),
    h("div", { class: "stats" },
      stat(String(pending), pending === 1 ? "tarefa" : "tarefas", "tarefas", "list"),
      stat(String(upcoming), "lembretes hoje", "lembretes", "bell"),
      stat(`${hab.done}/${hab.total}`, "hábitos", "habitos", "drop"),
      stat(running.length ? clock(Math.min(...running.map((t) => timerLeft(t)))) : "—", "timer", "timers", "clock"),
    ),
  );
}

function conversa(): HTMLElement {
  return h("div", { class: "fill" },
    card(null, chatList(data.chat, "full")),
    h("div", { class: "row-end" },
      askBox("ask-chat", "Mensagem para o Orb…"),
      h("button", { class: "ghost", text: "Limpar", onclick: () => { data.chat = []; commit(); } }),
    ),
  );
}

function memoria(): HTMLElement {
  const list = h("div", { class: "list" });
  if (!data.memory.length) list.append(empty("Nada ainda. Ex.: “Meu nome é Ana”, “Trabalho com design”. Ou diga no chat: “lembre que…”."));
  for (const m of data.memory) {
    list.append(h("div", { class: "item" }, h("div", { class: "item-text", text: m.text }),
      iconBtn("trash", "Apagar", () => { data.memory = data.memory.filter((x) => x !== m); commit(); })));
  }
  return h("div", {}, adder("add-mem", "Algo que o Orb deve lembrar…", (t) => { data.memory.push({ id: newId(), text: t }); Sound.play("pop"); commit(); }), list);
}

function tarefas(): HTMLElement {
  const open = data.tasks.filter((t) => !t.done);
  const done = data.tasks.filter((t) => t.done);
  const row = (t: (typeof data.tasks)[number]) =>
    h("div", { class: `item${t.done ? " done" : ""}` },
      h("button", { class: `check${t.done ? " on" : ""}`, title: t.done ? "Desmarcar" : "Concluir", onclick: () => {
        t.done = !t.done;
        data.xp = Math.max(0, data.xp + (t.done ? XP_TASK : -XP_TASK));
        if (t.done) { Sound.play("finish"); bot.triggerEmote("proud"); }
        commit();
      } }, t.done ? icon("check") : null),
      h("div", { class: "item-text", text: t.text }),
      iconBtn("trash", "Apagar", () => { data.tasks = data.tasks.filter((x) => x !== t); commit(); }));
  const list = h("div", { class: "list" });
  if (!open.length) list.append(empty(done.length ? "Tudo feito! 🎉" : "Nenhuma tarefa. Adicione a primeira acima."));
  open.forEach((t) => list.append(row(t)));
  const doneBox = done.length
    ? h("details", { class: "done-box" }, h("summary", { text: `Concluídas (${done.length})` }), ...done.map(row),
      h("button", { class: "ghost small", text: "Apagar concluídas", onclick: () => { data.tasks = open; commit(); } }))
    : null;
  return h("div", {}, adder("add-task", "Nova tarefa…", (text) => { data.tasks.push({ id: newId(), text, done: false, createdAt: Date.now() }); Sound.play("pop"); commit(); }), list, doneBox);
}

function lembretes(): HTMLElement {
  const when = h("input", { id: "rem-when", type: "datetime-local", class: "when" }) as HTMLInputElement;
  const inHour = new Date(Date.now() + 3600_000);
  inHour.setSeconds(0, 0);
  when.value = new Date(inHour.getTime() - inHour.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const list = h("div", { class: "list" });
  const items = [...data.reminders].sort((a, b) => Number(a.fired) - Number(b.fired) || a.at - b.at);
  if (!items.length) list.append(empty("Nenhum lembrete."));
  for (const r of items) {
    list.append(h("div", { class: `item${r.fired ? " done" : ""}` }, icon("bell", "ico item-ico"),
      h("div", { class: "item-text" }, h("div", { text: r.text }), h("div", { class: "meta", text: relative(r.at) })),
      iconBtn("trash", "Apagar", () => { data.reminders = data.reminders.filter((x) => x !== r); commit(); })));
  }
  return h("div", {},
    adder("add-rem", "Lembrar de…", (text) => {
      const at = new Date(when.value).getTime();
      if (!Number.isFinite(at)) return;
      data.reminders.push({ id: newId(), text, at, fired: at <= Date.now() });
      Sound.play("pop");
      commit();
    }, [when]),
    list);
}

function habitos(): HTMLElement {
  const list = h("div", { class: "list" });
  if (!data.habits.length) list.append(empty("Nenhum hábito. Ex.: “Beber 2 L de água”, “Ler 10 páginas”."));
  for (const hb of data.habits) {
    const on = habitDone(hb);
    const s = streak(hb);
    list.append(h("div", { class: `item${on ? " done-soft" : ""}` },
      h("button", { class: `check${on ? " on" : ""}`, title: on ? "Desmarcar hoje" : "Feito hoje", onclick: () => {
        data.xp = Math.max(0, data.xp + toggleHabit(hb));
        if (habitDone(hb)) Sound.play("approve");
        commit();
      } }, on ? icon("check") : null),
      h("div", { class: "item-text", text: hb.text }),
      s > 0 ? h("div", { class: "streak", title: `${s} dia(s) seguidos` }, icon("fire"), String(s)) : null,
      iconBtn("trash", "Apagar", () => { data.habits = data.habits.filter((x) => x !== hb); commit(); })));
  }
  return h("div", {}, adder("add-habit", "Novo hábito…", (text) => { data.habits.push({ id: newId(), text, doneOn: [] }); Sound.play("pop"); commit(); }), list);
}

function timers(): HTMLElement {
  const addTimer = (label: string, ms: number) => {
    const t: Timer = { id: newId(), label, durationMs: ms, endsAt: null, left: null, rang: false };
    startTimer(t);
    data.timers.push(t);
    Sound.play("tick");
    commit();
  };
  const dur = h("input", { id: "timer-dur", class: "dur", placeholder: "25", title: "Minutos (ou 1:30, 90s, 2h)" }) as HTMLInputElement;
  const presets = h("div", { class: "presets" }, ...[5, 10, 15, 25, 45].map((m) =>
    h("button", { class: "chip", text: `${m} min`, onclick: () => addTimer(`${m} minutos`, m * 60_000) })));
  const list = h("div", { class: "timer-grid" });
  if (!data.timers.length) list.append(empty("Nenhum timer. Escolha um tempo acima."));
  for (const t of data.timers) {
    const left = timerLeft(t);
    const running = t.endsAt != null;
    list.append(h("div", { class: `timer${running ? " running" : ""}${t.rang ? " rang" : ""}` },
      h("div", { class: "timer-label", text: t.label }),
      h("div", { class: "timer-clock", "data-timer": t.id, text: clock(left) }),
      bar(1 - left / t.durationMs),
      h("div", { class: "timer-actions" },
        running ? iconBtn("pause", "Pausar", () => { pauseTimer(t); commit(); }) : iconBtn("play", "Iniciar", () => { startTimer(t); commit(); }),
        iconBtn("reset", "Zerar", () => { resetTimer(t); commit(); }),
        iconBtn("trash", "Apagar", () => { data.timers = data.timers.filter((x) => x !== t); commit(); }))));
  }
  return h("div", {}, presets, customTimer(dur, addTimer), list);
}

function customTimer(dur: HTMLInputElement, addTimer: (label: string, ms: number) => void): HTMLElement {
  const label = h("input", { id: "timer-name", placeholder: "Nome do timer (opcional)…", maxlength: 60 }) as HTMLInputElement;
  const go = () => {
    const ms = parseDuration(dur.value || "25");
    if (!ms) { dur.classList.add("bad"); return; }
    addTimer(label.value.trim() || clock(ms), ms);
  };
  for (const el of [label, dur]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  return h("div", { class: "adder" }, label, dur, iconBtn("plus", "Criar timer", go, "add-btn"));
}

function musicCard(small = false): HTMLElement {
  const s = music;
  const cover = artwork && s.track?.artUrl === artwork.artUrl
    ? h("img", { class: "cover", src: artwork.dataUrl, alt: "" })
    : h("div", { class: "cover none" }, icon("music"));
  if (!s.running || !s.track) {
    return card(small ? null : "Spotify", h("div", { class: "music-off" }, cover,
      h("div", {}, h("div", { class: "track", text: s.running ? "Nada tocando" : "Spotify fechado" }),
        h("button", { class: "ghost small", text: "Abrir Spotify", onclick: () => void Bridge.spotifyOpen() }))));
  }
  const pos = spotifyPosition(s, Date.now());
  const ctl = (name: string, title: string, action: "previous" | "playPause" | "next", cls = "icon-btn") =>
    iconBtn(name, title, () => void Bridge.spotifyControl(action), cls);
  const vol = h("input", { type: "range", min: 0, max: 100, value: Math.round(s.volume), class: "volume", title: "Volume" }) as HTMLInputElement;
  vol.addEventListener("change", () => void Bridge.spotifyControl("volume", Number(vol.value)));
  return h("div", { class: `card music${small ? " small" : ""}` },
    h("div", { class: "music-top" }, cover,
      h("div", { class: "music-meta" }, h("div", { class: "track", text: s.track.title }), h("div", { class: "artist", text: s.track.artist }))),
    bar(s.track.duration ? pos / s.track.duration : 0),
    h("div", { class: "music-ctl" },
      ctl("prev", "Anterior", "previous"),
      ctl(s.playing ? "pause" : "play", s.playing ? "Pausar" : "Tocar", "playPause", "play-btn"),
      ctl("next", "Próxima", "next"),
      vol));
}

function musica(): HTMLElement {
  return h("div", {}, musicCard(false));
}

function copiados(): HTMLElement {
  const list = h("div", { class: "list" });
  if (!clips.length) list.append(empty("Nada copiado desde que o Orb abriu. Copie um texto (Ctrl+C) e ele aparece aqui."));
  for (const c of clips) {
    const b = h("button", { class: "item clip", title: "Copiar de novo", onclick: () => {
      void Bridge.clipboardCopy(c);
      b.classList.add("copied");
      Sound.play("blip");
      window.setTimeout(() => b.classList.remove("copied"), 900);
    } }, h("div", { class: "item-text clip-text", text: c.length > 400 ? `${c.slice(0, 400)}…` : c }), icon("copy", "ico item-ico"));
    list.append(b);
  }
  return h("div", {}, h("div", { class: "row-end" }, h("button", { class: "ghost small", text: "Limpar histórico", onclick: () => { void Bridge.clipboardClear(); clips = []; render(); } })), list);
}

const STEP_LABEL: Record<StepKind, string> = { app: "Abrir app", url: "Abrir site", music: "Tocar/pausar música", ask: "Pedir ao Orb" };

async function runRoutine(r: Routine) {
  Sound.play("work");
  for (const s of r.steps) {
    try {
      if (s.kind === "app") await Bridge.panelOpenApp(s.value);
      else if (s.kind === "url") { const u = safeUrl(s.value); if (u) await Bridge.openUrl(u); }
      else if (s.kind === "music") await Bridge.spotifyControl("playPause");
      else if (s.kind === "ask") await ask(s.value);
    } catch (err) {
      pushChat({ role: "orb", text: `Rotina “${r.name}”: ${String(err)}`, at: Date.now(), error: true });
    }
    await new Promise((res) => window.setTimeout(res, 500));
  }
}

function rotinas(): HTMLElement {
  if (editingRoutine) return routineEditor(editingRoutine);
  const list = h("div", { class: "list" });
  if (!data.routines.length) list.append(empty("Nenhuma rotina. Ex.: “Começar o dia”: abrir o Chrome, abrir o Spotify e tocar música."));
  for (const r of data.routines) {
    list.append(h("div", { class: "item" }, icon("bolt", "ico item-ico"),
      h("div", { class: "item-text" }, h("div", { text: r.name }), h("div", { class: "meta", text: r.steps.map((s) => (s.kind === "music" ? STEP_LABEL.music : `${STEP_LABEL[s.kind]}: ${s.value}`)).join(" → ") || "sem passos" })),
      h("button", { class: "chip run", text: "Executar", onclick: () => void runRoutine(r) }),
      iconBtn("edit", "Editar", () => { editingRoutine = structuredClone(r); render(); }),
      iconBtn("trash", "Apagar", () => { data.routines = data.routines.filter((x) => x !== r); commit(); })));
  }
  return h("div", {},
    h("div", { class: "row-end" }, h("button", { class: "primary", text: "Nova rotina", onclick: () => { editingRoutine = { id: newId(), name: "", steps: [] }; render(); } })),
    list);
}

function routineEditor(r: Routine): HTMLElement {
  const name = h("input", { id: "routine-name", placeholder: "Nome da rotina", value: r.name, maxlength: 60 }) as HTMLInputElement;
  name.addEventListener("input", () => (r.name = name.value));
  const kind = h("select", { class: "kind" }, ...(Object.keys(STEP_LABEL) as StepKind[]).map((k) => h("option", { value: k, text: STEP_LABEL[k] }))) as HTMLSelectElement;
  const value = h("input", { id: "step-value", placeholder: "Chrome, youtube.com, “que horas são?”…", maxlength: 300 }) as HTMLInputElement;
  const addStep = () => {
    const k = kind.value as StepKind;
    const v = value.value.trim();
    if (k !== "music" && !v) return;
    if (k === "url" && !safeUrl(v)) { value.classList.add("bad"); return; }
    r.steps.push({ kind: k, value: v } as Step);
    render();
    focusSoon("step-value");
  };
  value.addEventListener("keydown", (e) => { if (e.key === "Enter") addStep(); });
  const steps = h("div", { class: "list" });
  if (!r.steps.length) steps.append(empty("Adicione os passos na ordem em que devem acontecer."));
  r.steps.forEach((s, i) => steps.append(h("div", { class: "item" }, h("div", { class: "step-n", text: String(i + 1) }),
    h("div", { class: "item-text", text: s.kind === "music" ? STEP_LABEL.music : `${STEP_LABEL[s.kind]}: ${s.value}` }),
    iconBtn("x", "Tirar", () => { r.steps.splice(i, 1); render(); }))));
  return h("div", {},
    h("div", { class: "adder" }, name),
    h("div", { class: "adder" }, kind, value, iconBtn("plus", "Adicionar passo", addStep, "add-btn")),
    steps,
    h("div", { class: "row-end" },
      h("button", { class: "ghost", text: "Cancelar", onclick: () => { editingRoutine = null; render(); } }),
      h("button", { class: "primary", text: "Salvar", onclick: () => {
        if (!r.name.trim()) { name.classList.add("bad"); name.focus(); return; }
        const i = data.routines.findIndex((x) => x.id === r.id);
        if (i >= 0) data.routines[i] = r; else data.routines.push(r);
        editingRoutine = null;
        commit();
      } })));
}

function meupc(): HTMLElement {
  if (!pc) return empty("Lendo o computador…");
  const up = pc.uptimeSecs;
  const upText = up >= 86400 ? `${Math.floor(up / 86400)} d ${Math.floor((up % 86400) / 3600)} h` : `${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min`;
  const gauge = (title: string, value: string, fraction: number, detail: string) =>
    card(title, h("div", { class: "gauge-n", text: value }), bar(fraction), h("div", { class: "meta", text: detail }));
  return h("div", { class: "pc-grid" },
    gauge("Processador", `${Math.round(pc.cpu)}%`, pc.cpu / 100, "uso agora"),
    gauge("Memória", pc.memTotal ? `${Math.round((pc.memUsed / pc.memTotal) * 100)}%` : "—", pc.memTotal ? pc.memUsed / pc.memTotal : 0, `${bytes(pc.memUsed)} de ${bytes(pc.memTotal)}`),
    gauge("Disco", pc.diskTotal ? `${Math.round((pc.diskUsed / pc.diskTotal) * 100)}%` : "—", pc.diskTotal ? pc.diskUsed / pc.diskTotal : 0, pc.diskTotal ? `${bytes(pc.diskTotal - pc.diskUsed)} livres de ${bytes(pc.diskTotal)}` : ""),
    card("Sistema", h("div", { class: "gauge-n small", text: pc.host || "Este computador" }), h("div", { class: "meta", text: `${pc.os} · ligado há ${upText}` })),
  );
}

const RENDER: Record<SectionId, () => HTMLElement> = {
  inicio, conversa, memoria, tarefas, lembretes, habitos, timers, musica, copiados, rotinas, meupc,
};

// ── Shell ─────────────────────────────────────────────────────────────────────

const bot = new BotEngine();
bot.setState("idle", true);
const avatar = h("canvas", { class: "avatar", width: 88, height: 88 }) as HTMLCanvasElement;
avatar.addEventListener("click", () => bot.slap());
const statusText = h("span", { text: "Pronto" });
const levelText = h("span", { class: "lvl" });
const xpFill = h("div", { class: "xp-fill" });
const nav = h("nav", { class: "nav" });
const main = h("main", { class: "main" });
const banner = h("div", { class: "alarm-banner" });

function go_(id: SectionId) {
  section = id;
  editingRoutine = null;
  render();
  void refreshLive();
}

function badge(id: SectionId): string | null {
  if (id === "tarefas") { const n = data.tasks.filter((t) => !t.done).length; return n ? String(n) : null; }
  if (id === "habitos") { const x = habitsToday(data); return x.total ? `${x.done}/${x.total}` : null; }
  if (id === "lembretes") { const n = data.reminders.filter((r) => !r.fired).length; return n ? String(n) : null; }
  if (id === "timers") { const n = data.timers.filter((t) => t.endsAt != null).length; return n ? String(n) : null; }
  return null;
}

function render() {
  const lv = level(data.xp);
  levelText.textContent = `Nv${lv.level}`;
  xpFill.style.width = `${Math.round(lv.progress * 100)}%`;
  statusText.textContent = thinking ? "Pensando…" : "Pronto";
  nav.replaceChildren(...SECTIONS.map((s) => {
    const b = badge(s.id);
    return h("button", { class: `nav-item${s.id === section ? " active" : ""}`, onclick: () => go_(s.id) },
      icon(s.icon), h("span", { class: "nav-label", text: s.label }), b ? h("span", { class: "badge", text: b }) : null);
  }));
  const meta = SECTIONS.find((s) => s.id === section)!;
  const scroll = main.querySelector(".content")?.scrollTop ?? 0;
  const content = h("div", { class: "content" }, RENDER[section]());
  const head = h("header", { class: "head" }, h("h2", { text: meta.label }), h("div", { class: "sub", text: meta.sub }));
  if (section === "inicio") main.replaceChildren(content);
  else main.replaceChildren(head, content);
  content.scrollTop = scroll;
  renderBanner();
}

function renderBanner() {
  banner.classList.toggle("on", alarms.length > 0);
  if (!alarms.length) return banner.replaceChildren();
  banner.replaceChildren(icon("bell"), h("div", { class: "alarm-text", text: alarms.join(" · ") }),
    h("button", { class: "primary small", text: "OK", onclick: () => { alarms.length = 0; renderBanner(); } }));
}

root.append(
  h("div", { class: "panel" },
    h("aside", { class: "side" },
      h("div", { class: "who" }, avatar,
        h("div", {}, h("div", { class: "who-name", text: "Orb" }),
          h("div", { class: "who-status" }, h("span", { class: "dot" }), statusText),
          h("div", { class: "who-level" }, levelText, h("div", { class: "xp" }, xpFill)))),
      nav),
    h("div", { class: "right" }, banner, main),
  ),
);
render();

// ── Live parts: the avatar, timers, clipboard, the PC, music ──────────────────

let last = performance.now();
let raf = 0;
function frame(now: number) {
  raf = 0;
  if (!shown) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  bot.update(dt);
  const ctx = avatar.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, avatar.width, avatar.height);
  ctx.scale(2, 2);
  bot.draw(ctx, 44, 44);
  raf = requestAnimationFrame(frame);
}
function startFrames() {
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
}

/** Fetches what the open section shows live. */
async function refreshLive() {
  if (!shown) return;
  if (section === "copiados") {
    const next = (await Bridge.clipboardHistory()) ?? [];
    if (next.join("\u0000") !== clips.join("\u0000")) { clips = next; render(); }
  } else if (section === "meupc") {
    pc = await Bridge.pcInfo();
    render();
  }
}

window.setInterval(() => {
  if (!shown) return;
  // Timers tick in place, without rebuilding the page.
  for (const el of document.querySelectorAll<HTMLElement>("[data-timer]")) {
    const t = data.timers.find((x) => x.id === el.dataset.timer);
    if (t) el.textContent = clock(timerLeft(t));
  }
  if (section === "copiados" || section === "meupc") void refreshLive();
}, 1000);

void onEvent<SpotifyState>("spotify", (s) => {
  music = s;
  if (shown && (section === "musica" || section === "inicio")) render();
});
void onEvent<{ artUrl: string; dataUrl: string }>("spotify-artwork", (art) => {
  artwork = art;
  if (shown && (section === "musica" || section === "inicio")) render();
});

void onEvent<null>("panel-shown", () => {
  shown = true;
  data = load();
  render();
  startFrames();
  void Bridge.spotifyRefresh().then((s) => { if (s) { music = s; render(); } });
  void refreshLive();
});

/** The island rang a reminder or a timer: show it until OK. */
void onEvent<{ text: string }>("panel-alarm", (a) => {
  alarms.push(a.text);
  bot.setState("approval");
  window.setTimeout(() => bot.setState("idle"), 4000);
  data = load();
  render();
});

// The island changed the lists (an alarm rang): read them again.
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY) return;
  data = load();
  if (shown) render();
});

// ── Closing: the pointer leaves, Esc, or a click elsewhere ────────────────────

let leaveTimer: number | null = null;
function hide() {
  if (alarms.length) return;
  shown = false;
  void Bridge.panelHide();
}
function typing(): boolean {
  const el = document.activeElement as HTMLInputElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") && !!el.value && el.type !== "range";
}
document.documentElement.addEventListener("mouseleave", () => {
  if (leaveTimer) clearTimeout(leaveTimer);
  leaveTimer = window.setTimeout(() => { leaveTimer = null; if (!typing()) hide(); }, 700);
});
document.documentElement.addEventListener("mouseenter", () => {
  if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
});
window.addEventListener("blur", () => window.setTimeout(() => { if (!document.hasFocus()) hide(); }, 150));
window.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });

if (shown) startFrames();
