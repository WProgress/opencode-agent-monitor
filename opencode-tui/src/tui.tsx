/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, untrack } from "solid-js"
import {
  applyNamedEvent,
  applySnapshot,
  computeView,
  createState,
  deriveStatus,
  setRoot,
  type MonitorState,
  type Options,
  type Row as MonitorRow,
  type SessionSnapshot,
} from "./core.ts"

type Session = NonNullable<ReturnType<Context["data"]["session"]["get"]>>

type Monitor = {
  readonly state: () => MonitorState
  readonly now: () => number
  readonly attach: (sessionID: string) => void
  readonly dispose: () => void
}

type PanelView = { rows: MonitorRow[]; more: number; empty: boolean; error?: boolean }

type SessionSync = (id: string, options?: { children?: boolean }) => Promise<void>

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

function belongsToFamily(
  id: string,
  root: string | undefined,
  current: string | undefined,
  sessions: Record<string, SessionSnapshot>,
): boolean {
  if (id === root || id === current) return true

  let cursor = id
  const seen = new Set<string>([id])
  for (let depth = 0; depth < 20; depth += 1) {
    const parent = sessions[cursor]?.parentID
    if (!parent || seen.has(parent)) return false
    if (parent === root || parent === current) return true
    seen.add(parent)
    cursor = parent
  }

  return false
}

function agentLabel(context: Context, session: Session): string {
  const agent = session.agent
  if (!agent) return "session"
  const info = context.data.location.agent.list(session.location)?.find((item) => item.id === agent)
  return info?.name || agent || "session"
}

function modelLabel(context: Context, session: Session): string {
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

function createMonitor(context: Context, _options: Options): Monitor {
  const [state, setState] = createSignal(createState())
  const [now, setNow] = createSignal(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    timer = setInterval(() => setNow(Date.now()), 1000)
  } catch (error) {
    console.error("[ocam-sidebar] clock failed", error)
  }

  const unsubscribers: Array<() => void> = []
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const delayed = new Set<ReturnType<typeof setTimeout>>()
  const seen = new Set<string>()
  const syncSession: SessionSync = (id, syncOptions) =>
    (context.data.session.sync as SessionSync)(id, syncOptions)

  let attached: string | undefined
  let disposed = false

  function seenBefore(details: unknown): boolean {
    const id = (details as { id?: unknown } | null | undefined)?.id
    if (typeof id !== "string") return false
    if (seen.has(id)) return true
    seen.add(id)
    if (seen.size > 512) {
      const first = seen.values().next().value
      if (first !== undefined) seen.delete(first)
    }
    return false
  }

  function snapshot() {
    if (disposed) return

    const current = state().currentID
    let root = state().rootID ?? current

    if (current) {
      try {
        const rootNow = context.data.session.root(current)
        if (rootNow && rootNow !== state().rootID) {
          root = rootNow
          setState((previous) => setRoot(previous, current, rootNow))
        }
      } catch {
        // Keep the root already attached; the next snapshot retries.
      }
    }

    let familyIDs: string[] = []
    if (root) {
      try {
        familyIDs = context.data.session.family(root)
      } catch {
        familyIDs = []
      }
    }

    const ids = new Set<string>()
    if (root) ids.add(root)
    if (current) ids.add(current)
    for (const id of familyIDs) ids.add(id)

    if (familyIDs.length === 0 && root) {
      let listed: Session[] = []
      try {
        listed = context.data.session.list()
      } catch {
        listed = []
      }
      for (const session of listed) ids.add(session.id)
    }

    const known = state().sessions
    for (const id of Object.keys(known)) {
      if (!ids.has(id) && belongsToFamily(id, root, current, known)) ids.add(id)
    }

    const at = Date.now()

    setState((previous) => {
      let next = previous
      for (const id of ids) {
        const session = context.data.session.get(id)
        if (!session) continue
        const entry: SessionSnapshot = {
          id: session.id,
          agentLabel: agentLabel(context, session),
          modelLabel: modelLabel(context, session),
          created: session.time.created,
          updated: session.time.updated,
        }
        if (session.parentID !== undefined) entry.parentID = session.parentID
        if (session.title !== undefined) entry.title = session.title
        if (session.time.busy !== undefined) entry.busy = session.time.busy
        if (session.time.idle !== undefined) entry.idle = session.time.idle

        const status = deriveStatus(entry, context.data.session.status(id))
        next = applySnapshot(next, entry, status, at)
      }
      return next
    })
  }

  function refresh() {
    if (disposed) return
    try {
      snapshot()
    } catch {
      // Store reads can race a reload; the next event or sync retries.
    }
  }

  async function flush(id: string) {
    try {
      context.data.session.invalidate(id)
      await syncSession(id)
    } catch {
      // Sync failures are transient; the next event retries.
    }
    refresh()
  }

  function schedule(id: string | undefined) {
    if (!id || disposed || pending.has(id)) return
    const handle = setTimeout(() => {
      pending.delete(id)
      void flush(id)
    }, 150)
    pending.set(id, handle)
  }

  function scheduleDelayed(id: string | undefined) {
    if (!id || disposed) return
    const handle = setTimeout(() => {
      delayed.delete(handle)
      void flush(id)
    }, 700)
    delayed.add(handle)
  }

  async function bootstrap(root: string) {
    try {
      await syncSession(root, { children: true })
    } catch {
      try {
        await syncSession(root)
      } catch {
        // The scheduled sync is the fallback path.
      }
    }
    refresh()
  }

  function attach(sessionID: string) {
    if (disposed || !sessionID || attached === sessionID) return
    attached = sessionID

    let root = sessionID
    try {
      root = context.data.session.root(sessionID) || sessionID
    } catch {
      root = sessionID
    }

    setState((previous) => setRoot(previous, sessionID, root))
    refresh()
    schedule(root)
    if (sessionID !== root) schedule(sessionID)
    void bootstrap(root)
  }

  function handle(name: string | undefined, details: unknown) {
    if (!name || disposed) return

    const data =
      (details as { data?: { sessionID?: string; status?: { type?: string } } } | null | undefined)?.data ?? {}
    const sessionID = data.sessionID
    if (!sessionID) return
    if (seenBefore(details)) return

    const result = applyNamedEvent(state(), name, data, Date.now())
    if (!result.handled) return

    setState(result.state)
    schedule(sessionID)
    const root = state().rootID ?? state().currentID
    schedule(root)
    if (
      name === "session.step.ended" ||
      name === "session.step.failed" ||
      name === "session.retry.scheduled" ||
      name === "session.usage.updated"
    ) {
      scheduleDelayed(sessionID)
    }
  }

  try {
    unsubscribers.push(
      context.data.listen((event: { name?: string; details?: unknown }) => {
        const details = event.details
        const name = (details as { type?: string } | null | undefined)?.type ?? event.name
        handle(name, details)
      }),
    )
  } catch (error) {
    console.error("[ocam-sidebar] listener failed", "listen", error)
  }

  const watched = [
    "session.status",
    "session.idle",
    "session.created",
    "session.deleted",
    "session.renamed",
    "session.model.selected",
    "session.agent.selected",
    "session.step.started",
    "session.step.ended",
    "session.step.failed",
    "session.retry.scheduled",
    "session.usage.updated",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ] as const

  for (const name of watched) {
    try {
      unsubscribers.push(
        context.data.on(name, (event) => {
          handle(name, event)
        }),
      )
    } catch (error) {
      console.error("[ocam-sidebar] listener failed", name, error)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (timer !== undefined) clearInterval(timer)
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe()
      } catch {
        // Ignore teardown races.
      }
    }
    unsubscribers.length = 0
    for (const handle of pending.values()) clearTimeout(handle)
    pending.clear()
    for (const handle of delayed) clearTimeout(handle)
    delayed.clear()
    seen.clear()
  }

  return {
    state,
    now,
    attach,
    dispose,
  }
}

