#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-scheduler-invocation-"));
const schedulerRoot = path.join(root, "scheduler");
const queueRoot = path.join(root, "queue");
const startsPath = path.join(root, "starts.txt");
const startScript = path.join(root, "start.sh");
const configPath = path.join(root, "config.json");
const databasePath = path.join(root, "spool.sqlite3");
fs.mkdirSync(schedulerRoot, { recursive: true });
fs.mkdirSync(queueRoot, { recursive: true });
fs.writeFileSync(startScript, `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(startsPath)}
sleep 1
`);
fs.chmodSync(startScript, 0o700);

const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    creator TEXT NOT NULL, assignee TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, state TEXT NOT NULL,
    authorization_state TEXT NOT NULL, authorization_evidence TEXT,
    metadata_json TEXT NOT NULL
  );
`);
const insertJob = database.prepare(`
  INSERT INTO jobs
    (id,created_at,updated_at,creator,assignee,kind,title,description,state,
     authorization_state,authorization_evidence,metadata_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`);
for (const target of ["r-first", "r-second"]) {
  const fingerprint = target === "r-first" ? "a".repeat(64) : "b".repeat(64);
  insertJob.run(
    `durable-${target}`, "now", "now", "test", "test", "training", target,
    target, "queued", "recorded", "test", JSON.stringify({
      target,
      revision_fingerprint: fingerprint,
    }),
  );
}
database.close();

const jobsPath = path.join(schedulerRoot, "lora-jobs.json");
const statePath = path.join(schedulerRoot, "lora-scheduler-state.json");
const schedulerDocument = {
  schema_version: 2,
  jobs: ["r-first", "r-second"].map((target, index) => ({
    job_id: `queue-${target}`,
    target,
    authorization_job_id: `durable-${target}`,
    revision_fingerprint: index === 0 ? "a".repeat(64) : "b".repeat(64),
    authorized: true,
    priority: index + 1,
  })),
};
fs.writeFileSync(jobsPath, `${JSON.stringify(schedulerDocument, null, 2)}\n`);
fs.writeFileSync(configPath, `${JSON.stringify({
  training: {
    process_match: "process-name-that-cannot-match",
    start_script: startScript,
  },
  lora_automation: {
    queue_root: queueRoot,
    scheduler_root: schedulerRoot,
    scheduler_jobs_path: jobsPath,
    scheduler_state_path: statePath,
    scheduler_policy_path: path.join(schedulerRoot, "policy.json"),
    scheduler_queue_control_path: path.join(schedulerRoot, "queue-control.json"),
    scheduler_job_control_root: path.join(schedulerRoot, "jobs"),
  },
}, null, 2)}\n`);

const run = () => new Promise((resolve, reject) => {
  const child = spawn("/usr/bin/python3", [path.join(scripts, "lora-scheduler.py")], {
    env: { ...process.env, HAWKSPAN_CONFIG: configPath, HAWKSPAN_STATE_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (status) => resolve({ status, stderr }));
});

schedulerDocument.jobs[0].revision_fingerprint = "c".repeat(64);
schedulerDocument.jobs[1].revision_fingerprint = "c".repeat(64);
fs.writeFileSync(jobsPath, `${JSON.stringify(schedulerDocument, null, 2)}\n`);
const mismatched = await run();
assert.equal(mismatched.status, 0, mismatched.stderr);
assert.equal(fs.existsSync(startsPath), false);
const mismatchState = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert.equal(mismatchState.jobs["queue-r-first"].state, "invalid-authorization");
fs.rmSync(statePath);
schedulerDocument.jobs[0].revision_fingerprint = "a".repeat(64);
schedulerDocument.jobs[1].revision_fingerprint = "b".repeat(64);
fs.writeFileSync(jobsPath, `${JSON.stringify(schedulerDocument, null, 2)}\n`);

const [first, second] = await Promise.all([run(), run()]);
assert.equal(first.status, 0, first.stderr);
assert.equal(second.status, 0, second.stderr);
const starts = fs.readFileSync(startsPath, "utf8").trim().split("\n");
assert.equal(starts.length, 1, "overlapping scheduler invocations launched two trainers");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert.equal(Object.values(state.jobs).filter((job) => job.state === "running").length, 1);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("scheduler invocation lock tests passed\n");
