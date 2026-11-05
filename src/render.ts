import { AGENT_MODES, ALIAS_FILE, type AgentDraft } from "./agents.ts";
import { formatDuration, type Desk, type Snapshot } from "./state.ts";

export interface ProjectOption {
  id: string;
  name: string;
  path: string;
}

export interface RenderMeta {
  databasePath: string;
  staleMinutes: number;
  editing?: boolean;
  notice?: string;
  /** Every known OpenCode project, newest first. */
  projects?: ProjectOption[];
  /** Database id of the project this page shows. */
  activeProjectId?: string;
}

export type ViewName = "desks" | "mindmap" | "org" | "projects";

export function projectQuery(projectId?: string): string {
  return projectId ? `&project=${encodeURIComponent(projectId)}` : "";
}

/** The shared header navigation, keeping the selected project where possible. */
export function renderViewNav(active: ViewName, projectId?: string): string {
  const item = (view: ViewName, label: string): string => {
    if (view === active) {
      return `<span class="view-switch__item is-active" aria-current="page">${label}</span>`;
    }
    const href =
      view === "projects" ? "/?view=projects" : `/?view=${view}${projectQuery(projectId)}`;
    return `<a class="view-switch__item" href="${href}">${label}</a>`;
  };
  return `<nav class="view-switch" aria-label="View">
        ${item("org", "Org structure")}
        ${item("mindmap", "Mind map")}
        ${item("desks", "Desks")}
        ${item("projects", "All projects")}
      </nav>`;
}

/** A compact project picker. Hidden unless there is more than one project. */
export function renderProjectSwitcher(meta: RenderMeta, view: ViewName): string {
  const projects = meta.projects ?? [];
  if (projects.length < 2) return "";
  const overview = view === "projects";
  const options =
    (overview ? `<option value="">Go to project…</option>` : "") +
    projects
      .map(
        (project) =>
          `<option value="${escapeAttr(project.id)}"${!overview && project.id === meta.activeProjectId ? " selected" : ""}>${escapeHtml(project.name)}</option>`,
      )
      .join("");
  return `<form class="project-switch" method="get" action="/" data-role="project-switch">
        <input type="hidden" name="view" value="${overview ? "org" : view}">
        <label class="project-switch__label" for="project-select">Project</label>
        <select id="project-select" name="project" data-role="project-select">${options}</select>
        <noscript><button type="submit">Switch</button></noscript>
      </form>`;
}

/** Submits the picker as soon as a different project is chosen. */
export const PROJECT_SWITCH_SCRIPT = `<script>
(function () {
  var form = document.querySelector('[data-role="project-switch"]');
  if (!form) return;
  var select = form.querySelector('[data-role="project-select"]');
  if (select) select.addEventListener("change", function () { form.submit(); });
}());
</script>`;


export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function domId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function shortRole(description: string): string {
  const compact = description.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const sentence = compact.split(/[.;]/)[0].trim();
  return sentence.length > 54 ? `${sentence.slice(0, 53).trimEnd()}…` : sentence;
}

/**
 * One desk scene, drawn twice: an upright typing pose and a slumped sleeping
 * pose. CSS shows the one that matches the desk state, so a live status change
 * never needs to reload the page.
 */
