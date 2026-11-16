// The panel's line icons (24×24, drawn with a 1.8 stroke by panel.css).

export const PANEL_ICONS: Record<string, string> = {
  home: "M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5.5h4V20",
  chat: "M4 5.5h16v10H9l-5 4v-14z",
  brain: "M9 4.5a3 3 0 0 0-3 3v.3A3 3 0 0 0 4 10.6a3 3 0 0 0 1 4.9 3 3 0 0 0 3.5 3.8A2.5 2.5 0 0 0 12 20V6a2 2 0 0 0-3-1.5zM15 4.5a3 3 0 0 1 3 3v.3a3 3 0 0 1 2 2.8 3 3 0 0 1-1 4.9 3 3 0 0 1-3.5 3.8A2.5 2.5 0 0 1 12 20",
  list: "M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01",
  bell: "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15l1.5-2zM10 20.5a2.2 2.2 0 0 0 4 0",
  drop: "M12 3.5s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z",
  clock: "M12 21a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2",
  music: "M9 17.5V6l11-2v11.5M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  copy: "M8.5 8.5h11v11h-11zM15.5 8.5V4.5h-11v11h4",
  bolt: "M13 3 5 13.5h6L10 21l8-10.5h-6L13 3z",
  monitor: "M3.5 5h17v11h-17zM9 20h6M12 16v4",
  send: "M4 12 20 4l-5 16-3-7-8-1z",
  plus: "M12 5v14M5 12h14",
  trash: "M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13",
  check: "M5 12.5 10 17l9-10",
  play: "M8 5.5v13l10.5-6.5L8 5.5z",
  pause: "M8 5.5v13M16 5.5v13",
  prev: "M6 6v12M18 6v12L9 12l9-6z",
  next: "M18 6v12M6 6v12l9-6-9-6z",
  reset: "M5 12a7 7 0 1 0 2-5M5 4.5V9h4.5",
  x: "M6 6l12 12M18 6 6 18",
  fire: "M12 21c-3.6 0-6-2.4-6-5.6 0-3.2 2.6-5 3.2-8.4 1.9 1.3 2.8 3.3 2.8 4.8 1-.6 1.7-1.7 1.9-3 2 1.6 4.1 4 4.1 6.6 0 3.2-2.4 5.6-6 5.6z",
  edit: "M4.5 19.5h4l10-10-4-4-10 10v4zM13 7l4 4",
};

export function icon(name: string, cls = "ico"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PANEL_ICONS[name] ?? "");
  svg.append(path);
  return svg;
}
