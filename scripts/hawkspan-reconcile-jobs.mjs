#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const stateRoot = path.resolve(process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"));
const dbPath = path.join(stateRoot, "spool.sqlite3");
const auditRoot = path.join(stateRoot, "audit");
const configPath = path.resolve(process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH || path.join(stateRoot, "config.json"));
const trainerControlRoot = path.join(stateRoot, "trainer-control");

function now() {
  return new Date().toISOString();
}

function readBootTime() {
  const result = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
  const match = result.stdout.match(/sec = (\d+)/);
  return match ? new Date(Number(match[1]) * 1000) : null;
}

function readProcesses() {
  const result = spawnSync("ps", ["axww", "-o", "pid=,ppid=,comm=,args="], {
    encoding: "utf8",
    timeout: 5000,
  });
  return (result.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filePath);
}

function processLineForPid(processes, pid) {
  const wanted = String(pid);
  return processes.find((line) => line.split(/\s+/, 1)[0] === wanted) || null;
}

function trainerRecordProcess(record, processes) {
  const process = processLineForPid(processes, Number(record.pid || 0));
  if (!process) return null;
  const runner = String(record.runner || "");
  const target = String(record.target || "");
  return runner && target && process.includes(runner) && process.includes(target)
    ? process
    : null;
}

function loadManifestByTarget() {
  const config = readJson(configPath, {});
  const queueRoot = config.training?.queue_root || config.lora_automation?.queue_root;
  if (!queueRoot) return new Map();
  const manifest = readJson(path.join(queueRoot, "captioned-lora-manifest.json"), []);
  return new Map((Array.isArray(manifest) ? manifest : [])
    .filter((job) => job?.job_id)
    .map((job) => [job.job_id, job]));
}

function checkpointNamesForTarget(target, manifestByTarget) {
  const job = manifestByTarget.get(target);
  const outputDir = job?.output_dir;
  if (!outputDir || !fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^checkpoint-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a.slice(11)) - Number(b.slice(11)));
}

function reconcileTrainerControlRecords(bootTime, processes, applyChanges) {
  const manifestByTarget = loadManifestByTarget();
  if (!fs.existsSync(trainerControlRoot)) return [];
  const activeStates = new Set(["started", "running", "stop_requested"]);
  const results = [];
  for (const entry of fs.readdirSync(trainerControlRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") ||
        entry.name.endsWith(".status.json") ||
        entry.name.endsWith(".package-status.json")) {
      continue;
    }
    const recordPath = path.join(trainerControlRoot, entry.name);
    let record;
    try {
      record = readJson(recordPath, null);
    } catch (error) {
      results.push({ record_path: recordPath, classification: "unreadable", error: error.message });
      continue;
    }
    if (!record?.target || !activeStates.has(record.state)) continue;
    const process = trainerRecordProcess(record, processes);
    if (process) {
      results.push({
        record_path: recordPath,
        durable_job_id: record.durable_job_id || null,
        target: record.target,
        previous_state: record.state,
        classification: "real_active",
        process,
      });
      continue;
    }
    const startedAt = Number(record.started_at || 0);
    const startedBeforeBoot = Boolean(bootTime && startedAt > 0 && startedAt * 1000 < bootTime.getTime());
    const checkpoints = checkpointNamesForTarget(record.target, manifestByTarget);
    const nextState = checkpoints.length ? "interrupted_recoverable" : "interrupted_no_checkpoint";
    const result = {
      record_path: recordPath,
      durable_job_id: record.durable_job_id || null,
      target: record.target,
      previous_state: record.state,
      classification: nextState,
      checkpoints,
      started_at: startedAt,
      boot_time: bootTime?.toISOString() || null,
    };
    if (applyChanges) {
      const updated = {
        ...record,
        state: nextState,
        interrupted_at: Math.floor(Date.now() / 1000),
        interruption_reason: startedBeforeBoot ? "process_missing_after_boot" : "process_missing",
        recovery_checkpoints: checkpoints,
      };
      atomicJson(recordPath, updated);
      if (record.status_path) {
        atomicJson(record.status_path, {
          schema_version: 1,
          current: record.target,
          state: nextState,
          process_active: false,
          recovery_checkpoints: checkpoints,
          updated_at: Math.floor(Date.now() / 1000),
        });
      }
      const config = readJson(configPath, {});
      const schedulerRoot = config.lora_automation?.scheduler_root || path.join(stateRoot, "lora-scheduler");
      const jobControlPath = path.join(schedulerRoot, "jobs", `${record.target}.json`);
      atomicJson(jobControlPath, {
        schema_version: 1,
        target: record.target,
        state: nextState,
        authorization_job_id: record.durable_job_id || null,
        reason: checkpoints.length
          ? "interrupted after reboot; explicit checkpoint resume required"
          : "interrupted after reboot before any checkpoint; cannot resume",
        updated_at: Math.floor(Date.now() / 1000),
        recovery_checkpoints: checkpoints,
      });
      result.applied_state = nextState;
    }
    results.push(result);
  }
  return results;
}

