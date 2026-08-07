#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-test-"));
const testQueue = path.join(testRoot, "queue");
const testLogs = path.join(testRoot, "logs");
const testControl = path.join(testRoot, "trainer-control");
const testPreservation = path.join(testRoot, "preserved");
const testOutput = path.join(testRoot, "output", "cap-test-sdxl-lora");
const testSimpleTuner = path.join(testRoot, "simpletuner");
const testRevisionDataset = path.join(testRoot, "revision-source");
const testConditioning = path.join(testRoot, "conditioning");
fs.mkdirSync(testQueue, { recursive: true });
fs.mkdirSync(path.join(testQueue, "logs"), { recursive: true });
fs.mkdirSync(testLogs, { recursive: true });
fs.mkdirSync(testControl, { recursive: true });
fs.mkdirSync(testPreservation, { recursive: true });
fs.mkdirSync(path.join(testOutput, "checkpoint-400"), { recursive: true });
fs.mkdirSync(testRevisionDataset, { recursive: true });
fs.mkdirSync(testConditioning, { recursive: true });
const preservedCheckpoint = path.join(testOutput, "PRESERVED_CHECKPOINTS", "checkpoint-200");
fs.mkdirSync(preservedCheckpoint, { recursive: true });
for (const name of [
  "pytorch_lora_weights.safetensors",
  "optimizer.bin",
  "scheduler.bin",
]) {
  fs.writeFileSync(path.join(preservedCheckpoint, name), `${name}\n`);
}
fs.writeFileSync(
  path.join(preservedCheckpoint, "training_state.json"),
  `${JSON.stringify({ global_step: 200 })}\n`,
);
fs.mkdirSync(path.join(testSimpleTuner, ".venv", "bin"), { recursive: true });
fs.writeFileSync(
  path.join(testSimpleTuner, ".venv", "bin", "python"),
  "#!/bin/sh\nprintf '{\"python\":\"test\",\"platform\":\"test\",\"torch\":\"test\",\"mps_built\":true,\"mps_available\":true}\\n'\n",
  { mode: 0o755 },
);
fs.writeFileSync(path.join(testQueue, "sample.jpg"), "not-a-real-image");
fs.writeFileSync(path.join(testQueue, "sample.txt"), "structured adult caption\n");
fs.writeFileSync(
  path.join(testRevisionDataset, "revision.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5Z8AAAAASUVORK5CYII=",
    "base64",
  ),
);
fs.writeFileSync(
  path.join(testRevisionDataset, "revision.txt"),
  [
    "Subject: synthetic test identity;",
    "Pose: neutral standing pose;",
    "Setting: plain studio;",
    "Appearance: synthetic fixture;",
    "Camera/Crop: full body;",
    "Details: deterministic fixture.",
  ].join(" "),
);
fs.writeFileSync(
  path.join(testQueue, "config.json"),
  `${JSON.stringify({
    pretrained_model_name_or_path: "test-model",
    max_train_steps: 1200,
    checkpoint_step_interval: 200,
    validation_prompt: "fixed adult validation prompt",
  })}\n`,
);
fs.writeFileSync(
  path.join(testQueue, "multidatabackend.json"),
  `${JSON.stringify([{ id: "test", instance_data_dir: testQueue }])}\n`,
);
const validationPromptIds = [
  "subject-wide",
  "subject-angle",
  "subject-detail",
  "subject-context",
];
for (const id of validationPromptIds) {
  fs.writeFileSync(path.join(testConditioning, `${id}.png`), `control ${id}\n`);
}
fs.writeFileSync(
  path.join(testQueue, "validation-prompts.json"),
  `${JSON.stringify({
    schema_version: 1,
    fixed_settings: {
      seeds: [1234, 5678],
      base_model: "test-model",
      width: 1024,
      height: 1024,
      steps: 25,
      sampler: "test-sampler",
      guidance_scale: 5,
      lora_weight: 0.7,
      controlnet: {
        model: "synthetic-controlnet",
        mode: "balanced",
        weight: 1,
        start: 0,
        end: 1,
      },
    },
    controls_are_relative_to: "dataset",
    prompts: validationPromptIds.map((id) => ({
      id,
      prompt: `test, ${id}`,
      control_image: `conditioning/${id}.png`,
    })),
  })}\n`,
);
fs.writeFileSync(
  path.join(testQueue, "lora-queue-policy.json"),
  `${JSON.stringify({
    schema_version: 1,
    priorities: { "cap-test": 5, "cap-complete": 10 },
  })}\n`,
);
fs.writeFileSync(
  path.join(testOutput, "pytorch_lora_weights.safetensors"),
  "synthetic-final-lora\n",
);
fs.writeFileSync(
  path.join(testOutput, "checkpoint-400", "pytorch_lora_weights.safetensors"),
  "synthetic-checkpoint-lora\n",
);
fs.writeFileSync(path.join(testLogs, "trainer.log"), "step 1\nstep 2\n");
fs.writeFileSync(
  path.join(testLogs, "cap-test.log"),
  "\u001b[0mEpoch 5/10 Steps:  50%|#####| 500/1000 [10:00<10:00, 1.20s/it, lr=0.0001, step_loss=0.125]\u001b[0m\n",
);
fs.copyFileSync(
  path.join(testLogs, "cap-test.log"),
  path.join(testQueue, "logs", "cap-test.log"),
);
fs.writeFileSync(
  path.join(testQueue, "captioned-lora-manifest.json"),
  `${JSON.stringify([{
    index: 1,
    job_id: "cap-test",
    source: "Test",
    image_count: 1,
    caption_count: 1,
    trigger: "test",
    data_dir: testQueue,
    conditioning_dir: testConditioning,
    config_dir: testQueue,
    output_dir: testOutput,
  }, {
    index: 2,
    job_id: "cap-complete",
    source: "Completed Test",
    image_count: 1,
    caption_count: 1,
    trigger: "test-complete",
    data_dir: testQueue,
    config_dir: testQueue,
    output_dir: testOutput,
  }])}\n`,
);
fs.writeFileSync(
  path.join(testQueue, "captioned-lora-status.json"),
  `${JSON.stringify({
    batch: "test-batch",
    total: 2,
    current: "cap-test",
    completed: [{ job_id: "cap-complete", completed_at: "2026-07-25T00:00:00Z" }],
    failed: [],
  })}\n`,
);
fs.writeFileSync(
  path.join(testQueue, "job-config.json"),
  `${JSON.stringify({ checkpoints_total_limit: 10 })}\n`,
);
const fakeTrainerStart = path.join(testRoot, "trainer-start.sh");
const schedulerRoot = path.join(testRoot, "lora-scheduler");
const schedulerJobsPath = path.join(schedulerRoot, "lora-jobs.json");
const schedulerStatePath = path.join(schedulerRoot, "lora-scheduler-state.json");
const schedulerJobControlRoot = path.join(schedulerRoot, "jobs");
fs.mkdirSync(path.dirname(schedulerJobsPath), { recursive: true });
fs.mkdirSync(schedulerJobControlRoot, { recursive: true });
fs.writeFileSync(schedulerJobsPath, JSON.stringify({
  schema_version: 2,
  jobs: [{
    job_id: "scheduler-cap-test",
    target: "cap-test",
    authorization_job_id: "job-cap-test",
    revision_fingerprint: "scheduler-revision",
    authorized: true,
  }],
}));
fs.writeFileSync(schedulerStatePath, JSON.stringify({
  schema_version: 1,
  current: null,
  jobs: { "scheduler-cap-test": { state: "queued", phase: "queued", attempts: 0 } },
}));
fs.writeFileSync(fakeTrainerStart, "#!/bin/sh\nprintf 'started\\n'\n", { mode: 0o755 });
fs.writeFileSync(path.join(testRoot, "config.json"), JSON.stringify({
  schema_version: 1,
  node_id: "test-node",
  peer: {
    primary_host: "192.0.2.10",
    fallback_host: "198.51.100.10",
    primary_enabled: false,
    fallback_enabled: false,
  },
  training: {
    process_match: "test-mcp\\.mjs",
    queue_root: testQueue,
    log_root: testLogs,
    control_root: testControl,
    allow_start: true,
    start_script: fakeTrainerStart,
    allow_stop: false,
    allow_package: false,
    minimum_checkpoint_retention: 10,
    preservation_root: testPreservation,
  },
  queue_supervisor: {
    item_lease_ms: 1200,
    max_items_per_worker: 10,
  },
  lora_automation: {
    simpletuner_root: testSimpleTuner,
    queue_root: testQueue,
    output_root: path.join(testRoot, "output"),
    preservation_root: path.join(testRoot, "output"),
    manifest_root: path.join(testRoot, "automation-manifests"),
    registry_path: path.join(testRoot, "lora-registry.json"),
    revision_root: path.join(testRoot, "revisions"),
    validation_queue_root: path.join(testRoot, "validation-queue"),
    queue_policy_path: path.join(testQueue, "lora-queue-policy.json"),
    scheduler_root: schedulerRoot,
    scheduler_jobs_path: schedulerJobsPath,
    scheduler_state_path: schedulerStatePath,
    scheduler_job_control_root: schedulerJobControlRoot,
  },
}, null, 2));
const serverPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "mcp-server.mjs",
);
const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, HAWKSPAN_STATE_DIR: testRoot },
  stdio: ["pipe", "pipe", "inherit"],
});

