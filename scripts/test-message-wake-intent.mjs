#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-wake-intent-"));
const bin = path.join(root, "bin");
const routeLog = path.join(root, "route.log");
const wakeMarker = path.join(root, "wake-marker");
const configPath = path.join(root, "config.json");
const outbox = path.join(root, "outbox");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(outbox, { recursive: true });
fs.writeFileSync(wakeMarker, "busy\n");

fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "$HAWKSPAN_TEST_ROUTE_LOG"
case "$*" in
  *installed-revision.json*)
    printf '%s\\n' '{"schema_version":2,"revision":"test-revision","active_release_root":"/peer/release"}'
    exit 0
    ;;
  *wake-runner.mjs*)
    marker=$(tr -d '\\n' < "$HAWKSPAN_TEST_WAKE_MARKER")
    case "$marker" in
      started)
        printf '%s\\n' '{"schema_version":1,"status":"started","pid":1234}'
        exit 0
        ;;
      busy)
        printf '%s\\n' '{"schema_version":1,"status":"busy","active_message_id":"active-message"}'
        exit 73
        ;;
      failed)
        printf '%s\\n' '{"schema_version":1,"status":"failed","error":"runner rejected request"}'
        exit 1
        ;;
    esac
    ;;
  *"mkdir -p"*)
    exit 0
    ;;
esac
exit 2
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "rsync"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\\n' '--partial --append-verify'
  exit 0
