import type { Overview, OverviewProject } from "./overview.ts";
import {
  PROJECT_SWITCH_SCRIPT,
  clock,
  escapeAttr,
  escapeHtml,
  renderProjectSwitcher,
  renderViewNav,
  type RenderMeta,
} from "./render.ts";

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function activeList(project: OverviewProject): string {
  if (project.error) {
    return `<li class="project-card__idle project-card__error">${escapeHtml(project.error)}</li>`;
  }
  if (project.active.length === 0) {
    return `<li class="project-card__idle">Everyone is asleep.</li>`;
  }
  return project.active
    .map(
      (agent) => `<li class="project-chip">
        <span class="project-chip__avatar" style="--tone:${escapeAttr(agent.tone)}" aria-hidden="true">${escapeHtml(agent.initials)}</span>
        <span class="project-chip__text"><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.task)}</span></span>
      </li>`,
    )
    .join("");
}

function renderProjectCard(project: OverviewProject): string {
  const share = project.total > 0 ? Math.round((project.working / project.total) * 100) : 0;
  const open = project.id
    ? `/?view=org&project=${encodeURIComponent(project.id)}`
    : "/";
  return `<article class="project-card${project.working > 0 ? " is-active" : ""}${project.error ? " has-error" : ""}"
           data-project-card="${escapeAttr(project.id)}">
    <header class="project-card__head">
      <div class="project-card__title">
        <h2><a href="${open}">${escapeHtml(project.name)}</a></h2>
        <p title="${escapeAttr(project.path)}">${escapeHtml(project.path || "unknown path")}</p>
      </div>
      <span class="project-card__pill" data-role="card-pill">${project.working > 0 ? `${project.working} working` : "idle"}</span>
    </header>
    <dl class="project-card__stats">
      <div><dt>Working</dt><dd data-role="card-working">${project.working}</dd></div>
      <div><dt>Sleeping</dt><dd data-role="card-sleeping">${project.sleeping}</dd></div>
      <div><dt>Agents</dt><dd data-role="card-total">${project.total}</dd></div>
    </dl>
    <div class="project-card__bar" aria-hidden="true"><i data-role="card-bar" style="width:${share}%"></i></div>
    <ul class="project-card__active" data-role="card-active">${activeList(project)}</ul>
    <footer class="project-card__foot">
      <a href="${open}">Open org chart →</a>
      <span>${project.total} agent${project.total === 1 ? "" : "s"}</span>
    </footer>
  </article>`;
}