let sequence = 0;
const pending = new Map();
let buffer = "";

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
      waiter.resolve(response);
    }
  }
});

function request(method, params = {}) {
  const id = ++sequence;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, 10000);
  });
}

function tool(name, args = {}) {
  return request("tools/call", { name, arguments: args });
}

const initialized = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "hawkspan-test", version: "1" },
});
assert.equal(initialized.result.serverInfo.name, "hawkspan");

const listed = await request("tools/list");
const names = new Set(listed.result.tools.map((entry) => entry.name));
const listedByName = new Map(
  listed.result.tools.map((entry) => [entry.name, entry]),
);
for (const routineIpcTool of [
  "send_message",
  "retry_message",
  "wake_peer_thread",
  "acknowledge_message",
  "flush_outbox",
  "peer_call_tool",
  "trainer_queue_control",
  "trainer_start_authorized_job",
  "trainer_stop_authorized_job",
  "trainer_package_authorized_job",
]) {
  assert.equal(
    listedByName.get(routineIpcTool)?.annotations?.readOnlyHint,
    true,
    `${routineIpcTool} must not trigger per-message write approval`,
  );
  assert.equal(
    listedByName.get(routineIpcTool)?.annotations?.destructiveHint,
    false,
  );
}
for (const required of [
  "link_status",
  "run_command",
  "peer_call_tool",
  "send_message",
  "retry_message",
  "wake_peer_thread",
  "receive_messages",
  "list_messages",
  "acknowledge_message",
  "create_job",
  "update_job_status",
  "list_jobs",
  "register_artifact",
  "verify_artifact",
  "send_artifact",
  "queue_artifact_delivery",
  "list_artifacts",
  "receive_artifacts",
  "flush_outbox",
  "list_audit_events",
  "list_queue_adapters",
  "create_queue",
  "configure_queue",
  "delete_queue",
  "list_queues",
  "queue_status",
  "enqueue_queue_item",
  "enqueue_queue_batch",
  "queue_control",
  "start_next_queue_item",
  "supervise_queue",
  "trainer_status",
  "trainer_run_status",
  "trainer_queue_detail",
  "trainer_queue_status",
  "trainer_validate_dataset",
  "trainer_tail_log",
  "trainer_audit_checkpoint_retention",
  "trainer_preservation_status",
  "trainer_start_authorized_job",
  "trainer_stop_authorized_job",
  "trainer_package_authorized_job",
  "lora_automation",
]) {
  assert(names.has(required), `missing tool ${required}`);
}

const adapters = await tool("list_queue_adapters");
assert.equal(adapters.result.isError, false);
assert(adapters.result.structuredContent.adapters.some((entry) => entry.adapter === "message"));
assert(adapters.result.structuredContent.adapters.some((entry) => entry.adapter === "artifact"));
assert(adapters.result.structuredContent.adapters.some((entry) => entry.adapter === "command"));
assert(adapters.result.structuredContent.adapters.some((entry) => entry.adapter === "tool:list_jobs"));
assert(!adapters.result.structuredContent.adapters.some(
  (entry) => entry.adapter === "tool:trainer_start_authorized_job",
));

const outboxPath = path.join(testRoot, "outbox");
const outboundBeforeRejectedBatch = await tool("list_messages", { direction: "outbound" });
const outboxBeforeRejectedBatch = fs.readdirSync(outboxPath).sort();
const rejectedMessageBatch = await tool("enqueue_queue_batch", {
  queue_id: "hawkspan-messages",
  items: [
    {
      item_id: "atomic-message-valid",
      payload: { subject: "must roll back", body: "must roll back" },
    },
    {
      item_id: "atomic-message-invalid",
      payload: { subject: "missing body must reject batch" },
    },
  ],
});
assert.equal(rejectedMessageBatch.result.isError, true);
const outboundAfterRejectedBatch = await tool("list_messages", { direction: "outbound" });
assert.equal(
  outboundAfterRejectedBatch.result.structuredContent.length,
  outboundBeforeRejectedBatch.result.structuredContent.length,
);
assert.deepEqual(fs.readdirSync(outboxPath).sort(), outboxBeforeRejectedBatch);
const messageQueueAfterRejectedBatch = await tool("queue_status", {
  queue_id: "hawkspan-messages",
});
assert.equal(
  messageQueueAfterRejectedBatch.result.structuredContent.items.some(
    (item) => item.item_id.startsWith("atomic-message-"),
  ),
  false,
);

