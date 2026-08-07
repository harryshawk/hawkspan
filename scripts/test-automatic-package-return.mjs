#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-package-return-"));
const stateRoot = path.join(root, "state");
const packetRoot = path.join(root, "packets");
fs.mkdirSync(packetRoot, { recursive: true });
fs.mkdirSync(stateRoot, { recursive: true });
const packet = path.join(packetRoot, "r-test__return-packet.zip");
fs.writeFileSync(packet, "opaque package bytes; transport does not audit package contents\n");
const packetSha256 = crypto.createHash("sha256").update(fs.readFileSync(packet)).digest("hex");
const ledger = path.join(root, "ledger.json");
fs.writeFileSync(ledger, `${JSON.stringify({ packets: [{
  run_name: "r-test",
  status: "packaged",
  packet_path: packet,
  packet_sha256: packetSha256,
}] })}\n`);
const config = path.join(stateRoot, "config.json");
fs.writeFileSync(config, `${JSON.stringify({ lora_automation: { packet_ledger_path: ledger } })}\n`);
const queueRoot = path.join(root, "queue");
const schedulerRoot = path.join(stateRoot, "lora-scheduler");
const schedulerState = path.join(schedulerRoot, "lora-scheduler-state.json");
const schedulerJobs = path.join(schedulerRoot, "lora-jobs.json");

const fakeState = path.join(root, "fake-state.json");
const fakeLog = path.join(root, "fake-calls.log");
const fakeCallTool = path.join(root, "fake-call-tool.mjs");
const lockHolder = path.join(root, "lock-holder.mjs");
fs.writeFileSync(fakeCallTool, `
import fs from "node:fs";
const [name, raw] = process.argv.slice(2);
const args = JSON.parse(raw || "{}");
const statePath = process.env.FAKE_STATE;
const logPath = process.env.FAKE_LOG;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { artifacts: [] };
fs.appendFileSync(logPath, name + " " + JSON.stringify(args) + "\\n");
let structuredContent;
if (name === "list_artifacts") structuredContent = state.artifacts;
if (name === "list_jobs") structuredContent = [{ id: "durable-r-test", state: process.env.JOB_STATE || "returning" }];
if (name === "update_job_status") structuredContent = { job_id: args.job_id, state: args.state };
if (name === "receive_messages") structuredContent = { messages: process.env.RECEIVER_RECEIPT === "yes" ? [{
  id: "receiver-receipt-test",
  kind: "artifact-receipt",
  correlation_id: process.env.PACKET_SHA256,
  metadata: {
    sha256: process.env.PACKET_SHA256,
    transport_verified: true,
    expansion_secured: true,
  },
}] : [] };
if (name === "acknowledge_message") structuredContent = {
  acknowledged_message_id: args.message_id,
  reply_sent: false,
};
if (name === "register_artifact") {
  const digest = process.env.PACKET_SHA256;
  const artifact = { id: "artifact-test", path: args.path, sha256: digest, state: "registered", metadata: args.metadata };
  state.artifacts.push(artifact);
  fs.writeFileSync(statePath, JSON.stringify(state));
  structuredContent = { artifact_id: artifact.id, path: artifact.path, sha256: digest };
}
if (name === "send_artifact") {
  const verified = process.env.DELIVERY_MODE === "delivered";
  structuredContent = { artifact_id: args.artifact_id, delivery: { ok: verified, verified, queued: !verified } };
}
if (name === "queue_artifact_delivery") {
  structuredContent = { artifact_id: args.artifact_id, queued: true };
}
process.stdout.write(JSON.stringify({ isError: false, structuredContent }) + "\\n");
`);
fs.writeFileSync(lockHolder, `
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2]);
database.exec("CREATE TABLE IF NOT EXISTS lock_identity (id INTEGER PRIMARY KEY CHECK (id = 1))");
database.exec("BEGIN IMMEDIATE");
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`);

function run(extraEnv = {}, explicit = false, options = {}) {
  const selectedPacket = options.packet || packet;
  const selectedSha256 = options.sha256 || packetSha256;
  return spawnSync(process.execPath, [
    path.join(scripts, "automatic-package-return.mjs"),
    ...(explicit ? [
      "--strict", "--job-id", "r-test", "--packet", selectedPacket, "--sha256", selectedSha256,
      "--durable-job-id", "durable-r-test",
      "--queue-item-id", "queue-r-test",
      ...(options.awaitingValidation ? ["--awaiting-validation"] : []),
    ] : []),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HAWKSPAN_STATE_DIR: stateRoot,
      HAWKSPAN_CONFIG: config,
      HAWKSPAN_CALL_TOOL: fakeCallTool,
      FAKE_STATE: fakeState,
      FAKE_LOG: fakeLog,
      PACKET_SHA256: selectedSha256,
      ...extraEnv,
    },
  });
}

