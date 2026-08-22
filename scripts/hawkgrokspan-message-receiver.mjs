#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ingestMessageInbox } from "./message-inbox.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scriptPath = fileURLToPath(import.meta.url);
const scriptsRoot = path.dirname(scriptPath);
const releaseRoot = path.resolve(scriptsRoot, "..");

function fail(message) {
  process.stderr.write(`HawkGrokSpan message receiver failed: ${message}\n`);
  process.exit(1);
}

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    if (required) fail(`${name} is required`);
    return null;
  }
  return process.argv[index + 1];
}

function atomicWrite(filePath, body, mode = 0o600) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, body, { mode });
  fs.renameSync(temporary, filePath);
}

function promptShellQuote(value) {
  if (String(value).includes("'")) fail("receiver fallback path contains a forbidden quote");
  return `'${String(value)}'`;
}

function assertOwnedDirectory(directory, label) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch { fail(`${label} is unavailable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail(`${label} must be owned by the receiver account`);
  }
}

function assertExecutable(filePath, label) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) ||
      !/^\/[A-Za-z0-9_./ -]+$/.test(filePath) || path.normalize(filePath) !== filePath) {
    fail(`${label} must be a normalized absolute path`);
  }
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { fail(`${label} is unavailable`); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0 ||
      (stat.mode & 0o022) !== 0) {
    fail(`${label} must be an executable non-symbolic-link file that is not group- or other-writable`);
  }
  if (typeof process.getuid === "function" && stat.uid !== 0 && stat.uid !== process.getuid()) {
    fail(`${label} must be owned by root or the receiver account`);
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const stateRoot = path.resolve(argument("--state-root"));
const worker = process.argv.includes("--worker");
const supervisor = process.argv.includes("--supervisor");
const ensureSupervisor = process.argv.includes("--ensure-supervisor");
const service = process.argv.includes("--service");
if ([worker, supervisor, ensureSupervisor, service].filter(Boolean).length > 1) {
  fail("receiver modes are mutually exclusive");
}
const workerTarget = argument("--target", worker);
const workerNonce = argument("--nonce", worker || supervisor);
if (!path.isAbsolute(stateRoot) || !/^\/[A-Za-z0-9_./ -]+$/.test(stateRoot) ||
    path.normalize(stateRoot) !== stateRoot) fail("state root is invalid");
assertOwnedDirectory(stateRoot, "state root");

const config = JSON.parse(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"));
const receiver = config.message_receiver;
if (config.surface_profile !== "message-files" || receiver?.enabled !== true) {
  fail("local message receiver is not enabled for the message-files surface");
}
const artifactWriteRoots = config.transfer?.allowed_artifact_roots;
if (!Array.isArray(artifactWriteRoots) || artifactWriteRoots.length < 1) {
  fail("message-files receiver requires transfer.allowed_artifact_roots");
}
for (const root of artifactWriteRoots) {
  if (typeof root !== "string" || !path.isAbsolute(root) ||
      !/^\/[A-Za-z0-9_./ -]+$/.test(root) || path.normalize(root) !== root) {
    fail("transfer.allowed_artifact_roots entries must be normalized absolute paths");
  }
  assertOwnedDirectory(root, "artifact write root");
}
const reconcileIntervalSeconds = Number(receiver.reconcile_interval_seconds);
if (!Number.isSafeInteger(reconcileIntervalSeconds) ||
    reconcileIntervalSeconds < 5 || reconcileIntervalSeconds > 600) {
  fail("message_receiver.reconcile_interval_seconds must be 5 to 600 seconds");
}
const retryBackoffSeconds = receiver.retry_backoff_seconds === undefined
  ? [30, 60, 120, 300, 600]
  : receiver.retry_backoff_seconds.map(Number);
if (!Array.isArray(retryBackoffSeconds) || retryBackoffSeconds.length < 1 ||
    retryBackoffSeconds.length > 8 || retryBackoffSeconds.some((value, index, values) =>
      !Number.isSafeInteger(value) || value < 5 || value > 3600 ||
      (index > 0 && value < values[index - 1]))) {
  fail("message_receiver.retry_backoff_seconds must be 1 to 8 nondecreasing integers from 5 to 3600");
}
if (!SAFE_ID.test(receiver.default_target || "") ||
    !receiver.targets || typeof receiver.targets !== "object" || Array.isArray(receiver.targets) ||
    !Object.hasOwn(receiver.targets, receiver.default_target)) {
  fail("message_receiver.default_target must name a configured target");
}

const inbox = path.join(stateRoot, "inbox");
const audit = path.join(stateRoot, "audit");
const pendingRoot = path.join(audit, "message-receiver-pending");
assertOwnedDirectory(inbox, "inbox");
assertOwnedDirectory(audit, "audit directory");
fs.mkdirSync(pendingRoot, { recursive: true, mode: 0o700 });

function validateTarget(targetId) {
  if (!SAFE_ID.test(targetId || "")) fail("message receiver target ID is invalid");
  const target = receiver.targets[targetId];
  if (!target || !new Set(["codex", "grok"]).has(target.adapter)) {
    fail(`message receiver target is unavailable: ${targetId}`);
  }
  assertExecutable(target.command, `message_receiver.targets.${targetId}.command`);
  if (typeof target.workdir !== "string" || !path.isAbsolute(target.workdir) ||
      path.normalize(target.workdir) !== target.workdir) {
    fail(`message_receiver.targets.${targetId}.workdir is invalid`);
  }
  assertOwnedDirectory(target.workdir, `message receiver workdir ${targetId}`);
  if ((fs.statSync(target.workdir).mode & 0o022) !== 0) {
    fail(`message receiver workdir ${targetId} must not be group- or other-writable`);
  }
  if (!SESSION_UUID.test(target.session_id || "") ||
      /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(target.session_id)) {
    fail(`message_receiver.targets.${targetId}.session_id must be an exact persisted session UUID`);
  }
  if (target.adapter === "codex" && target.sandbox !== "workspace-write") {
    fail(`Codex target ${targetId} requires the workspace-write sandbox`);
  }
  if (target.adapter === "grok" && !new Set(["workspace", "hawkgrokspan"]).has(target.sandbox)) {
    fail(`Grok target ${targetId} requires the workspace or hawkgrokspan sandbox`);
  }
  const maximumRuntimeSeconds = Number(target.maximum_runtime_seconds);
  if (!Number.isSafeInteger(maximumRuntimeSeconds) || maximumRuntimeSeconds < 30 ||
      maximumRuntimeSeconds > 1800) {
    fail(`message receiver target ${targetId} maximum runtime must be 30 to 1800 seconds`);
  }
  const maximumTurns = target.adapter === "grok" ? Number(target.maximum_turns) : null;
  if (target.adapter === "grok" && (!Number.isSafeInteger(maximumTurns) ||
      maximumTurns < 2 || maximumTurns > 30)) {
    fail(`Grok target ${targetId} maximum turns must be 2 to 30`);
  }
  return { ...target, maximumRuntimeSeconds, maximumTurns };
}

const configuredSessions = new Set();
const configuredWorkdirs = new Set();
for (const targetId of Object.keys(receiver.targets)) {
  const target = validateTarget(targetId);
  const sessionKey = `${target.adapter}:${target.session_id.toLowerCase()}`;
  if (configuredSessions.has(sessionKey)) fail(`duplicate configured adapter session: ${targetId}`);
  if (configuredWorkdirs.has(target.workdir)) fail(`duplicate configured receiver workdir: ${targetId}`);
  configuredSessions.add(sessionKey);
  configuredWorkdirs.add(target.workdir);
}

function durableState(messageId) {
  const db = new DatabaseSync(path.join(stateRoot, "spool.sqlite3"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=10000");
    const row = db.prepare("SELECT state FROM messages WHERE id=? AND direction='inbound'").get(messageId);
    return row?.state || null;
  } finally {
    db.close();
  }
}

function importInboxDurably() {
  const db = new DatabaseSync(path.join(stateRoot, "spool.sqlite3"));
  try {
    db.exec("PRAGMA busy_timeout=10000");
    return ingestMessageInbox({
      inbox,
      db,
      audit: (action, objectType, objectId, result, details) => {
        db.prepare(`
          INSERT INTO audit_events
            (timestamp,node_id,action,object_type,object_id,result,details_json)
          VALUES (?,?,?,?,?,?,?)
        `).run(
          new Date().toISOString(),
          config.node_id,
          action,
          objectType,
          objectId,
          result,
          JSON.stringify(details || {}),
        );
        fs.appendFileSync(
          path.join(audit, "message-receiver-ingest.jsonl"),
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            action,
            object_type: objectType,
            object_id: objectId,
            result,
            details,
          })}\n`,
          { mode: 0o600 },
        );
      },
    });
  } finally {
    db.close();
  }
}