const faultDb = new DatabaseSync(path.join(testRoot, "spool.sqlite3"));
faultDb.exec(`
  CREATE TRIGGER reject_message_send_audit
  BEFORE INSERT ON audit_events
  WHEN NEW.action = 'send'
  BEGIN
    SELECT RAISE(ABORT, 'injected message audit failure');
  END;
`);
const outboxBeforeAuditFailure = fs.readdirSync(outboxPath).sort();
const outboundBeforeAuditFailure = await tool("list_messages", { direction: "outbound" });
const auditFailureBatch = await tool("enqueue_queue_batch", {
  queue_id: "hawkspan-messages",
  items: [{
    item_id: "atomic-message-audit-failure",
    payload: { subject: "audit failure rollback", body: "audit failure rollback" },
  }],
});
assert.equal(auditFailureBatch.result.isError, true);
assert.match(auditFailureBatch.result.content[0].text, /injected message audit failure/);
faultDb.exec("DROP TRIGGER reject_message_send_audit");
faultDb.close();
assert.deepEqual(fs.readdirSync(outboxPath).sort(), outboxBeforeAuditFailure);
const outboundAfterAuditFailure = await tool("list_messages", { direction: "outbound" });
assert.equal(
  outboundAfterAuditFailure.result.structuredContent.length,
  outboundBeforeAuditFailure.result.structuredContent.length,
);
const messageQueueAfterAuditFailure = await tool("queue_status", { queue_id: "hawkspan-messages" });
assert.equal(
  messageQueueAfterAuditFailure.result.structuredContent.items.some(
    (item) => item.item_id === "atomic-message-audit-failure",
  ),
  false,
);

const commandQueue = await tool("create_queue", {
  queue_id: "test-command-queue",
  kind: "application",
  adapter: "command",
  concurrency: 2,
  retry_delays_ms: [100],
});
assert.equal(commandQueue.result.isError, false);
const commandBatch = await tool("enqueue_queue_batch", {
  queue_id: "test-command-queue",
  items: [{
    item_id: "command-success",
    priority: 10,
    payload: { command: "/usr/bin/true", cwd: testRoot },
  }, {
    item_id: "command-retry",
    priority: 20,
    payload: { command: "/usr/bin/false", cwd: testRoot },
  }],
});
assert.equal(commandBatch.result.isError, false);
const commandSupervision = await tool("supervise_queue", {
  queue_id: "test-command-queue",
  worker_id: "test-command-worker",
  max_items: 2,
});
assert.equal(commandSupervision.result.isError, false);
assert.equal(commandSupervision.result.structuredContent.outcomes[0].state, "completed");
assert.equal(commandSupervision.result.structuredContent.outcomes[1].state, "queued");

const heartbeatQueue = await tool("create_queue", {
  queue_id: "test-heartbeat-queue",
  kind: "application",
  adapter: "command",
});
assert.equal(heartbeatQueue.result.isError, false);
await tool("enqueue_queue_item", {
  queue_id: "test-heartbeat-queue",
  item_id: "slow-command",
  payload: { command: "sleep 2", cwd: testRoot, timeout_ms: 5000 },
});
const heartbeatSupervisionPromise = tool("supervise_queue", {
  queue_id: "test-heartbeat-queue",
  worker_id: "heartbeat-worker",
  max_items: 1,
});
await new Promise((resolve) => setTimeout(resolve, 1350));
const liveHeartbeatStatus = await tool("queue_status", {
  queue_id: "test-heartbeat-queue",
});
const liveHeartbeatItem = liveHeartbeatStatus.result.structuredContent.items.find(
  (item) => item.item_id === "slow-command",
);
assert.equal(liveHeartbeatItem.state, "running");
assert.equal(liveHeartbeatItem.lease_owner, "heartbeat-worker");
assert(
  Date.parse(liveHeartbeatItem.lease_expires_at) > Date.now(),
  "lease must be renewed while the asynchronous adapter is still running",
);
const heartbeatSupervision = await heartbeatSupervisionPromise;
assert.equal(heartbeatSupervision.result.isError, false);
assert.equal(heartbeatSupervision.result.structuredContent.outcomes[0].state, "completed");

const toolQueue = await tool("create_queue", {
  queue_id: "test-tool-queue",
  kind: "application",
  adapter: "tool:list_jobs",
});
assert.equal(toolQueue.result.isError, false);
await tool("enqueue_queue_item", {
  queue_id: "test-tool-queue",
  item_id: "list-jobs-once",
  payload: { limit: 1 },
});
const toolSupervision = await tool("start_next_queue_item", {
  queue_id: "test-tool-queue",
  worker_id: "test-tool-worker",
});
assert.equal(toolSupervision.result.isError, false);
assert.equal(toolSupervision.result.structuredContent.outcomes[0].state, "completed");

const rejectedDuplicateTrainerQueue = await tool("create_queue", {
  queue_id: "test-trainer-start-queue",
  kind: "application",
  adapter: "tool:trainer_start_authorized_job",
});
assert.equal(rejectedDuplicateTrainerQueue.result.isError, true);
assert.match(
  rejectedDuplicateTrainerQueue.result.content[0].text,
  /single durable SimpleTuner scheduler/,
);

const queuedFile = path.join(testRoot, "queued-file.txt");
fs.writeFileSync(queuedFile, "queued file\n");
const fileItem = await tool("enqueue_queue_item", {
  queue_id: "hawkspan-artifacts",
  item_id: "queued-file",
  payload: { path: queuedFile, name: "queued-file.txt" },
});
assert.equal(fileItem.result.isError, false);
assert.match(fileItem.result.structuredContent.item.payload.artifact_id, /^artifact-/);

const queues = await tool("list_queues");
assert.equal(queues.result.isError, false);
assert(queues.result.structuredContent.queues.some((queue) => queue.queue_id === "hawkspan-messages"));
assert(queues.result.structuredContent.queues.some((queue) => queue.queue_id === "hawkspan-artifacts"));
assert(queues.result.structuredContent.queues.some((queue) => queue.queue_id === "test-command-queue"));

const cleared = await tool("queue_control", {
  queue_id: "test-command-queue",
  action: "clear-pending",
  reason: "test cleanup",
});
assert.equal(cleared.result.isError, false);
assert.equal(cleared.result.structuredContent.cleared, 1);
const loraAutomationTool = listed.result.tools.find(
  (entry) => entry.name === "lora_automation",
);
for (const requiredAction of [
  "training-readiness",
  "prepare-versioned-job",
  "scheduler-enqueue",
  "stage-runtime-job",
  "draw-things-plan",
  "draw-things-ingest",
]) {
  assert(
    loraAutomationTool.inputSchema.properties.action.enum.includes(requiredAction),
    `missing LoRA automation action ${requiredAction}`,
  );
}

const unauthorizedSchedulerEnqueue = await tool("lora_automation", {
  action: "scheduler-enqueue",
  job_id: "cap-test",
  scheduler_job_id: "scheduler-cap-test",
  authorization_job_id: "missing-authorization",
  revision_fingerprint: "a".repeat(64),
});
assert.equal(unauthorizedSchedulerEnqueue.result.isError, true);

const wrongKindSchedulerJob = await tool("create_job", {
  kind: "simpletuner-lora",
  title: "Wrong scheduler authorization kind",
  metadata: { target: "cap-test" },
});
await tool("update_job_status", {
  job_id: wrongKindSchedulerJob.result.structuredContent.job_id,
  state: "queued",
});
const wrongKindSchedulerEnqueue = await tool("lora_automation", {
  action: "scheduler-enqueue",
  job_id: "cap-test",
  scheduler_job_id: "scheduler-cap-test-wrong-kind",
  authorization_job_id: wrongKindSchedulerJob.result.structuredContent.job_id,
  revision_fingerprint: "a".repeat(64),
});
assert.equal(wrongKindSchedulerEnqueue.result.isError, true);
assert.match(wrongKindSchedulerEnqueue.result.content[0].text, /job kind must be training/);

