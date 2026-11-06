export type MonitorStatus = "idle" | "running"

export type SessionSnapshot = {
  id: string
  parentID?: string
  title?: string
  agentLabel?: string
  modelLabel?: string
  created?: number
  updated?: number
  busy?: number
  idle?: number
}

export type MonitorState = {
  currentID?: string
  rootID?: string
  sessions: Record<string, SessionSnapshot>
  statuses: Record<string, MonitorStatus>
  starts: Record<string, number>
}

export type Options = { scope: "session"; showCoordinator: boolean; showModel: boolean; maxRows: number }
export type Row = { id: string; kind: "running" | "coordinating"; line1: string; line2: string }
export type View = { rows: Row[]; more: number; empty: boolean }
export type NamedEventResult = { state: MonitorState; handled: boolean }

const MAX_DEPTH = 20

function clip(value: string | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim()
  const chars = [...text]
  if (chars.length <= max) return text
  return chars.slice(0, Math.max(0, max - 3)).join("").trimEnd() + "..."
}

export function createState(currentID?: string): MonitorState {
  const state: MonitorState = {
    sessions: {},
    statuses: {},
    starts: {},
  }

  return currentID === undefined ? state : { ...state, currentID }
}

export function setRoot(state: MonitorState, currentID: string, rootID: string): MonitorState {
  return { ...state, currentID, rootID }
}

export function deriveStatus(snapshot: SessionSnapshot, fallback: MonitorStatus): MonitorStatus {
  if (snapshot.busy !== undefined && (snapshot.idle === undefined || snapshot.busy > snapshot.idle)) {
    return "running"
  }
  if (snapshot.idle !== undefined && (snapshot.busy === undefined || snapshot.idle >= snapshot.busy)) {
    return "idle"
  }
  return fallback
}

export function applySnapshot(
  state: MonitorState,
  snapshot: SessionSnapshot,
  status: MonitorStatus,
  at = 0,
): MonitorState {
  const previous = state.sessions[snapshot.id]
  const sessions = {
    ...state.sessions,
    [snapshot.id]: previous ? { ...previous, ...snapshot } : { ...snapshot },
  }
  const statuses = { ...state.statuses, [snapshot.id]: status }
  const starts = { ...state.starts }

  if (status === "running") {
    if (starts[snapshot.id] === undefined) {
      starts[snapshot.id] = snapshot.busy ?? snapshot.updated ?? at
    } else if (snapshot.busy !== undefined && previous?.busy !== snapshot.busy) {
      starts[snapshot.id] = snapshot.busy
    }
  } else {
    delete starts[snapshot.id]
  }

  return { ...state, sessions, statuses, starts }
}

export function applyStatus(
  state: MonitorState,
  id: string,
  status: MonitorStatus,
  at: number,
): MonitorState {
  const statuses = { ...state.statuses, [id]: status }
  const starts = { ...state.starts }

  if (status === "running") {
    starts[id] = starts[id] ?? at
  } else {
    delete starts[id]
  }

  return { ...state, statuses, starts }
}

export function applyActivity(state: MonitorState, id: string, at: number): MonitorState {
  const previous = state.sessions[id]
  const wasIdle = (state.statuses[id] ?? "idle") === "idle"
  const sessions = {
    ...state.sessions,
    [id]: previous ? { ...previous, updated: at } : { id, updated: at },
  }
  const statuses = { ...state.statuses, [id]: "running" as const }
  const starts = { ...state.starts }
  if (wasIdle || starts[id] === undefined) starts[id] = at

  return { ...state, sessions, statuses, starts }
}

export function applyIdle(state: MonitorState, id: string, _at: number): MonitorState {
  const statuses = { ...state.statuses, [id]: "idle" as const }
  const starts = { ...state.starts }
  delete starts[id]

  return { ...state, statuses, starts }
}

export function removeSession(state: MonitorState, id: string): MonitorState {
  const sessions = { ...state.sessions }
  const statuses = { ...state.statuses }
  const starts = { ...state.starts }
  delete sessions[id]
  delete statuses[id]
  delete starts[id]

  return { ...state, sessions, statuses, starts }
}

export function applyNamedEvent(
  state: MonitorState,
  name: string,
  data: { sessionID?: string; status?: { type?: string } },
  at: number,
): NamedEventResult {
  const sessionID = data?.sessionID
  if (typeof sessionID !== "string") return { state, handled: false }

  switch (name) {
    case "session.status": {
      const status = data.status?.type
      if (status === "busy" || status === "retry") {
        return { state: applyActivity(state, sessionID, at), handled: true }
      }
      if (status === "idle") {
        return { state: applyIdle(state, sessionID, at), handled: true }
      }
      return { state, handled: false }
    }
    case "session.idle":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return { state: applyIdle(state, sessionID, at), handled: true }
    case "session.execution.started":
    case "session.step.started":
    case "session.step.streamed":
    case "session.tool.called":
      return { state: applyActivity(state, sessionID, at), handled: true }
    case "session.deleted":
      return { state: removeSession(state, sessionID), handled: true }
    case "session.created":
    case "session.renamed":
    case "session.model.selected":
    case "session.agent.selected":
    case "session.step.ended":
    case "session.step.failed":
    case "session.retry.scheduled":
    case "session.usage.updated":
      return { state, handled: true }
    default:
      if (name.startsWith("session.tool.")) {
        return { state: applyActivity(state, sessionID, at), handled: true }
      }
      return { state, handled: false }
  }
}

