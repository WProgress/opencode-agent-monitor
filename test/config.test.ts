import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { loadConfig, isLoopbackHost } from "../src/config.ts";

const DEFAULT_PROJECT = process.cwd();

test("uses the documented defaults when nothing is configured", () => {
  const config = loadConfig([], {});

  assert.equal(config.projectPath, resolve(DEFAULT_PROJECT));
  assert.equal(
    config.databasePath,
    resolve(join(homedir(), ".local", "share", "opencode", "opencode.db")),
  );
  assert.equal(config.port, 4420);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.staleMs, 15 * 60_000);
  assert.equal(config.refreshMs, 2000);
  assert.equal(config.readOnly, false);
  assert.equal(config.agentsDir, resolve(join(config.projectPath, ".opencode", "agents")));
});

test("lets flags override environment variables and defaults", () => {
  const config = loadConfig(
    [
      "--project=D:/work/flags",
      "--port=5000",
      "--stale-minutes=5",
      "--refresh-ms=1000",
      "--db=~/monitor.db",
      "--agents=~/agents",
    ],
    {
      MONITOR_PROJECT: "D:/work/environment",
      MONITOR_DB: "D:/work/environment.db",
      MONITOR_PORT: "6000",
      MONITOR_HOST: "0.0.0.0",
    },
  );

  assert.equal(config.projectPath, resolve("D:/work/flags"));
  assert.equal(config.databasePath, resolve(join(homedir(), "monitor.db")));
  assert.equal(config.agentsDir, resolve(join(homedir(), "agents")));
  assert.equal(config.port, 5000);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.staleMs, 5 * 60_000);
  assert.equal(config.refreshMs, 1000);
});

test("accepts the project as an environment variable or positional path", () => {
  const fromEnvironment = loadConfig([], { MONITOR_PROJECT: "D:/work/environment" });
  assert.equal(fromEnvironment.projectPath, resolve("D:/work/environment"));

  const positional = loadConfig(["D:/work/positional"], {
    MONITOR_PROJECT: "D:/work/environment",
  });
  assert.equal(positional.projectPath, resolve("D:/work/positional"));
});

test("rejects invalid numeric settings", () => {
  assert.throws(() => loadConfig(["--port=0"], {}), /Invalid port/);
  assert.throws(() => loadConfig(["--port=65536"], {}), /Invalid port/);
  assert.throws(() => loadConfig(["--port=nope"], {}), /Invalid port/);
  assert.throws(() => loadConfig(["--stale-minutes=0"], {}), /Invalid stale window/);
  assert.throws(() => loadConfig(["--refresh-ms=100"], {}), /Invalid refresh interval/);
});

test("enables read-only mode from a flag or environment variable", () => {
  assert.equal(loadConfig(["--read-only"], {}).readOnly, true);
  assert.equal(loadConfig([], { MONITOR_READ_ONLY: "1" }).readOnly, true);
  assert.equal(loadConfig([], { MONITOR_READ_ONLY: "true" }).readOnly, true);
  assert.equal(loadConfig([], { MONITOR_READ_ONLY: "0" }).readOnly, false);
  assert.equal(loadConfig([], {}).readOnly, false);
});

test("recognises only loopback bind addresses", () => {
  for (const host of ["127.0.0.1", "127.4.5.6", "localhost", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
  }
  for (const host of ["0.0.0.0", "192.168.1.10", "example.com", "::"]) {
    assert.equal(isLoopbackHost(host), false, `${host} should not be loopback`);
  }
});