function Row(props: { context: Context; row: MonitorRow }) {
  return (
    <>
      <text
        fg={
          props.row?.kind === "running"
            ? (props.context?.theme?.text?.feedback?.success?.base ?? props.context?.theme?.text?.muted)
            : (props.context?.theme?.text?.feedback?.info?.base ?? props.context?.theme?.text?.muted)
        }
        wrapMode="none"
        truncate
      >
        {props.row?.line1 ?? ""}
      </text>
      <text fg={props.context?.theme?.text?.muted} wrapMode="none" truncate>
        {props.row?.line2 ?? ""}
      </text>
    </>
  )
}

function FallbackPanel(props: { context: Context; message: string }) {
  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <text fg={props.context?.theme?.text?.muted} wrapMode="none" truncate>
        Working agents
      </text>
      <text fg={props.context?.theme?.text?.faint} wrapMode="none" truncate>
        {props.message}
      </text>
    </box>
  )
}

function WorkingAgents(props: {
  context: Context
  monitor: Monitor
  sessionID: string
  options: Options
}) {
  createEffect(() => {
    const sessionID = props.sessionID
    untrack(() => props.monitor.attach(sessionID))
  })

  const safeView = createMemo<PanelView>(() => {
    try {
      const now = props.monitor.now()
      return computeView(props.monitor.state(), now, props.options)
    } catch (error) {
      console.error("[ocam-sidebar] computeView failed", error)
      return { rows: [], more: 0, empty: false, error: true }
    }
  })

  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <text fg={props.context?.theme?.text?.muted} wrapMode="none" truncate>
        Working agents
      </text>
      {safeView().error ? (
        <text fg={props.context?.theme?.text?.faint} wrapMode="none" truncate>
          Panel error (see OpenCode logs)
        </text>
      ) : (
        <>
          {safeView().rows.map((row) => (
            <Row context={props.context} row={row} />
          ))}
          {safeView().empty ? (
            <text fg={props.context?.theme?.text?.faint} wrapMode="none" truncate>
              No agents working
            </text>
          ) : null}
          {safeView().more > 0 ? (
            <text fg={props.context?.theme?.text?.faint} wrapMode="none" truncate>
              {`+${safeView().more} more`}
            </text>
          ) : null}
        </>
      )}
    </box>
  )
}

export default Plugin.define({
  id: "wiseprogress.ocam-sidebar.tui",
  setup(context) {
    const options = readOptions(context.options)
    let monitor: Monitor | undefined
    let failure: string | undefined

    try {
      monitor = createMonitor(context, options)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      console.error("[ocam-sidebar] setup failed", error)
      try {
        context.ui.toast.show({
          variant: "error",
          title: "OCAM sidebar",
          message: `Setup failed: ${failure}`,
        })
      } catch {
        // A failed toast must not prevent the fallback panel.
      }
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) =>
        monitor ? (
          <WorkingAgents context={context} monitor={monitor} sessionID={input.sessionID} options={options} />
        ) : (
          <FallbackPanel context={context} message={failure ?? "Monitor unavailable"} />
        ),
    })

    return () => {
      monitor?.dispose()
      unregister()
    }
  },
})