function pendingByTarget() {
  const grouped = new Map();
  const scanDb = new DatabaseSync(path.join(stateRoot, "spool.sqlite3"));
  try {
    scanDb.exec("PRAGMA busy_timeout=10000");
    const rows = scanDb.prepare(`
      SELECT id,sender,kind,metadata_json
      FROM messages
      WHERE direction='inbound' AND state='received' AND kind!='acknowledgement'
      ORDER BY created_at ASC
    `).all();
    for (const row of rows) {
      if (row.kind === "routing_failure") {
        const acknowledgedAt = new Date().toISOString();
        scanDb.prepare(`
          UPDATE messages SET state='acknowledged', acknowledged_at=?
          WHERE id=? AND state='received'
        `).run(acknowledgedAt, row.id);
        atomicWrite(path.join(audit, `message-receiver-${row.id}.status.json`), `${JSON.stringify({
          schema_version: 1,
          message_id: row.id,
          state: "acknowledged",
          terminal_notice: "routing_failure",
          replied: false,
          recorded_at: acknowledgedAt,
        }, null, 2)}\n`);
        continue;
      }
      const metadata = JSON.parse(row.metadata_json || "{}");
      // Inbound/old envelopes with notify_receiver=false still wake.
      // if (metadata.notify_receiver === false) continue;
      const targetId = metadata.target_bot_id || receiver.default_target;
      if (!Object.hasOwn(receiver.targets, targetId)) {
        const toolEnvironment = {
          ...process.env,
          HAWKSPAN_STATE_DIR: stateRoot,
          HAWKSPAN_CONFIG: path.join(stateRoot, "config.json"),
        };
        const report = spawnSync(process.execPath, [
          path.join(scriptsRoot, "call-tool.mjs"),
          "send_message",
          JSON.stringify({
            recipient: row.sender,
            kind: "routing_failure",
            subject: `HawkGrokSpan routing failed: ${row.id}`,
            body: `Message ${row.id} requested unconfigured target_bot_id ${targetId}. The message was not delivered to a fallback bot.`,
            correlation_id: row.id,
            wake: true,
            deliver: false,
          }),
        ], {
          encoding: "utf8",
          timeout: 5000,
          env: toolEnvironment,
        });
        let reportMessageId = null;
        try {
          reportMessageId = JSON.parse(report.stdout).structuredContent.message_id;
        } catch {}
        let deliveryPid = null;
        if (report.status === 0 && SAFE_ID.test(reportMessageId || "")) {
          scanDb.prepare("UPDATE messages SET state='routing_failed' WHERE id=? AND state='received'")
            .run(row.id);
        }
        atomicWrite(path.join(audit, `message-receiver-${row.id}.status.json`), `${JSON.stringify({
          schema_version: 1,
          message_id: row.id,
          target_bot_id: targetId,
          state: "routing_failed",
          error: "target_bot_id is not configured",
          sender_report_queued: report.status === 0 && SAFE_ID.test(reportMessageId || ""),
          sender_report_message_id: reportMessageId,
          sender_report_delivery_pid: deliveryPid,
          sender_report_error: report.status === 0 ? null :
            (report.error?.message || report.stderr || report.stdout || "failed").trim(),
          recorded_at: new Date().toISOString(),
        }, null, 2)}\n`);
        continue;
      }
      if (!grouped.has(targetId)) grouped.set(targetId, []);
      grouped.get(targetId).push(row.id);
    }
  } finally {
    scanDb.close();
  }
  return grouped;
}

