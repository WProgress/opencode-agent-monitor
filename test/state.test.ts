import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  normalizePath,
  openDatabase,
  readSessions,
  readTodos,
  resolveProject,
} from "../src/db.ts";
import {
  buildSnapshot,
  formatDuration,
  isWorking,
  loadRoster,
  type AgentDefinition,
  type Desk,
  type Snapshot,
} from "../src/state.ts";
import { renderAgentForm, renderPage } from "../src/render.ts";
import { renderInteractivePage } from "../src/interactive.ts";
import { renderOrgPage } from "../src/org.ts";

const NOW = Date.parse("2026-11-05T08:00:00Z");
const MINUTE = 60_000;

interface SessionSeed {
  id: string;
  agent: string;
  title: string;
  parent?: string | null;
  busy?: number | null;
  idle?: number | null;
  updated?: number | null;
  archived?: number | null;
}

interface TodoSeed {
  sessionId: string;
  content: string;
  status: string;
  position?: number;
}

const ROSTER: AgentDefinition[] = [
  { id: "build", name: "Build", description: "Primary agent", tone: "#3b6ea5" },
  { id: "reviewer", name: "Reviewer", description: "Code review", tone: "#2c8aa0" },
  { id: "tester", name: "Tester", description: "QA", tone: "#3f8f63" },
  { id: "architect", name: "Architect", description: "Design", tone: "#7c5cbf" },
];

