#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-message-pruning-"));
const inbox = path.join(root, "inbox");
const outbox = path.join(root, "outbox");
const configPath = path.join(root, "config.json");
fs.mkdirSync(inbox, { recursive: true });
fs.mkdirSync(outbox, { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify({
  schema_version: 1,
  node_id: "pruning-test",
  peer: null,
  local_control: { enabled: false },
}, null, 2)}\n`);

const environment = {
  ...process.env,
  HAWKSPAN_STATE_DIR: root,
  HAWKSPAN_CONFIG: configPath,
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

tool("list_messages");
const db = new DatabaseSync(path.join(root, "spool.sqlite3"));
const insert = db.prepare(`
  INSERT INTO messages
    (id,created_at,sender,recipient,kind,subject,body,correlation_id,direction,
     state,envelope_path,delivered_via,acknowledged_at,pruned_at,wake_requested,
     metadata_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const old = "2026-01-01T00:00:00.000Z";
const recent = "2026-07-01T00:00:00.000Z";
const cutoff = "2026-06-01T00:00:00.000Z";

function seed({
  id,
  direction,
  state,
  kind = "message",
  correlationId = null,
  metadata = {},
  createdAt = old,
}) {
  const directory = direction === "inbound" ? inbox : outbox;
  const envelopePath = path.join(directory, `${id}.json`);
  const envelope = {
    schema_version: 1,
    id,
    created_at: createdAt,
    sender: direction === "inbound" ? "peer" : "pruning-test",
    recipient: direction === "inbound" ? "pruning-test" : "peer",
    kind,
    subject: `subject ${id}`,
    body: `body ${id}`,
    correlation_id: correlationId,
    metadata,
  };
  fs.writeFileSync(envelopePath, `${JSON.stringify(envelope)}\n`);
  insert.run(
    id,
    createdAt,
    envelope.sender,
    envelope.recipient,
    kind,
    envelope.subject,
    envelope.body,
    correlationId,
    direction,
    state,
    envelopePath,
    null,
    state === "acknowledged" ? old : null,
    null,
    direction === "outbound" ? 1 : 0,
    JSON.stringify(metadata),
  );
  return envelopePath;
}

const paths = new Map();
for (const record of [
  { id: "ack-in", direction: "inbound", state: "acknowledged" },
  {
    id: "cancel-in-control",
    direction: "inbound",
    state: "acknowledged",
    kind: "cancellation",
    correlationId: "cancelled-in",
    metadata: { message_cancellation: { message_id: "cancelled-in" } },
  },
  { id: "cancelled-in", direction: "inbound", state: "cancelled" },
  { id: "ack-out", direction: "outbound", state: "acknowledged" },
  { id: "cancelled-out-applied", direction: "outbound", state: "cancelled" },
  {
    id: "cancel-out-applied-control",
    direction: "outbound",
    state: "acknowledged",
    kind: "cancellation",
    correlationId: "cancelled-out-applied",
    metadata: { message_cancellation: { message_id: "cancelled-out-applied" } },
  },
  {
    id: "cancel-out-applied-receipt",
    direction: "inbound",
    state: "acknowledged",
    kind: "acknowledgement",
    correlationId: "cancel-out-applied-control",
    metadata: {
      message_cancellation: { message_id: "cancelled-out-applied", result: "applied" },
    },
  },
  { id: "cancelled-out-pending", direction: "outbound", state: "cancelled" },
  {
    id: "cancel-out-pending-control",
    direction: "outbound",
    state: "delivered",
    kind: "cancellation",
    correlationId: "cancelled-out-pending",
  },
  { id: "received-in", direction: "inbound", state: "received" },
  { id: "delivered-out", direction: "outbound", state: "delivered" },
  {
    id: "delivered-ack",
    direction: "outbound",
    state: "delivered",
    kind: "acknowledgement",
  },
  {
    id: "recent-ack",
    direction: "inbound",
    state: "acknowledged",
    createdAt: recent,
  },
]) {
  paths.set(record.id, seed(record));
}
db.close();

const preview = tool("prune_terminal_messages", { before: cutoff });
assert.equal(preview.dry_run, true);
assert.equal(preview.candidate_count, 9);
assert.equal(preview.selected_count, 8);
assert.equal(preview.pruned_count, 0);
assert.deepEqual(
  new Set(preview.skipped.map((entry) => entry.message_id)),
  new Set(["cancelled-out-pending"]),
);
for (const id of preview.selected.map((entry) => entry.message_id)) {
  assert.equal(fs.existsSync(paths.get(id)), true);
}

const executed = tool("prune_terminal_messages", { before: cutoff, dry_run: false });
assert.equal(executed.pruned_count, 8);
assert.equal(executed.already_pruned_count, 0);
assert(executed.payload_bytes_selected > 0);
assert(executed.envelope_bytes_selected > 0);
for (const entry of executed.outcomes) {
  assert.equal(fs.existsSync(paths.get(entry.message_id)), false);
}
for (const id of [
  "cancelled-out-pending",
  "cancel-out-pending-control",
  "received-in",
  "delivered-out",
  "recent-ack",
]) {
  assert.equal(fs.existsSync(paths.get(id)), true);
}

const operational = tool("list_messages", { limit: 1000 });
assert.equal(operational.length, 5);
assert.equal(operational.some((entry) => entry.id === "ack-in"), false);
const preserved = tool("list_messages", { include_pruned: true, limit: 1000 });
assert.equal(preserved.length, 13);
const preservedCancellation = preserved.find((entry) => entry.id === "cancel-in-control");
assert.equal(preservedCancellation.pruned_at !== null, true);
assert.equal(preservedCancellation.subject, "");
assert.equal(preservedCancellation.body, "");
assert.equal(preservedCancellation.state, "acknowledged");
assert.equal(preservedCancellation.correlation_id, "cancelled-in");
assert.equal(
  preservedCancellation.metadata.message_cancellation.message_id,
  "cancelled-in",
);
const preservedReceipt = preserved.find((entry) => entry.id === "cancel-out-applied-receipt");
assert.equal(preservedReceipt.metadata.message_cancellation.result, "applied");

const repeated = tool("prune_terminal_messages", {
  before: cutoff,
  message_ids: ["ack-in"],
  dry_run: false,
});
assert.equal(repeated.pruned_count, 0);
assert.equal(repeated.already_pruned_count, 1);

fs.writeFileSync(paths.get("ack-in"), `${JSON.stringify({
  schema_version: 1,
  id: "ack-in",
  created_at: old,
  sender: "peer",
  recipient: "pruning-test",
  kind: "message",
  subject: "replayed subject",
  body: "replayed body",
  metadata: {},
})}\n`);
tool("receive_messages", { include_acknowledged: true, limit: 1000 });
assert.equal(fs.existsSync(paths.get("ack-in")), false);
const afterReplay = tool("list_messages", { include_pruned: true, limit: 1000 })
  .filter((entry) => entry.id === "ack-in");
assert.equal(afterReplay.length, 1);
assert.equal(afterReplay[0].state, "acknowledged");
assert.equal(afterReplay[0].subject, "");
assert.equal(afterReplay[0].body, "");

const audit = tool("list_audit_events", { object_type: "message", limit: 5000 });
assert.equal(audit.filter((entry) => entry.action === "prune").length, 8);
assert.equal(
  audit.some((entry) => entry.action === "drop_replay" && entry.object_id === "ack-in"),
  true,
);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("message pruning tests passed\n");