const DESK_SCENE = `
<svg class="scene" viewBox="0 0 220 150" aria-hidden="true" focusable="false">
  <ellipse class="floor" cx="110" cy="136" rx="84" ry="9"/>
  <g class="chair">
    <rect x="42" y="66" width="8" height="44" rx="4"/>
    <rect x="46" y="106" width="34" height="7" rx="3"/>
    <rect x="50" y="113" width="4" height="16"/>
    <rect x="74" y="113" width="4" height="16"/>
  </g>
  <g class="pose pose--sleeping">
    <path class="shirt" d="M55 106 q3-26 22-26 q21 0 23 26 z"/>
    <circle class="skin" cx="74" cy="86" r="13"/>
    <path class="hair" d="M61 80 q6-13 22-5 q4 2 5 7"/>
    <path class="shirt arm" d="M94 100 q12 1 20 5" stroke-width="6" fill="none"/>
    <text class="zzz zzz--a" x="146" y="54">z</text>
    <text class="zzz zzz--b" x="158" y="42">z</text>
    <text class="zzz zzz--c" x="170" y="30">Z</text>
  </g>
  <g class="pose pose--working">
    <path class="shirt" d="M56 106 q2-30 22-30 q21 0 22 30 z"/>
    <circle class="skin" cx="78" cy="62" r="13"/>
    <path class="hair" d="M65 57 q6-12 24-5 q3 2 3 6"/>
    <rect class="shirt arm arm--left" x="88" y="92" width="20" height="6" rx="3"/>
    <rect class="shirt arm arm--right" x="98" y="84" width="18" height="6" rx="3"/>
    <rect class="keyboard" x="106" y="104" width="40" height="5" rx="2"/>
  </g>
  <g class="desk">
    <rect class="desk-top" x="96" y="106" width="116" height="7" rx="3"/>
    <rect class="desk-front" x="104" y="113" width="100" height="4"/>
    <rect class="desk-leg" x="112" y="117" width="5" height="16"/>
    <rect class="desk-leg" x="192" y="117" width="5" height="16"/>
  </g>
  <g class="monitor">
    <rect class="frame" x="118" y="62" width="60" height="40" rx="4"/>
    <rect class="screen" x="122" y="66" width="52" height="32" rx="2"/>
    <g class="code">
      <rect x="127" y="72" width="30" height="3" rx="1.5"/>
      <rect x="127" y="78" width="40" height="3" rx="1.5"/>
      <rect x="127" y="84" width="22" height="3" rx="1.5"/>
      <rect x="127" y="90" width="34" height="3" rx="1.5"/>
    </g>
    <rect class="frame" x="144" y="102" width="8" height="4"/>
    <rect class="frame" x="134" y="106" width="28" height="4" rx="2"/>
  </g>
  <g class="mug">
    <rect x="196" y="94" width="10" height="12" rx="3"/>
    <path d="M206 97 q6 3 0 7" fill="none"/>
  </g>
</svg>`;

function renderDesk(desk: Desk, editing = false, projectId?: string): string {
  const id = domId(desk.id);
  const role = shortRole(desk.description);
  const statusLabel = desk.status === "working" ? "Working" : "Sleeping";
  const elapsed =
    desk.status === "working" && desk.elapsedMs != null
      ? ` · ${formatDuration(desk.elapsedMs)}`
      : "";
  const editLink =
    editing && desk.editable
      ? `<a class="desk__edit" href="/agents/${encodeURIComponent(desk.id)}/edit?view=desks${projectQuery(projectId)}" aria-label="Edit ${escapeAttr(desk.name)}">Edit</a>`
      : "";
  return `
<article class="desk desk--${desk.status}${desk.visitor ? " desk--visitor" : ""}"
         data-desk="${escapeAttr(desk.id)}" data-status="${desk.status}"
         style="--tone:${escapeAttr(desk.tone)}"
         aria-labelledby="desk-${id}-title">
  <div class="desk__head">
    <span class="avatar" aria-hidden="true">${escapeHtml(desk.initials)}</span>
    <div class="desk__name">
      <h2 id="desk-${id}-title">${escapeHtml(desk.name)}</h2>
      <p class="desk__role"${role ? ` title="${escapeAttr(desk.description)}"` : " hidden"}>${escapeHtml(role)}</p>
    </div>
    ${editLink}
    <span class="chip chip--visitor" data-role="visitor"${desk.visitor ? "" : " hidden"}>visitor</span>
  </div>
  <div class="desk__scene">${DESK_SCENE}</div>
  <p class="desk__status">
    <span class="status-dot" aria-hidden="true"></span>
    <span data-role="status">${statusLabel}</span>
    <span class="desk__elapsed" data-role="elapsed">${escapeHtml(elapsed)}</span>
    <span class="chip chip--progress" data-role="progress"${desk.progress ? "" : " hidden"}>${escapeHtml(desk.progress ?? "")}</span>
  </p>
  <p class="desk__task" data-role="task">${escapeHtml(desk.task)}</p>
  <p class="desk__detail" data-role="detail">${escapeHtml(desk.detail)}</p>
</article>`;
}

