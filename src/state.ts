import type { ProjectRow, SessionRow, TodoRow } from "./db.ts";
import { defaultDefinition, type AgentDefinition } from "./agents.ts";

export type { AgentDefinition, AgentDraft, AgentFile } from "./agents.ts";
export { BUILD_AGENT, defaultDefinition, loadRoster, parseAgentFile, toneFor } from "./agents.ts";

export type DeskStatus = "working" | "sleeping";

export interface Desk {
  id: string;
  name: string;
  description: string;
  tone: string;
  initials: string;
  status: DeskStatus;
  task: string;
  detail: string;
  progress: string | null;
  elapsedMs: number | null;
  lastSeenAgoMs: number | null;
  activeCount: number;
  subAgents: number;
  coordinating: boolean;
  visitor: boolean;
  editable?: boolean;
  parentAgentId?: string | null;
  subAgentIds?: string[];
  sessions: number;
}

export interface Snapshot {
  generatedAt: number;
  project: { id: string; name: string; path: string };
  summary: { working: number; sleeping: number; total: number };
  desks: Desk[];
  rosterHash?: string;
  error: string | null;
}

interface TodoInfo {
  total: number;
  completed: number;
  inProgress: string | null;
}

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

export function formatAgo(ms: number | null): string {
  const value = formatDuration(ms);
  return value ? `${value} ago` : "just now";
}

export function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase());
  return letters.join("") || "?";
}

/** A session is working when it was marked busy after its last idle, recently. */
export function isWorking(
  session: SessionRow,
  now: number,
  staleMs: number,
  hasBusySignal = true,
): boolean {
  if (session.timeArchived) return false;

  if (hasBusySignal) {
    const busy = session.timeBusy ?? 0;
    if (!busy) return false;
    if ((session.timeIdle ?? 0) >= busy) return false;
    const lastActivity = Math.max(session.timeUpdated ?? 0, busy);
    return now - lastActivity <= staleMs;
  }

  // Older databases without time_busy: fall back to recent message activity.
  const updated = session.timeUpdated ?? 0;
  return updated > 0 && now - updated <= Math.min(staleMs, 5 * 60_000);
}

function agentOf(session: SessionRow): string {
  return session.agent?.trim() || "build";
}

function genericTitle(title: string): boolean {
  return /main session|build agent|new session|untitled/i.test(title);
}

