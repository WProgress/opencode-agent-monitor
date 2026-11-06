import test from "node:test"
import assert from "node:assert/strict"
import {
  applyActivity,
  applyIdle,
  applyNamedEvent,
  applySnapshot,
  applyStatus,
  computeView,
  createState,
  deriveStatus,
  formatElapsed,
  removeSession,
  setRoot,
  type MonitorState,
  type MonitorStatus,
  type Options,
  type SessionSnapshot,
} from "../src/core.ts"

const makeSession = (id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id,
  title: `Title ${id}`,
  agentLabel: `agent-${id}`,
  modelLabel: `model-${id}`,
  created: 0,
  updated: 0,
  ...overrides,
})

const defaultOptions = (overrides: Partial<Options> = {}): Options => ({
  scope: "session",
  showCoordinator: true,
  showModel: true,
  maxRows: 12,
  ...overrides,
})

const emit = (state: MonitorState, name: string, data: { sessionID?: string; status?: { type?: string } }, at: number) =>
  applyNamedEvent(state, name, data, at)

const snap = (state: MonitorState, session: SessionSnapshot, status: MonitorStatus, at = 0) =>
  applySnapshot(state, session, status, at)

const seed = (root: string, entries: Array<[SessionSnapshot, MonitorStatus]>): MonitorState => {
  let state = setRoot(createState(root), root, root)
  for (const [session, status] of entries) state = snap(state, session, status)
  return state
}

test("initial running root and child snapshots render two running rows with agent, model and title", () => {
  const state = seed("root", [
    [makeSession("root", { created: 1_000, updated: 1_000, busy: 1_000 }), "running"],
    [makeSession("child", { parentID: "root", created: 2_000, updated: 2_000, busy: 2_000 }), "running"],
  ])

  const view = computeView(state, 3_000, defaultOptions())

  assert.equal(view.empty, false)
  assert.equal(view.more, 0)
  assert.equal(view.rows.length, 2)

  assert.equal(view.rows[0].id, "root")
  assert.equal(view.rows[0].kind, "running")
  assert.equal(view.rows[0].line1, "> agent-root  2s")
  assert.equal(view.rows[0].line2, "  model-root - Title root")

  assert.equal(view.rows[1].id, "child")
  assert.equal(view.rows[1].kind, "running")
  assert.equal(view.rows[1].line1, "  > agent-child  1s")
  assert.equal(view.rows[1].line2, "    model-child - Title child")
})

test("busy session.status flips an idle row to running and starts elapsed at the event time", () => {
  const state = seed("root", [[makeSession("root", { created: 500, updated: 500 }), "idle"]])

  const idleView = computeView(state, 5_000, defaultOptions())
  assert.deepEqual(idleView.rows, [])
  assert.equal(idleView.empty, true)

  const result = emit(state, "session.status", { sessionID: "root", status: { type: "busy" } }, 1_000)
  assert.equal(result.handled, true)
  assert.equal(result.state.statuses.root, "running")
  assert.equal(result.state.starts.root, 1_000)
  assert.equal(result.state.sessions.root.updated, 1_000)

  const view = computeView(result.state, 5_000, defaultOptions())
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].id, "root")
  assert.equal(view.rows[0].kind, "running")
  assert.equal(view.rows[0].line1, "> agent-root  4s")
})

test("idle events remove the running row and clear the start timestamp", () => {
  const state = seed("root", [[makeSession("root", { created: 1_000, busy: 1_000 }), "running"]])
  assert.equal(computeView(state, 2_000, defaultOptions()).rows.length, 1)

  const byStatus = emit(state, "session.status", { sessionID: "root", status: { type: "idle" } }, 9_000)
  assert.equal(byStatus.handled, true)
  assert.equal(byStatus.state.statuses.root, "idle")
  assert.equal(byStatus.state.starts.root, undefined)
  assert.deepEqual(computeView(byStatus.state, 9_000, defaultOptions()).rows, [])

  const byIdle = emit(state, "session.idle", { sessionID: "root" }, 9_000)
  assert.equal(byIdle.handled, true)
  assert.equal(byIdle.state.statuses.root, "idle")
  assert.equal(byIdle.state.starts.root, undefined)

  const byExecution = emit(state, "session.execution.succeeded", { sessionID: "root" }, 9_000)
  assert.equal(byExecution.handled, true)
  assert.equal(byExecution.state.statuses.root, "idle")
  assert.equal(byExecution.state.starts.root, undefined)
})