export function renderPage(snapshot: Snapshot, meta: RenderMeta): string {
  const title = `Agent Monitor — ${snapshot.project.name}`;
  const working = snapshot.summary.working;
  const asleep = working === 0;
  const deskMarkup =
    snapshot.desks.length > 0
      ? snapshot.desks.map((desk) => renderDesk(desk, Boolean(meta.editing), meta.activeProjectId)).join("\n")
      : `<p class="empty">No agent desks are configured for this project.</p>`;
  const banner = `<div class="banner" role="alert" data-role="error"${snapshot.error ? "" : " hidden"}><strong>Cannot read OpenCode state.</strong> <span data-role="error-text">${escapeHtml(snapshot.error ?? "")}</span></div>`;
  const notice = meta.notice
    ? `<div class="notice notice--success" role="status">${escapeHtml(meta.notice)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<noscript><meta http-equiv="refresh" content="15"></noscript>
<style>
:root {
  --bg: #f6f1e8;
  --panel: #fffdf8;
  --ink: #1f262e;
  --muted: #5d6670;
  --faint: #6f6557;
  --line: #e4dacb;
  --line-strong: #cdbfa9;
  --working: #0f766e;
  --working-soft: #def0ec;
  --sleeping: #6d6458;
  --sleeping-soft: #eee8de;
  --shadow: 0 18px 34px -26px rgba(60, 46, 28, 0.55);
  --radius: 16px;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--ink);
  background:
    radial-gradient(1100px 520px at 50% -12%, #fffdf8 0%, rgba(255, 253, 248, 0) 70%),
    var(--bg);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
a { color: var(--working); }
a:focus-visible, button:focus-visible {
  outline: 2px solid var(--working);
  outline-offset: 3px;
}
.skip {
  position: absolute;
  left: 16px;
  top: -60px;
  z-index: 10;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--ink);
  color: #fff;
  text-decoration: none;
}
.skip:focus { top: 16px; }
html, body { height: 100%; }
body { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.shell { width: 100%; min-width: 0; margin: 0 auto; padding: 0 clamp(14px, 2vw, 30px); display: flex; flex-direction: column; flex: 1; min-height: 0; }
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 16px 0 12px;
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
}
.brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.brand > div { min-width: 0; }
.brand-mark {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 14px;
  background: var(--working-soft);
  color: var(--working);
  flex: 0 0 auto;
}
.brand-mark svg { width: 28px; height: 28px; }
h1 {
  margin: 0;
  font-size: 25px;
  line-height: 1.1;
  letter-spacing: -0.015em;
  font-weight: 650;
}
.project {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.project .path {
  color: var(--faint);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
}
.sep { color: var(--line-strong); padding: 0 5px; }
.top__actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; flex-wrap: wrap; }
.view-switch {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #f1eadf;
}
.view-switch__item {
  padding: 5px 11px;
  border-radius: 999px;
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.view-switch__item:hover { color: var(--working); }
.view-switch__item.is-active {
  background: var(--panel);
  color: var(--ink);
  box-shadow: 0 1px 4px rgba(60, 46, 28, 0.16);
}
.project-switch { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
.project-switch__label { color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.project-switch select { max-width: 190px; padding: 6px 4px; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 12px; font-weight: 600; }
.project-switch select:focus-visible { outline: 2px solid var(--working); outline-offset: 2px; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 13px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--panel);
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.btn:hover { border-color: var(--working); color: var(--working); }
.btn--primary { border-color: var(--working); background: var(--working); color: #fff; }
.btn--primary:hover { background: #0b5f58; color: #fff; }
.live {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  flex: 0 0 auto;
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--working);
  box-shadow: 0 0 0 4px rgba(15, 118, 110, 0.12);
  animation: live-pulse 2.6s ease-in-out infinite;
}
.live--off .live-dot { background: var(--faint); box-shadow: none; animation: none; }
.summary {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 10px 0 4px;
  flex: 0 0 auto;
}
.summary__counts {
  margin: 0;
  font-size: 15px;
  color: var(--muted);
}
.summary__counts strong { color: var(--ink); font-size: 17px; font-weight: 650; }
.summary__time { margin: 0; font-size: 12px; color: var(--faint); letter-spacing: 0.02em; }
.all-asleep { margin: 0; font-size: 13px; color: var(--sleeping); }
.banner {
  margin: 18px 0 0;
  padding: 14px 16px;
  border: 1px solid #d9b6a6;
  border-radius: 12px;
  background: #fbf0e9;
  color: #7a3b24;
}
.banner strong { display: block; }

.office {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(232px, 1fr));
  align-content: start;
  gap: 16px;
  padding: 14px 0 22px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.empty {
  margin: 24px 0;
  padding: 22px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius);
  color: var(--muted);
  text-align: center;
}

.desk {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 15px 15px 17px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: var(--shadow);
  transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
}
.desk:hover { transform: translateY(-2px); }
.desk--working {
  border-color: #b9dcd4;
  box-shadow: 0 0 0 1px rgba(15, 118, 110, 0.10), var(--shadow);
}
.desk--sleeping { background: #fffcf7; }
.desk--visitor { border-style: dashed; }

.desk__head { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.avatar {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--tone, #64748b);
  color: #fff;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
  flex: 0 0 auto;
}
.desk__name { min-width: 0; flex: 1 1 auto; }
.desk__edit {
  flex: 0 0 auto;
  margin-top: 2px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #faf5ec;
  color: var(--muted);
  font-size: 11px;
  text-decoration: none;
}
.desk__edit:hover { border-color: var(--working); color: var(--working); }
.desk__name h2 {
  margin: 1px 0 0;
  font-size: 16px;
  font-weight: 640;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.desk__role {
  margin: 3px 0 0;
  color: var(--faint);
  font-size: 11.5px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip {
  display: inline-block;
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #faf5ec;
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.5;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  white-space: nowrap;
}
.chip--visitor { flex: 0 0 auto; }
.chip--progress { border-color: #c9ddd8; background: var(--working-soft); color: var(--working); }

.desk__scene { margin: 6px -4px 0; }
.scene { display: block; width: 100%; height: auto; max-height: 168px; }
.scene .floor { fill: #efe8db; }
.scene .chair rect { fill: #cbb99e; }
.scene .shirt { fill: var(--tone, #64748b); }
.scene .skin { fill: #eac9a8; }
.scene .hair { fill: #5b4633; }
.scene .keyboard { fill: #e2d5c0; }
.scene .desk-top { fill: #d8c5a5; }
.scene .desk-front { fill: #c4b091; }
.scene .desk-leg { fill: #bfac8f; }
.scene .monitor .frame { fill: #2a333e; }
.scene .screen { fill: #121b24; }
.scene .code rect { fill: #93a5ba; }
.scene .code rect:nth-child(odd) { fill: var(--tone, #0f766e); }
.scene .mug rect { fill: #f8f1e5; stroke: #ded2c0; }
.scene .mug path { stroke: #ded2c0; }
.scene .zzz { fill: var(--sleeping); font-family: Georgia, "Times New Roman", serif; font-weight: 700; opacity: 0; }

.desk--working .pose--sleeping { display: none; }
.desk--sleeping .pose--working { display: none; }
.desk--sleeping .monitor { opacity: 0.72; }
.desk--sleeping .screen { fill: #2b333c; }
.desk--sleeping .code { opacity: 0.18; }
.desk--working .screen { filter: drop-shadow(0 0 9px rgba(15, 118, 110, 0.45)); }

.desk--working .arm--right { animation: typing 460ms ease-in-out infinite alternate; }
.desk--working .arm--left { animation: typing 460ms ease-in-out 200ms infinite alternate; }
.desk--working .code rect { animation: code-blink 2.4s ease-in-out infinite; }
.desk--working .code rect:nth-child(2) { animation-delay: 300ms; }
.desk--working .code rect:nth-child(3) { animation-delay: 600ms; }
.desk--working .code rect:nth-child(4) { animation-delay: 900ms; }
.desk--sleeping .zzz--a { animation: z-float 3.8s ease-in-out 200ms infinite; font-size: 11px; }
.desk--sleeping .zzz--b { animation: z-float 3.8s ease-in-out 1.4s infinite; font-size: 15px; }
.desk--sleeping .zzz--c { animation: z-float 3.8s ease-in-out 2.6s infinite; font-size: 19px; }

.desk__status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 9px 0 0;
  font-size: 12px;
  letter-spacing: 0.01em;
  color: var(--sleeping);
}
.desk--working .desk__status { color: var(--working); }
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sleeping);
  flex: 0 0 auto;
}
.desk--working .status-dot { background: var(--working); }
.desk__elapsed { color: var(--faint); }
.desk__task {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.7em;
  margin: 7px 0 0;
  font-size: 13.5px;
  line-height: 1.35;
  color: var(--ink);
}
.desk--sleeping .desk__task { color: var(--muted); }
.desk__detail {
  margin: 4px 0 0;
  color: var(--faint);
  font-size: 11.5px;
  line-height: 1.4;
  min-height: 1.4em;
}

.foot {
  padding: 9px 0 12px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 11.5px;
  flex: 0 0 auto;
}
.foot p { margin: 0 0 4px; max-width: 96ch; }
.foot p:last-child { margin-bottom: 0; }
.foot__meta { color: var(--faint); }
.foot code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  color: var(--faint);
}
.notice {
  margin: 14px 0 0;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fbf6ed;
  color: var(--muted);
  font-size: 12.5px;
}
.notice--success {
  border-color: #b9dcd4;
  background: var(--working-soft);
  color: var(--working);
}

@keyframes typing {
  from { transform: translateY(0); }
  to { transform: translateY(-2.5px); }
}
@keyframes code-blink {
  0%, 100% { opacity: 0.42; }
  50% { opacity: 1; }
}
@keyframes z-float {
  0% { opacity: 0; transform: translateY(7px); }
  25% { opacity: 0.75; }
  65% { opacity: 0.55; }
  100% { opacity: 0; transform: translateY(-9px); }
}
@keyframes live-pulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.10); }
  50% { box-shadow: 0 0 0 6px rgba(15, 118, 110, 0.04); }
}

@media (max-width: 700px) {
  html, body { height: auto; overflow: auto; }
  body { height: auto; }
  .shell { width: 100%; max-width: 100vw; padding: 0 12px; min-height: 100vh; }
  .top { flex-direction: column; align-items: flex-start; gap: 12px; padding-top: 18px; }
  .top__actions { align-self: stretch; width: 100%; max-width: 100%; flex-wrap: wrap; }
  .live { align-self: flex-start; }
  h1 { font-size: 22px; }
  .project .sep, .project .path { display: none; }
  .office { grid-template-columns: 1fr; overflow: visible; }
}
@media (prefers-reduced-motion: reduce) {
  *, .live-dot, .arm, .code rect, .zzz { animation: none !important; transition: none !important; }
  .desk--working .screen { filter: none; }
  .desk--sleeping .zzz { opacity: 0.5; }
}
</style>
</head>
<body>
<a class="skip" href="#desks">Skip to agent desks</a>
<div class="shell">
  <header class="top">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" role="presentation">
          <rect x="3" y="6" width="26" height="18" rx="4" fill="currentColor" opacity="0.14"/>
          <rect x="6" y="9" width="20" height="12" rx="2" fill="currentColor" opacity="0.85"/>
          <rect x="14" y="24" width="4" height="2" fill="currentColor"/>
          <rect x="9" y="26" width="14" height="2" rx="1" fill="currentColor"/>
        </svg>
      </span>
      <div>
        <h1>Agent Monitor</h1>
        <p class="project">
          <span>${escapeHtml(snapshot.project.name)}</span><span class="sep">·</span><span class="path">${escapeHtml(snapshot.project.path || "unknown project path")}</span>
        </p>
      </div>
    </div>
    <div class="top__actions">
      ${renderViewNav("desks", meta.activeProjectId)}
      ${renderProjectSwitcher(meta, "desks")}
      ${meta.editing ? `<a class="btn btn--primary" href="/agents/new?view=desks${projectQuery(meta.activeProjectId)}">New agent</a>` : ""}
      <div class="live" data-role="live">
        <span class="live-dot" aria-hidden="true"></span><span data-role="connection">live</span>
      </div>
    </div>
  </header>

  <section class="summary" aria-label="Activity summary">
    <p class="summary__counts" aria-live="polite" aria-atomic="true">
      <strong data-role="working">${working}</strong> working
      <span class="sep">·</span> <strong data-role="sleeping">${snapshot.summary.sleeping}</strong> sleeping
      <span class="sep">·</span> <span data-role="total">${snapshot.summary.total}</span> desks
    </p>
    <p class="summary__time">as of <span data-role="clock">${clock(snapshot.generatedAt)}</span></p>
    <p class="all-asleep" data-role="asleep"${asleep ? "" : " hidden"}>Everyone is asleep.</p>
  </section>

  ${banner}
  ${notice}

  <noscript>
    <p class="notice">Live updates are off because JavaScript is disabled. This page refreshes itself every 15 seconds, and the desks below are still fully readable.</p>
  </noscript>

  <main id="desks" class="office${asleep ? " office--asleep" : ""}" aria-label="Agent desks">
    ${deskMarkup}
  </main>

  <footer class="foot">
    <p><strong>Working</strong> means the agent has a live, busy OpenCode session.
       <strong>Sleeping</strong> means it has no active task. This dashboard is read-only:
       it never starts, stops or messages an agent.
       ${meta.editing ? "Agent files can be edited from their desks." : "Agent editing is disabled."}</p>
    <p class="foot__meta">Database <code>${escapeHtml(meta.databasePath)}</code>
       · stale after ${escapeHtml(String(meta.staleMinutes))} min
       · <a href="/?view=desks">Refresh</a></p>
  </footer>
</div>

${PROJECT_SWITCH_SCRIPT}
<script>
(function () {
  "use strict";
  var rosterHash = ${JSON.stringify(snapshot.rosterHash ?? "")};
  var projectId = ${JSON.stringify(meta.activeProjectId ?? "")};
  var liveUrl = "/events" + (projectId ? "?project=" + encodeURIComponent(projectId) : "");
  var stateUrl = "/api/state" + (projectId ? "?project=" + encodeURIComponent(projectId) : "");
  var desks = {};
  var nodes = document.querySelectorAll("[data-desk]");
  for (var i = 0; i < nodes.length; i += 1) {
    desks[nodes[i].getAttribute("data-desk")] = nodes[i];
  }
  var currentIds = Object.keys(desks).sort().join("|");

  function pad(value) { return (value < 10 ? "0" : "") + value; }
  function clock(ms) {
    var date = new Date(ms);
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }
  function duration(ms) {
    if (ms == null || !isFinite(ms)) return "";
    var seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return Math.max(1, seconds) + "s";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m";
    var hours = Math.floor(minutes / 60);
    var restMinutes = minutes % 60;
    if (hours < 24) return restMinutes ? hours + "h " + restMinutes + "m" : hours + "h";
    var days = Math.floor(hours / 24);
    var restHours = hours % 24;
    return restHours ? days + "d " + restHours + "h" : days + "d";
  }
  function text(root, role, value) {
    var node = root.querySelector('[data-role="' + role + '"]');
    if (node && node.textContent !== value) node.textContent = value;
  }
  function toggle(root, role, show) {
    var node = root.querySelector('[data-role="' + role + '"]');
    if (node) node.hidden = !show;
  }

  function apply(state) {
    if (!state) return;
    var failed = Boolean(state.error);
    toggle(document, "error", failed);
    if (failed) {
      text(document, "error-text", state.error);
      text(document, "clock", clock(state.generatedAt));
      return;
    }
    if (!state.desks) return;
    if (state.rosterHash && state.rosterHash !== rosterHash) {
      window.location.reload();
      return;
    }
    var ids = state.desks.map(function (desk) { return desk.id; }).sort().join("|");
    if (ids !== currentIds) { window.location.reload(); return; }

    text(document, "working", String(state.summary.working));
    text(document, "sleeping", String(state.summary.sleeping));
    text(document, "total", String(state.summary.total));
    text(document, "clock", clock(state.generatedAt));
    toggle(document, "asleep", state.summary.working === 0);

    var office = document.querySelector(".office");
    if (office) office.classList.toggle("office--asleep", state.summary.working === 0);

    for (var index = 0; index < state.desks.length; index += 1) {
      var desk = state.desks[index];
      var el = desks[desk.id];
      if (!el) { window.location.reload(); return; }
      el.classList.toggle("desk--working", desk.status === "working");
      el.classList.toggle("desk--sleeping", desk.status === "sleeping");
      el.classList.toggle("desk--visitor", Boolean(desk.visitor));
      el.setAttribute("data-status", desk.status);

      text(el, "status", desk.status === "working" ? "Working" : "Sleeping");
      text(el, "elapsed", desk.status === "working" && desk.elapsedMs != null ? " · " + duration(desk.elapsedMs) : "");
      text(el, "task", desk.task || "No task yet");
      text(el, "detail", desk.detail || "");

      var progress = el.querySelector('[data-role="progress"]');
      if (progress) {
        progress.hidden = !desk.progress;
        progress.textContent = desk.progress || "";
      }
      var visitor = el.querySelector('[data-role="visitor"]');
      if (visitor) visitor.hidden = !desk.visitor;
    }
  }

  var live = document.querySelector('[data-role="live"]');
  var connection = document.querySelector('[data-role="connection"]');
  function online() {
    if (live) live.classList.remove("live--off");
    if (connection) connection.textContent = "live";
  }
  function offline() {
    if (live) live.classList.add("live--off");
    if (connection) connection.textContent = "reconnecting";
  }

  if ("EventSource" in window) {
    var source = new EventSource(liveUrl);
    source.onopen = online;
    source.onmessage = function (event) {
      try { apply(JSON.parse(event.data)); } catch (error) { /* keep the last good view */ }
    };
    source.onerror = offline;
  } else {
    window.setInterval(function () {
      fetch(stateUrl)
        .then(function (response) { return response.json(); })
        .then(function (state) { online(); apply(state); })
        .catch(offline);
    }, 5000);
  }
}());
</script>
</body>
</html>`;
}

