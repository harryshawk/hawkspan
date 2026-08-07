#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegated-trainer-job-"));
const invocationLog = path.join(root, "trainer-invocations.log");
const adapter = path.join(root, "trainer-adapter.sh");
const activeMarker = path.join(root, "trainer-active");
const schedulerRoot = path.join(root, "lora-scheduler");
const schedulerJobs = path.join(schedulerRoot, "lora-jobs.json");
const schedulerState = path.join(schedulerRoot, "lora-scheduler-state.json");
const schedulerControls = path.join(schedulerRoot, "jobs");
const fakePs = path.join(root, "fake-ps.sh");
fs.mkdirSync(schedulerControls, { recursive: true });
fs.writeFileSync(adapter, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(invocationLog)}
if [ -e ${JSON.stringify(activeMarker)} ]; then
  rm -f ${JSON.stringify(activeMarker)}
else
  : > ${JSON.stringify(activeMarker)}
fi
printf '{"ok":true}\\n'
`, { mode: 0o755 });
fs.writeFileSync(fakePs, `#!/bin/sh
if [ ! -e ${JSON.stringify(activeMarker)} ]; then
  exit 0
fi
cat <<'OUT'
12100 1 12100 /usr/bin/python3 /release/scripts/run_captioned_loras.py.managed --only-job robot-test --mode train-and-return
OUT
`, { mode: 0o755 });
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  schema_version: 1,
  node_id: "worker-test",
  database_path: path.join(root, "state.sqlite"),
  artifact_root: path.join(root, "artifacts"),
  inbox_root: path.join(root, "inbox"),
  outbox_root: path.join(root, "outbox"),
  audit_root: path.join(root, "audit"),
  local_control: { enabled: false },
  training: {
    allow_start: true,
    allow_stop: true,
    allow_package: true,
    start_script: adapter,
    stop_script: adapter,
    package_script: adapter,
  },
  lora_automation: {
    scheduler_root: schedulerRoot,
    scheduler_jobs_path: schedulerJobs,
    scheduler_state_path: schedulerState,
    scheduler_queue_control_path: path.join(schedulerRoot, "queue-control.json"),
    scheduler_job_control_root: schedulerControls,
  },
}, null, 2));

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs");
const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    HAWKSPAN_STATE_DIR: root,
    HAWKSPAN_CALL_ORIGIN: "peer",
    HAWKSPAN_PS: fakePs,
  },
  stdio: ["pipe", "pipe", "inherit"],
});
let sequence = 0;
let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) {
      pending.delete(response.id);
      waiter(response);
    }
  }
});
function request(method, params = {}) {
  const id = ++sequence;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, 10000);
  });
}
const tool = (name, args = {}) => request("tools/call", { name, arguments: args });
await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

const queuedPauseJob = await tool("create_job", {
  kind: "training",
  title: "Queued pause and resume test",
  metadata: { target: "queued-pause-test" },
});
const queuedPauseJobId = queuedPauseJob.result.structuredContent.job_id;
await tool("update_job_status", { job_id: queuedPauseJobId, state: "queued" });
fs.writeFileSync(schedulerJobs, `${JSON.stringify({
  schema_version: 2,
  jobs: [{
    job_id: "queue-queued-pause-test",
    target: "queued-pause-test",
    authorization_job_id: queuedPauseJobId,
    revision_fingerprint: "b".repeat(64),
    authorized: true,
    priority: 20,
  }],
}, null, 2)}\n`);
const refusedReadyQueuedResume = await tool("trainer_queue_control", {
  action: "resume-job",
  target: "queued-pause-test",
  reason: "must not resume an already-ready queued job",
});
assert.equal(refusedReadyQueuedResume.result.isError, true);
assert.match(refusedReadyQueuedResume.result.content[0].text, /job state queued is not allowed/);
const pausedQueuedJob = await tool("trainer_queue_control", {
  action: "pause-job",
  target: "queued-pause-test",
  reason: "exercise queued pause",
});
assert.equal(pausedQueuedJob.result.isError, false, pausedQueuedJob.result.content?.[0]?.text);
const resumedQueuedJob = await tool("trainer_queue_control", {
  action: "resume-job",
  target: "queued-pause-test",
  reason: "exercise queued resume",
});
assert.equal(resumedQueuedJob.result.isError, false, resumedQueuedJob.result.content?.[0]?.text);
assert.equal(resumedQueuedJob.result.structuredContent.authorization_job_id, queuedPauseJobId);
const queuedPauseState = JSON.parse(fs.readFileSync(schedulerState, "utf8"));
assert.equal(queuedPauseState.jobs["queue-queued-pause-test"].state, "queued");
let queuedPauseJobs = await tool("list_jobs", { job_id: queuedPauseJobId });
assert.equal(queuedPauseJobs.result.structuredContent[0].state, "queued");
const refusedSecondQueuedResume = await tool("trainer_queue_control", {
  action: "resume-job",
  target: "queued-pause-test",
  reason: "must not resume twice",
});
assert.equal(refusedSecondQueuedResume.result.isError, true);
assert.match(refusedSecondQueuedResume.result.content[0].text, /job state queued is not allowed/);

const jobId = "job-delegated-training-test";
const context = {
  id: jobId,
  created_at: "2026-08-04T00:00:00.000Z",
  updated_at: "2026-08-04T00:01:00.000Z",
  creator: "controller-test",
  assignee: "worker-test",
  kind: "training",
  title: "Delegated training lifecycle",
  description: "Exact identity must cross the peer boundary.",
  state: "authorized",
  authorization_state: "recorded",
  authorization_evidence: "Active user instruction.",
  metadata: { target: "robot-test" },
};

const started = await tool("trainer_start_authorized_job", {
  job_id: jobId,
  target: "robot-test",
  expected_revision_fingerprint: "a".repeat(64),
  _delegated_job: context,
});
assert.equal(started.result.isError, false, started.result.content?.[0]?.text);
assert.match(fs.readFileSync(invocationLog, "utf8"), new RegExp(`--job-id ${jobId}.*--target robot-test`));
let jobs = await tool("list_jobs");
assert.equal(jobs.result.structuredContent[0].id, jobId);
assert.equal(jobs.result.structuredContent[0].creator, "controller-test");

const stopped = await tool("trainer_stop_authorized_job", {
  job_id: jobId,
  target: "robot-test",
  _delegated_job: { ...context, state: "running" },
});
assert.equal(stopped.result.isError, false, stopped.result.content?.[0]?.text);
assert.equal(stopped.result.structuredContent.queue_control.state, "paused");
jobs = await tool("list_jobs", { job_id: jobId });
assert.equal(jobs.result.structuredContent[0].state, "paused");
assert.equal(jobs.result.structuredContent[0].metadata.phase, "stopped");

fs.writeFileSync(schedulerJobs, `${JSON.stringify({
  schema_version: 2,
  jobs: [{
    job_id: "queue-robot-test",
    target: "robot-test",
    authorization_job_id: jobId,
    revision_fingerprint: "revision-robot-test",
    authorized: true,
    priority: 10,
  }],
}, null, 2)}\n`);

const refusedUnboundResume = await tool("trainer_start_authorized_job", {
  job_id: jobId,
  target: "robot-test",
  expected_revision_fingerprint: "a".repeat(64),
});
assert.equal(refusedUnboundResume.result.isError, true);
assert.match(refusedUnboundResume.result.content[0].text, /job state paused is not allowed/);
const refusedUnrecordedResume = await tool("trainer_queue_control", {
  action: "resume-job",
  target: "robot-test",
});
assert.equal(refusedUnrecordedResume.result.isError, true);
assert.match(refusedUnrecordedResume.result.content[0].text, /requires a reason/);
const controlsBackup = `${schedulerControls}.backup`;
fs.renameSync(schedulerControls, controlsBackup);
fs.writeFileSync(schedulerControls, "blocks scheduler control write\n");
const failedSchedulerMutation = await tool("trainer_queue_control", {
  action: "resume-job",
  target: "robot-test",
  reason: "force scheduler mutation failure",
});
assert.equal(failedSchedulerMutation.result.isError, true);
fs.unlinkSync(schedulerControls);
fs.renameSync(controlsBackup, schedulerControls);
jobs = await tool("list_jobs", { job_id: jobId });
assert.equal(
  jobs.result.structuredContent[0].state,
  "paused",
  "failed scheduler mutation must roll the durable authorization back",
);
const resumedEligibility = await tool("trainer_queue_control", {
  action: "resume-job",
  target: "robot-test",
  reason: "explicit bounded-test resume",
});
assert.equal(resumedEligibility.result.isError, false, resumedEligibility.result.content?.[0]?.text);
assert.equal(resumedEligibility.result.structuredContent.authorization_job_id, jobId);
const resumed = await tool("trainer_start_authorized_job", {
  job_id: jobId,
  target: "robot-test",
  expected_revision_fingerprint: "a".repeat(64),
});
assert.equal(resumed.result.isError, false, resumed.result.content?.[0]?.text);
assert.match(fs.readFileSync(invocationLog, "utf8"), /--expected-revision-fingerprint a{64}/);
jobs = await tool("list_jobs", { job_id: jobId });
assert.equal(jobs.result.structuredContent[0].state, "running");

const schedulerControlBeforeInvalidResume = fs.readFileSync(
  path.join(schedulerControls, "robot-test.json"), "utf8",
);
const invalidSecondResume = await tool("trainer_queue_control", {
  action: "resume-job",
  target: "robot-test",
  reason: "must be rejected before scheduler mutation",
});
assert.equal(invalidSecondResume.result.isError, true);
assert.match(invalidSecondResume.result.content[0].text, /job state running is not allowed/);
assert.equal(
  fs.readFileSync(path.join(schedulerControls, "robot-test.json"), "utf8"),
  schedulerControlBeforeInvalidResume,
);

fs.writeFileSync(schedulerJobs, `${JSON.stringify({
  schema_version: 2,
  jobs: [{
    job_id: "queue-robot-test",
    target: "robot-test",
    authorization_job_id: jobId,
    revision_fingerprint: "revision-robot-test",
    authorized: true,
    priority: 10,
  }],
}, null, 2)}\n`);
fs.writeFileSync(schedulerState, `${JSON.stringify({
  schema_version: 1,
  current: "robot-test",
  jobs: { "queue-robot-test": { state: "running", phase: "training", attempts: 1 } },
}, null, 2)}\n`);
fs.writeFileSync(path.join(schedulerControls, "robot-test.json"), `${JSON.stringify({
  schema_version: 1,
  target: "robot-test",
  state: "running",
  authorization_job_id: jobId,
}, null, 2)}\n`);
const pausedQueue = await tool("trainer_queue_control", {
  action: "pause-queue",
  reason: "bounded whole-queue test",
});
assert.equal(pausedQueue.result.isError, false, pausedQueue.result.content?.[0]?.text);
assert.equal(pausedQueue.result.structuredContent.state, "paused");
assert.equal(pausedQueue.result.structuredContent.stopped_jobs.length, 1);
jobs = await tool("list_jobs", { job_id: jobId });
assert.equal(jobs.result.structuredContent[0].state, "paused");
assert.equal(
  JSON.parse(fs.readFileSync(path.join(schedulerControls, "robot-test.json"))).state,
  "paused",
);
const resumedQueue = await tool("trainer_queue_control", {
  action: "resume-queue",
  reason: "bounded whole-queue test complete",
});
assert.equal(resumedQueue.result.isError, false, resumedQueue.result.content?.[0]?.text);
assert.equal(resumedQueue.result.structuredContent.state, "running");
jobs = await tool("list_jobs", { job_id: jobId });
assert.equal(jobs.result.structuredContent[0].state, "paused");

const mismatch = await tool("trainer_stop_authorized_job", {
  job_id: jobId,
  target: "robot-test",
  _delegated_job: { ...context, id: "job-wrong-id", state: "running" },
});
assert.equal(mismatch.result.isError, true);
assert.match(mismatch.result.content[0].text, /identity does not match/);

const packageJobId = "job-delegated-package-test";
const refusedPackageTargetDrift = await tool("trainer_package_authorized_job", {
  job_id: packageJobId,
  target: "different-target",
  expected_revision_fingerprint: "a".repeat(64),
  _delegated_job: {
    ...context,
    id: packageJobId,
    state: "returning",
    metadata: {
      target: "robot-test",
      phase: "awaiting-validation",
      revision_fingerprint: "a".repeat(64),
    },
  },
});
assert.equal(refusedPackageTargetDrift.result.isError, true);
assert.match(refusedPackageTargetDrift.result.content[0].text, /must match durable training target/);
const returningReplay = await tool("update_job_status", {
  job_id: packageJobId,
  state: "returning",
  metadata: {
    phase: "awaiting-validation",
    target: "robot-test",
    revision_fingerprint: "a".repeat(64),
  },
});
assert.equal(returningReplay.result.isError, false, returningReplay.result.content?.[0]?.text);
const packaged = await tool("trainer_package_authorized_job", {
  job_id: packageJobId,
  target: "robot-test",
  expected_revision_fingerprint: "a".repeat(64),
  _delegated_job: {
    ...context,
    id: packageJobId,
    state: "returning",
    metadata: {
      target: "robot-test",
      phase: "awaiting-validation",
      revision_fingerprint: "a".repeat(64),
    },
  },
});
assert.equal(packaged.result.isError, false, packaged.result.content?.[0]?.text);
assert.match(
  fs.readFileSync(invocationLog, "utf8"),
  new RegExp(
    `--job-id ${packageJobId}.*--target robot-test.*--expected-revision-fingerprint ${"a".repeat(64)}`,
  ),
);

const retryPackageJobId = "job-delegated-package-retry-test";
const retriedPackage = await tool("trainer_package_authorized_job", {
  job_id: retryPackageJobId,
  target: "robot-test",
  expected_revision_fingerprint: "b".repeat(64),
  _delegated_job: {
    ...context,
    id: retryPackageJobId,
    state: "failed",
    metadata: {
      target: "robot-test",
      phase: "package_return",
      revision_fingerprint: "b".repeat(64),
    },
  },
});
assert.equal(retriedPackage.result.isError, false, retriedPackage.result.content?.[0]?.text);
jobs = await tool("list_jobs", { job_id: retryPackageJobId });
assert.equal(jobs.result.structuredContent[0].state, "running");
assert.equal(jobs.result.structuredContent[0].metadata.phase, "package_return");
assert.equal(jobs.result.structuredContent[0].metadata.package_retry_state, "running");

const refusedDriftedPackage = await tool("trainer_package_authorized_job", {
  job_id: packageJobId,
  target: "robot-test",
  expected_revision_fingerprint: "c".repeat(64),
});
assert.equal(refusedDriftedPackage.result.isError, true);
assert.match(
  refusedDriftedPackage.result.content[0].text,
  /must match the revision recorded at training start/,
);

const preservedPackageJobId = "job-delegated-package-preserve-test";
const seededPackageFailure = await tool("trainer_package_authorized_job", {
  job_id: preservedPackageJobId,
  target: "robot-test",
  expected_revision_fingerprint: "d".repeat(64),
  _delegated_job: {
    ...context,
    id: preservedPackageJobId,
    state: "failed",
    metadata: {
      target: "robot-test",
      phase: "package_return",
      revision_fingerprint: "e".repeat(64),
    },
  },
});
assert.equal(seededPackageFailure.result.isError, true);
const preservedPackageRetry = await tool("trainer_package_authorized_job", {
  job_id: preservedPackageJobId,
  target: "robot-test",
  expected_revision_fingerprint: "e".repeat(64),
  _delegated_job: {
    ...context,
    id: preservedPackageJobId,
    state: "running",
    metadata: { target: "robot-test", phase: "training" },
  },
});
assert.equal(
  preservedPackageRetry.result.isError,
  false,
  preservedPackageRetry.result.content?.[0]?.text,
);
jobs = await tool("list_jobs", { job_id: preservedPackageJobId });
assert.equal(jobs.result.structuredContent[0].metadata.revision_fingerprint, "e".repeat(64));

child.stdin.end();
await new Promise((resolve) => child.once("exit", resolve));
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("delegated trainer job tests passed\n");