function retryQueuedRoutingFailureReports() {
  const retryDb = new DatabaseSync(path.join(stateRoot, "spool.sqlite3"), { readOnly: true });
  let rows;
  try {
    retryDb.exec("PRAGMA busy_timeout=10000");
    rows = retryDb.prepare(`
      SELECT id FROM messages
      WHERE direction='outbound' AND kind='routing_failure' AND state='queued'
      ORDER BY created_at ASC
    `).all();
  } finally {
    retryDb.close();
  }
  const started = [];
  for (const row of rows) {
    const statusPath = path.join(audit, `message-receiver-routing-report-${row.id}.status.json`);
    let prior = {};
    try { prior = JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch {}
    if (Number(prior.next_retry_at_ms || 0) > Date.now()) continue;
    const attempt = Number(prior.attempt || 0) + 1;
    const logPath = path.join(audit, `message-receiver-routing-report-${row.id}.log`);
    const logFd = fs.openSync(logPath, "a", 0o600);
    const delivery = spawn(process.execPath, [
      path.join(scriptsRoot, "call-tool.mjs"),
      "retry_message",
      JSON.stringify({ message_id: row.id }),
    ], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        HAWKSPAN_STATE_DIR: stateRoot,
        HAWKSPAN_CONFIG: path.join(stateRoot, "config.json"),
      },
    });
    delivery.unref();
    fs.closeSync(logFd);
    const nextRetryAtMs = Date.now() +
      retryBackoffSeconds[Math.min(attempt - 1, retryBackoffSeconds.length - 1)] * 1000;
    atomicWrite(statusPath, `${JSON.stringify({
      schema_version: 1,
      message_id: row.id,
      attempt,
      delivery_pid: delivery.pid,
      next_retry_at_ms: nextRetryAtMs,
      next_retry_at: new Date(nextRetryAtMs).toISOString(),
      started_at: new Date().toISOString(),
    }, null, 2)}\n`);
    started.push({ message_id: row.id, attempt, delivery_pid: delivery.pid });
  }
  return started;
}

function installedAuthority() {
  try {
    const authority = JSON.parse(fs.readFileSync(path.join(stateRoot, "installed-revision.json"), "utf8"));
    if (path.resolve(authority.active_release_root) !== releaseRoot ||
        !/^[0-9a-f]{40}$/.test(authority.revision || "")) {
      fail("installed release authority does not match this receiver");
    }
    return authority;
  } catch (error) {
    fail(`installed release authority is unavailable: ${error.message}`);
  }
}