function jobProcessEvidence(job, processes) {
  const metadata = JSON.parse(job.metadata_json || "{}");
  const pid = Number(metadata.pid || metadata.managed_pid || metadata.trainer_pid || 0);
  if (pid > 0) {
    const pidPrefix = String(pid);
    const match = processes.find((line) => line.split(/\s+/, 1)[0] === pidPrefix);
    if (match) return { live: true, reason: "pid_present", process: match };
  }
  const target = metadata.target;
  if (target) {
    const match = processes.find((line) => line.includes(target));
    if (match) return { live: true, reason: "target_present", process: match };
  }
  return { live: false, reason: "no_process_evidence" };
}

function classify(job, bootTime, processes) {
  const metadata = JSON.parse(job.metadata_json || "{}");
  const processEvidence = jobProcessEvidence(job, processes);
  const updatedAt = new Date(job.updated_at);
  const preBoot = bootTime ? updatedAt < bootTime : false;
  const activeStates = new Set(["running", "started", "stop_requested", "cancel_requested"]);
  const pendingStates = new Set(["queued", "authorized"]);
  const terminalStates = new Set(["completed", "verified", "cancelled", "failed"]);
  if (terminalStates.has(job.state)) {
    return { classification: "terminal", process_evidence: processEvidence, metadata };
  }
  if (job.state === "paused") {
    return { classification: "paused", process_evidence: processEvidence, metadata };
  }
  if (job.state === "returning") {
    const digest = metadata.packet_sha256;
    const receiptPath = digest
      ? path.join(stateRoot, "automatic-package-returns", `${digest}.json`)
      : null;
    const receipt = receiptPath ? readJson(receiptPath, null) : null;
    return {
      classification: receipt?.state === "receipt-confirmed" ? "return_receipt_confirmed" : "return_pending",
      process_evidence: processEvidence,
      metadata,
      receipt,
    };
  }
  if (activeStates.has(job.state)) {
    if (processEvidence.live) {
      return { classification: "real_active", process_evidence: processEvidence, metadata };
    }
    return {
      classification: preBoot ? "stale_after_boot" : "stale_no_process",
      process_evidence: processEvidence,
      metadata,
    };
  }
  if (pendingStates.has(job.state)) {
    return { classification: "pending_not_active", process_evidence: processEvidence, metadata };
  }
  return { classification: "unknown_state", process_evidence: processEvidence, metadata };
}

if (!fs.existsSync(dbPath)) {
  process.stderr.write(`missing HawkSpan job database: ${dbPath}\n`);
  process.exit(1);
}

fs.mkdirSync(auditRoot, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dbPath);
const bootTime = readBootTime();
const processes = readProcesses();
const trainer_control = reconcileTrainerControlRecords(bootTime, processes, apply);
const rows = db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC").all();
const classified = rows.map((job) => ({ ...job, ...classify(job, bootTime, processes) }));
const closable = classified.filter((job) => [
  "stale_after_boot",
  "stale_no_process",
].includes(job.classification));
const deliveredReturns = classified.filter((job) => job.classification === "return_receipt_confirmed");

if (apply && closable.length) {
  const update = db.prepare("UPDATE jobs SET state=?,updated_at=?,metadata_json=? WHERE id=?");
  const insertAudit = db.prepare(`
    INSERT INTO audit_events
      (timestamp,node_id,action,object_type,object_id,result,details_json)
    VALUES (?,?,?,?,?,?,?)
  `);
  for (const job of closable) {
    const terminalState = "failed";
    const metadata = {
      ...job.metadata,
      reconciled_by: "hawkspan-reconcile-jobs",
      reconciled_at: now(),
      reconciled_from_state: job.state,
      reconciliation_reason: job.classification,
    };
    update.run(terminalState, now(), JSON.stringify(metadata), job.id);
    insertAudit.run(
      now(),
      "hawkspan-startup",
      "reconcile",
      "job",
      job.id,
      terminalState,
      JSON.stringify({
        previous_state: job.state,
        terminal_state: terminalState,
        classification: job.classification,
        process_evidence: job.process_evidence,
      }),
    );
  }
}

if (apply && deliveredReturns.length) {
  const update = db.prepare("UPDATE jobs SET state='completed',updated_at=?,metadata_json=? WHERE id=?");
  for (const job of deliveredReturns) {
    update.run(now(), JSON.stringify({
      ...job.metadata,
      phase: "receipt-confirmed",
      package_return_state: "receipt-confirmed",
    }), job.id);
  }
}

const summary = {
  generated_at: now(),
  state_root: stateRoot,
  db_path: dbPath,
  boot_time: bootTime?.toISOString() || null,
  applied: apply,
  counts: classified.reduce((acc, job) => {
    acc[job.classification] = (acc[job.classification] || 0) + 1;
    return acc;
  }, {}),
  trainer_control,
  jobs: classified
    .filter((job) => job.classification !== "terminal")
    .map((job) => ({
      id: job.id,
      title: job.title,
      kind: job.kind,
      state: apply && closable.some((entry) => entry.id === job.id)
        ? "failed"
        : apply && deliveredReturns.some((entry) => entry.id === job.id)
          ? "completed"
        : job.state,
      previous_state: job.state,
      classification: job.classification,
      updated_at: job.updated_at,
      target: job.metadata.target || null,
      process_evidence: job.process_evidence,
    })),
};

const receiptPath = path.join(auditRoot, `job-reconciliation-${Date.now()}.json`);
fs.writeFileSync(receiptPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...summary, receipt_path: receiptPath }, null, 2)}\n`);
