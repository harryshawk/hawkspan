#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-reboot-reconciliation-"));
const queue = path.join(root, "queue");
const control = path.join(root, "trainer-control");
const scheduler = path.join(root, "lora-scheduler");
const recoverableOutput = path.join(root, "outputs", "recoverable");
const runtimeQueue = path.join(root, "runtime-queue");
const returnReceipts = path.join(root, "automatic-package-returns");
const terminalOutput = path.join(root, "outputs", "terminal-package-failure");
const liveTarget = "settled-but-live";
const unrelatedTarget = "target-mentioned-by-status-command";
const managedRunner = path.join(root, "managed-runner.mjs");
const liveStatusPath = path.join(control, `job-settled-live--${liveTarget}.status.json`);
fs.mkdirSync(queue, { recursive: true });
fs.mkdirSync(control, { recursive: true });
fs.mkdirSync(path.join(recoverableOutput, "checkpoint-25"), { recursive: true });
fs.mkdirSync(path.join(terminalOutput, "checkpoint-100"), { recursive: true });
fs.mkdirSync(runtimeQueue, { recursive: true });
fs.mkdirSync(returnReceipts, { recursive: true });
fs.writeFileSync(managedRunner, "setInterval(() => {}, 1000);\n");
const liveRunner = spawn(
  process.execPath,
  [managedRunner, "--only-job", liveTarget, "--status-file", liveStatusPath],
  { detached: true, stdio: "ignore" },
);
const unrelatedCommand = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000);", unrelatedTarget],
  { detached: true, stdio: "ignore" },
);
await new Promise((resolve) => setTimeout(resolve, 100));

fs.writeFileSync(path.join(queue, "captioned-lora-manifest.json"), JSON.stringify([
  { job_id: "no-checkpoint", output_dir: path.join(root, "outputs", "empty") },
  { job_id: "recoverable", output_dir: recoverableOutput },
  { job_id: "same-boot-missing", output_dir: path.join(root, "outputs", "same-boot") },
]));
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  schema_version: 1,
  node_id: "reboot-test",
  training: { queue_root: queue, control_root: control },
  lora_automation: { scheduler_root: scheduler },
}));
fs.writeFileSync(path.join(runtimeQueue, "captioned-lora-manifest.json"), JSON.stringify([
  { job_id: "no-checkpoint", output_dir: path.join(root, "outputs", "empty") },
  { job_id: "recoverable", output_dir: recoverableOutput },
  { job_id: "same-boot-missing", output_dir: path.join(root, "outputs", "same-boot") },
  { job_id: "terminal-package-failure", output_dir: terminalOutput },
]));
const runtimeConfig = path.join(root, "runtime-config.json");
fs.writeFileSync(runtimeConfig, JSON.stringify({
  training: { queue_root: runtimeQueue },
  lora_automation: { scheduler_root: scheduler },
}));
fs.writeFileSync(path.join(root, "active-lora-runtime.json"), JSON.stringify({
  config_path: runtimeConfig,
  runtime_root: root,
}));

for (const entry of [
  { job: "job-no-checkpoint", target: "no-checkpoint" },
  { job: "job-recoverable", target: "recoverable" },
  { job: "job-same-boot", target: "same-boot-missing", started_at: Math.floor(Date.now() / 1000) },
]) {
  const statusPath = path.join(control, `${entry.job}--${entry.target}.status.json`);
  fs.writeFileSync(statusPath, JSON.stringify({ current: entry.target, total: 1 }));
  fs.writeFileSync(path.join(control, `${entry.job}--${entry.target}.json`), JSON.stringify({
    schema_version: 1,
    durable_job_id: entry.job,
    target: entry.target,
    state: "started",
    started_at: entry.started_at || 1,
    pid: process.pid,
    process_group: process.pid,
    runner: "/not/the/current/process",
    status_path: statusPath,
  }));
}
const terminalStatusPath = path.join(
  control,
  "job-package-failed--terminal-package-failure.status.json",
);
fs.writeFileSync(terminalStatusPath, JSON.stringify({
  current: "terminal-package-failure",
  failed: [{ job_id: "terminal-package-failure", phase: "package_return" }],
}));
fs.writeFileSync(
  path.join(control, "job-package-failed--terminal-package-failure.json"),
  JSON.stringify({
    schema_version: 1,
    durable_job_id: "job-package-failed",
    target: "terminal-package-failure",
    state: "started",
    started_at: 1,
    pid: process.pid,
    process_group: process.pid,
    runner: "/not/the/current/process",
    status_path: terminalStatusPath,
  }),
);
fs.writeFileSync(
  path.join(control, `job-settled-live--${liveTarget}.json`),
  JSON.stringify({
    schema_version: 1,
    durable_job_id: "job-settled-live",
    target: liveTarget,
    state: "started",
    started_at: 1,
    pid: liveRunner.pid,
    process_group: liveRunner.pid,
    runner: managedRunner,
    status_path: liveStatusPath,
  }),
);

const database = new DatabaseSync(path.join(root, "spool.sqlite3"));
database.exec(`
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    creator TEXT NOT NULL, assignee TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, state TEXT NOT NULL,
    authorization_state TEXT NOT NULL, authorization_evidence TEXT,
    metadata_json TEXT NOT NULL
  );
  CREATE TABLE audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
    node_id TEXT NOT NULL, action TEXT NOT NULL, object_type TEXT NOT NULL,
    object_id TEXT, result TEXT NOT NULL, details_json TEXT NOT NULL
  );
`);
const insertJob = database.prepare(`
  INSERT INTO jobs
    (id,created_at,updated_at,creator,assignee,kind,title,description,state,
     authorization_state,authorization_evidence,metadata_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`);
