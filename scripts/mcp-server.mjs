#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createApplicationPluginFramework } from "./application-plugins.mjs";
import { applyHawkspanEnv, readHawkspanEnv } from "./hawkspan-env.mjs";
import { runReadinessMonitor } from "./hawkspan-readiness-monitor.mjs";
import { startLocalControlSurface } from "./local-control-surface.mjs";
import { createQueueRegistry } from "./queue-registry.mjs";
import { operationAttemptFits, routeAttemptPlan } from "./route-attempt-plan.mjs";
import {
  assertExecutingRelease,
  installedRevisionPath,
  readReleaseAuthority,
  validateLiveReleaseConfiguration,
} from "./release-authority.mjs";

const STATE_ROOT = process.env.HAWKSPAN_STATE_DIR
  ? path.resolve(process.env.HAWKSPAN_STATE_DIR)
  : path.join(os.homedir(), ".hawkspan");
const CONFIG_PATH = process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH
  ? path.resolve(process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH)
  : path.join(STATE_ROOT, "config.json");
const ENV_PATH = path.join(STATE_ROOT, "hawkspan.env");
const machineEnvironment = readHawkspanEnv(ENV_PATH);
const DB_PATH = path.join(STATE_ROOT, "spool.sqlite3");
const INBOX = path.join(STATE_ROOT, "inbox");
const OUTBOX = path.join(STATE_ROOT, "outbox");
const ARTIFACTS = path.join(STATE_ROOT, "artifacts");
const AUDIT = path.join(STATE_ROOT, "audit");
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const LORA_AUTOMATION_SCRIPT = path.join(SCRIPT_ROOT, "lora-automation.mjs");

for (const dir of [STATE_ROOT, INBOX, OUTBOX, ARTIFACTS, AUDIT]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const defaultConfig = {
  schema_version: 1,
  node_id: os.hostname(),
  peer: null,
  application_plugins: {
    enabled: true,
    roles: ["controller", "worker"],
    roots: [path.join(STATE_ROOT, "plugins")],
    entries: {},
  },
  local_control: {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    allowed_tools: [
      "link_status", "application_plugin_status", "application_plugin_cancel",
      "list_messages", "list_jobs", "list_artifacts", "list_audit_events",
      "list_queue_adapters", "create_queue", "configure_queue", "delete_queue",
      "list_queues", "queue_status", "enqueue_queue_item", "enqueue_queue_batch",
      "queue_control", "start_next_queue_item", "supervise_queue",
      "list_application_presets", "preview_application_preset",
      "apply_application_preset", "reset_application_preset",
    ],
  },
  training: {
    process_match: "simpletuner|train.py|accelerate launch",
    allow_start: false,
    allow_stop: false,
    allow_package: false,
    max_train_attempts: 3,
    minimum_checkpoint_retention: 10,
    preservation_root: null,
    simpletuner_root: null,
    queue_root: null,
    output_root: null,
    log_root: null,
    start_script: null,
    stop_script: null,
    package_script: null,
  },
  readiness: {
    local_config_timeout_ms: 10000,
    peer_ping_timeout_ms: 60000,
    ssh_port_timeout_ms: 90000,
    ssh_login_timeout_ms: 120000,
    agent_timeout_ms: 90000,
    trainer_timeout_ms: 60000,
    total_timeout_ms: 300000,
    retry_delays_ms: [2000, 3000, 5000, 8000],
  },
  queue_supervisor: {
    enabled: true,
    poll_interval_ms: 120000,
    worker_restart_delays_ms: [2000, 5000, 10000, 20000],
    item_lease_ms: 300000,
    max_items_per_worker: 10,
    default_maximum_attempts: 5,
    default_maximum_pending_items: 10000,
    default_maximum_payload_bytes: 1048576,
    retry_jitter: true,
  },
  link: {
    operation_retry_delays_ms: [2000, 5000, 10000, 20000],
    operation_attempt_timeout_ms: 15000,
    connect_timeout_ms: 5000,
    cycle_timeout_ms: 120000,
    server_alive_interval_seconds: 15,
    server_alive_count_max: 3,
    primary_reprobe_ms: 60000,
  },
};

function readConfig() {
  const loaded = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    : {};
  const merged = {
    ...defaultConfig,
    ...loaded,
    training: { ...defaultConfig.training, ...(loaded.training || {}) },
    application_plugins: {
      ...defaultConfig.application_plugins,
      ...(loaded.application_plugins || {}),
      entries: { ...(loaded.application_plugins?.entries || {}) },
    },
    local_control: { ...defaultConfig.local_control, ...(loaded.local_control || {}) },
    readiness: { ...defaultConfig.readiness, ...(loaded.readiness || {}) },
    queue_supervisor: {
      ...defaultConfig.queue_supervisor,
      ...(loaded.queue_supervisor || {}),
    },
    link: { ...defaultConfig.link, ...(loaded.link || {}) },
  };
  return applyHawkspanEnv(merged, machineEnvironment);
}

const config = readConfig();
if (fs.existsSync(installedRevisionPath(STATE_ROOT))) {
  const authority = readReleaseAuthority(STATE_ROOT);
  assertExecutingRelease(authority, path.dirname(SCRIPT_ROOT));
  const mismatches = validateLiveReleaseConfiguration(authority, {
    envValues: machineEnvironment,
    config,
  });
  if (mismatches.length) {
    throw new Error(`live release configuration disagrees with installed authority: ${JSON.stringify(mismatches)}`);
  }
}
const db = new DatabaseSync(DB_PATH);

function execWithRetry(sql, attempts = 20) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return db.exec(sql);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      if (!/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  throw lastError;
}

execWithRetry(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 10000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    correlation_id TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    state TEXT NOT NULL,
    envelope_path TEXT NOT NULL,
    delivered_via TEXT,
    acknowledged_at TEXT,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    creator TEXT NOT NULL,
    assignee TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    state TEXT NOT NULL,
    authorization_state TEXT NOT NULL,
    authorization_evidence TEXT,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    owner TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    state TEXT NOT NULL,
    delivered_via TEXT,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    node_id TEXT NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT,
    result TEXT NOT NULL,
    details_json TEXT NOT NULL
  );
`);

const queueRegistry = createQueueRegistry(db, {
  retryDelaysMs: config.queue_supervisor.worker_restart_delays_ms,
  maximumAttempts: config.queue_supervisor.default_maximum_attempts,
  maximumPendingItems: config.queue_supervisor.default_maximum_pending_items,
  maximumPayloadBytes: config.queue_supervisor.default_maximum_payload_bytes,
  retryJitter: config.queue_supervisor.retry_jitter,
});

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function audit(action, objectType, objectId, result, details = {}) {
  db.prepare(`
    INSERT INTO audit_events
      (timestamp,node_id,action,object_type,object_id,result,details_json)
    VALUES (?,?,?,?,?,?,?)
  `).run(now(), config.node_id, action, objectType, objectId || null, result, json(details));
}

function removeDuplicateSimpleTunerQueues() {
  const adapters = [
    "tool:trainer_start_authorized_job",
    "tool:trainer_stop_authorized_job",
    "tool:trainer_package_authorized_job",
    "tool:trainer_queue_control",
  ];
  const placeholders = adapters.map(() => "?").join(",");
  const rejected = db.prepare(`SELECT id,adapter FROM queues WHERE adapter IN (${placeholders})`)
    .all(...adapters);
  if (!rejected.length) return [];
  const remove = db.prepare("DELETE FROM queues WHERE id=?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const queue of rejected) remove.run(queue.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit("remove_rejected", "queue_set", "duplicate-simpletuner-queues", "removed", {
    queues: rejected,
    authority: "lora-scheduler.py",
  });
  return rejected;
}

removeDuplicateSimpleTunerQueues();

for (const definition of [
  {
    queue_id: "hawkspan-messages",
    name: "HawkSpan messages",
    kind: "message",
    adapter: "message",
    concurrency: 2,
    priority: 100,
  },
  {
    queue_id: "hawkspan-artifacts",
    name: "HawkSpan artifacts and files",
    kind: "file",
    adapter: "artifact",
    concurrency: 1,
    priority: 200,
  },
]) {
  const created = queueRegistry.createQueue(definition);
  if (created.created) audit("create", "queue", definition.queue_id, "created", definition);
}

function enqueueDeliveryReference(queueId, itemIdValue, payload, priority = 1000) {
  const result = queueRegistry.enqueueItem({
    queue_id: queueId,
    item_id: itemIdValue,
    payload,
    priority,
  });
  if (!result.already_present) {
    audit("enqueue", "queue_item", itemIdValue, "queued", { queue_id: queueId, payload });
  }
  return result;
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function writeEnvelope(envelope) {
  const filePath = path.join(OUTBOX, `${envelope.id}.json`);
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
  return filePath;
}

function ingestInbox() {
  let imported = 0;
  for (const name of fs.readdirSync(INBOX)) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(INBOX, name);
    let envelope;
    try {
      envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!envelope.id || !envelope.sender || !envelope.recipient) {
        throw new Error("missing required envelope fields");
      }
      const exists = db.prepare("SELECT 1 FROM messages WHERE id=?").get(envelope.id);
      if (exists) continue;
      db.prepare(`
        INSERT INTO messages
          (id,created_at,sender,recipient,kind,subject,body,correlation_id,
           direction,state,envelope_path,delivered_via,metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        envelope.id,
        envelope.created_at || now(),
        envelope.sender,
        envelope.recipient,
        envelope.kind || "message",
        envelope.subject || "",
        envelope.body || "",
        envelope.correlation_id || null,
        "inbound",
        envelope.kind === "acknowledgement" ? "acknowledged" : "received",
        filePath,
        envelope.delivered_via || null,
        json(envelope.metadata),
      );
      if (envelope.kind === "acknowledgement" && envelope.correlation_id) {
        db.prepare(`
          UPDATE messages
          SET state='acknowledged', acknowledged_at=?
          WHERE id=? AND direction='outbound'
        `).run(envelope.created_at || now(), envelope.correlation_id);
      }
      audit("ingest", "message", envelope.id, "received", { file_path: filePath });
      imported += 1;
    } catch (error) {
      audit("ingest", "message", name, "rejected", { error: String(error) });
    }
  }
  return imported;
}

const routeRetryAfter = new Map();

function peerCandidates() {
  if (!config.peer) return [];
  return [
    config.peer.primary_enabled === false ? null : config.peer.primary_host,
    config.peer.fallback_enabled === false ? null : config.peer.fallback_host,
  ].filter((host) => host && Date.now() >= Number(routeRetryAfter.get(host) || 0));
}

function recordRouteFailure(host) {
  if (host === config.peer?.primary_host) {
    routeRetryAfter.set(host, Date.now() + config.link.primary_reprobe_ms);
  }
}

function recordRouteSuccess(host) {
  routeRetryAfter.delete(host);
}

function sshArgs(host, remoteCommand) {
  const args = [];
  if (config.peer.ssh_identity) args.push("-i", config.peer.ssh_identity);
  const connectSeconds = Math.max(1, Math.ceil(config.link.connect_timeout_ms / 1000));
  args.push(
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectSeconds}`,
    "-o", `ServerAliveInterval=${config.link.server_alive_interval_seconds}`,
    "-o", `ServerAliveCountMax=${config.link.server_alive_count_max}`,
    `${config.peer.user}@${host}`,
    remoteCommand,
  );
  return args;
}

function ensureRemoteDirectory(host, remoteDir, timeout) {
  const result = spawnSync("ssh", sshArgs(host, `mkdir -p ${shellQuote(remoteDir)}`), {
    encoding: "utf8",
    timeout,
  });
  return { ok: result.status === 0, stderr: result.stderr?.trim() || "" };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function discoverPeerRelease(host, timeout = 15000) {
  const remoteStateRoot = config.peer.remote_state_dir ||
    path.posix.join("/Users", config.peer.user || "", ".hawkspan");
  const authorityPath = path.posix.join(remoteStateRoot, "installed-revision.json");
  const result = spawnSync("ssh", sshArgs(host, `cat ${shellQuote(authorityPath)}`), {
    encoding: "utf8",
    timeout,
  });
  if (result.status !== 0) {
    return { ok: false, status: result.status, error: result.stderr?.trim() || "peer release authority unavailable" };
  }
  try {
    const record = JSON.parse(result.stdout);
    const root = record.active_release_root;
    if (record.schema_version !== 2 || !record.revision ||
        typeof root !== "string" || !path.posix.isAbsolute(root)) {
      throw new Error("peer release authority is incomplete");
    }
    return { ok: true, revision: String(record.revision), active_release_root: root };
  } catch (error) {
    return { ok: false, status: result.status, error: String(error.message || error) };
  }
}

let rsyncAppendVerify;

function waitMilliseconds(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function beginLinkCycle() {
  return Date.now() + Number(config.link.cycle_timeout_ms);
}

function waitForOperationRetry(delayMs, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0 || delayMs >= remaining) return false;
  waitMilliseconds(delayMs);
  return true;
}

function reserveOperationAttempt(delayMs, deadline, isLastRoute) {
  const attemptMs = Number(config.link.operation_attempt_timeout_ms);
  if (!operationAttemptFits({
    remainingMs: deadline - Date.now(),
    delayMs,
    attemptTimeoutMs: attemptMs,
    isLastRoute,
  })) return false;
  return waitForOperationRetry(delayMs, deadline);
}

function remainingLinkCycle(deadline, requestedMs) {
  return Math.max(1, Math.min(Number(requestedMs), deadline - Date.now()));
}

function operationAttemptDeadline(cycleDeadline) {
  return Math.min(
    cycleDeadline,
    Date.now() + Number(config.link.operation_attempt_timeout_ms),
  );
}

function supportsAppendVerify() {
  if (rsyncAppendVerify !== undefined) return rsyncAppendVerify;
  const result = spawnSync("rsync", ["--help"], {
    encoding: "utf8",
    timeout: 5000,
  });
  rsyncAppendVerify = result.status === 0 &&
    `${result.stdout || ""}\n${result.stderr || ""}`.includes("--append-verify");
  return rsyncAppendVerify;
}

function rsyncFile(localPath, remoteDir, remoteName = null) {
  if (!config.peer) {
    return { ok: false, error: "peer is not configured", attempts: [] };
  }
  const attempts = [];
  const deadline = beginLinkCycle();
  for (const { host, cycle, delay_ms: delayMs, is_last_route: isLastRoute } of routeAttemptPlan(
    peerCandidates(), config.link.operation_retry_delays_ms,
  )) {
      if (!reserveOperationAttempt(delayMs, deadline, isLastRoute)) {
        if (isLastRoute) break;
        continue;
      }
      const attemptDeadline = operationAttemptDeadline(deadline);
      const prepared = ensureRemoteDirectory(
        host,
        remoteDir,
        remainingLinkCycle(attemptDeadline, config.link.connect_timeout_ms + 5000),
      );
      if (!prepared.ok) {
        attempts.push({ cycle, host, stage: "mkdir", error: prepared.stderr });
        recordRouteFailure(host);
        continue;
      }
      const sshCommand = [
        "ssh",
        ...(config.peer.ssh_identity ? ["-i", config.peer.ssh_identity] : []),
        "-o", "BatchMode=yes",
        "-o", `ConnectTimeout=${Math.max(1, Math.ceil(config.link.connect_timeout_ms / 1000))}`,
        "-o", `ServerAliveInterval=${config.link.server_alive_interval_seconds}`,
        "-o", `ServerAliveCountMax=${config.link.server_alive_count_max}`,
      ].join(" ");
      const resumeArgs = supportsAppendVerify()
        ? ["--partial", "--append-verify"]
        : ["--partial"];
      const remoteTarget = remoteName
        ? `${remoteDir.replaceAll(" ", "\\ ")}/${remoteName.replaceAll(" ", "\\ ")}`
        : `${remoteDir.replaceAll(" ", "\\ ")}/`;
      const result = spawnSync("rsync", [
        "-a",
        ...resumeArgs,
        "-e", sshCommand,
        localPath,
        `${config.peer.user}@${host}:${remoteTarget}`,
      ], {
        encoding: "utf8",
        timeout: remainingLinkCycle(attemptDeadline, config.link.operation_attempt_timeout_ms),
      });
      attempts.push({
        cycle,
        host,
        stage: "rsync",
        resume_mode: supportsAppendVerify() ? "append-verify" : "partial",
        status: result.status,
        error: result.stderr?.trim() || "",
      });
      if (result.status === 0) {
        recordRouteSuccess(host);
        return { ok: true, host, attempts };
      }
      recordRouteFailure(host);
  }
  return { ok: false, error: "all routes failed", attempts };
}

function retryMessage(args) {
  const row = db.prepare(`
    SELECT * FROM messages WHERE id=? AND direction='outbound'
  `).get(args.message_id);
  if (!row) throw new Error(`outbound message not found: ${args.message_id}`);
  if (row.state === "delivered" || row.state === "acknowledged") {
    return {
      message_id: row.id,
      envelope_path: row.envelope_path,
      delivery: { ok: true, already_delivered: true, host: row.delivered_via || null, attempts: [] },
      wake: null,
    };
  }
  if (!fs.existsSync(row.envelope_path)) {
    throw new Error(`immutable envelope is missing: ${row.envelope_path}`);
  }
  if (!config.peer?.remote_inbox) throw new Error("peer.remote_inbox is not configured");
  const delivery = rsyncFile(row.envelope_path, config.peer.remote_inbox);
  if (delivery.ok) {
    db.prepare("UPDATE messages SET state='delivered', delivered_via=? WHERE id=?")
      .run(delivery.host, row.id);
  }
  let wake = null;
  if (delivery.ok && row.kind !== "acknowledgement" && args.wake !== false) {
    wake = wakePeerThread({
      message_id: row.id,
      subject: row.subject,
      body: row.body,
    });
  }
  audit("retry", "message", row.id, delivery.ok ? "delivered" : "queued", {
    delivery,
    wake,
  });
  if (!delivery.ok) {
    enqueueDeliveryReference(
      "hawkspan-messages", `message-${row.id}`, { message_id: row.id, wake: args.wake !== false }, 100,
    );
  }
  return { message_id: row.id, envelope_path: row.envelope_path, delivery, wake };
}

function sendMessage(args, { onEnvelopeWritten = null } = {}) {
  const messageId = id("msg");
  const envelope = {
    schema_version: 1,
    id: messageId,
    created_at: now(),
    sender: config.node_id,
    recipient: args.recipient || config.peer?.node_id || "peer",
    kind: args.kind || "message",
    subject: args.subject,
    body: args.body,
    correlation_id: args.correlation_id || null,
    metadata: args.metadata || {},
  };
  const envelopePath = writeEnvelope(envelope);
  onEnvelopeWritten?.(envelopePath);
  try {
    db.prepare(`
      INSERT INTO messages
        (id,created_at,sender,recipient,kind,subject,body,correlation_id,
         direction,state,envelope_path,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      messageId,
      envelope.created_at,
      envelope.sender,
      envelope.recipient,
      envelope.kind,
      envelope.subject,
      envelope.body,
      envelope.correlation_id,
      "outbound",
      "queued",
      envelopePath,
      json(envelope.metadata),
    );
  } catch (error) {
    fs.rmSync(envelopePath, { force: true });
    throw error;
  }
  let delivery = null;
  if (args.deliver !== false && config.peer?.remote_inbox) {
    delivery = rsyncFile(envelopePath, config.peer.remote_inbox);
    if (delivery.ok) {
      db.prepare("UPDATE messages SET state='delivered', delivered_via=? WHERE id=?")
        .run(delivery.host, messageId);
    }
  }
  let wake = null;
  if (delivery?.ok && envelope.kind !== "acknowledgement" && args.wake !== false) {
    wake = wakePeerThread({
      message_id: messageId,
      subject: envelope.subject,
      body: envelope.body,
    });
  }
  audit("send", "message", messageId, delivery?.ok ? "delivered" : "queued", {
    delivery,
    wake,
  });
  if (args.deliver !== false && !delivery?.ok) {
    enqueueDeliveryReference(
      "hawkspan-messages", `message-${messageId}`, { message_id: messageId, wake: args.wake !== false }, 100,
    );
  }
  return { message_id: messageId, envelope_path: envelopePath, delivery, wake };
}