const retryControlJob = await tool("create_job", {
  kind: "training",
  title: "Queued skip and retry contract",
  metadata: { target: "cap-retry-control" },
});
await tool("update_job_status", {
  job_id: retryControlJob.result.structuredContent.job_id,
  state: "queued",
});
const schedulerDocument = JSON.parse(fs.readFileSync(schedulerJobsPath, "utf8"));
schedulerDocument.jobs.push({
  job_id: "scheduler-cap-retry-control",
  target: "cap-retry-control",
  authorization_job_id: retryControlJob.result.structuredContent.job_id,
  revision_fingerprint: "b".repeat(64),
  authorized: true,
  priority: 20,
});
fs.writeFileSync(schedulerJobsPath, JSON.stringify(schedulerDocument));
const schedulerState = JSON.parse(fs.readFileSync(schedulerStatePath, "utf8"));
schedulerState.jobs["scheduler-cap-retry-control"] = {
  state: "queued", phase: "queued", attempts: 0,
};
fs.writeFileSync(schedulerStatePath, JSON.stringify(schedulerState));
const skippedQueuedJob = await tool("trainer_queue_control", {
  action: "skip-job",
  target: "cap-retry-control",
  reason: "real queue-control regression",
});
assert.equal(skippedQueuedJob.result.isError, false);
assert.equal(skippedQueuedJob.result.structuredContent.state, "skipped");
const retriedQueuedJob = await tool("trainer_queue_control", {
  action: "retry-job",
  target: "cap-retry-control",
  reason: "same immutable queued job is eligible again",
});
assert.equal(retriedQueuedJob.result.isError, false);
assert.equal(retriedQueuedJob.result.structuredContent.state, "ready");
assert.equal(
  JSON.parse(fs.readFileSync(schedulerStatePath, "utf8"))
    .jobs["scheduler-cap-retry-control"].state,
  "queued",
);
const retriedDurableJob = await tool("list_jobs", {
  job_id: retryControlJob.result.structuredContent.job_id,
});
assert.equal(retriedDurableJob.result.structuredContent[0].state, "queued");

const automationQueue = await tool("lora_automation", { action: "queue" });
assert.equal(automationQueue.result.isError, false);
assert.deepEqual(
  automationQueue.result.structuredContent.jobs.map((entry) => entry.job_id),
  ["cap-test", "cap-complete"],
);
assert.deepEqual(
  automationQueue.result.structuredContent.jobs.map((entry) => entry.priority),
  [5, 10],
);

const automationEstimate = await tool("lora_automation", {
  action: "estimate",
  job_id: "cap-test",
});
assert.equal(automationEstimate.result.isError, false);
assert.equal(automationEstimate.result.structuredContent.job_id, "cap-test");
const automationComparison = await tool("lora_automation", {
  action: "compare",
  job_id: "cap-test",
});
assert.deepEqual(
  automationComparison.result.structuredContent.checkpoints.map((entry) => entry.step),
  [200, 400],
);
assert.equal(
  automationComparison.result.structuredContent.checkpoints[0].source,
  "preserved",
);
const automationRecovery = await tool("lora_automation", {
  action: "recovery",
  job_id: "cap-test",
});
assert.equal(automationRecovery.result.structuredContent.recoverable, true);
assert.equal(automationRecovery.result.structuredContent.selected_checkpoint.step, 200);
const automationTelemetry = await tool("lora_automation", { action: "telemetry" });
assert.equal(automationTelemetry.result.structuredContent.active, true);
assert.equal(automationTelemetry.result.structuredContent.active_source, "process-list");

const automationInventory = await tool("lora_automation", { action: "inventory" });
assert.equal(automationInventory.result.isError, false);
assert.equal(
  automationInventory.result.structuredContent.simpletuner.environment.mps_available,
  true,
);
const automationRegistry = await tool("lora_automation", {
  action: "registry-refresh",
});
assert.equal(automationRegistry.result.structuredContent.revision_count, 2);
const validationLibraryPath = path.join(testQueue, "validation-prompts.json");
const completeValidationLibrary = fs.readFileSync(validationLibraryPath, "utf8");
const incompleteValidationLibrary = JSON.parse(completeValidationLibrary);
delete incompleteValidationLibrary.fixed_settings.sampler;
fs.writeFileSync(
  validationLibraryPath,
  `${JSON.stringify(incompleteValidationLibrary)}\n`,
);
const incompleteValidationPlan = await tool("lora_automation", {
  action: "validation-plan",
  job_id: "cap-test",
});
assert.equal(incompleteValidationPlan.result.isError, true);
assert.match(
  incompleteValidationPlan.result.content[0].text,
  /fixed_settings\.sampler must be a non-empty string/,
);
fs.writeFileSync(validationLibraryPath, completeValidationLibrary);
const automationValidationPlan = await tool("lora_automation", {
  action: "validation-plan",
  job_id: "cap-test",
});
assert.equal(automationValidationPlan.result.isError, false);
assert.equal(automationValidationPlan.result.structuredContent.plan.prompts.length, 4);
assert.equal(
  automationValidationPlan.result.structuredContent.plan.control_inputs_bound,
  true,
);
for (const prompt of automationValidationPlan.result.structuredContent.plan.prompts) {
  assert.equal(
    prompt.control_image_path,
    path.join(testConditioning, `${prompt.id}.png`),
  );
  assert.equal(prompt.control_image_sha256.length, 64);
}
assert.equal(
  automationValidationPlan.result.structuredContent.plan.state,
  "awaiting_m2_draw_things_render",
);
const validationResultPath = path.join(testRoot, "validation-result.json");
const validationImagePathFor = (promptId, seed) =>
  path.join(testRoot, `${promptId}--${seed}.png`);
const checkpoint400LoraPath = path.join(
  testOutput,
  "checkpoint-400",
  "pytorch_lora_weights.safetensors",
);
const checkpoint400LoraSha256 = crypto.createHash("sha256")
  .update(fs.readFileSync(checkpoint400LoraPath))
  .digest("hex");