function titleOf(session: SessionRow | undefined, info: TodoInfo | undefined): string {
  if (!session) return "";
  const title = (session.title ?? "").trim();
  if (title && !genericTitle(title)) return title;
  return info?.inProgress ?? "";
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function todoInfoFor(todos: TodoRow[]): Map<string, TodoInfo> {
  const ordered = [...todos].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  const map = new Map<string, TodoInfo>();
  for (const todo of ordered) {
    const info = map.get(todo.sessionId) ?? { total: 0, completed: 0, inProgress: null };
    info.total += 1;
    if (todo.status === "completed") info.completed += 1;
    if (
      !info.inProgress &&
      (todo.status === "in_progress" || todo.status === "pending" || todo.status === "active")
    ) {
      info.inProgress = truncate(todo.content, 120);
    }
    map.set(todo.sessionId, info);
  }
  return map;
}

function projectLabel(project: ProjectRow): { name: string; path: string } {
  const path = project.worktree ?? "";
  const folder =
    path
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? "";
  return { name: (project.name ?? "").trim() || folder || "project", path };
}

export interface BuildSnapshotOptions {
  now: number;
  project: ProjectRow;
  sessions: SessionRow[];
  todos?: TodoRow[];
  roster: AgentDefinition[];
  staleMs: number;
  hasBusySignal?: boolean;
  rosterHash?: string;
}

export function buildSnapshot(options: BuildSnapshotOptions): Snapshot {
  const { now, project, roster, staleMs, hasBusySignal = true } = options;
  const todos = options.todos ?? [];
  const live = options.sessions.filter((session) => !session.timeArchived);
  const sessionById = new Map(live.map((session) => [session.id, session]));
  const todoInfo = todoInfoFor(todos);

  const groups = new Map<string, SessionRow[]>();
  for (const session of live) {
    const id = agentOf(session);
    const list = groups.get(id);
    if (list) list.push(session);
    else groups.set(id, [session]);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => (right.timeUpdated ?? 0) - (left.timeUpdated ?? 0));
  }

  // Roll a working child session up to its nearest differently-named ancestor,
  // so a coordinator is visible while its sub-agent is the one doing work.
  const parentAgentByChild = new Map<string, string>();
  for (const child of live) {
    const childAgent = agentOf(child);
    let parentId = child.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = sessionById.get(parentId);
      if (!parent) break;
      const parentAgent = agentOf(parent);
      if (parentAgent !== childAgent) {
        if (!parentAgentByChild.has(childAgent)) parentAgentByChild.set(childAgent, parentAgent);
        break;
      }
      parentId = parent.parentId;
    }
  }

  const childrenByAgent = new Map<string, SessionRow[]>();
  for (const child of live) {
    if (!isWorking(child, now, staleMs, hasBusySignal)) continue;
    let parentId = child.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = sessionById.get(parentId);
      if (!parent) break;
      const parentAgent = agentOf(parent);
      if (parentAgent !== agentOf(child)) {
        const list = childrenByAgent.get(parentAgent) ?? [];
        list.push(child);
        childrenByAgent.set(parentAgent, list);
        break;
      }
      parentId = parent.parentId;
    }
  }

  const makeDesk = (
    definition: AgentDefinition,
    sessions: SessionRow[],
    visitor: boolean,
  ): Desk => {
    const active = sessions
      .filter((session) => isWorking(session, now, staleMs, hasBusySignal))
      .sort(
        (left, right) =>
          (right.timeBusy ?? right.timeUpdated ?? 0) -
          (left.timeBusy ?? left.timeUpdated ?? 0),
      );
    const children = [...(childrenByAgent.get(definition.id) ?? [])].sort(
      (left, right) => (right.timeBusy ?? 0) - (left.timeBusy ?? 0),
    );
    const subAgentIds = [...new Set(children.map((child) => agentOf(child)))];
    const latest = sessions[0];

    let status: DeskStatus = "sleeping";
    let task = "";
    let detail = "";
    let progress: string | null = null;
    let elapsedMs: number | null = null;
    let lastSeenAgoMs: number | null = null;
    let coordinating = false;
    let subAgents = 0;

    if (active.length > 0) {
      status = "working";
      const current = active[0];
      const info = todoInfo.get(current.id);
      task = titleOf(current, info) || "Working on your request";
      const started = current.timeBusy ?? current.timeUpdated ?? now;
      elapsedMs = Math.max(0, now - started);

      const details: string[] = [];
      if (info && info.total > 1) {
        progress = `${info.completed}/${info.total}`;
        details.push(`${info.completed} of ${info.total} steps`);
      }
      if (info?.inProgress && info.inProgress !== task) details.push(info.inProgress);
      if (active.length > 1) details.push(`${active.length} sessions active`);
      if (children.length > 0) {
        subAgents = children.length;
        coordinating = true;
        details.push(`${children.length} sub-agent${children.length === 1 ? "" : "s"} working`);
      }
      detail = details.join(" · ");
    } else if (children.length > 0) {
      status = "working";
      coordinating = true;
      subAgents = children.length;
      const first = children[0];
      task = `Coordinating: ${titleOf(first, todoInfo.get(first.id)) || "sub-agent work"}`;
      detail =
        children.length === 1
          ? "Waiting on a sub-agent"
          : `${children.length} sub-agents working`;
      const earliest = Math.min(...children.map((child) => child.timeBusy ?? now));
      elapsedMs = Math.max(0, now - earliest);
    } else {
      status = "sleeping";
      const info = latest ? todoInfo.get(latest.id) : undefined;
      const lastTask = titleOf(latest, info);
      task = lastTask || "No task yet";
      if (latest?.timeUpdated != null) {
        lastSeenAgoMs = Math.max(0, now - latest.timeUpdated);
        detail = `Last active ${formatAgo(lastSeenAgoMs)}`;
      } else {
        detail = "Waiting for a task";
      }
    }

    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      tone: definition.tone,
      initials: initialsOf(definition.name),
      status,
      task: truncate(task, 140),
      detail: truncate(detail, 160),
      progress,
      elapsedMs,
      lastSeenAgoMs,
      activeCount: active.length,
      subAgents,
      coordinating,
      visitor,
      editable: definition.fileBacked ?? !visitor,
      parentAgentId: parentAgentByChild.get(definition.id) ?? null,
      subAgentIds,
      sessions: sessions.length,
    };
  };

  // Build is synthesized by loadRoster for projects that use OpenCode's
  // built-in primary agent. Do not invent a Build desk when the project has
  // neither a build.md file nor any build session.
  const visibleRoster = roster.filter(
    (definition) =>
      definition.id !== "build" ||
      definition.fileBacked !== false ||
      groups.has("build"),
  );

  const desks: Desk[] = visibleRoster.map((definition) =>
    makeDesk(definition, groups.get(definition.id) ?? [], false),
  );

  const known = new Set(visibleRoster.map((definition) => definition.id));
  const visitorIds = new Set<string>();
  for (const [id, sessions] of groups) {
    if (known.has(id)) continue;
    if (sessions.some((session) => isWorking(session, now, staleMs, hasBusySignal))) {
      visitorIds.add(id);
    }
  }
  for (const id of childrenByAgent.keys()) {
    if (!known.has(id)) visitorIds.add(id);
  }
  for (const id of [...visitorIds].sort()) {
    desks.push(makeDesk(defaultDefinition(id), groups.get(id) ?? [], true));
  }

  const working = desks.filter((desk) => desk.status === "working").length;
  const label = projectLabel(project);

  return {
    generatedAt: now,
    project: { id: project.id, name: label.name, path: label.path },
    summary: { working, sleeping: desks.length - working, total: desks.length },
    desks,
    rosterHash: options.rosterHash ?? "",
    error: null,
  };
}

export function emptySnapshot(now: number, error: string): Snapshot {
  return {
    generatedAt: now,
    project: { id: "", name: "project", path: "" },
    summary: { working: 0, sleeping: 0, total: 0 },
    desks: [],
    rosterHash: "",
    error,
  };
}
