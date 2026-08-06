#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-supervisor-test-"));
const environment = {
  ...process.env,
  HAWKSPAN_STATE_DIR: state,
  HAWKSPAN_CONFIG: path.join(state, "config.json"),
};
fs.writeFileSync(environment.HAWKSPAN_CONFIG, JSON.stringify({
  schema_version: 1,
  node_id: "supervisor-test",
  peer: { primary_enabled: false, fallback_enabled: false },
}), { mode: 0o600 });
fs.writeFileSync(path.join(state, "hawkspan.env"), [
  "HAWKSPAN_QUEUE_SUPERVISOR_ENABLED=true",
  "HAWKSPAN_QUEUE_SUPERVISOR_POLL_INTERVAL_MS=1000",
  "HAWKSPAN_QUEUE_WORKER_RESTART_DELAYS_MS=100,200",
  "HAWKSPAN_QUEUE_ITEM_LEASE_MS=5000",
  "HAWKSPAN_QUEUE_MAX_ITEMS_PER_WORKER=2",
  "",
].join("\n"), { mode: 0o600 });

function call(name, args) {
  const result = spawnSync(process.execPath, [
    path.join(scripts, "call-tool.mjs"), name, JSON.stringify(args),
  ], { env: environment, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).structuredContent;
}

call("create_queue", {
  queue_id: "supervisor-command",
  adapter: "command",
  retry_delays_ms: [100],
});
call("enqueue_queue_item", {
  queue_id: "supervisor-command",
  item_id: "supervised-command",
  payload: { command: "/usr/bin/true", cwd: state },
});

const supervisor = spawn(process.execPath, [path.join(scripts, "queue-supervisor.mjs")], {
  env: environment,
  stdio: "ignore",
});
try {
  let completed = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = call("queue_status", { queue_id: "supervisor-command" });
    if (status.items[0]?.state === "completed") {
      completed = true;
      break;
    }
  }
  assert.equal(completed, true, "persistent supervisor did not complete queued command");
} finally {
  supervisor.kill("SIGTERM");
}

console.log("queue supervisor process test passed");