test("an idle root with a running descendant keeps a leading coordinating row", () => {
  const state = seed("root", [
    [makeSession("root", { created: 1_000 }), "idle"],
    [makeSession("child", { parentID: "root", created: 2_000, busy: 2_000 }), "running"],
  ])

  const view = computeView(state, 5_000, defaultOptions())
  assert.equal(view.rows.length, 2)
  assert.equal(view.rows[0].id, "root")
  assert.equal(view.rows[0].kind, "coordinating")
  assert.equal(view.rows[1].id, "child")
  assert.equal(view.rows[1].kind, "running")
})

test("elapsed time advances with the passed clock and formatElapsed boundaries are stable", () => {
  const state = seed("root", [[makeSession("root", { created: 10_000, busy: 10_000 }), "running"]])

  assert.equal(computeView(state, 10_000, defaultOptions()).rows[0].line1, "> agent-root  0s")
  assert.equal(computeView(state, 75_000, defaultOptions()).rows[0].line1, "> agent-root  1m 05s")

  assert.equal(formatElapsed(0), "0s")
  assert.equal(formatElapsed(999), "0s")
  assert.equal(formatElapsed(1_000), "1s")
  assert.equal(formatElapsed(59_999), "59s")
  assert.equal(formatElapsed(60_000), "1m 00s")
  assert.equal(formatElapsed(3_600_000), "1h 00m")
  assert.equal(formatElapsed(3_661_000), "1h 01m")
})

test("deriveStatus prefers the newer timestamp, then falls back only when neither exists", () => {
  assert.equal(deriveStatus({ id: "s", busy: 10, idle: 0 }, "idle"), "running")
  assert.equal(deriveStatus({ id: "s", busy: 10, idle: undefined }, "idle"), "running")
  assert.equal(deriveStatus({ id: "s", busy: 10, idle: 10 }, "running"), "idle")
  assert.equal(deriveStatus({ id: "s", busy: 1, idle: 10 }, "running"), "idle")
  assert.equal(deriveStatus({ id: "s", idle: 10 }, "running"), "idle")
  assert.equal(deriveStatus({ id: "s", busy: 0 }, "idle"), "running")
  assert.equal(deriveStatus({ id: "s" }, "running"), "running")
  assert.equal(deriveStatus({ id: "s" }, "idle"), "idle")
})

test("a new busy timestamp resets the running start without an intervening idle event", () => {
  const state = setRoot(createState("root"), "root", "root")

  const first = snap(state, makeSession("root", { created: 1_000, busy: 1_000 }), "running", 1_000)
  assert.equal(first.starts.root, 1_000)
  assert.equal(computeView(first, 5_000, defaultOptions()).rows[0].line1, "> agent-root  4s")

  const second = snap(
    first,
    makeSession("root", { created: 1_000, updated: 2_000, busy: 2_000 }),
    "running",
    2_000,
  )
  assert.equal(second.starts.root, 2_000)
  assert.equal(computeView(second, 5_000, defaultOptions()).rows[0].line1, "> agent-root  3s")
})

test("a turn-ending idle snapshot clears the start and removes the row without an idle event", () => {
  const state = setRoot(createState("root"), "root", "root")
  const running = snap(state, makeSession("root", { created: 1_000, busy: 1_000 }), "running", 1_000)
  assert.equal(running.starts.root, 1_000)

  const ended = snap(
    running,
    makeSession("root", { created: 1_000, busy: 1_000, idle: 5_000 }),
    "idle",
    5_000,
  )
  assert.equal(ended.statuses.root, "idle")
  assert.equal("root" in ended.starts, false)
  assert.equal(ended.starts.root, undefined)

  const view = computeView(ended, 5_000, defaultOptions())
  assert.deepEqual(view.rows, [])
  assert.equal(view.empty, true)
})