const receiverAuthority = installedAuthority();
const receiverRevision = receiverAuthority.revision;
const stableScriptPath = path.join(
  path.resolve(receiverAuthority.stable_release_root),
  path.relative(releaseRoot, scriptPath),
);

function observedProcess(pid) {
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function matchesLeaseProcess(lease, { mode, targetId = null } = {}) {
  if (!lease || !pidAlive(Number(lease.pid))) return false;
  const observed = observedProcess(lease.pid);
  const scriptMatches = observed && (
    observed.includes(String(lease.script_path || "")) || observed.includes(stableScriptPath)
  );
  if (!scriptMatches ||
      !observed.includes(`--${mode}`) ||
      !observed.includes(`--state-root ${stateRoot}`)) return false;
  if (mode !== "service" && !observed.includes(`--nonce ${lease.nonce}`)) return false;
  return !targetId || observed.includes(`--target ${targetId}`);
}

function findManagedService() {
  const result = spawnSync("ps", ["-ww", "-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const observed = match[2];
    const scriptMatches = observed.includes(scriptPath) || observed.includes(stableScriptPath);
    if (pid !== process.pid && scriptMatches &&
        observed.includes("--service") &&
        observed.includes(`--state-root ${stateRoot}`) && pidAlive(pid)) {
      return pid;
    }
  }
  return null;
}

function leasePaths(targetId) {
  const target = receiver.targets[targetId];
  const sessionKey = `${target.adapter}-${target.session_id.toLowerCase()}`;
  const leaseRoot = path.join(audit, `message-receiver-session-${sessionKey}.lock`);
  return { leaseRoot, leasePath: path.join(leaseRoot, "lease.json") };
}

function readLease(targetId) {
  try { return JSON.parse(fs.readFileSync(leasePaths(targetId).leasePath, "utf8")); } catch { return null; }
}

function queuePending(targetId, messageIds) {
  const targetRoot = path.join(pendingRoot, targetId);
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const messageId of messageIds) atomicWrite(path.join(targetRoot, messageId), `${messageId}\n`);
}

function removeRecoverableLease(targetId, target) {
  const { leaseRoot } = leasePaths(targetId);
  if (!fs.existsSync(leaseRoot)) return true;
  const lease = readLease(targetId);
  if (lease && pidAlive(Number(lease.pid))) {
    const ageMs = Date.now() - Number(lease.started_at_ms || 0);
    if (lease.initializing === true && ageMs <= 10000) return false;
    const claimedAgeMs = Date.now() - Number(lease.claimed_at_ms || 0);
    if (Number(lease.claimed_at_ms) > 0 && claimedAgeMs <= 5000) return false;
    const verified = matchesLeaseProcess(lease, { mode: "worker", targetId });
    const currentRelease = path.resolve(String(lease.script_path || "")) === scriptPath &&
      lease.revision === receiverRevision;
    if (verified && currentRelease && ageMs <= (target.maximumRuntimeSeconds + 60) * 1000) return false;
    if (verified) {
      try { process.kill(-Number(lease.pid), "SIGTERM"); } catch {
        try { process.kill(Number(lease.pid), "SIGTERM"); } catch {}
      }
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && pidAlive(Number(lease.pid))) sleep(100);
      if (pidAlive(Number(lease.pid))) return false;
    }
  }
  const current = readLease(targetId);
  if (lease && current &&
      (current.nonce !== lease.nonce ||
       String(current.pid ?? "") !== String(lease.pid ?? ""))) {
    return false;
  }
  const quarantine = `${leaseRoot}.stale-${crypto.randomUUID()}`;
  try {
    fs.renameSync(leaseRoot, quarantine);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function requestTarget(targetId, messageIds) {
  const target = validateTarget(targetId);
  const statusPath = path.join(audit, `message-receiver-${targetId}.status.json`);
  try {
    const previous = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (previous.acknowledged !== true &&
        JSON.stringify(previous.message_ids || []) === JSON.stringify(messageIds) &&
        Number(previous.next_retry_at_ms || 0) > Date.now()) {
      queuePending(targetId, messageIds);
      return {
        target_bot_id: targetId,
        started: false,
        queued: true,
        retry_deferred_until: new Date(previous.next_retry_at_ms).toISOString(),
        message_ids: messageIds,
      };
    }
  } catch {}
  const { leaseRoot, leasePath } = leasePaths(targetId);
  if (!removeRecoverableLease(targetId, target)) {
    queuePending(targetId, messageIds);
    return { target_bot_id: targetId, started: false, queued: true, message_ids: messageIds };
  }
  try { fs.mkdirSync(leaseRoot, { mode: 0o700 }); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    queuePending(targetId, messageIds);
    return { target_bot_id: targetId, started: false, queued: true, message_ids: messageIds };
  }
  queuePending(targetId, messageIds);
  const nonce = crypto.randomUUID();
  atomicWrite(leasePath, `${JSON.stringify({
    schema_version: 1,
    pid: process.pid,
    nonce,
    initializing: true,
    target_bot_id: targetId,
    started_at_ms: Date.now(),
    maximum_runtime_seconds: target.maximumRuntimeSeconds,
    session_key: `${target.adapter}:${target.session_id.toLowerCase()}`,
    script_path: scriptPath,
    release_root: releaseRoot,
    revision: receiverRevision,
  }, null, 2)}\n`);
  let child;
  try {
    child = spawn(process.execPath, [
      scriptPath,
      "--state-root", stateRoot,
      "--worker",
      "--target", targetId,
      "--nonce", nonce,
    ], { detached: true, stdio: "ignore" });
    atomicWrite(leasePath, `${JSON.stringify({
      schema_version: 1,
      pid: child.pid,
      nonce,
      initializing: true,
      target_bot_id: targetId,
      started_at_ms: Date.now(),
      maximum_runtime_seconds: target.maximumRuntimeSeconds,
      session_key: `${target.adapter}:${target.session_id.toLowerCase()}`,
      script_path: scriptPath,
      release_root: releaseRoot,
      revision: receiverRevision,
    }, null, 2)}\n`);
  } catch (error) {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    const current = readLease(targetId);
    if (current?.nonce === nonce) {
      const failedRoot = `${leaseRoot}.failed-${crypto.randomUUID()}`;
      try {
        fs.renameSync(leaseRoot, failedRoot);
        fs.rmSync(failedRoot, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }
  child.unref();
  return {
    target_bot_id: targetId,
    started: true,
    queued: false,
    message_ids: messageIds,
    receiver_pid: child.pid,
    completion_boundary: "durable acknowledgement",
  };
}

function reconcileOnce() {
  const imported = importInboxDurably();
  const grouped = pendingByTarget();
  const routingReportRetries = retryQueuedRoutingFailureReports();
  const targets = [...grouped].map(([targetId, messageIds]) => requestTarget(targetId, messageIds));
  return { accepted: true, imported, routing_report_retries: routingReportRetries, targets };
}

const supervisorLeaseRoot = path.join(audit, "message-receiver-supervisor.lock");
const supervisorLeasePath = path.join(supervisorLeaseRoot, "lease.json");
const managedServiceStatusPath = path.join(audit, "message-receiver-service.status.json");

function readSupervisorLease() {
  try { return JSON.parse(fs.readFileSync(supervisorLeasePath, "utf8")); } catch { return null; }
}

function recentManagedService() {
  try {
    const status = JSON.parse(fs.readFileSync(managedServiceStatusPath, "utf8"));
    if (status.revision === receiverRevision &&
        Number.isSafeInteger(Number(status.pid)) && Number(status.pid) > 1 &&
        Date.now() - Number(status.heartbeat_at_ms || 0) <= 5000) {
      return Number(status.pid);
    }
  } catch {}
  return null;
}

function quarantineStoppedSupervisor() {
  if (!fs.existsSync(supervisorLeaseRoot)) return true;
  const lease = readSupervisorLease();
  if (lease && pidAlive(Number(lease.pid))) {
    const ageMs = Date.now() - Number(lease.started_at_ms || 0);
    if (lease.initializing === true && ageMs <= 10000) return false;
    const verified = matchesLeaseProcess(lease, {
      mode: lease.managed_service === true ? "service" : "supervisor",
    });
    const currentRelease = path.resolve(String(lease.script_path || "")) === scriptPath &&
      lease.revision === receiverRevision;
    if (verified && currentRelease) return false;
    if (verified) {
      try { process.kill(Number(lease.pid), "SIGTERM"); } catch {}
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && pidAlive(Number(lease.pid))) sleep(100);
      if (pidAlive(Number(lease.pid))) return false;
    }
  }
  const current = readSupervisorLease();
  if (lease && current &&
      (current.nonce !== lease.nonce ||
       String(current.pid ?? "") !== String(lease.pid ?? ""))) {
    return false;
  }
  const quarantine = `${supervisorLeaseRoot}.stale-${crypto.randomUUID()}`;
  try {
    fs.renameSync(supervisorLeaseRoot, quarantine);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function ensureSupervisorProcess() {
  // A managed service is the receiver authority even if a concurrent or stale
  // writer displaced its lease. MCP startup must never create a second receiver.
  const managedServicePid = recentManagedService() || findManagedService();
  if (managedServicePid) {
    return { started: false, already_running: true, pid: managedServicePid };
  }
  if (!quarantineStoppedSupervisor()) {
    const lease = readSupervisorLease();
    return { started: false, already_running: true, pid: lease?.pid || null };
  }
  try { fs.mkdirSync(supervisorLeaseRoot, { mode: 0o700 }); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const lease = readSupervisorLease();
    return { started: false, already_running: true, pid: lease?.pid || null };
  }
  const nonce = crypto.randomUUID();
  atomicWrite(supervisorLeasePath, `${JSON.stringify({
    schema_version: 1,
    pid: process.pid,
    nonce,
    initializing: true,
    started_at_ms: Date.now(),
    script_path: scriptPath,
    release_root: releaseRoot,
    revision: receiverRevision,
    reconcile_interval_seconds: reconcileIntervalSeconds,
  }, null, 2)}\n`);
  let child;
  try {
    child = spawn(process.execPath, [
      scriptPath,
      "--state-root", stateRoot,
      "--supervisor",
      "--nonce", nonce,
    ], { detached: true, stdio: "ignore" });
    atomicWrite(supervisorLeasePath, `${JSON.stringify({
      schema_version: 1,
      pid: child.pid,
      nonce,
      initializing: true,
      started_at_ms: Date.now(),
      script_path: scriptPath,
      release_root: releaseRoot,
      revision: receiverRevision,
      reconcile_interval_seconds: reconcileIntervalSeconds,
    }, null, 2)}\n`);
  } catch (error) {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    const current = readSupervisorLease();
    if (current?.nonce === nonce) {
      const failedRoot = `${supervisorLeaseRoot}.failed-${crypto.randomUUID()}`;
      try {
        fs.renameSync(supervisorLeaseRoot, failedRoot);
        fs.rmSync(failedRoot, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }
  child.unref();
  return { started: true, already_running: false, pid: child.pid };
}

function activeReleaseStillMatches() {
  const authorityPath = path.join(stateRoot, "installed-revision.json");
  try {
    const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
    return path.resolve(authority.active_release_root) === releaseRoot &&
      authority.revision === receiverRevision;
  } catch {
    return false;
  }
}

async function runSupervisorLoop(nonce, { managedService = false } = {}) {
  const cleanupSupervisor = () => {
    const current = readSupervisorLease();
    if (current?.nonce === nonce && Number(current.pid) === process.pid) {
      fs.rmSync(supervisorLeaseRoot, { recursive: true, force: true });
    }
    if (managedService) {
      try {
        const status = JSON.parse(fs.readFileSync(managedServiceStatusPath, "utf8"));
        if (Number(status.pid) === process.pid) fs.rmSync(managedServiceStatusPath, { force: true });
      } catch {}
    }
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      cleanupSupervisor();
      process.exit(143);
    });
  }
  try {
    let nextReconcileAt = 0;
    while (activeReleaseStillMatches()) {
      if (managedService) {
        atomicWrite(managedServiceStatusPath, `${JSON.stringify({
          schema_version: 1,
          pid: process.pid,
          revision: receiverRevision,
          script_path: scriptPath,
          heartbeat_at_ms: Date.now(),
          heartbeat_at: new Date().toISOString(),
        }, null, 2)}\n`);
      }
      if (Date.now() >= nextReconcileAt) {
        try {
          const result = reconcileOnce();
          atomicWrite(path.join(audit, "message-receiver-supervisor.status.json"), `${JSON.stringify({
            ...result,
            supervisor_pid: process.pid,
            revision: receiverRevision,
            script_path: scriptPath,
            reconciled_at: new Date().toISOString(),
          }, null, 2)}\n`);
        } catch (error) {
          atomicWrite(path.join(audit, "message-receiver-supervisor.status.json"), `${JSON.stringify({
            accepted: false,
            supervisor_pid: process.pid,
            revision: receiverRevision,
            script_path: scriptPath,
            error: String(error.message || error),
            reconciled_at: new Date().toISOString(),
          }, null, 2)}\n`);
        }
        nextReconcileAt = Date.now() + reconcileIntervalSeconds * 1000;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(100, nextReconcileAt - Date.now()))));
    }
  } finally {
    cleanupSupervisor();
  }
}

if (ensureSupervisor) {
  atomicWrite(path.join(audit, "message-receiver-request.json"), `${JSON.stringify({
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ accepted: true, supervisor: ensureSupervisorProcess() })}\n`);
  process.exit(0);
}

if (service) {
  if (!quarantineStoppedSupervisor()) {
    fail("another verified message receiver supervisor already owns the lease");
  }
  try { fs.mkdirSync(supervisorLeaseRoot, { mode: 0o700 }); } catch (error) {
    fail(`cannot acquire managed supervisor lease: ${error.message}`);
  }
  const nonce = crypto.randomUUID();
  atomicWrite(supervisorLeasePath, `${JSON.stringify({
    schema_version: 1,
    pid: process.pid,
    nonce,
    managed_service: true,
    started_at_ms: Date.now(),
    script_path: scriptPath,
    release_root: releaseRoot,
    revision: receiverRevision,
    reconcile_interval_seconds: reconcileIntervalSeconds,
  }, null, 2)}\n`);
  await runSupervisorLoop(nonce, { managedService: true });
  process.exit(0);
}

if (supervisor) {
  let lease;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lease = readSupervisorLease();
    if (lease?.nonce === workerNonce && Number(lease.pid) === process.pid) break;
    sleep(100);
  }
  if (!lease || lease.nonce !== workerNonce || Number(lease.pid) !== process.pid) {
    fail("supervisor does not own its lease");
  }
  atomicWrite(supervisorLeasePath, `${JSON.stringify({
    ...lease,
    initializing: false,
    claimed_at_ms: Date.now(),
  }, null, 2)}\n`);
  await runSupervisorLoop(workerNonce);
  process.exit(0);
}

if (!worker) {
  process.stdout.write(`${JSON.stringify(reconcileOnce())}\n`);
  process.exit(0);
}

if (!SAFE_ID.test(workerTarget || "")) fail("worker target is invalid");
const target = validateTarget(workerTarget);
const { leaseRoot } = leasePaths(workerTarget);
let lease;
for (let attempt = 0; attempt < 30; attempt += 1) {
  lease = readLease(workerTarget);
  if (lease?.nonce === workerNonce && Number(lease.pid) === process.pid) break;
  sleep(100);
}
if (!lease || lease.nonce !== workerNonce || Number(lease.pid) !== process.pid) {
  fail("worker does not own the receiver lease");
}
atomicWrite(leasePaths(workerTarget).leasePath, `${JSON.stringify({
  ...lease,
  initializing: false,
  claimed_at_ms: Date.now(),
}, null, 2)}\n`);

const targetPendingRoot = path.join(pendingRoot, workerTarget);
const logPath = path.join(audit, `message-receiver-${workerTarget}.log`);
const statusPath = path.join(audit, `message-receiver-${workerTarget}.status.json`);
let activeChild = null;
let terminating = false;

function stopActiveChild(signal = "SIGTERM") {
  if (!activeChild?.pid) return;
  try { process.kill(-activeChild.pid, signal); } catch {}
}

function cleanup() {
  const current = readLease(workerTarget);
  if (current?.nonce === workerNonce && Number(current.pid) === process.pid) {
    fs.rmSync(leaseRoot, { recursive: true, force: true });
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (terminating) return;
    terminating = true;
    stopActiveChild("SIGTERM");
    setTimeout(() => stopActiveChild("SIGKILL"), 2000).unref();
    setTimeout(() => { cleanup(); process.exit(143); }, 2500).unref();
  });
}

function targetMessageIds() {
  return pendingByTarget().get(workerTarget) || [];
}

function receiverPrompt(messageIds) {
  const sessionGuidance = target.adapter === "codex"
    ? "Inspect goal state before changing it. Never blindly create a goal. Continue a matching active receiver goal. If an unrelated unfinished owner goal exists, do not overwrite it and do not acknowledge unprocessed inbound work; send a correlated busy/deferred report if possible and leave the original message pending. A completed, blocked, or stale receiver-bootstrap goal must not suppress this delivery."
    : "This exact persisted Grok session has no HawkGrokSpan goal-state control. Process the routed inbox directly. If the session cannot accept the work, do not acknowledge the unprocessed inbound message; send a correlated busy/deferred report if possible and leave the original pending.";
  return [
    `HawkGrokSpan delivered durable messages for target_bot_id ${workerTarget}: ${messageIds.join(", ")}.`,
    "This is agent notification and inbox continuation, not authorization for machine control.",
    sessionGuidance,
    `Your first action must be a direct call to the MCP tool hawkgrokspan__receive_messages with {"limit":50,"target_bot_id":"${workerTarget}"}. Do not search for the tool and do not use a terminal or call-tool fallback.`,
    "Receiving the envelope is not completion. Read and carry out each envelope body, send any requested operational reply with hawkgrokspan__send_message, then call hawkgrokspan__acknowledge_message for that message only after its work is complete.",
    `Process each delivered message ID once. Before ending, call hawkgrokspan__receive_messages again with {"limit":50,"target_bot_id":"${workerTarget}"} and continue until no unread routed envelope remains.`,
    `Operational replies go to the peer agent endpoint through HawkGrokSpan. In hawkgrokspan__send_message, recipient identifies the peer node; target_bot_id must be the peer target named by the envelope (for example m2-primary), never this local target ${workerTarget}. Harry is the human owner and should be contacted only for a new decision, authorization, or physical action.`,
    "For requested returned files, use the built-in Write or Edit tool directly; do not create files with terminal redirection. A requested Node self-test may run only as `node ABSOLUTE_FILE_UNDER_THE_CONFIGURED_EXCHANGE_ROOT`; do not combine it with another shell command.",
    "Do not enable or invoke shell control, peer commands, training, Funnel, Tailscale SSH, exit nodes, subnet routes, or broader access. End without leaving a synthetic receiver-only goal active.",
  ].join(" ");
}

function commandFor(prompt) {
  if (target.adapter === "codex") {
    return [target.command, [
      "exec",
      "-c", "sandbox_workspace_write.writable_roots=[]",
      "-s", target.sandbox,
      "-C", target.workdir,
      "resume",
      "--skip-git-repo-check",
      target.session_id,
      prompt,
    ]];
  }
  const tools = [
    "hawkgrokspan__acknowledge_message",
    "hawkgrokspan__flush_outbox",
    "hawkgrokspan__link_status",
    "hawkgrokspan__list_artifacts",
    "hawkgrokspan__list_messages",
    "hawkgrokspan__queue_artifact_delivery",
    "hawkgrokspan__receive_artifacts",
    "hawkgrokspan__receive_messages",
    "hawkgrokspan__register_artifact",
    "hawkgrokspan__retry_message",
    "hawkgrokspan__send_artifact",
    "hawkgrokspan__send_message",
    "hawkgrokspan__verify_artifact",
  ];
  const toolPermissions = tools.flatMap((toolName) => ["--allow", `MCPTool(${toolName})`]);
  const artifactWritePermissions = artifactWriteRoots.flatMap((root) => [
    "--allow", `Write(${root}/**)`,
    "--allow", `Edit(${root}/**)`,
    "--allow", `Bash(node ${root}/*)`,
  ]);
  return [target.command, [
    "-p", prompt,
    "--resume", target.session_id,
    "--cwd", target.workdir,
    "--output-format", "json",
    "--sandbox", target.sandbox,
    "--max-turns", String(target.maximumTurns),
    "--tools", tools.join(","),
    ...toolPermissions,
    ...artifactWritePermissions,
  ]];
}

async function runAgent(messageIds, timeoutMs) {
  const [command, args] = commandFor(receiverPrompt(messageIds));
  const logFd = fs.openSync(logPath, "a", 0o600);
  fs.writeSync(logFd, `${new Date().toISOString()} adapter=${target.adapter} messages=${messageIds.join(",")}\n`);
  activeChild = spawn(command, args, {
    cwd: target.workdir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      HOME: os.homedir(),
      HAWKGROKSPAN_RECEIVER_STATE_ROOT: stateRoot,
      HAWKGROKSPAN_TARGET_BOT_ID: workerTarget,
    },
  });
  let timedOut = false;
  const result = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      resolve(value);
    };
    let killTimer = null;
    let settleTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      stopActiveChild("SIGTERM");
      killTimer = setTimeout(() => stopActiveChild("SIGKILL"), 3000);
      settleTimer = setTimeout(() => settle({
        status: null,
        signal: "SIGKILL",
        error: "adapter did not exit after TERM/KILL containment deadline",
      }), 5000);
    }, timeoutMs);
    activeChild.once("error", (error) => {
      settle({ status: null, signal: null, error: error.message });
    });
    activeChild.once("exit", (status, signal) => {
      settle({ status, signal, error: null });
    });
  });
  fs.closeSync(logFd);
  activeChild = null;
  return { ...result, timed_out: timedOut };
}