const FORM_STYLE = `
:root {
  --bg: #f6f1e8;
  --panel: #fffdf8;
  --ink: #1f262e;
  --muted: #5d6670;
  --faint: #6f6557;
  --line: #e4dacb;
  --line-strong: #cdbfa9;
  --working: #0f766e;
  --working-soft: #def0ec;
  --shadow: 0 18px 34px -26px rgba(60, 46, 28, 0.55);
  --radius: 16px;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--ink);
  background:
    radial-gradient(1100px 520px at 50% -12%, #fffdf8 0%, rgba(255, 253, 248, 0) 70%),
    var(--bg);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
a { color: var(--working); }
a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: 2px solid var(--working);
  outline-offset: 2px;
}
.shell { width: min(880px, 100% - 40px); margin: 0 auto; padding: 28px 0 48px; }
.top-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.top-bar h1 { margin: 0; font-size: 24px; letter-spacing: -0.015em; font-weight: 650; }
.top-bar p { margin: 3px 0 0; color: var(--muted); font-size: 13px; }
.back { font-size: 13px; text-decoration: none; white-space: nowrap; }
.card {
  padding: 22px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: var(--shadow);
}
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.field--wide { grid-column: 1 / -1; }
.field label { font-size: 12.5px; font-weight: 650; letter-spacing: 0.01em; }
.field .hint { color: var(--faint); font-size: 11.5px; line-height: 1.4; }
input[type="text"], textarea, select {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: #fffdf9;
  color: var(--ink);
  font: inherit;
  font-size: 13.5px;
}
input[readonly] { background: #f4efe5; color: var(--muted); }
textarea { resize: vertical; min-height: 90px; }
textarea.mono {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.5;
}
.required { color: #9a3f2c; }
.errors {
  margin: 0 0 18px;
  padding: 12px 14px;
  border: 1px solid #d9b6a6;
  border-radius: 10px;
  background: #fbf0e9;
  color: #7a3b24;
  font-size: 13px;
}
.errors p { margin: 0; }
.errors p + p { margin-top: 5px; }
.notice {
  margin: 0 0 18px;
  padding: 10px 14px;
  border: 1px solid #b9dcd4;
  border-radius: 10px;
  background: var(--working-soft);
  color: var(--working);
  font-size: 12.5px;
}
.actions { display: flex; align-items: center; gap: 10px; margin-top: 20px; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 9px 16px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--panel);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.btn:hover { border-color: var(--working); color: var(--working); }
.btn--primary { border-color: var(--working); background: var(--working); color: #fff; }
.btn--primary:hover { background: #0b5f58; color: #fff; }
.preserve {
  margin: 18px 0 0;
  padding: 11px 14px;
  border: 1px dashed var(--line-strong);
  border-radius: 10px;
  color: var(--muted);
  font-size: 12px;
}
.status-card { padding: 30px; }
.status-card p { color: var(--muted); }
@media (max-width: 620px) {
  .shell { width: min(880px, 100% - 24px); }
  .grid { grid-template-columns: 1fr; }
  .top-bar { flex-direction: column; align-items: flex-start; }
}
`;

