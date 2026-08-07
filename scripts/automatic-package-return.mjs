#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mutateSchedulerState } from "./scheduler-state.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const stateRoot = path.resolve(
  process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"),
);
const callTool = path.resolve(process.env.HAWKSPAN_CALL_TOOL || path.join(scriptRoot, "call-tool.mjs"));
const receiptRoot = path.join(stateRoot, "automatic-package-returns");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function digest(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let count;
    do {
      count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count) hash.update(buffer.subarray(0, count));
    } while (count);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function settleSchedulerItem(queueItemId, jobId, receipt, terminal) {
  const configPath = path.resolve(
    process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH || path.join(stateRoot, "config.json"),
  );
  if (!fs.existsSync(configPath)) return;
  const config = readJson(configPath);
  const queueRoot = config.training?.queue_root || config.lora_automation?.queue_root;
  if (queueRoot) {
    const statusPath = path.join(path.resolve(queueRoot), "captioned-lora-status.json");
    if (fs.existsSync(statusPath)) {
      const status = readJson(statusPath);
      const returning = Array.isArray(status.returning) ? status.returning : [];
      const settled = returning.find((entry) => entry.job_id === jobId);
      if (settled) {
        if (terminal) {
          status.returning = returning.filter((entry) => entry.job_id !== jobId);
          status.completed = Array.isArray(status.completed) ? status.completed : [];
          if (!status.completed.some((entry) => entry.job_id === jobId)) {
            status.completed.push({ ...settled, package_return_state: "receipt-confirmed" });
          }
        } else {
          status.returning = returning.map((entry) => entry.job_id === jobId ? {
            ...entry,
            phase: "awaiting-validation",
            package_return_state: "receipt-confirmed",
            receiver_receipt_message_id: receipt.receiver_receipt_message_id,
          } : entry);
        }
        atomicJson(statusPath, status);
      }
    }
  }
  if (!queueItemId) return;
  const schedulerRoot = path.resolve(
    config.lora_automation?.scheduler_root || path.join(stateRoot, "lora-scheduler"),
  );
  const schedulerStatePath = path.resolve(
    config.lora_automation?.scheduler_state_path || path.join(schedulerRoot, "lora-scheduler-state.json"),
  );
  if (!fs.existsSync(schedulerStatePath)) return;
  mutateSchedulerState(
    schedulerStatePath,
    { schema_version: 1, jobs: {}, current: null },
    (state) => {
      const current = state.jobs?.[queueItemId];
      if (!current) return;
      const now = new Date().toISOString();
      state.jobs[queueItemId] = {
        ...current,
        state: terminal ? "completed" : "returning",
        phase: terminal ? "receipt-confirmed" : "awaiting-validation",
        target: jobId,
        packet_path: receipt.packet_path,
        packet_sha256: receipt.sha256,
        artifact_id: receipt.artifact_id,
        receiver_receipt_message_id: receipt.receiver_receipt_message_id,
        ...(terminal ? { completed_at: now } : { awaiting_validation_at: now }),
      };
      if (state.current === queueItemId) state.current = null;
      state.decision = terminal ? "receipt-confirmed" : "awaiting-validation";
      state.last_checked_at = now;
    },
  );
}

