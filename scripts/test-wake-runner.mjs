#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupLease } from "./wake-runner.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(scripts, "wake-runner.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-wake-runner-"));
const audit = path.join(root, "audit");
const calls = path.join(root, "calls.jsonl");
const raceAckStarted = path.join(root, "race-ack-started.json");
const raceAckFinished = path.join(root, "race-ack-finished.json");
const fakeCodex = path.join(root, "fake-codex.mjs");
const fakeCallTool = path.join(root, "fake-call-tool.mjs");
fs.mkdirSync(audit, { recursive: true });

fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
const mode = process.env.HAWKSPAN_TEST_CODEX_MODE;
if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  const messageId = mode === "mismatch" ? "wrong-message" : process.env.HAWKSPAN_TEST_MESSAGE_ID;
  fs.writeFileSync(output, JSON.stringify({ message_id: messageId, status: "accepted" }));
  if (mode === "ack-race") {
    const ownerPath = path.join(path.dirname(output), "owner.json");
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    owner.deadline_at = new Date(Date.now() + 400).toISOString();
    fs.writeFileSync(ownerPath, JSON.stringify(owner));
  }
  if (mode === "lose-lease") {
    fs.writeFileSync(path.join(path.dirname(output), "owner.json"), JSON.stringify({
      token: "successor-token-after-acceptance",
      pid: process.pid,
      deadline_at: new Date(Date.now() + 60000).toISOString(),
    }));
  }
}
`, { mode: 0o755 });

fs.writeFileSync(fakeCallTool, `#!/usr/bin/env node
import fs from "node:fs";
const [name, raw = "{}"] = process.argv.slice(2);
const args = JSON.parse(raw);
fs.appendFileSync(process.env.HAWKSPAN_TEST_CALL_LOG, JSON.stringify({ name, args }) + "\\n");
if (name === "list_messages") {
  process.stdout.write(JSON.stringify({
    isError: false,
    structuredContent: [{
      id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
      direction: "inbound",
      state: "received",
    }],
  }));
} else if (name === "acknowledge_message") {
  const delayMs = Number(process.env.HAWKSPAN_TEST_ACK_DELAY_MS || 0);
  if (delayMs > 0) {
    fs.writeFileSync(process.env.HAWKSPAN_TEST_ACK_STARTED, JSON.stringify({ at: Date.now() }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    fs.writeFileSync(process.env.HAWKSPAN_TEST_ACK_FINISHED, JSON.stringify({ at: Date.now() }));
  }
  process.stdout.write(JSON.stringify({
    isError: false,
    structuredContent: { message_id: "ack-test", acknowledged_message_id: args.message_id },
  }));
} else {
  process.stdout.write(JSON.stringify({ isError: true, content: [{ text: "unexpected tool" }] }));
}
`, { mode: 0o755 });

function request(name, messageId, overrides = {}) {
  return {
    schema_version: 1,
    wake_id: `wake-${name}`,
    message_id: messageId,
    thread_id: `thread-${name}`,
    prompt: `accept ${messageId}`,
    codex_command: fakeCodex,
    node_command: process.execPath,
    call_tool_path: fakeCallTool,
    audit_dir: audit,
    log_path: path.join(audit, `wake-${name}.log`),
    lease_path: path.join(audit, `wake-thread-${name}.lock`),
    result_path: path.join(audit, `wake-${name}.result.json`),
    timeout_ms: 2000,
    termination_grace_ms: 100,
    ...overrides,
  };
}

function launch(wakeRequest, mode = "accept") {
  const encoded = Buffer.from(JSON.stringify(wakeRequest)).toString("base64");
  const result = spawnSync(process.execPath, [runner, "launch", encoded], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      HAWKSPAN_TEST_CODEX_MODE: mode,
      HAWKSPAN_TEST_MESSAGE_ID: wakeRequest.message_id,
      HAWKSPAN_TEST_CALL_LOG: calls,
      HAWKSPAN_TEST_ACK_DELAY_MS: mode === "ack-race" ? "900" : "0",
      HAWKSPAN_TEST_ACK_STARTED: raceAckStarted,
      HAWKSPAN_TEST_ACK_FINISHED: raceAckFinished,
    },
  });
  const marker = JSON.parse(result.stdout.trim());
  return { result, marker };
}

async function waitResult(wakeRequest, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(wakeRequest.result_path)) {
      return JSON.parse(fs.readFileSync(wakeRequest.result_path, "utf8"));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${wakeRequest.result_path}`);
}

