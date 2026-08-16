#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-trainer-state-"));
const invocationLog = path.join(root, "trainer-invocations.log");
const adapter = path.join(root, "trainer-start.sh");
fs.writeFileSync(adapter, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(invocationLog)}\nprintf '{"started":true}\\n'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  schema_version: 1,
  node_id: "state-test",
  database_path: path.join(root, "state.sqlite"),
  artifact_root: path.join(root, "artifacts"),
  inbox_root: path.join(root, "inbox"),
  outbox_root: path.join(root, "outbox"),
  audit_root: path.join(root, "audit"),
  local_control: { enabled: false },
  training: {
    allow_start: true,
    start_script: adapter,
  },
}, null, 2));

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs");
const child = spawn(process.execPath, [server], {
  env: { ...process.env, HAWKSPAN_STATE_DIR: root },
  stdio: ["pipe", "pipe", "inherit"],
});
let sequence = 0;
let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) {
      pending.delete(response.id);
      waiter(response);
    }
  }
});
function request(method, params = {}) {
  const id = ++sequence;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, 10000);
  });
}
const tool = (name, args = {}) => request("tools/call", { name, arguments: args });
await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

const missingBinding = await tool("create_job", {
  kind: "training",
  title: "Missing exact authorization binding",
  requires_authorization: true,
});
const refusedMissingBinding = await tool("update_job_status", {
  job_id: missingBinding.result.structuredContent.job_id,
  state: "authorized",
  authorization_evidence: "A general instruction is not an exact revision binding.",
});
assert.equal(refusedMissingBinding.result.isError, true);
assert.match(refusedMissingBinding.result.content[0].text, /requires target/);

const created = await tool("create_job", {
  kind: "training",
  title: "State gate",
  requires_authorization: true,
  metadata: {
    target: "robot-test",
    revision_fingerprint: "a".repeat(64),
  },
});
const jobId = created.result.structuredContent.job_id;
const refused = await tool("trainer_start_authorized_job", {
  job_id: jobId,
  target: "robot-test",
});
assert.equal(refused.result.isError, true);
assert.match(refused.result.content[0].text, /recorded explicit authorization/);
assert.equal(fs.existsSync(invocationLog), false);

const authorized = await tool("update_job_status", {
  job_id: jobId,
  state: "authorized",
  authorization_evidence: "Active user instruction for this bounded test.",
});
assert.equal(authorized.result.isError, false);
const refusedBindingMutation = await tool("update_job_status", {
  job_id: jobId,
  state: "authorized",
  authorization_evidence: "Must not replace an existing exact binding.",
  metadata: { revision_fingerprint: "b".repeat(64) },
});
assert.equal(refusedBindingMutation.result.isError, true);
assert.match(refusedBindingMutation.result.content[0].text, /binding is immutable/);
const unboundStart = await tool("trainer_start_authorized_job", {
  job_id: jobId,
  target: "robot-test",
});
assert.equal(unboundStart.result.isError, true);
assert.match(unboundStart.result.content[0].text, /expected_revision_fingerprint/);
assert.equal(fs.existsSync(invocationLog), false);
const mismatchedStart = await tool("trainer_start_authorized_job", {
  job_id: jobId,
  target: "robot-test",
  expected_revision_fingerprint: "b".repeat(64),
});
assert.equal(mismatchedStart.result.isError, true);
assert.match(mismatchedStart.result.content[0].text, /does not match recorded authorization/);
const started = await tool("trainer_start_authorized_job", {
  job_id: jobId,
  target: "robot-test",
  expected_revision_fingerprint: "a".repeat(64),
});
assert.equal(started.result.isError, false);
assert.match(fs.readFileSync(invocationLog, "utf8"), /--target robot-test/);

const cancelled = await tool("create_job", {
  kind: "training",
  title: "Cancelled state",
  requires_authorization: true,
  metadata: {
    target: "robot-test",
    revision_fingerprint: "a".repeat(64),
  },
});
await tool("update_job_status", {
  job_id: cancelled.result.structuredContent.job_id,
  state: "authorized",
  authorization_evidence: "Active user instruction for this bounded test.",
});
await tool("update_job_status", {
  job_id: cancelled.result.structuredContent.job_id,
  state: "cancelled",
});
const cancelledStart = await tool("trainer_start_authorized_job", {
  job_id: cancelled.result.structuredContent.job_id,
  target: "robot-test",
});
assert.equal(cancelledStart.result.isError, true);
assert.match(cancelledStart.result.content[0].text, /state cancelled is not allowed/);

child.stdin.end();
await new Promise((resolve) => child.once("exit", resolve));
process.stdout.write("trainer job state tests passed\n");
