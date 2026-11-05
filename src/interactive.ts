import {
  clock,
  escapeAttr,
  escapeHtml,
  PROJECT_SWITCH_SCRIPT,
  projectQuery,
  renderProjectSwitcher,
  renderViewNav,
  type RenderMeta,
} from "./render.ts";
import { formatDuration, type Desk, type Snapshot } from "./state.ts";

interface RadialNode {
  desk: Desk;
  children: RadialNode[];
  depth: number;
  leaves: number;
  angle: number;
  x: number;
  y: number;
}

interface RadialEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  path: string;
  active: boolean;
}

interface RadialLayout {
  center: RadialNode | null;
  nodes: RadialNode[];
  edges: RadialEdge[];
  rings: Array<{ rx: number; ry: number }>;
  maxDepth: number;
}

const VIEW_WIDTH = 1200;
const VIEW_HEIGHT = 720;
const CENTER_X = 600;
const CENTER_Y = 360;
const MAX_RX = 500;
const MAX_RY = 290;

function domId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function hashOf(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function metaOf(desk: Desk): string {
  if (desk.status === "working") {
    const label = desk.coordinating ? "Coordinating" : "Working";
    return `${label} · ${formatDuration(desk.elapsedMs) || "now"}`;
  }
  return desk.lastSeenAgoMs != null
    ? `Sleeping · ${formatDuration(desk.lastSeenAgoMs)} ago`
    : "Sleeping";
}

function buildRadialLayout(desks: Desk[]): RadialLayout {
  const byId = new Map(desks.map((desk) => [desk.id, desk]));
  const parentOf = new Map<string, string | null>();

  for (const desk of desks) {
    let parentId = desk.parentAgentId ?? null;
    if (parentId === desk.id || !parentId || !byId.has(parentId)) parentId = null;

    if (parentId) {
      const seen = new Set<string>([desk.id]);
      let cursor: string | null = parentId;
      while (cursor) {
        if (seen.has(cursor)) {
          parentId = null;
          break;
        }
        seen.add(cursor);
        const parent = byId.get(cursor);
        cursor = parent?.parentAgentId ?? null;
        if (cursor && !byId.has(cursor)) cursor = null;
      }
    }
    parentOf.set(desk.id, parentId);
  }

  const childrenOf = new Map<string, Desk[]>();
  const roots: Desk[] = [];
  for (const desk of desks) {
    const parentId = parentOf.get(desk.id);
    if (parentId) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(desk);
      childrenOf.set(parentId, list);
    } else {
      roots.push(desk);
    }
  }

  const singleRoot = roots.length === 1;
  const makeNode = (desk: Desk, depth: number): RadialNode => {
    const children = (childrenOf.get(desk.id) ?? []).map((child) => makeNode(child, depth + 1));
    return { desk, children, depth, leaves: 0, angle: 0, x: CENTER_X, y: CENTER_Y };
  };
  const rootNodes = roots.map((desk) => makeNode(desk, singleRoot ? 0 : 1));
  const center = singleRoot ? rootNodes[0] ?? null : null;

  let maxDepth = 0;
  const measure = (node: RadialNode): number => {
    maxDepth = Math.max(maxDepth, node.depth);
    if (node.children.length === 0) {
      node.leaves = 1;
      return 1;
    }
    node.leaves = node.children.reduce((total, child) => total + measure(child), 0);
    return node.leaves;
  };

  const place = (node: RadialNode, start: number, end: number): void => {
    node.angle = (start + end) / 2;
    if (node.children.length === 0) return;

    const totalLeaves = node.children.reduce((total, child) => total + child.leaves, 0);
    const gap = Math.min(0.05, ((end - start) * 0.035) / Math.max(1, node.children.length));
    let cursor = start;
    for (const child of node.children) {
      const span = (end - start) * (child.leaves / totalLeaves);
      const childStart = cursor + gap / 2;
      const childEnd = cursor + span - gap / 2;
      place(child, childEnd > childStart ? childStart : cursor, childEnd > childStart ? childEnd : cursor + span);
      cursor += span;
    }
    node.angle = (node.children[0].angle + node.children[node.children.length - 1].angle) / 2;
  };

  if (center) {
    measure(center);
    place(center, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2);
  } else {
    for (const root of rootNodes) measure(root);
    const totalLeaves = rootNodes.reduce((total, root) => total + root.leaves, 0) || 1;
    const gap = Math.min(0.05, (Math.PI * 2 * 0.035) / Math.max(1, rootNodes.length));
    let cursor = -Math.PI / 2;
    for (const root of rootNodes) {
      const span = Math.PI * 2 * (root.leaves / totalLeaves);
      const start = cursor + gap / 2;
      const end = cursor + span - gap / 2;
      place(root, end > start ? start : cursor, end > start ? end : cursor + span);
      cursor += span;
    }
  }

  const ringFraction = (depth: number): number => {
    if (depth <= 0) return 0;
    if (maxDepth <= 1) return depth === 1 ? 0.64 : 0;
    return 0.36 + ((depth - 1) / (maxDepth - 1)) * 0.64;
  };

  const nodes: RadialNode[] = [];
  const position = (node: RadialNode): void => {
    if (node.depth > 0) {
      const fraction = ringFraction(node.depth);
      node.x = CENTER_X + MAX_RX * fraction * Math.cos(node.angle);
      node.y = CENTER_Y + MAX_RY * fraction * Math.sin(node.angle);
    }
    nodes.push(node);
    for (const child of node.children) position(child);
  };
  for (const root of rootNodes) position(root);

  const edges: RadialEdge[] = [];
  const linkPath = (from: RadialEdge["from"], to: RadialEdge["to"], x1: number, y1: number, x2: number, y2: number): RadialEdge => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.max(1, Math.hypot(dx, dy));
    const direction = hashOf(`${from}>${to}`) % 2 === 0 ? 1 : -1;
    const bend = Math.min(36, length * 0.075) * direction;
    const mx = (x1 + x2) / 2 - (dy / length) * bend;
    const my = (y1 + y2) / 2 + (dx / length) * bend;
    return {
      from,
      to,
      x1,
      y1,
      x2,
      y2,
      path: `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      active: false,
    };
  };

  const targetDesk = (id: string): Desk | undefined => byId.get(id);
  const addEdges = (node: RadialNode): void => {
    for (const child of node.children) {
      const edge = linkPath(node.desk.id, child.desk.id, node.x, node.y, child.x, child.y);
      edge.active = targetDesk(child.desk.id)?.status === "working";
      edges.push(edge);
      addEdges(child);
    }
  };

  if (center) {
    addEdges(center);
  } else {
    for (const root of rootNodes) {
      const edge = linkPath("__root__", root.desk.id, CENTER_X, CENTER_Y, root.x, root.y);
      edge.active = targetDesk(root.desk.id)?.status === "working";
      edges.push(edge);
      addEdges(root);
    }
  }

  const rings: Array<{ rx: number; ry: number }> = [];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const fraction = ringFraction(depth);
    rings.push({ rx: MAX_RX * fraction, ry: MAX_RY * fraction });
  }

  return { center, nodes, edges, rings, maxDepth };
}

function renderNode(node: RadialNode): string {
  const desk = node.desk;
  const id = domId(desk.id);
  const deep = node.depth >= 3;
  const classes = [
    "radial-node",
    desk.status === "working" ? "is-working" : "is-sleeping",
    desk.visitor ? "is-visitor" : "",
    deep ? "radial-node--deep" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<article class="${classes}" data-agent="${escapeAttr(desk.id)}" data-status="${desk.status}"
         tabindex="0" style="left:${((node.x / VIEW_WIDTH) * 100).toFixed(2)}%;top:${((node.y / VIEW_HEIGHT) * 100).toFixed(2)}%;--tone:${escapeAttr(desk.tone)}"
         aria-label="${escapeAttr(desk.name)}: ${escapeAttr(metaOf(desk))}">
    <span class="radial-node__avatar" data-role="avatar" aria-hidden="true">${escapeHtml(desk.initials)}<i class="radial-node__dot"></i></span>
    <strong id="node-${id}">${escapeHtml(desk.name)}</strong>
    <span class="radial-node__meta" data-role="meta">${escapeHtml(metaOf(desk))}</span>
  </article>`;
}

function renderCenter(node: RadialNode): string {
  const desk = node.desk;
  const classes = [
    "radial-center",
    desk.status === "working" ? "is-working" : "is-sleeping",
    desk.visitor ? "is-visitor" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<article class="${classes}" data-agent="${escapeAttr(desk.id)}" data-status="${desk.status}"
         tabindex="0" style="--tone:${escapeAttr(desk.tone)}"
         aria-label="${escapeAttr(desk.name)}: ${escapeAttr(metaOf(desk))}">
    <span class="radial-center__avatar" data-role="avatar" aria-hidden="true">${escapeHtml(desk.initials)}<i class="radial-center__dot"></i></span>
    <strong>${escapeHtml(desk.name)}</strong>
    <span class="radial-center__meta" data-role="meta">${escapeHtml(metaOf(desk))}</span>
  </article>`;
}

function renderHub(snapshot: Snapshot): string {
  return `<div class="radial-hub" aria-hidden="true">
    <span class="radial-hub__mark">AM</span>
    <strong>${escapeHtml(snapshot.project.name)}</strong>
    <span>${snapshot.summary.working} working · ${snapshot.summary.sleeping} sleeping</span>
  </div>`;
}

function renderAgentCard(desk: Desk, editing: boolean, projectId?: string): string {
  const classes = [
    "agent-card",
    desk.status === "working" ? "is-working" : "is-sleeping",
    desk.visitor ? "is-visitor" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const editable = editing && Boolean(desk.editable);
  return `<article class="${classes}" data-agent-card="${escapeAttr(desk.id)}" data-status="${desk.status}" style="--tone:${escapeAttr(desk.tone)}">
    <div class="agent-card__top">
      <span class="agent-card__avatar" aria-hidden="true">${escapeHtml(desk.initials)}<i class="agent-card__dot"></i></span>
      <div class="agent-card__name">
        <strong>${escapeHtml(desk.name)}</strong>
        <span data-role="card-meta">${escapeHtml(metaOf(desk))}</span>
      </div>
      ${editable ? `<a class="agent-card__edit" href="/agents/${encodeURIComponent(desk.id)}/edit?view=mindmap${projectQuery(projectId)}" aria-label="Edit ${escapeAttr(desk.name)}">Edit</a>` : ""}
    </div>
    <p class="agent-card__task" data-role="card-task">${escapeHtml(desk.task)}</p>
    <p class="agent-card__detail" data-role="card-detail">${escapeHtml(desk.detail)}</p>
    <span class="agent-card__progress" data-role="card-progress"${desk.progress ? "" : " hidden"}>${escapeHtml(desk.progress ?? "")}</span>
  </article>`;
}

export function renderInteractivePage(snapshot: Snapshot, meta: RenderMeta): string {
  const layout = buildRadialLayout(snapshot.desks);
  const editing = Boolean(meta.editing);
  const title = `Agent mind map — ${snapshot.project.name}`;
  const working = snapshot.summary.working;
  const asleep = working === 0;
  const nodes = layout.nodes
    .filter((node) => node.desk.id !== layout.center?.desk.id)
    .map(renderNode)
    .join("\n");
  const center = layout.center ? renderCenter(layout.center) : renderHub(snapshot);
  const links = layout.edges
    .map(
      (edge) =>
        `<path class="radial-link${edge.active ? " radial-link--active" : ""}" data-edge="${escapeAttr(edge.from)}>${escapeAttr(edge.to)}" d="${edge.path}"></path>`,
    )
    .join("\n");
  const rings = layout.rings
    .map(
      (ring) =>
        `<ellipse class="radial-ring" cx="${CENTER_X}" cy="${CENTER_Y}" rx="${ring.rx.toFixed(1)}" ry="${ring.ry.toFixed(1)}"></ellipse>`,
    )
    .join("\n");
  const stageMinHeight = Math.max(520, 320 + layout.maxDepth * 110);
  const cards = snapshot.desks.map((desk) => renderAgentCard(desk, editing, meta.activeProjectId)).join("\n");
  const banner = `<div class="banner" role="alert" data-role="error"${snapshot.error ? "" : " hidden"}><strong>Cannot read OpenCode state.</strong> <span data-role="error-text">${escapeHtml(snapshot.error ?? "")}</span></div>`;
  const notice = meta.notice
    ? `<div class="notice" role="status">${escapeHtml(meta.notice)}</div>`
    : "";
  const initialDesks = snapshot.desks.map((desk) => ({
    id: desk.id,
    name: desk.name,
    initials: desk.initials,
    tone: desk.tone,
    status: desk.status,
    task: desk.task,
    detail: desk.detail,
    progress: desk.progress,
    elapsedMs: desk.elapsedMs,
    lastSeenAgoMs: desk.lastSeenAgoMs,
    coordinating: desk.coordinating,
    editable: Boolean(desk.editable),
    visitor: Boolean(desk.visitor),
    parentAgentId: desk.parentAgentId ?? null,
    subAgentIds: desk.subAgentIds ?? [],
  }));

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
  --shadow: 0 18px 34px -26px rgba(60, 46, 28, 0.55);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
html, body { height: 100%; }
body {
  margin: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--ink);
  background:
    radial-gradient(1100px 520px at 50% -12%, #fffdf8 0%, rgba(255, 253, 248, 0) 70%),
    var(--bg);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
a { color: var(--working); }
a:focus-visible, button:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--working);
  outline-offset: 3px;
}
.skip {
  position: absolute;
  left: 16px;
  top: -60px;
  z-index: 100;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--ink);
  color: #fff;
  text-decoration: none;
}
.skip:focus { top: 16px; }
.shell { width: 100%; min-width: 0; margin: 0 auto; padding: 0 clamp(14px, 2vw, 30px); display: flex; flex-direction: column; flex: 1; min-height: 0; }
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 16px 0 12px;
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
h1 { margin: 0; font-size: 25px; line-height: 1.1; letter-spacing: -0.015em; font-weight: 650; }
.project { margin: 5px 0 0; color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project .path { color: var(--faint); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }
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
.view-switch__item.is-active { background: var(--panel); color: var(--ink); box-shadow: 0 1px 4px rgba(60, 46, 28, 0.16); }
.project-switch { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
.project-switch__label { color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.project-switch select { max-width: 190px; padding: 6px 4px; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 12px; font-weight: 600; }
.project-switch select:focus-visible { outline: 2px solid var(--working); outline-offset: 2px; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
.summary__counts { margin: 0; font-size: 15px; color: var(--muted); }
.summary__counts strong { color: var(--ink); font-size: 17px; font-weight: 650; }
.summary__time { margin: 0; font-size: 12px; color: var(--faint); letter-spacing: 0.02em; }
.all-asleep { margin: 0; font-size: 13px; color: var(--sleeping); }
.banner {
  margin: 12px 0 0;
  padding: 14px 16px;
  border: 1px solid #d9b6a6;
  border-radius: 12px;
  background: #fbf0e9;
  color: #7a3b24;
}
.banner strong { display: block; }
.notice {
  margin: 12px 0 0;
  padding: 10px 14px;
  border: 1px solid #b9dcd4;
  border-radius: 10px;
  background: var(--working-soft);
  color: var(--working);
  font-size: 12.5px;
}
.hint { margin: 0 0 8px; color: var(--faint); font-size: 11.5px; flex: 0 0 auto; }
.interactive-layout {
  display: grid;
  grid-template-columns: minmax(250px, 300px) minmax(0, 1fr);
  gap: 18px;
  align-items: stretch;
  flex: 1;
  min-height: 0;
}
.agent-rail {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: rgba(255, 253, 248, 0.72);
  box-shadow: var(--shadow);
}
.agent-rail__head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 0 2px 9px; }
.agent-rail__head h2 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.agent-rail__head span { color: var(--faint); font-size: 10.5px; }
.agent-rail__list { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; overflow-y: auto; padding-right: 3px; }
.agent-card {
  position: relative;
  padding: 9px 10px 9px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fffdf8;
  transition: border-color 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
}
.agent-card.is-working { border-color: #a9d3c6; box-shadow: 0 0 0 1px rgba(15, 118, 110, 0.08); }
.agent-card.is-sleeping { filter: grayscale(1); opacity: 0.82; }
.agent-card.is-visitor { border-style: dashed; }
.agent-card__top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.agent-card__avatar {
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--tone, #64748b);
  color: #fff;
  font-size: 9.5px;
  font-weight: 650;
  flex: 0 0 auto;
}
.agent-card__dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border: 2px solid #fffdf8;
  border-radius: 50%;
  background: var(--sleeping);
}
.agent-card.is-working .agent-card__dot { background: var(--working); }
.agent-card__name { min-width: 0; flex: 1 1 auto; }
.agent-card__name strong {
  display: block;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-card.is-working .agent-card__name strong { color: var(--working); }
.agent-card__name span { display: block; margin-top: 1px; color: var(--faint); font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-card__edit {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: #fff;
  color: var(--muted);
  font-size: 9.5px;
  font-weight: 600;
  text-decoration: none;
}
.agent-card__edit:hover { border-color: var(--working); color: var(--working); }
.agent-card__task {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 7px 0 0;
  font-size: 11px;
  line-height: 1.3;
}
.agent-card__detail { margin: 2px 0 0; color: var(--faint); font-size: 9.5px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-card__progress { display: inline-block; margin-top: 5px; padding: 1px 6px; border: 1px solid #c9ddd8; border-radius: 999px; background: var(--working-soft); color: var(--working); font-size: 9px; letter-spacing: 0.04em; text-transform: uppercase; }

.radial-wrap {
  position: relative;
  margin: 0;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 28px;
  background:
    radial-gradient(620px 320px at 50% 50%, rgba(255, 255, 250, 0.94), rgba(255, 255, 250, 0) 74%),
    linear-gradient(180deg, #fbf7ef 0%, #f4efe4 100%);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.radial-stage { position: relative; width: 100%; min-width: 900px; height: 100%; min-height: 520px; }
.radial-stage::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: radial-gradient(rgba(150, 130, 100, 0.16) 1px, transparent 1px);
  background-size: 22px 22px;
  mask-image: radial-gradient(circle at 50% 50%, #000 0%, transparent 74%);
  pointer-events: none;
}
.radial-scroll { flex: 1; min-height: 0; overflow: auto; border-radius: inherit; }
.radial-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.radial-ring { fill: none; stroke: #d8ccb8; stroke-width: 1.5; stroke-dasharray: 4 9; }
.radial-link { fill: none; stroke: #c7b8a2; stroke-width: 1.6; }
.radial-link--active { stroke: #73b9ad; stroke-width: 2.2; filter: drop-shadow(0 0 4px rgba(115, 185, 173, 0.45)); }

.radial-node {
  position: absolute;
  z-index: 6;
  width: 116px;
  margin-left: -58px;
  text-align: center;
  transform: translateY(-23px);
  cursor: default;
}
.radial-node__avatar {
  position: relative;
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin: 0 auto;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--tone, #64748b);
  color: #fff;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
  box-shadow: 0 0 0 5px rgba(251, 247, 239, 0.96), 0 12px 18px -12px rgba(60, 46, 28, 0.9);
  transition: opacity 180ms ease, box-shadow 180ms ease;
}
.radial-node__dot {
  position: absolute;
  right: 0;
  bottom: 1px;
  width: 10px;
  height: 10px;
  border: 2px solid #fbf7ef;
  border-radius: 50%;
  background: var(--sleeping);
}
.radial-node.is-working .radial-node__avatar {
  box-shadow: 0 0 0 5px rgba(251, 247, 239, 0.96), 0 0 0 9px rgba(15, 118, 110, 0.18), 0 12px 18px -12px rgba(60, 46, 28, 0.9);
}
.radial-node.is-working .radial-node__dot { background: var(--working); }
.radial-node.is-sleeping { filter: grayscale(1); opacity: 0.76; }
.radial-node.is-visitor .radial-node__avatar { border-style: dashed; }
.radial-node[data-walking="true"] .radial-node__avatar { opacity: 0.08; }
.radial-node strong {
  display: block;
  margin-top: 5px;
  font-size: 12px;
  font-weight: 650;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.radial-node.is-working strong { color: var(--working); }
.radial-node__meta {
  display: block;
  margin-top: 1px;
  color: var(--faint);
  font-size: 9.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.radial-node--deep { width: 96px; margin-left: -48px; }
.radial-node--deep .radial-node__meta { display: none; }
.radial-node.is-talking .radial-node__avatar { animation: talk-ring 1.15s ease-in-out; }

.radial-center {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 7;
  display: grid;
  place-items: center;
  width: 126px;
  height: 126px;
  margin: -63px 0 0 -63px;
  border: 1px solid #a9d3c6;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 28%, #ffffff, #f7f3e8 68%);
  box-shadow: 0 0 0 12px rgba(15, 118, 110, 0.06), 0 24px 36px -26px rgba(60, 46, 28, 0.75);
  text-align: center;
  cursor: default;
}
.radial-center__avatar {
  position: relative;
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--tone, #3b6ea5);
  color: #fff;
  font-size: 14px;
  font-weight: 650;
  box-shadow: 0 0 0 4px rgba(255, 253, 248, 0.92);
  transition: opacity 180ms ease;
}
.radial-center__dot {
  position: absolute;
  right: 0;
  bottom: 1px;
  width: 10px;
  height: 10px;
  border: 2px solid #fffdf8;
  border-radius: 50%;
  background: var(--sleeping);
}
.radial-center.is-working .radial-center__dot { background: var(--working); }
.radial-center.is-working { box-shadow: 0 0 0 12px rgba(15, 118, 110, 0.06), 0 0 0 16px rgba(15, 118, 110, 0.05), 0 24px 36px -26px rgba(60, 46, 28, 0.75); }
.radial-center.is-sleeping { filter: grayscale(1); opacity: 0.8; }
.radial-center strong { display: block; margin-top: 4px; font-size: 14px; }
.radial-center__meta { display: block; color: var(--working); font-size: 10px; white-space: nowrap; }
.radial-center.is-sleeping .radial-center__meta { color: var(--faint); }
.radial-center[data-walking="true"] .radial-center__avatar { opacity: 0.08; }
.radial-center.is-talking { animation: talk-center 1.15s ease-in-out; }

.radial-hub {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 7;
  display: grid;
  place-items: center;
  width: 126px;
  height: 126px;
  margin: -63px 0 0 -63px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: radial-gradient(circle at 40% 30%, #fffdf8, #f2ecdf 72%);
  box-shadow: 0 0 0 12px rgba(205, 191, 169, 0.08), 0 24px 36px -26px rgba(60, 46, 28, 0.75);
  text-align: center;
}
.radial-hub__mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: var(--working-soft);
  color: var(--working);
  font-size: 12px;
  font-weight: 700;
}
.radial-hub strong { display: block; margin-top: 3px; max-width: 100px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.radial-hub span { display: block; color: var(--faint); font-size: 9px; }

.radial-legend {
  position: absolute;
  right: 18px;
  bottom: 16px;
  z-index: 10;
  display: flex;
  gap: 14px;
  padding: 8px 12px;
  border: 1px solid rgba(205, 191, 169, 0.75);
  border-radius: 999px;
  background: rgba(255, 253, 248, 0.78);
  backdrop-filter: blur(4px);
  color: var(--faint);
  font-size: 11px;
}
.radial-legend span { display: inline-flex; align-items: center; gap: 6px; }
.radial-legend i { width: 7px; height: 7px; border-radius: 50%; background: var(--sleeping); }
.radial-legend .on i { background: var(--working); box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.1); }

.walker {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 40;
  width: 38px;
  height: 38px;
  margin: -19px 0 0 -19px;
  pointer-events: none;
  will-change: transform;
}
.walker__avatar {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--tone, #64748b);
  color: #fff;
  font-size: 11px;
  font-weight: 650;
  box-shadow: 0 0 0 5px rgba(251, 247, 239, 0.9), 0 12px 18px -9px rgba(60, 46, 28, 0.9);
}
.walker--moving .walker__avatar { animation: walk-bob 420ms ease-in-out infinite alternate; }
.walker--talking .walker__avatar { animation: talk-bob 620ms ease-in-out infinite alternate; }
.walker__bubble {
  position: absolute;
  left: 50%;
  bottom: 50px;
  width: max-content;
  max-width: 200px;
  padding: 8px 11px;
  border-radius: 11px 11px 11px 3px;
  background: var(--ink);
  color: #fff;
  font-size: 11.5px;
  line-height: 1.3;
  box-shadow: 0 10px 18px -12px rgba(0, 0, 0, 0.8);
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
  transition: opacity 180ms ease, transform 180ms ease;
}
.walker__bubble::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: -6px;
  border: 7px solid transparent;
  border-left-color: var(--ink);
  border-top-color: var(--ink);
}
.walker--talking .walker__bubble { opacity: 1; transform: translateX(-50%) translateY(0); }
.walker--below .walker__bubble { top: 50px; bottom: auto; border-radius: 3px 11px 11px 11px; }
.walker--below .walker__bubble::after {
  top: -6px;
  bottom: auto;
  border-top-color: transparent;
  border-bottom-color: var(--ink);
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
.foot code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; color: var(--faint); }

@keyframes live-pulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.10); }
  50% { box-shadow: 0 0 0 6px rgba(15, 118, 110, 0.04); }
}
@keyframes walk-bob { from { transform: translateY(0); } to { transform: translateY(-4px); } }
@keyframes talk-bob { from { transform: translateY(0) scale(1); } to { transform: translateY(-2px) scale(1.04); } }
@keyframes talk-ring {
  0%, 100% { box-shadow: 0 0 0 5px rgba(251, 247, 239, 0.96), 0 0 0 9px rgba(15, 118, 110, 0.18); }
  50% { box-shadow: 0 0 0 5px rgba(251, 247, 239, 0.96), 0 0 0 14px rgba(15, 118, 110, 0.05); }
}
@keyframes talk-center {
  0%, 100% { box-shadow: 0 0 0 12px rgba(15, 118, 110, 0.08), 0 24px 36px -26px rgba(60, 46, 28, 0.75); }
  50% { box-shadow: 0 0 0 18px rgba(15, 118, 110, 0.14), 0 24px 36px -26px rgba(60, 46, 28, 0.75); }
}

@media (max-width: 980px) {
  html, body { height: auto; overflow: auto; }
  body { height: auto; }
  .shell { min-width: 0; max-width: 100vw; min-height: 100vh; }
  .interactive-layout { display: flex; flex-direction: column; flex: none; }
  .agent-rail { order: 2; height: auto; }
  .radial-wrap { order: 1; height: 520px; min-height: 520px; }
  .agent-rail__list { max-height: 320px; }
}
@media (max-width: 680px) {
  .top { flex-direction: column; align-items: flex-start; gap: 12px; }
  .top__actions { align-self: stretch; width: 100%; max-width: 100%; }
  .live { align-self: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  *, .live-dot, .walker__avatar, .radial-node__avatar, .radial-center__avatar { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<a class="skip" href="#radial">Skip to the agent mind map</a>
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
        <h1>Agent mind map</h1>
        <p class="project">
          <span>${escapeHtml(snapshot.project.name)}</span><span class="sep">·</span><span class="path">${escapeHtml(snapshot.project.path || "unknown project path")}</span>
        </p>
      </div>
    </div>
    <div class="top__actions">
      ${renderViewNav("mindmap", meta.activeProjectId)}
      ${renderProjectSwitcher(meta, "mindmap")}
      ${editing ? `<a class="btn btn--primary" href="/agents/new?view=mindmap${projectQuery(meta.activeProjectId)}">New agent</a>` : ""}
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
    <p class="notice">The walking animation needs JavaScript. The mind map below is still readable and refreshes every 15 seconds.</p>
  </noscript>

  <p class="hint">Rings show hierarchy depth. Edit agents from the list on the left; sleeping agents are shown in grayscale.</p>

  <div class="interactive-layout">
    <aside class="agent-rail" aria-label="Agents">
      <div class="agent-rail__head"><h2>Agents</h2><span>${snapshot.desks.length}</span></div>
      <div class="agent-rail__list">${cards}</div>
    </aside>

    <div class="radial-wrap">
      <div class="radial-scroll">
        <div class="radial-stage" id="radial" data-role="radial" style="min-height:${stageMinHeight}px">
          <svg class="radial-svg" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            ${rings}
            ${links}
          </svg>
          ${center}
          ${nodes}
          <div class="radial-legend" aria-hidden="true"><span class="on"><i></i>working</span><span><i></i>sleeping</span></div>
          <div class="walker" data-role="walker" hidden>
            <span class="walker__bubble" data-role="bubble" role="status" aria-live="polite"></span>
            <span class="walker__avatar" data-role="walker-avatar" aria-hidden="true"></span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <footer class="foot">
    <p><strong>Mind map</strong> maps coordinators and sub-agents as a radial tree. Each ring is another level of delegation.
       A coordinator walks outward along its link to assign work; a sub-agent walks inward to report when finished.</p>
    <p>The dashboard is read-only; agent files can be edited from the list on the left when editing is enabled.
       Database <code>${escapeHtml(meta.databasePath)}</code> · stale after ${escapeHtml(String(meta.staleMinutes))} min
       · <a href="/?view=mindmap${projectQuery(meta.activeProjectId)}">Refresh</a></p>
  </footer>
</div>

${PROJECT_SWITCH_SCRIPT}
<script>
(function () {
  "use strict";
  var rosterHash = ${jsonForScript(snapshot.rosterHash ?? "")};
  var projectId = ${jsonForScript(meta.activeProjectId ?? "")};
  var liveUrl = "/events" + (projectId ? "?project=" + encodeURIComponent(projectId) : "");
  var stateUrl = "/api/state" + (projectId ? "?project=" + encodeURIComponent(projectId) : "");
  var initialDesks = ${jsonForScript(initialDesks)};

  var pods = {};
  var nodes = document.querySelectorAll("[data-agent]");
  for (var i = 0; i < nodes.length; i += 1) pods[nodes[i].getAttribute("data-agent")] = nodes[i];
  var cards = {};
  var cardNodes = document.querySelectorAll("[data-agent-card]");
  for (var c = 0; c < cardNodes.length; c += 1) cards[cardNodes[c].getAttribute("data-agent-card")] = cardNodes[c];
  var currentIds = Object.keys(pods).sort().join("|");
  var previous = {};
  for (var p = 0; p < initialDesks.length; p += 1) previous[initialDesks[p].id] = stateOf(initialDesks[p]);

  var stage = document.querySelector('[data-role="radial"]');
  var walker = document.querySelector('[data-role="walker"]');
  var walkerAvatar = document.querySelector('[data-role="walker-avatar"]');
  var bubble = document.querySelector('[data-role="bubble"]');
  var edgePaths = {};
  var edgeNodes = document.querySelectorAll("[data-edge]");
  for (var e = 0; e < edgeNodes.length; e += 1) edgePaths[edgeNodes[e].getAttribute("data-edge")] = edgeNodes[e];
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var queue = Promise.resolve();

  function stateOf(desk) {
    return {
      status: desk.status,
      task: desk.task || "",
      parentAgentId: desk.parentAgentId || null,
      subAgentIds: (desk.subAgentIds || []).slice()
    };
  }

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
  function metaOf(desk) {
    if (desk.status === "working") return (desk.coordinating ? "Coordinating" : "Working") + " · " + (duration(desk.elapsedMs) || "now");
    return desk.lastSeenAgoMs != null ? "Sleeping · " + duration(desk.lastSeenAgoMs) + " ago" : "Sleeping";
  }
  function text(root, role, value) {
    var node = root.querySelector('[data-role="' + role + '"]');
    if (node && node.textContent !== value) node.textContent = value;
  }
  function toggle(root, role, show) {
    var node = root.querySelector('[data-role="' + role + '"]');
    if (node) node.hidden = !show;
  }
  function shorten(value, max) {
    var text = String(value || "").replace(/\\s+/g, " ").trim();
    max = max || 62;
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
  }
  function wait(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }
  function centerOf(element) {
    var stageRect = stage.getBoundingClientRect();
    var rect = element.getBoundingClientRect();
    return {
      x: rect.left - stageRect.left + rect.width / 2,
      y: rect.top - stageRect.top + rect.height / 2
    };
  }
  function translate(element, point) {
    element.style.transform = "translate(" + point.x + "px," + point.y + "px)";
  }
  function pathPoints(path, reverse) {
    var total = path.getTotalLength();
    var svg = path.ownerSVGElement;
    var svgRect = svg.getBoundingClientRect();
    var stageRect = stage.getBoundingClientRect();
    var steps = 36;
    var points = [];
    for (var step = 0; step <= steps; step += 1) {
      var t = step / steps;
      var point = path.getPointAtLength(total * (reverse ? 1 - t : t));
      points.push({
        x: (point.x / 1200) * svgRect.width + (svgRect.left - stageRect.left),
        y: (point.y / 720) * svgRect.height + (svgRect.top - stageRect.top)
      });
    }
    return points;
  }
  function fallbackPoints(source, target) {
    var start = centerOf(source);
    var end = centerOf(target);
    var mid = Math.abs(end.x - start.x) > Math.abs(end.y - start.y)
      ? { x: end.x, y: start.y }
      : { x: start.x, y: end.y };
    return [start, mid, end];
  }
  function edgeFor(source, target) {
    var direct = edgePaths[source + ">" + target];
    if (direct) return { path: direct, reverse: false };
    var reversed = edgePaths[target + ">" + source];
    if (reversed) return { path: reversed, reverse: true };
    return null;
  }
  function followPath(element, points, durationMs) {
    if (element.getAnimations) {
      element.getAnimations().forEach(function (animation) { animation.cancel(); });
    }
    translate(element, points[0]);
    if (!element.animate || points.length < 2) {
      translate(element, points[points.length - 1]);
      return wait(durationMs);
    }
    var keyframes = points.map(function (point) {
      return { transform: "translate(" + point.x + "px," + point.y + "px)" };
    });
    var animation = element.animate(keyframes, {
      duration: durationMs,
      easing: "linear",
      fill: "forwards"
    });
    return animation.finished.catch(function () {}).then(function () {
      translate(element, points[points.length - 1]);
    });
  }
  function updateAgent(element, desk) {
    element.classList.toggle("is-working", desk.status === "working");
    element.classList.toggle("is-sleeping", desk.status === "sleeping");
    element.classList.toggle("is-visitor", Boolean(desk.visitor));
    element.setAttribute("data-status", desk.status);
    text(element, "meta", metaOf(desk));
  }
  function updateCard(element, desk) {
    element.classList.toggle("is-working", desk.status === "working");
    element.classList.toggle("is-sleeping", desk.status === "sleeping");
    element.classList.toggle("is-visitor", Boolean(desk.visitor));
    element.setAttribute("data-status", desk.status);
    text(element, "card-meta", metaOf(desk));
    text(element, "card-task", desk.task || "No task yet");
    text(element, "card-detail", desk.detail || "");
    var progress = element.querySelector('[data-role="card-progress"]');
    if (progress) {
      progress.hidden = !desk.progress;
      progress.textContent = desk.progress || "";
    }
  }

  function enqueue(event) {
    if (!pods[event.source] || !pods[event.target]) return;
    queue = queue.then(function () { return performWalk(event); }).catch(function () {});
  }
  function performWalk(event) {
    var sourcePod = pods[event.source];
    var targetPod = pods[event.target];
    if (!sourcePod || !targetPod) return Promise.resolve();
    if (reduced) {
      targetPod.classList.add("is-talking");
      return wait(900).then(function () { targetPod.classList.remove("is-talking"); });
    }

    var sourceAvatar = sourcePod.querySelector('[data-role="avatar"]');
    var edge = edgeFor(event.source, event.target);
    var points = edge ? pathPoints(edge.path, edge.reverse) : fallbackPoints(sourcePod, targetPod);
    var durationMs = Math.max(950, Math.min(1900, points.length * 34));
    walkerAvatar.textContent = (sourceAvatar && sourceAvatar.textContent.trim()) || "?";
    walkerAvatar.style.setProperty("--tone", sourcePod.style.getPropertyValue("--tone") || "#64748b");
    bubble.textContent = event.message;
    sourcePod.setAttribute("data-walking", "true");
    walker.hidden = false;
    walker.classList.remove("walker--talking", "walker--below", "walker--moving");
    walker.classList.toggle("walker--below", points[points.length - 1].y < 150);
    walker.classList.add("walker--moving");

    return followPath(walker, points, durationMs)
      .then(function () {
        walker.classList.remove("walker--moving");
        walker.classList.add("walker--talking");
        targetPod.classList.add("is-talking");
        return wait(1250);
      })
      .then(function () {
        walker.classList.remove("walker--talking");
        targetPod.classList.remove("is-talking");
        walker.classList.add("walker--moving");
        return followPath(walker, points.slice().reverse(), durationMs);
      })
      .then(function () {
        walker.classList.remove("walker--moving");
        walker.hidden = true;
        sourcePod.removeAttribute("data-walking");
      })
      .catch(function () {
        walker.classList.remove("walker--moving", "walker--talking");
        walker.hidden = true;
        sourcePod.removeAttribute("data-walking");
        targetPod.classList.remove("is-talking");
      });
  }

  function apply(state) {
    if (!state) return;
    if (state.error) {
      toggle(document, "error", true);
      text(document, "error-text", state.error);
      text(document, "clock", clock(state.generatedAt));
      return;
    }
    toggle(document, "error", false);
    if (!state.desks) return;
    if (state.rosterHash && state.rosterHash !== rosterHash) { window.location.reload(); return; }
    var ids = state.desks.map(function (desk) { return desk.id; }).sort().join("|");
    if (ids !== currentIds) { window.location.reload(); return; }

    text(document, "working", String(state.summary.working));
    text(document, "sleeping", String(state.summary.sleeping));
    text(document, "total", String(state.summary.total));
    text(document, "clock", clock(state.generatedAt));
    toggle(document, "asleep", state.summary.working === 0);

    var next = {};
    state.desks.forEach(function (desk) { next[desk.id] = desk; });

    var events = [];
    state.desks.forEach(function (desk) {
      var pod = pods[desk.id];
      if (pod) updateAgent(pod, desk);
      var card = cards[desk.id];
      if (card) updateCard(card, desk);
      var prev = previous[desk.id];
      if (prev) {
        if (prev.status !== "working" && desk.status === "working" && desk.parentAgentId && desk.parentAgentId !== desk.id) {
          events.push({
            type: "assign",
            source: desk.parentAgentId,
            target: desk.id,
            message: "Assigning: " + shorten(desk.task || "new work")
          });
        }
        if (prev.status === "working" && desk.status === "sleeping" && desk.parentAgentId && desk.parentAgentId !== desk.id) {
          events.push({
            type: "done",
            source: desk.id,
            target: desk.parentAgentId,
            message: "Done: " + shorten(prev.task || desk.task || "the task")
          });
        }
        var oldSubs = prev.subAgentIds || [];
        var newSubs = desk.subAgentIds || [];
        for (var s = 0; s < newSubs.length; s += 1) {
          var childId = newSubs[s];
          if (oldSubs.indexOf(childId) === -1 && next[childId]) {
            events.push({
              type: "assign",
              source: desk.id,
              target: childId,
              message: "Assigning: " + shorten(next[childId].task || "new work")
            });
          }
        }
      }
      previous[desk.id] = stateOf(desk);
    });

    for (var edgeKey in edgePaths) {
      if (!Object.prototype.hasOwnProperty.call(edgePaths, edgeKey)) continue;
      var targetId = edgeKey.split(">")[1];
      var targetDesk = next[targetId];
      edgePaths[edgeKey].classList.toggle("radial-link--active", Boolean(targetDesk && targetDesk.status === "working"));
    }

    var seen = {};
    events.forEach(function (event) {
      var key = event.type + ":" + event.source + ">" + event.target;
      if (seen[key]) return;
      seen[key] = true;
      enqueue(event);
    });
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
      try { apply(JSON.parse(event.data)); } catch (error) { /* keep the last good mind map */ }
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