test("session.created only refreshes while snapshots add child and grandchild rows by depth", () => {
  const state = seed("root", [[makeSession("root", { created: 1_000, busy: 1_000 }), "running"]])

  const created = emit(state, "session.created", { sessionID: "child" }, 500)
  assert.equal(created.handled, true)
  assert.equal(created.state.sessions.child, undefined)
  assert.deepEqual(
    computeView(created.state, 2_000, defaultOptions()).rows.map((row) => row.id),
    ["root"],
  )

  const withChild = snap(
    created.state,
    makeSession("child", { parentID: "root", created: 2_000, busy: 2_000 }),
    "running",
  )
  const childView = computeView(withChild, 3_000, defaultOptions())
  assert.deepEqual(childView.rows.map((row) => row.id), ["root", "child"])
  assert.equal(childView.rows.filter((row) => row.id === "child").length, 1)
  assert.equal(childView.rows[1].line1, "  > agent-child  1s")

  const withGrandchild = snap(
    withChild,
    makeSession("grandchild", { parentID: "child", created: 3_000, busy: 3_000 }),
    "running",
  )
  const grandchildView = computeView(withGrandchild, 3_000, defaultOptions())
  assert.deepEqual(grandchildView.rows.map((row) => row.id), ["root", "child", "grandchild"])
  assert.equal(grandchildView.rows[2].line1, "    > agent-grandchild  0s")

  const withOutside = snap(withGrandchild, makeSession("outside", { created: 4_000 }), "idle")
  const withStranger = snap(
    withOutside,
    makeSession("stranger", { parentID: "outside", created: 5_000, busy: 5_000 }),
    "running",
  )
  const familyView = computeView(withStranger, 5_000, defaultOptions())
  assert.deepEqual(familyView.rows.map((row) => row.id), ["root", "child", "grandchild"])
  assert.equal(familyView.rows.some((row) => row.id === "stranger"), false)
  assert.equal(familyView.rows.some((row) => row.id === "outside"), false)
})

test("rows follow depth-first tree order with children sorted by created time", () => {
  const state = seed("root", [
    [makeSession("root", { created: 0, busy: 1_000 }), "running"],
    [makeSession("a", { parentID: "root", created: 1, busy: 1_000 }), "running"],
    [makeSession("b", { parentID: "root", created: 2, busy: 1_000 }), "running"],
    [makeSession("a1", { parentID: "a", created: 3, busy: 1_000 }), "running"],
  ])

  const view = computeView(state, 5_000, defaultOptions())
  assert.deepEqual(view.rows.map((row) => row.id), ["root", "a", "a1", "b"])
  assert.equal(view.rows[0].line1, "> agent-root  4s")
  assert.equal(view.rows[1].line1, "  > agent-a  4s")
  assert.equal(view.rows[2].line1, "    > agent-a1  4s")
  assert.equal(view.rows[3].line1, "  > agent-b  4s")
})

test("a current session with a missing parent attaches under the anchor exactly once", () => {
  const base = seed("root", [[makeSession("root", { created: 0, busy: 1_000 }), "running"]])
  const withOrphan = snap(
    setRoot(base, "orphan", "root"),
    makeSession("orphan", { parentID: "missing", created: 5_000, busy: 5_000 }),
    "running",
    5_000,
  )

  const view = computeView(withOrphan, 6_000, defaultOptions())
  assert.deepEqual(view.rows.map((row) => row.id), ["root", "orphan"])
  assert.equal(view.rows.filter((row) => row.id === "orphan").length, 1)
  assert.equal(view.rows[1].line1, "  > agent-orphan  1s")
})

