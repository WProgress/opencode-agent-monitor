import { DatabaseSync } from "node:sqlite";

export interface SessionRow {
  id: string;
  projectId: string | null;
  parentId: string | null;
  agent: string | null;
  title: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
  timeBusy: number | null;
  timeIdle: number | null;
  timeArchived: number | null;
}

export interface TodoRow {
  sessionId: string;
  content: string;
  status: string;
  priority: string | null;
  position: number | null;
}

export interface ProjectRow {
  id: string;
  name: string | null;
  worktree: string | null;
  timeActive: number | null;
  timeArchived: number | null;
}

export interface Database {
  db: DatabaseSync;
  sessionTable: string;
  columns: Set<string>;
}

const SESSION_TABLES = ["session_v2", "session"] as const;

function query(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): any[] {
  return db.prepare(sql).all(...params) as any[];
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name));
}

/** Opens the OpenCode database strictly read-only. */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path, { readOnly: true });
  const fail = (message: string): never => {
    try {
      db.close();
    } catch {
      // The connection failed to close; the original error matters more.
    }
    throw new Error(message);
  };

  let sessionTable: string | undefined;
  for (const candidate of SESSION_TABLES) {
    if (hasTable(db, candidate)) {
      sessionTable = candidate;
      break;
    }
  }
  if (!sessionTable) {
    return fail(
      `No session table found in ${path}. Expected one of: ${SESSION_TABLES.join(", ")}`,
    );
  }

  // The table name comes from a fixed allowlist above, never from user input.
  const columns = new Set<string>(
    query(db, `select name from pragma_table_info('${sessionTable}')`).map((row) =>
      String(row.name),
    ),
  );

  for (const required of ["id", "project_id"]) {
    if (!columns.has(required)) {
      return fail(
        `Session table "${sessionTable}" is missing the required "${required}" column.`,
      );
    }
  }

  return { db, sessionTable, columns };
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set<string>(
    query(db, `select name from pragma_table_info('${table}')`).map((row) => String(row.name)),
  );
}

/** Case-insensitive, slash-normalised path comparison that works on Windows. */
export function normalizePath(input: string): string {
  let value = input.trim().replace(/\\/g, "/");
  value = value.replace(/\/{2,}/g, "/");
  const withoutTrailing = value.replace(/\/+$/, "");
  return (withoutTrailing || value).toLowerCase();
}

export function listProjects(conn: Database): ProjectRow[] {
  const { db } = conn;
  if (!hasTable(db, "project")) return [];

  // Older or newer schemas may not carry every column, so absent ones read as null.
  const columns = tableColumns(db, "project");
  if (!columns.has("id")) return [];
  const field = (name: string, alias: string) =>
    columns.has(name) ? `"${name}" as ${alias}` : `null as ${alias}`;
  const select = [
    field("id", "id"),
    field("name", "name"),
    field("worktree", "worktree"),
    field("time_active", "time_active"),
    field("time_archived", "time_archived"),
  ].join(", ");

  return query(db, `select ${select} from project`).map((row) => ({
    id: String(row.id),
    name: row.name == null ? null : String(row.name),
    worktree: row.worktree == null ? null : String(row.worktree),
    timeActive: row.time_active == null ? null : Number(row.time_active),
    timeArchived: row.time_archived == null ? null : Number(row.time_archived),
  }));
}

/** Looks up one project by its OpenCode database id. */
export function projectById(conn: Database, id: string): ProjectRow | null {
  return listProjects(conn).find((project) => project.id === id) ?? null;
}

