#!/usr/bin/env node
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`OpenCode Agent Monitor (OCAM) ${pkg.version}

Usage:
  ocam [project-path] [options]

Options:
  --project=<path>          Project to open first (default: current folder)
  --port=<number>           HTTP port (default: 4420)
  --host=<address>          Bind address (default: 127.0.0.1)
  --db=<path>               OpenCode SQLite database
  --agents=<dir>            Agent folder for the default project
  --stale-minutes=<n>       Activity window before an agent is sleeping (default: 15)
  --refresh-ms=<n>          Poll interval in milliseconds (default: 2000)
  --read-only               Disable agent editing
  -h, --help                Show this help
  -v, --version             Show the version

The dashboard opens at http://127.0.0.1:4420 by default.
Use the Project selector to switch between OpenCode projects.`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 24) {
  console.error(
    `OpenCode Agent Monitor needs Node.js 24 or newer. Current version: ${process.versions.node}`,
  );
  process.exit(1);
}

const { startMonitor } = await import("./server.ts");
startMonitor();
