import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tone: string;
  mode?: string;
  model?: string;
  color?: string;
  fileBacked?: boolean;
}

export interface AgentFile extends AgentDefinition {
  id: string;
  name: string;
  description: string;
  tone: string;
  mode: string;
  model: string;
  color: string;
  body: string;
  content: string;
  hash: string;
  filePath: string;
  fileBacked: true;
}

export interface AgentDraft {
  id: string;
  name: string;
  description: string;
  mode: string;
  model: string;
  color: string;
  body: string;
}

interface AliasEntry {
  name?: string;
}

interface AliasStore {
  version: number;
  agents: Record<string, AliasEntry>;
}

export class AgentFileError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AgentFileError";
    this.status = status;
  }
}

export const ALIAS_FILE = ".agent-monitor.json";
export const MAX_AGENT_BYTES = 256 * 1024;
export const MAX_ALIAS_BYTES = 64 * 1024;
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const AGENT_MODES = ["primary", "subagent", "all"] as const;

const MODES = new Set<string>(AGENT_MODES);
const THEME_COLORS: Record<string, string> = {
  primary: "#3b6ea5",
  secondary: "#7c5cbf",
  accent: "#c2477f",
  success: "#3f8f63",
  warning: "#c07a2e",
  error: "#b0473f",
  info: "#2c8aa0",
};
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const BACKUP_DIR = ".agent-monitor-backups";
const MAX_BACKUPS = 20;

const TONES: Record<string, string> = {
  build: "#3b6ea5",
  architect: "#7c5cbf",
  designer: "#c2477f",
  reviewer: "#2c8aa0",
  tester: "#3f8f63",
  "victor-black": "#b0473f",
  "sam-miller": "#c07a2e",
};
const FALLBACK_TONES = ["#5b7fa6", "#7a6aa8", "#a26a8f", "#4f8f88", "#8a7a4f", "#8f5f5f"];

export const BUILD_AGENT: AgentDefinition = {
  id: "build",
  name: "Build",
  description: "Primary agent — implements, tests and coordinates the other agents.",
  tone: TONES.build,
  mode: "primary",
  model: "",
  color: "",
  fileBacked: false,
};

