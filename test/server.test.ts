import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { aliasPath } from "../src/agents.ts";
import type { Config } from "../src/config.ts";
import { createMonitor, type Monitor } from "../src/server.ts";

interface Fixture {
  dir: string;
  databasePath: string;
  agentsDir: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "agent-monitor-server-"));
  const databasePath = join(dir, "opencode.db");
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir);

  const db = new DatabaseSync(databasePath);
  db.exec(`
    create table project (
      id text primary key, name text, worktree text,
      time_active integer, time_archived integer
    );
    create table session_v2 (
      id text, project_id text, parent_id text, agent text, title text,
      time_created integer, time_updated integer, time_busy integer,
      time_idle integer, time_archived integer
    );
    create table todo (
      session_id text, content text, status text, priority text, position integer
    );
  `);
  db.prepare("insert into project values (?, ?, ?, ?, ?)").run(
    "project-1",
    "BillingAgent",
    dir,
    Date.now(),
    null,
  );
  db.close();

  writeFileSync(
    join(agentsDir, "reviewer.md"),
    `---
description: Independent code reviewer
mode: subagent
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---

Review the actual code.
`,
  );

  return { dir, databasePath, agentsDir };
}

function configFor(f: Fixture, overrides: Partial<Config> = {}): Config {
  return {
    projectPath: f.dir,
    databasePath: f.databasePath,
    port: 0,
    host: "127.0.0.1",
    staleMs: 15 * 60_000,
    refreshMs: 60_000,
    agentsDir: f.agentsDir,
    readOnly: false,
    ...overrides,
  };
}

async function start(config: Config): Promise<{ monitor: Monitor; base: string }> {
  const monitor = createMonitor(config);
  await new Promise<void>((resolve) => monitor.server.listen(0, "127.0.0.1", resolve));
  const address = monitor.server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port.");
  return { monitor, base: `http://127.0.0.1:${address.port}` };
}

function csrfOf(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, "form should include a CSRF token");
  return match[1];
}

function hashOf(html: string): string {
  const match = /name="hash" value="([^"]+)"/.exec(html);
  assert.ok(match, "edit form should include the file hash");
  return match[1];
}

async function post(
  base: string,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: base,
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}

/** Sends a form with a custom Host header, which fetch does not allow. */
function rawPost(
  port: string,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(port),
        path,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function agentFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: "security-auditor",
    name: "Security Auditor",
    description: "Reviews code for security issues",
    mode: "subagent",
    model: "openai/gpt-6.1-sol#medium",
    color: "#ff6b6b",
    body: "You are a security reviewer.\n",
    ...overrides,
  };
}

