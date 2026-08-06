#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lora-stage-test-"));
const queue = path.join(root, "source-queue");
const dataset = path.join(queue, "source", "Test v2");
const conditioning = path.join(queue, "source", "Test v2 controls");
const configDir = path.join(queue, "configs", "cap-test-v2");
const sourceOutput = path.join(root, "source-output", "cap-test-v2");
const recoveryCheckpoint = path.join(sourceOutput, "checkpoint-400");
const overlayRoot = path.join(root, "overlay");
const runtimeRoot = path.join(root, "runtime");
const simpletuner = path.join(root, "simpletuner");
for (const directory of [
  dataset,
  conditioning,
  configDir,
  sourceOutput,
  recoveryCheckpoint,
  path.join(overlayRoot, "jobs", "cap-test-v2", "source", "Test v2"),
  path.join(simpletuner, ".venv", "bin"),
  path.join(simpletuner, "cache", "huggingface", "hub"),
]) {
  fs.mkdirSync(directory, { recursive: true });
}
for (const name of [
  "pytorch_lora_weights.safetensors",
  "optimizer.bin",
  "scheduler.bin",
  "training_state.json",
]) {
  fs.writeFileSync(path.join(recoveryCheckpoint, name), `${name}\n`);
}

const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5Z8AAAAASUVORK5CYII=",
  "base64",
);
fs.writeFileSync(path.join(dataset, "sample.png"), image);
fs.writeFileSync(path.join(conditioning, "sample.png"), image);
const variants = ["literal", "sensual", "erotic", "clinical", "tags"].map(
  (mode) => [
    `Subject: testv2, ${mode}`,
    "Pose: standing",
    "Setting: studio",
    "Appearance: synthetic test subject",
    "Camera/Crop: full body",
    "Details: deterministic fixture",
  ].join("; "),
);
fs.writeFileSync(path.join(dataset, "sample.txt"), "old diagnostic caption\n");
fs.writeFileSync(
  path.join(overlayRoot, "jobs", "cap-test-v2", "source", "Test v2", "sample.txt"),
  `${variants.join("\n")}\n`,
);
fs.writeFileSync(
  path.join(simpletuner, ".venv", "bin", "python"),
  "#!/bin/sh\nprintf '{\"python\":\"test\",\"platform\":\"test\",\"torch\":\"test\",\"mps_built\":true,\"mps_available\":true,\"packages\":{}}\\n'\n",
  { mode: 0o755 },
);

const validationPath = path.join(configDir, "validation-prompt-library.json");
fs.writeFileSync(validationPath, JSON.stringify({
  seed_policy: "Use seed 20260801 for every mapped prompt at step 300.",
  prompts: [
    "subject-wide",
    "subject-angle",
    "subject-detail",
    "subject-context",
  ].map((id) => ({ id, prompt: `testv2, ${id}` })),
}));
fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
  data_backend_config: path.join(configDir, "multidatabackend.json"),
  output_dir: sourceOutput,
  max_train_steps: 1200,
  checkpoint_step_interval: 17,
  checkpoints_total_limit: 11,
  lora_rank: 24,
  lora_alpha: 12,
  resume_from_checkpoint: recoveryCheckpoint,
}));
fs.writeFileSync(path.join(configDir, "multidatabackend.json"), JSON.stringify([
  {
    id: "images",
    type: "local",
    instance_data_dir: dataset,
    caption_strategy: "textfile",
    disable_multiline_split: false,
    crop_style: "center",
    crop_aspect: "preserve",
    cache_dir_vae: path.join(queue, "cache", "vae", "cap-test-v2"),
    conditioning: { instance_data_dir: conditioning, type: "canny" },
  },
  {
    id: "text",
    type: "local",
    dataset_type: "text_embeds",
    cache_dir: path.join(queue, "cache", "text", "cap-test-v2"),
  },
]));
fs.writeFileSync(path.join(configDir, "TRAINING_READINESS_POLICY.json"), JSON.stringify({
  version_tag: "v2",
  expected_caption_variants: 5,
  required_trigger: "testv2",
  maximum_tokens: 77,
  tokenizer_root: path.join(root, "fake-tokenizer"),
  minimum_checkpoint_retention: 10,
  minimum_free_bytes: 1,
  validation_prompt_library: validationPath,
  recovery_checkpoint: recoveryCheckpoint,
}));
fs.writeFileSync(path.join(queue, "captioned-lora-manifest.json"), JSON.stringify([{
  index: 1,
  job_id: "cap-test-v2",
  source: "Synthetic",
  image_count: 1,
  caption_count: 1,
  trigger: "testv2",
  data_dir: dataset,
  conditioning_dir: conditioning,
  config_dir: configDir,
  output_dir: sourceOutput,
  runtime_staged: true,
  hawkspan_revision: "stale-source-revision",
  readiness_path: "/stale/readiness.json",
  readiness_revision_fingerprint: "a".repeat(64),
}]));
fs.writeFileSync(path.join(queue, "captioned-lora-status.json"), JSON.stringify({
  current: null,
  completed: [],
  failed: [],
}));