function wakePeerThread(args) {
  if (!config.peer?.allow_remote_wake) {
    return {
      ok: false,
      skipped: true,
      error: "peer.allow_remote_wake is disabled; the durable inbox remains authoritative",
      attempts: [],
    };
  }
  if (!config.peer?.thread_id) {
    return { ok: false, error: "peer.thread_id is not configured", attempts: [] };
  }
  const codexCommand = config.peer.codex_command || "codex";
  const remoteNode = config.peer.remote_node || "node";
  let peerRelease = null;
  const discoveryAttempts = [];
  const deadline = beginLinkCycle();
  for (const { host, cycle, delay_ms: delayMs, is_last_route: isLastRoute } of routeAttemptPlan(
    peerCandidates(), config.link.operation_retry_delays_ms,
  )) {
    if (!reserveOperationAttempt(delayMs, deadline, isLastRoute)) {
      if (isLastRoute) break;
      continue;
    }
    const observed = discoverPeerRelease(
      host,
      remainingLinkCycle(operationAttemptDeadline(deadline), 15000),
    );
    discoveryAttempts.push({ host, cycle, ...observed });
    if (observed.ok) {
      peerRelease = observed;
      break;
    }
  }
  if (!peerRelease) {
    return { ok: false, error: "peer release authority unavailable", attempts: discoveryAttempts };
  }
  const remoteCallTool = path.posix.join(peerRelease.active_release_root, "scripts", "call-tool.mjs");
  const auditDir = config.peer.remote_audit || `${config.peer.remote_inbox}/../audit`;
  const wakeId = id("wake");
  const logPath = path.posix.join(auditDir, `${wakeId}.log`);
  const leasePath = path.posix.join(
    auditDir,
    `wake-${String(config.peer.thread_id).replace(/[^A-Za-z0-9._-]/g, "_")}.lock`,
  );
  const prompt = [
    `HawkSpan-D delivered message ${args.message_id || "unknown"}.`,
    args.subject ? `Subject: ${args.subject}.` : "",
    args.body ? `Message body: ${args.body}` : "",
    "Import and acknowledge the durable envelope when MCP tools are available.",
    "If exec mode cannot load dynamic MCP tools, this embedded message body is authoritative.",
    `Direct receive fallback: ${remoteNode} ${remoteCallTool} receive_messages '{"limit":20}'`,
    `Direct acknowledge fallback: ${remoteNode} ${remoteCallTool} acknowledge_message ` +
      `'{"message_id":"${args.message_id || "unknown"}","deliver":true}'`,
    "Continue the existing task without repeating completed work.",
  ].filter(Boolean).join(" ");
  const resumedCommand = [
    "trap",
    shellQuote(`rm -rf ${shellQuote(leasePath)}`),
    "EXIT HUP INT TERM",
    ";",
    shellQuote(codexCommand),
    "exec",
    "resume",
    "--skip-git-repo-check",
    shellQuote(config.peer.thread_id),
    shellQuote(prompt),
  ].join(" ");
  const command = [
    `mkdir -p ${shellQuote(auditDir)}`,
    "&&",
    "(",
    `mkdir ${shellQuote(leasePath)} 2>/dev/null`,
    "||",
    "exit 0",
    ")",
    "&&",
    "nohup",
    "/bin/sh",
    "-c",
    shellQuote(resumedCommand),
    ">",
    shellQuote(logPath),
    "2>&1",
    "<",
    "/dev/null",
    "&",
  ].join(" ");
  const attempts = [...discoveryAttempts.map((attempt) => ({ ...attempt, phase: "release_discovery" }))];
  for (const { host, cycle, delay_ms: delayMs, is_last_route: isLastRoute } of routeAttemptPlan(
    peerCandidates(), config.link.operation_retry_delays_ms,
  )) {
      if (!reserveOperationAttempt(delayMs, deadline, isLastRoute)) {
        if (isLastRoute) break;
        continue;
      }
      const result = spawnSync("ssh", sshArgs(host, command), {
        encoding: "utf8",
        timeout: remainingLinkCycle(
          operationAttemptDeadline(deadline),
          Math.max(15000, config.link.connect_timeout_ms + 5000),
        ),
      });
      attempts.push({
        cycle,
        host,
        status: result.status,
        error: result.stderr?.trim() || "",
      });
      if (result.status === 0) {
        recordRouteSuccess(host);
        audit("wake", "thread", config.peer.thread_id, "started", {
          host,
          peer_revision: peerRelease.revision,
          wake_id: wakeId,
          log_path: logPath,
          message_id: args.message_id || null,
        });
        return { ok: true, host, wake_id: wakeId, log_path: logPath, attempts };
      }
      recordRouteFailure(host);
  }
  audit("wake", "thread", config.peer.thread_id, "failed", { attempts });
  return { ok: false, error: "all routes failed", wake_id: wakeId, attempts };
}

function receiveMessages(args) {
  const imported = ingestInbox();
  const limit = Math.min(Math.max(Number(args.limit || 50), 1), 500);
  const states = args.include_acknowledged
    ? ["received", "acknowledged"]
    : ["received"];
  const placeholders = states.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id,created_at,sender,recipient,kind,subject,body,correlation_id,state,
           metadata_json
    FROM messages
    WHERE direction='inbound' AND state IN (${placeholders})
    ORDER BY created_at ASC
    LIMIT ?
  `).all(...states, limit);
  return {
    imported,
    messages: rows.map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata_json),
      metadata_json: undefined,
    })),
  };
}

function listMessages(args) {
  ingestInbox();
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 1000);
  const clauses = [];
  const values = [];
  if (args.direction) {
    clauses.push("direction=?");
    values.push(args.direction);
  }
  if (args.state) {
    clauses.push("state=?");
    values.push(args.state);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT id,created_at,sender,recipient,kind,subject,body,correlation_id,
           direction,state,envelope_path,delivered_via,acknowledged_at,metadata_json
    FROM messages ${where}
    ORDER BY created_at DESC LIMIT ?
  `).all(...values, limit);
  return rows.map((row) => ({
    ...row,
    metadata: JSON.parse(row.metadata_json),
    metadata_json: undefined,
  }));
}

function acknowledgeMessage(args) {
  const row = db.prepare(`
    SELECT * FROM messages WHERE id=? AND direction='inbound'
  `).get(args.message_id);
  if (!row) throw new Error(`inbound message not found: ${args.message_id}`);
  const acknowledgedAt = now();
  db.prepare(`
    UPDATE messages SET state='acknowledged', acknowledged_at=? WHERE id=?
  `).run(acknowledgedAt, args.message_id);
  const shouldReply = args.reply === undefined
    ? row.kind !== "acknowledgement"
    : args.reply;
  if (!shouldReply) {
    audit("acknowledge", "message", row.id, "acknowledged_local", {
      reply: false,
      inbound_kind: row.kind,
    });
    return {
      acknowledged_message_id: row.id,
      acknowledged_at: acknowledgedAt,
      reply_sent: false,
    };
  }
  const acknowledgement = sendMessage({
    recipient: row.sender,
    kind: "acknowledgement",
    subject: `Acknowledged: ${row.subject}`,
    body: args.note || "Received and acknowledged.",
    correlation_id: row.id,
    metadata: { acknowledged_message_id: row.id, acknowledged_at: acknowledgedAt },
    deliver: args.deliver,
  });
  audit("acknowledge", "message", row.id, "acknowledged", {
    acknowledgement_id: acknowledgement.message_id,
  });
  return { acknowledged_message_id: row.id, ...acknowledgement };
}

const jobTransitions = {
  proposed: new Set(["awaiting_authorization", "authorized", "queued", "cancelled"]),
  awaiting_authorization: new Set(["authorized", "cancelled"]),
  authorized: new Set(["queued", "cancelled"]),
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["paused", "returning", "completed", "failed", "cancel_requested"]),
  returning: new Set(["completed", "failed", "cancel_requested"]),
  paused: new Set(["queued", "cancelled"]),
  cancel_requested: new Set(["paused", "cancelled", "failed"]),
  completed: new Set(["verified"]),
  failed: new Set(["queued", "cancelled"]),
  verified: new Set(),
  cancelled: new Set(),
};

function trainingAuthorizationBinding(row, metadata = null) {
  const bound = metadata || JSON.parse(row.metadata_json || "{}");
  const target = String(bound.target || "").trim();
  const revisionFingerprint = String(bound.revision_fingerprint || "").trim();
  if (!target) throw new Error("training authorization metadata requires target");
  if (!/^[A-Fa-f0-9]{64}$/.test(revisionFingerprint)) {
    throw new Error("training authorization metadata requires revision_fingerprint");
  }
  if (bound.recovery_checkpoint &&
      !/^[A-Fa-f0-9]{64}$/.test(String(bound.recovery_checkpoint_revision_sha256 || ""))) {
    throw new Error(
      "checkpoint-resume authorization requires recovery_checkpoint_revision_sha256",
    );
  }
  return { target, revision_fingerprint: revisionFingerprint };
}