export function resolveProject(conn: Database, directory: string): ProjectRow | null {
  const target = normalizePath(directory);
  const projects = listProjects(conn);
  const byId = new Map(projects.map((project) => [project.id, project]));

  const candidates = new Map<string, ProjectRow>();
  const add = (project: ProjectRow | undefined, sourcePath: string | null) => {
    // An archived project can share a worktree with a live one; never prefer it.
    if (!project || project.timeArchived) return;
    const mapped: ProjectRow = {
      id: project.id,
      name: project.name,
      worktree: project.worktree ?? sourcePath,
      timeActive: project.timeActive,
      timeArchived: project.timeArchived,
    };
    const existing = candidates.get(project.id);
    if (!existing || (mapped.timeActive ?? 0) > (existing.timeActive ?? 0)) {
      candidates.set(project.id, mapped);
    }
  };

  for (const project of projects) {
    if (project.worktree && normalizePath(project.worktree) === target) {
      add(project, project.worktree);
    }
  }

  if (hasTable(conn.db, "project_directory")) {
    const directoryColumns = tableColumns(conn.db, "project_directory");
    if (directoryColumns.has("project_id") && directoryColumns.has("directory")) {
      for (const row of query(conn.db, "select project_id, directory from project_directory")) {
        if (row.directory && normalizePath(String(row.directory)) === target) {
          add(byId.get(String(row.project_id)), String(row.directory));
        }
      }
    }
  }

  let best: ProjectRow | null = null;
  for (const project of candidates.values()) {
    if (!best || (project.timeActive ?? 0) > (best.timeActive ?? 0)) best = project;
  }
  return best;
}

export function readSessions(conn: Database, projectId: string, limit = 1000): SessionRow[] {
  const { db, sessionTable, columns } = conn;
  const field = (name: string, alias: string) =>
    columns.has(name) ? `"${name}" as ${alias}` : `null as ${alias}`;
  const select = [
    field("id", "id"),
    field("project_id", "project_id"),
    field("parent_id", "parent_id"),
    field("agent", "agent"),
    field("title", "title"),
    field("time_created", "time_created"),
    field("time_updated", "time_updated"),
    field("time_busy", "time_busy"),
    field("time_idle", "time_idle"),
    field("time_archived", "time_archived"),
  ].join(", ");

  const archiveFilter = columns.has("time_archived")
    ? "and (time_archived is null or time_archived = 0)"
    : "";
  const orderBy = columns.has("time_updated") ? "order by time_updated desc" : "";

  return query(
    db,
    `select ${select} from "${sessionTable}"
       where project_id = ? ${archiveFilter}
       ${orderBy} limit ?`,
    projectId,
    limit,
  ).map((row) => ({
    id: String(row.id),
    projectId: row.project_id == null ? null : String(row.project_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    agent: row.agent == null ? null : String(row.agent),
    title: row.title == null ? null : String(row.title),
    timeCreated: row.time_created == null ? null : Number(row.time_created),
    timeUpdated: row.time_updated == null ? null : Number(row.time_updated),
    timeBusy: row.time_busy == null ? null : Number(row.time_busy),
    timeIdle: row.time_idle == null ? null : Number(row.time_idle),
    timeArchived: row.time_archived == null ? null : Number(row.time_archived),
  }));
}

export function readTodos(conn: Database, sessionIds: string[]): TodoRow[] {
  if (sessionIds.length === 0 || !hasTable(conn.db, "todo")) return [];
  const columns = tableColumns(conn.db, "todo");
  if (!columns.has("session_id")) return [];

  const field = (name: string) => (columns.has(name) ? `"${name}"` : "null");
  const select = [
    `"session_id" as session_id`,
    `${field("content")} as content`,
    `${field("status")} as status`,
    `${field("priority")} as priority`,
    `${field("position")} as position`,
  ].join(", ");
  const placeholders = sessionIds.map(() => "?").join(", ");

  return query(
    conn.db,
    `select ${select} from todo where session_id in (${placeholders})`,
    ...sessionIds,
  ).map((row) => ({
    sessionId: String(row.session_id),
    content: String(row.content ?? ""),
    status: String(row.status ?? ""),
    priority: row.priority == null ? null : String(row.priority),
    position: row.position == null ? null : Number(row.position),
  }));
}
