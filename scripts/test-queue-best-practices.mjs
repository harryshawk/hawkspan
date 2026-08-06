#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createQueueRegistry } from "./queue-registry.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-queue-practices-"));
const db = new DatabaseSync(path.join(root, "registry.sqlite3"));
db.exec(`
  PRAGMA foreign_keys=ON;
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA busy_timeout=10000;
`);
const registry = createQueueRegistry(db, {
  retryDelaysMs: [100, 200],
  maximumAttempts: 2,
});

function item(queueId, itemId) {
  return registry.queueStatus({ queue_id: queueId, limit: 1000 }).items
    .find((entry) => entry.item_id === itemId);
}

try {
  registry.createQueue({
    queue_id: "priority-work",
    adapter: "command",
    concurrency: 2,
    ordering: "priority",
    maximum_attempts: 2,
    retry_delays_ms: [100, 200],
  });

  const original = registry.enqueueItem({
    queue_id: "priority-work",
    item_id: "stable-request",
    payload: { command: "/usr/bin/true" },
  });
  const duplicate = registry.enqueueItem({
    queue_id: "priority-work",
    item_id: "stable-request",
    payload: { command: "/usr/bin/true" },
  });
  assert.equal(duplicate.already_present, true, "same id and intent must be idempotent");
  assert.deepEqual(duplicate.item, original.item);
  assert.throws(() => registry.enqueueItem({
    queue_id: "priority-work",
    item_id: "stable-request",
    payload: { command: "/usr/bin/false" },
  }), /refusing to replace differing queue item/);

  assert.throws(() => registry.enqueueBatch({
    queue_id: "priority-work",
    items: [
      { item_id: "must-roll-back", payload: { command: "/usr/bin/true" } },
      { item_id: "stable-request", payload: { command: "/usr/bin/false" } },
    ],
  }), /refusing to replace differing queue item/);
  assert.equal(item("priority-work", "must-roll-back"), undefined, "batch must roll back as one unit");

  registry.enqueueBatch({
    queue_id: "priority-work",
    items: [
      { item_id: "priority-later", priority: 20, payload: {} },
      { item_id: "priority-first", priority: 10, payload: {} },
    ],
  });
  const priorityClaim = registry.claim({
    queue_id: "priority-work", worker_id: "priority-worker", lease_ms: 1000,
  });
  assert.equal(priorityClaim.item.item_id, "priority-first");
  const priorityLaterClaim = registry.claim({
    queue_id: "priority-work", worker_id: "second-worker", lease_ms: 1000,
  });
  assert.equal(priorityLaterClaim.item.item_id, "priority-later", "a live lease must exclude the claimed item");

  assert.throws(() => registry.complete({
    queue_id: "priority-work",
    item_id: "priority-first",
    worker_id: "wrong-worker",
    lease_token: priorityClaim.item.lease_token,
    result: {},
  }), /does not own/);
  registry.complete({
    queue_id: "priority-work",
    item_id: "priority-first",
    worker_id: "priority-worker",
    lease_token: priorityClaim.item.lease_token,
    result: { ok: true },
  });
  registry.complete({
    queue_id: "priority-work",
    item_id: "priority-later",
    worker_id: "second-worker",
    lease_token: priorityLaterClaim.item.lease_token,
    result: { ok: true },
  });

  registry.createQueue({ queue_id: "fifo-work", adapter: "command", ordering: "fifo" });
  registry.enqueueBatch({
    queue_id: "fifo-work",
    items: [
      { item_id: "fifo-first", priority: 100, payload: {} },
      { item_id: "fifo-second", priority: -100, payload: {} },
    ],
  });
  const fifoClaim = registry.claim({ queue_id: "fifo-work", worker_id: "fifo-worker", lease_ms: 1000 });
  assert.equal(fifoClaim.item.item_id, "fifo-first", "FIFO must ignore item priority");
  registry.complete({
    queue_id: "fifo-work", item_id: "fifo-first", worker_id: "fifo-worker",
    lease_token: fifoClaim.item.lease_token, result: {},
  });

  registry.control({ queue_id: "fifo-work", action: "pause-queue" });
  assert.equal(registry.claim({
    queue_id: "fifo-work", worker_id: "paused-worker", lease_ms: 1000,
  }).claimed, false);
  registry.control({ queue_id: "fifo-work", action: "resume-queue" });

  const expiring = registry.claim({
    queue_id: "fifo-work", worker_id: "expired-worker", lease_ms: 1000,
  });
  db.prepare("UPDATE queue_items SET lease_expires_at=? WHERE id=?")
    .run("1970-01-01T00:00:00.000Z", expiring.item.item_id);
  const recovered = registry.claim({
    queue_id: "fifo-work", worker_id: "recovery-worker", lease_ms: 1000,
  });
  assert.equal(recovered.item.item_id, expiring.item.item_id);
  assert.equal(recovered.recovered_expired_leases, 1);
  assert.equal(recovered.item.attempts, 2, "lease recovery is an at-least-once retry");
  assert.throws(() => registry.complete({
    queue_id: "fifo-work", item_id: recovered.item.item_id,
    worker_id: "expired-worker", lease_token: expiring.item.lease_token, result: {},
  }), /does not own/, "an expired claim token must be fenced after recovery");
  const terminal = registry.fail({
    queue_id: "fifo-work",
    item_id: recovered.item.item_id,
    worker_id: "recovery-worker",
    lease_token: recovered.item.lease_token,
    error: "poison item",
  });
  assert.equal(terminal.state, "failed", "retry exhaustion must become terminal");
  assert.equal(terminal.next_attempt_at, null);

  registry.createQueue({
    queue_id: "bounded-work", adapter: "command",
    maximum_pending_items: 1, maximum_payload_bytes: 1024,
  });
  registry.enqueueItem({ queue_id: "bounded-work", item_id: "one", payload: {} });
  assert.throws(() => registry.enqueueItem({
    queue_id: "bounded-work", item_id: "two", payload: {},
  }), /admission limit reached/);
  assert.throws(() => registry.enqueueItem({
    queue_id: "bounded-work", item_id: "large", payload: { body: "x".repeat(2048) },
  }), /maximum_payload_bytes/);

  registry.control({ queue_id: "fifo-work", action: "archive-queue" });
  assert.throws(() => registry.enqueueItem({
    queue_id: "fifo-work", item_id: "after-archive", payload: {},
  }), /queue is archived/);

  const priorityStatus = registry.queueStatus({ queue_id: "priority-work", limit: 1000 });
  assert.equal(priorityStatus.items.some((entry) => entry.queue_id === "fifo-work"), false);
  assert.throws(() => registry.deleteQueue({ queue_id: "fifo-work" }), /must be empty/);

process.stdout.write("focused queue safety tests passed\n");
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