for (const promptId of validationPromptIds) {
  for (const seed of [1234, 5678]) {
    fs.writeFileSync(
      validationImagePathFor(promptId, seed),
      `synthetic validation image ${promptId} ${seed}\n`,
    );
  }
}
fs.writeFileSync(
  validationResultPath,
  `${JSON.stringify({
    checkpoint: "checkpoint-400",
    validation_plan_path:
      automationValidationPlan.result.structuredContent.plan_path,
    validation_plan_sha256:
      automationValidationPlan.result.structuredContent.plan_sha256,
    lora_path: checkpoint400LoraPath,
    lora_sha256: checkpoint400LoraSha256,
    settings:
      automationValidationPlan.result.structuredContent.plan.fixed_settings,
    score: 8.5,
    renders: validationPromptIds.flatMap((promptId) => [1234, 5678].map((seed) => ({
        prompt_id: promptId,
        image_path: validationImagePathFor(promptId, seed),
        seed,
        live_metadata: {
          lora_weight: 0.7,
          settings: automationValidationPlan.result.structuredContent.plan.fixed_settings,
        },
        score: 8.5,
        notes: "synthetic validation",
      }))),
    notes: "synthetic result",
  })}\n`,
);
const wrongSeedResultPath = path.join(testRoot, "wrong-seed-validation-result.json");
const wrongSeedResult = JSON.parse(fs.readFileSync(validationResultPath, "utf8"));
wrongSeedResult.renders[0].seed = 9999;
fs.writeFileSync(wrongSeedResultPath, `${JSON.stringify(wrongSeedResult)}\n`);
const wrongSeedIngest = await tool("lora_automation", {
  action: "validation-ingest",
  job_id: "cap-test",
  result_path: wrongSeedResultPath,
});
assert.equal(wrongSeedIngest.result.isError, true);
const automationValidationIngest = await tool("lora_automation", {
  action: "validation-ingest",
  job_id: "cap-test",
  result_path: validationResultPath,
});
assert.equal(
  automationValidationIngest.result.structuredContent.recommended_checkpoint,
  "checkpoint-400",
);
const drawThingsPlanResult = await tool("lora_automation", {
  action: "draw-things-plan",
  job_id: "cap-test",
});
assert.equal(
  drawThingsPlanResult.result.isError,
  false,
  JSON.stringify(drawThingsPlanResult.result),
);
assert.equal(
  drawThingsPlanResult.result.structuredContent.plan.selected_checkpoint,
  "checkpoint-400",
);
assert.equal(
  drawThingsPlanResult.result.structuredContent.plan.import.expected_base_model,
  "test-model",
);
const drawThingsPlanDoc = drawThingsPlanResult.result.structuredContent.plan;
const drawThingsPlanPath = drawThingsPlanResult.result.structuredContent.plan_path;
const drawThingsPlanSha256 = drawThingsPlanResult.result.structuredContent.plan_sha256;
const drawThingsValidationPlan = JSON.parse(
  fs.readFileSync(drawThingsPlanDoc.validation_plan_path, "utf8"),
);
const drawThingsPromptsById = new Map(
  drawThingsValidationPlan.prompts.map((prompt) => [prompt.id, prompt]),
);
const drawThingsResultPath = path.join(testRoot, "draw-things-result.json");
const drawThingsResult = {
  import_succeeded: true,
  imported_name: "cap-test checkpoint-400",
  application_version: "test-version",
  base_model: "test-model",
  draw_things_plan_path: drawThingsPlanPath,
  draw_things_plan_sha256: drawThingsPlanSha256,
  checkpoint: drawThingsPlanDoc.selected_checkpoint,
  lora_path: drawThingsPlanDoc.lora_path,
  lora_sha256: drawThingsPlanDoc.lora_sha256,
  validation_plan_path: drawThingsPlanDoc.validation_plan_path,
  validation_plan_sha256: drawThingsPlanDoc.validation_plan_sha256,
  settings: drawThingsPlanDoc.validation_settings,
  score: 8.5,
  renders: validationPromptIds.flatMap((promptId) => [1234, 5678].map((seed) => ({
      prompt_id: promptId,
      image_path: validationImagePathFor(promptId, seed),
      seed,
      live_metadata: {
        lora_weight: 0.7,
        imported_name: "cap-test checkpoint-400",
        base_model: "test-model",
        settings: drawThingsPlanDoc.validation_settings,
        control: {
          input_sha256: drawThingsPromptsById.get(promptId).control_image_sha256,
          model: "synthetic-controlnet",
          mode: "balanced",
          weight: 1,
          start: 0,
          end: 1,
        },
      },
      score: 8.5,
      notes: "synthetic Draw Things render",
    }))),
  converted: false,
  notes: "synthetic direct import",
};
fs.writeFileSync(drawThingsResultPath, `${JSON.stringify(drawThingsResult)}\n`);
const unboundDrawThingsResultPath = path.join(testRoot, "unbound-draw-things-result.json");
fs.writeFileSync(
  unboundDrawThingsResultPath,
  `${JSON.stringify({ ...drawThingsResult, base_model: "wrong-model" })}\n`,
);
const unboundDrawThingsIngest = await tool("lora_automation", {
  action: "draw-things-ingest",
  job_id: "cap-test",
  result_path: unboundDrawThingsResultPath,
});
assert.equal(unboundDrawThingsIngest.result.isError, true);
assert.match(
  unboundDrawThingsIngest.result.content[0].text,
  /base_model differs from the bound Draw Things plan/,
);
const alternateLoraPath = path.join(testRoot, "alternate-lora.safetensors");
fs.writeFileSync(alternateLoraPath, "self-consistent but unselected LoRA\n");
const alternateLoraSha256 = crypto.createHash("sha256")
  .update(fs.readFileSync(alternateLoraPath))
  .digest("hex");