fi
printf 'rsync %s\\n' "$*" >> "$HAWKSPAN_TEST_ROUTE_LOG"
exit 0
`, { mode: 0o755 });

fs.writeFileSync(configPath, `${JSON.stringify({
  schema_version: 1,
  node_id: "wake-intent-test",
  peer: {
    node_id: "peer",
    user: "peeruser",
    primary_enabled: true,
    primary_host: "192.0.2.20",
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

const legacyEnvelopePath = path.join(outbox, "legacy-message.json");
fs.writeFileSync(legacyEnvelopePath, `${JSON.stringify({
  schema_version: 1,
  id: "legacy-message",
  created_at: "2026-08-16T00:00:00.000Z",
  sender: "wake-intent-test",
  recipient: "peer",
  kind: "message",
  subject: "legacy",
  body: "legacy envelope without wake_requested",
  correlation_id: null,
  metadata: {},
}, null, 2)}\n`);
const legacyDb = new DatabaseSync(path.join(root, "spool.sqlite3"));
legacyDb.exec(`
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    correlation_id TEXT,
    direction TEXT NOT NULL,
    state TEXT NOT NULL,
    envelope_path TEXT NOT NULL,
    delivered_via TEXT,
    acknowledged_at TEXT,
    metadata_json TEXT NOT NULL
  );
`);
legacyDb.prepare(`
  INSERT INTO messages
    (id,created_at,sender,recipient,kind,subject,body,correlation_id,
     direction,state,envelope_path,metadata_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  "legacy-message",
  "2026-08-16T00:00:00.000Z",
  "wake-intent-test",
  "peer",
  "message",
  "legacy",
  "legacy envelope without wake_requested",
  null,
  "outbound",
  "delivered",
  legacyEnvelopePath,
  "{}",
);
legacyDb.close();

const environment = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  HAWKSPAN_STATE_DIR: root,
  HAWKSPAN_CONFIG: configPath,
  HAWKSPAN_TEST_ROUTE_LOG: routeLog,
  HAWKSPAN_TEST_WAKE_MARKER: wakeMarker,
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

function toolError(name, args = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(scripts, "call-tool.mjs"), name, JSON.stringify(args)],
    { encoding: "utf8", timeout: 30000, env: environment },
  );
  assert.equal(result.status, 1, result.stderr);
  const response = JSON.parse(result.stderr.slice(result.stderr.indexOf("{")));
  assert.equal(response.isError, true);
  return response.content?.[0]?.text || "";
}

const afterMigration = tool("list_messages", { direction: "outbound" });
assert.equal(afterMigration.find((entry) => entry.id === "legacy-message")?.wake_requested, true);
const migratedDb = new DatabaseSync(path.join(root, "spool.sqlite3"));
assert.equal(
  migratedDb.prepare("SELECT wake_requested FROM messages WHERE id='legacy-message'").get().wake_requested,
  1,
);
migratedDb.close();

assert.match(
  toolError("send_message", {
    subject: "missing exact target",
    body: "must not create a targetless actionable message",
  }),
  /exact target_thread_id/,
);

const legacyFlagsIgnored = tool("send_message", {
  target_thread_id: "00000000-0000-0000-0000-000000000009",
  subject: "obsolete no-wake flags",
  body: "stale clients cannot suppress delivery or wake",
  deliver: false,
  wake: false,
});
assert.equal(legacyFlagsIgnored.delivery.ok, true);
assert.equal(legacyFlagsIgnored.wake_requested, true);
assert.equal(legacyFlagsIgnored.wake.busy, true);
assert.equal(
  JSON.parse(fs.readFileSync(legacyFlagsIgnored.envelope_path, "utf8")).wake_requested,
  true,
);
const retrySuppressionIgnored = tool("retry_message", {
  message_id: legacyFlagsIgnored.message_id,
  wake: false,
});
assert.equal(retrySuppressionIgnored.wake_requested, true);
assert.equal(retrySuppressionIgnored.wake.busy, true);
fs.writeFileSync(path.join(root, "inbox", "legacy-flags-ack.json"), `${JSON.stringify({
  schema_version: 1,
  id: "legacy-flags-ack",
  created_at: new Date().toISOString(),
  sender: "peer",
  recipient: "wake-intent-test",
  kind: "acknowledgement",
  subject: "obsolete flags ignored",
  body: "accepted",
  correlation_id: legacyFlagsIgnored.message_id,
  metadata: {},
})}\n`);
tool("receive_messages");

const queued = tool("enqueue_queue_item", {
  queue_id: "hawkspan-messages",
  item_id: "queued-obsolete-no-wake",
  payload: {
    target_thread_id: "00000000-0000-0000-0000-000000000009",
    subject: "queue obsolete no wake",
    body: "message adapter must normalize obsolete suppression away",
    wake: false,
  },
});
assert.deepEqual(Object.keys(queued.item.payload), ["message_id"]);
const queueMessage = tool("list_messages", { direction: "outbound" })
  .find((entry) => entry.subject === "queue obsolete no wake");
assert.equal(queueMessage.wake_requested, true);
fs.writeFileSync(path.join(root, "inbox", "queued-message-ack.json"), `${JSON.stringify({
  schema_version: 1,
  id: "queued-message-ack",
  created_at: new Date().toISOString(),
  sender: "peer",
  recipient: "wake-intent-test",
  kind: "acknowledgement",
  subject: "queued message accepted",
  body: "accepted",
  correlation_id: queueMessage.id,
  metadata: {},
})}\n`);
tool("receive_messages");
tool("queue_control", {
  queue_id: "hawkspan-messages",
  item_id: "queued-obsolete-no-wake",
  action: "cancel-item",
  reason: "test cleanup after wake-intent assertion",
});

fs.writeFileSync(path.join(root, "inbox", "protocol-source.json"), `${JSON.stringify({
  schema_version: 1,
  id: "protocol-source",
  created_at: new Date().toISOString(),
  sender: "peer",
  recipient: "wake-intent-test",
  kind: "message",
  subject: "protocol receipt source",
  body: "acknowledge silently",
  correlation_id: null,
  metadata: {},
})}\n`);
tool("receive_messages");
const protocolReceipt = tool("acknowledge_message", { message_id: "protocol-source" });
assert.equal(protocolReceipt.wake_requested, false);
assert.equal(protocolReceipt.wake, null);

const preDurableRoutes = fs.readFileSync(routeLog, "utf8");

const durable = tool("send_message", {
  target_thread_id: "00000000-0000-0000-0000-000000000009",
  subject: "durable wake pending",
  body: "delivery succeeds while receiver is busy",
});
assert.equal(durable.delivery.ok, true);
assert.equal(durable.wake.busy, true);
assert.equal(durable.wake_pending, true);
const durableEnvelopeBefore = fs.readFileSync(durable.envelope_path);
const durableEnvelopePath = durable.envelope_path;
const durableRow = tool("list_messages", { direction: "outbound" })
  .find((entry) => entry.id === durable.message_id);
assert.equal(durableRow.state, "wake_pending");
const pendingQueue = tool("queue_status", { queue_id: "hawkspan-messages" })
  .items.find((entry) => entry.item_id === `message-${durable.message_id}`);
assert.equal(pendingQueue.state, "queued");

fs.writeFileSync(wakeMarker, "started\n");
const restartedSupervisor = tool("supervise_queue", {
  queue_id: "hawkspan-messages",
  worker_id: "wake-restart-worker",
  max_items: 1,
});
assert.equal(restartedSupervisor.outcomes[0].item_id, `message-${durable.message_id}`);
assert.equal(restartedSupervisor.outcomes[0].state, "queued");
assert.equal(restartedSupervisor.outcomes[0].deferred, true);
assert.equal(restartedSupervisor.outcomes[0].result.delivery.already_delivered, true);
assert.equal(restartedSupervisor.outcomes[0].result.wake.ok, true);
assert.deepEqual(fs.readFileSync(durableEnvelopePath), durableEnvelopeBefore);

fs.writeFileSync(path.join(root, "inbox", "durable-ack.json"), `${JSON.stringify({
  schema_version: 1,
  id: "durable-ack",
  created_at: new Date().toISOString(),
  sender: "peer",
  recipient: "wake-intent-test",
  kind: "acknowledgement",
  subject: "durable accepted",
  body: "accepted",
  correlation_id: durable.message_id,
  metadata: { acknowledged_message_id: durable.message_id },
})}\n`);
const acceptedRetry = tool("retry_message", {
  message_id: durable.message_id,
});
assert.equal(acceptedRetry.wake_pending, false);
assert.equal(acceptedRetry.delivery.already_delivered, true);
assert.equal(acceptedRetry.wake, null);
const afterAcceptance = tool("flush_outbox");
assert.equal(
  afterAcceptance.messages.some((entry) => entry.message_id === durable.message_id),
  false,
);
const acceptedRow = tool("list_messages", { direction: "outbound" })
  .find((entry) => entry.id === durable.message_id);
assert.equal(acceptedRow.state, "acknowledged");
const acceptedQueue = tool("queue_status", { queue_id: "hawkspan-messages" })
  .items.find((entry) => entry.item_id === `message-${durable.message_id}`);
assert.equal(acceptedQueue.state, "cancelled");
const afterAcceptedSupervisor = tool("supervise_queue", {
  queue_id: "hawkspan-messages",
  worker_id: "wake-after-ack-worker",
  max_items: 1,
});
assert.equal(afterAcceptedSupervisor.idle, true);
tool("flush_outbox");

const durableRoutes = fs.readFileSync(routeLog, "utf8").slice(preDurableRoutes.length);
assert.equal(durableRoutes.split("\n").filter((line) => line.includes("wake-runner.mjs")).length, 2);
assert.equal(durableRoutes.split("\n").filter((line) => line.startsWith("rsync ")).length, 1);
assert.deepEqual(fs.readFileSync(durableEnvelopePath), durableEnvelopeBefore);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("immutable message wake-intent tests passed\n");
