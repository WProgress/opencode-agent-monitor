import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AgentFileError,
  agentsFingerprint,
  createAgentFile,
  loadRoster,
  readAgentFile,
  saveAgentFile,
  type AgentDefinition,
  type AgentDraft,
} from "./agents.ts";
import { isLoopbackHost, loadConfig, type Config } from "./config.ts";
import {
  listProjects,
  normalizePath,
  openDatabase,
  projectById,
  readSessions,
  readTodos,
  resolveProject,
  type Database,
  type ProjectRow,
} from "./db.ts";
import {
  renderAgentForm,
  renderPage,
  renderStatusPage,
  type ProjectOption,
  type ViewName,
} from "./render.ts";
import { renderInteractivePage } from "./interactive.ts";
import { renderOrgPage } from "./org.ts";
import { renderProjectsPage } from "./projects.ts";
import { buildOverview, overviewProject, type Overview } from "./overview.ts";
import { buildSnapshot, emptySnapshot, type Snapshot } from "./state.ts";

const MAX_FORM_BYTES = 512 * 1024;
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="8" fill="#def0ec"/>
<rect x="7" y="9" width="18" height="12" rx="2" fill="#0f766e"/>
<rect x="13" y="24" width="6" height="2" fill="#0f766e"/>
<rect x="9" y="26" width="14" height="2" rx="1" fill="#0f766e"/>
</svg>`;

const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "interest-cohort=()",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** `interactive` is kept as a legacy alias for the renamed Mind map view. */
function viewOf(value: string | null): ViewName {
  if (value === "interactive" || value === "mindmap") return "mindmap";
  if (value === "desks") return "desks";
  if (value === "projects" || value === "all-projects") return "projects";
  return "org";
}

function formView(value: string | null): "mindmap" | "org" | "desks" | undefined {
  if (!value) return undefined;
  const view = viewOf(value);
  return view === "projects" ? "org" : view;
}

function projectName(project: ProjectRow): string {
  const folder =
    (project.worktree ?? "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? "";
  return (project.name ?? "").trim() || folder || "project";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface Monitor {
  server: Server;
  refresh: () => void;
  close: () => Promise<void>;
  snapshot: () => Snapshot;
  editingEnabled: boolean;
}

export function createMonitor(config: Config): Monitor {
  const csrfToken = randomBytes(32).toString("hex");
  const editingEnabled = !config.readOnly && isLoopbackHost(config.host);
  const rosters = new Map<string, { hash: string; roster: AgentDefinition[] }>();
  let connection: Database | null = null;
  let databaseError: string | null = null;
  const clients = new Map<ServerResponse, string>();
  let overviewCache: { at: number; value: Overview } | null = null;

  function ensureDatabase(): Database | null {
    if (connection) return connection;
    try {
      connection = openDatabase(config.databasePath);
      databaseError = null;
    } catch (error) {
      databaseError = errorText(error);
    }
    return connection;
  }

  function resetDatabase(): void {
    try {
      connection?.db.close();
    } catch {
      // The connection may already be closed; nothing else to do.
    }
    connection = null;
    overviewCache = null;
  }

  function rosterFor(directory: string, force = false): { hash: string; roster: AgentDefinition[] } {
    const hash = agentsFingerprint(directory);
    const cached = rosters.get(directory);
    if (cached && !force && cached.hash === hash) return cached;
    const entry = { hash, roster: loadRoster(directory) };
    rosters.set(directory, entry);
    return entry;
  }

  /** The configured project may use --agents; every other project uses its own folder. */
  function agentsDirFor(project: ProjectRow): string {
    if (project.worktree && normalizePath(project.worktree) === normalizePath(config.projectPath)) {
      return config.agentsDir;
    }
    if (!project.worktree) return config.agentsDir;
    return join(project.worktree, ".opencode", "agents");
  }

  /** Project rows can repeat a worktree after a rename; keep the most recent one. */
  function availableProjects(): ProjectRow[] {
    const database = ensureDatabase();
    if (!database) return [];
    try {
      const byPath = new Map<string, ProjectRow>();
      for (const project of listProjects(database)) {
        if (project.timeArchived) continue;
        // OpenCode's synthetic global project is not a real workspace.
        if (project.id === "global") continue;
        const key = project.worktree ? normalizePath(project.worktree) : `id:${project.id}`;
        const existing = byPath.get(key);
        if (!existing || (project.timeActive ?? 0) > (existing.timeActive ?? 0)) {
          byPath.set(key, project);
        }
      }
      return [...byPath.values()].sort(
        (left, right) =>
          (right.timeActive ?? 0) - (left.timeActive ?? 0) ||
          projectName(left).localeCompare(projectName(right), undefined, { sensitivity: "base" }),
      );
    } catch (error) {
      resetDatabase();
      databaseError = errorText(error);
      return [];
    }
  }

  function projectOptions(): ProjectOption[] {
    return availableProjects().map((project) => ({
      id: project.id,
      name: projectName(project),
      path: project.worktree ?? "",
    }));
  }

  function resolveSelector(database: Database, selector: string): ProjectRow | null {
    const byId = projectById(database, selector);
    if (byId && !byId.timeArchived) return byId;
    return resolveProject(database, selector);
  }

  function collectFor(selector: string): Snapshot {
    const database = ensureDatabase();
    if (!database) {
      return emptySnapshot(Date.now(), databaseError ?? "OpenCode database is unavailable");
    }

    let project: ProjectRow | null;
    try {
      project = resolveSelector(database, selector);
    } catch (error) {
      resetDatabase();
      return emptySnapshot(Date.now(), errorText(error));
    }

    if (!project) {
      const known = availableProjects()
        .map((entry) => entry.worktree)
        .filter((path): path is string => Boolean(path))
        .slice(0, 8);
      return emptySnapshot(
        Date.now(),
        `No OpenCode project matches ${selector}.` +
          (known.length > 0 ? ` Known projects: ${known.join(", ")}.` : ""),
      );
    }

    try {
      const now = Date.now();
      const agentsDir = agentsDirFor(project);
      const roster = rosterFor(agentsDir);
      const sessions = readSessions(database, project.id);
      const todos = readTodos(database, sessions.map((session) => session.id));
      return buildSnapshot({
        now,
        project,
        sessions,
        todos,
        roster: roster.roster,
        staleMs: config.staleMs,
        hasBusySignal: database.columns.has("time_busy"),
        rosterHash: roster.hash,
      });
    } catch (error) {
      resetDatabase();
      return emptySnapshot(Date.now(), errorText(error));
    }
  }

  function collectOverview(): Overview {
    const now = Date.now();
    if (overviewCache && now - overviewCache.at < 1500) return overviewCache.value;

    const database = ensureDatabase();
    if (!database) {
      const empty = buildOverview([], now);
      empty.error = databaseError ?? "OpenCode database is unavailable";
      overviewCache = { at: now, value: empty };
      return empty;
    }

    const entries = availableProjects().map((project) => {
      const snapshot = collectFor(project.id);
      return overviewProject(snapshot, {
        id: project.id,
        name: projectName(project),
        path: project.worktree ?? "",
      });
    });
    const value = buildOverview(entries, now);
    overviewCache = { at: now, value };
    return value;
  }

  let snapshot: Snapshot = collectFor(config.projectPath);

  function broadcast(): void {
    if (clients.size === 0) return;
    const built = new Map<string, Snapshot>([[config.projectPath, snapshot]]);
    for (const [client, selector] of clients) {
      try {
        let payload = built.get(selector);
        if (!payload) {
          payload = collectFor(selector);
          built.set(selector, payload);
        }
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  }

  function refresh(): void {
    try {
      snapshot = collectFor(config.projectPath);
    } catch (error) {
      snapshot = emptySnapshot(Date.now(), errorText(error));
    }
    overviewCache = null;
    broadcast();
  }

  const refreshTimer = setInterval(refresh, config.refreshMs);
  refreshTimer.unref();

  const heartbeatTimer = setInterval(() => {
    for (const client of [...clients.keys()]) {
      try {
        client.write(": ping\n\n");
      } catch {
        clients.delete(client);
      }
    }
  }, 25_000);
  heartbeatTimer.unref();

  function send(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    type: string,
    body: string,
    extra: Record<string, string> = {},
  ): void {
    response.writeHead(status, {
      ...BASE_HEADERS,
      "content-type": type,
      "cache-control": "no-store",
      ...extra,
    });
    response.end(request.method === "HEAD" ? undefined : body);
  }

  function json(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    value: unknown,
  ): void {
    send(request, response, status, "application/json; charset=utf-8", JSON.stringify(value, null, 2));
  }

  function redirect(response: ServerResponse, location: string): void {
    response.writeHead(303, {
      ...BASE_HEADERS,
      location,
      "cache-control": "no-store",
    });
    response.end();
  }

  function html(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: string,
  ): void {
    send(request, response, status, "text/html; charset=utf-8", body);
  }

  function statusPage(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    title: string,
    message: string,
  ): void {
    html(request, response, status, renderStatusPage(title, message));
  }

  function requestPath(request: IncomingMessage): string {
    const url = new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
    return url.pathname;
  }

  function readForm(request: IncomingMessage): Promise<URLSearchParams> {
    return new Promise((resolvePromise, reject) => {
      const type = String(request.headers["content-type"] ?? "").toLowerCase();
      if (!type.startsWith("application/x-www-form-urlencoded")) {
        reject(new HttpError(415, "Expected an application/x-www-form-urlencoded form."));
        return;
      }

      let size = 0;
      let tooLarge = false;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX_FORM_BYTES) {
          tooLarge = true;
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (tooLarge) {
          reject(new HttpError(413, "The form submission is too large."));
          return;
        }
        resolvePromise(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      });
      request.on("error", reject);
    });
  }

  function sameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;

    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      // Browsers can send an opaque "null" origin; the CSRF token still guards the form.
      return true;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;

    const host = request.headers.host?.toLowerCase();
    if (host && url.host.toLowerCase() === host) return true;

    // A loopback page may be reached as localhost, 127.0.0.1, [::1] or through
    // a local port-forward. The CSRF token remains the primary protection.
    return isLoopbackHost(url.hostname) && isLoopbackHost(config.host);
  }

  function validCsrf(value: string | null): boolean {
    const expected = Buffer.from(csrfToken, "utf8");
    const actual = Buffer.from(value ?? "", "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function draftFrom(form: URLSearchParams, id: string): AgentDraft {
    return {
      id,
      name: form.get("name") ?? "",
      description: form.get("description") ?? "",
      mode: form.get("mode") ?? "",
      model: form.get("model") ?? "",
      color: form.get("color") ?? "",
      body: form.get("body") ?? "",
    };
  }

  function formPage(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    options: {
      mode: "create" | "edit";
      draft: AgentDraft;
      hash: string;
      errors: string[];
      notice?: string;
      view?: ViewName;
      projectId?: string;
      projectName?: string;
    },
  ): void {
    html(
      request,
      response,
      status,
      renderAgentForm({
        ...options,
        csrf: csrfToken,
      }),
    );
  }

  function requireEditing(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    if (editingEnabled) return true;
    statusPage(
      request,
      response,
      403,
      "Editing is disabled",
      config.readOnly
        ? "Agent Monitor was started in read-only mode. Remove --read-only or set MONITOR_READ_ONLY=0 to edit agents."
        : `Agent editing is only available on loopback hosts. The server is bound to ${config.host}.`,
    );
    return false;
  }

  function handleGet(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
    const path = url.pathname;

    if (path === "/") {
      const saved = url.searchParams.get("saved");
      const created = url.searchParams.get("created");
      const notice = created
        ? `Agent "${created}" was created.`
        : saved
          ? `Agent "${saved}" was saved.`
          : undefined;
      const view = viewOf(url.searchParams.get("view"));
      const projects = projectOptions();
      const baseMeta = {
        databasePath: config.databasePath,
        staleMinutes: Math.round(config.staleMs / 60_000),
        editing: editingEnabled,
        notice,
        projects,
      };

      if (view === "projects") {
        html(request, response, 200, renderProjectsPage(collectOverview(), baseMeta));
        return;
      }

      const selector = url.searchParams.get("project") || config.projectPath;
      const page = collectFor(selector);
      const activeProjectId =
        page.project.id || projects.find((project) => project.id === selector)?.id;
      const meta = { ...baseMeta, activeProjectId };
      html(
        request,
        response,
        200,
        view === "mindmap"
          ? renderInteractivePage(page, meta)
          : view === "desks"
            ? renderPage(page, meta)
            : renderOrgPage(page, meta),
      );
      return;
    }

    if (path === "/api/state") {
      const selector = url.searchParams.get("project") || config.projectPath;
      json(request, response, 200, collectFor(selector));
      return;
    }

    if (path === "/api/projects") {
      json(request, response, 200, collectOverview());
      return;
    }

    if (path === "/health") {
      const healthy = snapshot.error == null;
      json(request, response, healthy ? 200 : 503, {
        status: healthy ? "ok" : "degraded",
        database: healthy ? "ok" : "unavailable",
        error: snapshot.error,
        project: { name: snapshot.project.name, path: snapshot.project.path },
        desks: snapshot.summary.total,
        working: snapshot.summary.working,
        editing: editingEnabled,
        updatedAt: new Date(snapshot.generatedAt).toISOString(),
        source: config.databasePath,
      });
      return;
    }

    if (path === "/events") {
      const selector = url.searchParams.get("project") || config.projectPath;
      response.writeHead(200, {
        ...BASE_HEADERS,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const initial = selector === config.projectPath ? snapshot : collectFor(selector);
      response.write("retry: 3000\n\n");
      response.write(`data: ${JSON.stringify(initial)}\n\n`);
      clients.set(response, selector);
      const drop = () => clients.delete(response);
      request.on("close", drop);
      request.on("error", drop);
      return;
    }

    if (path === "/favicon.svg" || path === "/favicon.ico") {
      send(request, response, 200, "image/svg+xml", FAVICON);
      return;
    }

    if (path === "/agents/new") {
      if (!requireEditing(request, response)) return;
      const selector = url.searchParams.get("project") || config.projectPath;
      const database = ensureDatabase();
      if (!database) {
        statusPage(request, response, 503, "Database unavailable", databaseError ?? "OpenCode database is unavailable.");
        return;
      }
      const project = resolveSelector(database, selector);
      if (!project) {
        statusPage(request, response, 404, "Unknown project", `No OpenCode project matches "${selector}".`);
        return;
      }
      const id = (url.searchParams.get("id") ?? "").trim().toLowerCase();
      formPage(request, response, 200, {
        mode: "create",
        draft: {
          id: /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) ? id : "",
          name: "",
          description: "",
          mode: "subagent",
          model: "",
          color: "",
          body: "",
        },
        hash: "",
        errors: [],
        view: formView(url.searchParams.get("view")),
        projectId: project.id,
        projectName: projectName(project),
      });
      return;
    }

    const editMatch = /^\/agents\/([^/]+)\/edit$/.exec(path);
    if (editMatch) {
      if (!requireEditing(request, response)) return;
      let id: string;
      try {
        id = decodeURIComponent(editMatch[1]);
      } catch {
        statusPage(request, response, 400, "Invalid agent", "The agent id could not be decoded.");
        return;
      }
      const selector = url.searchParams.get("project") || config.projectPath;
      const database = ensureDatabase();
      if (!database) {
        statusPage(request, response, 503, "Database unavailable", databaseError ?? "OpenCode database is unavailable.");
        return;
      }
      const project = resolveSelector(database, selector);
      if (!project) {
        statusPage(request, response, 404, "Unknown project", `No OpenCode project matches "${selector}".`);
        return;
      }
      try {
        const file = readAgentFile(agentsDirFor(project), id);
        if (!file) {
          statusPage(request, response, 404, "Agent not found", `No agent file exists for "${id}" in ${projectName(project)}.`);
          return;
        }
        formPage(request, response, 200, {
          mode: "edit",
          draft: {
            id: file.id,
            name: file.name,
            description: file.description,
            mode: file.mode,
            model: file.model,
            color: file.color,
            body: file.body,
          },
          hash: file.hash,
          errors: [],
          notice: url.searchParams.get("saved") ? "Your changes were saved." : undefined,
          view: formView(url.searchParams.get("view")),
          projectId: project.id,
          projectName: projectName(project),
        });
      } catch (error) {
        const status = error instanceof AgentFileError ? error.status : 500;
        statusPage(request, response, status, "Cannot edit agent", errorText(error));
      }
      return;
    }

    send(request, response, 404, "text/plain; charset=utf-8", "Not found\n");
  }

  async function handlePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = requestPath(request);
    if (!path.startsWith("/agents")) {
      send(request, response, 404, "text/plain; charset=utf-8", "Not found\n");
      return;
    }
    if (!requireEditing(request, response)) return;
    if (!sameOrigin(request)) {
      console.warn(
        `Rejected form from origin ${request.headers.origin ?? "(none)"} ` +
          `(host ${request.headers.host ?? "(none)"}).`,
      );
      statusPage(request, response, 403, "Request rejected", "Cross-origin form submissions are not allowed.");
      return;
    }

    let form: URLSearchParams;
    try {
      form = await readForm(request);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      statusPage(request, response, status, "Cannot read form", errorText(error));
      return;
    }

    if (!validCsrf(form.get("csrf"))) {
      statusPage(
        request,
        response,
        403,
        "Request rejected",
        "The form token is missing or expired. Reload the page and try again.",
      );
      return;
    }

    const view = formView(form.get("view"));
    const selector = (form.get("project") ?? "").trim() || config.projectPath;
    const database = ensureDatabase();
    if (!database) {
      statusPage(request, response, 503, "Database unavailable", databaseError ?? "OpenCode database is unavailable.");
      return;
    }
    const project = resolveSelector(database, selector);
    if (!project) {
      statusPage(request, response, 404, "Unknown project", `No OpenCode project matches "${selector}".`);
      return;
    }
    const agentsDir = agentsDirFor(project);
    const projectId = project.id;

    if (path === "/agents") {
      const draft = draftFrom(form, (form.get("id") ?? "").trim());
      try {
        const created = createAgentFile(agentsDir, draft);
        rosterFor(agentsDir, true);
        refresh();
        console.log(`Agent created: ${created.id}`);
        redirect(
          response,
          view
            ? `/?view=${view}&created=${encodeURIComponent(created.id)}&project=${encodeURIComponent(projectId)}`
            : `/?created=${encodeURIComponent(created.id)}&project=${encodeURIComponent(projectId)}`,
        );
      } catch (error) {
        const status = error instanceof AgentFileError ? error.status : 500;
        formPage(request, response, status, {
          mode: "create",
          draft,
          hash: "",
          errors: [errorText(error)],
          view,
          projectId,
          projectName: projectName(project),
        });
      }
      return;
    }

    const saveMatch = /^\/agents\/([^/]+)$/.exec(path);
    if (!saveMatch) {
      send(request, response, 404, "text/plain; charset=utf-8", "Not found\n");
      return;
    }

    let id: string;
    try {
      id = decodeURIComponent(saveMatch[1]);
    } catch {
      statusPage(request, response, 400, "Invalid agent", "The agent id could not be decoded.");
      return;
    }

    const draft = draftFrom(form, id);
    const expectedHash = form.get("hash") ?? undefined;
    try {
      const saved = saveAgentFile(agentsDir, id, draft, expectedHash);
      rosterFor(agentsDir, true);
      refresh();
      console.log(`Agent updated: ${saved.id}`);
      redirect(
        response,
        view
          ? `/?view=${view}&saved=${encodeURIComponent(saved.id)}&project=${encodeURIComponent(projectId)}`
          : `/?saved=${encodeURIComponent(saved.id)}&project=${encodeURIComponent(projectId)}`,
      );
    } catch (error) {
      const status = error instanceof AgentFileError ? error.status : 500;
      if (status === 404) {
        statusPage(request, response, 404, "Agent not found", errorText(error));
        return;
      }
      formPage(request, response, status, {
        mode: "edit",
        draft,
        hash: expectedHash ?? "",
        errors: [errorText(error)],
        view,
        projectId,
        projectName: projectName(project),
      });
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" || request.method === "HEAD") {
      handleGet(request, response);
      return;
    }
    if (request.method === "POST") {
      await handlePost(request, response);
      return;
    }
    send(request, response, 405, "text/plain; charset=utf-8", "Method not allowed\n", {
      allow: "GET, HEAD, POST",
    });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error(`Request failed: ${errorText(error)}`);
      if (!response.headersSent) {
        statusPage(request, response, 500, "Server error", errorText(error));
      } else {
        response.end();
      }
    });
  });

  async function close(): Promise<void> {
    clearInterval(refreshTimer);
    clearInterval(heartbeatTimer);
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // The client may already be gone.
      }
    }
    clients.clear();
    if (server.listening) {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    }
    try {
      connection?.db.close();
    } catch {
      // Nothing to close.
    }
    connection = null;
  }

  return {
    server,
    refresh,
    close,
    snapshot: () => snapshot,
    editingEnabled,
  };
}

export function startMonitor(config: Config = loadConfig()): Monitor {
  const monitor = createMonitor(config);
  const { server } = monitor;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${config.port} is already in use. Stop the other monitor or pass --port=<number>.`,
      );
    } else {
      console.error(`Monitor failed to start: ${error.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    const current = monitor.snapshot();
    const roster = loadRoster(config.agentsDir);
    console.log(`Agent Monitor — ${current.project.name}`);
    console.log(`  URL      http://${config.host}:${config.port}`);
    console.log(`  Project  ${config.projectPath}`);
    console.log(`  Database ${config.databasePath} (read-only)`);
    console.log(`  Agents   ${config.agentsDir} (${monitor.editingEnabled ? "editing" : "read-only"})`);
    console.log(`  Roster   ${roster.map((agent) => agent.name).join(", ")}`);
    if (current.error) console.warn(`  Warning  ${current.error}`);
  });

  function shutdown(): void {
    monitor
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return monitor;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  startMonitor();
}
