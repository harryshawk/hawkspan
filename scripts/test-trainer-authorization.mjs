#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-trainer-auth-"));
const invocationLog = path.join(root, "trainer-invocations.log");
const adapter = path.join(root, "trainer-adapter.sh");
fs.writeFileSync(adapter, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(invocationLog)}
printf '{"ok":true}\\n'
`, { mode: 0o755 });
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  schema_version: 1,
  node_id: "auth-test",
  database_path: path.join(root, "state.sqlite"),
  artifact_root: path.join(root, "artifacts"),
  inbox_root: path.join(root, "inbox"),
  outbox_root: path.join(root, "outbox"),
  audit_root: path.join(root, "audit"),
  local_control: { enabled: false },
  training: {
    allow_start: true,
    allow_stop: true,
    allow_package: true,
    start_script: adapter,
    stop_script: adapter,
    package_script: adapter,
  },
}, null, 2));

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs");
const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    HAWKSPAN_STATE_DIR: root,
    HAWKSPAN_CALL_ORIGIN: "peer",
  },
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

const fingerprint = "a".repeat(64);
const recordedAuthError = /recorded explicit authorization/;

function invocationCount() {
  return fs.existsSync(invocationLog)
    ? fs.readFileSync(invocationLog, "utf8").split("\n").filter(Boolean).length
    : 0;
}

const beforeUnauthorized = invocationCount();
const proposed = await tool("create_job", {
  kind: "training",
  title: "Proposed without recorded authorization",
});
assert.equal(proposed.result.structuredContent.state, "proposed");
const queuedWithoutAuth = await tool("update_job_status", {
  job_id: proposed.result.structuredContent.job_id,
  state: "queued",
});
assert.equal(queuedWithoutAuth.result.isError, false, queuedWithoutAuth.result.content?.[0]?.text);
assert.equal(queuedWithoutAuth.result.structuredContent.state, "queued");
assert.equal(queuedWithoutAuth.result.structuredContent.authorization_state, "not_required");
const refusedProposedQueued = await tool("trainer_start_authorized_job", {
  job_id: proposed.result.structuredContent.job_id,
  target: "robot-test",
  expected_revision_fingerprint: fingerprint,
});
assert.equal(refusedProposedQueued.result.isError, true);
assert.match(refusedProposedQueued.result.content[0].text, recordedAuthError);
assert.equal(invocationCount(), beforeUnauthorized);

const requiredJob = await tool("create_job", {
  kind: "training",
  title: "Awaiting authorization",
  requires_authorization: true,
});
assert.equal(requiredJob.result.structuredContent.state, "awaiting_authorization");
const refusedRequired = await tool("trainer_start_authorized_job", {
  job_id: requiredJob.result.structuredContent.job_id,
  target: "robot-test",
  expected_revision_fingerprint: fingerprint,
});
assert.equal(refusedRequired.result.isError, true);
assert.match(refusedRequired.result.content[0].text, recordedAuthError);
assert.equal(invocationCount(), beforeUnauthorized);
process.stdout.write("trainer authorization: unrecorded start including proposed to queued refused\n");

const delegatedBase = {
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:01:00.000Z",
  creator: "controller-test",
  assignee: "auth-test",
  kind: "training",
  title: "Invalid delegated authorization",
  description: "Delegated context must already carry recorded authorization.",
  state: "authorized",
  authorization_evidence: "Peer-supplied evidence is not a substitute for recorded state.",
  metadata: { target: "robot-test", revision_fingerprint: fingerprint },
};
for (const [label, authorizationState] of [
  ["not_required", "not_required"],
  ["required", "required"],
  ["omitted", undefined],
]) {
  const jobId = `job-delegated-invalid-${label}`;
  const beforeDelegated = invocationCount();
  const context = { ...delegatedBase, id: jobId };
  if (authorizationState !== undefined) context.authorization_state = authorizationState;
  const refusedDelegated = await tool("trainer_start_authorized_job", {
    job_id: jobId,
    target: "robot-test",
    expected_revision_fingerprint: fingerprint,
    _delegated_job: context,
  });
  assert.equal(refusedDelegated.result.isError, true, label);
  assert.match(refusedDelegated.result.content[0].text, recordedAuthError);
  assert.equal(invocationCount(), beforeDelegated, label);
}
process.stdout.write("trainer authorization: invalid delegated start refused\n");

const authorized = await tool("create_job", {
  kind: "training",
  title: "Recorded authorization lifecycle",
  requires_authorization: true,
});
const jobId = authorized.result.structuredContent.job_id;
await tool("update_job_status", {
  job_id: jobId,
  state: "authorized",
  authorization_evidence: "Active owner instruction for this bounded test.",
  metadata: { target: "robot-test", revision_fingerprint: fingerprint },
});
const started = await tool("trainer_start_authorized_job", {
  job_id: jobId,
  target: "robot-test",
  expected_revision_fingerprint: fingerprint,
});
assert.equal(started.result.isError, false, started.result.content?.[0]?.text);
assert.match(fs.readFileSync(invocationLog, "utf8"), new RegExp(`--job-id ${jobId}.*--target robot-test`));
let jobs = await tool("list_jobs", { job_id: jobId });
assert.equal(jobs.result.structuredContent[0].state, "running");
assert.equal(jobs.result.structuredContent[0].authorization_state, "recorded");

const stopped = await tool("trainer_stop_authorized_job", {
  job_id: jobId,
  target: "robot-test",
});
assert.equal(stopped.result.isError, false, stopped.result.content?.[0]?.text);
jobs = await tool("list_jobs", { job_id: jobId });
assert.equal(jobs.result.structuredContent[0].state, "paused");

const packageJob = await tool("create_job", {
  kind: "training",
  title: "Recorded authorization package",
  requires_authorization: true,
});
const packageJobId = packageJob.result.structuredContent.job_id;
await tool("update_job_status", {
  job_id: packageJobId,
  state: "authorized",
  authorization_evidence: "Active owner instruction for this bounded test.",
  metadata: { target: "robot-test", revision_fingerprint: fingerprint },
});
const packageStarted = await tool("trainer_start_authorized_job", {
  job_id: packageJobId,
  target: "robot-test",
  expected_revision_fingerprint: fingerprint,
});
assert.equal(packageStarted.result.isError, false, packageStarted.result.content?.[0]?.text);
const returning = await tool("update_job_status", {
  job_id: packageJobId,
  state: "returning",
  metadata: { phase: "awaiting-validation" },
});
assert.equal(returning.result.isError, false, returning.result.content?.[0]?.text);
const packaged = await tool("trainer_package_authorized_job", {
  job_id: packageJobId,
  target: "robot-test",
  expected_revision_fingerprint: fingerprint,
});
assert.equal(packaged.result.isError, false, packaged.result.content?.[0]?.text);
assert.match(
  fs.readFileSync(invocationLog, "utf8"),
  new RegExp(`--job-id ${packageJobId}.*--target robot-test.*--expected-revision-fingerprint ${fingerprint}`),
);
process.stdout.write("trainer authorization: recorded start stop package succeeded\n");

child.stdin.end();
await new Promise((resolve) => child.once("exit", resolve));
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("trainer authorization tests passed\n");