function isDescendant(
  id: string,
  root: string | undefined,
  current: string | undefined,
  sessions: Record<string, SessionSnapshot>,
): boolean {
  if (id === root || id === current) return true

  let cursor = id
  const seen = new Set<string>([id])
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = sessions[cursor]?.parentID
    if (!parent || seen.has(parent)) return false
    if (parent === root || parent === current) return true
    if (sessions[parent] === undefined) return true
    seen.add(parent)
    cursor = parent
  }

  return false
}

export function computeView(state: MonitorState, now: number, options: Options): View {
  const root = state.rootID ?? state.currentID
  const current = state.currentID ?? root
  const sessions = state.sessions

  const family = new Set<string>()
  if (root !== undefined) family.add(root)
  if (current !== undefined) family.add(current)
  for (const id of Object.keys(sessions)) {
    if (isDescendant(id, root, current, sessions)) family.add(id)
  }

  const anchor = root ?? current
  const rootRunning = root !== undefined && (state.statuses[root] ?? "idle") === "running"

  const children = new Map<string, string[]>()
  for (const id of family) {
    if (id === anchor) continue
    const parent = sessions[id]?.parentID
    const attach = parent !== undefined && parent !== id && family.has(parent) ? parent : anchor
    if (attach === undefined) continue
    const list = children.get(attach)
    if (list) list.push(id)
    else children.set(attach, [id])
  }
  for (const list of children.values()) {
    list.sort((left, right) => {
      const a = sessions[left]?.created ?? 0
      const b = sessions[right]?.created ?? 0
      return a - b || left.localeCompare(right)
    })
  }

  const ordered: Array<{ id: string; depth: number }> = []
  const depths = new Map<string, number>()
  const seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return
    seen.add(id)
    ordered.push({ id, depth })
    depths.set(id, depth)
    for (const child of children.get(id) ?? []) walk(child, depth + 1)
  }
  if (anchor !== undefined) walk(anchor, 0)
  for (const id of family) {
    if (!seen.has(id)) walk(id, 0)
  }

  const runningIDs: string[] = []
  const runningRows: Row[] = []
  for (const { id, depth } of ordered) {
    if ((state.statuses[id] ?? "idle") !== "running") continue
    runningIDs.push(id)

    const snapshot = sessions[id]
    const indent = "  ".repeat(Math.min(depth, 3))
    const start = state.starts[id] ?? snapshot?.busy ?? snapshot?.updated
    const agent = clip(snapshot?.agentLabel, 22) || "session"
    const title = clip(snapshot?.title, 48) || "Untitled session"
    const model = options.showModel ? clip(snapshot?.modelLabel, 24) : ""
    const heading = model ? `${model} - ` : ""

    runningRows.push({
      id,
      kind: "running",
      line1: `${indent}> ${agent}  ${formatElapsed(now - (start ?? now))}`,
      line2: `${indent}  ${heading}${title}`,
    })
  }

  const runningDescendants = runningIDs.filter((id) => id !== root)
  let coordinatorRow: Row | undefined
  if (root !== undefined && options.showCoordinator && !rootRunning && runningDescendants.length > 0) {
    let start: number | undefined
    for (const id of runningDescendants) {
      const candidate = state.starts[id] ?? sessions[id]?.busy ?? sessions[id]?.updated
      if (candidate === undefined) continue
      if (start === undefined || candidate < start) start = candidate
    }
    if (start === undefined) {
      start = state.starts[root] ?? sessions[root]?.busy ?? sessions[root]?.updated ?? now
    }

    const snapshot = sessions[root]
    const indent = "  ".repeat(Math.min(depths.get(root) ?? 0, 3))
    const agent = clip(snapshot?.agentLabel, 22) || "session"
    const title = clip(snapshot?.title, 48) || "Untitled session"
    const model = options.showModel ? clip(snapshot?.modelLabel, 24) : ""
    const heading = model ? `${model} - ` : ""

    coordinatorRow = {
      id: root,
      kind: "coordinating",
      line1: `${indent}~ ${agent}  ${formatElapsed(now - start)}`,
      line2: `${indent}  ${heading}coordinating - ${title}`,
    }
  }

  const totalRows = runningRows.length + (coordinatorRow ? 1 : 0)
  const visible: Row[] = []
  if (coordinatorRow && options.maxRows > runningRows.length) visible.push(coordinatorRow)
  for (const row of runningRows) {
    if (visible.length >= options.maxRows) break
    if (coordinatorRow && row.id === coordinatorRow.id) continue
    visible.push(row)
  }

  return {
    rows: visible,
    more: Math.max(0, totalRows - visible.length),
    empty: totalRows === 0,
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}
