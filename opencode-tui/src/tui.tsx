/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, onCleanup } from "solid-js"

type Session = NonNullable<ReturnType<Context["data"]["session"]["get"]>>

type Options = {
  scope: "session"
  showCoordinator: boolean
  showModel: boolean
  maxRows: number
}

type Row = {
  id: string
  kind: "running" | "coordinating"
  line1: string
  line2: string
}

type View = {
  rows: Row[]
  more: number
  empty: boolean
}

const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)

function readOptions(raw: Readonly<Record<string, any>>): Options {
  const maxRows =
    typeof raw.maxRows === "number" && Number.isInteger(raw.maxRows) && raw.maxRows >= 1 && raw.maxRows <= 20
      ? raw.maxRows
      : 8
  return {
    scope: "session",
    showCoordinator: flag(raw.showCoordinator, true),
    showModel: flag(raw.showModel, true),
    maxRows,
  }
}

function clip(value: string | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim()
  const chars = [...text]
  if (chars.length <= max) return text
  return chars.slice(0, Math.max(0, max - 3)).join("").trimEnd() + "..."
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

function agentName(context: Context, session: Session): string {
  const agent = session.agent
  if (!agent) return "session"
  const info = context.data.location.agent.list(session.location)?.find((item) => item.id === agent)
  return clip(info?.name || agent, 22)
}

function modelName(context: Context, session: Session): string {
  const ref = session.model
  if (!ref) return ""
  const info = context.data.location.model
    .list(session.location)
    ?.find((item) => item.modelID === ref.id && item.providerID === ref.providerID)
  let label = (info?.name || ref.id).replace(/\s+/g, " ").trim()
  const prefix = `${ref.providerID}/`
  if (label.toLowerCase().startsWith(prefix.toLowerCase())) label = label.slice(prefix.length)
  if (!info && label.includes("/")) label = label.slice(label.lastIndexOf("/") + 1)
  return clip(label, 24)
}

function startOf(session: Session): number | undefined {
  return session.time.busy ?? session.time.updated
}

function buildView(context: Context, sessionID: string, options: Options, now: number): View {
  const rootID = context.data.session.root(sessionID)
  const ids = new Set<string>([rootID, sessionID, ...context.data.session.family(sessionID)])
  const sessions = new Map<string, Session>()
  for (const id of ids) {
    const session = context.data.session.get(id)
    if (session) sessions.set(id, session)
  }

  // Keep traversal anchored even if the root is not cached for a moment.
  const anchor = sessions.has(rootID) ? rootID : sessionID
  const running = new Map<string, boolean>()
  for (const id of sessions.keys()) running.set(id, context.data.session.status(id) === "running")
  const anyRunning = [...running.values()].some(Boolean)
  const rootRunning = running.get(rootID) === true

  const children = new Map<string, string[]>()
  for (const [id, session] of sessions) {
    if (id === anchor) continue
    const parent = session.parentID && sessions.has(session.parentID) ? session.parentID : anchor
    if (parent === id) continue
    const list = children.get(parent) ?? []
    list.push(id)
    children.set(parent, list)
  }
  for (const list of children.values()) {
    list.sort((left, right) => {
      const a = sessions.get(left)!
      const b = sessions.get(right)!
      return a.time.created - b.time.created || left.localeCompare(right)
    })
  }

  const ordered: Array<{ id: string; depth: number }> = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return
    seen.add(id)
    if (sessions.has(id)) ordered.push({ id, depth })
    for (const child of children.get(id) ?? []) walk(child, depth + 1)
  }
  walk(anchor, 0)
  for (const id of sessions.keys()) if (!seen.has(id)) walk(id, 0)

  if (!anyRunning) return { rows: [], more: 0, empty: true }

  let earliest: number | undefined
  for (const [id, session] of sessions) {
    if (id === rootID || !running.get(id)) continue
    const start = startOf(session)
    if (start === undefined) continue
    if (earliest === undefined || start < earliest) earliest = start
  }

  const coordinator = !rootRunning && options.showCoordinator
  const rows: Row[] = []
  for (const { id, depth } of ordered) {
    const session = sessions.get(id)
    if (!session) continue
    const isRunning = running.get(id) === true
    const isCoordinator = id === rootID && coordinator
    if (!isRunning && !isCoordinator) continue

    const kind: Row["kind"] = isRunning ? "running" : "coordinating"
    const start = isRunning ? startOf(session) : (earliest ?? startOf(session))
    const indent = "  ".repeat(Math.min(depth, 3))
    const title = clip(session.title?.trim() || "Untitled session", 48)
    const model = options.showModel ? modelName(context, session) : ""
    const prefix = kind === "coordinating" ? "coordinating - " : ""
    const heading = model ? `${model} - ` : ""

    rows.push({
      id,
      kind,
      line1: `${indent}${kind === "running" ? ">" : "~"} ${agentName(context, session)}  ${formatElapsed(now - (start ?? now))}`,
      line2: `${indent}  ${heading}${prefix}${title}`,
    })
  }

  const coordinatorRow = rows.find((row) => row.kind === "coordinating")
  const workerRows = rows.filter((row) => row.kind === "running")
  const visible: Row[] = []
  if (coordinatorRow && options.maxRows > workerRows.length) visible.push(coordinatorRow)
  visible.push(...workerRows.slice(0, options.maxRows - visible.length))

  return {
    rows: visible,
    more: Math.max(0, rows.length - visible.length),
    empty: false,
  }
}

export default Plugin.define({
  id: "wiseprogress.ocam-sidebar.tui",
  setup(context) {
    const options = readOptions(context.options)

    const WorkingAgents = (props: { sessionID: string }) => {
      const [now, setNow] = createSignal(Date.now())
      const timer = setInterval(() => setNow(Date.now()), 1000)
      onCleanup(() => clearInterval(timer))

      const view = createMemo(() => buildView(context, props.sessionID, options, now()))

      return (
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <text fg={context.theme.text.muted} wrapMode="none" truncate>
            Working agents
          </text>
          {view().rows.map((row) => (
            <>
              <text
                fg={
                  row.kind === "running"
                    ? context.theme.text.feedback.success.base
                    : context.theme.text.feedback.info.base
                }
                wrapMode="none"
                truncate
              >
                {row.line1}
              </text>
              <text fg={context.theme.text.muted} wrapMode="none" truncate>
                {row.line2}
              </text>
            </>
          ))}
          {view().empty ? (
            <text fg={context.theme.text.faint} wrapMode="none" truncate>
              No agents working
            </text>
          ) : null}
          {view().more > 0 ? (
            <text fg={context.theme.text.faint} wrapMode="none" truncate>
              {`+${view().more} more`}
            </text>
          ) : null}
        </box>
      )
    }

    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => <WorkingAgents sessionID={input.sessionID} />,
    })
  },
})
