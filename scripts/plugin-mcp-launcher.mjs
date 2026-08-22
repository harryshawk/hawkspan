#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readReleaseAuthority } from "./release-authority.mjs";

const stateRoot = path.resolve(
  process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"),
);
const authority = readReleaseAuthority(stateRoot);
const serverPath = path.join(authority.active_release_root, "scripts", "mcp-server.mjs");
if (!fs.existsSync(serverPath) || !fs.statSync(serverPath).isFile()) {
  throw new Error(`active HawkSpan release is missing its MCP server: ${serverPath}`);
}

// Codex runs this launcher from its immutable plugin cache. The release
// authority, not the cache pathname, selects the single executable server.
const child = spawn(process.execPath, [serverPath], {
  // The persistent HawkSpan agent owns the local-control listener. A Codex
  // plugin process is stdio-only and must not contend for that same port.
  env: { ...process.env, HAWKSPAN_LOCAL_CONTROL_DISABLED: "1" },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
