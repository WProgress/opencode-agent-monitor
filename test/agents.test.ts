import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentFileError,
  agentsFingerprint,
  aliasPath,
  composeAgentContent,
  createAgentFile,
  loadRoster,
  parseAgentFile,
  patchFrontmatter,
  readAgentFile,
  saveAgentFile,
  validateDraft,
  type AgentDraft,
} from "../src/agents.ts";

const SAMPLE = `---
description: Reviews code for quality
mode: subagent
color: "#b3ff00"
permissions:
  - action: "*"
    resource: "*"
    effect: allow
---

You are a code reviewer.
`;

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `agent-monitor-${name}-`));
}

function draft(overrides: Partial<AgentDraft> = {}): AgentDraft {
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

test("parses the full agent file, including body and color", () => {
  const file = parseAgentFile("review.md", SAMPLE);

  assert.equal(file.id, "review");
  assert.equal(file.name, "Review");
  assert.equal(file.description, "Reviews code for quality");
  assert.equal(file.mode, "subagent");
  assert.equal(file.color, "#b3ff00");
  assert.equal(file.tone, "#b3ff00");
  assert.equal(file.body, "\nYou are a code reviewer.\n");
  assert.equal(file.hash.length, 64);
});

test("patches only named keys and preserves unknown blocks and the body", () => {
  const patched = patchFrontmatter(SAMPLE, {
    description: 'Uses "quotes": and #hash',
    mode: "primary",
    model: "openai/gpt-6.1-sol#medium",
  });

  assert.match(patched, /permissions:\n  - action: "\*"\n    resource: "\*"\n    effect: allow/);
  assert.match(patched, /You are a code reviewer\.\n$/);
  assert.match(patched, /mode: primary/);
  assert.match(patched, /description: "Uses \\"quotes\\": and #hash"/);

  const parsed = parseAgentFile("review.md", patched);
  assert.equal(parsed.description, 'Uses "quotes": and #hash');
  assert.equal(parsed.mode, "primary");
  assert.equal(parsed.model, "openai/gpt-6.1-sol#medium");
});

test("preserves a UTF-8 BOM when patching a file", () => {
  const content = `\uFEFF${SAMPLE}`;
  const patched = patchFrontmatter(content, { description: "BOM-safe" });

  assert.equal(patched.startsWith("\uFEFF---"), true);
  assert.match(patched, /description: "BOM-safe"/);
  assert.match(patched, /You are a code reviewer\./);
});

test("removes optional keys when their values are cleared", () => {
  const patched = patchFrontmatter(SAMPLE, { color: null, mode: null });

  assert.doesNotMatch(patched, /^color:/m);
  assert.doesNotMatch(patched, /^mode:/m);
  assert.match(patched, /permissions:/);
});

test("composeAgentContent keeps CRLF line endings and preserves nested blocks", () => {
  const crlf = SAMPLE.replace(/\n/g, "\r\n");
  const content = composeAgentContent(
    crlf,
    draft({
      description: "Updated reviewer",
      mode: "subagent",
      body: "New instructions.\nSecond line.\n",
    }),
  );

  const withoutCrlf = content.replace(/\r\n/g, "");
  assert.equal(withoutCrlf.includes("\n"), false);
  assert.match(content, /permissions:\r\n  - action: "\*"\r\n/);
  assert.match(content, /New instructions\.\r\nSecond line\.\r\n$/);
});

test("creates an agent file, alias and a valid roster entry", () => {
  const dir = tempDir("create");
  try {
    const created = createAgentFile(dir, draft({ name: "AppSec Auditor" }));
    assert.equal(created.id, "security-auditor");
    assert.equal(created.name, "AppSec Auditor");

    const file = readFileSync(join(dir, "security-auditor.md"), "utf8");
    assert.match(file, /^---\n/);
    assert.match(file, /description: "Reviews code for security issues"/);
    assert.match(file, /mode: subagent/);
    assert.match(file, /color: "#ff6b6b"/);
    assert.match(file, /You are a security reviewer\./);

    const aliases = JSON.parse(readFileSync(aliasPath(dir), "utf8"));
    assert.equal(aliases.agents["security-auditor"].name, "AppSec Auditor");

    const roster = loadRoster(dir);
    assert.equal(roster.find((agent) => agent.id === "security-auditor")?.name, "AppSec Auditor");
    assert.equal(roster.find((agent) => agent.id === "security-auditor")?.fileBacked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses duplicate and unsafe agent ids", () => {
  const dir = tempDir("duplicate");
  try {
    createAgentFile(dir, draft());
    assert.throws(() => createAgentFile(dir, draft()), (error: unknown) =>
      error instanceof AgentFileError && error.status === 409,
    );
    assert.throws(() => createAgentFile(dir, draft({ id: "../escape" })), AgentFileError);
    assert.throws(() => readAgentFile(dir, "../escape"), AgentFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saves an agent, writes a backup and updates the alias", () => {
  const dir = tempDir("save");
  try {
    const created = createAgentFile(dir, draft());
    const saved = saveAgentFile(
      dir,
      "security-auditor",
      draft({ name: "AppSec Auditor", description: "Updated role" }),
      created.hash,
    );

    assert.equal(saved.name, "AppSec Auditor");
    assert.equal(saved.description, "Updated role");

    const backups = readdirSync(join(dir, ".agent-monitor-backups"));
    assert.equal(backups.filter((entry) => entry.endsWith(".md.bak")).length, 1);
    assert.equal(loadRoster(dir).find((agent) => agent.id === "security-auditor")?.name, "AppSec Auditor");

    const aliases = JSON.parse(readFileSync(aliasPath(dir), "utf8"));
    assert.equal(aliases.agents["security-auditor"].name, "AppSec Auditor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a stale save without touching the file", () => {
  const dir = tempDir("stale");
  try {
    const created = createAgentFile(dir, draft());
    saveAgentFile(dir, "security-auditor", draft({ description: "First save" }), created.hash);

    const before = readFileSync(join(dir, "security-auditor.md"), "utf8");
    assert.throws(
      () => saveAgentFile(dir, "security-auditor", draft({ description: "Second save" }), created.hash),
      (error: unknown) => error instanceof AgentFileError && error.status === 409,
    );
    assert.equal(readFileSync(join(dir, "security-auditor.md"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validates required fields, modes, colors and sizes", () => {
  assert.deepEqual(validateDraft(draft()), []);
  assert.match(validateDraft(draft({ description: "" })).join(" "), /Description is required/);
  assert.match(validateDraft(draft({ mode: "sometimes" })).join(" "), /Mode must be one of/);
  assert.match(validateDraft(draft({ color: "red" })).join(" "), /Color must be a hex color/);
  assert.match(
    validateDraft({ ...draft(), id: "Bad ID" }, { create: true }).join(" "),
    /Agent id must start/,
  );
});

test("fingerprints change when agent files change", () => {
  const dir = tempDir("fingerprint");
  try {
    const before = agentsFingerprint(dir);
    createAgentFile(dir, draft());
    const after = agentsFingerprint(dir);
    assert.notEqual(before, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("omits mode when the default is selected", () => {
  const dir = tempDir("default-mode");
  try {
    createAgentFile(dir, draft({ mode: "" }));
    const file = readFileSync(join(dir, "security-auditor.md"), "utf8");
    assert.doesNotMatch(file, /^mode:/m);
    assert.equal(loadRoster(dir).find((agent) => agent.id === "security-auditor")?.mode, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores a missing agents directory when loading the roster", () => {
  const roster = loadRoster(join(tmpdir(), "definitely-not-here", "agents"));
  assert.deepEqual(roster.map((agent) => agent.id), ["build"]);
});

test("writes a custom display name without adding a name frontmatter key", () => {
  const dir = tempDir("alias");
  try {
    createAgentFile(dir, draft({ name: "A Friendlier Name" }));
    const file = readFileSync(join(dir, "security-auditor.md"), "utf8");
    assert.doesNotMatch(file, /^name:/m);
    assert.equal(loadRoster(dir).find((agent) => agent.id === "security-auditor")?.name, "A Friendlier Name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not create partially written files when the directory is missing", () => {
  const base = tempDir("create-dir");
  const dir = join(base, "nested", "agents");
  try {
    createAgentFile(dir, draft());
    assert.equal(existsSync(join(dir, "security-auditor.md")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