function call(name, args) {
  const result = spawnSync(process.execPath, [callTool, name, JSON.stringify(args)], {
    encoding: "utf8",
    env: process.env,
    timeout: 24 * 60 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(result.stderr?.trim() || result.error?.message || `${name} failed`);
  }
  const response = JSON.parse(result.stdout);
  if (response.isError) throw new Error(response.content?.[0]?.text || `${name} failed`);
  return response.structuredContent;
}

function validatePacket(packetPath) {
  const stat = fs.statSync(packetPath);
  if (!stat.isFile()) throw new Error(`return packet is not a regular file: ${packetPath}`);
  if (stat.size < 1) throw new Error(`return packet is empty: ${packetPath}`);
  return stat;
}

function findArtifact(artifacts, packetPath, packetSha256, jobId) {
  return artifacts.find((artifact) => (
    artifact.sha256 === packetSha256 &&
    (artifact.path === packetPath || artifact.metadata?.automatic_return_job_id === jobId)
  ));
}

function findReceiverReceipt(packetSha256) {
  const response = call("receive_messages", {
    include_acknowledged: true,
    limit: 500,
  });
  return (response.messages || []).find((message) => (
    message.kind === "artifact-receipt" &&
    message.correlation_id === packetSha256 &&
    message.metadata?.sha256 === packetSha256 &&
    message.metadata?.transport_verified === true &&
    message.metadata?.expansion_secured === true
  )) || null;
}

function confirmReceipt(pending, receiverReceipt) {
  const receipt = {
    ...pending,
    state: "settling",
    receiver_receipt_message_id: receiverReceipt.id,
    receiver_receipt_metadata: receiverReceipt.metadata,
    receipt_confirmed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const receiptPath = path.join(receiptRoot, `${pending.sha256}.json`);
  atomicJson(receiptPath, receipt);
  const jobs = pending.durable_job_id
    ? call("list_jobs", { job_id: pending.durable_job_id, limit: 1 })
    : [];
  const job = jobs[0];
  const terminal = pending.terminal !== false;
  const nextDurableState = terminal ? "completed" : "returning";
  const maySettleDurableJob = job && (
    ["running", "returning"].includes(job.state) ||
    (job.state === "completed" && terminal)
  );
  if (maySettleDurableJob) {
    call("update_job_status", {
      job_id: pending.durable_job_id,
      state: nextDurableState,
      metadata: {
        phase: terminal ? "receipt-confirmed" : "awaiting-validation",
        packet: pending.packet_path,
        packet_path: pending.packet_path,
        packet_sha256: pending.sha256,
        package_return_artifact_id: pending.artifact_id,
        package_return_state: "receipt-confirmed",
        receiver_receipt_message_id: receiverReceipt.id,
        terminal,
      },
    });
  } else if (job?.state === "completed" && !terminal) {
    throw new Error(
      "nonterminal package receipt cannot preserve an incorrectly completed durable job; run startup reconciliation first",
    );
  }
  settleSchedulerItem(
    pending.simpletuner_queue_item_id,
    pending.job_id,
    receipt,
    terminal,
  );
  try {
    call("acknowledge_message", {
      message_id: receiverReceipt.id,
      reply: false,
      deliver: false,
    });
  } catch (error) {
    receipt.receiver_receipt_acknowledgement_error = String(error.message || error);
  }
  receipt.state = "receipt-confirmed";
  receipt.settled_at = new Date().toISOString();
  receipt.updated_at = receipt.settled_at;
  atomicJson(receiptPath, receipt);
  return receipt;
}

function withDigestLock(packetSha256, callback) {
  fs.mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  const waitMs = Math.max(1000, Number(process.env.HAWKSPAN_PACKAGE_RETURN_LOCK_WAIT_MS || 30000));
  const database = new DatabaseSync(path.join(receiptRoot, `${packetSha256}.lock.sqlite3`));
  database.exec(`PRAGMA busy_timeout = ${Math.floor(waitMs)}`);
  database.exec("CREATE TABLE IF NOT EXISTS lock_identity (id INTEGER PRIMARY KEY CHECK (id = 1))");
  let transactionOpen = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const result = callback();
    database.exec("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    database.close();
  }
}

function returnPacket({ jobId, packetPath, expectedSha256 = null, durableJobId = null, queueItemId = null, terminal = true }, sendNow) {
  const resolvedPacket = path.resolve(packetPath);
  const stat = validatePacket(resolvedPacket);
  const packetSha256 = digest(resolvedPacket);
  if (expectedSha256 && packetSha256 !== expectedSha256) {
    throw new Error(`return packet digest mismatch: expected ${expectedSha256}, found ${packetSha256}`);
  }
  return withDigestLock(packetSha256, () => {
    const receiptPath = path.join(receiptRoot, `${packetSha256}.json`);
    const previous = fs.existsSync(receiptPath) ? readJson(receiptPath) : null;
    if (previous?.state === "receipt-confirmed" && previous.packet_path === resolvedPacket) {
      const receiverReceipt = findReceiverReceipt(packetSha256);
      return receiverReceipt ? confirmReceipt(previous, receiverReceipt) : previous;
    }

    const artifacts = call("list_artifacts", { sha256: packetSha256, limit: 5000 });
    let artifact = findArtifact(artifacts, resolvedPacket, packetSha256, jobId);
    if (!artifact) {
      const registered = call("register_artifact", {
        path: resolvedPacket,
        name: path.basename(resolvedPacket),
        metadata: {
          kind: "lora-return-packet",
          automatic_return: true,
          automatic_return_job_id: jobId,
          durable_job_id: durableJobId,
          simpletuner_queue_item_id: queueItemId,
          packet_sha256: packetSha256,
          terminal,
        },
      });
      if (registered.sha256 !== packetSha256) throw new Error("registered artifact digest changed");
      artifact = { id: registered.artifact_id, state: "registered" };
    }

    const pending = {
      schema_version: 1,
      job_id: jobId,
      packet_path: resolvedPacket,
      packet_name: path.basename(resolvedPacket),
      size_bytes: stat.size,
      sha256: packetSha256,
      artifact_id: artifact.id,
      durable_job_id: durableJobId,
      simpletuner_queue_item_id: queueItemId,
      terminal,
      state: "registered",
      updated_at: new Date().toISOString(),
    };
    atomicJson(receiptPath, pending);

    const existingReceiverReceipt = findReceiverReceipt(packetSha256);
    if (existingReceiverReceipt) return confirmReceipt(pending, existingReceiverReceipt);

    if (previous?.state === "staged" && previous.packet_path === resolvedPacket) {
      const staged = { ...pending, ...previous, updated_at: new Date().toISOString() };
      atomicJson(receiptPath, staged);
      return staged;
    }
    const sent = call(sendNow ? "send_artifact" : "queue_artifact_delivery", {
      artifact_id: artifact.id,
    });
    const stagedOnReceiver = sent.delivery?.verified === true;
    const receipt = {
      ...pending,
      state: stagedOnReceiver ? "staged" : "queued",
      delivery: sent.delivery || { queued: sent.queued === true },
      updated_at: new Date().toISOString(),
    };
    atomicJson(receiptPath, receipt);
    const receiverReceipt = findReceiverReceipt(packetSha256);
    return receiverReceipt ? confirmReceipt(receipt, receiverReceipt) : receipt;
  });
}

function candidatesFromReceipts() {
  if (!fs.existsSync(receiptRoot)) return [];
  return fs.readdirSync(receiptRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(receiptRoot, name)))
    .filter((entry) => ["registered", "queued", "staged", "settling"].includes(entry.state))
    .map((entry) => ({
      jobId: entry.job_id,
      packetPath: entry.packet_path,
      expectedSha256: entry.sha256,
      durableJobId: entry.durable_job_id || null,
      queueItemId: entry.simpletuner_queue_item_id || null,
      terminal: entry.terminal !== false,
    }))
    .filter((entry) => entry.jobId && entry.packetPath);
}

function candidatesFromScheduler() {
  const configPath = path.resolve(
    process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH || path.join(stateRoot, "config.json"),
  );
  if (!fs.existsSync(configPath)) return [];
  const config = readJson(configPath);
  const automation = config.lora_automation || {};
  const schedulerRoot = path.resolve(automation.scheduler_root || path.join(stateRoot, "lora-scheduler"));
  const statePath = path.resolve(
    automation.scheduler_state_path || path.join(schedulerRoot, "lora-scheduler-state.json"),
  );
  const jobsPath = path.resolve(
    automation.scheduler_jobs_path || path.join(schedulerRoot, "lora-jobs.json"),
  );
  if (!fs.existsSync(statePath)) return [];
  const state = readJson(statePath);
  const jobs = fs.existsSync(jobsPath) ? readJson(jobsPath).jobs || [] : [];
  const jobsById = new Map(jobs.map((job) => [job.job_id, job]));
  return Object.entries(state.jobs || {})
    .filter(([, record]) => record.phase === "returning" && record.state !== "completed")
    .map(([queueItemId, record]) => {
      const queued = jobsById.get(queueItemId) || {};
      return {
        jobId: record.target || queued.target,
        packetPath: record.packet_path || record.packet,
        expectedSha256: record.packet_sha256 || null,
        durableJobId: queued.authorization_job_id || record.authorization_job_id || null,
        queueItemId,
        terminal: record.terminal !== false,
      };
    })
    .filter((entry) => entry.jobId && entry.packetPath && fs.existsSync(entry.packetPath));
}

function recoveryCandidates() {
  const candidates = [...candidatesFromReceipts(), ...candidatesFromScheduler()];
  const unique = new Map();
  for (const candidate of candidates) {
    unique.set(candidate.expectedSha256 || path.resolve(candidate.packetPath), candidate);
  }
  return [...unique.values()];
}

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const explicitPacket = value("--packet");
const explicitJob = value("--job-id");
const candidates = explicitPacket || explicitJob
  ? [{
      jobId: explicitJob,
      packetPath: explicitPacket,
      expectedSha256: value("--sha256"),
      durableJobId: value("--durable-job-id"),
      queueItemId: value("--queue-item-id"),
      terminal: !args.includes("--awaiting-validation"),
    }]
  : recoveryCandidates();

if (candidates.some((entry) => !entry.jobId || !entry.packetPath)) {
  process.stderr.write("--packet and --job-id must be supplied together\n");
  process.exit(2);
}

const results = [];
for (const candidate of candidates) {
  try {
    results.push({ ok: true, ...returnPacket(candidate, Boolean(explicitPacket)) });
  } catch (error) {
    results.push({ ok: false, job_id: candidate.jobId, packet_path: candidate.packetPath, error: String(error.message || error) });
  }
}
process.stdout.write(`${JSON.stringify({ checked: candidates.length, results })}\n`);
if (strict && results.some((entry) => !entry.ok)) process.exitCode = 1;