export function displayName(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function toneFor(id: string): string {
  if (TONES[id]) return TONES[id];
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return FALLBACK_TONES[Math.abs(hash) % FALLBACK_TONES.length];
}

/** Uses a valid frontmatter color when present, otherwise the deterministic tone. */
export function colorTone(color: string | undefined, id: string): string {
  const value = (color ?? "").trim();
  if (HEX_COLOR.test(value)) return value;
  const theme = THEME_COLORS[value.toLowerCase()];
  if (theme) return theme;
  return toneFor(id);
}

export function defaultDefinition(id: string): AgentDefinition {
  return {
    id,
    name: displayName(id),
    description: "",
    tone: toneFor(id),
    mode: "",
    model: "",
    color: "",
    fileBacked: false,
  };
}

function unquote(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function splitDocument(content: string): {
  bom: string;
  eol: string;
  frontmatter: string | null;
  body: string;
} {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? content.slice(1) : content;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { bom, eol, frontmatter: null, body: text };
  return { bom, eol, frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

function fieldsOf(frontmatter: string | null): Map<string, string> {
  const fields = new Map<string, string>();
  if (!frontmatter) return fields;
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (match) fields.set(match[1].toLowerCase(), unquote(match[2]));
  }
  return fields;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Parses an OpenCode agent markdown file into its full agent data. */
export function parseAgentFile(filename: string, content: string): AgentFile {
  const id = basename(filename, extname(filename)).toLowerCase();
  const { body } = splitDocument(content);
  const fields = fieldsOf(splitDocument(content).frontmatter);
  const color = fields.get("color") ?? "";

  return {
    id,
    name: fields.get("name") || displayName(id),
    description: fields.get("description") ?? "",
    tone: colorTone(color, id),
    mode: fields.get("mode") ?? "",
    model: fields.get("model") ?? "",
    color,
    body,
    content,
    hash: hashContent(content),
    filePath: "",
    fileBacked: true,
  };
}

export function aliasPath(agentsDir: string): string {
  return join(agentsDir, ALIAS_FILE);
}

export function readAliases(agentsDir: string): AliasStore {
  const empty: AliasStore = { version: 1, agents: {} };
  try {
    const raw = readFileSync(aliasPath(agentsDir), "utf8");
    if (raw.length > MAX_ALIAS_BYTES) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return empty;

    const container = parsed as { agents?: unknown };
    const source =
      container.agents && typeof container.agents === "object"
        ? container.agents
        : (parsed as Record<string, unknown>);
    const agents: Record<string, AliasEntry> = {};
    for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
      if (!AGENT_ID_PATTERN.test(id)) continue;
      if (typeof value === "string") {
        const name = value.trim();
        if (name) agents[id] = { name };
      } else if (value && typeof value === "object") {
        const name = (value as { name?: unknown }).name;
        if (typeof name === "string" && name.trim()) agents[id] = { name: name.trim() };
      }
    }
    return { version: 1, agents };
  } catch {
    return empty;
  }
}

function writeAliases(agentsDir: string, store: AliasStore): void {
  mkdirSync(agentsDir, { recursive: true });
  const path = aliasPath(agentsDir);
  if (Object.keys(store.agents).length === 0 && !existsSync(path)) return;
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // A new sidecar keeps the restrictive default mode.
  }
  atomicWrite(path, `${JSON.stringify(store, null, 2)}\n`, mode);
}

function setAlias(agentsDir: string, id: string, name: string): void {
  const store = readAliases(agentsDir);
  const trimmed = name.trim();
  if (trimmed && trimmed !== displayName(id)) store.agents[id] = { name: trimmed };
  else delete store.agents[id];
  writeAliases(agentsDir, store);
}

export function loadRoster(agentsDir: string): AgentDefinition[] {
  const aliases = readAliases(agentsDir);
  const definitions = new Map<string, AgentDefinition>([[BUILD_AGENT.id, { ...BUILD_AGENT }]]);

  try {
    for (const entry of readdirSync(agentsDir)) {
      if (extname(entry).toLowerCase() !== ".md") continue;
      try {
        const file = parseAgentFile(entry, readFileSync(join(agentsDir, entry), "utf8"));
        if (!file.id) continue;
        const alias = aliases.agents[file.id]?.name?.trim();
        definitions.set(file.id, {
          id: file.id,
          name: alias || file.name,
          description: file.description,
          tone: file.tone,
          mode: file.mode,
          model: file.model,
          color: file.color,
          // Files with ids we cannot safely address from a URL stay view-only.
          fileBacked: AGENT_ID_PATTERN.test(file.id) && !file.id.endsWith("."),
        });
      } catch {
        // A malformed or unreadable agent file must not break the monitor.
      }
    }
  } catch {
    // Missing agents directory simply means a build-only roster.
  }

  return [...definitions.values()].sort((left, right) => {
    if (left.id === "build") return -1;
    if (right.id === "build") return 1;
    return left.name.localeCompare(right.name);
  });
}

export function agentsFingerprint(agentsDir: string): string {
  const parts: string[] = [];
  try {
    for (const entry of readdirSync(agentsDir).sort()) {
      if (extname(entry).toLowerCase() !== ".md" && entry !== ALIAS_FILE) continue;
      try {
        const info = statSync(join(agentsDir, entry));
        parts.push(`${entry}:${info.size}:${Math.trunc(info.mtimeMs)}`);
      } catch {
        // A file that vanished mid-scan is simply skipped.
      }
    }
  } catch {
    // A missing directory has a stable, empty fingerprint.
  }
  return hashContent(parts.join("|"));
}

const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

function agentFilePath(agentsDir: string, id: string): string {
  if (!AGENT_ID_PATTERN.test(id) || id.endsWith(".")) {
    throw new AgentFileError(
      `Invalid agent id "${id}". Use lowercase letters, numbers, dots, dashes or underscores.`,
    );
  }
  if (RESERVED_WINDOWS_NAMES.has(id.split(".")[0])) {
    throw new AgentFileError(`"${id}" is a reserved file name on Windows.`);
  }
  const base = resolve(agentsDir);
  const path = resolve(base, `${id}.md`);
  if (dirname(path) !== base) {
    throw new AgentFileError("Agent path escapes the agents directory.");
  }
  return path;
}

function normalizeEol(value: string, eol: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return eol === "\n" ? normalized : normalized.replace(/\n/g, eol);
}

function bodyOf(content: string): string {
  return splitDocument(content).body;
}

const PLAIN_SCALAR = /^[A-Za-z0-9._/-]+$/;
const RESERVED_SCALARS = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

function formatScalar(key: string, value: string): string {
  if (key === "description" || key === "name" || key === "color") return JSON.stringify(value);
  if (PLAIN_SCALAR.test(value) && !RESERVED_SCALARS.has(value.toLowerCase())) return value;
  return JSON.stringify(value);
}

type FrontmatterUpdates = Record<string, string | null>;

/** Replaces only the named top-level keys, preserving unknown keys and nested blocks. */
export function patchFrontmatter(content: string, updates: FrontmatterUpdates): string {
  const { bom, eol, frontmatter, body } = splitDocument(content);
  const lines = frontmatter == null ? [] : frontmatter.split(/\r?\n/);
  const remaining = new Map(Object.entries(updates));
  const result: string[] = [];

  for (const line of lines) {
    const match = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1].toLowerCase())) {
      const key = match[1].toLowerCase();
      const value = updates[key];
      remaining.delete(key);
      if (value != null && value !== "") result.push(`${match[1]}: ${formatScalar(key, value)}`);
      continue;
    }
    result.push(line);
  }

  const additions: string[] = [];
  for (const [key, value] of remaining) {
    if (value != null && value !== "") additions.push(`${key}: ${formatScalar(key, value)}`);
  }
  if (additions.length > 0) {
    let insertion = result.length;
    for (let index = 0; index < result.length - 1; index += 1) {
      if (/^[A-Za-z0-9_.-]+:/.test(result[index]) && /^[ \t]/.test(result[index + 1])) {
        insertion = index;
        break;
      }
    }
    result.splice(insertion, 0, ...additions);
  }

  return `${bom}---${eol}${result.join(eol)}${eol}---${eol}${body}`;
}

