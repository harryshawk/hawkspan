#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-message-cancellation-"));
const bin = path.join(root, "bin");
const inbox = path.join(root, "inbox");
const audit = path.join(root, "audit");
const routeLog = path.join(root, "route.log");
const blockIdFile = path.join(root, "block-message-id");
const blockReady = path.join(root, "block-ready");
const blockRelease = path.join(root, "block-release");
const configPath = path.join(root, "config.json");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(inbox, { recursive: true });
fs.mkdirSync(audit, { recursive: true });

fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "$HAWKSPAN_TEST_ROUTE_LOG"
case "$*" in
  *"mkdir -p"*) exit 0 ;;
esac
exit 2
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "rsync"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\\n' '--partial --append-verify'
  exit 0
fi
printf 'rsync %s\\n' "$*" >> "$HAWKSPAN_TEST_ROUTE_LOG"
if [ -f "$HAWKSPAN_TEST_BLOCK_ID_FILE" ]; then
  block_id=$(tr -d '\\n' < "$HAWKSPAN_TEST_BLOCK_ID_FILE")
  case "$*" in
    *"$block_id"*)
      : > "$HAWKSPAN_TEST_BLOCK_READY"
      while [ ! -f "$HAWKSPAN_TEST_BLOCK_RELEASE" ]; do sleep 0.01; done
      ;;
  esac