function fixture(sessions: SessionSeed[], todos: TodoSeed[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "agent-monitor-"));
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`
    create table project (
      id text primary key, name text, worktree text,
      time_active integer, time_archived integer
    );
    create table project_directory (project_id text, directory text);
    create table session_v2 (
      id text, project_id text, parent_id text, agent text, title text,
      time_created integer, time_updated integer, time_busy integer,
      time_idle integer, time_archived integer, time_compacting integer
    );
    create table todo (
      session_id text, content text, status text, priority text, position integer
    );
  `);
  db.prepare("insert into project values (?, ?, ?, ?, ?)").run(
    "project-1",
    null,
    "D:/SourceCode/Personal/BillingAgent",
    NOW,
    null,
  );
  db.prepare("insert into project_directory values (?, ?)").run(
    "project-1",
    "D:/SourceCode/Personal/BillingAgent",
  );

  for (const session of sessions) {
    db.prepare(
      `insert into session_v2
         (id, project_id, parent_id, agent, title, time_created, time_updated,
          time_busy, time_idle, time_archived)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      "project-1",
      session.parent ?? null,
      session.agent,
      session.title,
      session.updated ?? NOW,
      session.updated ?? NOW,
      session.busy ?? null,
      session.idle ?? null,
      session.archived ?? null,
    );
  }

  for (const todo of todos) {
    db.prepare(
      "insert into todo (session_id, content, status, priority, position) values (?, ?, ?, ?, ?)",
    ).run(todo.sessionId, todo.content, todo.status, null, todo.position ?? 0);
  }

  db.close();
  return { dir, path };
}

function tempDatabase(
  name: string,
  schema: string,
  seed: (db: DatabaseSync) => void = () => {},
) {
  const dir = mkdtempSync(join(tmpdir(), `agent-monitor-${name}-`));
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(schema);
  seed(db);
  db.close();
  return { dir, path };
}

function readFixture(path: string) {
  const connection = openDatabase(path);
  const project = resolveProject(connection, "d:/sourcecode/personal/billingagent/");
  assert.ok(project, "project should resolve");
  const sessions = readSessions(connection, project.id);
  const todos = readTodos(connection, sessions.map((session) => session.id));
  connection.db.close();
  return { project, sessions, todos };
}

function snapshotOf(
  sessions: SessionSeed[],
  todos: TodoSeed[] = [],
  roster: AgentDefinition[] = ROSTER,
) {
  const { dir, path } = fixture(sessions, todos);
  try {
    const { project, sessions: rows, todos: todoRows } = readFixture(path);
    return buildSnapshot({
      now: NOW,
      project,
      sessions: rows,
      todos: todoRows,
      roster,
      staleMs: 15 * MINUTE,
      hasBusySignal: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function desk(snapshot: Snapshot, id: string): Desk {
  const found = snapshot.desks.find((entry) => entry.id === id);
  assert.ok(found, `desk ${id} should exist`);
  return found;
}

test("normalises Windows paths for comparison", () => {
  assert.equal(
    normalizePath("D:\\SourceCode\\Personal\\BillingAgent\\"),
    "d:/sourcecode/personal/billingagent",
  );
  assert.equal(
    normalizePath("d:/sourcecode//personal/billingagent"),
    "d:/sourcecode/personal/billingagent",
  );
  assert.equal(normalizePath("D:\\SourceCode\\Personal\\BillingAgent"), normalizePath("d:/SourceCode/Personal/BillingAgent"));
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("   "), "");
});

test("resolves the project regardless of path case or trailing slash", () => {
  const { dir, path } = fixture([]);
  try {
    const connection = openDatabase(path);
    const project = resolveProject(connection, "d:\\sourcecode\\personal\\billingagent\\");
    assert.equal(project?.id, "project-1");
    assert.equal(project?.worktree, "D:/SourceCode/Personal/BillingAgent");
    connection.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores archived projects even when they share the worktree", () => {
  const { dir, path } = tempDatabase(
    "archived-project",
    `
      create table project (
        id text primary key, name text, worktree text,
        time_active integer, time_archived integer
      );
      create table session_v2 (id text, project_id text);
    `,
    (db) => {
      db.prepare("insert into project values (?, ?, ?, ?, ?)").run(
        "active",
        "Active",
        "D:/SourceCode/Personal/BillingAgent",
        NOW,
        null,
      );
      db.prepare("insert into project values (?, ?, ?, ?, ?)").run(
        "archived",
        "Archived",
        "D:/SourceCode/Personal/BillingAgent",
        NOW + MINUTE,
        NOW,
      );
    },
  );

  try {
    const connection = openDatabase(path);
    const project = resolveProject(connection, "d:/sourcecode/personal/billingagent");
    assert.equal(project?.id, "active");
    connection.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("degrades to no project when the project table is missing", () => {
  const { dir, path } = tempDatabase(
    "missing-project",
    "create table session_v2 (id text, project_id text);",
  );

  try {
    const connection = openDatabase(path);
    assert.equal(resolveProject(connection, "D:/anywhere"), null);
    connection.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a session table without the required project_id column", () => {
  const { dir, path } = tempDatabase(
    "missing-project-id",
    "create table session_v2 (id text, title text);",
  );

  try {
    assert.throws(() => openDatabase(path), /missing the required "project_id" column/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads todos when optional priority and position columns are missing", () => {
  const { dir, path } = tempDatabase(
    "sparse-todo",
    `
      create table project (id text, name text, worktree text, time_active integer);
      create table session_v2 (
        id text, project_id text, agent text, title text,
        time_updated integer, time_busy integer, time_idle integer
      );
      create table todo (session_id text, content text, status text);
    `,
    (db) => {
      db.prepare("insert into project values (?, ?, ?, ?)").run(
        "project-1",
        "BillingAgent",
        "D:/SourceCode/Personal/BillingAgent",
        NOW,
      );
      db.prepare(
        "insert into session_v2 (id, project_id, agent, title, time_updated, time_busy, time_idle) values (?, ?, ?, ?, ?, ?, ?)",
      ).run("s-build", "project-1", "build", "Ship the monitor", NOW, NOW - MINUTE, null);
      db.prepare("insert into todo (session_id, content, status) values (?, ?, ?)").run(
        "s-build",
        "Run the focused tests",
        "in_progress",
      );
    },
  );

  try {
    const connection = openDatabase(path);
    const project = resolveProject(connection, "d:/sourcecode/personal/billingagent");
    assert.equal(project?.id, "project-1");
    const sessions = readSessions(connection, "project-1");
    const todos = readTodos(connection, sessions.map((session) => session.id));
    assert.equal(todos.length, 1);
    assert.equal(todos[0]?.content, "Run the focused tests");
    assert.equal(todos[0]?.priority, null);
    assert.equal(todos[0]?.position, null);
    connection.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("marks an agent working while its session is busy", () => {  const snapshot = snapshotOf([
    {
      id: "s-build",
      agent: "build",
      title: "Ship the monitor",
      busy: NOW - 10 * MINUTE,
      updated: NOW - 1 * MINUTE,
    },
  ]);

  const build = desk(snapshot, "build");
  assert.equal(build.status, "working");
  assert.equal(build.task, "Ship the monitor");
  assert.equal(build.elapsedMs, 10 * MINUTE);
  assert.equal(snapshot.summary.working, 1);
  assert.equal(snapshot.summary.sleeping, 3);
});

test("returns an agent to sleeping once its idle marker is newer than busy", () => {
  const snapshot = snapshotOf([
    {
      id: "s-reviewer",
      agent: "reviewer",
      title: "Approve wave 1a",
      busy: NOW - 45 * MINUTE,
      idle: NOW - 20 * MINUTE,
      updated: NOW - 20 * MINUTE,
    },
  ]);

  const reviewer = desk(snapshot, "reviewer");
  assert.equal(reviewer.status, "sleeping");
  assert.equal(reviewer.task, "Approve wave 1a");
  assert.equal(reviewer.lastSeenAgoMs, 20 * MINUTE);
  assert.match(reviewer.detail, /Last active 20m ago/);
});

test("does not trust a busy marker with no recent activity", () => {
  const snapshot = snapshotOf([
    {
      id: "s-tester",
      agent: "tester",
      title: "Abandoned run",
      busy: NOW - 60 * MINUTE,
      updated: NOW - 40 * MINUTE,
    },
  ]);

  assert.equal(desk(snapshot, "tester").status, "sleeping");
});

test("keeps a long-running session working while it is still active", () => {
  const snapshot = snapshotOf([
    {
      id: "s-tester",
      agent: "tester",
      title: "Full suite",
      busy: NOW - 55 * MINUTE,
      updated: NOW - 30 * 1000,
    },
  ]);

  assert.equal(desk(snapshot, "tester").status, "working");
  assert.equal(desk(snapshot, "tester").elapsedMs, 55 * MINUTE);
});

test("ignores archived sessions", () => {
  const snapshot = snapshotOf([
    {
      id: "s-tester",
      agent: "tester",
      title: "Old archived run",
      busy: NOW - 5 * MINUTE,
      updated: NOW - 1 * MINUTE,
      archived: NOW - 2 * MINUTE,
    },
  ]);

  assert.equal(desk(snapshot, "tester").status, "sleeping");
  assert.equal(desk(snapshot, "tester").task, "No task yet");
});

test("rolls an active child session up to its coordinating agent", () => {
  const snapshot = snapshotOf([
    {
      id: "s-build",
      agent: "build",
      title: "Main Session (Build Agent)",
      busy: NOW - 2 * 60 * MINUTE,
      idle: NOW - 60 * MINUTE,
      updated: NOW - 60 * MINUTE,
    },
    {
      id: "s-tester",
      agent: "tester",
      title: "Verify wave 1a final",
      parent: "s-build",
      busy: NOW - 6 * MINUTE,
      updated: NOW - 30 * 1000,
    },
  ]);

  const build = desk(snapshot, "build");
  assert.equal(build.status, "working");
  assert.equal(build.coordinating, true);
  assert.equal(build.subAgents, 1);
  assert.match(build.task, /Coordinating: Verify wave 1a final/);
  assert.deepEqual(build.subAgentIds, ["tester"]);
  assert.equal(desk(snapshot, "tester").status, "working");
  assert.equal(desk(snapshot, "tester").parentAgentId, "build");
});

test("keeps the parent link after a child agent goes idle", () => {
  const snapshot = snapshotOf([
    {
      id: "s-build",
      agent: "build",
      title: "Main Session (Build Agent)",
      busy: NOW - 2 * 60 * MINUTE,
      idle: NOW - 60 * MINUTE,
      updated: NOW - 60 * MINUTE,
    },
    {
      id: "s-tester",
      agent: "tester",
      title: "Verify wave 1a final",
      parent: "s-build",
      busy: NOW - 20 * MINUTE,
      idle: NOW - 5 * MINUTE,
      updated: NOW - 5 * MINUTE,
    },
  ]);

  const tester = desk(snapshot, "tester");
  assert.equal(tester.status, "sleeping");
  assert.equal(tester.parentAgentId, "build");
  assert.deepEqual(desk(snapshot, "build").subAgentIds, []);
});

test("shows an agent's own task while still noting its sub-agents", () => {
  const snapshot = snapshotOf([
    {
      id: "s-build",
      agent: "build",
      title: "Main Session (Build Agent)",
      busy: NOW - 5 * MINUTE,
      updated: NOW - 10 * 1000,
    },
    {
      id: "s-tester",
      agent: "tester",
      title: "Verify wave 1a final",
      parent: "s-build",
      busy: NOW - 4 * MINUTE,
      updated: NOW - 20 * 1000,
    },
  ]);

  const build = desk(snapshot, "build");
  assert.equal(build.status, "working");
  assert.equal(build.coordinating, true);
  assert.equal(build.subAgents, 1);
  assert.equal(build.task, "Working on your request");
  assert.match(build.detail, /sub-agent/);
});

test("uses the in-progress todo as the task for a generic main session", () => {
  const snapshot = snapshotOf(
    [
      {
        id: "s-build",
        agent: "build",
        title: "Main Session (Build Agent)",
        busy: NOW - 3 * MINUTE,
        updated: NOW - 5 * 1000,
      },
    ],
    [
      { sessionId: "s-build", content: "Read the current schema", status: "completed" },
      {
        sessionId: "s-build",
        content: "Run the focused test suite",
        status: "in_progress",
        position: 1,
      },
      { sessionId: "s-build", content: "Ship the release", status: "pending", position: 2 },
    ],
  );

  const build = desk(snapshot, "build");
  assert.equal(build.task, "Run the focused test suite");
  assert.equal(build.progress, "1/3");
  assert.match(build.detail, /1 of 3 steps/);
});

test("shows a visitor desk for an active agent outside the roster", () => {
  const snapshot = snapshotOf([
    {
      id: "s-explore",
      agent: "explore",
      title: "Find the invoice routes",
      busy: NOW - 2 * MINUTE,
      updated: NOW - 10 * 1000,
    },
  ]);

  const explore = desk(snapshot, "explore");
  assert.equal(explore.status, "working");
  assert.equal(explore.visitor, true);
  assert.equal(explore.name, "Explore");
  assert.equal(snapshot.summary.working, 1);
  assert.equal(snapshot.summary.total, 5);
});

test("keeps unused roster agents asleep with no task", () => {
  const snapshot = snapshotOf([]);
  const architect = desk(snapshot, "architect");
  assert.equal(architect.status, "sleeping");
  assert.equal(architect.task, "No task yet");
  assert.equal(architect.detail, "Waiting for a task");
  assert.equal(snapshot.summary.working, 0);
});

test("counts concurrent sessions and picks the newest active task", () => {
  const snapshot = snapshotOf([
    {
      id: "s-older",
      agent: "reviewer",
      title: "First review",
      busy: NOW - 8 * MINUTE,
      updated: NOW - 7 * MINUTE,
    },
    {
      id: "s-newer",
      agent: "reviewer",
      title: "Second review",
      busy: NOW - 3 * MINUTE,
      updated: NOW - 10 * 1000,
    },
  ]);

  const reviewer = desk(snapshot, "reviewer");
  assert.equal(reviewer.activeCount, 2);
  assert.equal(reviewer.task, "Second review");
  assert.equal(reviewer.elapsedMs, 3 * MINUTE);
});

test("formats durations at every boundary", () => {
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(0), "1s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(90_000), "1m");
  assert.equal(formatDuration(59 * MINUTE), "59m");
  assert.equal(formatDuration(3.5 * 60 * MINUTE), "3h 30m");
  assert.equal(formatDuration(26 * 60 * MINUTE), "1d 2h");
});

test("loads the roster from agent markdown and always includes build first", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-roster-"));
  try {
    writeFileSync(
      join(dir, "reviewer.md"),
      "---\ndescription: Independent code reviewer for correctness.\nmode: subagent\n---\n\n# reviewer\n",
    );
    writeFileSync(
      join(dir, "sam-miller.md"),
      '---\ndescription: "Customer acceptance reviewer"\nmode: subagent\n---\n',
    );
    writeFileSync(join(dir, "notes.txt"), "not an agent");

    const roster = loadRoster(dir);
    assert.deepEqual(roster.map((agent) => agent.id), ["build", "reviewer", "sam-miller"]);
    assert.equal(roster[1]?.name, "Reviewer");
    assert.equal(roster[1]?.description, "Independent code reviewer for correctness.");
    assert.equal(roster[2]?.name, "Sam Miller");
    assert.equal(roster[2]?.description, "Customer acceptance reviewer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("treats missing agent directories as a build-only roster", () => {
  const roster = loadRoster(join(tmpdir(), "definitely-not-here", "agents"));
  assert.deepEqual(roster.map((agent) => agent.id), ["build"]);
});

test("isWorking needs a busy marker newer than idle, still fresh", () => {
  const base = {
    id: "s",
    projectId: "p",
    parentId: null,
    agent: "build",
    title: "x",
    timeCreated: NOW,
    timeUpdated: NOW,
    timeBusy: NOW,
    timeIdle: null,
    timeArchived: null,
  };
  assert.equal(isWorking(base, NOW, 15 * MINUTE), true);
  assert.equal(isWorking({ ...base, timeIdle: NOW + 1 }, NOW, 15 * MINUTE), false);
  assert.equal(
    isWorking(
      { ...base, timeBusy: NOW - 30 * MINUTE, timeUpdated: NOW - 30 * MINUTE },
      NOW,
      15 * MINUTE,
    ),
    false,
  );
  assert.equal(isWorking({ ...base, timeArchived: NOW }, NOW, 15 * MINUTE), false);
});

function deskModel(overrides: Partial<Desk> = {}): Desk {
  return {
    id: "build",
    name: "Build",
    description: "Primary agent",
    tone: "#3b6ea5",
    initials: "B",
    status: "working",
    task: "Ship the monitor",
    detail: "2 of 5 steps",
    progress: "2/5",
    elapsedMs: 10 * MINUTE,
    lastSeenAgoMs: null,
    activeCount: 1,
    subAgents: 0,
    coordinating: false,
    visitor: false,
    sessions: 1,
    ...overrides,
  };
}

function snapshotModel(desks: Desk[], error: string | null = null): Snapshot {
  const working = desks.filter((entry) => entry.status === "working").length;
  return {
    generatedAt: NOW,
    project: { id: "p", name: "BillingAgent", path: "D:/SourceCode/Personal/BillingAgent" },
    summary: { working, sleeping: desks.length - working, total: desks.length },
    desks,
    error,
  };
}

test("renders the mind map with walking wiring and escaped content", () => {
  const html = renderInteractivePage(
    snapshotModel([
      deskModel({
        id: "build",
        name: "Build",
        parentAgentId: null,
        subAgentIds: ["tester"],
        coordinating: true,
      }),
      deskModel({
        id: "tester",
        name: "Tester",
        initials: "T",
        task: "</script><script>alert(1)</script>",
        parentAgentId: "build",
        subAgentIds: [],
        status: "working",
        editable: true,
      }),
    ]),
    { databasePath: "C:/db/opencode.db", staleMinutes: 15, editing: true },
  );

  assert.match(html, /Agent mind map/);
  assert.match(html, /class="radial-stage" id="radial" data-role="radial"/);
  assert.match(html, /data-role="walker"/);
  assert.match(html, /class="agent-rail"/);
  assert.match(html, /data-agent-card="build"/);
  assert.match(html, /data-agent-card="tester"/);
  assert.match(html, /class="agent-card__edit" href="\/agents\/tester\/edit\?view=mindmap"/);
  assert.match(html, /\.agent-card\.is-sleeping \{ filter: grayscale\(1\)/);
  assert.match(html, /\.radial-node\.is-sleeping \{ filter: grayscale\(1\)/);
  assert.match(html, /Assigning:/);
  assert.match(html, /"subAgentIds":\["tester"\]/);
  assert.match(html, /"parentAgentId":"build"/);
  assert.doesNotMatch(html, /<\/script><script>alert\(1\)<\/script>/);
  assert.match(html, /\\u003c\/script>\\u003cscript>alert\(1\)\\u003c\/script>/);
  assert.match(html, /class="view-switch__item" href="\/\?view=desks">Desks/);
});

test("renders nested sub-agents on deeper radial rings", () => {
  const html = renderInteractivePage(
    snapshotModel([
      deskModel({
        id: "build",
        name: "Build",
        parentAgentId: null,
        subAgentIds: ["tester"],
        coordinating: true,
      }),
      deskModel({
        id: "tester",
        name: "Tester",
        initials: "T",
        parentAgentId: "build",
        subAgentIds: ["specialist"],
        coordinating: true,
      }),
      deskModel({
        id: "specialist",
        name: "Specialist",
        initials: "S",
        parentAgentId: "tester",
        subAgentIds: [],
        status: "working",
      }),
    ]),
    { databasePath: "C:/db/opencode.db", staleMinutes: 15, editing: true },
  );

  assert.match(html, /Agent mind map/);
  assert.match(html, /data-edge="build>tester"/);
  assert.match(html, /data-edge="tester>specialist"/);
  assert.match(html, /"parentAgentId":"tester"/);
  assert.match(html, /"subAgentIds":\["specialist"\]/);
  assert.match(html, /class="radial-ring"/);
});

test("renders the organizational structure with nested reporting and grayscale", () => {
  const html = renderOrgPage(
    snapshotModel([
      deskModel({
        id: "build",
        name: "Build",
        parentAgentId: null,
        subAgentIds: ["tester"],
        coordinating: true,
        editable: true,
      }),
      deskModel({
        id: "tester",
        name: "Tester",
        initials: "T",
        parentAgentId: "build",
        subAgentIds: ["specialist"],
        coordinating: true,
        editable: true,
      }),
      deskModel({
        id: "specialist",
        name: "Specialist",
        initials: "S",
        parentAgentId: "tester",
        subAgentIds: [],
        status: "sleeping",
        editable: true,
      }),
    ]),
    { databasePath: "C:/db/opencode.db", staleMinutes: 15, editing: true },
  );

  assert.match(html, /Organizational structure/);
  assert.match(html, /data-agent-card="build"/);
  assert.match(html, /data-agent-card="tester"/);
  assert.match(html, /data-agent-card="specialist"/);
  assert.match(html, /data-edge="build>tester"/);
  assert.match(html, /data-edge="tester>specialist"/);
  assert.match(html, /\.org-card\.is-sleeping \{ filter: grayscale\(1\)/);
  assert.match(html, /href="\/agents\/specialist\/edit\?view=org"/);
  assert.match(html, /class="view-switch__item" href="\/\?view=mindmap">Mind map/);
  assert.match(html, /data-action="fit">Fit chart/);
  assert.match(html, /data-role="search"/);
  assert.match(html, /currentHierarchy/);
  assert.match(html, /vector-effect: non-scaling-stroke/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("org chart handles empty teams, cycles and unsafe card content", () => {
  const meta = { databasePath: "test", staleMinutes: 15, editing: false };
  const empty = renderOrgPage(snapshotModel([]), meta);
  assert.match(empty, /Your team starts here/);
  assert.doesNotMatch(empty, /class="org-card org-card--lead org-hub"/);
  const html = renderOrgPage(snapshotModel([
    deskModel({ id: "a", parentAgentId: "b", name: '<img src=x onerror="bad()">', task: '</script><script>bad()</script>' }),
    deskModel({ id: "b", parentAgentId: "a" }),
    deskModel({ id: "c", parentAgentId: "missing" }),
  ]), meta);
  assert.equal((html.match(/data-agent-card=/g) ?? []).length, 3);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.doesNotMatch(html, /class="org-card__edit"/);
});

test("lays deep reporting chains out as readable columns", () => {
  const meta = { databasePath: "C:/db/opencode.db", staleMinutes: 15, editing: true };
  const html = renderOrgPage(
    snapshotModel([
      deskModel({ id: "build", name: "Build", parentAgentId: null }),
      deskModel({ id: "director", name: "Director", parentAgentId: "build" }),
      deskModel({ id: "manager", name: "Manager", parentAgentId: "director" }),
      deskModel({ id: "specialist", name: "Specialist", parentAgentId: "manager" }),
    ]),
    meta,
  );

  assert.match(html, /data-agent-card="specialist"/);
  assert.match(html, /data-depth="3"/);
  assert.match(html, /class="org-level org-level--column"/);
  assert.match(html, /org-band--column/);
  assert.match(html, /var readableZoom = 0.92/);
  assert.match(html, /@media \(max-width: 760px\)/);
  assert.match(html, /--depth\) \* 18px/);
});

test("renders working and sleeping desks with written status and live wiring", () => {
  const html = renderPage(
    snapshotModel([
      deskModel(),
      deskModel({
        id: "reviewer",
        name: "Reviewer",
        initials: "R",
        tone: "#2c8aa0",
        status: "sleeping",
        task: "Approve wave 1a",
        detail: "Last active 3h ago",
        progress: null,
        elapsedMs: null,
        lastSeenAgoMs: 3 * 60 * MINUTE,
        activeCount: 0,
      }),
    ]),
    { databasePath: "C:/Users/Hamza/.local/share/opencode/opencode.db", staleMinutes: 15 },
  );

  assert.match(html, /data-desk="build"/);
  assert.match(html, /class="desk desk--working"/);
  assert.match(html, /class="desk desk--sleeping"/);
  assert.match(html, /<span data-role="status">Working<\/span>/);
  assert.match(html, /<span data-role="status">Sleeping<\/span>/);
  assert.match(html, /new EventSource\(liveUrl\)/);
  assert.match(html, /var liveUrl = "\/events"/);
  assert.match(html, /<noscript><meta http-equiv="refresh" content="15"><\/noscript>/);
  assert.match(html, /<strong data-role="working">1<\/strong> working/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /prefers-reduced-motion/);
});

test("escapes task text and never emits raw markup", () => {
  const html = renderPage(
    snapshotModel([
      deskModel({
        task: '<script>alert("x")</script>',
        detail: "</article><b>boom</b>",
      }),
    ]),
    { databasePath: "x", staleMinutes: 15 },
  );

  assert.doesNotMatch(html, /<script>alert\("x"\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<\/article><b>boom<\/b>/);
  assert.match(html, /&lt;\/article&gt;&lt;b&gt;boom&lt;\/b&gt;/);
});

test("renders a clear error banner instead of desks when state is unavailable", () => {
  const html = renderPage(
    snapshotModel([], "No OpenCode project matches D:/nope"),
    { databasePath: "C:/db/opencode.db", staleMinutes: 15 },
  );

  assert.match(html, /class="banner" role="alert"/);
  assert.match(html, /Cannot read OpenCode state/);
  assert.match(html, /No OpenCode project matches D:\/nope/);
  assert.match(html, /No agent desks are configured/);
});

test("keeps a hidden error banner ready so live failures can be shown", () => {
  const html = renderPage(snapshotModel([deskModel()]), {
    databasePath: "x",
    staleMinutes: 15,
  });

  assert.match(html, /data-role="error" hidden/);
  assert.match(html, /data-role="error-text"/);
  assert.match(html, /toggle\(document, "error", failed\)/);
});

test("escapes roster tones used in inline styles", () => {
  const html = renderPage(
    snapshotModel([deskModel({ tone: '"><svg onload=alert(1)>' })]),
    { databasePath: "x", staleMinutes: 15 },
  );

  assert.doesNotMatch(html, /style="--tone:"><svg/);
  assert.match(html, /style="--tone:&quot;&gt;&lt;svg/);
});

test("escapes agent editor values and carries the CSRF token and hash", () => {
  const html = renderAgentForm({
    mode: "edit",
    draft: {
      id: "reviewer",
      name: '"><script>alert(1)</script>',
      description: "</textarea><script>alert(2)</script>",
      mode: "subagent",
      model: "openai/gpt-6.1-sol#medium",
      color: "#b3ff00",
      body: "</textarea><img src=x onerror=alert(3)>",
    },
    hash: "abc123",
    csrf: "token-value",
    errors: ["Bad <value>"],
  });

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<\/textarea><script>/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /name="csrf" value="token-value"/);
  assert.match(html, /name="hash" value="abc123"/);
  assert.match(html, /Bad &lt;value&gt;/);
  assert.match(html, /action="\/agents\/reviewer"/);
});