try {
  const workerDeadline = Number(lease.started_at_ms) + target.maximumRuntimeSeconds * 1000;
  let previous = null;
  for (let pass = 1; pass <= 3; pass += 1) {
    fs.mkdirSync(targetPendingRoot, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(targetPendingRoot)) fs.rmSync(path.join(targetPendingRoot, name), { force: true });
    const messageIds = targetMessageIds();
    if (messageIds.length === 0) break;
    const beforeStates = Object.fromEntries(messageIds.map((messageId) => [messageId, durableState(messageId)]));
    const beforeSignature = JSON.stringify({ messageIds, states: beforeStates });
    if (beforeSignature === previous) break;
    previous = beforeSignature;
    const remainingMs = workerDeadline - Date.now();
    if (remainingMs < 1000) break;
    const result = await runAgent(messageIds, remainingMs);
    const states = Object.fromEntries(messageIds.map((messageId) => [messageId, durableState(messageId)]));
    const acknowledged = messageIds.every((messageId) => states[messageId] === "acknowledged");
    let retryAttempt = 0;
    if (!acknowledged) {
      try {
        const old = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        if (JSON.stringify(old.message_ids || []) === JSON.stringify(messageIds)) {
          retryAttempt = Number(old.retry_attempt || 0);
        }
      } catch {}
      retryAttempt += 1;
    }
    const nextRetryAtMs = acknowledged ? null : Date.now() +
      retryBackoffSeconds[Math.min(retryAttempt - 1, retryBackoffSeconds.length - 1)] * 1000;
    atomicWrite(statusPath, `${JSON.stringify({
      schema_version: 1,
      target_bot_id: workerTarget,
      adapter: target.adapter,
      session_id: target.session_id,
      message_ids: messageIds,
      states,
      acknowledged,
      retry_attempt: retryAttempt,
      next_retry_at_ms: nextRetryAtMs,
      next_retry_at: nextRetryAtMs ? new Date(nextRetryAtMs).toISOString() : null,
      attempt: pass,
      process: result,
      completed_at: new Date().toISOString(),
    }, null, 2)}\n`);
    if (acknowledged) {
      sleep(500);
      if (targetMessageIds().length === 0) break;
      continue;
    }
    if (result.timed_out || result.status !== 0) break;
  }
} finally {
  cleanup();
}
