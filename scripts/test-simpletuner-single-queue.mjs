#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-single-simpletuner-queue-"));
const schedulerRoot = path.join(root, "scheduler");
const queueRoot = path.join(root, "queue");
const invocation = path.join(root, "start.json");
const startScript = path.join(root, "start.sh");
const configPath = path.join(root, "config.json");
fs.mkdirSync(schedulerRoot, { recursive: true });
fs.mkdirSync(queueRoot, { recursive: true });
fs.writeFileSync(startScript, `#!/bin/sh
printf '{"queue_item_id":"%s","arguments":"%s"}\n' "$HAWKSPAN_SIMPLETUNER_QUEUE_ITEM_ID" "$*" > ${JSON.stringify(invocation)}
`);
fs.chmodSync(startScript, 0o700);

const jobsPath = path.join(schedulerRoot, "lora-jobs.json");
const statePath = path.join(schedulerRoot, "lora-scheduler-state.json");
fs.writeFileSync(jobsPath, `${JSON.stringify({
  schema_version: 2,
  jobs: [{
    job_id: "queue-r-test",
    target: "r-test",
    authorization_job_id: "durable-r-test",
    revision_fingerprint: "revision-r-test",
    authorized: true,
    priority: 10,
  }],
}, null, 2)}\n`);
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

const result = spawnSync("/usr/bin/python3", [path.join(scripts, "lora-scheduler.py")], {
  encoding: "utf8",
  env: { ...process.env, HAWKSPAN_CONFIG: configPath },
});
assert.equal(result.status, 0, result.stderr);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert.equal(state.current, "r-test");
assert.equal(state.jobs["queue-r-test"].state, "running");
assert.equal(state.jobs["queue-r-test"].phase, "training");
const started = JSON.parse(fs.readFileSync(invocation, "utf8"));
assert.equal(started.queue_item_id, "queue-r-test");
assert.match(started.arguments, /--job-id durable-r-test --target r-test/);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("single SimpleTuner lifecycle queue tests passed\n");