test("an orphan with a parent absent from state attaches under the anchor once at depth 1", () => {
  const base = seed("root", [[makeSession("root", { created: 0, busy: 1_000 }), "running"]])
  const withOrphan = snap(
    base,
    makeSession("orphan", { parentID: "missing", created: 5_000, busy: 5_000 }),
    "running",
    5_000,
  )

  assert.equal("missing" in withOrphan.sessions, false)
  const view = computeView(withOrphan, 6_000, defaultOptions())
  assert.deepEqual(view.rows.map((row) => row.id), ["root", "orphan"])
  assert.equal(view.rows.filter((row) => row.id === "orphan").length, 1)
  assert.equal(view.rows[1].line1, "  > agent-orphan  1s")
})

test("repeated step events and snapshots keep row ids unique and counts stable", () => {
  let state = seed("root", [
    [makeSession("root", { created: 1_000, busy: 1_000 }), "running"],
    [makeSession("child", { parentID: "root", created: 2_000, busy: 2_000 }), "running"],
  ])
  const before = computeView(state, 3_000, defaultOptions()).rows.map((row) => row.id)

  for (let index = 0; index < 5; index += 1) {
    state = emit(state, "session.step.started", { sessionID: "child" }, 1_500 + index).state
    state = snap(state, makeSession("child", { parentID: "root", created: 2_000, busy: 2_000 }), "running")
  }

  const view = computeView(state, 3_000, defaultOptions())
  const ids = view.rows.map((row) => row.id)
  assert.deepEqual(ids, before)
  assert.equal(new Set(ids).size, ids.length)

  const idleRoot = emit(state, "session.status", { sessionID: "root", status: { type: "idle" } }, 3_000).state
  const coordinatorView = computeView(idleRoot, 4_000, defaultOptions())
  const coordinatorIds = coordinatorView.rows.map((row) => row.id)
  assert.equal(coordinatorView.rows[0].kind, "coordinating")
  assert.equal(coordinatorIds.length, 2)
  assert.equal(new Set(coordinatorIds).size, coordinatorIds.length)
  assert.notEqual(coordinatorView.rows[0].id, coordinatorView.rows[1].id)
})

test("coordinator row leads idle-root views, uses the earliest descendant start, and respects options", () => {
  const coordinatorState = seed("root", [
    [makeSession("root", { created: 500 }), "idle"],
    [makeSession("c1", { parentID: "root", created: 1_000, busy: 3_000 }), "running"],
    [makeSession("c2", { parentID: "root", created: 2_000, busy: 2_000 }), "running"],
  ])

  const view = computeView(coordinatorState, 7_000, defaultOptions())
  assert.deepEqual(view.rows.map((row) => row.id), ["root", "c1", "c2"])
  assert.equal(view.rows[0].kind, "coordinating")
  assert.equal(view.rows[0].line1, "~ agent-root  5s")
  assert.equal(view.rows[0].line2, "  model-root - coordinating - Title root")
  assert.equal(view.rows[1].line1, "  > agent-c1  4s")
  assert.equal(view.rows[2].line1, "  > agent-c2  5s")

  const rootRunning = seed("root", [
    [makeSession("root", { created: 500, busy: 500 }), "running"],
    [makeSession("c1", { parentID: "root", created: 1_000, busy: 3_000 }), "running"],
    [makeSession("c2", { parentID: "root", created: 2_000, busy: 2_000 }), "running"],
  ])
  const runningView = computeView(rootRunning, 7_000, defaultOptions())
  assert.equal(runningView.rows.some((row) => row.kind === "coordinating"), false)
  assert.equal(runningView.rows.length, 3)

  const hidden = computeView(coordinatorState, 7_000, defaultOptions({ showCoordinator: false }))
  assert.deepEqual(hidden.rows.map((row) => row.id), ["c1", "c2"])
  assert.equal(hidden.rows.some((row) => row.kind === "coordinating"), false)

  const crowded = seed(
    "root",
    [
      [makeSession("root", { created: 500 }), "idle"],
      [makeSession("c1", { parentID: "root", created: 1_000, busy: 1_000 }), "running"],
      [makeSession("c2", { parentID: "root", created: 2_000, busy: 2_000 }), "running"],
      [makeSession("c3", { parentID: "root", created: 3_000, busy: 3_000 }), "running"],
      [makeSession("c4", { parentID: "root", created: 4_000, busy: 4_000 }), "running"],
    ],
  )
  const tight = computeView(crowded, 5_000, defaultOptions({ maxRows: 3 }))
  assert.equal(tight.rows.length, 3)
  assert.equal(tight.rows.some((row) => row.kind === "coordinating"), false)
  assert.equal(tight.more, 2)
})