const configPath = path.join(root, "link-config.json");
const automationScript = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "lora-automation.mjs",
);
fs.writeFileSync(configPath, JSON.stringify({
  schema_version: 1,
  training: {
    queue_root: queue,
    output_root: path.join(root, "source-output"),
    log_root: path.join(queue, "logs"),
    control_root: path.join(root, "durable-control"),
    simpletuner_root: simpletuner,
    node_path: process.execPath,
    automation_script: automationScript,
  },
  lora_automation: {
    simpletuner_root: simpletuner,
    queue_root: queue,
    output_root: path.join(root, "source-output"),
    preservation_root: path.join(root, "source-output"),
    manifest_root: path.join(queue, "automation-manifests"),
    registry_path: path.join(root, "registry.json"),
    revision_root: path.join(root, "revisions"),
    packet_ledger_path: path.join(root, "ledger.json"),
    validation_queue_root: path.join(root, "validation"),
    queue_policy_path: path.join(queue, "queue-policy.json"),
  },
}));

const preparedResult = spawnSync(process.execPath, [
  automationScript,
  "prepare-versioned-job",
  JSON.stringify({
    job_id: "cap-test-v2",
    target_job_id: "cap-test-v3",
    version_tag: "v3",
    required_trigger: "testv2",
    tokenizer_root: path.join(root, "fake-tokenizer"),
    validation_prompt_library: validationPath,
    recovery_checkpoint: recoveryCheckpoint,
  }),
], {
  encoding: "utf8",
  timeout: 30000,
  env: { ...process.env, HAWKSPAN_CONFIG: configPath },
});
assert.equal(preparedResult.status, 0, preparedResult.stderr);
const prepared = JSON.parse(preparedResult.stdout);
assert.equal(prepared.target_job.runtime_staged, false);
assert.equal("hawkspan_revision" in prepared.target_job, false);
assert.equal("readiness_path" in prepared.target_job, false);
assert.equal("readiness_revision_fingerprint" in prepared.target_job, false);
const stagedCheckpoint = path.join(
  root,
  "source-output",
  "cap-test-v3-sdxl-lora",
  "checkpoint-400",
);
assert.equal(prepared.staged_recovery_checkpoint, stagedCheckpoint);
assert.deepEqual(
  fs.readdirSync(stagedCheckpoint).sort(),
  fs.readdirSync(recoveryCheckpoint).sort(),
);
const preparedConfig = JSON.parse(fs.readFileSync(
  path.join(queue, "configs", "cap-test-v3", "config.json"),
));
assert.equal(preparedConfig.resume_from_checkpoint, stagedCheckpoint);
assert.equal(preparedConfig.checkpoint_step_interval, 17);
assert.equal(preparedConfig.checkpoints_total_limit, 11);
assert.equal(preparedConfig.lora_rank, 24);
assert.equal(preparedConfig.lora_alpha, 12);
const preparedPolicy = JSON.parse(fs.readFileSync(
  path.join(queue, "configs", "cap-test-v3", "TRAINING_READINESS_POLICY.json"),
));
assert.equal(preparedPolicy.recovery_checkpoint, stagedCheckpoint);
assert.equal(preparedPolicy.source_recovery_checkpoint, recoveryCheckpoint);
const preparedValidation = JSON.parse(fs.readFileSync(
  path.join(queue, "configs", "cap-test-v3", "validation-prompts.json"),
));
assert.deepEqual(preparedValidation.fixed_settings.seeds, [20260801]);
assert.equal(
  preparedValidation.seed_policy,
  "Use seed 20260801 for every mapped prompt.",
);

const stageScript = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "stage-lora-runtime-job.py",
);
const result = spawnSync("/usr/bin/python3", [
  stageScript,
  "--source-manifest", path.join(queue, "captioned-lora-manifest.json"),
  "--job-id", "cap-test-v2",
  "--runtime-root", runtimeRoot,
  "--base-link-config", configPath,
  "--caption-overlay-root", overlayRoot,
], { encoding: "utf8", timeout: 30000 });
assert.equal(result.status, 0, result.stderr);
const staged = JSON.parse(result.stdout);
assert.equal(staged.staged, true);
assert.equal(staged.training_started, false);
assert.equal(staged.ready, true, JSON.stringify(staged.problems, null, 2));
assert.equal(staged.recovery_checkpoint.complete, true);
assert.match(staged.recovery_checkpoint.revision_sha256, /^[a-f0-9]{64}$/);