function createJob(args) {
  const jobId = id("job");
  const createdAt = now();
  const authorizationState = args.requires_authorization === true
    ? "required"
    : "not_required";
  db.prepare(`
    INSERT INTO jobs
      (id,created_at,updated_at,creator,assignee,kind,title,description,state,
       authorization_state,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    jobId,
    createdAt,
    createdAt,
    config.node_id,
    args.assignee || config.peer?.node_id || config.node_id,
    args.kind,
    args.title,
    args.description || "",
    authorizationState === "required" ? "awaiting_authorization" : "proposed",
    authorizationState,
    json(args.metadata),
  );
  audit("create", "job", jobId, "created", { authorization_state: authorizationState });
  return { job_id: jobId, state: authorizationState === "required" ? "awaiting_authorization" : "proposed" };
}

function updateJobStatus(args) {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(args.job_id);
  if (!row) throw new Error(`job not found: ${args.job_id}`);
  if (args.state === "authorized") {
    if (!args.authorization_evidence?.trim()) {
      throw new Error("authorization_evidence is required to authorize a job");
    }
  } else if (args.state !== row.state && !jobTransitions[row.state]?.has(args.state)) {
    throw new Error(`invalid job transition: ${row.state} -> ${args.state}`);
  }
  const currentMetadata = JSON.parse(row.metadata_json || "{}");
  const nextMetadata = { ...currentMetadata, ...(args.metadata || {}) };
  if (row.kind === "training" && args.state === "authorized") {
    trainingAuthorizationBinding(row, nextMetadata);
  }
  if (row.kind === "training" && row.authorization_state === "recorded") {
    const currentBinding = trainingAuthorizationBinding(row, currentMetadata);
    const nextBinding = trainingAuthorizationBinding(row, nextMetadata);
    if (currentBinding.target !== nextBinding.target ||
        currentBinding.revision_fingerprint !== nextBinding.revision_fingerprint) {
      throw new Error("recorded training authorization binding is immutable");
    }
    if (currentMetadata.recovery_checkpoint_revision_sha256 &&
        nextMetadata.recovery_checkpoint_revision_sha256 !==
          currentMetadata.recovery_checkpoint_revision_sha256) {
      throw new Error("recorded recovery checkpoint binding is immutable");
    }
  }
  let authorizationState = row.authorization_state;
  let authorizationEvidence = row.authorization_evidence;
  if (args.state === "authorized") {
    authorizationState = "recorded";
    authorizationEvidence = args.authorization_evidence;
  }
  if (["queued", "running"].includes(args.state) && authorizationState === "required") {
    throw new Error("job requires recorded authorization before it can be queued or run");
  }
  db.prepare(`
    UPDATE jobs
    SET state=?,updated_at=?,authorization_state=?,authorization_evidence=?,
        metadata_json=?
    WHERE id=?
  `).run(
    args.state,
    now(),
    authorizationState,
    authorizationEvidence,
    json(nextMetadata),
    args.job_id,
  );
  audit("transition", "job", args.job_id, args.state, {
    previous_state: row.state,
    authorization_state: authorizationState,
  });
  return { job_id: args.job_id, previous_state: row.state, state: args.state, authorization_state: authorizationState };
}

function listJobs(args) {
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 500);
  const clauses = [];
  const values = [];
  if (args.state) {
    clauses.push("state=?");
    values.push(args.state);
  }
  if (args.job_id) {
    clauses.push("id=?");
    values.push(args.job_id);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM jobs ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...values, limit);
  return rows.map((row) => ({
    ...row,
    metadata: JSON.parse(row.metadata_json),
    metadata_json: undefined,
  }));
}

function jobCountSummary() {
  const activeStates = ["running", "returning", "started", "stop_requested", "cancel_requested"];
  const pendingStates = ["queued", "authorized"];
  const terminalStates = ["completed", "verified", "cancelled", "failed"];
  const countWhere = (states) => db.prepare(`
    SELECT count(*) AS count FROM jobs
    WHERE state IN (${states.map(() => "?").join(",")})
  `).get(...states).count;
  return {
    active_jobs: countWhere(activeStates),
    pending_jobs: countWhere(pendingStates),
    paused_jobs: db.prepare(`
      SELECT count(*) AS count FROM jobs WHERE state='paused'
    `).get().count,
    completed_jobs: countWhere(terminalStates),
  };
}

function registerArtifact(args) {
  const filePath = path.resolve(args.path);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("artifact path must be a regular file");
  const artifactId = id("artifact");
  const digest = sha256(filePath);
  db.prepare(`
    INSERT INTO artifacts
      (id,created_at,owner,path,name,size_bytes,sha256,state,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    artifactId,
    now(),
    config.node_id,
    filePath,
    args.name || path.basename(filePath),
    stat.size,
    digest,
    "registered",
    json(args.metadata),
  );
  audit("register", "artifact", artifactId, "registered", {
    path: filePath,
    size_bytes: stat.size,
    sha256: digest,
  });
  return { artifact_id: artifactId, path: filePath, size_bytes: stat.size, sha256: digest };
}

function verifyArtifact(args) {
  const row = args.artifact_id
    ? db.prepare("SELECT * FROM artifacts WHERE id=?").get(args.artifact_id)
    : null;
  const filePath = path.resolve(args.path || row?.path || "");
  if (!filePath) throw new Error("path or artifact_id is required");
  const digest = sha256(filePath);
  const expected = args.expected_sha256 || row?.sha256 || null;
  const matches = expected ? digest === expected : null;
  if (row && matches === true) {
    db.prepare("UPDATE artifacts SET state='verified' WHERE id=?").run(row.id);
  }
  audit("verify", "artifact", row?.id || filePath, matches === false ? "mismatch" : "verified", {
    sha256: digest,
    expected_sha256: expected,
  });
  return { path: filePath, sha256: digest, expected_sha256: expected, matches };
}

function sendArtifact(args) {
  const row = db.prepare("SELECT * FROM artifacts WHERE id=?").get(args.artifact_id);
  if (!row) throw new Error(`artifact not found: ${args.artifact_id}`);
  if (row.state === "delivered") {
    return {
      artifact_id: row.id,
      delivery: { ok: true, verified: true, already_delivered: true, host: row.delivered_via || null, attempts: [] },
    };
  }
  if (!config.peer?.remote_artifacts) throw new Error("peer.remote_artifacts is not configured");
  if (!fs.existsSync(row.path)) {
    db.prepare("UPDATE artifacts SET state='source_missing' WHERE id=?").run(row.id);
    const delivery = { ok: false, verified: false, error: "registered source file is missing" };
    audit("send", "artifact", row.id, "source_missing", { delivery });
    return { artifact_id: row.id, delivery };
  }
  const currentStat = fs.statSync(row.path);
  const currentSha256 = sha256(row.path);
  if (Number(currentStat.size) !== Number(row.size_bytes) || currentSha256 !== row.sha256) {
    db.prepare("UPDATE artifacts SET state='source_changed' WHERE id=?").run(row.id);
    const delivery = {
      ok: false,
      verified: false,
      error: "registered source file changed; register the current revision as a new artifact",
      registered_size_bytes: row.size_bytes,
      current_size_bytes: currentStat.size,
      registered_sha256: row.sha256,
      current_sha256: currentSha256,
    };
    audit("send", "artifact", row.id, "source_changed", { delivery });
    return { artifact_id: row.id, delivery };
  }
  const remoteFileName = `${row.id}-${path.basename(row.path)}`;
  const delivery = rsyncFile(row.path, config.peer.remote_artifacts, remoteFileName);
  if (delivery.ok) {
    const remotePath = path.posix.join(config.peer.remote_artifacts, remoteFileName);
    const verified = spawnSync(
      "ssh",
      sshArgs(delivery.host, `shasum -a 256 ${shellQuote(remotePath)}`),
      { encoding: "utf8", timeout: config.link.operation_attempt_timeout_ms },
    );
    const remoteSha256 = verified.status === 0
      ? verified.stdout.trim().split(/\s+/)[0]
      : null;
    delivery.remote_path = remotePath;
    delivery.remote_sha256 = remoteSha256;
    delivery.verified = remoteSha256 === row.sha256;
    if (delivery.verified) {
      const manifestPath = path.join(OUTBOX, `${row.id}.artifact.json`);
      fs.writeFileSync(manifestPath, `${JSON.stringify({
        schema_version: 1,
        artifact_id: row.id,
        owner: row.owner,
        name: row.name,
        file_name: remoteFileName,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        delivered_at: now(),
        delivered_via: delivery.host,
        metadata: JSON.parse(row.metadata_json),
      }, null, 2)}\n`, { mode: 0o600 });
      const manifestDelivery = rsyncFile(manifestPath, config.peer.remote_artifacts);
      delivery.manifest = manifestDelivery;
      if (!manifestDelivery.ok) delivery.verified = false;
    }
    if (delivery.verified) {
      db.prepare("UPDATE artifacts SET state='delivered', delivered_via=? WHERE id=?")
        .run(delivery.host, row.id);
    } else {
      db.prepare("UPDATE artifacts SET state='delivery_queued' WHERE id=?").run(row.id);
      delivery.error = verified.stderr?.trim() || "remote SHA-256 verification failed";
    }
  } else {
    db.prepare("UPDATE artifacts SET state='delivery_queued' WHERE id=?").run(row.id);
  }
  audit("send", "artifact", row.id, delivery.verified ? "delivered" : "failed", { delivery });
  if (!delivery.verified) {
    queueArtifactDelivery({ artifact_id: row.id });
  }
  return { artifact_id: row.id, delivery };
}

function queueArtifactDelivery(args) {
  const row = db.prepare("SELECT id,state FROM artifacts WHERE id=?").get(args.artifact_id);
  if (!row) throw new Error(`artifact not found: ${args.artifact_id}`);
  if (row.state === "delivered") {
    return { artifact_id: row.id, queued: false, delivery: { verified: true, already_delivered: true } };
  }
  db.prepare("UPDATE artifacts SET state='delivery_queued' WHERE id=?").run(row.id);
  const queued = enqueueDeliveryReference(
    "hawkspan-artifacts", `artifact-${row.id}`, { artifact_id: row.id }, 200,
  );
  if (queued.item?.state === "failed") {
    queued.item = queueRegistry.control({
      queue_id: "hawkspan-artifacts",
      item_id: queued.item.item_id,
      action: "retry-item",
      reason: "automatic artifact delivery retry",
    }).item;
  }
  audit("enqueue", "artifact", row.id, "delivery_queued", { queue_id: "hawkspan-artifacts" });
  return { artifact_id: row.id, queued: true, queue_item: queued.item };
}

function flushOutbox(args) {
  const messageRows = db.prepare(`
    SELECT id FROM messages
    WHERE direction='outbound' AND state='queued'
    ORDER BY created_at ASC
  `).all();
  const artifactRows = db.prepare(`
    SELECT id FROM artifacts
    WHERE state='delivery_queued'
    ORDER BY created_at ASC
  `).all();
  const messages = [];
  const artifacts = [];
  for (const row of messageRows) {
    try {
      messages.push(retryMessage({ message_id: row.id, wake: args.wake !== false }));
    } catch (error) {
      messages.push({ message_id: row.id, error: String(error?.message || error) });
    }
  }
  for (const row of artifactRows) {
    try {
      artifacts.push(enqueueDeliveryReference(
        "hawkspan-artifacts", `artifact-${row.id}`, { artifact_id: row.id }, 200,
      ));
    } catch (error) {
      artifacts.push({ artifact_id: row.id, error: String(error?.message || error) });
    }
  }
  ingestInbox();
  const received = receiveArtifacts();
  audit("flush", "outbox", null, "complete", {
    message_count: messages.length,
    artifact_count: artifacts.length,
    artifact_delivery: "independent queue supervisor",
    received_artifact_count: received.artifacts.length,
  });
  return { messages, artifacts, received };
}

function listArtifacts(args) {
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 5000);
  const clauses = [];
  const values = [];
  for (const [column, value] of [
    ["state", args.state], ["id", args.artifact_id], ["sha256", args.sha256],
  ]) {
    if (value) {
      clauses.push(`${column}=?`);
      values.push(value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM artifacts ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...values, limit);
  return rows.map((row) => ({
    ...row,
    metadata: JSON.parse(row.metadata_json),
    metadata_json: undefined,
  }));
}

function receiveArtifacts() {
  const results = [];
  for (const name of fs.readdirSync(ARTIFACTS)) {
    if (!name.endsWith(".artifact.json")) continue;
    const manifestPath = path.join(ARTIFACTS, name);
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const filePath = path.join(ARTIFACTS, manifest.file_name);
      if (!fs.existsSync(filePath)) throw new Error(`artifact file is missing: ${manifest.file_name}`);
      const stat = fs.statSync(filePath);
      const existing = db.prepare(
        "SELECT size_bytes,sha256,state FROM artifacts WHERE id=?"
      ).get(manifest.artifact_id);
      if (
        existing?.state === "received_verified" &&
        Number(existing.size_bytes) === Number(manifest.size_bytes) &&
        Number(stat.size) === Number(manifest.size_bytes) &&
        existing.sha256 === manifest.sha256
      ) {
        results.push({
          artifact_id: manifest.artifact_id,
          path: filePath,
          verified: true,
          cached: true,
        });
        continue;
      }
      const digest = sha256(filePath);
      const verified = stat.size === manifest.size_bytes && digest === manifest.sha256;
      if (!existing) {
        db.prepare(`
          INSERT INTO artifacts
            (id,created_at,owner,path,name,size_bytes,sha256,state,delivered_via,metadata_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(
          manifest.artifact_id,
          manifest.delivered_at || now(),
          manifest.owner || "peer",
          filePath,
          manifest.name || manifest.file_name,
          stat.size,
          digest,
          verified ? "received_verified" : "received_mismatch",
          manifest.delivered_via || null,
          json(manifest.metadata),
        );
      }
      audit("receive", "artifact", manifest.artifact_id, verified ? "verified" : "mismatch", {
        path: filePath,
        size_bytes: stat.size,
        sha256: digest,
      });
      results.push({ artifact_id: manifest.artifact_id, path: filePath, verified });
    } catch (error) {
      audit("receive", "artifact", name, "rejected", { error: String(error) });
      results.push({ manifest: manifestPath, verified: false, error: String(error?.message || error) });
    }
  }
  return { artifacts: results };
}

function listAuditEvents(args) {
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 1000);
  const rows = args.object_type
    ? db.prepare(`
        SELECT * FROM audit_events WHERE object_type=?
        ORDER BY sequence DESC LIMIT ?
      `).all(args.object_type, limit)
    : db.prepare("SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?").all(limit);
  return rows.map((row) => ({
    ...row,
    details: JSON.parse(row.details_json),
    details_json: undefined,
  }));
}

const peerToolAllowlist = new Set([
  "link_status",
  "run_command",
  "receive_messages",
  "list_messages",
  "acknowledge_message",
  "create_job",
  "update_job_status",
  "list_jobs",
  "register_artifact",
  "verify_artifact",
  "send_artifact",
  "list_artifacts",
  "receive_artifacts",
  "flush_outbox",
  "list_audit_events",
  "create_queue",
  "configure_queue",
  "delete_queue",
  "list_queues",
  "queue_status",
  "enqueue_queue_item",
  "enqueue_queue_batch",
  "queue_control",
  "start_next_queue_item",
  "list_queue_adapters",
  "trainer_status",
  "trainer_run_status",
  "trainer_queue_status",
  "trainer_queue_detail",
  "trainer_validate_dataset",
  "trainer_tail_log",
  "trainer_audit_checkpoint_retention",
  "trainer_preservation_status",
  "trainer_start_authorized_job",
  "trainer_stop_authorized_job",
  "trainer_package_authorized_job",
  "trainer_queue_control",
  "lora_automation",
]);

function runCommand(args) {
  const command = String(args.command || "").trim();
  if (!command) throw new Error("command is required");

  const trackedJob = args.job_id
    ? db.prepare("SELECT * FROM jobs WHERE id=?").get(args.job_id)
    : null;
  if (args.job_id && !trackedJob) {
    throw new Error(`job not found: ${args.job_id}`);
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : os.homedir();
  const stat = fs.statSync(cwd);
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);

  const timeoutMs = Math.min(
    Math.max(Number(args.timeout_ms || 300000), 1000),
    24 * 60 * 60 * 1000,
  );
  const outputLimit = Math.min(
    Math.max(Number(args.output_limit_bytes || 1024 * 1024), 4096),
    16 * 1024 * 1024,
  );
  const startedAt = now();
  const started = Date.now();
  const result = spawnSync("/bin/zsh", ["-lc", command], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: outputLimit,
    env: process.env,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const commandId = id("command");
  const ok = result.status === 0 && !result.error;
  const details = {
    command,
    cwd,
    consequential: args.consequential === true,
    tracking_job_id: trackedJob?.id || null,
    started_at: startedAt,
    duration_ms: Date.now() - started,
    exit_code: result.status,
    signal: result.signal || null,
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    error: result.error ? String(result.error) : null,
  };
  audit("execute", "command", commandId, ok ? "completed" : "failed", details);
  return {
    command_id: commandId,
    ...details,
    stdout,
    stderr,
    ok,
  };
}

function loraAutomation(args) {
  const action = String(args.action || "").trim();
  const allowedActions = new Set([
    "inventory",
    "preflight",
    "preflight-all",
    "training-readiness",
    "prepare-versioned-job",
    "scheduler-enqueue",
    "stage-runtime-job",
    "telemetry",
    "queue",
    "compare",
    "recovery",
    "packet-audit",
    "packet-validation-plan",
    "registry-refresh",
    "validation-plan",
    "validation-ingest",
    "draw-things-plan",
    "draw-things-ingest",
    "revision-ingest",
    "estimate",
  ]);
  if (!allowedActions.has(action)) {
    throw new Error(`unsupported LoRA automation action: ${action}`);
  }
  if (action === "scheduler-enqueue") {
    const authorizationJobId = String(args.authorization_job_id || "").trim();
    const authorizationJob = requireTrackedJob(
      authorizationJobId,
      "training",
      ["authorized", "queued"],
    );
    const metadata = JSON.parse(authorizationJob.metadata_json || "{}");
    const binding = trainingAuthorizationBinding(authorizationJob, metadata);
    if (binding.target !== args.job_id) {
      throw new Error("training authorization target does not match scheduler target");
    }
    if (binding.revision_fingerprint !== args.revision_fingerprint) {
      throw new Error("training authorization fingerprint does not match scheduler fingerprint");
    }
  }
  const operationArgs = { ...args };
  delete operationArgs.action;
  delete operationArgs.timeout_ms;
  const result = spawnSync(process.execPath, [
    LORA_AUTOMATION_SCRIPT,
    action,
    JSON.stringify(operationArgs),
  ], {
    encoding: "utf8",
    timeout: Number(args.timeout_ms || 300000),
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      HAWKSPAN_CONFIG: CONFIG_PATH,
      HAWKSPAN_STATE_DIR: STATE_ROOT,
    },
  });
  const ok = result.status === 0 && !result.error;
  audit("execute", "lora_automation", action, ok ? "completed" : "failed", {
    arguments: operationArgs,
    status: result.status,
    error: result.error ? String(result.error) : null,
    stderr: result.stderr?.slice(-4000) || "",
  });
  if (!ok) {
    throw new Error(result.stderr?.trim() || result.error || `LoRA automation ${action} failed`);
  }
  return JSON.parse(result.stdout);
}

const delegatedTrainerTools = new Set([
  "trainer_start_authorized_job",
  "trainer_stop_authorized_job",
  "trainer_package_authorized_job",
]);

const replaySafePeerTools = new Set([
  "link_status",
  "receive_messages",
  "list_messages",
  "acknowledge_message",
  "list_jobs",
  "verify_artifact",
  "send_artifact",
  "list_artifacts",
  "receive_artifacts",
  "flush_outbox",
  "list_audit_events",
  "list_queues",
  "queue_status",
  "list_queue_adapters",
  "trainer_status",
  "trainer_run_status",
  "trainer_queue_status",
  "trainer_queue_detail",
  "trainer_validate_dataset",
  "trainer_tail_log",
  "trainer_audit_checkpoint_retention",
  "trainer_preservation_status",
]);

function delegatedJobRecord(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    creator: row.creator,
    assignee: row.assignee,
    kind: row.kind,
    title: row.title,
    description: row.description,
    state: row.state,
    authorization_state: row.authorization_state,
    authorization_evidence: row.authorization_evidence,
    metadata: JSON.parse(row.metadata_json),
  };
}

function importDelegatedJob(context, expectedJobId, options = {}) {
  if (process.env.HAWKSPAN_CALL_ORIGIN !== "peer") {
    throw new Error("delegated job context is accepted only from the paired peer");
  }
  if (!context || context.id !== expectedJobId) {
    throw new Error("delegated job identity does not match requested job");
  }
  if (!context.creator || !context.kind || !context.state) {
    throw new Error("delegated job context is incomplete");
  }
  const existing = db.prepare("SELECT * FROM jobs WHERE id=?").get(expectedJobId);
  if (existing && existing.creator !== context.creator) {
    throw new Error(`delegated job creator conflict: ${expectedJobId}`);
  }
  const preserveExisting = options.preserve_existing === true && existing;
  const existingMetadata = existing ? JSON.parse(existing.metadata_json || "{}") : {};
  const importedContext = preserveExisting ? {
    ...context,
    created_at: existing.created_at,
    updated_at: existing.updated_at,
    creator: existing.creator,
    assignee: existing.assignee,
    kind: existing.kind,
    title: existing.title,
    description: existing.description,
    state: existing.state,
    authorization_state: existing.authorization_state,
    authorization_evidence: existing.authorization_evidence,
    metadata: { ...(context.metadata || {}), ...existingMetadata },
  } : context;
  if (importedContext.kind === "training" &&
      importedContext.authorization_state === "recorded") {
    const importedBinding = trainingAuthorizationBinding(
      { metadata_json: json(importedContext.metadata) },
      importedContext.metadata,
    );
    if (existing?.kind === "training" && existing.authorization_state === "recorded") {
      const existingBinding = trainingAuthorizationBinding(existing, existingMetadata);
      if (existingBinding.target !== importedBinding.target ||
          existingBinding.revision_fingerprint !== importedBinding.revision_fingerprint) {
        throw new Error("delegated training authorization binding conflicts with local record");
      }
    }
  }
  const values = [
    importedContext.created_at || now(), importedContext.updated_at || now(), importedContext.creator,
    importedContext.assignee || config.node_id, importedContext.kind,
    importedContext.title || expectedJobId, importedContext.description || "",
    importedContext.state, importedContext.authorization_state || "not_required",
    importedContext.authorization_evidence || null,
    json(importedContext.metadata), expectedJobId,
  ];
  if (existing) {
    db.prepare(`
      UPDATE jobs SET created_at=?,updated_at=?,creator=?,assignee=?,kind=?,title=?,
        description=?,state=?,authorization_state=?,authorization_evidence=?,metadata_json=?
      WHERE id=?
    `).run(...values);
  } else {
    db.prepare(`
      INSERT INTO jobs
        (created_at,updated_at,creator,assignee,kind,title,description,state,
         authorization_state,authorization_evidence,metadata_json,id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(...values);
  }
  audit("import", "job", expectedJobId, importedContext.state, {
    creator: importedContext.creator,
    delegated: true,
    preserved_existing_execution_state: Boolean(preserveExisting),
  });
}

function peerCallTool(args) {
  if (!config.peer) throw new Error("peer is not configured");
  if (!peerToolAllowlist.has(args.tool_name)) {
    throw new Error(`peer tool is not allowed: ${args.tool_name}`);
  }
  const remoteNode = config.peer.remote_node || "node";
  const replaySafe = replaySafePeerTools.has(args.tool_name);
  const forwardedArguments = { ...(args.arguments || {}) };
  if (delegatedTrainerTools.has(args.tool_name) && forwardedArguments.job_id) {
    let job = db.prepare("SELECT * FROM jobs WHERE id=?").get(forwardedArguments.job_id);
    if (!job) throw new Error(`job not found: ${forwardedArguments.job_id}`);
    if (args.tool_name === "trainer_start_authorized_job" &&
        !forwardedArguments.expected_revision_fingerprint) {
      throw new Error("trainer start requires expected_revision_fingerprint");
    }
    if (args.tool_name === "trainer_start_authorized_job" && job.state === "authorized") {
      updateJobStatus({ job_id: job.id, state: "queued" });
      job = db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
    }
    if (args.tool_name === "trainer_stop_authorized_job" && job.state === "running") {
      updateJobStatus({ job_id: job.id, state: "cancel_requested" });
      job = db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
    }
    forwardedArguments._delegated_job = delegatedJobRecord(job);
  }
  const attempts = [];
  const deadline = beginLinkCycle();
  for (const { host, cycle, delay_ms: delayMs, is_last_route: isLastRoute } of routeAttemptPlan(
    peerCandidates(), config.link.operation_retry_delays_ms,
  )) {
      if (!reserveOperationAttempt(delayMs, deadline, isLastRoute)) {
        if (isLastRoute) break;
        continue;
      }
      const attemptDeadline = operationAttemptDeadline(deadline);
      const peerRelease = discoverPeerRelease(
        host,
        remainingLinkCycle(attemptDeadline, Math.max(15000, config.link.connect_timeout_ms + 5000)),
      );
      if (!peerRelease.ok) {
        attempts.push({ cycle, host, status: peerRelease.status ?? null, error: peerRelease.error, phase: "release_discovery" });
        recordRouteFailure(host);
        continue;
      }
      const remoteCallTool = path.posix.join(peerRelease.active_release_root, "scripts", "call-tool.mjs");
      const remoteCommand = [
        "env",
        "HAWKSPAN_CALL_ORIGIN=peer",
        shellQuote(remoteNode),
        shellQuote(remoteCallTool),
        shellQuote(args.tool_name),
        shellQuote(JSON.stringify(forwardedArguments)),
      ].join(" ");
      const result = spawnSync("ssh", sshArgs(host, remoteCommand), {
        encoding: "utf8",
        timeout: remainingLinkCycle(attemptDeadline, Number(args.timeout_ms || 300000)),
      });
      attempts.push({
        cycle,
        host,
        status: result.status,
        error: result.stderr?.trim() || "",
        revision: peerRelease.revision,
        active_release_root: peerRelease.active_release_root,
      });
      if (result.status !== 0) {
        recordRouteFailure(host);
        if (!replaySafe) {
          attempts.at(-1).phase = "tool_dispatch";
          attempts.at(-1).outcome = "unknown";
          audit("call", "peer_tool", args.tool_name, "outcome_unknown", {
            attempts,
            replay_suppressed: true,
          });
          return {
            tool_name: args.tool_name,
            error: "remote outcome unknown; dispatched tool was not replayed",
            outcome: "unknown",
            replay_suppressed: true,
            attempts,
          };
        }
        continue;
      }
      let output;
      try {
        output = JSON.parse(result.stdout);
      } catch {
        attempts.at(-1).error = `invalid JSON: ${result.stdout.slice(0, 1000)}`;
        recordRouteFailure(host);
        if (!replaySafe) {
          attempts.at(-1).phase = "tool_response";
          attempts.at(-1).outcome = "unknown";
          audit("call", "peer_tool", args.tool_name, "outcome_unknown", {
            attempts,
            replay_suppressed: true,
          });
          return {
            tool_name: args.tool_name,
            error: "remote outcome unknown; invalid response was not replayed",
            outcome: "unknown",
            replay_suppressed: true,
            attempts,
          };
        }
        continue;
      }
      recordRouteSuccess(host);
      audit("call", "peer_tool", args.tool_name, output.isError ? "error" : "ok", {
        host,
        peer_revision: peerRelease.revision,
        remote_is_error: Boolean(output.isError),
      });
      if (!output.isError && forwardedArguments.job_id) {
        const localJob = db.prepare("SELECT * FROM jobs WHERE id=?")
          .get(forwardedArguments.job_id);
        if (args.tool_name === "trainer_start_authorized_job" &&
            localJob?.state === "queued") {
          updateJobStatus({
            job_id: localJob.id,
            state: "running",
            metadata: {
              target: forwardedArguments.target || null,
              phase: "training",
              revision_fingerprint:
                forwardedArguments.expected_revision_fingerprint,
            },
          });
        }
        if (args.tool_name === "trainer_stop_authorized_job" &&
            localJob?.state === "cancel_requested") {
          updateJobStatus({
            job_id: localJob.id,
            state: "paused",
            metadata: { target: forwardedArguments.target || null, phase: "stopped" },
          });
        }
      }
      return { host, tool_name: args.tool_name, result: output, attempts };
  }
  audit("call", "peer_tool", args.tool_name, "failed", { attempts });
  return { tool_name: args.tool_name, error: "all routes failed", attempts };
}

function linkStatus() {
  ingestInbox();
  const counts = {
    inbound_unacknowledged: db.prepare(`
      SELECT count(*) AS count FROM messages
      WHERE direction='inbound' AND state='received'
        AND kind != 'acknowledgement'
    `).get().count,
    outbound_queued: db.prepare(`
      SELECT count(*) AS count FROM messages
      WHERE direction='outbound' AND state='queued'
    `).get().count,
    ...jobCountSummary(),
    artifacts: db.prepare("SELECT count(*) AS count FROM artifacts").get().count,
  };
  const readiness = runReadinessMonitor(config, { once: true });
  const routes = readiness.routes.map((route) => {
    const failed = route.layers.find((entry) => !entry.ok);
    return {
      role: route.role,
      label: route.label,
      host: route.host,
      local_host: route.local_host,
      network_reachable: route.network_reachable,
      transport_ready: route.transport_ready,
      ready: route.ready,
      failed_layer: route.failed_layer,
      transport_error: route.transport_ready ? "" : failed?.evidence || "",
      layers: route.layers,
    };
  });
  const selectedRoute = routes.find((route) => route.ready) ||
    routes.find((route) => route.transport_ready) ||
    null;
  return {
    node_id: config.node_id,
    state_root: STATE_ROOT,
    config_path: CONFIG_PATH,
    peer: config.peer ? {
      node_id: config.peer.node_id,
      primary_host: config.peer.primary_host,
      fallback_host: config.peer.fallback_host,
    } : null,
    routes,
    readiness,
    selected_route: selectedRoute?.host || null,
    counts,
    queue_registry: queueRegistry.listQueues(),
    queue_supervisor: {
      enabled: config.queue_supervisor.enabled,
      poll_interval_ms: config.queue_supervisor.poll_interval_ms,
      item_lease_ms: config.queue_supervisor.item_lease_ms,
      max_items_per_worker: config.queue_supervisor.max_items_per_worker,
      worker_restart_delays_ms: config.queue_supervisor.worker_restart_delays_ms,
    },
    local_control: localControl ? {
      enabled: true,
      host: localControl.host,
      port: localControl.port,
      url: localControl.url,
    } : { enabled: false },
  };
}

function trainerStatus() {
  const result = spawnSync("ps", ["-axo", "pid,ppid,etime,%cpu,%mem,command"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const matcher = new RegExp(
    [config.training.process_match, "run_captioned_loras\\.py"]
      .filter(Boolean)
      .join("|"),
    "i",
  );
  const processes = (result.stdout || "")
    .split("\n")
    .filter((line) => (
      matcher.test(line) &&
      !line.includes("mcp-server.mjs") &&
      !line.includes("codex exec resume") &&
      !line.includes("/Applications/ChatGPT.app/Contents/Resources/codex")
    ))
    .map((line) => line.trim());
  let logHeartbeat = null;
  try {
    const effectiveTraining = activeRuntimeConfig()?.training || config.training;
    const queueRoot = trainingDirectory(effectiveTraining, "queue_root");
    const logRoot = trainingDirectory(effectiveTraining, "log_root");
    const statusPath = path.join(queueRoot, "captioned-lora-status.json");
    const status = fs.existsSync(statusPath)
      ? JSON.parse(fs.readFileSync(statusPath, "utf8"))
      : {};
    const current = status.current || null;
    const logPath = current ? path.join(logRoot, `${current}.log`) : null;
    if (logPath && fs.existsSync(logPath)) {
      const ageSeconds = Math.max(
        0,
        (Date.now() - fs.statSync(logPath).mtimeMs) / 1000,
      );
      logHeartbeat = {
        current,
        log_path: logPath,
        age_seconds: ageSeconds,
        fresh: ageSeconds <= 120,
      };
    }
  } catch (error) {
    logHeartbeat = {
      fresh: false,
      error: String(error?.message || error),
    };
  }
  const processInspectionError = result.status === 0
    ? null
    : result.error?.message || result.stderr?.trim() || `ps exited ${result.status}`;
  const active = processes.length > 0 || Boolean(logHeartbeat?.fresh);
  const activeSource = processes.length > 0
    ? "process-list"
    : logHeartbeat?.fresh
      ? "fresh-log-heartbeat"
      : "none";
  audit("inspect", "trainer", null, "ok", {
    process_count: processes.length,
    active,
    active_source: activeSource,
    process_inspection_error: processInspectionError,
    log_heartbeat: logHeartbeat,
  });
  return {
    process_match: config.training.process_match,
    active,
    active_source: activeSource,
    processes,
    process_inspection_error: processInspectionError,
    log_heartbeat: logHeartbeat,
    allow_start: config.training.allow_start,
    allow_stop: config.training.allow_stop,
  };
}

function jobIdSet(entries) {
  return new Set(
    (entries || [])
      .map((entry) => typeof entry === "string" ? entry : entry?.job_id)
      .filter(Boolean),
  );
}

function configuredDirectory(key, required = true) {
  return trainingDirectory(config.training, key, required);
}

function trainingDirectory(training, key, required = true) {
  const value = training?.[key];
  if (!value && required) throw new Error(`training.${key} is not configured`);
  return value ? path.resolve(value) : null;
}

function assertWithin(candidate, roots) {
  const resolved = path.resolve(candidate);
  const allowed = roots.filter(Boolean).map((root) => path.resolve(root));
  if (!allowed.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`path is outside configured training roots: ${resolved}`);
  }
  return resolved;
}

function trainerQueueStatus() {
  const effectiveTraining = activeRuntimeConfig()?.training || config.training;
  const queueRoot = trainingDirectory(effectiveTraining, "queue_root");
  const entries = fs.existsSync(queueRoot)
    ? fs.readdirSync(queueRoot, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => {
          const itemPath = path.join(queueRoot, entry.name);
          const stat = fs.statSync(itemPath);
          return {
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
            modified_at: stat.mtime.toISOString(),
            size_bytes: entry.isFile() ? stat.size : null,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return { queue_root: queueRoot, exists: fs.existsSync(queueRoot), entries };
}

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"]);

function trainerValidateDataset(args) {
  const runtimeTraining = activeRuntimeConfig()?.training || null;
  const roots = [
    configuredDirectory("queue_root", false),
    configuredDirectory("simpletuner_root", false),
    trainingDirectory(runtimeTraining, "queue_root", false),
    trainingDirectory(runtimeTraining, "simpletuner_root", false),
  ];
  const datasetPath = assertWithin(args.path, roots);
  if (!fs.statSync(datasetPath).isDirectory()) throw new Error("dataset path must be a directory");
  const files = fs.readdirSync(datasetPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("._"));
  const images = files.filter((entry) => imageExtensions.has(path.extname(entry.name).toLowerCase()));
  const captions = new Set(
    files.filter((entry) => path.extname(entry.name).toLowerCase() === ".txt")
      .map((entry) => path.basename(entry.name, path.extname(entry.name))),
  );
  const missingCaptions = images
    .map((entry) => path.basename(entry.name, path.extname(entry.name)))
    .filter((stem) => !captions.has(stem));
  const emptyCaptions = images
    .map((entry) => path.basename(entry.name, path.extname(entry.name)))
    .filter((stem) => {
      const captionPath = path.join(datasetPath, `${stem}.txt`);
      return fs.existsSync(captionPath) && fs.statSync(captionPath).size === 0;
    });
  const result = {
    path: datasetPath,
    image_count: images.length,
    caption_count: captions.size,
    missing_captions: missingCaptions,
    empty_captions: emptyCaptions,
    valid: images.length > 0 && missingCaptions.length === 0 && emptyCaptions.length === 0,
  };
  audit("validate", "dataset", datasetPath, result.valid ? "valid" : "invalid", result);
  return result;
}

function trainerTailLog(args) {
  const runtimeTraining = activeRuntimeConfig()?.training || null;
  const roots = [
    configuredDirectory("log_root"),
    configuredDirectory("control_root", false),
    trainingDirectory(runtimeTraining, "log_root", false),
    trainingDirectory(runtimeTraining, "control_root", false),
  ];
  const logPath = assertWithin(args.path, roots);
  const lines = Math.min(Math.max(Number(args.lines || 100), 1), 2000);
  const result = spawnSync("tail", ["-n", String(lines), logPath], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "tail failed");
  return { path: logPath, lines, content: result.stdout };
}

function trainerAuditCheckpointRetention() {
  const runtimeConfig = activeRuntimeConfig();
  const effectiveTraining = runtimeConfig?.training || config.training;
  const effectiveAutomation = runtimeConfig?.lora_automation || config.lora_automation || {};
  const queueRoot = path.resolve(
    effectiveTraining.queue_root || config.training.queue_root,
  );
  if (!fs.existsSync(queueRoot) || !fs.statSync(queueRoot).isDirectory()) {
    throw new Error(`configured directory is unavailable: ${queueRoot}`);
  }
  const minimum = Number(effectiveTraining.minimum_checkpoint_retention || 10);
  const configs = [];
  const manifestPath = path.join(queueRoot, "captioned-lora-manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : [];
  const schedulerJobsPath = effectiveAutomation.scheduler_jobs_path ||
    config.lora_automation?.scheduler_jobs_path;
  let schedulerTargets = null;
  if (schedulerJobsPath && fs.existsSync(path.resolve(schedulerJobsPath))) {
    const scheduler = JSON.parse(fs.readFileSync(path.resolve(schedulerJobsPath), "utf8"));
    schedulerTargets = new Set(
      (scheduler.jobs || []).map((entry) => entry.target).filter(Boolean),
    );
  }
  const scopedManifest = schedulerTargets
    ? manifest.filter((job) => schedulerTargets.has(job.job_id))
    : manifest;
  for (const job of scopedManifest) {
    const filePath = path.join(path.resolve(job.config_dir || ""), "config.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!Object.hasOwn(parsed, "checkpoints_total_limit")) continue;
      const retention = Number(parsed.checkpoints_total_limit);
      const preservedRoot = parsed.output_dir
        ? path.join(path.resolve(parsed.output_dir), "PRESERVED_CHECKPOINTS")
        : null;
      const protectedByPreservedCheckpoints = Boolean(
        preservedRoot &&
        fs.existsSync(preservedRoot) &&
        fs.readdirSync(preservedRoot).some((name) => name.startsWith("checkpoint-")),
      );
      configs.push({
        job_id: job.job_id || null,
        path: filePath,
        checkpoints_total_limit: retention,
        meets_minimum: Number.isFinite(retention) && retention >= minimum,
        output_dir: parsed.output_dir || null,
        preserved_root: preservedRoot,
        protected_by_preserved_checkpoints: protectedByPreservedCheckpoints,
      });
    } catch {
      // Ignore unrelated or incomplete JSON; only parsed SimpleTuner configs count.
    }
  }
  const belowMinimum = configs.filter((entry) => !entry.meets_minimum);
  const unprotectedBelowMinimum = belowMinimum.filter(
    (entry) => !entry.protected_by_preserved_checkpoints,
  );
  const result = {
    queue_root: queueRoot,
    scope: schedulerTargets ? "scheduler" : "manifest-fallback",
    minimum,
    inventory_config_count: manifest.length,
    scheduler_target_count: schedulerTargets?.size ?? null,
    config_count: configs.length,
    below_minimum_count: belowMinimum.length,
    below_minimum: belowMinimum,
    unprotected_below_minimum_count: unprotectedBelowMinimum.length,
    valid: configs.length > 0 && unprotectedBelowMinimum.length === 0,
  };
  audit("audit", "checkpoint-retention", queueRoot, result.valid ? "valid" : "attention", result);
  return result;
}

function trainerPreservationStatus() {
  const effectiveTraining = activeRuntimeConfig()?.training || config.training;
  const preservationRoot = path.resolve(
    effectiveTraining.preservation_root || config.training.preservation_root,
  );
  const preservedRoots = [];
  if (fs.existsSync(preservationRoot)) {
    const pending = [preservationRoot];
    while (pending.length) {
      const current = pending.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      if (path.basename(current) === "PRESERVED_CHECKPOINTS") {
        preservedRoots.push({
          path: current,
          checkpoints: entries
            .filter((entry) => entry.isDirectory() && entry.name.startsWith("checkpoint-"))
            .map((entry) => entry.name)
            .sort(),
        });
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          pending.push(path.join(current, entry.name));
        }
      }
    }
  }
  return {
    preservation_root: preservationRoot,
    exists: fs.existsSync(preservationRoot),
    preserved_roots: preservedRoots,
    preserved_checkpoint_count: preservedRoots.reduce(
      (total, entry) => total + entry.checkpoints.length,
      0,
    ),
  };
}

function durationTextToSeconds(value) {
  if (!value) return null;
  const parts = String(value).split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function trainerControlRecords() {
  const controlRoot = path.resolve(
    config.training.control_root || path.join(STATE_ROOT, "trainer-control"),
  );
  if (!fs.existsSync(controlRoot)) return [];
  return fs.readdirSync(controlRoot, { withFileTypes: true })
    .filter((entry) =>
      entry.isFile() && entry.name.endsWith(".json") &&
      !entry.name.endsWith(".status.json") &&
      !entry.name.endsWith(".package-status.json"))
    .map((entry) => path.join(controlRoot, entry.name))
    .sort((left, right) =>
      fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

function latestTrainerControlRecord(preferredTarget = null) {
  const records = [];
  for (const recordPath of trainerControlRecords()) {
    try {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      if (record?.durable_job_id && record?.target && record?.pid) {
        records.push({ ...record, record_path: recordPath });
      }
    } catch {
      // Ignore an interrupted control-record write and inspect older records.
    }
  }
  return records.find((record) =>
    ["started", "running", "stop_requested"].includes(record.state) &&
    trainerRecordIsActive(record)
  ) || records.find((record) =>
    !["interrupted_no_checkpoint", "interrupted_recoverable"].includes(record.state)
  ) || records.find((record) =>
    preferredTarget && record.target === preferredTarget
  ) || records[0] || null;
}

function trainerRecordIsActive(record) {
  try {
    process.kill(Number(record.pid), 0);
  } catch {
    return false;
  }
  const inspected = spawnSync(
    "/bin/ps",
    ["-p", String(record.pid), "-o", "command="],
    { encoding: "utf8", timeout: 5000 },
  );
  if (inspected.status !== 0) return false;
  const command = inspected.stdout || "";
  return command.includes(String(record.runner || "")) &&
    command.includes(String(record.target));
}

function activeRuntimeConfig() {
  const pointerPath = path.resolve(
    config.lora_automation?.active_runtime_pointer ||
      path.join(path.dirname(CONFIG_PATH), "active-lora-runtime.json"),
  );
  if (!fs.existsSync(pointerPath)) return null;
  const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  if (!pointer?.config_path || !pointer?.runtime_root) return null;
  const runtimeRoot = path.resolve(pointer.runtime_root);
  const runtimeConfigPath = path.resolve(pointer.config_path);
  if (!runtimeConfigPath.startsWith(`${runtimeRoot}${path.sep}`) ||
      !fs.existsSync(runtimeConfigPath)) {
    throw new Error("active runtime configuration is missing or outside its runtime root");
  }
  return JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
}

function trainerCheckpointStatus(checkpointPath, preserved) {
  const name = path.basename(checkpointPath);
  const match = /^checkpoint-(\d+)$/.exec(name);
  const expectedStep = match ? Number(match[1]) : null;
  const required = [
    "pytorch_lora_weights.safetensors",
    "optimizer.bin",
    "scheduler.bin",
    "training_state.json",
  ];
  const problems = [];
  for (const fileName of required) {
    const filePath = path.join(checkpointPath, fileName);
    if (!fs.existsSync(filePath)) {
      problems.push(`missing_required_file:${fileName}`);
      continue;
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) problems.push(`required_path_not_regular_file:${fileName}`);
    else if (stat.size <= 0) problems.push(`required_file_empty:${fileName}`);
  }
  let globalStep = null;
  const statePath = path.join(checkpointPath, "training_state.json");
  if (!problems.some((problem) => problem.endsWith(":training_state.json"))) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      globalStep = state?.global_step;
      if (!Number.isSafeInteger(globalStep) || globalStep < 1) {
        problems.push("training_state_global_step_invalid");
      } else if (globalStep !== expectedStep) {
        problems.push("checkpoint_basename_global_step_mismatch");
      }
    } catch {
      problems.push("training_state_json_invalid");
    }
  }
  return {
    name,
    path: checkpointPath,
    preserved,
    step: expectedStep,
    global_step: Number.isSafeInteger(globalStep) ? globalStep : null,
    complete: problems.length === 0,
    problems,
  };
}

function trainerRunStatus() {
  const runtimeConfig = activeRuntimeConfig();
  const effectiveTraining = runtimeConfig?.training || config.training;
  const queueRoot = path.resolve(effectiveTraining.queue_root);
  const logRoot = path.resolve(effectiveTraining.log_root);
  const statusPath = path.join(queueRoot, "captioned-lora-status.json");
  const manifestPath = path.join(queueRoot, "captioned-lora-manifest.json");
  const queueStatus = fs.existsSync(statusPath)
    ? JSON.parse(fs.readFileSync(statusPath, "utf8"))
    : {};
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : [];
  const adapterRecord = latestTrainerControlRecord(queueStatus.current || null);
  const adapterActive = Boolean(
    adapterRecord &&
    ["started", "stop_requested"].includes(adapterRecord.state) &&
    trainerRecordIsActive(adapterRecord),
  );
  const adapterStatus = adapterRecord?.status_path &&
    fs.existsSync(adapterRecord.status_path)
    ? JSON.parse(fs.readFileSync(adapterRecord.status_path, "utf8"))
    : {};
  const directRunState = adapterRecord
    ? adapterActive
      ? "running"
      : jobIdSet(adapterStatus.trained).has(adapterRecord.target)
        ? "completed"
        : jobIdSet(adapterStatus.failed).has(adapterRecord.target)
          ? "failed"
          : adapterRecord.state
    : null;
  const adapterInterrupted = ["interrupted_no_checkpoint", "interrupted_recoverable"]
    .includes(directRunState);
  const status = adapterRecord
    ? { ...queueStatus, ...adapterStatus }
    : queueStatus;
  const current = adapterActive
    ? adapterRecord.target
    : adapterInterrupted
      ? (queueStatus.current === adapterRecord.target ? null : queueStatus.current || null)
      : (status.current || null);
  const currentJob = manifest.find((entry) => entry.job_id === current) || null;
  const logPath = adapterActive && adapterRecord.log_path
    ? adapterRecord.log_path
    : current ? path.join(logRoot, `${current}.log`) : null;
  let progress = null;
  if (logPath && fs.existsSync(logPath)) {
    const stat = fs.statSync(logPath);
    const bytes = Math.min(stat.size, 1024 * 1024);
    const fd = fs.openSync(logPath, "r");
    const buffer = Buffer.alloc(bytes);
    try {
      fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8")
      .replaceAll("\r", "\n")
      .replace(/\u001b\[[0-9;]*m/g, "");
    const pattern = /Epoch\s+(\d+)\/(\d+),?\s+Steps:\s+(\d+)%[^\n]*?\|\s*(\d+)\/(\d+)\s+\[([^\]]+)\]/g;
    for (const match of text.matchAll(pattern)) {
      const timing = match[6];
      const eta = timing.match(/<([^,\]]+)/)?.[1] || null;
      const secondsPerIteration = timing.match(/([\d.]+)s\/it/)?.[1] || null;
      const learningRate = timing.match(/lr=([^,\]]+)/)?.[1] || null;
      const stepLoss = timing.match(/step_loss=([^,\]\s]+)/)?.[1] || null;
      progress = {
        epoch: Number(match[1]),
        epochs_total: Number(match[2]),
        percent: Number(match[3]),
        step: Number(match[4]),
        steps_total: Number(match[5]),
        eta,
        eta_seconds: eta ? durationTextToSeconds(eta) : null,
        seconds_per_iteration: secondsPerIteration === null
          ? null
          : Number(secondsPerIteration),
        learning_rate: learningRate === null ? null : Number(learningRate),
        step_loss: stepLoss === null ? null : Number(stepLoss),
      };
    }
  }
  const checkpoints = [];
  if (currentJob?.output_dir && fs.existsSync(currentJob.output_dir)) {
    for (const entry of fs.readdirSync(currentJob.output_dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("checkpoint-")) {
        const checkpointPath = path.join(currentJob.output_dir, entry.name);
        checkpoints.push(trainerCheckpointStatus(checkpointPath, false));
      }
    }
    const preservedRoot = path.join(currentJob.output_dir, "PRESERVED_CHECKPOINTS");
    if (fs.existsSync(preservedRoot)) {
      for (const entry of fs.readdirSync(preservedRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("checkpoint-")) {
          const checkpointPath = path.join(preservedRoot, entry.name);
          checkpoints.push(trainerCheckpointStatus(checkpointPath, true));
        }
      }
    }
  }
  const process = trainerStatus();
  const effectiveCurrentJob = currentJob
    ? {
        ...currentJob,
        state: adapterRecord?.target === current
          ? directRunState
          : "running",
      }
    : null;
  const result = {
    batch: status.batch || null,
    queue_total: Number(status.total || manifest.length),
    current,
    current_job: effectiveCurrentJob,
    completed: status.completed || [],
    failed: status.failed || [],
    remaining: Math.max(
      0,
      Number(status.total || manifest.length) -
        (status.completed?.length || 0) -
        (status.failed?.length || 0),
    ),
    started_at: status.started_at || null,
    current_started_at: status.current_started_at || null,
    process_active: process.active,
    activity_source: process.active_source,
    process_inspection_error: process.process_inspection_error,
    log_heartbeat: process.log_heartbeat,
    progress,
    log_path: logPath,
    checkpoints: checkpoints.sort((a, b) => a.name.localeCompare(b.name)),
    direct_run: adapterRecord ? {
      durable_job_id: adapterRecord.durable_job_id,
      target: adapterRecord.target,
      state: directRunState,
      pid: adapterRecord.pid,
      process_group: adapterRecord.process_group || null,
      revision_fingerprint: adapterRecord.revision_fingerprint || null,
      readiness_path: adapterRecord.readiness_path || null,
      status_path: adapterRecord.status_path || null,
      log_path: adapterRecord.log_path || null,
      record_path: adapterRecord.record_path,
      active: adapterActive,
    } : null,
  };
  audit("inspect", "trainer_run", current, "ok", {
    process_active: result.process_active,
    step: progress?.step || null,
    steps_total: progress?.steps_total || null,
  });
  return result;
}

function trainerQueueDetail() {
  const effectiveTraining = activeRuntimeConfig()?.training || config.training;
  const queueRoot = trainingDirectory(effectiveTraining, "queue_root");
  const statusPath = path.join(queueRoot, "captioned-lora-status.json");
  const manifestPath = path.join(queueRoot, "captioned-lora-manifest.json");
  const status = fs.existsSync(statusPath)
    ? JSON.parse(fs.readFileSync(statusPath, "utf8"))
    : {};
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : [];
  const completed = jobIdSet(status.completed);
  const failed = jobIdSet(status.failed);
  return {
    batch: status.batch || null,
    jobs: manifest.map((job) => ({
      ...job,
      state: job.job_id === status.current
        ? "running"
        : completed.has(job.job_id)
          ? "completed"
          : failed.has(job.job_id)
            ? "failed"
            : "pending",
    })),
  };
}

function requireAuthorizedJob(jobId, kind, allowedStates) {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
  if (!row) throw new Error(`job not found: ${jobId}`);
  if (kind && row.kind !== kind) throw new Error(`job kind must be ${kind}`);
  if (row.authorization_state !== "recorded") {
    throw new Error("job does not contain recorded explicit authorization");
  }
  if (!allowedStates.includes(row.state)) {
    throw new Error(`job state ${row.state} is not allowed for this operation`);
  }
  return row;
}

function requireTrackedJob(jobId, kind, allowedStates) {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
  if (!row) throw new Error(`job not found: ${jobId}`);
  if (kind && row.kind !== kind) throw new Error(`job kind must be ${kind}`);
  if (allowedStates && !allowedStates.includes(row.state)) {
    throw new Error(`job state ${row.state} is not allowed for this operation`);
  }
  return row;
}

function runConfiguredScript(scriptKey, allowKey, args, jobKind, allowedStates) {
  if (!config.training[allowKey]) throw new Error(`training.${allowKey} is disabled`);
  if (args._delegated_job) importDelegatedJob(args._delegated_job, args.job_id);
  const job = requireAuthorizedJob(args.job_id, jobKind, allowedStates);
  const scriptPath = path.resolve(config.training[scriptKey] || "");
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    throw new Error(`training.${scriptKey} is not configured to an existing script`);
  }
  const commandArgs = ["--job-id", job.id];
  if (args.target) commandArgs.push("--target", String(args.target));
  if (args.expected_revision_fingerprint) {
    commandArgs.push(
      "--expected-revision-fingerprint",
      String(args.expected_revision_fingerprint),
    );
  }
  const result = spawnSync(scriptPath, commandArgs, {
    encoding: "utf8",
    timeout: Number(args.timeout_ms || 30000),
  });
  const ok = result.status === 0;
  audit("execute", "trainer", job.id, ok ? "started" : "failed", {
    script: scriptPath,
    status: result.status,
    stdout: result.stdout?.slice(-4000) || "",
    stderr: result.stderr?.slice(-4000) || "",
  });
  if (!ok) throw new Error(result.stderr?.trim() || `${scriptKey} failed`);
  return { job_id: job.id, script: scriptPath, stdout: result.stdout?.trim() || "" };
}

function trainerStartAuthorizedJob(args) {
  if (args._delegated_job) importDelegatedJob(args._delegated_job, args.job_id);
  let job = requireAuthorizedJob(args.job_id, "training", ["authorized", "queued"]);
  if (!args.expected_revision_fingerprint) {
    throw new Error("trainer start requires expected_revision_fingerprint");
  }
  const binding = trainingAuthorizationBinding(job);
  if (binding.target !== args.target) {
    throw new Error("trainer start target does not match recorded authorization");
  }
  if (binding.revision_fingerprint !== args.expected_revision_fingerprint) {
    throw new Error("trainer start fingerprint does not match recorded authorization");
  }
  const schedulerJobsPath = config.lora_automation?.scheduler_jobs_path;
  if (schedulerJobsPath && fs.existsSync(path.resolve(schedulerJobsPath))) {
    const scheduler = JSON.parse(fs.readFileSync(path.resolve(schedulerJobsPath), "utf8"));
    if ((scheduler.jobs || []).some((entry) => entry.target === args.target)) {
      throw new Error("queued SimpleTuner targets must be launched by the scheduler");
    }
  }
  if (job.state === "authorized") {
    updateJobStatus({ job_id: job.id, state: "queued" });
  }
  try {
    const result = runConfiguredScript(
      "start_script", "allow_start", { ...args, _delegated_job: null }, "training", ["queued"],
    );
    updateJobStatus({
      job_id: job.id,
      state: "running",
      metadata: {
        target: args.target || null,
        phase: "training",
        revision_fingerprint: args.expected_revision_fingerprint,
      },
    });
    return result;
  } catch (error) {
    job = requireTrackedJob(args.job_id, "training", ["queued"]);
    updateJobStatus({
      job_id: job.id,
      state: "failed",
      metadata: { target: args.target || null, phase: "start-failed", error: String(error.message || error) },
    });
    throw error;
  }
}

function trainerQueueControlScript(args) {
  const resolved = path.join(path.dirname(new URL(import.meta.url).pathname), "lora-queue-control.py");
  const commandArgs = [String(args.action)];
  if (args.target) commandArgs.push("--target", String(args.target));
  if (args.reason) commandArgs.push("--reason", String(args.reason));
  const result = spawnSync("/usr/bin/python3", [resolved, ...commandArgs], {
    encoding: "utf8",
    timeout: Number(args.timeout_ms || 30000),
    env: { ...process.env, HAWKSPAN_CONFIG: CONFIG_PATH },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "queue control failed");
  }
  return JSON.parse(result.stdout);
}

function trainerStopAuthorizedJob(args) {
  if (args._delegated_job) importDelegatedJob(args._delegated_job, args.job_id);
  const job = requireAuthorizedJob(args.job_id, "training", ["running", "cancel_requested"]);
  const binding = trainingAuthorizationBinding(job);
  if (binding.target !== args.target) {
    throw new Error("trainer stop target does not match recorded authorization");
  }
  if (job.state === "running") updateJobStatus({ job_id: job.id, state: "cancel_requested" });
  const result = runConfiguredScript(
    "stop_script", "allow_stop", { ...args, _delegated_job: null }, "training", ["cancel_requested"],
  );
  updateJobStatus({
    job_id: job.id,
    state: "paused",
    metadata: { target: args.target || null, phase: "stopped" },
  });
  const queueControl = args.target
    ? trainerQueueControlScript({
      action: "pause-job",
      target: args.target,
      reason: "exact authorized stop completed; explicit resume is required",
      timeout_ms: args.timeout_ms,
    })
    : null;
  return { ...result, queue_control: queueControl };
}

function trainerPackageAuthorizedJob(args) {
  if (args._delegated_job) {
    importDelegatedJob(args._delegated_job, args.job_id, {
      preserve_existing: true,
    });
  }
  let job = requireAuthorizedJob(args.job_id, "training", ["failed", "returning", "completed"]);
  const metadata = JSON.parse(job.metadata_json || "{}");
  if (!args.target || metadata.target !== args.target) {
    throw new Error(
      `package target must match durable training target ${metadata.target || "<missing>"}`,
    );
  }
  if (!args.expected_revision_fingerprint) {
    throw new Error("trainer package requires expected_revision_fingerprint");
  }
  if (!metadata.revision_fingerprint ||
      metadata.revision_fingerprint !== args.expected_revision_fingerprint) {
    throw new Error(
      "package revision fingerprint must match the revision recorded at training start",
    );
  }
  if (job.state === "failed") {
    if (metadata.phase !== "package_return") {
      throw new Error("only a package-return failure can be retried by package control");
    }
    updateJobStatus({
      job_id: job.id,
      state: "queued",
      metadata: { ...metadata, phase: "package_return", package_retry_state: "queued" },
    });
    updateJobStatus({
      job_id: job.id,
      state: "running",
      metadata: { ...metadata, phase: "package_return", package_retry_state: "running" },
    });
    job = requireTrackedJob(job.id, "training", ["running"]);
  }
  try {
    return runConfiguredScript(
      "package_script", "allow_package", { ...args, _delegated_job: null },
      "training", ["running", "returning", "completed"],
    );
  } catch (error) {
    job = requireTrackedJob(job.id, "training");
    if (job.state === "running") {
      updateJobStatus({
        job_id: job.id,
        state: "failed",
        metadata: { ...metadata, phase: "package_return", error: String(error.message || error) },
      });
    }
    throw error;
  }
}

function trainerQueueControl(args) {
  if (args.action === "resume-job" && !args.reason?.trim()) {
    throw new Error("resume-job requires a reason recording the explicit resume instruction");
  }
  let durableJob = null;
  let originalDurableState = null;
  let originalDurableMetadata = null;
  if (["resume-job", "retry-job"].includes(args.action)) {
    const expectedState = args.action === "resume-job" ? "paused" : "failed";
    const schedulerPath = config.lora_automation?.scheduler_jobs_path;
    if (!schedulerPath || !fs.existsSync(schedulerPath)) {
      throw new Error(`${args.action} requires configured scheduler state`);
    }
    const scheduler = JSON.parse(fs.readFileSync(schedulerPath, "utf8"));
    const schedulerJob = (scheduler.jobs || []).find((entry) => entry.target === args.target);
    if (!schedulerJob?.authorization_job_id) {
      throw new Error(`${args.action} requires a scheduler job linked to a durable authorization job`);
    }
    durableJob = requireTrackedJob(schedulerJob.authorization_job_id, "training", [expectedState, "queued"]);
    const metadata = JSON.parse(durableJob.metadata_json || "{}");
    const retryingPendingAuthorization = durableJob.state === "queued" &&
      metadata.phase === `${args.action}-pending-scheduler` &&
      metadata.target === args.target;
    const schedulerStatePath = config.lora_automation?.scheduler_state_path;
    const schedulerState = schedulerStatePath && fs.existsSync(schedulerStatePath)
      ? JSON.parse(fs.readFileSync(schedulerStatePath, "utf8"))
      : { jobs: {} };
    const resumingQueuedPausedJob = args.action === "resume-job" &&
      durableJob.state === "queued" &&
      schedulerState.jobs?.[schedulerJob.job_id]?.state === "paused";
    const retryingQueuedSkippedJob = args.action === "retry-job" &&
      durableJob.state === "queued" &&
      schedulerState.jobs?.[schedulerJob.job_id]?.state === "skipped";
    if (durableJob.state === "queued" &&
        !retryingPendingAuthorization && !resumingQueuedPausedJob &&
        !retryingQueuedSkippedJob) {
      throw new Error(`job state ${durableJob.state} is not allowed for this operation`);
    }
    originalDurableState = resumingQueuedPausedJob || retryingQueuedSkippedJob
      ? "queued"
      : expectedState;
    originalDurableMetadata = metadata;
    if (durableJob.state !== "queued") {
      updateJobStatus({
        job_id: durableJob.id,
        state: "queued",
        metadata: {
          target: args.target,
          phase: `${args.action}-pending-scheduler`,
          reason: args.reason || null,
        },
      });
    }
  }
  let output;
  try {
    output = trainerQueueControlScript(args);
  } catch (error) {
    if (durableJob) {
      db.prepare("UPDATE jobs SET state=?,updated_at=?,metadata_json=? WHERE id=?").run(
        originalDurableState,
        now(),
        json(originalDurableMetadata),
        durableJob.id,
      );
      audit("transition", "job", durableJob.id, originalDurableState, {
        rollback_of: args.action,
        reason: String(error.message || error),
      });
    }
    throw error;
  }
  if (durableJob) {
    const row = db.prepare("SELECT metadata_json FROM jobs WHERE id=?").get(durableJob.id);
    db.prepare("UPDATE jobs SET updated_at=?,metadata_json=? WHERE id=?").run(
      now(),
      json({
        ...JSON.parse(row.metadata_json || "{}"),
        target: args.target,
        phase: args.action,
        reason: args.reason || null,
        scheduler_eligible_at: now(),
      }),
      durableJob.id,
    );
    output.authorization_job_id = durableJob.id;
  }
  if (args.action === "pause-queue") {
    output.stopped_jobs = [];
    for (const active of output.active_jobs || []) {
      if (!active.authorization_job_id || !active.target) continue;
      const stopped = runConfiguredScript(
        "stop_script", "allow_stop",
        { job_id: active.authorization_job_id, target: active.target, timeout_ms: args.timeout_ms },
        "training", ["running"],
      );
      const afterStop = db.prepare("SELECT * FROM jobs WHERE id=?").get(active.authorization_job_id);
      if (afterStop?.state === "running") {
        updateJobStatus({
          job_id: afterStop.id,
          state: "paused",
          metadata: { target: active.target, phase: "paused-with-queue" },
        });
      }
      trainerQueueControlScript({
        action: "pause-job",
        target: active.target,
        reason: args.reason || "whole SimpleTuner queue paused",
        timeout_ms: args.timeout_ms,
      });
      output.stopped_jobs.push(stopped);
    }
  }
  audit("control", "trainer_queue", args.target || "queue", "ok", {
    action: args.action,
    reason: args.reason || "",
    resume_authorization: args.action === "resume-job"
      ? "explicit_control_call"
      : null,
  });
  return output;
}

const BUILTIN_QUEUE_ADAPTERS = new Set(["message", "artifact", "command"]);
const QUEUE_MANAGEMENT_TOOLS = new Set([
  "create_queue", "configure_queue", "delete_queue", "list_queues", "queue_status",
  "enqueue_queue_item", "enqueue_queue_batch", "queue_control", "start_next_queue_item",
  "supervise_queue",
  "list_queue_adapters",
]);
const SINGLETON_LIFECYCLE_TOOLS = new Set([
  "trainer_start_authorized_job",
  "trainer_stop_authorized_job",
  "trainer_package_authorized_job",
  "trainer_queue_control",
]);

function queueDefinition(queueId) {
  return queueRegistry.queueStatus({ queue_id: queueId, limit: 1 }).queue;
}

function validateQueueAdapter(adapter) {
  if (BUILTIN_QUEUE_ADAPTERS.has(adapter)) return;
  if (!adapter.startsWith("tool:")) throw new Error(`unsupported queue adapter: ${adapter}`);
  const toolName = adapter.slice(5);
  if (!toolMap.has(toolName)) throw new Error(`registered application tool not found: ${toolName}`);
  if (QUEUE_MANAGEMENT_TOOLS.has(toolName)) {
    throw new Error(`queue management tools cannot be queue adapters: ${toolName}`);
  }
  if (SINGLETON_LIFECYCLE_TOOLS.has(toolName)) {
    throw new Error(
      `SimpleTuner lifecycle tools cannot create generic queues; use the single durable SimpleTuner scheduler: ${toolName}`,
    );
  }
}

function createQueueSurface(args) {
  validateQueueAdapter(String(args.adapter || ""));
  const result = queueRegistry.createQueue(args);
  audit("create", "queue", args.queue_id, result.created ? "created" : "already_present", result.queue);
  return result;
}

function configureQueueSurface(args) {
  const result = queueRegistry.configureQueue(args);
  audit("configure", "queue", args.queue_id, "configured", result.queue);
  return result;
}

function normalizeQueuePayload(queue, payload = {}, rollbackFiles = []) {
  if (queue.adapter === "message" && !payload.message_id) {
    if (!payload.subject || !payload.body) {
      throw new Error("message queue items require message_id or subject and body");
    }
    const message = sendMessage(
      { ...payload, deliver: false },
      { onEnvelopeWritten: (envelopePath) => rollbackFiles.push(envelopePath) },
    );
    return { message_id: message.message_id, wake: payload.wake !== false };
  }
  if (queue.adapter === "artifact" && !payload.artifact_id) {
    if (!payload.path) throw new Error("artifact queue items require artifact_id or path");
    const artifact = registerArtifact({
      path: payload.path,
      name: payload.name,
      metadata: payload.metadata,
    });
    return { artifact_id: artifact.artifact_id };
  }
  if (queue.adapter === "command" && !payload.command) {
    throw new Error("command queue items require command");
  }
  return payload;
}

function enqueueQueueItemSurface(args) {
  const queue = queueDefinition(args.queue_id);
  const rollbackFiles = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const payload = normalizeQueuePayload(queue, args.payload || {}, rollbackFiles);
    const result = queueRegistry.enqueueItem({ ...args, payload });
    audit("enqueue", "queue_item", result.item.item_id, "queued", {
      queue_id: args.queue_id,
      adapter: queue.adapter,
    });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    for (const filePath of rollbackFiles) fs.rmSync(filePath, { force: true });
    throw error;
  }
}

function enqueueQueueBatchSurface(args) {
  const queue = queueDefinition(args.queue_id);
  const rollbackFiles = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const items = args.items.map((entry) => ({
      ...entry,
      payload: normalizeQueuePayload(queue, entry.payload || {}, rollbackFiles),
    }));
    const result = queueRegistry.enqueueBatch(
      { queue_id: args.queue_id, items },
      { withinTransaction: true },
    );
    audit("enqueue_batch", "queue", args.queue_id, "queued", { count: items.length });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    for (const filePath of rollbackFiles) fs.rmSync(filePath, { force: true });
    throw error;
  }
}

function queueControlSurface(args) {
  const result = queueRegistry.control(args);
  audit("control", "queue", args.queue_id, args.action, {
    item_id: args.item_id || null,
    reason: args.reason || "",
    priority: args.priority ?? null,
  });
  return result;
}

function deleteQueueSurface(args) {
  const result = queueRegistry.deleteQueue(args);
  audit("delete", "queue", args.queue_id, "deleted");
  return result;
}

function executeAdapterTool(toolName, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(SCRIPT_ROOT, "call-tool.mjs"),
      toolName,
      JSON.stringify(payload || {}),
    ], {
      env: {
        ...process.env,
        HAWKSPAN_STATE_DIR: STATE_ROOT,
        HAWKSPAN_CONFIG: CONFIG_PATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (target, chunk) => {
      const next = target + chunk;
      if (Buffer.byteLength(next) > 16 * 1024 * 1024) {
        child.kill("SIGTERM");
        throw new Error("queue adapter output exceeded 16 MiB");
      }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${toolName} adapter exited ${code ?? signal}`));
        return;
      }
      try {
        const response = JSON.parse(stdout);
        if (response.isError) {
          reject(new Error(response.content?.[0]?.text || `${toolName} reported failure`));
          return;
        }
        resolve(response.structuredContent ?? { content: response.content || [] });
      } catch (error) {
        reject(new Error(`invalid ${toolName} adapter response: ${error.message}`));
      }
    });
  });
}

async function executeQueueAdapter(queue, item) {
  const toolName = queue.adapter === "message"
    ? "retry_message"
    : queue.adapter === "artifact"
      ? "send_artifact"
      : queue.adapter === "command"
        ? "run_command"
        : queue.adapter.slice(5);
  validateQueueAdapter(queue.adapter);
  const result = await executeAdapterTool(toolName, item.payload);
  if (result?.ok === false || result?.delivery?.ok === false ||
      (queue.adapter === "artifact" && result?.delivery?.verified !== true)) {
    throw Object.assign(new Error(result.error || `${toolName} reported failure`), { result });
  }
  return result;
}

async function superviseQueue(args) {
  const queue = queueDefinition(args.queue_id);
  validateQueueAdapter(queue.adapter);
  const workerId = String(args.worker_id || `worker-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const maxItems = Math.min(
    Math.max(Number(args.max_items || config.queue_supervisor.max_items_per_worker), 1),
    1000,
  );
  const outcomes = [];
  for (let index = 0; index < maxItems; index += 1) {
    const claim = queueRegistry.claim({
      queue_id: queue.queue_id,
      worker_id: workerId,
      lease_ms: config.queue_supervisor.item_lease_ms,
    });
    if (!claim.claimed) {
      return { queue_id: queue.queue_id, worker_id: workerId, outcomes, idle: true, reason: claim.reason };
    }
    try {
      const heartbeatMs = Math.max(1000, Math.floor(config.queue_supervisor.item_lease_ms / 3));
      const heartbeat = setInterval(() => {
        try {
          queueRegistry.renewLease({
            queue_id: queue.queue_id,
            item_id: claim.item.item_id,
            worker_id: workerId,
            lease_token: claim.item.lease_token,
            lease_ms: config.queue_supervisor.item_lease_ms,
          });
        } catch {
          clearInterval(heartbeat);
        }
      }, heartbeatMs);
      let result;
      try {
        result = await executeQueueAdapter(queue, claim.item);
      } finally {
        clearInterval(heartbeat);
      }
      const item = queueRegistry.complete({
        queue_id: queue.queue_id,
        item_id: claim.item.item_id,
        worker_id: workerId,
        lease_token: claim.item.lease_token,
        result,
      });
      outcomes.push({ item_id: item.item_id, state: item.state, result });
      audit("complete", "queue_item", item.item_id, "completed", { queue_id: queue.queue_id });
    } catch (error) {
      const message = String(error?.message || error);
      const item = queueRegistry.fail({
        queue_id: queue.queue_id,
        item_id: claim.item.item_id,
        worker_id: workerId,
        lease_token: claim.item.lease_token,
        error: message,
        result: error?.result || null,
      });
      outcomes.push({ item_id: item.item_id, state: item.state, error: item.error, next_attempt_at: item.next_attempt_at });
      audit("fail", "queue_item", item.item_id, item.state, {
        queue_id: queue.queue_id,
        error: item.error,
        next_attempt_at: item.next_attempt_at,
      });
      if (item.state === "queued") break;
    }
  }
  return { queue_id: queue.queue_id, worker_id: workerId, outcomes, idle: false };
}

async function startNextQueueItem(args) {
  return superviseQueue({
    queue_id: args.queue_id,
    worker_id: args.worker_id,
    max_items: 1,
  });
}

const coreTools = [
  {
    name: "link_status",
    description: "Read route, queue, job, and artifact status for this HawkSpan node.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: linkStatus,
  },
  {
    name: "list_queue_adapters",
    description: "List built-in and registered application adapters available to newly created queues.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: () => ({
      adapters: [
        ...[...BUILTIN_QUEUE_ADAPTERS].map((adapter) => ({ adapter, source: "builtin" })),
        ...[...toolMap.keys()]
          .filter((name) => !QUEUE_MANAGEMENT_TOOLS.has(name) && !SINGLETON_LIFECYCLE_TOOLS.has(name))
          .sort()
          .map((name) => ({ adapter: `tool:${name}`, source: "registered_tool" })),
      ],
    }),
  },
  {
    name: "create_queue",
    description: "Create an independent durable queue using a built-in or registered application adapter.",
    inputSchema: {
      type: "object",
      required: ["queue_id", "adapter"],
      properties: {
        queue_id: { type: "string", pattern: "^[A-Za-z0-9._-]+$" },
        name: { type: "string" },
        kind: { type: "string" },
        adapter: { type: "string" },
        concurrency: { type: "integer", minimum: 1, maximum: 32 },
        priority: { type: "integer" },
        ordering: { type: "string", enum: ["fifo", "priority"] },
        maximum_attempts: { type: "integer", minimum: 1, maximum: 100 },
        maximum_pending_items: { type: "integer", minimum: 1, maximum: 1000000 },
        maximum_payload_bytes: { type: "integer", minimum: 1024, maximum: 16777216 },
        retry_delays_ms: {
          type: "array", minItems: 1, maxItems: 16,
          items: { type: "integer", minimum: 100, maximum: 3600000 },
        },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: createQueueSurface,
  },
  {
    name: "configure_queue",
    description: "Update scheduling, concurrency, and retry policy for an existing queue without replacing its identity or adapter.",
    inputSchema: {
      type: "object",
      required: ["queue_id"],
      properties: {
        queue_id: { type: "string" }, name: { type: "string" },
        concurrency: { type: "integer", minimum: 1, maximum: 32 },
        priority: { type: "integer" },
        ordering: { type: "string", enum: ["fifo", "priority"] },
        maximum_attempts: { type: "integer", minimum: 1, maximum: 100 },
        maximum_pending_items: { type: "integer", minimum: 1, maximum: 1000000 },
        maximum_payload_bytes: { type: "integer", minimum: 1024, maximum: 16777216 },
        retry_delays_ms: {
          type: "array", minItems: 1, maxItems: 16,
          items: { type: "integer", minimum: 100, maximum: 3600000 },
        },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: configureQueueSurface,
  },
  {
    name: "delete_queue",
    description: "Delete an empty queue. A queue containing any item must be archived instead.",
    inputSchema: {
      type: "object", required: ["queue_id"],
      properties: { queue_id: { type: "string" } }, additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: deleteQueueSurface,
  },
  {
    name: "list_queues",
    description: "List every registered queue, adapter, supervisor policy, and item count by state.",
    inputSchema: {
      type: "object",
      properties: { state: { type: "string", enum: ["running", "paused", "archived"] } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: (args) => queueRegistry.listQueues(args),
  },
  {
    name: "queue_status",
    description: "Read one queue and its ordered active, pending, paused, failed, and terminal items.",
    inputSchema: {
      type: "object", required: ["queue_id"],
      properties: {
        queue_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: (args) => queueRegistry.queueStatus(args),
  },
  {
    name: "enqueue_queue_item",
    description: "Add one durable item to a named queue. Message and file queues may create their durable envelope or artifact from the payload.",
    inputSchema: {
      type: "object", required: ["queue_id", "payload"],
      properties: {
        queue_id: { type: "string" }, item_id: { type: "string" },
        priority: { type: "integer" }, payload: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: enqueueQueueItemSurface,
  },
  {
    name: "enqueue_queue_batch",
    description: "Atomically add an ordered batch of durable items to one queue.",
    inputSchema: {
      type: "object", required: ["queue_id", "items"],
      properties: {
        queue_id: { type: "string" },
        items: {
          type: "array", minItems: 1, maxItems: 1000,
          items: {
            type: "object", required: ["payload"],
            properties: {
              item_id: { type: "string" }, priority: { type: "integer" },
              payload: { type: "object" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: enqueueQueueBatchSurface,
  },
  {
    name: "queue_control",
    description: "Pause, resume, archive, or clear a queue; or pause, resume, cancel, skip, retry, or reprioritize one item.",
    inputSchema: {
      type: "object", required: ["queue_id", "action"],
      properties: {
        queue_id: { type: "string" },
        action: {
          type: "string",
          enum: [
            "pause-queue", "resume-queue", "archive-queue", "clear-pending",
            "pause-item", "resume-item", "cancel-item", "skip-item", "retry-item", "reset-attempts", "set-priority",
          ],
        },
        item_id: { type: "string" }, reason: { type: "string" }, priority: { type: "integer" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: queueControlSurface,
  },
  {
    name: "start_next_queue_item",
    description: "Start the next eligible item in one running queue through its registered adapter.",
    inputSchema: {
      type: "object", required: ["queue_id"],
      properties: {
        queue_id: { type: "string" },
        worker_id: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: startNextQueueItem,
  },
  {
    name: "supervise_queue",
    description: "Claim and execute eligible items through the queue's adapter, recording completion or an env-backed retry after failure.",
    inputSchema: {
      type: "object", required: ["queue_id"],
      properties: {
        queue_id: { type: "string" }, worker_id: { type: "string" },
        max_items: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: superviseQueue,
  },
  {
    name: "run_command",
    description: "Run a shell command on this trusted Mac and record an audit event. The consequential flag classifies the audit entry; the active user instruction is the authority.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 86400000
        },
        output_limit_bytes: {
          type: "integer",
          minimum: 4096,
          maximum: 16777216
        },
        consequential: {
          type: "boolean",
          default: false,
          description: "Audit classification for a consequential action; it does not create a second authorization gate."
        },
        job_id: {
          type: "string",
          description: "Optional durable tracking job ID."
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: runCommand,
  },
  {
    name: "lora_automation",
    description: "Inspect and coordinate SimpleTuner LoRA work: inventory, deep preflight, telemetry, scheduling, recovery, checkpoint comparison, registry, validation, revision ingestion, packet completeness, and estimates. This tool does not start or stop training.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "inventory",
            "preflight",
            "preflight-all",
            "training-readiness",
            "prepare-versioned-job",
            "scheduler-enqueue",
            "stage-runtime-job",
            "telemetry",
            "queue",
            "compare",
            "recovery",
            "packet-audit",
            "packet-validation-plan",
            "registry-refresh",
            "validation-plan",
            "validation-ingest",
            "draw-things-plan",
            "draw-things-ingest",
            "revision-ingest",
            "estimate"
          ]
        },
        path: { type: "string" },
        output_dir: { type: "string" },
        source_path: { type: "string" },
        result_path: { type: "string" },
        job_id: { type: "string" },
        target_job_id: { type: "string" },
        scheduler_job_id: { type: "string" },
        authorization_job_id: { type: "string" },
        revision_fingerprint: { type: "string" },
        version_tag: { type: "string" },
        trigger: { type: "string" },
        required_trigger: { type: "string" },
        required_adult_phrase: { type: "string" },
        required_adult_pattern: { type: "string" },
        tokenizer_root: { type: "string" },
        runtime_root: { type: "string" },
        source_manifest: { type: "string" },
        caption_overlay_root: { type: "string" },
        recovery_checkpoint: { type: "string" },
        validation_prompt_library: { type: "string" },
        required_validation_prompt_ids: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          uniqueItems: true
        },
        validation_base_model: { type: "string" },
        base_model_reason: { type: "string" },
        notes: { type: "string" },
        expected_caption_variants: { type: "integer", minimum: 1, maximum: 20 },
        maximum_tokens: { type: "integer", minimum: 1, maximum: 512 },
        minimum_checkpoint_retention: { type: "integer", minimum: 1 },
        checkpoint_step_interval: { type: "integer", minimum: 1 },
        max_train_steps: { type: "integer", minimum: 1 },
        lora_rank: { type: "integer", minimum: 1 },
        lora_alpha: { type: "integer", minimum: 1 },
        minimum_free_bytes: { type: "integer", minimum: 0 },
        priority: { type: "integer" },
        index: { type: "integer", minimum: 1 },
        write_manifest: { type: "boolean", default: false },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 3600000 }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: loraAutomation,
  },
  {
    name: "peer_call_tool",
    description: "Call one allowlisted HawkSpan-D tool on the paired Mac over the preferred private route with fallback. The active user instruction remains authoritative.",
    inputSchema: {
      type: "object",
      required: ["tool_name"],
      properties: {
        tool_name: { type: "string" },
        arguments: { type: "object" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 3600000 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: peerCallTool,
  },
  {
    name: "send_message",
    description: "Send routine private M2/M4 coordination over the already-authorized local HawkSpan-D. This is durable, idempotent IPC, not an external communication or consequential action.",
    inputSchema: {
      type: "object",
      required: ["subject", "body"],
      properties: {
        recipient: { type: "string" },
        kind: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        correlation_id: { type: "string" },
        metadata: { type: "object" },
        deliver: { type: "boolean", default: true },
        wake: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: sendMessage,
  },
  {
    name: "retry_message",
    description: "Retry delivery of the same immutable queued outbound message without creating a duplicate.",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string" },
        wake: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: retryMessage,
  },
  {
    name: "wake_peer_thread",
    description: "Wake the configured Codex task on the paired Mac after an audited message has been delivered.",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string" },
        subject: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: wakePeerThread,
  },
  {
    name: "receive_messages",
    description: "Import and list inbound messages that have not yet been acknowledged.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500 },
        include_acknowledged: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: receiveMessages,
  },
  {
    name: "list_messages",
    description: "List durable inbound and outbound messages by direction or state.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["inbound", "outbound"] },
        state: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listMessages,
  },
  {
    name: "acknowledge_message",
    description: "Mark one inbound message acknowledged and send a correlated acknowledgement.",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string" },
        note: { type: "string" },
        deliver: { type: "boolean", default: true },
        reply: {
          type: "boolean",
          description: "Send a correlated acknowledgement envelope. Defaults false for acknowledgement-kind inbound messages and true otherwise.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: acknowledgeMessage,
  },
  {
    name: "create_job",
    description: "Create an audited job for identity, progress, recovery, and idempotency.",
    inputSchema: {
      type: "object",
      required: ["kind", "title"],
      properties: {
        kind: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        assignee: { type: "string" },
        requires_authorization: { type: "boolean", default: false },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: createJob,
  },
  {
    name: "update_job_status",
    description: "Apply a validated, audited job state transition. Authorization requires recorded evidence.",
    inputSchema: {
      type: "object",
      required: ["job_id", "state"],
      properties: {
        job_id: { type: "string" },
        state: {
          type: "string",
          enum: ["awaiting_authorization", "authorized", "queued", "running", "returning", "paused", "cancel_requested", "cancelled", "completed", "failed", "verified"],
        },
        authorization_evidence: { type: "string" },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: updateJobStatus,
  },
  {
    name: "list_jobs",
    description: "List durable jobs and authorization state.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        job_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listJobs,
  },
  {
    name: "register_artifact",
    description: "Register a local file as an immutable artifact and calculate its SHA-256 digest.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        name: { type: "string" },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: registerArtifact,
  },
  {
    name: "verify_artifact",
    description: "Calculate an artifact digest and optionally compare it with an expected SHA-256 value.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: { type: "string" },
        path: { type: "string" },
        expected_sha256: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: verifyArtifact,
  },
  {
    name: "send_artifact",
    description: "Send a registered artifact with resumable rsync over the primary route, falling back when necessary.",
    inputSchema: {
      type: "object",
      required: ["artifact_id"],
      properties: { artifact_id: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: sendArtifact,
  },
  {
    name: "queue_artifact_delivery",
    description: "Durably enqueue a registered artifact for resumable peer delivery without waiting for transfer completion.",
    inputSchema: {
      type: "object",
      required: ["artifact_id"],
      properties: { artifact_id: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: queueArtifactDelivery,
  },
  {
    name: "list_artifacts",
    description: "List registered artifacts and their durable delivery state.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        artifact_id: { type: "string" },
        sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        limit: { type: "integer", minimum: 1, maximum: 5000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listArtifacts,
  },
  {
    name: "receive_artifacts",
    description: "Import artifact manifests delivered by the peer and verify each local file by size and SHA-256.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: receiveArtifacts,
  },
  {
    name: "flush_outbox",
    description: "Retry every queued message and previously attempted artifact over the preferred route with automatic fallback.",
    inputSchema: {
      type: "object",
      properties: {
        wake: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: flushOutbox,
  },
  {
    name: "list_audit_events",
    description: "Read the local append-only coordination audit trail.",
    inputSchema: {
      type: "object",
      properties: {
        object_type: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listAuditEvents,
  },
  {
    name: "trainer_status",
    description: "Read configured SimpleTuner-related process status without changing training.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: trainerStatus,
  },
  {
    name: "trainer_run_status",
    description: "Read the active SimpleTuner run, exact step/loss/ETA, queue counts, and preserved checkpoints.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: trainerRunStatus,
  },
  {
    name: "trainer_queue_detail",
    description: "List every manifest job with pending, running, completed, or failed state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: trainerQueueDetail,
  },
  {
    name: "trainer_queue_status",
    description: "Inspect the configured SimpleTuner queue without changing it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: trainerQueueStatus,
  },
  {
    name: "trainer_validate_dataset",
    description: "Validate that a dataset has images and a non-empty sidecar caption for every image.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: trainerValidateDataset,
  },
  {
    name: "trainer_tail_log",
    description: "Read the tail of a configured SimpleTuner log file.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        lines: { type: "integer", minimum: 1, maximum: 2000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: trainerTailLog,
  },
  {
    name: "trainer_audit_checkpoint_retention",
    description: "Audit queued SimpleTuner configs against the configured minimum checkpoint retention.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: trainerAuditCheckpointRetention,
  },
  {
    name: "trainer_preservation_status",
    description: "Inspect the preserved-checkpoint root without changing checkpoints.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: trainerPreservationStatus,
  },
  {
    name: "trainer_queue_control",
    description: "Control one non-running LoRA job independently, or explicitly pause/resume the entire queue. Per-job eligibility controls do not terminate an active process; pause-queue stops the exact active managed target.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "pause-job",
            "resume-job",
            "skip-job",
            "retry-job",
            "pause-queue",
            "resume-queue",
            "status"
          ]
        },
        target: { type: "string" },
        reason: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 }
      },
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: trainerQueueControl,
  },
  {
    name: "trainer_start_authorized_job",
    description: "Start an exact preconfigured training target when training.allow_start is enabled; readiness and revision checks still apply.",
    inputSchema: {
      type: "object",
      required: ["job_id", "target", "expected_revision_fingerprint"],
      properties: {
        job_id: { type: "string" },
        target: { type: "string" },
        expected_revision_fingerprint: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
        _delegated_job: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: trainerStartAuthorizedJob,
  },
  {
    name: "trainer_stop_authorized_job",
    description: "Stop only the exact adapter-managed training target when training.allow_stop is enabled.",
    inputSchema: {
      type: "object",
      required: ["job_id", "target"],
      properties: {
        job_id: { type: "string" },
        target: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
        _delegated_job: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: trainerStopAuthorizedJob,
  },
  {
    name: "trainer_package_authorized_job",
    description: "Package an exact completed training target when training.allow_package is enabled.",
    inputSchema: {
      type: "object",
      required: ["job_id", "target", "expected_revision_fingerprint"],
      properties: {
        job_id: { type: "string" },
        target: { type: "string" },
        expected_revision_fingerprint: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
        _delegated_job: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: trainerPackageAuthorizedJob,
  },
];

let toolMap = new Map(coreTools.map((tool) => [tool.name, tool]));

function writeConfiguration(next) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, CONFIG_PATH);
  fs.chmodSync(CONFIG_PATH, 0o600);
}

function publicPreset(preset) {
  return {
    id: preset.id,
    plugin_id: preset.plugin_id,
    plugin_name: preset.plugin_name,
    plugin_version: preset.plugin_version,
    name: preset.name,
    description: preset.description,
    impact: preset.impact,
    settings: { enabled_operations: [...preset.settings.enabled_operations] },
  };
}

function validateLightweightPreset(preset) {
  const keys = Object.keys(preset.settings || {});
  if (keys.some((key) => key !== "enabled_operations")) {
    throw new Error("HawkSpan presets may select package operations only");
  }
  return preset;
}

async function callToolInternal(name, args = {}, origin = "local", pluginId = null) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  if (tool.allowedOrigins && !tool.allowedOrigins.has(origin)) {
    throw new Error(`${name} does not allow ${origin} access`);
  }
  if (origin === "plugin") {
    const globalAllowlist = config.application_plugins?.core_tool_allowlist || [];
    const pluginAllowlist = config.application_plugins?.entries?.[pluginId]?.core_tool_allowlist || [];
    if (!globalAllowlist.includes(name) || !pluginAllowlist.includes(name)) {
      throw new Error(`plugin core-tool access is not allowed: ${name}`);
    }
  }
  return tool.handler(args, origin);
}

const pluginFramework = await createApplicationPluginFramework({
  config,
  stateRoot: STATE_ROOT,
  db,
  audit,
  callCoreTool: callToolInternal,
  environment: machineEnvironment,
  validatePreset: validateLightweightPreset,
});
const applicationPresets = pluginFramework.presets;

function findPreset(presetId) {
  const preset = applicationPresets.find((entry) => entry.id === presetId);
  if (!preset) throw new Error(`application preset not found: ${presetId}`);
  return preset;
}

const presetTools = [
  {
    name: "list_application_presets",
    description: "List operation-selection presets supplied by installed HawkSpan packages.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: () => ({ presets: applicationPresets.map(publicPreset) }),
  },
  {
    name: "preview_application_preset",
    description: "Preview the package operations selected by an installed preset.",
    inputSchema: { type: "object", required: ["preset_id"], properties: { preset_id: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: ({ preset_id: presetId }) => ({ preset: publicPreset(findPreset(presetId)), confirmation_required: true }),
  },
  {
    name: "apply_application_preset",
    description: "Apply only the operation selection from an installed package preset.",
    inputSchema: { type: "object", required: ["preset_id", "confirm"], properties: { preset_id: { type: "string" }, confirm: { type: "boolean", const: true } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: ({ preset_id: presetId, confirm }) => {
      if (confirm !== true) throw new Error("applying an application preset requires confirm: true");
      const preset = findPreset(presetId);
      const next = structuredClone(config);
      next.application_plugins.entries[preset.plugin_id] = {
        ...(next.application_plugins.entries[preset.plugin_id] || {}),
        enabled_operations: [...preset.settings.enabled_operations],
      };
      writeConfiguration(next);
      audit("apply", "application_preset", preset.id, "saved", { plugin_id: preset.plugin_id });
      return { preset: publicPreset(preset), restart_required: true };
    },
  },
  {
    name: "reset_application_preset",
    description: "Remove an installed package preset's operation selection.",
    inputSchema: { type: "object", required: ["preset_id", "confirm"], properties: { preset_id: { type: "string" }, confirm: { type: "boolean", const: true } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: ({ preset_id: presetId, confirm }) => {
      if (confirm !== true) throw new Error("resetting an application preset requires confirm: true");
      const preset = findPreset(presetId);
      const next = structuredClone(config);
      delete next.application_plugins.entries[preset.plugin_id]?.enabled_operations;
      writeConfiguration(next);
      audit("reset", "application_preset", preset.id, "saved", { plugin_id: preset.plugin_id });
      return { preset: publicPreset(preset), reset: true, restart_required: true };
    },
  },
];

const tools = [...coreTools, ...presetTools, ...pluginFramework.tools];
toolMap = new Map(tools.map((tool) => [tool.name, tool]));
for (const tool of pluginFramework.tools) {
  if (tool.allowedOrigins?.has("peer")) peerToolAllowlist.add(tool.name);
}
const localControl = await startLocalControlSurface(
  process.env.HAWKSPAN_LOCAL_CONTROL_DISABLED === "1"
    ? { enabled: false }
    : {
        ...config.local_control,
        allowed_tools: (config.local_control?.allowed_tools || [])
          .filter((name) => toolMap.has(name)),
      },
  callToolInternal,
);

function success(idValue, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: idValue, result })}\n`);
}

function failure(idValue, code, message, data) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: idValue ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  })}\n`);
}

async function handle(request) {
  const requestId = request.id;
  if (request.method === "initialize") {
    success(requestId, {
      protocolVersion: request.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "hawkspan", version: "0.1.0" },
    });
    return;
  }
  if (request.method === "ping") {
    success(requestId, {});
    return;
  }
  if (request.method === "tools/list") {
    success(requestId, {
      tools: tools.map(({ handler, allowedOrigins, applicationPlugin, ...definition }) => definition),
    });
    return;
  }
  if (request.method === "tools/call") {
    const tool = toolMap.get(request.params?.name);
    if (!tool) {
      failure(requestId, -32602, `unknown tool: ${request.params?.name}`);
      return;
    }
    try {
      const origin = process.env.HAWKSPAN_CALL_ORIGIN === "peer" ? "peer" : "local";
      const output = await callToolInternal(tool.name, request.params?.arguments || {}, origin);
      success(requestId, {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
        isError: false,
      });
    } catch (error) {
      audit("tool_call", "tool", tool.name, "error", { error: String(error) });
      success(requestId, {
        content: [{ type: "text", text: String(error?.message || error) }],
        isError: true,
      });
    }
    return;
  }
  if (request.method?.startsWith("notifications/")) return;
  failure(requestId, -32601, `method not found: ${request.method}`);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

input.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    Promise.resolve(handle(request)).catch((error) => {
      failure(request.id, -32603, "internal error", String(error));
    });
  } catch (error) {
    failure(null, -32700, "parse error", String(error));
  }
});

input.on("close", async () => {
  await pluginFramework.close();
  if (localControl) await localControl.close();
  db.close();
});