test("serves edit and create pages with editable desks", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f));
  try {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /New agent/);
    assert.match(html, /Organizational structure/);
    assert.match(html, /href="\/agents\/reviewer\/edit\?view=org(?:&amp;|&)project=project-1"/);
    const desks = await (await fetch(`${base}/?view=desks`)).text();
    assert.match(desks, /data-desk="reviewer"/);
    assert.match(desks, /href="\/agents\/reviewer\/edit\?view=desks(?:&amp;|&)project=project-1"/);
    const deskEdit = await (await fetch(`${base}/agents/reviewer/edit?view=desks`)).text();
    assert.match(deskEdit, /name="view" value="desks"/);
    assert.match(deskEdit, /Back to desks/);
    assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self'/);

    const edit = await fetch(`${base}/agents/reviewer/edit`);
    const editHtml = await edit.text();
    assert.equal(edit.status, 200);
    assert.match(editHtml, /Independent code reviewer/);
    assert.match(editHtml, /Review the actual code\./);
    assert.match(editHtml, /name="hash"/);

    const create = await fetch(`${base}/agents/new`);
    assert.equal(create.status, 200);
    assert.match(await create.text(), /Create agent/);

    const interactive = await fetch(`${base}/?view=mindmap`);
    const interactiveHtml = await interactive.text();
    assert.equal(interactive.status, 200);
    assert.match(interactiveHtml, /Agent mind map/);
    assert.match(interactiveHtml, /data-role="walker"/);
    assert.match(interactiveHtml, /\/edit\?view=mindmap(?:&amp;|&)project=project-1/);

    const org = await fetch(`${base}/?view=org`);
    const orgHtml = await org.text();
    assert.equal(org.status, 200);
    assert.match(orgHtml, /Organizational structure/);
    assert.match(orgHtml, /data-agent-card="reviewer"/);
    assert.match(orgHtml, /class="org-link"/);
    assert.match(orgHtml, /\/agents\/reviewer\/edit\?view=org(?:&amp;|&)project=project-1/);

    const orgEdit = await (await fetch(`${base}/agents/reviewer/edit?view=org`)).text();
    assert.match(orgEdit, /name="view" value="org"/);
    assert.match(orgEdit, /Back to org chart/);

    const legacy = await fetch(`${base}/?view=interactive`);
    assert.match(await legacy.text(), /Agent mind map/);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("creates an agent and exposes it through state and the roster", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f));
  try {
    const form = await (await fetch(`${base}/agents/new`)).text();
    const response = await post(base, "/agents", {
      csrf: csrfOf(form),
      ...agentFields({ name: "AppSec Auditor" }),
    });

    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /\/\?created=security-auditor/);
    assert.equal(existsSync(join(f.agentsDir, "security-auditor.md")), true);
    assert.equal(existsSync(aliasPath(f.agentsDir)), true);

    const file = readFileSync(join(f.agentsDir, "security-auditor.md"), "utf8");
    assert.match(file, /description: "Reviews code for security issues"/);
    assert.match(file, /mode: subagent/);

    const state = await (await fetch(`${base}/api/state`)).json();
    const desk = state.desks.find((entry: { id: string }) => entry.id === "security-auditor");
    assert.equal(desk.name, "AppSec Auditor");
    assert.equal(desk.editable, true);
    assert.equal(state.summary.total, 3);

    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /AppSec Auditor/);
    assert.match(page, /href="\/agents\/security-auditor\/edit\?view=org(?:&amp;|&)project=project-1"/);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("saves edits, updates the alias and preserves permissions", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f));
  try {
    const edit = await (await fetch(`${base}/agents/reviewer/edit`)).text();
    const response = await post(base, "/agents/reviewer", {
      csrf: csrfOf(edit),
      hash: hashOf(edit),
      name: "Code Reviewer",
      description: "Reviews correctness and security",
      mode: "primary",
      model: "",
      color: "accent",
      body: "Updated review instructions.\n",
    });

    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /\/\?saved=reviewer/);

    const file = readFileSync(join(f.agentsDir, "reviewer.md"), "utf8");
    assert.match(file, /description: "Reviews correctness and security"/);
    assert.match(file, /mode: primary/);
    assert.match(file, /color: "accent"/);
    assert.match(file, /permissions:\n  - action: "\*"/);
    assert.match(file, /Updated review instructions\./);

    const aliases = JSON.parse(readFileSync(aliasPath(f.agentsDir), "utf8"));
    assert.equal(aliases.agents.reviewer.name, "Code Reviewer");

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.desks.find((entry: { id: string }) => entry.id === "reviewer").name, "Code Reviewer");
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("switches projects and summarises every project", async () => {
  const f = fixture();
  const other = join(f.dir, "other-project");
  const otherAgents = join(other, ".opencode", "agents");
  mkdirSync(otherAgents, { recursive: true });
  writeFileSync(
    join(otherAgents, "designer.md"),
    `---\ndescription: Designs interface screens\nmode: subagent\n---\n\nDesign clear screens.\n`,
  );
  const db = new DatabaseSync(f.databasePath);
  db.prepare("insert into project values (?, ?, ?, ?, ?)").run(
    "project-2",
    "OtherProject",
    other,
    Date.now() - 5000,
    null,
  );
  db.close();

  const { monitor, base } = await start(configFor(f));
  try {
    const page = await (await fetch(`${base}/?view=projects`)).text();
    assert.match(page, /All projects/);
    assert.match(page, /data-project-card="project-1"/);
    assert.match(page, /data-project-card="project-2"/);
    assert.match(page, /Open org chart/);
    assert.match(page, /<select id="project-select"/);

    const overview = await (await fetch(`${base}/api/projects`)).json() as {
      projects: Array<{ id: string; total: number }>;
      totals: { projects: number; total: number };
    };
    assert.equal(overview.totals.projects, 2);
    assert.equal(overview.totals.total, 4);
    assert.equal(overview.projects.find((project) => project.id === "project-2")?.total, 2);

    const otherPage = await (await fetch(`${base}/?view=org&project=project-2`)).text();
    assert.match(otherPage, /OtherProject/);
    assert.match(otherPage, /data-agent-card="designer"/);
    assert.match(otherPage, /value="project-2" selected/);
    assert.match(otherPage, /\/agents\/designer\/edit\?view=org(?:&amp;|&)project=project-2/);
    assert.match(otherPage, /var projectId = "project-2"/);
    assert.match(otherPage, /new EventSource\(liveUrl\)/);

    const otherState = await (await fetch(`${base}/api/state?project=project-2`)).json() as {
      project: { id: string };
    };
    assert.equal(otherState.project.id, "project-2");

    const edit = await (await fetch(`${base}/agents/designer/edit?project=project-2&view=org`)).text();
    assert.match(edit, /name="project" value="project-2"/);
    assert.match(edit, /Designs interface screens/);

    const response = await post(base, "/agents/designer", {
      csrf: csrfOf(edit),
      hash: hashOf(edit),
      project: "project-2",
      view: "org",
      description: "Designs interface screens and states",
      mode: "subagent",
      body: "Design clear screens.",
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /project=project-2/);
    assert.match(readFileSync(join(otherAgents, "designer.md"), "utf8"), /and states/);
    assert.doesNotMatch(readFileSync(join(f.agentsDir, "reviewer.md"), "utf8"), /and states/);

    const unknown = await fetch(`${base}/?view=org&project=missing-project`);
    assert.equal(unknown.status, 200);
    assert.match(await unknown.text(), /No OpenCode project matches/);
    assert.equal((await fetch(`${base}/agents/reviewer/edit?project=missing-project`)).status, 404);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("keeps the mind map view through editing and saving", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f));
  try {
    const edit = await (await fetch(`${base}/agents/reviewer/edit?view=mindmap`)).text();
    assert.match(edit, /name="view" value="mindmap"/);
    assert.match(edit, /Back to mind map/);

    const response = await post(base, "/agents/reviewer", {
      csrf: csrfOf(edit),
      hash: hashOf(edit),
      view: "mindmap",
      name: "Reviewer",
      description: "Updated from the office",
      mode: "subagent",
      model: "",
      color: "",
      body: "Review carefully.\n",
    });

    assert.equal(response.status, 303);
    assert.match(
      response.headers.get("location") ?? "",
      /\/\?view=mindmap&saved=reviewer/,
    );

    const page = await (await fetch(`${base}/?view=mindmap&saved=reviewer`)).text();
    assert.match(page, /Agent mind map/);
    assert.match(page, /Agent &quot;reviewer&quot; was saved/);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rejects a stale edit with 409", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f));
  try {
    const edit = await (await fetch(`${base}/agents/reviewer/edit`)).text();
    const fields = {
      csrf: csrfOf(edit),
      hash: hashOf(edit),
      name: "Reviewer",
      description: "First edit",
      mode: "subagent",
      model: "",
      color: "",
      body: "First.\n",
    };
    assert.equal((await post(base, "/agents/reviewer", fields)).status, 303);

    const stale = await post(base, "/agents/reviewer", { ...fields, description: "Second edit" });
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /Reload/);
    assert.match(readFileSync(join(f.agentsDir, "reviewer.md"), "utf8"), /First edit/);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("returns validation errors without writing a file", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f));
  try {
    const form = await (await fetch(`${base}/agents/new`)).text();
    const response = await post(base, "/agents", {
      csrf: csrfOf(form),
      ...agentFields({ description: "" }),
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /Description is required/);
    assert.equal(existsSync(join(f.agentsDir, "security-auditor.md")), false);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rejects missing CSRF tokens and cross-origin posts", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f));
  try {
    const noToken = await post(base, "/agents", agentFields());
    assert.equal(noToken.status, 403);

    const form = await (await fetch(`${base}/agents/new`)).text();
    const crossOrigin = await post(base, "/agents", { csrf: csrfOf(form), ...agentFields() }, {
      origin: "http://evil.example",
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(existsSync(join(f.agentsDir, "security-auditor.md")), false);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("accepts a loopback origin spelled differently from the Host header", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f));
  try {
    const form = await (await fetch(`${base}/agents/new`)).text();
    const port = new URL(base).port;
    const body = new URLSearchParams({
      csrf: csrfOf(form),
      ...agentFields({ name: "Alias Auditor" }),
    }).toString();

    // Simulates a browser or proxy that reports localhost while the page origin is 127.0.0.1.
    const response = await rawPost(port, "/agents", body, {
      origin: base,
      host: `localhost:${port}`,
    });

    assert.equal(response.status, 303);
    assert.equal(existsSync(join(f.agentsDir, "security-auditor.md")), true);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("refuses editing in read-only mode", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f, { readOnly: true }));
  try {
    const create = await fetch(`${base}/agents/new`);
    assert.equal(create.status, 403);
    assert.match(await create.text(), /read-only mode/);

    const edit = await fetch(`${base}/agents/reviewer/edit`);
    assert.equal(edit.status, 403);

    const page = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(page, /New agent/);
    assert.doesNotMatch(page, /href="\/agents\/reviewer\/edit"/);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rejects unsafe agent ids and unsupported methods", async () => {
  const f = fixture();
  const { monitor, base } = await start(configFor(f));
  try {
    const traversal = await fetch(`${base}/agents/..%2Fescape/edit`);
    assert.equal(traversal.status, 400);

    const method = await fetch(`${base}/agents`, { method: "PUT" });
    assert.equal(method.status, 405);
    assert.match(method.headers.get("allow") ?? "", /POST/);

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.editing, true);
  } finally {
    await monitor.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});