const alternateLoraResultPath = path.join(testRoot, "alternate-lora-result.json");
fs.writeFileSync(
  alternateLoraResultPath,
  `${JSON.stringify({
    ...drawThingsResult,
    lora_path: alternateLoraPath,
    lora_sha256: alternateLoraSha256,
  })}\n`,
);
const alternateLoraIngest = await tool("lora_automation", {
  action: "draw-things-ingest",
  job_id: "cap-test",
  result_path: alternateLoraResultPath,
});
assert.equal(alternateLoraIngest.result.isError, true);
assert.match(
  alternateLoraIngest.result.content[0].text,
  /LoRA differs from the bound Draw Things plan/,
);
const changedSettingsResultPath = path.join(testRoot, "changed-settings-result.json");
fs.writeFileSync(
  changedSettingsResultPath,
  `${JSON.stringify({
    ...drawThingsResult,
    settings: { ...drawThingsResult.settings, seeds: [9999] },
  })}\n`,
);
const changedSettingsIngest = await tool("lora_automation", {
  action: "draw-things-ingest",
  job_id: "cap-test",
  result_path: changedSettingsResultPath,
});
assert.equal(changedSettingsIngest.result.isError, true);
assert.match(
  changedSettingsIngest.result.content[0].text,
  /validation settings differ from the bound fixed settings/,
);
const changedLiveSettingsResultPath = path.join(testRoot, "changed-live-settings-result.json");
const changedLiveSettingsResult = structuredClone(drawThingsResult);
changedLiveSettingsResult.renders[0].live_metadata.settings = {
  ...changedLiveSettingsResult.renders[0].live_metadata.settings,
  seeds: [9999],
};
fs.writeFileSync(
  changedLiveSettingsResultPath,
  `${JSON.stringify(changedLiveSettingsResult)}\n`,
);
const changedLiveSettingsIngest = await tool("lora_automation", {
  action: "draw-things-ingest",
  job_id: "cap-test",
  result_path: changedLiveSettingsResultPath,
});
assert.equal(changedLiveSettingsIngest.result.isError, true);
assert.match(
  changedLiveSettingsIngest.result.content[0].text,
  /live settings differ from the bound fixed settings/,
);
const duplicateRenderResultPath = path.join(testRoot, "duplicate-render-result.json");
const duplicateRenderResult = structuredClone(drawThingsResult);
duplicateRenderResult.renders[1].image_path = duplicateRenderResult.renders[0].image_path;
fs.writeFileSync(
  duplicateRenderResultPath,
  `${JSON.stringify(duplicateRenderResult)}\n`,
);
const duplicateRenderIngest = await tool("lora_automation", {
  action: "draw-things-ingest",
  job_id: "cap-test",
  result_path: duplicateRenderResultPath,
});
assert.equal(duplicateRenderIngest.result.isError, true);
assert.match(
  duplicateRenderIngest.result.content[0].text,
  /duplicates another render image/,
);
const missingControlResultPath = path.join(testRoot, "missing-control-result.json");
const missingControlResult = structuredClone(drawThingsResult);
delete missingControlResult.renders[0].live_metadata.control;
fs.writeFileSync(
  missingControlResultPath,
  `${JSON.stringify(missingControlResult)}\n`,
);
const missingControlIngest = await tool("lora_automation", {
  action: "draw-things-ingest",
  job_id: "cap-test",
  result_path: missingControlResultPath,
});
assert.equal(missingControlIngest.result.isError, true);
assert.match(
  missingControlIngest.result.content[0].text,
  /has no ControlNet metadata/,
);
const drawThingsIngest = await tool("lora_automation", {
  action: "draw-things-ingest",
  job_id: "cap-test",
  result_path: drawThingsResultPath,
});
assert.equal(
  drawThingsIngest.result.isError,
  false,
  JSON.stringify(drawThingsIngest.result),
);
assert.equal(drawThingsIngest.result.structuredContent.import_count, 1);
assert.equal(drawThingsIngest.result.structuredContent.controlled_validation.render_count, 8);
const drawThingsValidationResult = JSON.parse(
  fs.readFileSync(path.join(testOutput, "validation-result.json"), "utf8"),
);
assert.equal(drawThingsValidationResult.renders.length, 8);
assert.equal(drawThingsValidationResult.render_matrix_sha256.length, 64);
assert.equal(drawThingsValidationResult.renders[0].image_sha256.length, 64);
assert.equal(
  drawThingsValidationResult.renders[0].image_path.startsWith("validation-renders/"),
  true,
);
const acceptedRenderPath = path.join(
  testOutput,
  drawThingsValidationResult.renders[0].image_path,
);
const acceptedRenderSha256 = crypto.createHash("sha256")
  .update(fs.readFileSync(acceptedRenderPath))
  .digest("hex");
const firstSourcePath = drawThingsResult.renders[0].image_path;
const firstSourceBytes = fs.readFileSync(firstSourcePath);
fs.writeFileSync(firstSourcePath, "changed source that must not replace accepted evidence\n");
const failedReplacementResultPath = path.join(testRoot, "failed-replacement-result.json");
const failedReplacementResult = structuredClone(drawThingsResult);
failedReplacementResult.renders.at(-1).image_path = path.join(testRoot, "missing-render.png");
fs.writeFileSync(
  failedReplacementResultPath,
  `${JSON.stringify(failedReplacementResult)}\n`,
);
const failedReplacementIngest = await tool("lora_automation", {
  action: "draw-things-ingest",
  job_id: "cap-test",
  result_path: failedReplacementResultPath,
});
assert.equal(failedReplacementIngest.result.isError, true);
assert.equal(
  crypto.createHash("sha256").update(fs.readFileSync(acceptedRenderPath)).digest("hex"),
  acceptedRenderSha256,
);
fs.writeFileSync(firstSourcePath, firstSourceBytes);
const registryRefreshAfterDrawThings = await tool("lora_automation", {
  action: "registry-refresh",
});
assert.equal(registryRefreshAfterDrawThings.result.isError, false);
const refreshedAfterDrawThings = JSON.parse(
  fs.readFileSync(
    registryRefreshAfterDrawThings.result.structuredContent.registry_path,
    "utf8",
  ),
);
assert.equal(
  refreshedAfterDrawThings.revisions["cap-test"].draw_things.imports.length,
  1,
);
const automationRevisionIngest = await tool("lora_automation", {
  action: "revision-ingest",
  job_id: "cap-test",
  source_path: testRevisionDataset,
  trigger: "test-v2",
  notes: "synthetic revised dataset",
});
assert.equal(automationRevisionIngest.result.structuredContent.accepted, true);
assert(
  fs.existsSync(automationRevisionIngest.result.structuredContent.revision_path),
);
const revisionRegistry = JSON.parse(
  fs.readFileSync(
    automationRevisionIngest.result.structuredContent.registry_path,
    "utf8",
  ),
);
assert.equal(
  revisionRegistry.revisions[
    automationRevisionIngest.result.structuredContent.revision.revision_id
  ].training_authorized,
  false,
);
assert(
  revisionRegistry.revisions["cap-test"].child_revisions.includes(
    automationRevisionIngest.result.structuredContent.revision.revision_id,
  ),
);