const historicalLedgerIgnored = run();
assert.equal(historicalLedgerIgnored.status, 0, historicalLedgerIgnored.stderr);
assert.equal(JSON.parse(historicalLedgerIgnored.stdout).checked, 0);
assert.equal(fs.existsSync(fakeLog), false);

fs.mkdirSync(queueRoot, { recursive: true });
fs.mkdirSync(schedulerRoot, { recursive: true });
fs.writeFileSync(config, `${JSON.stringify({
  training: { queue_root: queueRoot },
  lora_automation: {
    queue_root: queueRoot,
    scheduler_root: schedulerRoot,
    scheduler_state_path: schedulerState,
    scheduler_jobs_path: schedulerJobs,
  },
})}\n`);
fs.writeFileSync(schedulerJobs, `${JSON.stringify({ schema_version: 2, jobs: [{
  job_id: "queue-r-test",
  target: "r-test",
  authorization_job_id: "durable-r-test",
}] })}\n`);
fs.writeFileSync(schedulerState, `${JSON.stringify({ schema_version: 1, current: "queue-r-test", jobs: {
  "queue-r-test": {
    state: "running",
    phase: "returning",
    target: "r-test",
    packet,
    packet_sha256: packetSha256,
  },
} })}\n`);
fs.writeFileSync(path.join(queueRoot, "captioned-lora-status.json"), `${JSON.stringify({
  returning: [{ job_id: "r-test", packet }],
  completed: [],
})}\n`);

const lockRoot = path.join(stateRoot, "automatic-package-returns");
fs.mkdirSync(lockRoot, { recursive: true });
const lockPath = path.join(lockRoot, `${packetSha256}.lock.sqlite3`);
const holder = spawn(process.execPath, [lockHolder, lockPath], {
  stdio: ["ignore", "pipe", "inherit"],
});
await once(holder.stdout, "data");
const liveOwnerRefused = run({
  DELIVERY_MODE: "queued",
  HAWKSPAN_PACKAGE_RETURN_LOCK_WAIT_MS: "1000",
}, true);
assert.notEqual(liveOwnerRefused.status, 0);
assert.match(liveOwnerRefused.stdout, /database is locked/);
holder.kill("SIGKILL");
await once(holder, "exit");
const queued = run({
  DELIVERY_MODE: "queued",
  HAWKSPAN_PACKAGE_RETURN_LOCK_WAIT_MS: "1000",
}, true);
assert.equal(queued.status, 0, queued.stderr);
assert.equal(JSON.parse(queued.stdout).results[0].state, "queued");
assert.equal(fs.existsSync(lockPath), true, "the crash-safe SQLite lock database is persistent");

const rescanned = run();
assert.equal(rescanned.status, 0, rescanned.stderr);
assert.equal(JSON.parse(rescanned.stdout).results[0].state, "queued");

const delivered = run({ DELIVERY_MODE: "delivered" }, true);
assert.equal(delivered.status, 0, delivered.stderr);
assert.equal(JSON.parse(delivered.stdout).results[0].state, "staged");
assert.equal(
  fs.readFileSync(fakeLog, "utf8").includes("update_job_status "),
  false,
  "transport staging must not complete the durable job",
);

// Simulate a crash after the runner recorded its returning scheduler phase but
// before the local automatic-return receipt survived. Recovery must use the
// scheduler record and the receiver's durable receipt.
fs.unlinkSync(path.join(stateRoot, "automatic-package-returns", `${packetSha256}.json`));
const receiptConfirmed = run({ RECEIVER_RECEIPT: "yes" });
assert.equal(receiptConfirmed.status, 0, receiptConfirmed.stderr);
assert.equal(JSON.parse(receiptConfirmed.stdout).results[0].state, "receipt-confirmed");

const calls = fs.readFileSync(fakeLog, "utf8").trim().split("\n");
assert.equal(calls.filter((line) => line.startsWith("register_artifact ")).length, 1);
assert.equal(calls.filter((line) => line.startsWith("send_artifact ")).length, 2);
assert.equal(calls.filter((line) => line.startsWith("queue_artifact_delivery ")).length, 1);
assert.equal(calls.filter((line) => line.startsWith("update_job_status ")).length, 1);
assert.equal(calls.filter((line) => line.startsWith("acknowledge_message ")).length, 1);
const receipt = JSON.parse(fs.readFileSync(
  path.join(stateRoot, "automatic-package-returns", `${packetSha256}.json`),
  "utf8",
));
assert.equal(receipt.state, "receipt-confirmed");
assert.equal(receipt.sha256, packetSha256);
assert.equal(receipt.job_id, "r-test");
assert.equal(receipt.receiver_receipt_message_id, "receiver-receipt-test");
const finalScheduler = JSON.parse(fs.readFileSync(schedulerState, "utf8"));
assert.equal(finalScheduler.jobs["queue-r-test"].state, "completed");
assert.equal(finalScheduler.jobs["queue-r-test"].phase, "receipt-confirmed");
assert.equal(finalScheduler.current, null);
const finalStatus = JSON.parse(fs.readFileSync(
  path.join(queueRoot, "captioned-lora-status.json"),
  "utf8",
));
assert.equal(finalStatus.returning.length, 0);
assert.equal(finalStatus.completed[0].package_return_state, "receipt-confirmed");

