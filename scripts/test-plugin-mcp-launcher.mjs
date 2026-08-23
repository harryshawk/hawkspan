#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-plugin-launcher-"));
const stateRoot = path.join(root, "state");
const releaseRoot = path.join(root, "authority-release");
const stableRoot = path.join(root, "current");
fs.mkdirSync(path.join(releaseRoot, "scripts"), { recursive: true });
fs.mkdirSync(stateRoot, { recursive: true });
fs.writeFileSync(path.join(releaseRoot, "scripts", "mcp-server.mjs"), `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    input,
    localControlDisabled: process.env.HAWKSPAN_LOCAL_CONTROL_DISABLED,
  }));
});
`);
fs.writeFileSync(path.join(stateRoot, "installed-revision.json"), `${JSON.stringify({
  schema_version: 2,
  revision: "a".repeat(40),
  active_release_root: releaseRoot,
  stable_release_root: stableRoot,
  activated_at: new Date().toISOString(),
}, null, 2)}\n`);

const request = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
const launched = spawnSync(process.execPath, [path.join(scripts, "plugin-mcp-launcher.mjs")], {
  input: request,
  encoding: "utf8",
  timeout: 10000,
  env: { ...process.env, HAWKSPAN_STATE_DIR: stateRoot },
});
assert.equal(launched.status, 0, launched.stderr);
assert.deepEqual(JSON.parse(launched.stdout), {
  input: request,
  localControlDisabled: "1",
});

const missingAuthority = spawnSync(
  process.execPath,
  [path.join(scripts, "plugin-mcp-launcher.mjs")],
  {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, HAWKSPAN_STATE_DIR: path.join(root, "missing") },
  },
);
assert.notEqual(missingAuthority.status, 0);
assert.match(missingAuthority.stderr, /installed release authority is missing/);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("plugin MCP authority launcher tests passed\n");