fi
exit 0
`, { mode: 0o755 });

fs.writeFileSync(configPath, `${JSON.stringify({
  schema_version: 1,
  node_id: "cancellation-test",
  peer: {
    node_id: "peer",
    user: "peeruser",
    primary_enabled: true,
    primary_host: "192.0.2.30",
    fallback_enabled: false,
    remote_inbox: "/Users/peeruser/.hawkspan/inbox",
    remote_audit: "/Users/peeruser/.hawkspan/audit",
    codex_ipc_socket: "/peer/codex/ipc.sock",
    thread_id: "00000000-0000-0000-0000-000000000001",
    allow_remote_wake: true,
  },
  link: {
    operation_retry_delays_ms: [0],
    operation_attempt_timeout_ms: 1000,
    connect_timeout_ms: 500,
    cycle_timeout_ms: 5000,
    server_alive_interval_seconds: 1,
    server_alive_count_max: 1,
    primary_reprobe_ms: 100,
  },
}, null, 2)}\n`);

const environment = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  HAWKSPAN_STATE_DIR: root,
  HAWKSPAN_CONFIG: configPath,
  HAWKSPAN_TEST_ROUTE_LOG: routeLog,
  HAWKSPAN_TEST_BLOCK_ID_FILE: blockIdFile,
  HAWKSPAN_TEST_BLOCK_READY: blockReady,
  HAWKSPAN_TEST_BLOCK_RELEASE: blockRelease,
};

function tool(name, args = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(scripts, "call-tool.mjs"), name, JSON.stringify(args)],
    { encoding: "utf8", timeout: 30000, env: environment },
  );
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.isError, false, response.content?.[0]?.text);
  return response.structuredContent;
}

function writeInbound(envelope) {
  fs.writeFileSync(
    path.join(inbox, `${envelope.id}.json`),
    `${JSON.stringify({
      schema_version: 1,
      created_at: new Date().toISOString(),
      sender: "peer",
      recipient: "cancellation-test",
      subject: "test",
      body: "test",
      metadata: {},
      ...envelope,
    })}\n`,
  );
}

function toolAsync(name, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(scripts, "call-tool.mjs"), name, JSON.stringify(args)],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `${name} exited ${code}`));
        return;
      }
      const response = JSON.parse(stdout);
      if (response.isError) {
        reject(new Error(response.content?.[0]?.text || `${name} failed`));
        return;
      }
      resolve(response.structuredContent);
    });
  });
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(fs.existsSync(filePath), `timed out waiting for ${filePath}`);
}

function messages(direction) {
  return tool("list_messages", { direction, limit: 1000 });
}

const staged = tool("enqueue_queue_item", {
  queue_id: "hawkspan-messages",
  item_id: "cancel-staged-message",
  payload: {
    target_thread_id: "00000000-0000-0000-0000-000000000009",
    subject: "cancel before delivery",
    body: "this durable message must never escape after cancellation",
  },
});
const originalId = staged.item.payload.message_id;
assert.equal(fs.existsSync(routeLog), false);

const cancelled = tool("cancel_message", {
  message_id: originalId,
  reason: "owner withdrew this queued message",
});
assert.equal(cancelled.cancelled, true);
assert.equal(cancelled.local_state, "cancelled");
assert.equal(cancelled.peer_status, "pending");
assert.match(cancelled.cancellation_message_id, /^msg-/);
assert.equal(cancelled.queue_items_cancelled.includes("cancel-staged-message"), true);
const cancellationId = cancelled.cancellation_message_id;

const routesAfterCancel = fs.readFileSync(routeLog, "utf8");
assert.equal(routesAfterCancel.includes(originalId), false);
assert.equal(routesAfterCancel.includes(cancellationId), true);
assert.equal(routesAfterCancel.includes("wake-runner.mjs"), false);
assert.equal(routesAfterCancel.includes("installed-revision.json"), false);
assert.equal(
  tool("queue_status", { queue_id: "hawkspan-messages", limit: 1000 })
    .items.find((entry) => entry.item_id === "cancel-staged-message")?.state,
  "cancelled",
);

const retry = tool("retry_message", { message_id: originalId });
assert.equal(retry.cancelled, true);
assert.equal(retry.delivery.skipped, true);
assert.equal(retry.wake, null);
const flushed = tool("flush_outbox");
assert.equal(flushed.messages.some((entry) => entry.message_id === originalId), false);
assert.equal(fs.readFileSync(routeLog, "utf8"), routesAfterCancel);

const repeated = tool("cancel_message", { message_id: originalId, reason: "repeated request" });
assert.equal(repeated.already_cancelled, true);
assert.equal(repeated.cancellation_message_id, cancellationId);

writeInbound({
  id: "cancellation-applied-ack",
  kind: "acknowledgement",
  correlation_id: cancellationId,
  metadata: {
    message_cancellation: { message_id: originalId, result: "applied" },
  },
});
const confirmed = tool("cancel_message", { message_id: originalId });
assert.equal(confirmed.peer_status, "applied");
assert.equal(confirmed.cancellation_state, "acknowledged");

const racing = tool("enqueue_queue_item", {
  queue_id: "hawkspan-messages",
  item_id: "cancel-during-delivery",
  payload: {
    target_thread_id: "00000000-0000-0000-0000-000000000009",
    subject: "cancel while rsync is active",
    body: "a concurrent retry must not overwrite the cancellation or wake",
  },
});
const racingId = racing.item.payload.message_id;
fs.writeFileSync(blockIdFile, `${racingId}\n`);
const activeRetry = toolAsync("retry_message", { message_id: racingId });
await waitForFile(blockReady);
const racedCancellation = tool("cancel_message", {
  message_id: racingId,
  reason: "cancel while a queue worker is delivering",
});
assert.equal(racedCancellation.cancelled, true);
fs.writeFileSync(blockRelease, "continue\n");
const racedRetry = await activeRetry;
assert.equal(racedRetry.cancelled, true);
assert.equal(racedRetry.wake, null);
assert.equal(messages("outbound").find((entry) => entry.id === racingId)?.state, "cancelled");
assert.equal(fs.readFileSync(routeLog, "utf8").includes("wake-runner.mjs"), false);
fs.rmSync(blockIdFile, { force: true });

const peerOriginalId = "peer-original-after-tombstone";
const peerCancellationId = "peer-cancellation-before-original";
writeInbound({
  id: peerCancellationId,
  kind: "cancellation",
  correlation_id: peerOriginalId,
  metadata: { message_cancellation: { message_id: peerOriginalId, reason: "withdrawn" } },
});
messages("inbound");
writeInbound({
  id: peerOriginalId,
  kind: "message",
  target_thread_id: "00000000-0000-0000-0000-000000000009",
  subject: "replayed after cancellation",
  body: "must remain hidden",
  correlation_id: null,
});
assert.equal(
  tool("receive_messages", { limit: 1000 }).messages.some((entry) => entry.id === peerOriginalId),
  false,
);
assert.equal(messages("inbound").find((entry) => entry.id === peerOriginalId)?.state, "cancelled");
assert.equal(
  messages("outbound").filter((entry) => entry.correlation_id === peerCancellationId).length,
  1,
);

const acknowledgedOriginalId = "peer-already-acknowledged";
writeInbound({ id: acknowledgedOriginalId, kind: "message" });
tool("receive_messages");
tool("acknowledge_message", { message_id: acknowledgedOriginalId, deliver: false });
const tooLateCancellationId = "peer-cancellation-too-late";
writeInbound({
  id: tooLateCancellationId,
  kind: "cancellation",
  correlation_id: acknowledgedOriginalId,
  metadata: { message_cancellation: { message_id: acknowledgedOriginalId } },
});
messages("inbound");
const tooLateReceipt = messages("outbound")
  .find((entry) => entry.correlation_id === tooLateCancellationId);
assert.equal(tooLateReceipt.metadata.message_cancellation.result, "too_late");
assert.equal(messages("inbound").find((entry) => entry.id === acknowledgedOriginalId)?.state, "acknowledged");

const inFlightOriginalId = "peer-in-flight";
writeInbound({ id: inFlightOriginalId, kind: "message" });
tool("receive_messages");
const lease = path.join(audit, "wake-test.lock");
fs.mkdirSync(lease);
fs.writeFileSync(path.join(lease, "owner.json"), `${JSON.stringify({
  schema_version: 1,
  message_id: inFlightOriginalId,
  pid: process.pid,
  state: "running",
  deadline_at: new Date(Date.now() + 60000).toISOString(),
})}\n`);
const inFlightCancellationId = "peer-cancellation-in-flight";
writeInbound({
  id: inFlightCancellationId,
  kind: "cancellation",
  correlation_id: inFlightOriginalId,
  metadata: { message_cancellation: { message_id: inFlightOriginalId } },
});
messages("inbound");
const inFlightReceipt = messages("outbound")
  .find((entry) => entry.correlation_id === inFlightCancellationId);
assert.equal(inFlightReceipt.metadata.message_cancellation.result, "in_flight");
assert.equal(messages("inbound").find((entry) => entry.id === inFlightOriginalId)?.state, "received");

const cancellationMessages = messages("inbound")
  .filter((entry) => entry.kind === "cancellation");
assert.equal(cancellationMessages.every((entry) => entry.state === "acknowledged"), true);
assert.equal(fs.readFileSync(routeLog, "utf8").includes("wake-runner.mjs"), false);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("durable message cancellation tests passed\n");