export interface AgentFormOptions {
  mode: "create" | "edit";
  draft: AgentDraft;
  hash: string;
  csrf: string;
  errors: string[];
  notice?: string;
  view?: "desks" | "mindmap" | "org";
  projectId?: string;
  projectName?: string;
}

export function renderAgentForm(options: AgentFormOptions): string {
  const creating = options.mode === "create";
  const title = creating ? "New agent" : `Edit ${options.draft.name || options.draft.id}`;
  const action = creating ? "/agents" : `/agents/${encodeURIComponent(options.draft.id)}`;
  const backHref = options.view
    ? `/?view=${options.view}${projectQuery(options.projectId)}`
    : "/";
  const backLabel =
    options.view === "mindmap" ? "mind map" : options.view === "desks" ? "desks" : "org chart";
  const where = options.projectName
    ? `OpenCode agent in <strong>${escapeHtml(options.projectName)}</strong>.`
    : creating
      ? "Create a new OpenCode agent."
      : "Edit this OpenCode agent file.";
  const modeLabels: Record<string, string> = {
    "": "Default (all)",
    primary: "Primary",
    subagent: "Subagent",
    all: "All",
  };
  const modes = ["", ...AGENT_MODES].map((mode) => {
    const selected = options.draft.mode === mode ? " selected" : "";
    return `<option value="${escapeAttr(mode)}"${selected}>${escapeHtml(modeLabels[mode] ?? mode)}</option>`;
  }).join("");
  const errors = options.errors.length
    ? `<div class="errors" role="alert">${options.errors.map((message) => `<p>${escapeHtml(message)}</p>`).join("")}</div>`
    : "";
  const notice = options.notice
    ? `<div class="notice" role="status">${escapeHtml(options.notice)}</div>`
    : "";
  const idField = creating
    ? `<div class="field">
         <label for="agent-id">Agent id <span class="required">*</span></label>
         <input id="agent-id" name="id" type="text" required pattern="[a-z0-9][a-z0-9._-]*"
                maxlength="64" value="${escapeAttr(options.draft.id)}"
                placeholder="security-auditor" autocomplete="off">
         <span class="hint">Becomes the file name: <code>security-auditor.md</code>. Lowercase letters, numbers, dots, dashes, underscores.</span>
       </div>`
    : `<div class="field">
         <label for="agent-id">Agent id</label>
         <input id="agent-id" type="text" value="${escapeAttr(options.draft.id)}" readonly>
         <span class="hint">The file name is fixed; create a new agent to use another id.</span>
       </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} — Agent Monitor</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${FORM_STYLE}</style>
</head>
<body>
<div class="shell">
  <div class="top-bar">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p>${where}</p>
    </div>
    <a class="back" href="${backHref}">← Back to ${backLabel}</a>
  </div>

  <form class="card" method="post" action="${escapeAttr(action)}">
    ${errors}
    ${notice}
    <div class="grid">
      ${idField}
      <div class="field">
        <label for="agent-name">Display name</label>
        <input id="agent-name" name="name" type="text" maxlength="80"
               value="${escapeAttr(options.draft.name)}" placeholder="Security Auditor">
        <span class="hint">Shown in Agent Monitor only; stored in <code>${escapeHtml(ALIAS_FILE)}</code>.</span>
      </div>
      <div class="field field--wide">
        <label for="agent-description">Description / role <span class="required">*</span></label>
        <textarea id="agent-description" name="description" required maxlength="2000"
                  placeholder="Reviews code for security issues and risky changes.">${escapeHtml(options.draft.description)}</textarea>
        <span class="hint">Required by OpenCode. Used when deciding when to invoke this subagent.</span>
      </div>
      <div class="field">
        <label for="agent-mode">Mode</label>
        <select id="agent-mode" name="mode">${modes}</select>
        <span class="hint">Leave default to let OpenCode use <code>all</code>.</span>
      </div>
      <div class="field">
        <label for="agent-model">Model</label>
        <input id="agent-model" name="model" type="text" maxlength="200"
               value="${escapeAttr(options.draft.model)}" placeholder="provider/model-id">
        <span class="hint">Optional. Empty uses the inherited or global model.</span>
      </div>
      <div class="field">
        <label for="agent-color">Color</label>
        <input id="agent-color" name="color" type="text" maxlength="40"
               value="${escapeAttr(options.draft.color)}" placeholder="#3b82f6 or accent">
        <span class="hint">Hex color or theme name. Also colors the desk.</span>
      </div>
      <div class="field field--wide">
        <label for="agent-body">System prompt</label>
        <textarea id="agent-body" name="body" class="mono" rows="18"
                  placeholder="You are a security reviewer...">${escapeHtml(options.draft.body)}</textarea>
        <span class="hint">The markdown body after the frontmatter.</span>
      </div>
    </div>

    <input type="hidden" name="csrf" value="${escapeAttr(options.csrf)}">
    ${options.view ? `<input type="hidden" name="view" value="${escapeAttr(options.view)}">` : ""}
    ${options.projectId ? `<input type="hidden" name="project" value="${escapeAttr(options.projectId)}">` : ""}
    ${creating ? "" : `<input type="hidden" name="hash" value="${escapeAttr(options.hash)}">`}

    <div class="actions">
      <button class="btn btn--primary" type="submit">${creating ? "Create agent" : "Save changes"}</button>
      <a class="btn" href="${backHref}">Cancel</a>
    </div>

    <p class="preserve">Permissions, temperature, tools and any other frontmatter are preserved as written.
       Agent Monitor changes take effect in the dashboard immediately; a running OpenCode process may
       need to reload or restart before it sees them.</p>
  </form>
</div>
</body>
</html>`;
}

export function renderStatusPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} — Agent Monitor</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${FORM_STYLE}</style>
</head>
<body>
<div class="shell">
  <div class="top-bar">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p>Agent Monitor</p>
    </div>
    <a class="back" href="/">← Back to org chart</a>
  </div>
  <div class="card status-card" role="alert">
    <p>${escapeHtml(message)}</p>
    <div class="actions"><a class="btn btn--primary" href="/">Return to org chart</a></div>
  </div>
</div>
</body>
</html>`;
}