const packetRoot = path.join(testRoot, "packet-source", "return-packet");
for (const relative of [
  "OUTPUTS/pytorch_lora_weights.safetensors",
  "CONFIG/config.json",
  "CONFIG/multidatabackend.json",
  "DATASET/captions/revision.txt",
  "DATASET/dataset-manifest.json",
  "LOGS/train.log",
  "CONFIG/validation-prompt-library.json",
  "VALIDATION_SAMPLES/sample.png",
  "SHA256SUMS.txt",
  "RUN_SUMMARY.json",
  "EVALUATION_NOTES.md",
  "CONFIG/environment-versions.json",
]) {
  const target = path.join(packetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${relative}\n`);
}
fs.writeFileSync(
  path.join(packetRoot, "CONFIG", "validation-prompt-library.json"),
  `${JSON.stringify({
    schema_version: 1,
    seed_policy: "Use seed 20260801 for every mapped prompt.",
    fixed_settings: {
      seeds: [20260801],
      base_model: "test-model",
      width: 1024,
      height: 1024,
      steps: 25,
      sampler: "test-sampler",
      guidance_scale: 5,
      lora_weight: 0.7,
    },
    prompts: validationPromptIds.map((id) => ({ id, prompt: `test, ${id}` })),
  })}\n`,
);
const packetPath = path.join(testRoot, "complete-return-packet.zip");
const packetZip = spawnSync("/usr/bin/zip", [
  "-qr", packetPath, path.basename(packetRoot),
], {
  cwd: path.dirname(packetRoot),
  encoding: "utf8",
});
assert.equal(packetZip.status, 0, packetZip.stderr);
const automationPacketAudit = await tool("lora_automation", {
  action: "packet-audit",
  path: packetPath,
});
assert.equal(automationPacketAudit.result.structuredContent.complete, true);
const automationPacketPlan = await tool("lora_automation", {
  action: "packet-validation-plan",
  path: packetPath,
  job_id: "cap-test",
  trigger: "test",
});
assert.equal(automationPacketPlan.result.isError, false);
assert.equal(automationPacketPlan.result.structuredContent.plan.prompts.length, 4);
assert.deepEqual(
  automationPacketPlan.result.structuredContent.plan.fixed_settings.seeds,
  [20260801],
);
assert.equal(automationPacketPlan.result.structuredContent.plan.required_render_count, 4);

const routineCommand = await tool("run_command", {
  command: "printf 'routine-ok'",
  cwd: testRoot,
});
assert.equal(routineCommand.result.isError, false);
assert.equal(routineCommand.result.structuredContent.stdout, "routine-ok");
assert.equal(routineCommand.result.structuredContent.ok, true);

const blockedConsequentialCommand = await tool("run_command", {
  command: "printf 'must-not-run'",
  cwd: testRoot,
  consequential: true,
});
assert.equal(blockedConsequentialCommand.result.isError, false);
assert.equal(
  blockedConsequentialCommand.result.structuredContent.stdout,
  "must-not-run",
);

const queued = await tool("send_message", {
  subject: "MCP test",
  body: "Queued without a configured peer.",
  deliver: false,
  wake: false,
});
assert.equal(queued.result.isError, false);
const queuedMessageId = queued.result.structuredContent.message_id;
assert(queuedMessageId);

const acknowledgementEnvelope = {
  schema_version: 1,
  id: "test-ack-1",
  created_at: new Date().toISOString(),
  sender: "test-peer",
  recipient: "test-node",
  kind: "acknowledgement",
  subject: "Acknowledged MCP test",
  body: "Received.",
  correlation_id: queuedMessageId,
  metadata: {},
};
fs.writeFileSync(
  path.join(testRoot, "inbox", "test-ack-1.json"),
  `${JSON.stringify(acknowledgementEnvelope)}\n`,
);
await tool("receive_messages");
const acknowledgedOutbound = await tool("list_messages", {
  direction: "outbound",
  state: "acknowledged",
});
assert.equal(acknowledgedOutbound.result.structuredContent[0].id, queuedMessageId);
const terminalAck = await tool("acknowledge_message", {
  message_id: "test-ack-1",
});
assert.equal(terminalAck.result.structuredContent.reply_sent, false);
const outboundAfterTerminalAck = await tool("list_messages", {
  direction: "outbound",
});
assert.equal(outboundAfterTerminalAck.result.structuredContent.length, 1);

const jobCreated = await tool("create_job", {
  kind: "training",
  title: "Authorization gate test",
});
const jobId = jobCreated.result.structuredContent.job_id;
assert.equal(jobCreated.result.structuredContent.state, "proposed");

const authorizedConsequentialCommand = await tool("run_command", {
  command: "printf 'authorized-ok'",
  cwd: testRoot,
  consequential: true,
  job_id: jobId,
});
assert.equal(authorizedConsequentialCommand.result.isError, false);
assert.equal(
  authorizedConsequentialCommand.result.structuredContent.stdout,
  "authorized-ok",
);

await tool("update_job_status", { job_id: jobId, state: "queued" });
await tool("update_job_status", { job_id: jobId, state: "running" });
await tool("update_job_status", { job_id: jobId, state: "completed" });
const verifiedJob = await tool("update_job_status", {
  job_id: jobId,
  state: "verified",
});
assert.equal(verifiedJob.result.isError, false);

const samplePath = path.join(testRoot, "sample.txt");
fs.writeFileSync(samplePath, "hawkspan\n");
const registered = await tool("register_artifact", { path: samplePath });
const artifact = registered.result.structuredContent;
assert.equal(artifact.size_bytes, 9);
const verifiedArtifact = await tool("verify_artifact", {
  artifact_id: artifact.artifact_id,
  expected_sha256: artifact.sha256,
});
assert.equal(verifiedArtifact.result.structuredContent.matches, true);
const queuedArtifact = await tool("queue_artifact_delivery", {
  artifact_id: artifact.artifact_id,
});
assert.equal(queuedArtifact.result.structuredContent.queued, true);
const artifactQueue = await tool("queue_status", { queue_id: "hawkspan-artifacts" });
assert.equal(
  artifactQueue.result.structuredContent.items.some(
    (item) => item.payload.artifact_id === artifact.artifact_id && item.state === "queued",
  ),
  true,
);

const inboundArtifactPath = path.join(testRoot, "artifacts", "peer-result.zip");
fs.writeFileSync(inboundArtifactPath, "peer artifact\n");
const inboundDigest = crypto.createHash("sha256")
  .update(fs.readFileSync(inboundArtifactPath))
  .digest("hex");
fs.writeFileSync(
  path.join(testRoot, "artifacts", "peer-artifact-1.artifact.json"),
  `${JSON.stringify({
    schema_version: 1,
    artifact_id: "peer-artifact-1",
    owner: "test-peer",
    name: "Peer result",
    file_name: "peer-result.zip",
    size_bytes: fs.statSync(inboundArtifactPath).size,
    sha256: inboundDigest,
    delivered_at: new Date().toISOString(),
    delivered_via: "test",
    metadata: { kind: "return-packet" },
  })}\n`,
);
const receivedArtifacts = await tool("receive_artifacts");
assert.equal(receivedArtifacts.result.structuredContent.artifacts[0].verified, true);

const status = await tool("link_status");
assert.equal(status.result.isError, false);
assert.equal(status.result.structuredContent.counts.active_jobs, 0);
assert.deepEqual(status.result.structuredContent.routes, []);

const queueStatus = await tool("trainer_queue_status");
assert.equal(queueStatus.result.structuredContent.exists, true);
const runStatus = await tool("trainer_run_status");
assert.equal(runStatus.result.structuredContent.progress.step, 500);
assert.equal(runStatus.result.structuredContent.progress.steps_total, 1000);
assert(
  runStatus.result.structuredContent.checkpoints.some(
    (entry) => entry.name === "checkpoint-400",
  ),
);
const queueDetail = await tool("trainer_queue_detail");
assert.equal(queueDetail.result.structuredContent.jobs[0].state, "running");
assert.equal(queueDetail.result.structuredContent.jobs[1].state, "completed");
fs.writeFileSync(
  path.join(testQueue, "captioned-lora-status.json"),
  `${JSON.stringify({ batch: null, total: 2, current: null, completed: [], failed: [] })}\n`,
);
const directStatusPath = path.join(testControl, "job-direct--cap-test.status.json");
const directLogPath = path.join(testControl, "job-direct--cap-test.log");
const directRunner = spawn(process.execPath, [
  "-e",
  "setTimeout(() => {}, 60000)",
  "cap-test",
]);
fs.copyFileSync(path.join(testLogs, "cap-test.log"), directLogPath);
fs.writeFileSync(
  directStatusPath,
  `${JSON.stringify({ batch: "direct", total: 1, current: "cap-test", completed: [], failed: [] })}\n`,
);
fs.writeFileSync(
  path.join(testControl, "job-direct--cap-test.json"),
  `${JSON.stringify({
    schema_version: 1,
    durable_job_id: "job-direct",
    target: "cap-test",
    pid: directRunner.pid,
    process_group: directRunner.pid,
    runner: process.execPath,
    state: "started",
    status_path: directStatusPath,
    log_path: directLogPath,
    revision_fingerprint: "direct-revision",
    readiness_path: path.join(testRoot, "direct-readiness.json"),
  })}\n`,
);
const activeRuntimeRoot = path.join(testRoot, "active-runtime");
const activeRuntimeQueue = path.join(activeRuntimeRoot, "queue");
const activeRuntimeOutput = path.join(activeRuntimeRoot, "outputs", "cap-test");
const activeRuntimeJobConfig = path.join(activeRuntimeRoot, "config", "cap-test");
const archivedRuntimeJobConfig = path.join(activeRuntimeRoot, "config", "archived-test");
fs.mkdirSync(activeRuntimeQueue, { recursive: true });
fs.mkdirSync(activeRuntimeOutput, { recursive: true });
fs.mkdirSync(activeRuntimeJobConfig, { recursive: true });
fs.mkdirSync(archivedRuntimeJobConfig, { recursive: true });
fs.writeFileSync(
  path.join(activeRuntimeJobConfig, "config.json"),
  `${JSON.stringify({
    checkpoints_total_limit: 10,
    output_dir: activeRuntimeOutput,
  })}\n`,
);
fs.writeFileSync(
  path.join(archivedRuntimeJobConfig, "config.json"),
  `${JSON.stringify({
    checkpoints_total_limit: 1,
    output_dir: path.join(activeRuntimeRoot, "outputs", "archived-test"),
  })}\n`,
);
fs.writeFileSync(
  path.join(activeRuntimeQueue, "captioned-lora-manifest.json"),
  `${JSON.stringify([{
    job_id: "cap-test",
    data_dir: path.join(activeRuntimeRoot, "dataset"),
    config_dir: activeRuntimeJobConfig,
    output_dir: activeRuntimeOutput,
  }, {
    job_id: "archived-test",
    data_dir: path.join(activeRuntimeRoot, "archived-dataset"),
    config_dir: archivedRuntimeJobConfig,
    output_dir: path.join(activeRuntimeRoot, "outputs", "archived-test"),
  }])}\n`,
);
fs.writeFileSync(
  path.join(activeRuntimeQueue, "captioned-lora-status.json"),
  `${JSON.stringify({ current: "cap-test", total: 1, completed: [], failed: [] })}\n`,
);
const activeRuntimeConfig = path.join(activeRuntimeRoot, "config.json");
fs.writeFileSync(activeRuntimeConfig, JSON.stringify({
  training: {
    queue_root: activeRuntimeQueue,
    log_root: testLogs,
    output_root: path.join(activeRuntimeRoot, "outputs"),
    minimum_checkpoint_retention: 10,
    preservation_root: testPreservation,
  },
}));
fs.writeFileSync(path.join(testRoot, "active-lora-runtime.json"), JSON.stringify({
  config_path: activeRuntimeConfig,
  runtime_root: activeRuntimeRoot,
}));
const activeQueueStatus = await tool("trainer_queue_status");
assert.equal(activeQueueStatus.result.structuredContent.queue_root, activeRuntimeQueue);
const activeQueueDetail = await tool("trainer_queue_detail");
assert.equal(activeQueueDetail.result.structuredContent.jobs[0].job_id, "cap-test");
assert.equal(activeQueueDetail.result.structuredContent.jobs[0].state, "running");
const directRunStatus = await tool("trainer_run_status");
assert.equal(directRunStatus.result.structuredContent.current, "cap-test");
assert.equal(directRunStatus.result.structuredContent.current_job.job_id, "cap-test");
assert.equal(directRunStatus.result.structuredContent.current_job.state, "running");
assert.equal(
  directRunStatus.result.structuredContent.current_job.output_dir,
  activeRuntimeOutput,
);
assert.equal(directRunStatus.result.structuredContent.progress.step, 500);
assert.equal(directRunStatus.result.structuredContent.direct_run.durable_job_id, "job-direct");
assert.equal(directRunStatus.result.structuredContent.direct_run.active, true);
const interruptedDirectStatusPath = path.join(testControl, "job-interrupted--cap-stale.status.json");
fs.writeFileSync(
  interruptedDirectStatusPath,
  `${JSON.stringify({
    batch: "direct",
    total: 1,
    current: "cap-stale",
    completed: [],
    failed: [],
    state: "interrupted_no_checkpoint",
  })}\n`,
);
fs.writeFileSync(
  path.join(testControl, "job-interrupted--cap-stale.json"),
  `${JSON.stringify({
    schema_version: 1,
    durable_job_id: "job-interrupted",
    target: "cap-stale",
    pid: 999999,
    process_group: 999999,
    runner: process.execPath,
    state: "interrupted_no_checkpoint",
    status_path: interruptedDirectStatusPath,
    log_path: path.join(testControl, "job-interrupted--cap-stale.log"),
    revision_fingerprint: "interrupted-revision",
    readiness_path: path.join(testRoot, "interrupted-readiness.json"),
  })}\n`,
);
const afterInterruptedRecordStatus = await tool("trainer_run_status");
assert.equal(afterInterruptedRecordStatus.result.structuredContent.current, "cap-test");
assert.equal(
  afterInterruptedRecordStatus.result.structuredContent.direct_run.durable_job_id,
  "job-direct",
);
assert.equal(afterInterruptedRecordStatus.result.structuredContent.direct_run.active, true);
directRunner.kill();
await new Promise((resolve) => directRunner.once("exit", resolve));
fs.writeFileSync(
  directStatusPath,
  `${JSON.stringify({
    batch: "direct",
    total: 1,
    current: null,
    completed: [],
    failed: [],
    trained: [{ job_id: "cap-test", output: activeRuntimeOutput }],
  })}\n`,
);
const completedDirectRun = await tool("trainer_run_status");
assert.equal(completedDirectRun.result.structuredContent.current, null);
assert.equal(completedDirectRun.result.structuredContent.direct_run.active, false);
assert.equal(completedDirectRun.result.structuredContent.direct_run.state, "completed");
const dataset = await tool("trainer_validate_dataset", { path: testQueue });
assert.equal(dataset.result.structuredContent.valid, true);
const logTail = await tool("trainer_tail_log", {
  path: path.join(testLogs, "trainer.log"),
  lines: 1,
});
assert.equal(logTail.result.structuredContent.content, "step 2\n");
const retentionAudit = await tool("trainer_audit_checkpoint_retention");
assert.equal(retentionAudit.result.structuredContent.valid, true);
assert.equal(retentionAudit.result.structuredContent.queue_root, activeRuntimeQueue);
assert.equal(retentionAudit.result.structuredContent.scope, "scheduler");
assert.equal(retentionAudit.result.structuredContent.inventory_config_count, 2);
assert.equal(retentionAudit.result.structuredContent.config_count, 1);
const preservationStatus = await tool("trainer_preservation_status");
assert.equal(preservationStatus.result.structuredContent.exists, true);
assert.equal(preservationStatus.result.structuredContent.preservation_root, testPreservation);
const terminalStart = await tool("trainer_start_authorized_job", { job_id: jobId });
assert.equal(terminalStart.result.isError, true);
const artifacts = await tool("list_artifacts");
assert.equal(artifacts.result.structuredContent.length, 3);
const auditEvents = await tool("list_audit_events", { limit: 10 });
assert(auditEvents.result.structuredContent.length > 0);

child.stdin.end();
await new Promise((resolve) => child.once("exit", resolve));
fs.rmSync(testRoot, { recursive: true, force: true });
process.stdout.write("HawkSpan MCP tests passed\n");
