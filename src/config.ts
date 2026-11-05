import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  projectPath: string;
  databasePath: string;
  port: number;
  host: string;
  staleMs: number;
  refreshMs: number;
  agentsDir: string;
  readOnly: boolean;
}

const DEFAULT_PROJECT = process.cwd();
const DEFAULT_PORT = 4420;
const DEFAULT_STALE_MINUTES = 15;
const DEFAULT_REFRESH_MS = 2000;

/** Expands a leading ~ so paths copied from a shell work on every platform. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function isTruthy(value: string | undefined): boolean {
  return value != null && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Only loopback hosts are allowed to mutate agent files. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    /^127(?:\.\d{1,3}){3}$/.test(value)
  );
}

/**
 * Reads configuration from CLI flags, then environment variables, then defaults.
 *
 *   node src/server.ts [project-path] [--port=4420] [--stale-minutes=15] [--read-only]
 *
 * ENV: MONITOR_PROJECT, MONITOR_DB, MONITOR_PORT, MONITOR_HOST,
 *      MONITOR_STALE_MINUTES, MONITOR_REFRESH_MS, MONITOR_AGENTS_DIR,
 *      MONITOR_READ_ONLY
 */
export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Config {
  const flag = (name: string): string | undefined => {
    const hit = argv.find((value) => value.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const positional = argv.find((value) => !value.startsWith("--"));

  const projectPath = resolve(
    expandHome(flag("project") ?? positional ?? env.MONITOR_PROJECT ?? DEFAULT_PROJECT),
  );

  const databasePath = resolve(
    expandHome(
      flag("db") ?? env.MONITOR_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db"),
    ),
  );

  const port = Number(flag("port") ?? env.MONITOR_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  const staleMinutes = Number(
    flag("stale-minutes") ?? env.MONITOR_STALE_MINUTES ?? DEFAULT_STALE_MINUTES,
  );
  if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
    throw new Error(`Invalid stale window: ${staleMinutes}`);
  }

  const refreshMs = Number(flag("refresh-ms") ?? env.MONITOR_REFRESH_MS ?? DEFAULT_REFRESH_MS);
  if (!Number.isFinite(refreshMs) || refreshMs < 250) {
    throw new Error(`Invalid refresh interval: ${refreshMs}`);
  }

  return {
    projectPath,
    databasePath,
    port,
    host: env.MONITOR_HOST ?? "127.0.0.1",
    staleMs: Math.round(staleMinutes * 60_000),
    refreshMs: Math.round(refreshMs),
    agentsDir: resolve(
      expandHome(
        flag("agents") ?? env.MONITOR_AGENTS_DIR ?? join(projectPath, ".opencode", "agents"),
      ),
    ),
    readOnly: argv.includes("--read-only") || isTruthy(env.MONITOR_READ_ONLY),
  };
}
