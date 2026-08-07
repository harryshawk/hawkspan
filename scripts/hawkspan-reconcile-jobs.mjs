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
  const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`unable to read boot time: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
  const match = result.stdout.match(/sec = (\d+)/);
  return match ? new Date(Number(match[1]) * 1000) : null;
}

function readProcesses() {
  const result = spawnSync("/bin/ps", ["axww", "-o", "pid=,ppid=,pgid=,comm=,args="], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`unable to read process table: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
  return result.stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        process_group: Number(match[3]),
        command: match[4],
        arguments: match[5] || "",
        line,
      };
    })
    .filter(Boolean);
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
  return processes.find((process) => process.pid === Number(pid)) || null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function managedRunnerCommandMatches(process, runner, target, statusPath) {
  if (!runner || !target || !statusPath) return false;
  const exactInvocation = new RegExp(
    `^\\S+\\s+${escapeRegExp(runner)}\\s+--only-job\\s+${escapeRegExp(target)}(?=\\s|$)`,
  );
  const exactStatus = new RegExp(
    `(?:^|\\s)--status-file\\s+${escapeRegExp(statusPath)}(?=\\s|$)`,
  );
  return exactInvocation.test(process.arguments) && exactStatus.test(process.arguments);
}

function trainerRecordProcess(record, processes) {
  const process = processLineForPid(processes, Number(record.pid || 0));
  if (!process) return null;
  const runner = String(record.runner || "");
  const target = String(record.target || "");
  const statusPath = String(record.status_path || "");
  const recordedGroup = Number(record.process_group || 0);
  if (recordedGroup > 0 && process.process_group !== recordedGroup) return null;
  return managedRunnerCommandMatches(process, runner, target, statusPath) ? process : null;
}

function loadManifestByTarget() {
  let config = readJson(configPath, {});
  const pointerPath = path.resolve(
    config.lora_automation?.active_runtime_pointer ||
      path.join(path.dirname(configPath), "active-lora-runtime.json"),
  );
  const pointer = readJson(pointerPath, null);
  if (pointer?.config_path) {
    const runtimeConfig = path.resolve(pointer.config_path);
    const runtimeRoot = pointer.runtime_root ? path.resolve(pointer.runtime_root) : null;
    if (fs.existsSync(runtimeConfig) &&
        (!runtimeRoot || runtimeConfig.startsWith(`${runtimeRoot}${path.sep}`))) {
      config = readJson(runtimeConfig, config);
    }
  }
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

function reconcileTrainerControlRecords(
  bootTime,
  processes,
  applyChanges,
  durableJobsById,
) {
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
        process: process.line,
        process_identity: {
          pid: process.pid,
          process_group: process.process_group,
          runner: record.runner,
          target: record.target,
        },
      });
      continue;
    }
    const durableJob = durableJobsById.get(record.durable_job_id);
    const durableSettledStates = new Set([
      "failed", "completed", "verified", "cancelled", "returning", "paused",
    ]);
    if (durableJob && durableSettledStates.has(durableJob.state)) {
      const checkpoints = checkpointNamesForTarget(record.target, manifestByTarget);
      const result = {
        record_path: recordPath,
        durable_job_id: record.durable_job_id,
        target: record.target,
        previous_state: record.state,
        classification: `durable_${durableJob.state}`,
        checkpoints,
      };
      if (applyChanges) {
        atomicJson(recordPath, {
          ...record,
          state: durableJob.state,
          reconciled_at: Math.floor(Date.now() / 1000),
          reconciliation_reason: "durable_job_not_process_active",
          recovery_checkpoints: checkpoints,
        });
        const config = readJson(configPath, {});
        const schedulerRoot = config.lora_automation?.scheduler_root ||
          path.join(stateRoot, "lora-scheduler");
        atomicJson(path.join(schedulerRoot, "jobs", `${record.target}.json`), {
          schema_version: 1,
          target: record.target,
          state: durableJob.state,
          authorization_job_id: record.durable_job_id,
          reason: "durable job is not process-active",
          updated_at: Math.floor(Date.now() / 1000),
          recovery_checkpoints: checkpoints,
        });
        result.applied_state = durableJob.state;
      }
      results.push(result);
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

function jobProcessEvidence(job, processes, liveManagedByJobId) {
  const metadata = JSON.parse(job.metadata_json || "{}");
  const managedRecord = liveManagedByJobId.get(job.id);
  if (managedRecord && (!metadata.target || metadata.target === managedRecord.target)) {
    return {
      live: true,
      reason: "exact_managed_runner",
      process: managedRecord.process,
      process_identity: managedRecord.process_identity,
    };
  }
  const record = {
    pid: metadata.pid || metadata.managed_pid || metadata.trainer_pid,
    process_group: metadata.process_group,
    runner: metadata.runner,
    target: metadata.target,
    status_path: metadata.status_path,
  };
  const process = trainerRecordProcess(record, processes);
  if (process) {
    return {
      live: true,
      reason: "exact_managed_runner_metadata",
      process: process.line,
      process_identity: {
        pid: process.pid,
        process_group: process.process_group,
        runner: record.runner,
        target: record.target,
      },
    };
  }
  return { live: false, reason: "no_exact_managed_process_evidence" };
}

function classify(job, bootTime, processes, liveManagedByJobId) {
  const metadata = JSON.parse(job.metadata_json || "{}");
  const processEvidence = jobProcessEvidence(job, processes, liveManagedByJobId);
  const updatedAt = new Date(job.updated_at);
  const preBoot = bootTime ? updatedAt < bootTime : false;
  const activeStates = new Set(["running", "started", "stop_requested", "cancel_requested"]);
  const pendingStates = new Set(["queued", "authorized"]);
  const terminalStates = new Set(["completed", "verified", "cancelled", "failed"]);
  if (terminalStates.has(job.state)) {
    return {
      classification: processEvidence.live ? "settled_with_live_managed_process" : "terminal",
      process_evidence: processEvidence,
      metadata,
    };
  }
  if (job.state === "paused") {
    return {
      classification: processEvidence.live ? "settled_with_live_managed_process" : "paused",
      process_evidence: processEvidence,
      metadata,
    };
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
const rows = db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC").all();
const durableJobsById = new Map(rows.map((job) => [job.id, job]));
const trainer_control = reconcileTrainerControlRecords(
  bootTime, processes, apply, durableJobsById,
);
const liveManagedByJobId = new Map(trainer_control
  .filter((record) => record.classification === "real_active" && record.durable_job_id)
  .map((record) => [record.durable_job_id, record]));
const classified = rows.map((job) => ({
  ...job,
  ...classify(job, bootTime, processes, liveManagedByJobId),
}));
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
