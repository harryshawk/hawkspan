#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createQueueRegistry } from "./queue-registry.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-queue-registry-"));
const db = new DatabaseSync(path.join(root, "registry.sqlite3"));
db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
const registry = createQueueRegistry(db, {
  retryDelaysMs: [100, 200],
  maximumAttempts: 2,
  retryJitter: false,
});

const created = registry.createQueue({
  queue_id: "renders",
  name: "Render jobs",
  kind: "application",
  adapter: "tool:render_image",
  concurrency: 2,
  ordering: "priority",
});
assert.equal(created.created, true);
assert.equal(registry.createQueue({
  queue_id: "renders", kind: "application", adapter: "tool:render_image",
}).already_present, true);
assert.throws(() => registry.createQueue({
  queue_id: "renders", kind: "application", adapter: "command",
}), /refusing to replace queue with different identity/);

const configured = registry.configureQueue({
  queue_id: "renders",
  name: "Priority renders",
  concurrency: 1,
  priority: 25,
  ordering: "priority",
  maximum_attempts: 2,
  maximum_pending_items: 20,
  maximum_payload_bytes: 4096,
  retry_delays_ms: [100, 200],
  metadata: { owner: "queue-registry-test" },
});
assert.equal(configured.queue.name, "Priority renders");
assert.equal(configured.queue.concurrency, 1);
assert.equal(configured.queue.priority, 25);
assert.equal(configured.queue.ordering, "priority");
assert.equal(configured.queue.maximum_attempts, 2);
assert.equal(configured.queue.maximum_pending_items, 20);
assert.equal(configured.queue.maximum_payload_bytes, 4096);
assert.deepEqual(configured.queue.retry_delays_ms, [100, 200]);
assert.deepEqual(configured.queue.metadata, { owner: "queue-registry-test" });

const batch = registry.enqueueBatch({
  queue_id: "renders",
  items: [
    { item_id: "later", priority: 20, payload: { prompt: "later" } },
    { item_id: "first", priority: 10, payload: { prompt: "first" } },
  ],
});
assert.equal(batch.items.length, 2);
assert.equal(registry.control({
  queue_id: "renders", action: "set-priority", item_id: "first", priority: 5,
}).item.priority, 5);

registry.control({ queue_id: "renders", action: "pause-queue" });
assert.equal(registry.claim({
  queue_id: "renders", worker_id: "paused-worker", lease_ms: 1000,
}).claimed, false);
registry.control({ queue_id: "renders", action: "resume-queue" });

const first = registry.claim({ queue_id: "renders", worker_id: "worker-1", lease_ms: 1000 });
assert.equal(first.item.item_id, "first");
assert.equal(first.item.attempts, 1);
assert.throws(() => registry.control({
  queue_id: "renders", action: "pause-item", item_id: "first",
}), /does not allow item state running/);
const blockedByConcurrency = registry.claim({
  queue_id: "renders", worker_id: "worker-2", lease_ms: 1000,
});
assert.equal(blockedByConcurrency.claimed, false);
assert.equal(blockedByConcurrency.reason, "queue concurrency limit reached");
const retried = registry.fail({
  queue_id: "renders", item_id: "first", worker_id: "worker-1",
  lease_token: first.item.lease_token, error: "temporary",
});
assert.equal(retried.state, "queued");
assert(retried.next_attempt_at);

const later = registry.claim({ queue_id: "renders", worker_id: "worker-2", lease_ms: 1000 });
assert.equal(later.item.item_id, "later");
const renewedLater = registry.renewLease({
  queue_id: "renders", item_id: "later", worker_id: "worker-2",
  lease_token: later.item.lease_token, lease_ms: 2000,
});
assert(Date.parse(renewedLater.lease_expires_at) > Date.parse(later.item.lease_expires_at));
assert.equal(registry.complete({
  queue_id: "renders", item_id: "later", worker_id: "worker-2",
  lease_token: later.item.lease_token, result: { ok: true },
}).state, "completed");

registry.enqueueItem({ queue_id: "renders", item_id: "repair", priority: 40, payload: { prompt: "repair" } });
const repairClaim = registry.claim({ queue_id: "renders", worker_id: "worker-repair", lease_ms: 1000 });
registry.fail({
  queue_id: "renders", item_id: "repair", worker_id: "worker-repair",
  lease_token: repairClaim.item.lease_token, error: "system defect",
});
const reset = registry.control({
  queue_id: "renders", action: "reset-attempts", item_id: "repair",
  reason: "system-induced attempts repaired",
});
assert.equal(reset.item.state, "queued");
assert.equal(reset.item.attempts, 0);
assert.equal(reset.item.error, "system-induced attempts repaired");

registry.enqueueItem({ queue_id: "renders", item_id: "deferred", priority: 5, payload: { prompt: "deferred" } });
const deferredClaim = registry.claim({ queue_id: "renders", worker_id: "worker-defer", lease_ms: 1000 });
assert.equal(deferredClaim.item.item_id, "deferred");
const deferred = registry.defer({
  queue_id: "renders", item_id: "deferred", worker_id: "worker-defer",
  lease_token: deferredClaim.item.lease_token,
  delay_ms: 1000, reason: "application busy",
});
assert.equal(deferred.state, "queued");
assert.equal(deferred.attempts, 0);
assert.equal(deferred.error, "application busy");
assert.ok(Date.parse(deferred.next_attempt_at) > Date.now());

await new Promise((resolve) => setTimeout(resolve, 120));
const retry = registry.claim({ queue_id: "renders", worker_id: "worker-1", lease_ms: 1000 });
assert.equal(retry.item.item_id, "first");
const exhausted = registry.fail({
  queue_id: "renders", item_id: "first", worker_id: "worker-1",
  lease_token: retry.item.lease_token, error: "permanent",
});
assert.equal(exhausted.state, "failed");

registry.control({ queue_id: "renders", action: "retry-item", item_id: "first" });
registry.control({ queue_id: "renders", action: "pause-item", item_id: "first" });
assert.equal(registry.queueStatus({ queue_id: "renders" }).items.find(
  (item) => item.item_id === "first",
).state, "paused");
registry.control({ queue_id: "renders", action: "resume-item", item_id: "first" });
assert.equal(registry.queueStatus({ queue_id: "renders" }).items.find(
  (item) => item.item_id === "first",
).state, "queued");
registry.control({ queue_id: "renders", action: "skip-item", item_id: "first" });
registry.control({ queue_id: "renders", action: "retry-item", item_id: "first" });
registry.control({ queue_id: "renders", action: "cancel-item", item_id: "first" });
registry.control({ queue_id: "renders", action: "retry-item", item_id: "first" });
assert.equal(registry.control({
  queue_id: "renders", action: "clear-pending", reason: "clear test",
}).cleared, 3);

const finalStatus = registry.queueStatus({ queue_id: "renders" });
assert.equal(finalStatus.items.find((item) => item.item_id === "later").state, "completed");
assert.equal(finalStatus.items.find((item) => item.item_id === "first").state, "cancelled");
assert.equal(finalStatus.items.find((item) => item.item_id === "deferred").state, "cancelled");
assert.equal(finalStatus.items.find((item) => item.item_id === "repair").state, "cancelled");
registry.control({ queue_id: "renders", action: "archive-queue" });
assert.equal(registry.listQueues().queues[0].state, "archived");
assert.throws(() => registry.deleteQueue({ queue_id: "renders" }), /must be empty/);

registry.createQueue({ queue_id: "empty", adapter: "command" });
assert.equal(registry.deleteQueue({ queue_id: "empty" }).deleted, true);

db.close();
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("queue registry tests passed\n");