const terminalReceiptSha = "a".repeat(64);
const nonterminalReceiptSha = "b".repeat(64);
const legacyNonterminalReceiptSha = "c".repeat(64);
for (const [sha256, terminal] of [
  [terminalReceiptSha, true],
  [nonterminalReceiptSha, false],
  [legacyNonterminalReceiptSha, false],
]) {
  fs.writeFileSync(path.join(returnReceipts, `${sha256}.json`), JSON.stringify({
    state: "receipt-confirmed",
    sha256,
    terminal,
  }));
}
for (const [id, state] of [
  ["pending-authorized", "authorized"],
  ["pending-queued", "queued"],
  ["deliberately-paused", "paused"],
  ["job-package-failed", "failed"],
  ["job-settled-live", "failed"],
  ["job-pid-reused", "running"],
  ["job-unrelated-target", "running"],
  ["terminal-return", "returning"],
  ["nonterminal-return", "returning"],
  ["legacy-completed-nonterminal", "completed"],
]) {
  const metadata = id === "job-pid-reused"
    ? { pid: process.pid, target: "pid-reuse-target" }
    : id === "job-unrelated-target"
      ? { target: unrelatedTarget }
      : id === "job-settled-live"
        ? { target: liveTarget }
        : id === "terminal-return"
          ? { packet_sha256: terminalReceiptSha, terminal: true }
          : id === "nonterminal-return"
            ? { packet_sha256: nonterminalReceiptSha, terminal: false }
            : id === "legacy-completed-nonterminal"
              ? { packet_sha256: legacyNonterminalReceiptSha, terminal: false }
              : {};
  insertJob.run(
    id, new Date().toISOString(), new Date().toISOString(), "test", "test",
    "training", id, "", state, state === "authorized" ? "recorded" : "not_required",
    state === "authorized" ? "test authorization" : null, JSON.stringify(metadata),
  );
}
database.close();

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "hawkspan-reconcile-jobs.mjs");
const result = spawnSync(process.execPath, [script, "--apply"], {
  env: {
    ...process.env,
    HAWKSPAN_STATE_DIR: root,
    HAWKSPAN_CONFIG: path.join(root, "config.json"),
  },
  encoding: "utf8",
  timeout: 10000,
});
assert.equal(result.status, 0, result.stderr);

const noCheckpoint = JSON.parse(fs.readFileSync(
  path.join(control, "job-no-checkpoint--no-checkpoint.json"),
));
const recoverable = JSON.parse(fs.readFileSync(
  path.join(control, "job-recoverable--recoverable.json"),
));
const sameBootMissing = JSON.parse(fs.readFileSync(
  path.join(control, "job-same-boot--same-boot-missing.json"),
));
const terminalPackageFailure = JSON.parse(fs.readFileSync(
  path.join(control, "job-package-failed--terminal-package-failure.json"),
));
assert.equal(noCheckpoint.state, "interrupted_no_checkpoint");
assert.deepEqual(noCheckpoint.recovery_checkpoints, []);
assert.equal(recoverable.state, "interrupted_recoverable");
assert.deepEqual(recoverable.recovery_checkpoints, ["checkpoint-25"]);
assert.equal(sameBootMissing.state, "interrupted_no_checkpoint");
assert.equal(sameBootMissing.interruption_reason, "process_missing");
assert.equal(terminalPackageFailure.state, "failed");
assert.deepEqual(terminalPackageFailure.recovery_checkpoints, ["checkpoint-100"]);
assert.deepEqual(JSON.parse(fs.readFileSync(terminalStatusPath)).failed, [
  { job_id: "terminal-package-failure", phase: "package_return" },
]);
const settledLiveRecord = JSON.parse(fs.readFileSync(
  path.join(control, `job-settled-live--${liveTarget}.json`),
));
assert.equal(settledLiveRecord.state, "started");
const summary = JSON.parse(result.stdout);
const settledLiveControl = summary.trainer_control.find(
  (entry) => entry.durable_job_id === "job-settled-live",
);
assert.equal(settledLiveControl.classification, "real_active");
assert.equal(settledLiveControl.process_identity.pid, liveRunner.pid);
assert.equal(
  summary.jobs.find((job) => job.id === "job-settled-live").classification,
  "settled_with_live_managed_process",
);
const reconciled = new DatabaseSync(path.join(root, "spool.sqlite3"));
for (const [id, state] of [
  ["pending-authorized", "authorized"],
  ["pending-queued", "queued"],
  ["deliberately-paused", "paused"],
]) {
  assert.equal(reconciled.prepare("SELECT state FROM jobs WHERE id=?").get(id).state, state);
}
assert.equal(reconciled.prepare("SELECT state FROM jobs WHERE id=?").get("job-pid-reused").state, "failed");
assert.equal(
  reconciled.prepare("SELECT state FROM jobs WHERE id=?").get("job-unrelated-target").state,
  "failed",
);
assert.equal(reconciled.prepare("SELECT state FROM jobs WHERE id=?").get("terminal-return").state, "completed");
for (const id of ["nonterminal-return", "legacy-completed-nonterminal"]) {
  const row = reconciled.prepare("SELECT state,metadata_json FROM jobs WHERE id=?").get(id);
  assert.equal(row.state, "returning");
  const metadata = JSON.parse(row.metadata_json);
  assert.equal(metadata.phase, "awaiting-validation");
  assert.equal(metadata.package_return_state, "receipt-confirmed");
  assert.equal(metadata.terminal, false);
}
reconciled.close();

process.kill(-liveRunner.pid, "SIGTERM");
process.kill(-unrelatedCommand.pid, "SIGTERM");
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("HawkSpan reboot reconciliation tests passed\n");