export function renderProjectsPage(overview: Overview, meta: RenderMeta): string {
  const { totals } = overview;
  const cards = overview.projects.map(renderProjectCard).join("\n");
  const ids = overview.projects.map((project) => project.id);
  const banner = `<div class="banner" role="alert" data-role="error"${overview.error ? "" : " hidden"}><strong>Cannot refresh projects.</strong> <span data-role="error-text">${escapeHtml(overview.error ?? "")}</span></div>`;
  const notice = meta.notice
    ? `<div class="notice" role="status">${escapeHtml(meta.notice)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex">
<title>All projects — Agent Monitor</title>
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
  --shadow: 0 18px 34px -26px rgba(60, 46, 28, 0.55);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body {
  margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  color: var(--ink);
  background: radial-gradient(1100px 520px at 50% -12%, #fffdf8 0%, rgba(255, 253, 248, 0) 70%), var(--bg);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px; line-height: 1.5;
}
a { color: var(--working); }
a:focus-visible, button:focus-visible, select:focus-visible { outline: 2px solid var(--working); outline-offset: 3px; }
.skip { position: absolute; left: 16px; top: -60px; z-index: 100; padding: 10px 14px; border-radius: 10px; background: var(--ink); color: #fff; text-decoration: none; }
.skip:focus { top: 16px; }
.shell { width: 100%; min-width: 0; padding: 0 clamp(14px, 2vw, 30px); display: flex; flex-direction: column; flex: 1; min-height: 0; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 0 12px; flex: 0 0 auto; }
.brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.brand > div { min-width: 0; }
.brand-mark { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 14px; background: var(--working-soft); color: var(--working); flex: 0 0 auto; }
.brand-mark svg { width: 28px; height: 28px; }
h1 { margin: 0; font-size: 25px; line-height: 1.1; letter-spacing: -0.015em; font-weight: 650; }
.project { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
.top__actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; flex-wrap: wrap; }
.view-switch { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: #f1eadf; }
.view-switch__item { padding: 5px 11px; border-radius: 999px; color: var(--muted); font-size: 11.5px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.view-switch__item:hover { color: var(--working); }
.view-switch__item.is-active { background: var(--panel); color: var(--ink); box-shadow: 0 1px 4px rgba(60, 46, 28, 0.16); }
.project-switch { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
.project-switch__label { color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.project-switch select { max-width: 190px; padding: 6px 4px; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 12px; font-weight: 600; }
.live { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--muted); font-size: 12px; letter-spacing: .04em; text-transform: uppercase; flex: 0 0 auto; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--working); box-shadow: 0 0 0 4px rgba(15, 118, 110, .12); animation: live-pulse 2.6s ease-in-out infinite; }
.live--off .live-dot { background: var(--faint); box-shadow: none; animation: none; }
.summary { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 18px; padding: 10px 0 8px; flex: 0 0 auto; min-width: 0; }
.summary__counts { margin: 0; font-size: 15px; color: var(--muted); min-width: 0; }
.summary__counts strong { color: var(--ink); font-size: 17px; font-weight: 650; }
.summary__time { margin: 0; font-size: 12px; color: var(--faint); }
.sep { color: var(--line-strong); padding: 0 5px; }
.banner { margin: 8px 0 0; padding: 12px 16px; border: 1px solid #d9b6a6; border-radius: 12px; background: #fbf0e9; color: #7a3b24; }
.banner strong { display: block; }
.notice { margin: 8px 0 0; padding: 10px 14px; border: 1px solid #b9dcd4; border-radius: 10px; background: var(--working-soft); color: var(--working); font-size: 12.5px; }
.grid-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 2px 18px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 16px; min-width: 0; }
.project-card {
  display: flex; flex-direction: column; min-width: 0; min-height: 252px; padding: 18px;
  border: 1px solid var(--line); border-radius: 18px; background: var(--panel);
  box-shadow: 0 12px 24px -22px rgba(60, 46, 28, .6);
  transition: border-color 160ms ease, box-shadow 160ms ease;
}
.project-card.is-active { border-color: #a9d3c6; box-shadow: 0 0 0 1px rgba(15, 118, 110, .06), 0 16px 28px -22px rgba(60, 46, 28, .7); }
.project-card.has-error { border-color: #d9b6a6; background: #fdf7f1; }
.project-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
.project-card__title { min-width: 0; }
.project-card h2 { margin: 0; font-size: 17px; line-height: 1.25; letter-spacing: -.01em; }
.project-card h2 a { color: var(--ink); text-decoration: none; }
.project-card h2 a:hover { color: var(--working); }
.project-card__title p { margin: 5px 0 0; color: var(--faint); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-card__pill { flex: 0 0 auto; padding: 4px 9px; border: 1px solid var(--line); border-radius: 999px; background: #f4efe5; color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.project-card.is-active .project-card__pill { border-color: #b9dcd4; background: var(--working-soft); color: var(--working); }
.project-card__stats { display: flex; gap: 26px; margin: 16px 0 10px; }
.project-card__stats div { display: flex; flex-direction: column-reverse; gap: 1px; }
.project-card__stats dt { color: var(--faint); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.project-card__stats dd { margin: 0; font-size: 25px; font-weight: 650; line-height: 1; font-variant-numeric: tabular-nums; }
.project-card__bar { height: 6px; border-radius: 999px; background: #efe7d9; overflow: hidden; }
.project-card__bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #16a394, var(--working)); transition: width 300ms ease; }
.project-card__active { display: flex; flex-direction: column; gap: 7px; flex: 1; margin: 14px 0 0; padding: 0; list-style: none; min-height: 52px; }
.project-card__idle { color: var(--faint); font-size: 12px; font-style: italic; }
.project-card__error { color: #7a3b24; font-style: normal; }
.project-chip { display: flex; align-items: center; gap: 8px; min-width: 0; }
.project-chip__avatar { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--tone, #64748b); color: #fff; font-size: 8px; font-weight: 700; flex: 0 0 auto; }
.project-chip__text { min-width: 0; display: flex; gap: 6px; align-items: baseline; }
.project-chip__text strong { font-size: 11.5px; white-space: nowrap; }
.project-chip__text span { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-card__foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 11.5px; }
.project-card__foot a { font-weight: 700; text-decoration: none; }
.project-card__foot a:hover { text-decoration: underline; }
.project-card__foot span { color: var(--faint); }
.empty { display: grid; place-content: center; flex: 1; text-align: center; color: var(--muted); }
.empty strong { color: var(--ink); font-size: 22px; }
.empty p { max-width: 44ch; margin: 8px auto 0; }
.empty code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; color: var(--faint); }
.foot { padding: 9px 0 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; flex: 0 0 auto; }
.foot p { margin: 0 0 4px; max-width: 96ch; }
.foot p:last-child { margin-bottom: 0; }
.foot code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; color: var(--faint); }
@keyframes live-pulse { 0%, 100% { box-shadow: 0 0 0 3px rgba(15, 118, 110, .10); } 50% { box-shadow: 0 0 0 6px rgba(15, 118, 110, .04); } }
@media (max-width: 760px) {
  html, body { height: auto; overflow: auto; }
  body { height: auto; }
  .shell { max-width: 100vw; min-height: 100vh; }
  .top { flex-direction: column; align-items: flex-start; gap: 12px; }
  .top__actions { align-self: stretch; width: 100%; max-width: 100%; }
  .grid-scroll { overflow: visible; width: 100%; min-width: 0; }
  .grid { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  *, .live-dot, .project-card__bar i { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<a class="skip" href="#projects">Skip to projects</a>
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
        <h1>All projects</h1>
        <p class="project">Every OpenCode project in the database</p>
      </div>
    </div>
    <div class="top__actions">
      ${renderViewNav("projects")}
      ${renderProjectSwitcher(meta, "projects")}
      <div class="live" data-role="live">
        <span class="live-dot" aria-hidden="true"></span><span data-role="connection">live</span>
      </div>
    </div>
  </header>

  <section class="summary" aria-label="All project activity">
    <p class="summary__counts" aria-live="polite" aria-atomic="true">
      <strong data-role="working">${totals.working}</strong> working
      <span class="sep">·</span> <strong data-role="sleeping">${totals.sleeping}</strong> sleeping
      <span class="sep">·</span> <span data-role="total">${totals.total}</span> agents
      <span class="sep">·</span> <strong data-role="projects">${totals.projects}</strong> projects
    </p>
    <p class="summary__time">as of <span data-role="clock">${clock(overview.generatedAt)}</span></p>
  </section>

  ${banner}
  ${notice}
  <noscript><p class="notice">Live updates are off because JavaScript is disabled. This page refreshes every 15 seconds.</p></noscript>

  <div class="grid-scroll" id="projects">
    ${overview.projects.length === 0
      ? `<div class="empty"><strong>No projects found</strong><p>OpenCode has not recorded a project yet. Open a folder in OpenCode, then reload. Database <code>${escapeHtml(meta.databasePath)}</code>.</p></div>`
      : `<div class="grid">${cards}</div>`}
  </div>

  <footer class="foot">
    <p><strong>All projects</strong> summarises every project in the OpenCode database. Pick a project above or from the selector to open its org chart.</p>
    <p>Read-only · database <code>${escapeHtml(meta.databasePath)}</code> · stale after ${escapeHtml(String(meta.staleMinutes))} min</p>
  </footer>
</div>

${PROJECT_SWITCH_SCRIPT}
<script>
(function () {
  "use strict";
  var projectIds = ${jsonForScript(ids)};
  var live = document.querySelector('[data-role="live"]');
  var connection = document.querySelector('[data-role="connection"]');

  function pad(value) { return (value < 10 ? "0" : "") + value; }
  function clock(ms) {
    var date = new Date(ms);
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }
  function text(root, role, value) {
    var node = root.querySelector('[data-role="' + role + '"]');
    if (node && node.textContent !== value) node.textContent = value;
  }
  function cardFor(id) { return document.querySelector('[data-project-card="' + id + '"]'); }

  function renderActive(card, entry) {
    var list = card.querySelector('[data-role="card-active"]');
    if (!list) return;
    list.textContent = "";
    if (entry.error) {
      var fault = document.createElement("li");
      fault.className = "project-card__idle project-card__error";
      fault.textContent = entry.error;
      list.appendChild(fault);
      return;
    }
    if (!entry.active.length) {
      var idle = document.createElement("li");
      idle.className = "project-card__idle";
      idle.textContent = "Everyone is asleep.";
      list.appendChild(idle);
      return;
    }
    entry.active.forEach(function (agent) {
      var item = document.createElement("li");
      item.className = "project-chip";
      var avatar = document.createElement("span");
      avatar.className = "project-chip__avatar";
      avatar.style.setProperty("--tone", agent.tone);
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = agent.initials;
      var body = document.createElement("span");
      body.className = "project-chip__text";
      var name = document.createElement("strong");
      name.textContent = agent.name;
      var task = document.createElement("span");
      task.textContent = agent.task;
      body.appendChild(name);
      body.appendChild(task);
      item.appendChild(avatar);
      item.appendChild(body);
      list.appendChild(item);
    });
  }

  function apply(state) {
    if (!state) return;
    if (state.error) {
      text(document, "error-text", state.error);
      var faultBanner = document.querySelector('[data-role="error"]');
      if (faultBanner) faultBanner.hidden = false;
      return;
    }
    var banner = document.querySelector('[data-role="error"]');
    if (banner) banner.hidden = true;
    if (!state.projects) return;
    var ids = state.projects.map(function (entry) { return entry.id; }).sort();
    var expected = projectIds.slice().sort();
    if (ids.length !== expected.length || ids.some(function (id, index) { return id !== expected[index]; })) {
      window.location.reload();
      return;
    }
    text(document, "working", String(state.totals.working));
    text(document, "sleeping", String(state.totals.sleeping));
    text(document, "total", String(state.totals.total));
    text(document, "projects", String(state.totals.projects));
    text(document, "clock", clock(state.generatedAt));
    state.projects.forEach(function (entry) {
      var card = cardFor(entry.id);
      if (!card) return;
      card.classList.toggle("is-active", entry.working > 0);
      card.classList.toggle("has-error", Boolean(entry.error));
      text(card, "card-working", String(entry.working));
      text(card, "card-sleeping", String(entry.sleeping));
      text(card, "card-total", String(entry.total));
      text(card, "card-pill", entry.working > 0 ? entry.working + " working" : "idle");
      var bar = card.querySelector('[data-role="card-bar"]');
      if (bar) bar.style.width = (entry.total > 0 ? Math.round(entry.working / entry.total * 100) : 0) + "%";
      renderActive(card, entry);
    });
  }

  function online() {
    if (live) live.classList.remove("live--off");
    if (connection) connection.textContent = "live";
  }
  function offline() {
    if (live) live.classList.add("live--off");
    if (connection) connection.textContent = "reconnecting";
  }

  function poll() {
    fetch("/api/projects")
      .then(function (response) { return response.json(); })
      .then(function (state) { online(); apply(state); })
      .catch(offline);
  }
  poll();
  window.setInterval(poll, 5000);
}());
</script>
</body>
</html>`;
}
