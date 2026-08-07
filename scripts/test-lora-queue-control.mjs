#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-queue-control-"));
const scheduler = path.join(root, "lora-scheduler");
const jobs = path.join(scheduler, "jobs");
const config = path.join(root, "config.json");
const ps = path.join(root, "fake-ps");
fs.mkdirSync(jobs, { recursive: true });
fs.writeFileSync(config, JSON.stringify({
  lora_automation: {
    scheduler_root: scheduler,
    scheduler_job_control_root: jobs,
  },
}));
fs.writeFileSync(path.join(jobs, "stale-target.json"), JSON.stringify({
  schema_version: 1,
  target: "stale-target",
  state: "running",
  authorization_job_id: "job-stale",
}));
fs.writeFileSync(path.join(jobs, "active-target.json"), JSON.stringify({
  schema_version: 1,
  target: "active-target",
  state: "running",
  authorization_job_id: "job-active",
}));
fs.writeFileSync(path.join(scheduler, "lora-jobs.json"), JSON.stringify({
  schema_version: 2,
  jobs: [
    { job_id: "queue-active", target: "active-target", authorized: true, priority: 10 },
    { job_id: "queue-stale", target: "stale-target", authorized: true, priority: 20 },
  ],
}));
fs.writeFileSync(path.join(scheduler, "lora-scheduler-state.json"), JSON.stringify({
  schema_version: 1,
  current: "active-target",
  jobs: {
    "queue-active": { state: "running", phase: "training", attempts: 1 },
    "queue-stale": { state: "running", phase: "training", attempts: 1 },
  },
}));
fs.writeFileSync(ps, `#!/bin/sh
cat <<'OUT'
12100 1 12100 /usr/bin/python3 /release/scripts/run_captioned_loras.py.managed --only-job active-target --mode train-and-return
OUT
`);
fs.chmodSync(ps, 0o700);

function queueControl(args) {
  const result = spawnSync("/usr/bin/python3", [
    path.join(repoRoot, "scripts", "lora-queue-control.py"),
    ...args,
  ], {
    env: { ...process.env, HAWKSPAN_CONFIG: config, HAWKSPAN_PS: ps },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const status = queueControl(["status"]);
assert.equal(status.queue_id, "simpletuner");
assert.equal(status.items.find((item) => item.target === "active-target").active_process.pid, 12100);
assert.equal(status.controls["stale-target"].reported_state, "stale_running");

const repaired = queueControl(["status", "--repair-stale"]);
assert.deepEqual(repaired.repaired_stale_targets, ["stale-target"]);
assert.equal(repaired.controls["stale-target"].state, "stale");
assert.equal(repaired.controls["stale-target"].previous_state, "running");
assert.equal(repaired.items.find((item) => item.target === "stale-target").state, "stale");
assert.equal(repaired.current, "active-target");
assert.equal(JSON.parse(fs.readFileSync(path.join(jobs, "active-target.json"))).state, "running");

const activeRetry = spawnSync("/usr/bin/python3", [
  path.join(repoRoot, "scripts", "lora-queue-control.py"),
  "retry-job", "--target", "active-target", "--reason", "must refuse",
], {
  env: { ...process.env, HAWKSPAN_CONFIG: config, HAWKSPAN_PS: ps },
  encoding: "utf8",
  timeout: 10000,
});
assert.notEqual(activeRetry.status, 0);
assert.match(activeRetry.stderr, /refuses active target/);

let queueState = queueControl(["pause-queue", "--reason", "whole queue test"]);
assert.equal(queueState.state, "paused");
assert.equal(queueState.active_jobs[0].target, "active-target");
queueState = queueControl(["resume-queue", "--reason", "whole queue test complete"]);
assert.equal(queueState.state, "running");

queueControl(["pause-job", "--target", "stale-target", "--reason", "test"]);
let schedulerState = JSON.parse(fs.readFileSync(path.join(scheduler, "lora-scheduler-state.json")));
assert.equal(schedulerState.jobs["queue-stale"].state, "paused");
queueControl(["resume-job", "--target", "stale-target", "--reason", "test"]);
schedulerState = JSON.parse(fs.readFileSync(path.join(scheduler, "lora-scheduler-state.json")));
assert.equal(schedulerState.jobs["queue-stale"].state, "queued");
schedulerState.current = "stale-target";
fs.writeFileSync(
  path.join(scheduler, "lora-scheduler-state.json"),
  JSON.stringify(schedulerState),
);
queueControl(["skip-job", "--target", "stale-target", "--reason", "test"]);
schedulerState = JSON.parse(fs.readFileSync(path.join(scheduler, "lora-scheduler-state.json")));
assert.equal(schedulerState.jobs["queue-stale"].state, "skipped");
assert.equal(schedulerState.current, null);
queueControl(["retry-job", "--target", "stale-target", "--reason", "test"]);
schedulerState = JSON.parse(fs.readFileSync(path.join(scheduler, "lora-scheduler-state.json")));
assert.equal(schedulerState.jobs["queue-stale"].state, "queued");
assert.equal(schedulerState.jobs["queue-stale"].attempts, 0);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("lora queue-control tests passed\n");
