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

interface OrgNode {
  desk: Desk | null;
  children: OrgNode[];
  depth: number;
  leaves: number;
  xIndex: number;
  x: number;
  y: number;
}

interface OrgEdge {
  from: string;
  to: string;
  path: string;
  active: boolean;
}

interface OrgLayout {
  root: OrgNode | null;
  nodes: OrgNode[];
  edges: OrgEdge[];
  maxDepth: number;
  leaves: number;
  stageWidth: number;
  stageHeight: number;
  hub: boolean;
  horizontal: boolean;
}

const LEAF_GAP = 296;
const ROW_GAP = 260;
const CARD_HEIGHT = 220;
const CARD_WIDTH = 264;
const COLUMN_GAP = 330;
const LEAF_ROW_GAP = 250;

function hierarchyKey(desks: Desk[]): string {
  return JSON.stringify(desks.map((desk) => [desk.id, desk.parentAgentId ?? null]).sort());
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function shortRole(description: string): string {
  const compact = description.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const sentence = compact.split(/[.;]/)[0].trim();
  return sentence.length > 46 ? `${sentence.slice(0, 45).trimEnd()}…` : sentence;
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

function buildOrgLayout(desks: Desk[]): OrgLayout {
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

  const makeNode = (desk: Desk, depth: number): OrgNode => {
    const children = (childrenOf.get(desk.id) ?? []).map((child) => makeNode(child, depth + 1));
    return { desk, children, depth, leaves: 0, xIndex: 0, x: 0, y: 0 };
  };

  const hub = roots.length > 1;
  const hubNode: OrgNode | null = hub
    ? {
        desk: null,
        children: roots.map((desk) => makeNode(desk, 1)),
        depth: 0,
        leaves: 0,
        xIndex: 0,
        x: 0,
        y: 0,
      }
    : null;
  const root = hubNode ?? (roots[0] ? makeNode(roots[0], 0) : null);

  let maxDepth = 0;
  const measure = (node: OrgNode): number => {
    maxDepth = Math.max(maxDepth, node.depth);
    if (node.children.length === 0) {
      node.leaves = 1;
      return 1;
    }
    node.leaves = node.children.reduce((total, child) => total + measure(child), 0);
    return node.leaves;
  };

  let leafCursor = 0;
  const assign = (node: OrgNode): void => {
    if (node.children.length === 0) {
      node.xIndex = leafCursor;
      leafCursor += 1;
      return;
    }
    for (const child of node.children) assign(child);
    node.xIndex = (node.children[0].xIndex + node.children[node.children.length - 1].xIndex) / 2;
  };

  if (root) measure(root);
  if (root) assign(root);
  const leafCount = Math.max(1, leafCursor);
  // Three or more delegated levels read much better as columns: the hierarchy
  // uses the wide desktop instead of shrinking four rows into a thumbnail.
  const horizontal = maxDepth >= 3;
  const stageWidth = horizontal
    ? Math.max(900, 150 + maxDepth * COLUMN_GAP + CARD_WIDTH / 2 + 40)
    : Math.max(600, leafCount * LEAF_GAP + 80);
  const stageHeight = horizontal
    ? Math.max(420, 150 + (leafCount - 1) * LEAF_ROW_GAP + CARD_HEIGHT / 2 + 40)
    : Math.max(360, 162 + maxDepth * ROW_GAP + CARD_HEIGHT / 2 + 48);

  const nodes: OrgNode[] = [];
  const position = (node: OrgNode): void => {
    if (horizontal) {
      node.x = 150 + node.depth * COLUMN_GAP;
      node.y = 150 + node.xIndex * LEAF_ROW_GAP;
    } else {
      node.x = (stageWidth - leafCount * LEAF_GAP) / 2 + (node.xIndex + 0.5) * LEAF_GAP;
      node.y = 162 + node.depth * ROW_GAP;
    }
    nodes.push(node);
    for (const child of node.children) position(child);
  };
  if (root) position(root);

  const edges: OrgEdge[] = [];
  const addEdges = (node: OrgNode): void => {
    if (node.children.length === 0) return;
    for (const child of node.children) {
      const from = node.desk?.id ?? "__root__";
      let path: string;
      if (horizontal) {
        const parentX = node.x + CARD_WIDTH / 2;
        const parentY = node.y;
        const childX = child.x - CARD_WIDTH / 2;
        const childY = child.y;
        const busX = (parentX + childX) / 2;
        path = `M ${parentX.toFixed(1)} ${parentY.toFixed(1)} H ${busX.toFixed(1)} V ${childY.toFixed(1)} H ${childX.toFixed(1)}`;
      } else {
        const parentX = node.x;
        const parentY = node.y + CARD_HEIGHT / 2;
        const childX = child.x;
        const childY = child.y - CARD_HEIGHT / 2;
        const busY = (parentY + childY) / 2;
        path = `M ${parentX.toFixed(1)} ${parentY.toFixed(1)} V ${busY.toFixed(1)} H ${childX.toFixed(1)} V ${childY.toFixed(1)}`;
      }
      edges.push({
        from,
        to: child.desk?.id ?? "__root__",
        path,
        active: child.desk?.status === "working",
      });
      addEdges(child);
    }
  };
  if (root) addEdges(root);

  return {
    root,
    nodes,
    edges,
    maxDepth,
    leaves: leafCount,
    stageWidth,
    stageHeight,
    hub,
    horizontal,
  };
}

function levelLabel(depth: number, hub: boolean): string {
  if (depth === 0) return hub ? "Project" : "Leadership";
  if (depth === 1) return "Direct reports";
  if (depth === 2) return "Nested reports";
  return "Deeper reports";
}

function renderCard(node: OrgNode, editing: boolean, projectId?: string): string {
  const desk = node.desk;
  if (!desk) return "";
  const role = shortRole(desk.description);
  const editable = editing && Boolean(desk.editable);
  const classes = [
    "org-card",
    node.depth === 0 ? "org-card--lead" : "",
    desk.status === "working" ? "is-working" : "is-sleeping",
    desk.visitor ? "is-visitor" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const badgeText =
    desk.coordinating && desk.subAgents > 0
      ? `${desk.subAgents} report${desk.subAgents === 1 ? "" : "s"}`
      : desk.visitor
        ? "Visitor"
        : "";
  const badgeClass = desk.visitor ? " org-card__badge--sample" : "";

  return `<article class="${classes}" data-agent-card="${escapeAttr(desk.id)}" data-status="${desk.status}"
         data-depth="${node.depth === 0 ? 0 : node.depth}"
         data-parent="${escapeAttr(desk.parentAgentId ?? "__root__")}"
         tabindex="0" data-search="${escapeAttr(`${desk.name} ${desk.description} ${desk.task}`.toLowerCase())}"
         style="left:${node.x.toFixed(2)}px;top:${node.y.toFixed(2)}px;--tone:${escapeAttr(desk.tone)};--depth:${node.depth}"
         aria-label="${escapeAttr(desk.name)}: ${escapeAttr(metaOf(desk))}">
    <div class="org-card__head">
      <span class="org-card__avatar" aria-hidden="true">${escapeHtml(desk.initials)}<i class="org-card__dot"></i></span>
      <div class="org-card__name">
        <strong title="${escapeAttr(desk.name)}">${escapeHtml(desk.name)}</strong>
        <span title="${escapeAttr(desk.description)}">${escapeHtml(role || "Project agent")}</span>
      </div>
      ${editable ? `<a class="org-card__edit" href="/agents/${encodeURIComponent(desk.id)}/edit?view=org${projectQuery(projectId)}" aria-label="Edit ${escapeAttr(desk.name)}">Edit</a>` : ""}
    </div>
    <p class="org-card__status"><span class="dot" aria-hidden="true"></span><span data-role="card-meta">${escapeHtml(metaOf(desk))}</span></p>
    <p class="org-card__task" data-role="card-task" title="${escapeAttr(desk.task)}">${escapeHtml(desk.task)}</p>
    <p class="org-card__detail" data-role="card-detail" title="${escapeAttr(desk.detail)}">${escapeHtml(desk.detail)}</p>
    <div class="org-card__foot">
      <span class="org-card__progress" data-role="card-progress"${desk.progress ? "" : " hidden"}>${escapeHtml(desk.progress ?? "")}</span>
      <span class="org-card__badge${badgeClass}" data-role="card-badge"${badgeText ? "" : " hidden"}>${escapeHtml(badgeText)}</span>
    </div>
  </article>`;
}

function renderHub(snapshot: Snapshot, layout: OrgLayout): string {
  if (!layout.root || !layout.hub) return "";
  const root = layout.root;
  return `<article class="org-card org-card--lead org-hub" data-depth="0" style="left:${root.x.toFixed(2)}px;top:${root.y.toFixed(2)}px;--depth:0">
    <div class="org-card__head">
      <span class="org-hub__mark" aria-hidden="true">AM</span>
      <div class="org-card__name"><strong>${escapeHtml(snapshot.project.name)}</strong><span>Project</span></div>
    </div>
    <p class="org-card__status" data-role="hub-summary">${snapshot.summary.working} working · ${snapshot.summary.sleeping} sleeping</p>
    <p class="org-card__task">${snapshot.summary.total} agents in this project</p>
  </article>`;
}

export function renderOrgPage(snapshot: Snapshot, meta: RenderMeta): string {
  const layout = buildOrgLayout(snapshot.desks);
  const editing = Boolean(meta.editing);
  const title = `Organizational structure — ${snapshot.project.name}`;
  const working = snapshot.summary.working;
  const asleep = working === 0;
  const cards: string[] = [];
  for (const node of layout.nodes) {
    if (node.desk) cards.push(renderCard(node, editing, meta.activeProjectId));
  }
  const hubs = renderHub(snapshot, layout);
  const links = layout.edges
    .map(
      (edge) =>
        `<path class="org-link${edge.active ? " org-link--active" : ""}" data-edge="${escapeAttr(edge.from)}>${escapeAttr(edge.to)}" d="${edge.path}"></path>`,
    )
    .join("\n");
  const labels: string[] = [];
  const bands: string[] = [];
  if (layout.root) {
    const seen = new Set<number>();
    for (const node of layout.nodes) {
      if (seen.has(node.depth)) continue;
      seen.add(node.depth);
      if (layout.horizontal) {
        labels.push(`<span class="org-level org-level--column" style="left:${node.x.toFixed(1)}px;top:14px">${levelLabel(node.depth, layout.hub)}</span>`);
        bands.push(
          `<div class="org-band org-band--column${node.depth % 2 ? " org-band--alt" : ""}" style="left:${(node.x - COLUMN_GAP / 2 + 18).toFixed(1)}px;top:34px;width:${COLUMN_GAP - 36}px;height:${layout.stageHeight - 68}px" aria-hidden="true"></div>`,
        );
      } else {
        labels.push(`<span class="org-level" style="top:${node.y - 138}px">${levelLabel(node.depth, layout.hub)}</span>`);
        bands.push(
          `<div class="org-band${node.depth % 2 ? " org-band--alt" : ""}" style="top:${node.y - 110}px;height:220px" aria-hidden="true"></div>`,
        );
      }
    }
  }
  const banner = `<div class="banner" role="alert" data-role="error"${snapshot.error ? "" : " hidden"}><strong>Cannot read OpenCode state.</strong> <span data-role="error-text">${escapeHtml(snapshot.error ?? "")}</span></div>`;
  const notice = meta.notice
    ? `<div class="notice" role="status">${escapeHtml(meta.notice)}</div>`
    : "";
  const initialIds = snapshot.desks.map((desk) => desk.id).sort().join("|");

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
a:focus-visible, button:focus-visible { outline: 2px solid var(--working); outline-offset: 3px; }
.skip { position: absolute; left: 16px; top: -60px; z-index: 100; padding: 10px 14px; border-radius: 10px; background: var(--ink); color: #fff; text-decoration: none; }
.skip:focus { top: 16px; }
.shell { width: 100%; min-width: 0; margin: 0 auto; padding: 0 clamp(14px, 2vw, 30px); display: flex; flex-direction: column; flex: 1; min-height: 0; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 0 12px; flex: 0 0 auto; }
.brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.brand > div { min-width: 0; }
.brand-mark { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 14px; background: var(--working-soft); color: var(--working); flex: 0 0 auto; }
.brand-mark svg { width: 28px; height: 28px; }
h1 { margin: 0; font-size: 25px; line-height: 1.1; letter-spacing: -0.015em; font-weight: 650; }
.project { margin: 5px 0 0; color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project .path { color: var(--faint); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }
.sep { color: var(--line-strong); padding: 0 5px; }
.top__actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; flex-wrap: wrap; }
.view-switch { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: #f1eadf; }
.view-switch__item { padding: 5px 11px; border-radius: 999px; color: var(--muted); font-size: 11.5px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.view-switch__item:hover { color: var(--working); }
.view-switch__item.is-active { background: var(--panel); color: var(--ink); box-shadow: 0 1px 4px rgba(60, 46, 28, 0.16); }
.project-switch { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
.project-switch__label { color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.project-switch select { max-width: 190px; padding: 6px 4px; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 12px; font-weight: 600; }
.project-switch select:focus-visible { outline: 2px solid var(--working); outline-offset: 2px; }
.btn { display: inline-flex; align-items: center; justify-content: center; padding: 8px 13px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--panel); color: var(--ink); font-size: 12.5px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.btn:hover { border-color: var(--working); color: var(--working); }
.btn--primary { border-color: var(--working); background: var(--working); color: #fff; }
.btn--primary:hover { background: #0b5f58; color: #fff; }
.live { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--muted); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; flex: 0 0 auto; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--working); box-shadow: 0 0 0 4px rgba(15, 118, 110, 0.12); animation: live-pulse 2.6s ease-in-out infinite; }
.live--off .live-dot { background: var(--faint); box-shadow: none; animation: none; }
.summary { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 18px; padding: 10px 0 4px; flex: 0 0 auto; }
.summary__counts { margin: 0; font-size: 15px; color: var(--muted); }
.summary__counts strong { color: var(--ink); font-size: 17px; font-weight: 650; }
.summary__time { margin: 0; font-size: 12px; color: var(--faint); letter-spacing: 0.02em; }
.all-asleep { margin: 0; font-size: 13px; color: var(--sleeping); }
.banner { margin: 12px 0 0; padding: 14px 16px; border: 1px solid #d9b6a6; border-radius: 12px; background: #fbf0e9; color: #7a3b24; }
.banner strong { display: block; }
.notice { margin: 12px 0 0; padding: 10px 14px; border: 1px solid #b9dcd4; border-radius: 10px; background: var(--working-soft); color: var(--working); font-size: 12.5px; }
.hint { margin: 0 0 8px; color: var(--faint); font-size: 11.5px; flex: 0 0 auto; }

.org-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 28px;
  background:
    radial-gradient(800px 340px at 50% 0%, rgba(255, 255, 250, 0.92), rgba(255, 255, 250, 0) 74%),
    linear-gradient(180deg, #fbf7ef 0%, #f5f0e5 100%);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.org-wrap::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: radial-gradient(rgba(150, 130, 100, 0.12) 1px, transparent 1px);
  background-size: 22px 22px;
  mask-image: linear-gradient(180deg, #000 0%, transparent 88%);
  pointer-events: none;
}
.org-scroll { flex: 1; min-height: 0; overflow: auto; border-radius: inherit; }
.org-stage { position: relative; transform-origin: top left; }
.org-surface { position: relative; margin: 0 auto; }
.org-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 3; }
.org-band { position: absolute; left: 0; right: 0; z-index: 0; background: rgba(180, 158, 122, 0.055); pointer-events: none; }
.org-band--alt { background: rgba(180, 158, 122, 0.11); }
.org-band--column { right: auto; border-radius: 18px; }
.org-link { fill: none; stroke: #c8b9a3; stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.org-link--active { stroke: #88c1b7; stroke-width: 2.2; filter: drop-shadow(0 0 4px rgba(136, 193, 183, 0.4)); }
.org-level { position: absolute; left: 18px; z-index: 4; color: var(--faint); font-size: 9px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; transform: translateY(-50%); white-space: nowrap; }
.org-level--column { transform: translateX(-50%); }
.org-card {
  position: absolute;
  z-index: 5;
   width: 264px;
   height: 220px;
   margin-left: -132px;
   padding: 16px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(255, 253, 248, 0.97);
  box-shadow: 0 16px 28px -22px rgba(60, 46, 28, 0.7);
  transform: translateY(-50%);
  overflow: hidden;
  transition: border-color 160ms ease, opacity 160ms ease, filter 160ms ease;
}
.org-card--lead { border-color: #b9dcd4; box-shadow: 0 0 0 1px rgba(15, 118, 110, 0.08), 0 18px 30px -22px rgba(60, 46, 28, 0.7); }
.org-card.is-working { border-color: #a9d3c6; }
.org-card.is-sleeping { filter: grayscale(1); opacity: 1; }
.org-card.is-visitor { border-style: dashed; }
.org-card__head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.org-card__avatar { position: relative; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--tone, #64748b); color: #fff; font-size: 10px; font-weight: 650; flex: 0 0 auto; }
.org-card__dot { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border: 2px solid #fffdf8; border-radius: 50%; background: var(--sleeping); }
.org-card.is-working .org-card__dot { background: var(--working); }
.org-card__name { min-width: 0; flex: 1 1 auto; }
.org-card__name strong { display: block; font-size: 12.5px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.org-card__name span { display: block; margin-top: 1px; color: var(--faint); font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.org-card__edit { flex: 0 0 auto; padding: 3px 7px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--muted); font-size: 9px; text-decoration: none; }
.org-card__edit:hover { border-color: var(--working); color: var(--working); }
.org-card__status { display: flex; align-items: center; gap: 5px; margin: 8px 0 0; font-size: 10px; color: var(--faint); }
.org-card.is-working .org-card__status { color: var(--working); }
.org-card__status .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--sleeping); }
.org-card.is-working .org-card__status .dot { background: var(--working); }
.org-card__task { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.6em; margin: 5px 0 0; font-size: 11px; line-height: 1.3; }
.org-card__detail { margin: 2px 0 0; color: var(--faint); font-size: 9.5px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.org-card__foot { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.org-card__progress { display: inline-block; padding: 1px 6px; border: 1px solid #c9ddd8; border-radius: 999px; background: var(--working-soft); color: var(--working); font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.04em; }
.org-card__badge { display: inline-block; padding: 1px 6px; border: 1px solid var(--line); border-radius: 999px; background: #f4efe5; color: var(--faint); font-size: 8.5px; letter-spacing: 0.04em; text-transform: uppercase; }
.org-card__badge--sample { border-style: dashed; }
.org-hub { display: flex; flex-direction: column; justify-content: center; border-style: solid; background: linear-gradient(180deg, #fffdf8, #f7f2e8); }
.org-hub__mark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: var(--working-soft); color: var(--working); font-size: 11px; font-weight: 700; flex: 0 0 auto; }
.org-hub .org-card__status { color: var(--faint); }
.org-hub .org-card__task { min-height: 0; }
.org-legend { position: absolute; right: 18px; bottom: 14px; z-index: 6; display: flex; gap: 14px; padding: 8px 12px; border: 1px solid rgba(205, 191, 169, 0.75); border-radius: 999px; background: rgba(255, 253, 248, 0.8); backdrop-filter: blur(4px); color: var(--faint); font-size: 11px; }
.org-legend span { display: inline-flex; align-items: center; gap: 6px; }
.org-legend i { width: 7px; height: 7px; border-radius: 50%; background: var(--sleeping); }
.org-legend .on i { background: var(--working); box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.1); }
.foot { padding: 9px 0 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; flex: 0 0 auto; }
.foot p { margin: 0 0 4px; max-width: 96ch; }
.foot p:last-child { margin-bottom: 0; }
.foot code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; color: var(--faint); }
.org-toolbar { position: relative; z-index: 7; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
.org-toolbar__title { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.org-toolbar__title span { color: var(--muted); font-size: 12px; }
.org-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.org-search { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.org-search input { width: 180px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; }
.org-search input:focus-visible, .org-card:focus-visible { outline: 2px solid var(--working); outline-offset: 3px; }
.org-tools button { min-width: 44px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font: inherit; font-size: 12px; cursor: pointer; }
.org-tools button:hover { background: var(--working-soft); border-color: var(--working); }
.org-tools button:disabled { opacity: .45; cursor: default; }
.org-zoom { min-width: 42px; text-align: center; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.org-scroll { padding: 12px; }
.org-card { border-radius: 16px; box-shadow: 0 5px 16px rgba(60, 46, 28, .06); }
.org-card.is-working { border-top: 3px solid var(--working); }
.org-card__avatar { width: 38px; height: 38px; font-size: 12px; }
.org-card__name strong { font-size: 15px; }
.org-card__name span { font-size: 12px; margin-top: 4px; }
.org-card__edit { min-width: 44px; min-height: 44px; display: grid; place-items: center; padding: 4px; font-size: 12px; border-radius: 8px; }
.org-card__status { font-size: 12px; margin-top: 12px; }
.org-card__task { font-size: 13px; line-height: 1.5; min-height: 3em; margin-top: 8px; }
.org-card__detail { font-size: 12px; }
.org-card__foot { margin-top: 10px; }
.org-card__progress, .org-card__badge { font-size: 10px; }
.org-card.is-match { outline: 3px solid var(--working); outline-offset: 4px; }
.org-card.is-dimmed { opacity: .3; }
.org-card.is-muted { opacity: .35; }
.org-card.is-path { border-color: var(--working); box-shadow: 0 0 0 3px rgba(15, 118, 110, .12), 0 16px 28px -22px rgba(60, 46, 28, .55); }
.org-link.is-path { stroke: var(--working); stroke-width: 2.6; }
.org-card:focus .org-card__task, .org-card:focus .org-card__detail { position: relative; display: block; white-space: normal; overflow: visible; background: var(--panel); }
.org-card:focus { height: auto; min-height: 220px; overflow: visible; z-index: 8; }
.org-level { left: 24px; font-size: 10px; }
.org-bottom { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 18px; border-top: 1px solid var(--line); background: var(--panel); color: var(--muted); font-size: 12px; }
.org-legend { position: static; padding: 0; border: 0; background: none; backdrop-filter: none; }
.org-empty { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; color: var(--muted); }
.org-empty strong { color: var(--ink); font-size: 20px; }
.org-empty p { max-width: 36ch; }
@keyframes live-pulse { 0%, 100% { box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.10); } 50% { box-shadow: 0 0 0 6px rgba(15, 118, 110, 0.04); } }
@media (max-width: 760px) {
  html, body { height: auto; overflow: auto; }
  body { height: auto; }
  .shell { width: 100%; max-width: 100vw; padding: 0 12px; min-height: 100vh; }
  .top { flex-direction: column; align-items: flex-start; gap: 12px; }
  .brand { max-width: 100%; }
  h1 { font-size: 22px; }
  .project .sep, .project .path { display: none; }
  .top__actions { align-self: stretch; width: 100%; max-width: 100%; }
  .org-wrap { height: auto; min-height: 0; flex: none; }
  .org-tools { width: 100%; }
  .org-search { width: 100%; }
  .org-search input { flex: 1; min-width: 0; }
  .org-tools [data-action], .org-zoom { display: none; }
  .org-bottom { align-items: flex-start; }
  .org-legend { flex-shrink: 0; gap: 8px; }

  /* Deep reporting lines read better as an indented list than as a tiny chart. */
  .org-scroll { overflow: visible; padding: 8px; }
  .org-surface, .org-stage { width: 100% !important; height: auto !important; }
  .org-stage { display: flex; flex-direction: column; gap: 10px; padding: 14px 6px 22px; }
  .org-svg, .org-band, .org-level { display: none; }
  .org-card, .org-hub {
    position: relative;
    left: auto !important;
    top: auto !important;
    width: calc(100% - var(--depth) * 18px);
    height: auto;
    min-height: 0;
    margin: 0 0 0 calc(var(--depth) * 18px);
    transform: none;
    overflow: visible;
  }
  .org-card--lead { width: calc(100% - var(--depth) * 18px); }
  .org-card[data-depth]:not([data-depth="0"])::before {
    content: "";
    position: absolute;
    left: -10px;
    top: -12px;
    width: 10px;
    height: 34px;
    border-left: 1px solid var(--line-strong);
    border-bottom: 1px solid var(--line-strong);
    border-bottom-left-radius: 5px;
  }
  .org-card__task { -webkit-line-clamp: 3; min-height: 0; }
  .org-card__detail { white-space: normal; overflow: visible; text-overflow: clip; }
}
@media (prefers-reduced-motion: reduce) {
  *, .live-dot { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<a class="skip" href="#org">Skip to the organizational structure</a>
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
        <h1>Organizational structure</h1>
        <p class="project">
          <span>${escapeHtml(snapshot.project.name)}</span><span class="sep">·</span><span class="path">${escapeHtml(snapshot.project.path || "unknown project path")}</span>
        </p>
      </div>
    </div>
    <div class="top__actions">
      ${renderViewNav("org", meta.activeProjectId)}
      ${renderProjectSwitcher(meta, "org")}
      ${editing ? `<a class="btn btn--primary" href="/agents/new?view=org${projectQuery(meta.activeProjectId)}">New agent</a>` : ""}
      <div class="live" data-role="live">
        <span class="live-dot" aria-hidden="true"></span><span data-role="connection">live</span>
      </div>
    </div>
  </header>

  <section class="summary" aria-label="Activity summary">
    <p class="summary__counts" aria-live="polite" aria-atomic="true">
      <strong data-role="working">${working}</strong> working
      <span class="sep">·</span> <strong data-role="sleeping">${snapshot.summary.sleeping}</strong> sleeping
      <span class="sep">·</span> <span data-role="total">${snapshot.summary.total}</span> agents
    </p>
    <p class="summary__time">as of <span data-role="clock">${clock(snapshot.generatedAt)}</span></p>
    <p class="all-asleep" data-role="asleep"${asleep ? "" : " hidden"}>Everyone is asleep.</p>
  </section>

  ${banner}
  ${notice}

  <noscript>
    <p class="notice">Live updates are off because JavaScript is disabled. This page refreshes every 15 seconds.</p>
  </noscript>

  <div class="org-wrap">
    <div class="org-toolbar">
      <div class="org-toolbar__title"><strong>Reporting hierarchy</strong><span>${layout.root ? layout.maxDepth + 1 : 0} levels</span></div>
      <div class="org-tools" data-role="chart-tools" hidden>
        <label class="org-search">Find agent <input type="search" data-role="search" placeholder="Name, role or task" autocomplete="off"></label>
        <button type="button" data-action="zoom-out" aria-label="Zoom out">−</button>
        <output class="org-zoom" data-role="zoom" aria-label="Chart zoom">100%</output>
        <button type="button" data-action="zoom-in" aria-label="Zoom in">+</button>
        <button type="button" data-action="fit">Fit chart</button>
        <button type="button" data-action="reset">100%</button>
      </div>
    </div>
    <div class="org-scroll" tabindex="0" role="region" aria-label="Reporting chart; scroll to explore">
     <div class="org-surface" style="width:${layout.stageWidth}px;height:${layout.stageHeight}px">
      <div class="org-stage" id="org" data-role="org" style="width:${layout.stageWidth}px;height:${layout.stageHeight}px">
        ${bands.join("\n")}
        <svg class="org-svg" viewBox="0 0 ${layout.stageWidth} ${layout.stageHeight}" aria-hidden="true" focusable="false">
          ${links}
        </svg>
        ${labels.join("\n")}
        ${hubs}
        ${cards.join("\n")}
        ${snapshot.desks.length === 0 ? `<div class="org-empty"><strong>Your team starts here</strong><p>No agents are available yet. Add an agent to see the reporting hierarchy.</p>${editing ? `<a class="btn" href="/agents/new?view=org">Create an agent</a>` : ""}</div>` : ""}
      </div>
     </div>
    </div>
    <div class="org-bottom"><span data-role="search-result" role="status">Scroll to explore · Focus a card to read its full task</span><div class="org-legend"><span class="on"><i></i>Working</span><span><i></i>Sleeping</span></div></div>
  </div>

  <footer class="foot">
    <p><strong>Organizational structure</strong> shows the reporting hierarchy directly: coordinators above their direct reports,
       and nested reports below their manager. The chart updates live from OpenCode sessions.</p>
    <p>The dashboard is read-only; agent files can be edited from their cards when editing is enabled.
       Database <code>${escapeHtml(meta.databasePath)}</code> · stale after ${escapeHtml(String(meta.staleMinutes))} min
       · <a href="/?view=org${projectQuery(meta.activeProjectId)}">Refresh</a></p>
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
  var currentIds = ${jsonForScript(initialIds)};
  var currentHierarchy = ${jsonForScript(hierarchyKey(snapshot.desks))};
  var cards = {};
  var nodes = document.querySelectorAll("[data-agent-card]");
  for (var i = 0; i < nodes.length; i += 1) cards[nodes[i].getAttribute("data-agent-card")] = nodes[i];
  var edgePaths = {};
  var edgeNodes = document.querySelectorAll("[data-edge]");
  for (var e = 0; e < edgeNodes.length; e += 1) edgePaths[edgeNodes[e].getAttribute("data-edge")] = edgeNodes[e];
  var parentById = {};
  for (var p = 0; p < nodes.length; p += 1) {
    parentById[nodes[p].getAttribute("data-agent-card")] = nodes[p].getAttribute("data-parent");
  }

  function highlightPath(id, on) {
    var keep = {};
    if (on && id) {
      var cursor = id;
      var seen = {};
      while (cursor && !seen[cursor]) {
        keep[cursor] = true;
        seen[cursor] = true;
        cursor = parentById[cursor] || "";
      }
      var stack = [id];
      while (stack.length) {
        var current = stack.pop();
        for (var child in parentById) {
          if (parentById[child] === current && !keep[child]) {
            keep[child] = true;
            stack.push(child);
          }
        }
      }
    }
    for (var key in cards) {
      if (!Object.prototype.hasOwnProperty.call(cards, key)) continue;
      cards[key].classList.toggle("is-path", Boolean(keep[key]));
      cards[key].classList.toggle("is-muted", Boolean(on && id && !keep[key]));
    }
    for (var edge in edgePaths) {
      if (!Object.prototype.hasOwnProperty.call(edgePaths, edge)) continue;
      var pair = edge.split(">");
      edgePaths[edge].classList.toggle("is-path", Boolean(keep[pair[0]] && keep[pair[1]]));
    }
  }

  var focusTimer = 0;
  document.addEventListener("focusin", function (event) {
    var card = event.target && event.target.closest ? event.target.closest("[data-agent-card]") : null;
    if (!card) return;
    clearTimeout(focusTimer);
    highlightPath(card.getAttribute("data-agent-card"), true);
  });
  document.addEventListener("focusout", function () {
    clearTimeout(focusTimer);
    focusTimer = window.setTimeout(function () {
      var active = document.activeElement;
      var card = active && active.closest ? active.closest("[data-agent-card]") : null;
      if (!card) highlightPath("", false);
    }, 40);
  });

  var scroll = document.querySelector('.org-scroll');
  var stage = document.querySelector('.org-stage');
  var surface = document.querySelector('.org-surface');
  var chartWidth = ${layout.stageWidth};
  var chartHeight = ${layout.stageHeight};
  var zoom = 1;
  var autoFit = "readable";
  var readableZoom = ${layout.horizontal ? .92 : .7};
  var flowQuery = window.matchMedia("(max-width: 760px)");
  var search = document.querySelector('[data-role="search"]');
  document.querySelector('[data-role="chart-tools"]').hidden = false;
  function isFlow() { return flowQuery.matches; }
  function setZoom(value) {
    var oldZoom = zoom;
    var centerX = (scroll.scrollLeft + scroll.clientWidth / 2 - surface.offsetLeft + scroll.offsetLeft) / oldZoom;
    var centerY = (scroll.scrollTop + scroll.clientHeight / 2) / oldZoom;
    zoom = Math.min(1.6, Math.max(.25, value));
    stage.style.transform = 'scale(' + zoom + ')';
    surface.style.width = chartWidth * zoom + 'px';
    surface.style.height = chartHeight * zoom + 'px';
    text(document, 'zoom', Math.round(zoom * 100) + '%');
    scroll.scrollLeft = centerX * zoom - scroll.clientWidth / 2;
    scroll.scrollTop = centerY * zoom - scroll.clientHeight / 2;
    document.querySelector('[data-action="zoom-out"]').disabled = zoom <= .25;
    document.querySelector('[data-action="zoom-in"]').disabled = zoom >= 1.6;
  }
  function clearZoom() {
    zoom = 1;
    stage.style.transform = 'none';
    surface.style.width = '';
    surface.style.height = '';
    text(document, 'zoom', '100%');
  }
  function fitChart(minimum) {
    if (isFlow()) { clearZoom(); return; }
    setZoom(Math.max(minimum, Math.min(
      1,
      (scroll.clientWidth - 24) / chartWidth,
      (scroll.clientHeight - 24) / chartHeight,
    )));
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
  }
  function applyAutoFit() {
    if (isFlow()) clearZoom();
    else if (autoFit === 'all') fitChart(.25);
    else if (autoFit === 'readable') fitChart(readableZoom);
    else setZoom(zoom);
  }
  document.querySelector('.org-tools').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var action = button.getAttribute('data-action');
    autoFit = action === 'fit' ? 'all' : false;
    if (action === 'fit') fitChart(.25);
    else setZoom(action === 'reset' ? 1 : zoom + (action === 'zoom-in' ? .1 : -.1));
  });
  function searchCards(reveal) {
    var query = search.value.trim().toLowerCase();
    var matches = [];
    for (var n = 0; n < nodes.length; n += 1) {
      var match = Boolean(query && nodes[n].getAttribute('data-search').indexOf(query) !== -1);
      nodes[n].classList.toggle('is-match', match);
      nodes[n].classList.toggle('is-dimmed', Boolean(query && !match));
      if (match) matches.push(nodes[n]);
    }
    text(document, 'search-result', query ? matches.length + ' matching agent' + (matches.length === 1 ? '' : 's') : 'Scroll to explore · Focus a card to read its full task');
    if (reveal && matches.length) {
      autoFit = false;
      if (!isFlow()) setZoom(1);
      matches[0].scrollIntoView({ block: 'center', inline: 'center' });
    }
  }
  search.addEventListener('input', function () { searchCards(true); });
  if ('ResizeObserver' in window) new ResizeObserver(applyAutoFit).observe(scroll);
  if (flowQuery.addEventListener) flowQuery.addEventListener('change', applyAutoFit);
  applyAutoFit();

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
  function updateCard(card, desk) {
    card.classList.toggle("is-working", desk.status === "working");
    card.classList.toggle("is-sleeping", desk.status === "sleeping");
    card.classList.toggle("is-visitor", Boolean(desk.visitor));
    card.setAttribute("data-status", desk.status);
    card.setAttribute('aria-label', desk.name + ': ' + metaOf(desk));
    card.setAttribute('data-search', (desk.name + ' ' + desk.description + ' ' + desk.task).toLowerCase());
    text(card, "card-meta", metaOf(desk));
    text(card, "card-task", desk.task || "No task yet");
    text(card, "card-detail", desk.detail || "");
    card.querySelector('[data-role="card-task"]').title = desk.task || '';
    card.querySelector('[data-role="card-detail"]').title = desk.detail || '';
    var progress = card.querySelector('[data-role="card-progress"]');
    if (progress) {
      progress.hidden = !desk.progress;
      progress.textContent = desk.progress || "";
    }
    var badge = card.querySelector('[data-role="card-badge"]');
    if (badge) {
      var badgeText = desk.coordinating && desk.subAgents > 0
        ? desk.subAgents + " report" + (desk.subAgents === 1 ? "" : "s")
        : desk.visitor
          ? "Visitor"
          : "";
      badge.hidden = !badgeText;
      badge.textContent = badgeText;
    }
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
    var hierarchy = JSON.stringify(state.desks.map(function (desk) { return [desk.id, desk.parentAgentId || null]; }).sort());
    if (hierarchy !== currentHierarchy) { window.location.reload(); return; }

    text(document, "working", String(state.summary.working));
    text(document, "sleeping", String(state.summary.sleeping));
    text(document, "total", String(state.summary.total));
    text(document, "clock", clock(state.generatedAt));
    toggle(document, "asleep", state.summary.working === 0);
    text(document, 'hub-summary', state.summary.working + ' working · ' + state.summary.sleeping + ' sleeping');

    var next = {};
    state.desks.forEach(function (desk) {
      next[desk.id] = desk;
      var card = cards[desk.id];
      if (card) updateCard(card, desk);
    });
    searchCards(false);

    for (var key in edgePaths) {
      if (!Object.prototype.hasOwnProperty.call(edgePaths, key)) continue;
      var targetId = key.split(">")[1];
      var target = next[targetId];
      edgePaths[key].classList.toggle("org-link--active", Boolean(target && target.status === "working"));
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
      try { apply(JSON.parse(event.data)); } catch (error) { /* keep the last good chart */ }
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
