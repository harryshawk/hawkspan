import crypto from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const QUEUE_STATES = new Set(["running", "paused", "archived"]);
const ITEM_STATES = new Set([
  "queued", "running", "paused", "completed", "failed", "cancelled", "skipped",
]);

function timestamp() {
  return new Date().toISOString();
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  return JSON.parse(value);
}

function itemId() {
  return `item-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function assertId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must contain only letters, digits, dot, underscore, or hyphen`);
  }
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function retryDelays(value, fallback) {
  const candidate = value ?? fallback;
  if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 16) {
    throw new Error("retry_delays_ms must contain 1 to 16 delays");
  }
  return candidate.map((entry) => integer(entry, "retry delay", 100, 3600000));
}

function publicQueue(row) {
  return {
    queue_id: row.id,
    name: row.name,
    kind: row.kind,
    adapter: row.adapter,
    state: row.state,
    concurrency: row.concurrency,
    priority: row.priority,
    ordering: row.ordering,
    maximum_attempts: row.maximum_attempts,
    maximum_pending_items: row.maximum_pending_items,
    maximum_payload_bytes: row.maximum_payload_bytes,
    retry_delays_ms: parseJson(row.retry_delays_json, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: parseJson(row.metadata_json),
  };
}

function publicItem(row) {
  return {
    item_id: row.id,
    queue_id: row.queue_id,
    state: row.state,
    priority: row.priority,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at,
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
    lease_generation: row.lease_generation,
    lease_token: row.lease_token,
    created_at: row.created_at,
    updated_at: row.updated_at,
    payload: parseJson(row.payload_json),
    result: parseJson(row.result_json, null),
    error: row.error,
  };
}

export function createQueueRegistry(db, options = {}) {
  const defaultRetryDelays = retryDelays(options.retryDelaysMs, [2000, 5000, 10000, 20000]);
  const defaultMaximumAttempts = integer(options.maximumAttempts ?? 5, "maximum_attempts", 1, 100);
  const random = options.random || Math.random;
  const retryJitter = options.retryJitter !== false;
  const defaultMaximumPendingItems = integer(
    options.maximumPendingItems ?? 10000, "maximum_pending_items", 1, 1000000,
  );
  const defaultMaximumPayloadBytes = integer(
    options.maximumPayloadBytes ?? 1024 * 1024, "maximum_payload_bytes", 1024, 16 * 1024 * 1024,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS queues (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      adapter TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','paused','archived')),
      concurrency INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      ordering TEXT NOT NULL CHECK(ordering IN ('fifo','priority')),
      maximum_attempts INTEGER NOT NULL,
      maximum_pending_items INTEGER NOT NULL DEFAULT 10000,
      maximum_payload_bytes INTEGER NOT NULL DEFAULT 1048576,
      retry_delays_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','paused','completed','failed','cancelled','skipped')),
      priority INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS queue_items_eligible
      ON queue_items(queue_id,state,next_attempt_at,priority,created_at);
  `);
  const itemColumns = new Set(db.prepare("PRAGMA table_info(queue_items)").all().map((row) => row.name));
  if (!itemColumns.has("lease_generation")) {
    db.exec("ALTER TABLE queue_items ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0");
  }
  if (!itemColumns.has("lease_token")) {
    db.exec("ALTER TABLE queue_items ADD COLUMN lease_token TEXT");
  }
  const queueColumns = new Set(db.prepare("PRAGMA table_info(queues)").all().map((row) => row.name));
  if (!queueColumns.has("maximum_pending_items")) {
    db.exec("ALTER TABLE queues ADD COLUMN maximum_pending_items INTEGER NOT NULL DEFAULT 10000");
  }
  if (!queueColumns.has("maximum_payload_bytes")) {
    db.exec("ALTER TABLE queues ADD COLUMN maximum_payload_bytes INTEGER NOT NULL DEFAULT 1048576");
  }

  const getQueueRow = (queueId) => {
    assertId(queueId, "queue_id");
    const row = db.prepare("SELECT * FROM queues WHERE id=?").get(queueId);
    if (!row) throw new Error(`queue not found: ${queueId}`);
    return row;
  };

  const getItemRow = (queueId, requestedItemId) => {
    getQueueRow(queueId);
    assertId(requestedItemId, "item_id");
    const row = db.prepare("SELECT * FROM queue_items WHERE id=? AND queue_id=?")
      .get(requestedItemId, queueId);
    if (!row) throw new Error(`queue item not found: ${requestedItemId}`);
    return row;
  };

  function createQueue(args) {
    const queueId = String(args.queue_id || "").trim();
    assertId(queueId, "queue_id");
    const adapter = String(args.adapter || "").trim();
    assertId(adapter.replace(/^tool:/, ""), "adapter");
    if (!adapter) throw new Error("adapter is required");
    const current = db.prepare("SELECT * FROM queues WHERE id=?").get(queueId);
    if (current) {
      const stable = publicQueue(current);
      if (stable.adapter !== adapter || stable.kind !== String(args.kind || "generic")) {
        throw new Error(`refusing to replace queue with different identity: ${queueId}`);
      }
      return { created: false, already_present: true, queue: stable };
    }
    const createdAt = timestamp();
    db.prepare(`
      INSERT INTO queues
        (id,created_at,updated_at,name,kind,adapter,state,concurrency,priority,
         ordering,maximum_attempts,maximum_pending_items,maximum_payload_bytes,
         retry_delays_json,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      queueId,
      createdAt,
      createdAt,
      String(args.name || queueId),
      String(args.kind || "generic"),
      adapter,
      "running",
      integer(args.concurrency ?? 1, "concurrency", 1, 32),
      integer(args.priority ?? 1000, "priority", -1000000, 1000000),
      args.ordering || "priority",
      integer(args.maximum_attempts ?? defaultMaximumAttempts, "maximum_attempts", 1, 100),
      integer(args.maximum_pending_items ?? defaultMaximumPendingItems, "maximum_pending_items", 1, 1000000),
      integer(args.maximum_payload_bytes ?? defaultMaximumPayloadBytes, "maximum_payload_bytes", 1024, 16 * 1024 * 1024),
      JSON.stringify(retryDelays(args.retry_delays_ms, defaultRetryDelays)),
      JSON.stringify(args.metadata || {}),
    );
    return { created: true, already_present: false, queue: publicQueue(getQueueRow(queueId)) };
  }

  function configureQueue(args) {
    const row = getQueueRow(args.queue_id);
    const next = {
      name: args.name ?? row.name,
      concurrency: integer(args.concurrency ?? row.concurrency, "concurrency", 1, 32),
      priority: integer(args.priority ?? row.priority, "priority", -1000000, 1000000),
      ordering: args.ordering ?? row.ordering,
      maximum_attempts: integer(
        args.maximum_attempts ?? row.maximum_attempts, "maximum_attempts", 1, 100,
      ),
      maximum_pending_items: integer(
        args.maximum_pending_items ?? row.maximum_pending_items, "maximum_pending_items", 1, 1000000,
      ),
      maximum_payload_bytes: integer(
        args.maximum_payload_bytes ?? row.maximum_payload_bytes, "maximum_payload_bytes", 1024, 16 * 1024 * 1024,
      ),
      retry_delays_ms: retryDelays(
        args.retry_delays_ms, parseJson(row.retry_delays_json, defaultRetryDelays),
      ),
      metadata: args.metadata ?? parseJson(row.metadata_json),
    };
    if (!new Set(["fifo", "priority"]).has(next.ordering)) {
      throw new Error("ordering must be fifo or priority");
    }
    db.prepare(`
      UPDATE queues SET updated_at=?,name=?,concurrency=?,priority=?,ordering=?,
        maximum_attempts=?,maximum_pending_items=?,maximum_payload_bytes=?,
        retry_delays_json=?,metadata_json=? WHERE id=?
    `).run(
      timestamp(), next.name, next.concurrency, next.priority, next.ordering,
      next.maximum_attempts, next.maximum_pending_items, next.maximum_payload_bytes,
      JSON.stringify(next.retry_delays_ms), JSON.stringify(next.metadata), row.id,
    );
    return { configured: true, queue: publicQueue(getQueueRow(row.id)) };
  }

  function listQueues(args = {}) {
    const rows = args.state
      ? db.prepare("SELECT * FROM queues WHERE state=? ORDER BY priority,id").all(args.state)
      : db.prepare("SELECT * FROM queues ORDER BY priority,id").all();
    return {
      queues: rows.map((row) => {
        const counts = db.prepare(`
          SELECT state,COUNT(*) AS count FROM queue_items WHERE queue_id=? GROUP BY state
        `).all(row.id);
        const next = db.prepare(`
          SELECT MIN(CASE WHEN state='queued' THEN next_attempt_at END) AS next_attempt_at,
            MIN(CASE WHEN state IN ('queued','paused','failed') THEN created_at END) AS oldest_pending_at
          FROM queue_items WHERE queue_id=?
        `).get(row.id);
        const oldestPendingAt = next?.oldest_pending_at || null;
        return {
          ...publicQueue(row),
          counts: Object.fromEntries(counts.map((entry) => [entry.state, entry.count])),
          next_attempt_at: next?.next_attempt_at || null,
          oldest_pending_at: oldestPendingAt,
          oldest_pending_age_ms: oldestPendingAt
            ? Math.max(0, Date.now() - Date.parse(oldestPendingAt))
            : null,
        };
      }),
    };
  }

  function queueStatus(args) {
    const queue = publicQueue(getQueueRow(args.queue_id));
    const limit = integer(args.limit ?? 100, "limit", 1, 1000);
    const rows = db.prepare(`
      SELECT * FROM queue_items WHERE queue_id=?
      ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
        priority,created_at LIMIT ?
    `).all(queue.queue_id, limit);
    return { queue, items: rows.map(publicItem) };
  }

  function enqueueItem(args) {
    const queue = getQueueRow(args.queue_id);
    if (queue.state === "archived") throw new Error(`queue is archived: ${queue.id}`);
    const requestedItemId = String(args.item_id || itemId());
    assertId(requestedItemId, "item_id");
    const payloadJson = JSON.stringify(args.payload || {});
    if (Buffer.byteLength(payloadJson) > queue.maximum_payload_bytes) {
      throw new Error(`queue item payload exceeds maximum_payload_bytes for ${queue.id}`);
    }
    const existing = db.prepare("SELECT * FROM queue_items WHERE id=?").get(requestedItemId);
    if (existing) {
      if (existing.queue_id !== queue.id || existing.payload_json !== payloadJson) {
        throw new Error(`refusing to replace differing queue item: ${requestedItemId}`);
      }
      return { enqueued: true, already_present: true, item: publicItem(existing) };
    }
    const pending = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM queue_items
      WHERE queue_id=? AND state IN ('queued','running','paused','failed')
    `).get(queue.id).count);
    if (pending >= queue.maximum_pending_items) {
      throw new Error(`queue admission limit reached: ${queue.id}`);
    }
    const createdAt = timestamp();
    let nextAttemptAt = createdAt;
    if (args.not_before !== undefined && args.not_before !== null) {
      const parsed = Date.parse(String(args.not_before));
      if (!Number.isFinite(parsed)) throw new Error("not_before must be an ISO-8601 timestamp");
      const requested = new Date(parsed).toISOString();
      if (requested > nextAttemptAt) nextAttemptAt = requested;
    }
    const concurrencyKey = parseJson(payloadJson)?.concurrency_key;
    if (typeof concurrencyKey === "string" && concurrencyKey) {
      const blocked = db.prepare(`
        SELECT MAX(next_attempt_at) AS blocked_until FROM queue_items
        WHERE queue_id=? AND state='queued' AND next_attempt_at>?
          AND json_extract(payload_json,'$.concurrency_key')=?
      `).get(queue.id, createdAt, concurrencyKey)?.blocked_until;
      if (blocked && blocked > nextAttemptAt) nextAttemptAt = blocked;
    }
    db.prepare(`
      INSERT INTO queue_items
        (id,queue_id,created_at,updated_at,state,priority,attempts,next_attempt_at,
         lease_owner,lease_expires_at,payload_json,result_json,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      requestedItemId, queue.id, createdAt, createdAt, "queued",
      integer(args.priority ?? 1000, "priority", -1000000, 1000000), 0, nextAttemptAt,
      null, null, payloadJson, null, null,
    );
    return { enqueued: true, already_present: false, item: publicItem(getItemRow(queue.id, requestedItemId)) };
  }

  function enqueueBatch(args, { withinTransaction = false } = {}) {
    if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 1000) {
      throw new Error("items must contain 1 to 1000 queue items");
    }
    if (!withinTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      const items = args.items.map((entry) => enqueueItem({ ...entry, queue_id: args.queue_id }));
      if (!withinTransaction) db.exec("COMMIT");
      return { enqueued: true, queue_id: args.queue_id, items };
    } catch (error) {
      if (!withinTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  function control(args) {
    const queue = getQueueRow(args.queue_id);
    const action = String(args.action || "");
    if (new Set(["pause-queue", "resume-queue", "archive-queue"]).has(action)) {
      const state = action === "pause-queue" ? "paused" : action === "resume-queue" ? "running" : "archived";
      db.prepare("UPDATE queues SET state=?,updated_at=? WHERE id=?").run(state, timestamp(), queue.id);
      return { action, queue: publicQueue(getQueueRow(queue.id)) };
    }
    if (action === "clear-pending") {
      const result = db.prepare(`
        UPDATE queue_items SET state='cancelled',updated_at=?,lease_owner=NULL,
          lease_expires_at=NULL,lease_token=NULL,error=?
        WHERE queue_id=? AND state IN ('queued','paused','failed')
      `).run(timestamp(), String(args.reason || "queue pending items cleared"), queue.id);
      return { action, queue_id: queue.id, cleared: Number(result.changes) };
    }
    const item = getItemRow(queue.id, args.item_id);
    const transitions = {
      "pause-item": { from: new Set(["queued"]), state: "paused" },
      "resume-item": { from: new Set(["paused"]), state: "queued" },
      "cancel-item": { from: new Set(["queued", "paused", "failed"]), state: "cancelled" },
      "skip-item": { from: new Set(["queued", "paused", "failed"]), state: "skipped" },
      "retry-item": { from: new Set(["failed", "cancelled", "skipped"]), state: "queued", reset: true },
    };
    if (action === "set-priority") {
      db.prepare("UPDATE queue_items SET priority=?,updated_at=? WHERE id=?")
        .run(integer(args.priority, "priority", -1000000, 1000000), timestamp(), item.id);
      return { action, item: publicItem(getItemRow(queue.id, item.id)) };
    }
    if (action === "reset-attempts") {
      if (!new Set(["queued", "paused", "failed"]).has(item.state)) {
        throw new Error(`reset-attempts does not allow item state ${item.state}`);
      }
      const state = item.state === "failed" ? "queued" : item.state;
      db.prepare(`
        UPDATE queue_items SET state=?,updated_at=?,attempts=0,next_attempt_at=?,
          lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL,error=? WHERE id=?
      `).run(
        state, timestamp(), state === "queued" ? timestamp() : null,
        String(args.reason || "retry attempts reset"), item.id,
      );
      return { action, item: publicItem(getItemRow(queue.id, item.id)) };
    }
    const transition = transitions[action];
    if (!transition) throw new Error(`unsupported queue control action: ${action}`);
    if (!transition.from.has(item.state)) {
      throw new Error(`${action} does not allow item state ${item.state}`);
    }
    db.prepare(`
      UPDATE queue_items SET state=?,updated_at=?,attempts=?,next_attempt_at=?,
        lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL,error=? WHERE id=?
    `).run(
      transition.state, timestamp(), transition.reset ? 0 : item.attempts,
      transition.state === "queued" ? timestamp() : null,
      args.reason ? String(args.reason) : item.error, item.id,
    );
    return { action, item: publicItem(getItemRow(queue.id, item.id)) };
  }

  function deleteQueue(args) {
    const queue = getQueueRow(args.queue_id);
    const count = db.prepare("SELECT COUNT(*) AS count FROM queue_items WHERE queue_id=?").get(queue.id).count;
    if (count !== 0) throw new Error(`queue must be empty before deletion: ${queue.id}`);
    db.prepare("DELETE FROM queues WHERE id=?").run(queue.id);
    return { deleted: true, queue_id: queue.id };
  }

  function recoverExpiredLeases(queueId) {
    const observedAt = timestamp();
    return Number(db.prepare(`
      UPDATE queue_items SET state='queued',updated_at=?,next_attempt_at=?,
        lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL,error='worker lease expired'
      WHERE queue_id=? AND state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
    `).run(observedAt, observedAt, queueId, observedAt).changes);
  }

  function claim(args) {
    const queue = getQueueRow(args.queue_id);
    if (queue.state !== "running") return { claimed: false, reason: `queue ${queue.state}` };
    const workerId = String(args.worker_id || "").trim();
    assertId(workerId, "worker_id");
    const leaseMs = integer(args.lease_ms ?? 300000, "lease_ms", 1000, 86400000);
    db.exec("BEGIN IMMEDIATE");
    try {
      const recovered = recoverExpiredLeases(queue.id);
      const running = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM queue_items WHERE queue_id=? AND state='running'
      `).get(queue.id).count);
      if (running >= queue.concurrency) {
        db.exec("COMMIT");
        return {
          claimed: false,
          reason: "queue concurrency limit reached",
          recovered_expired_leases: recovered,
        };
      }
      const order = queue.ordering === "fifo"
        ? "candidate.created_at,candidate.id"
        : "candidate.priority,candidate.created_at,candidate.id";
      const precedes = queue.ordering === "fifo"
        ? `(blocker.created_at<candidate.created_at OR
            (blocker.created_at=candidate.created_at AND blocker.id<candidate.id))`
        : `(blocker.priority<candidate.priority OR
            (blocker.priority=candidate.priority AND
              (blocker.created_at<candidate.created_at OR
                (blocker.created_at=candidate.created_at AND blocker.id<candidate.id))))`;
      const observedAt = timestamp();
      const row = db.prepare(`
        SELECT candidate.* FROM queue_items AS candidate
        WHERE candidate.queue_id=? AND candidate.state='queued'
          AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at<=?)
          AND (
            COALESCE(json_extract(candidate.payload_json,'$.concurrency_key'),'')=''
            OR NOT EXISTS (
              SELECT 1 FROM queue_items AS blocker
              WHERE blocker.queue_id=candidate.queue_id AND blocker.id<>candidate.id
                AND blocker.state IN ('queued','running')
                AND json_extract(blocker.payload_json,'$.concurrency_key')=
                  json_extract(candidate.payload_json,'$.concurrency_key')
                AND (
                  blocker.state='running'
                  OR (blocker.state='queued' AND ${precedes})
                )
            )
          )
        ORDER BY ${order} LIMIT 1
      `).get(queue.id, observedAt);
      if (!row) {
        db.exec("COMMIT");
        return { claimed: false, reason: "no eligible items", recovered_expired_leases: recovered };
      }
      const claimedAt = timestamp();
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      const leaseToken = crypto.randomBytes(16).toString("hex");
      db.prepare(`
        UPDATE queue_items SET state='running',updated_at=?,attempts=attempts+1,
          lease_owner=?,lease_expires_at=?,lease_generation=lease_generation+1,
          lease_token=?,error=NULL WHERE id=? AND state='queued'
      `).run(claimedAt, workerId, leaseExpiresAt, leaseToken, row.id);
      const claimed = getItemRow(queue.id, row.id);
      db.exec("COMMIT");
      return { claimed: true, queue: publicQueue(queue), item: publicItem(claimed), recovered_expired_leases: recovered };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function complete(args) {
    const item = getItemRow(args.queue_id, args.item_id);
    if (item.state !== "running" || item.lease_owner !== args.worker_id ||
        item.lease_token !== args.lease_token) {
      throw new Error(`worker does not own running queue item: ${item.id}`);
    }
    db.prepare(`
      UPDATE queue_items SET state='completed',updated_at=?,result_json=?,error=NULL,
        next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL WHERE id=?
    `).run(timestamp(), JSON.stringify(args.result ?? {}), item.id);
    return publicItem(getItemRow(args.queue_id, item.id));
  }

  function fail(args) {
    const queue = getQueueRow(args.queue_id);
    const item = getItemRow(queue.id, args.item_id);
    if (item.state !== "running" || item.lease_owner !== args.worker_id ||
        item.lease_token !== args.lease_token) {
      throw new Error(`worker does not own running queue item: ${item.id}`);
    }
    const delays = parseJson(queue.retry_delays_json, defaultRetryDelays);
    const exhausted = item.attempts >= queue.maximum_attempts;
    const baseDelay = delays[Math.min(Math.max(item.attempts - 1, 0), delays.length - 1)];
    const delay = retryJitter ? Math.floor(random() * (baseDelay + 1)) : baseDelay;
    const nextAttemptAt = exhausted ? null : new Date(Date.now() + delay).toISOString();
    db.prepare(`
      UPDATE queue_items SET state=?,updated_at=?,result_json=?,error=?,next_attempt_at=?,
        lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL WHERE id=?
    `).run(
      exhausted ? "failed" : "queued", timestamp(), JSON.stringify(args.result ?? {}),
      String(args.error || "queue adapter failed"), nextAttemptAt, item.id,
    );
    return publicItem(getItemRow(queue.id, item.id));
  }

  function defer(args) {
    const queue = getQueueRow(args.queue_id);
    const delayMs = integer(args.delay_ms ?? 60000, "delay_ms", 1000, 86400000);
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      const item = getItemRow(queue.id, args.item_id);
      if (item.state !== "running" || item.lease_owner !== args.worker_id ||
          item.lease_token !== args.lease_token) {
        throw new Error(`worker does not own running queue item: ${item.id}`);
      }
      const updatedAt = timestamp();
      db.prepare(`
        UPDATE queue_items SET state='queued',updated_at=?,attempts=MAX(attempts-1,0),
          next_attempt_at=?,lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL,error=? WHERE id=?
      `).run(updatedAt, nextAttemptAt, String(args.reason || "queue item deferred"), item.id);
      const concurrencyKey = parseJson(item.payload_json)?.concurrency_key;
      if (typeof concurrencyKey === "string" && concurrencyKey) {
        db.prepare(`
          UPDATE queue_items SET updated_at=?,next_attempt_at=?
          WHERE queue_id=? AND id<>? AND state='queued'
            AND (next_attempt_at IS NULL OR next_attempt_at<?)
            AND json_extract(payload_json,'$.concurrency_key')=?
        `).run(updatedAt, nextAttemptAt, queue.id, item.id, nextAttemptAt, concurrencyKey);
      }
      const deferred = publicItem(getItemRow(queue.id, item.id));
      db.exec("COMMIT");
      return deferred;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function renewLease(args) {
    const item = getItemRow(args.queue_id, args.item_id);
    if (item.state !== "running" || item.lease_owner !== args.worker_id ||
        item.lease_token !== args.lease_token) {
      throw new Error(`worker does not own running queue item: ${item.id}`);
    }
    const leaseMs = integer(args.lease_ms ?? 300000, "lease_ms", 1000, 86400000);
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    db.prepare("UPDATE queue_items SET updated_at=?,lease_expires_at=? WHERE id=?")
      .run(timestamp(), expiresAt, item.id);
    return publicItem(getItemRow(args.queue_id, item.id));
  }

  return {
    createQueue,
    configureQueue,
    listQueues,
    queueStatus,
    enqueueItem,
    enqueueBatch,
    control,
    deleteQueue,
    recoverExpiredLeases,
    claim,
    complete,
    fail,
    defer,
    renewLease,
  };
}

export const __test = { SAFE_ID, QUEUE_STATES, ITEM_STATES };