function replaceBody(content: string, body: string): string {
  const { bom, eol } = splitDocument(content);
  const text = bom ? content.slice(1) : content;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return bom + normalizeEol(body, eol);
  return bom + text.slice(0, match[0].length) + normalizeEol(body, eol);
}

export function normalizeDraft(draft: AgentDraft): AgentDraft {
  return {
    id: draft.id.trim().toLowerCase(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    mode: draft.mode.trim().toLowerCase(),
    model: draft.model.trim(),
    color: draft.color.trim(),
    body: draft.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
  };
}

export function validateDraft(
  draft: AgentDraft,
  options: { create?: boolean } = {},
): string[] {
  const errors: string[] = [];
  if (options.create && !AGENT_ID_PATTERN.test(draft.id)) {
    errors.push(
      "Agent id must start with a letter or number and use only lowercase letters, numbers, dots, dashes or underscores.",
    );
  }
  if (draft.name.length > 80) errors.push("Display name must be 80 characters or fewer.");
  if (!draft.description) errors.push("Description is required.");
  else if (draft.description.length > 2000) {
    errors.push("Description must be 2000 characters or fewer.");
  }
  if (draft.mode && !MODES.has(draft.mode)) {
    errors.push(`Mode must be one of: ${AGENT_MODES.join(", ")}.`);
  }
  if (draft.model.length > 200 || /[\r\n]/.test(draft.model)) {
    errors.push("Model must be a single line of 200 characters or fewer.");
  }
  if (draft.color && !HEX_COLOR.test(draft.color) && !THEME_COLORS[draft.color.toLowerCase()]) {
    errors.push("Color must be a hex color (for example #3b82f6) or a theme color name.");
  }
  if (Buffer.byteLength(draft.body, "utf8") > MAX_AGENT_BYTES) {
    errors.push("The system prompt is too large.");
  }
  return errors;
}

export function composeAgentContent(original: string, draft: AgentDraft): string {
  const normalized = normalizeDraft(draft);
  let next = patchFrontmatter(original, {
    description: normalized.description,
    mode: normalized.mode || null,
    model: normalized.model || null,
    color: normalized.color || null,
  });
  if (normalized.body !== bodyOf(original).replace(/\r\n/g, "\n").replace(/\r/g, "\n")) {
    next = replaceBody(next, normalized.body);
  }
  return next;
}

export function readAgentFile(agentsDir: string, id: string): AgentFile | null {
  const path = agentFilePath(agentsDir, id);
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AgentFileError("Agent file is not a regular file.", 400);
  }

  const content = readFileSync(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_AGENT_BYTES) {
    throw new AgentFileError("Agent file is too large to edit.", 400);
  }

  const file = parseAgentFile(`${id}.md`, content);
  const alias = readAliases(agentsDir).agents[id]?.name?.trim();
  return { ...file, name: alias || file.name, filePath: path, fileBacked: true };
}