test("empty views and maxRows truncation report the correct more count", () => {
  const empty = computeView(createState("root"), 0, defaultOptions())
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.more, 0)
  assert.equal(empty.empty, true)

  const workers: Array<[SessionSnapshot, MonitorStatus]> = [
    [makeSession("root", { created: 1_000, busy: 1_000 }), "running"],
  ]
  for (let index = 1; index < 10; index += 1) {
    workers.push([
      makeSession(`worker-${index}`, { parentID: "root", created: 1_000 + index, busy: 1_000 + index }),
      "running",
    ])
  }
  const view = computeView(seed("root", workers), 20_000, defaultOptions({ maxRows: 8 }))
  assert.equal(view.rows.length, 8)
  assert.equal(view.more, 2)
  assert.equal(view.empty, false)
  assert.equal(view.rows.some((row) => row.kind === "coordinating"), false)

  const coordinatorState = seed("root", [
    [makeSession("root", { created: 500 }), "idle"],
    [makeSession("c1", { parentID: "root", created: 1_000, busy: 1_000 }), "running"],
    [makeSession("c2", { parentID: "root", created: 2_000, busy: 2_000 }), "running"],
    [makeSession("c3", { parentID: "root", created: 3_000, busy: 3_000 }), "running"],
  ])
  const noRoom = computeView(coordinatorState, 5_000, defaultOptions({ maxRows: 3 }))
  assert.equal(noRoom.rows.some((row) => row.kind === "coordinating"), false)
  assert.equal(noRoom.more, 1)

  const room = computeView(coordinatorState, 5_000, defaultOptions({ maxRows: 4 }))
  assert.equal(room.rows[0].kind, "coordinating")
  assert.equal(room.rows.length, 4)
  assert.equal(room.more, 0)
})

test("every transition returns a new state without mutating the original", () => {
  const base = seed("root", [
    [makeSession("root", { created: 1_000, busy: 1_000 }), "running"],
    [makeSession("child", { parentID: "root", created: 2_000 }), "idle"],
  ])
  const before = JSON.stringify(base)

  const transitions: Array<[string, MonitorState]> = [
    ["setRoot", setRoot(base, "root", "root")],
    ["applySnapshot", snap(base, makeSession("new", { created: 5_000, busy: 5_000 }), "running")],
    ["applyStatus", applyStatus(base, "child", "running", 2_000)],
    ["applyActivity", applyActivity(base, "child", 2_000)],
    ["applyIdle", applyIdle(base, "root", 2_000)],
    ["removeSession", removeSession(base, "child")],
    [
      "applyNamedEvent",
      emit(base, "session.status", { sessionID: "child", status: { type: "busy" } }, 4_000).state,
    ],
  ]

  for (const [name, next] of transitions) {
    assert.notEqual(next, base, `${name} should return a new state object`)
    assert.equal(JSON.stringify(base), before, `${name} must not mutate its input`)
  }
})

test("snapshots without timestamps start at zero and repeated application is deterministic", () => {
  const base = seed("root", [[makeSession("root", { created: 100, busy: 100 }), "running"]])
  const fresh: SessionSnapshot = { id: "fresh" }

  const once = snap(base, fresh, "running")
  const twice = snap(base, fresh, "running")
  assert.equal(once.starts.fresh, 0)
  assert.equal(twice.starts.fresh, 0)
  assert.deepEqual(once, twice)

  const chained = snap(once, fresh, "running")
  assert.equal(chained.starts.fresh, 0)
  assert.deepEqual(chained, once)
})

