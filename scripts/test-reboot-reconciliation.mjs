#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-reboot-reconciliation-"));
const queue = path.join(root, "queue");
const control = path.join(root, "trainer-control");
const scheduler = path.join(root, "lora-scheduler");
const recoverableOutput = path.join(root, "outputs", "recoverable");
fs.mkdirSync(queue, { recursive: true });
fs.mkdirSync(control, { recursive: true });
fs.mkdirSync(path.join(recoverableOutput, "checkpoint-25"), { recursive: true });

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
for (const [id, state] of [
  ["pending-authorized", "authorized"],
  ["pending-queued", "queued"],
  ["deliberately-paused", "paused"],
]) {
  insertJob.run(
    id, new Date().toISOString(), new Date().toISOString(), "test", "test",
    "training", id, "", state, state === "authorized" ? "recorded" : "not_required",
    state === "authorized" ? "test authorization" : null, "{}",
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
assert.equal(noCheckpoint.state, "interrupted_no_checkpoint");
assert.deepEqual(noCheckpoint.recovery_checkpoints, []);
assert.equal(recoverable.state, "interrupted_recoverable");
assert.deepEqual(recoverable.recovery_checkpoints, ["checkpoint-25"]);
assert.equal(sameBootMissing.state, "interrupted_no_checkpoint");
assert.equal(sameBootMissing.interruption_reason, "process_missing");
const reconciled = new DatabaseSync(path.join(root, "spool.sqlite3"));
for (const [id, state] of [
  ["pending-authorized", "authorized"],
  ["pending-queued", "queued"],
  ["deliberately-paused", "paused"],
]) {
  assert.equal(reconciled.prepare("SELECT state FROM jobs WHERE id=?").get(id).state, state);
}
reconciled.close();

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("HawkSpan reboot reconciliation tests passed\n");