function atomicWrite(path: string, content: string, mode: number): void {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`,
  );
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode });
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Cleanup is best effort; the original write error matters more.
    }
    throw error;
  }
}

function backupFile(agentsDir: string, id: string, content: string): void {
  const dir = join(agentsDir, BACKUP_DIR);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${id}-${stamp}.md.bak`), content, "utf8");
  try {
    const backups = readdirSync(dir)
      .filter((entry) => entry.toLowerCase().endsWith(".md.bak"))
      .sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))) {
      rmSync(join(dir, stale), { force: true });
    }
  } catch {
    // Retention is best effort; a backup was still written.
  }
}

export function createAgentFile(agentsDir: string, draft: AgentDraft): AgentFile {
  const normalized = normalizeDraft(draft);
  const errors = validateDraft(normalized, { create: true });
  if (errors.length > 0) throw new AgentFileError(errors.join(" "), 400);

  mkdirSync(agentsDir, { recursive: true });
  const path = agentFilePath(agentsDir, normalized.id);
  const content = composeAgentContent("", normalized);
  if (Buffer.byteLength(content, "utf8") > MAX_AGENT_BYTES) {
    throw new AgentFileError("Agent file is too large.", 400);
  }

  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AgentFileError(`An agent named "${normalized.id}" already exists.`, 409);
    }
    throw error;
  }

  setAlias(agentsDir, normalized.id, normalized.name);
  const created = readAgentFile(agentsDir, normalized.id);
  if (!created) throw new AgentFileError("The new agent file could not be read back.", 500);
  return created;
}

export function saveAgentFile(
  agentsDir: string,
  id: string,
  draft: AgentDraft,
  expectedHash: string | undefined,
): AgentFile {
  const normalized = normalizeDraft({ ...draft, id });
  const errors = validateDraft(normalized);
  if (errors.length > 0) throw new AgentFileError(errors.join(" "), 400);

  const path = agentFilePath(agentsDir, id);
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentFileError(`Agent "${id}" no longer exists.`, 404);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AgentFileError("Agent file is not a regular file.", 400);
  }

  const original = readFileSync(path, "utf8");
  if (expectedHash && hashContent(original) !== expectedHash) {
    throw new AgentFileError(
      "This agent file changed on disk since the form was opened. Reload it and try again.",
      409,
    );
  }

  const content = composeAgentContent(original, normalized);
  if (Buffer.byteLength(content, "utf8") > MAX_AGENT_BYTES) {
    throw new AgentFileError("Agent file is too large.", 400);
  }

  backupFile(agentsDir, id, original);
  atomicWrite(path, content, stats.mode & 0o777);
  setAlias(agentsDir, id, normalized.name);

  const saved = readAgentFile(agentsDir, id);
  if (!saved) throw new AgentFileError("The saved agent file could not be read back.", 500);
  return saved;
}