// A terminal local receipt can survive while scheduler settlement does not.
// Replaying that receipt must repair only its own item and preserve a newer job.
const unsettledScheduler = JSON.parse(fs.readFileSync(schedulerState, "utf8"));
unsettledScheduler.jobs["queue-r-test"].state = "running";
unsettledScheduler.jobs["queue-r-test"].phase = "returning";
unsettledScheduler.current = "queue-r-next";
unsettledScheduler.jobs["queue-r-next"] = { state: "running", phase: "training", target: "r-next" };
fs.writeFileSync(schedulerState, `${JSON.stringify(unsettledScheduler)}\n`);
const replayedSettlement = run({ RECEIVER_RECEIPT: "yes" });
assert.equal(replayedSettlement.status, 0, replayedSettlement.stderr);
const replayedScheduler = JSON.parse(fs.readFileSync(schedulerState, "utf8"));
assert.equal(replayedScheduler.jobs["queue-r-test"].state, "completed");
assert.equal(replayedScheduler.current, "queue-r-next");

// A received training packet is durable evidence, but it is not terminal.
// It releases the scheduler slot and keeps the lifecycle awaiting validation.
const trainingPacket = path.join(packetRoot, "r-test__training__return-packet.zip");
fs.writeFileSync(trainingPacket, "training packet awaiting controlled validation\n");
const trainingSha256 = crypto.createHash("sha256")
  .update(fs.readFileSync(trainingPacket))
  .digest("hex");
const awaitingScheduler = JSON.parse(fs.readFileSync(schedulerState, "utf8"));
awaitingScheduler.current = "queue-r-test";
awaitingScheduler.jobs["queue-r-test"] = {
  state: "running",
  phase: "returning",
  target: "r-test",
  packet: trainingPacket,
  packet_sha256: trainingSha256,
  terminal: false,
};
fs.writeFileSync(schedulerState, `${JSON.stringify(awaitingScheduler)}\n`);
fs.writeFileSync(path.join(queueRoot, "captioned-lora-status.json"), `${JSON.stringify({
  returning: [{ job_id: "r-test", packet: trainingPacket }],
  completed: [],
})}\n`);
const trainingQueued = run(
  { DELIVERY_MODE: "queued", JOB_STATE: "running" },
  true,
  { packet: trainingPacket, sha256: trainingSha256, awaitingValidation: true },
);
assert.equal(trainingQueued.status, 0, trainingQueued.stderr);
assert.equal(JSON.parse(trainingQueued.stdout).results[0].state, "queued");
const awaitingValidation = run({
  RECEIVER_RECEIPT: "yes",
  JOB_STATE: "returning",
  PACKET_SHA256: trainingSha256,
});
assert.equal(awaitingValidation.status, 0, awaitingValidation.stderr);
const awaitingReceipt = JSON.parse(awaitingValidation.stdout).results[0];
assert.equal(awaitingReceipt.state, "receipt-confirmed");
assert.equal(awaitingReceipt.terminal, false);
const awaitingState = JSON.parse(fs.readFileSync(schedulerState, "utf8"));
assert.equal(awaitingState.jobs["queue-r-test"].state, "returning");
assert.equal(awaitingState.jobs["queue-r-test"].phase, "awaiting-validation");
assert.equal(awaitingState.current, null);
const awaitingStatus = JSON.parse(fs.readFileSync(
  path.join(queueRoot, "captioned-lora-status.json"),
  "utf8",
));
assert.equal(awaitingStatus.returning.length, 1);
assert.equal(awaitingStatus.completed.length, 0);
assert.equal(awaitingStatus.returning[0].phase, "awaiting-validation");
assert.equal(awaitingStatus.returning[0].package_return_state, "receipt-confirmed");
const lastDurableUpdate = fs.readFileSync(fakeLog, "utf8").trim().split("\n")
  .filter((line) => line.startsWith("update_job_status "))
  .at(-1);
assert.match(lastDurableUpdate, /\"state\":\"returning\"/);
assert.match(lastDurableUpdate, /\"phase\":\"awaiting-validation\"/);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("automatic package return tests passed\n");
