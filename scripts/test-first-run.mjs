#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyReleaseTree } from "./release-tree.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-first-run-"));
const verified = verifyReleaseTree(repository);
assert.match(verified.release_id, /^tree-sha256:[a-f0-9]{64}$/);
fs.copyFileSync(path.join(repository, "config", "example.json"), path.join(state, "config.json"));
fs.copyFileSync(path.join(repository, "config", "hawkspan.env.example"), path.join(state, "hawkspan.env"));
fs.chmodSync(path.join(state, "config.json"), 0o600);
fs.chmodSync(path.join(state, "hawkspan.env"), 0o600);

const child = spawn(process.execPath, [path.join(repository, "scripts", "start-local-control.mjs")], {
  env: { ...process.env, HAWKSPAN_STATE_DIR: state },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`first-run timeout: ${stderr}`)), 30000);
    const inspectOutput = () => {
      const match = stdout.match(/HawkSpan dashboard: (http:\/\/127\.0\.0\.1:\d+\/)\n/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout.on("data", inspectOutput);
    inspectOutput();
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`first-run launcher exited ${code}: ${stderr}`));
    });
  });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>HawkSpan[^<]*<\/title>/);
  assert.match(html, /Configuration/);
  assert.match(html, /Help/);
  assert.ok(fs.existsSync(path.join(state, "spool.sqlite3")));
} finally {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  process.kill(-child.pid, "SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!stopped) {
    process.kill(-child.pid, "SIGKILL");
    await exited;
  }
  fs.rmSync(state, { recursive: true, force: true });
}

process.stdout.write("hawkspan isolated first-run dashboard test passed\n");