test("usage, step failure and retry scheduling events refresh without changing state", () => {
  const base = seed("root", [
    [makeSession("root", { created: 500, updated: 500 }), "idle"],
    [makeSession("child", { parentID: "root", created: 1_000, updated: 1_000 }), "idle"],
  ])

  for (const name of ["session.usage.updated", "session.step.failed", "session.retry.scheduled"]) {
    const result = emit(base, name, { sessionID: "child" }, 4_000)
    assert.equal(result.handled, true, name)
    assert.equal(result.state, base, name)
    assert.equal(result.state.statuses.child, "idle", name)
    assert.equal(result.state.starts.child, undefined, name)
  }
})

test("applyNamedEvent maps status, execution, step, tool, refresh, delete and invalid events exactly", () => {
  const base = seed("root", [
    [makeSession("root", { created: 500, updated: 500 }), "idle"],
    [makeSession("child", { parentID: "root", created: 1_000, updated: 1_000 }), "idle"],
  ])
  const childSnapshot = base.sessions.child

  const assertActivity = (
    result: { state: MonitorState; handled: boolean },
    name: string,
  ) => {
    assert.equal(result.handled, true, name)
    assert.notEqual(result.state, base, name)
    assert.equal(result.state.statuses.child, "running", name)
    assert.equal(result.state.starts.child, 4_000, name)
    assert.deepEqual(result.state.sessions.child, { ...childSnapshot, updated: 4_000 }, name)
    assert.deepEqual(result.state.statuses, { ...base.statuses, child: "running" }, name)
  }

  for (const type of ["busy", "retry"]) {
    const result = emit(base, "session.status", { sessionID: "child", status: { type } }, 4_000)
    assertActivity(result, `session.status:${type}`)
  }

  for (const name of [
    "session.execution.started",
    "session.step.started",
    "session.step.streamed",
    "session.tool.called",
    "session.tool.output.delta",
    "session.tool.future.event",
  ]) {
    assertActivity(emit(base, name, { sessionID: "child" }, 4_000), name)
  }

  const runningChild = emit(
    base,
    "session.status",
    { sessionID: "child", status: { type: "busy" } },
    1_000,
  ).state
  for (const name of [
    "session.status idle",
    "session.idle",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ]) {
    const result =
      name === "session.status idle"
        ? emit(runningChild, "session.status", { sessionID: "child", status: { type: "idle" } }, 2_000)
        : emit(runningChild, name, { sessionID: "child" }, 2_000)
    assert.equal(result.handled, true, name)
    assert.equal(result.state.statuses.child, "idle", name)
    assert.equal(result.state.starts.child, undefined, name)
    assert.deepEqual(result.state.sessions, runningChild.sessions, name)
  }

  for (const name of [
    "session.created",
    "session.renamed",
    "session.model.selected",
    "session.agent.selected",
    "session.step.ended",
    "session.step.failed",
    "session.retry.scheduled",
    "session.usage.updated",
  ]) {
    const result = emit(base, name, { sessionID: "child" }, 4_000)
    assert.equal(result.handled, true, name)
    assert.equal(result.state, base, name)
  }

  const unknownStatus = emit(base, "session.status", { sessionID: "child", status: { type: "mystery" } }, 4_000)
  assert.equal(unknownStatus.handled, false)
  assert.equal(unknownStatus.state, base)

  const deleted = emit(base, "session.deleted", { sessionID: "child" }, 4_000)
  assert.equal(deleted.handled, true)
  assert.equal(deleted.state.sessions.child, undefined)
  assert.equal(deleted.state.statuses.child, undefined)
  assert.equal(deleted.state.starts.child, undefined)
  assert.deepEqual(Object.keys(deleted.state.sessions), ["root"])

  for (const name of ["session.mystery", "message.updated", ""]) {
    const result = emit(base, name, { sessionID: "child" }, 4_000)
    assert.equal(result.handled, false, name)
    assert.equal(result.state, base, name)
  }

  const invalidData: unknown[] = [{}, { sessionID: undefined }, { sessionID: 42 }, { sessionID: null }, null]
  for (const data of invalidData) {
    const result = applyNamedEvent(base, "session.idle", data as { sessionID?: string }, 4_000)
    assert.equal(result.handled, false)
    assert.equal(result.state, base)
  }
})