const runtimeManifest = JSON.parse(fs.readFileSync(staged.runtime_manifest));
assert.equal(runtimeManifest.length, 1);
assert(runtimeManifest[0].data_dir.startsWith(runtimeRoot));
assert(runtimeManifest[0].config_dir.startsWith(runtimeRoot));
assert(runtimeManifest[0].output_dir.startsWith(runtimeRoot));
assert(runtimeManifest[0].conditioning_dir.startsWith(runtimeRoot));
const runtimeBackend = JSON.parse(fs.readFileSync(
  path.join(runtimeManifest[0].config_dir, "multidatabackend.json"),
));
assert.equal(
  runtimeBackend[0].conditioning.instance_data_dir,
  runtimeManifest[0].conditioning_dir,
);
assert.equal(
  fs.readFileSync(path.join(runtimeManifest[0].conditioning_dir, "sample.png"), "base64"),
  image.toString("base64"),
);
const stagedCaption = path.join(
  runtimeManifest[0].data_dir,
  "sample.txt",
);
assert.deepEqual(fs.readFileSync(stagedCaption, "utf8").trim().split("\n"), variants);
const preserved = path.join(
  path.dirname(runtimeManifest[0].data_dir),
  "preserved-source-captions",
  "sample.txt",
);
assert.equal(fs.readFileSync(preserved, "utf8"), "old diagnostic caption\n");
assert.equal(fs.readFileSync(path.join(dataset, "sample.txt"), "utf8"), "old diagnostic caption\n");
const activePointer = JSON.parse(
  fs.readFileSync(path.join(root, "active-lora-runtime.json"), "utf8"),
);
assert.equal(activePointer.config_path, staged.runtime_config);
assert.equal(activePointer.training_authorized, false);
const runtimeLinkConfig = JSON.parse(fs.readFileSync(staged.runtime_config));
assert.equal(runtimeLinkConfig.training.node_path, process.execPath);
assert.equal(runtimeLinkConfig.training.automation_script, automationScript);
assert.equal(runtimeLinkConfig.training.runner_script, undefined);
assert.equal(runtimeLinkConfig.training.control_root, path.join(root, "durable-control"));
assert.equal(
  runtimeLinkConfig.lora_automation.scheduler_root,
  path.join(root, "lora-scheduler"),
  "staged data must retain the one base scheduler authority",
);

const scheduler = spawnSync("/usr/bin/python3", [
  path.join(path.dirname(new URL(import.meta.url).pathname), "lora-scheduler.py"),
], {
  encoding: "utf8",
  timeout: 30000,
  env: { ...process.env, HAWKSPAN_CONFIG: configPath },
});
assert.equal(scheduler.status, 0, scheduler.stderr);
assert(
  fs.existsSync(path.join(root, "lora-scheduler", "lora-scheduler-state.json")),
);
assert.equal(fs.existsSync(path.join(runtimeRoot, "scheduler")), false);
const delegatedQueue = spawnSync(process.execPath, [
  automationScript,
  "queue",
  "{}",
], {
  encoding: "utf8",
  timeout: 30000,
  env: { ...process.env, HAWKSPAN_CONFIG: configPath },
});
assert.equal(delegatedQueue.status, 0, delegatedQueue.stderr);
assert.deepEqual(
  JSON.parse(delegatedQueue.stdout).jobs.map((entry) => entry.job_id),
  ["cap-test-v2"],
);

const second = spawnSync("/usr/bin/python3", [
  stageScript,
  "--source-manifest", path.join(queue, "captioned-lora-manifest.json"),
  "--job-id", "cap-test-v2",
  "--runtime-root", runtimeRoot,
  "--base-link-config", configPath,
  "--caption-overlay-root", overlayRoot,
], { encoding: "utf8", timeout: 30000 });
assert.equal(second.status, 0, second.stderr);
assert.equal(JSON.parse(second.stdout).already_present, true);

const stagedRoot = JSON.parse(second.stdout).runtime_job_root;
fs.rmSync(path.join(stagedRoot, "STAGE-MANIFEST.json"));
fs.writeFileSync(path.join(stagedRoot, "partial-attempt-marker"), "incomplete\n");
const recovered = spawnSync("/usr/bin/python3", [
  stageScript,
  "--source-manifest", path.join(queue, "captioned-lora-manifest.json"),
  "--job-id", "cap-test-v2",
  "--runtime-root", runtimeRoot,
  "--base-link-config", configPath,
  "--caption-overlay-root", overlayRoot,
], { encoding: "utf8", timeout: 30000 });
assert.equal(recovered.status, 0, recovered.stderr);
assert.equal(JSON.parse(recovered.stdout).staged, true);
assert.equal(fs.existsSync(path.join(stagedRoot, "partial-attempt-marker")), false);
assert.equal(fs.existsSync(path.join(stagedRoot, "STAGE-MANIFEST.json")), true);
process.stdout.write("LoRA runtime staging test passed\n");