function callNames() {
  if (!fs.existsSync(calls)) return [];
  return fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line).name);
}

const acceptedRequest = request("accepted", "message-accepted");
const acceptedLaunch = launch(acceptedRequest);
assert.equal(acceptedLaunch.result.status, 0, acceptedLaunch.result.stderr);
assert.equal(acceptedLaunch.marker.status, "started");
const acceptedResult = await waitResult(acceptedRequest);
assert.equal(acceptedResult.status, "acknowledged");
assert.equal(acceptedResult.acknowledged, true);
assert.equal(acceptedResult.lease_released, true);
assert.equal(fs.existsSync(acceptedRequest.lease_path), false);
assert.equal(callNames().filter((name) => name === "acknowledge_message").length, 1);

const mismatchRequest = request("mismatch", "message-mismatch");
const mismatchLaunch = launch(mismatchRequest, "mismatch");
assert.equal(mismatchLaunch.result.status, 0, mismatchLaunch.result.stderr);
const mismatchResult = await waitResult(mismatchRequest);
assert.equal(mismatchResult.status, "invalid_acceptance");
assert.equal(mismatchResult.acknowledged, false);
assert.equal(mismatchResult.lease_released, true);
assert.equal(fs.existsSync(mismatchRequest.lease_path), false);
assert.equal(callNames().filter((name) => name === "acknowledge_message").length, 1);

const lostLeaseRequest = request("lost-lease", "message-lost-lease");
const lostLeaseLaunch = launch(lostLeaseRequest, "lose-lease");
assert.equal(lostLeaseLaunch.result.status, 0, lostLeaseLaunch.result.stderr);
const lostLeaseResult = await waitResult(lostLeaseRequest);
assert.equal(lostLeaseResult.status, "lease_lost");
assert.equal(lostLeaseResult.acknowledged, false);
assert.equal(lostLeaseResult.lease_released, false);
assert.equal(callNames().filter((name) => name === "acknowledge_message").length, 1);
assert.equal(cleanupLease(lostLeaseRequest.lease_path, "successor-token-after-acceptance"), true);

const hungRequest = request("hung", "message-hung", {
  timeout_ms: 200,
  termination_grace_ms: 100,
});
const hungLaunch = launch(hungRequest, "hang");
assert.equal(hungLaunch.result.status, 0, hungLaunch.result.stderr);
const hungResult = await waitResult(hungRequest);
assert.equal(hungResult.status, "timed_out");
assert.equal(hungResult.acknowledged, false);
assert.equal(hungResult.lease_released, true);
assert.equal(fs.existsSync(hungRequest.lease_path), false);
assert.equal(callNames().filter((name) => name === "acknowledge_message").length, 1);

const busyRequest = request("busy", "message-busy");
fs.mkdirSync(busyRequest.lease_path);
fs.writeFileSync(path.join(busyRequest.lease_path, "owner.json"), JSON.stringify({
  token: "active-token",
  pid: process.pid,
  wake_id: "wake-active",
  message_id: "message-active",
  deadline_at: new Date(Date.now() + 60000).toISOString(),
}));
const busyLaunch = launch(busyRequest);
assert.equal(busyLaunch.result.status, 73);
assert.equal(busyLaunch.marker.status, "busy");
assert.equal(busyLaunch.marker.active_message_id, "message-active");
fs.rmSync(busyRequest.lease_path, { recursive: true, force: true });

const expiredLiveRequest = request("expired-live", "message-expired-live");
fs.mkdirSync(expiredLiveRequest.lease_path);
fs.writeFileSync(path.join(expiredLiveRequest.lease_path, "owner.json"), JSON.stringify({
  token: "expired-live-token",
  pid: process.pid,
  wake_id: "wake-expired-live-old",
  message_id: "message-expired-live-old",
  deadline_at: new Date(Date.now() - 1000).toISOString(),
}));
const expiredLiveLaunch = launch(expiredLiveRequest);
assert.equal(expiredLiveLaunch.result.status, 0, expiredLiveLaunch.result.stderr);
assert.equal(expiredLiveLaunch.marker.status, "started");
assert.equal(expiredLiveLaunch.marker.recovered_lease.owner_alive, true);
assert.equal(expiredLiveLaunch.marker.recovered_lease.deadline_expired, true);
assert.equal(expiredLiveLaunch.marker.recovered_lease.token_matched, true);
const expiredLiveResult = await waitResult(expiredLiveRequest);
assert.equal(expiredLiveResult.status, "acknowledged");
assert.equal(expiredLiveResult.lease_released, true);
assert.equal(fs.existsSync(expiredLiveRequest.lease_path), false);

const staleRequest = request("stale", "message-stale");
fs.mkdirSync(staleRequest.lease_path);
fs.writeFileSync(path.join(staleRequest.lease_path, "owner.json"), JSON.stringify({
  token: "stale-token",
  pid: 999999,
  wake_id: "wake-stale-old",
  message_id: "message-stale-old",
}));
const staleLaunch = launch(staleRequest);
assert.equal(staleLaunch.result.status, 0, staleLaunch.result.stderr);
assert.equal(staleLaunch.marker.status, "started");
const staleResult = await waitResult(staleRequest);
assert.equal(staleResult.status, "acknowledged");
assert.equal(staleResult.lease_released, true);
assert.equal(fs.existsSync(staleRequest.lease_path), false);

const fencedLease = path.join(audit, "wake-thread-fenced.lock");
fs.mkdirSync(fencedLease);
fs.writeFileSync(path.join(fencedLease, "owner.json"), JSON.stringify({
  token: "successor-token",
  pid: process.pid,
}));
assert.equal(cleanupLease(fencedLease, "predecessor-token"), false);
assert.equal(fs.existsSync(fencedLease), true);
assert.equal(cleanupLease(fencedLease, "successor-token"), true);
assert.equal(fs.existsSync(fencedLease), false);

const raceRequest = request("ack-race", "message-ack-race");
const raceLaunch = launch(raceRequest, "ack-race");
assert.equal(raceLaunch.result.status, 0, raceLaunch.result.stderr);
const raceStartDeadline = Date.now() + 5000;
while (!fs.existsSync(raceAckStarted) && Date.now() < raceStartDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert(fs.existsSync(raceAckStarted), "guarded acknowledgement must begin");
await new Promise((resolve) => setTimeout(resolve, 500));
const successorRequest = request("ack-race-successor", "message-ack-race-successor", {
  lease_path: raceRequest.lease_path,
});
const successorAttemptedAt = Date.now();
const successorLaunch = launch(successorRequest);
const successorReturnedAt = Date.now();
assert.equal(successorLaunch.result.status, 0, successorLaunch.result.stderr);
assert.equal(successorLaunch.marker.status, "started");
assert(fs.existsSync(raceAckFinished), "successor must wait for guarded acknowledgement");
const raceStartedAt = JSON.parse(fs.readFileSync(raceAckStarted, "utf8")).at;
const raceFinishedAt = JSON.parse(fs.readFileSync(raceAckFinished, "utf8")).at;
assert(raceStartedAt <= successorAttemptedAt);
assert(successorAttemptedAt < raceFinishedAt);
assert(raceFinishedAt <= successorReturnedAt);
const raceResult = await waitResult(raceRequest);
assert.equal(raceResult.status, "acknowledged");
assert.equal(raceResult.acknowledged, true);
const successorResult = await waitResult(successorRequest);
assert.equal(successorResult.status, "acknowledged");
assert.equal(successorResult.lease_released, true);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("bounded and fenced wake-runner tests passed\n");
