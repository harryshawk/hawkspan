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
const targets = path.join(queue, "source", "targets");
const configDir = path.join(queue, "configs", "cap-test-v2");
const sourceOutput = path.join(root, "source-output", "cap-test-v2");
const recoveryCheckpoint = path.join(sourceOutput, "checkpoint-400");
const overlayRoot = path.join(root, "overlay");
const runtimeRoot = path.join(root, "runtime");
const simpletuner = path.join(root, "simpletuner");
for (const directory of [
  dataset,
  conditioning,
  targets,
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
]) {
  fs.writeFileSync(path.join(recoveryCheckpoint, name), `${name}\n`);
}
fs.writeFileSync(
  path.join(recoveryCheckpoint, "training_state.json"),
  `${JSON.stringify({ global_step: 400 })}\n`,
);

const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5Z8AAAAASUVORK5CYII=",
  "base64",
);
fs.writeFileSync(path.join(dataset, "sample.png"), image);
fs.writeFileSync(path.join(conditioning, "sample.png"), image);
fs.writeFileSync(path.join(targets, "sample.png"), image);
fs.writeFileSync(path.join(dataset, "aspect_ratio_bucket_metadata_old-job.json"), "{}\n");
fs.writeFileSync(path.join(conditioning, "aspect_ratio_bucket_indices_old-job.json"), "{}\n");
fs.writeFileSync(path.join(conditioning, "sample.txt"), "conditioning cache sidecar\n");
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
const v3Overlay = path.join(
  overlayRoot,
  "jobs",
  "cap-test-v3",
  "source",
  "Test v2",
  "sample.txt",
);
fs.mkdirSync(path.dirname(v3Overlay), { recursive: true });
fs.writeFileSync(v3Overlay, `${variants.join("\n")}\n`);
fs.writeFileSync(
  path.join(simpletuner, ".venv", "bin", "python"),
  "#!/bin/sh\nprintf '{\"python\":\"test\",\"platform\":\"test\",\"torch\":\"test\",\"mps_built\":true,\"mps_available\":true,\"packages\":{}}\\n'\n",
  { mode: 0o755 },
);

const validationPath = path.join(configDir, "validation-prompt-library.json");
fs.writeFileSync(validationPath, JSON.stringify({
  controls_are_relative_to: "dataset",
  seed_policy: "Use seed 20260801 for every mapped prompt at step 300.",
  fixed_settings: {
    seeds: [20260801],
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
  prompts: [
    "subject-wide",
    "subject-angle",
    "subject-detail",
    "subject-context",
  ].map((id) => ({
    id,
    prompt: `testv2, ${id}`,
    control_image: "conditioning/sample.png",
    source_target: "targets/sample.png",
  })),
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
    max_train_attempts: 7,
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

function writeCheckpoint(checkpointPath, globalStep, mutation = null) {
  fs.mkdirSync(checkpointPath, { recursive: true });
  for (const name of [
    "pytorch_lora_weights.safetensors",
    "optimizer.bin",
    "scheduler.bin",
  ]) {
    fs.writeFileSync(path.join(checkpointPath, name), `${name}\n`);
  }
  fs.writeFileSync(
    path.join(checkpointPath, "training_state.json"),
    `${JSON.stringify({ global_step: globalStep })}\n`,
  );
  mutation?.(checkpointPath);
}

function rejectedPreparation(label, checkpointPath, expectedError) {
  const result = spawnSync(process.execPath, [
    automationScript,
    "prepare-versioned-job",
    JSON.stringify({
      job_id: "cap-test-v2",
      target_job_id: `cap-test-${label}`,
      version_tag: label,
      required_trigger: "testv2",
      tokenizer_root: path.join(root, "fake-tokenizer"),
      validation_prompt_library: validationPath,
      recovery_checkpoint: checkpointPath,
    }),
  ], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, HAWKSPAN_CONFIG: configPath },
  });
  assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
  assert.match(result.stderr, expectedError);
}

const nonRegularCheckpoint = path.join(sourceOutput, "checkpoint-401");
writeCheckpoint(nonRegularCheckpoint, 401, (checkpointPath) => {
  fs.rmSync(path.join(checkpointPath, "optimizer.bin"));
  fs.mkdirSync(path.join(checkpointPath, "optimizer.bin"));
});
rejectedPreparation("nonregular", nonRegularCheckpoint, /required_path_not_regular_file/);

const emptyCheckpoint = path.join(sourceOutput, "checkpoint-402");
writeCheckpoint(emptyCheckpoint, 402, (checkpointPath) => {
  fs.writeFileSync(path.join(checkpointPath, "scheduler.bin"), "");
});
rejectedPreparation("empty", emptyCheckpoint, /required_file_empty/);

const malformedCheckpoint = path.join(sourceOutput, "checkpoint-403");
writeCheckpoint(malformedCheckpoint, 403, (checkpointPath) => {
  fs.writeFileSync(path.join(checkpointPath, "training_state.json"), "{not-json\n");
});
rejectedPreparation("malformed", malformedCheckpoint, /training_state_json_invalid/);

const mismatchedCheckpoint = path.join(sourceOutput, "checkpoint-404");
writeCheckpoint(mismatchedCheckpoint, 405);
rejectedPreparation("mismatch", mismatchedCheckpoint, /checkpoint_basename_global_step_mismatch/);

const invalidNameCheckpoint = path.join(sourceOutput, "recovery-405");
writeCheckpoint(invalidNameCheckpoint, 405);
rejectedPreparation("badname", invalidNameCheckpoint, /checkpoint_basename_must_be_checkpoint_N/);

const outsideCheckpoint = path.join(root, "outside", "checkpoint-406");
writeCheckpoint(outsideCheckpoint, 406);
rejectedPreparation(
  "outside",
  outsideCheckpoint,
  /must be under the source job output or configured preservation root/,
);

const otherJobCheckpoint = path.join(
  root,
  "source-output",
  "other-job",
  "PRESERVED_CHECKPOINTS",
  "checkpoint-407",
);
writeCheckpoint(otherJobCheckpoint, 407);
rejectedPreparation(
  "otherjob",
  otherJobCheckpoint,
  /must be under the source job output or configured preservation root/,
);

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
assert.equal(prepared.recovery_checkpoint.global_step, 400);
assert.equal(
  prepared.recovery_checkpoint_provenance.source_job_id,
  "cap-test-v2",
);
assert.equal(
  prepared.recovery_checkpoint_provenance.matched_root_kind,
  "source_output",
);
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
  "--job-id", "cap-test-v3",
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
const runtimeRecoveryCheckpoint = path.join(
  runtimeRoot,
  "outputs",
  "cap-test-v3",
  "checkpoint-400",
);
assert.equal(staged.recovery_checkpoint.path, runtimeRecoveryCheckpoint);
assert.deepEqual(
  fs.readdirSync(runtimeRecoveryCheckpoint).sort(),
  fs.readdirSync(recoveryCheckpoint).sort(),
);
const runtimeConfig = JSON.parse(fs.readFileSync(
  path.join(staged.runtime_job_root, "config", "config.json"),
));
const runtimePolicy = JSON.parse(fs.readFileSync(
  path.join(staged.runtime_job_root, "config", "TRAINING_READINESS_POLICY.json"),
));
assert.equal(runtimeConfig.resume_from_checkpoint, runtimeRecoveryCheckpoint);
assert.equal(runtimePolicy.recovery_checkpoint, runtimeRecoveryCheckpoint);
assert.equal(runtimePolicy.staged_recovery_checkpoint, runtimeRecoveryCheckpoint);
assert.equal(runtimePolicy.runtime_recovery_checkpoint, runtimeRecoveryCheckpoint);
assert.equal(runtimePolicy.source_recovery_checkpoint, recoveryCheckpoint);
assert.equal(
  runtimePolicy.recovery_checkpoint_revision_sha256,
  prepared.recovery_checkpoint.revision_sha256,
);
assert.equal(
  runtimePolicy.recovery_checkpoint_provenance.runtime_checkpoint_path,
  runtimeRecoveryCheckpoint,
);
assert(
  runtimeRecoveryCheckpoint.startsWith(
    `${path.join(runtimeRoot, "outputs", "cap-test-v3")}${path.sep}`,
  ),
  "recovery checkpoint must be visible under the packaged runtime output",
);
const preparedOptimizer = path.join(stagedCheckpoint, "optimizer.bin");
const preparedOptimizerContents = fs.readFileSync(preparedOptimizer);
fs.appendFileSync(preparedOptimizer, "tampered\n");
const rejectedDriftedStage = spawnSync("/usr/bin/python3", [
  stageScript,
  "--source-manifest", path.join(queue, "captioned-lora-manifest.json"),
  "--job-id", "cap-test-v3",
  "--runtime-root", runtimeRoot,
  "--base-link-config", configPath,
  "--caption-overlay-root", overlayRoot,
], { encoding: "utf8", timeout: 30000 });
assert.notEqual(rejectedDriftedStage.status, 0);
assert.match(rejectedDriftedStage.stderr, /does not match prepared hash evidence/);
fs.writeFileSync(preparedOptimizer, preparedOptimizerContents);

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
assert.equal(
  fs.readFileSync(
    path.join(path.dirname(runtimeManifest[0].data_dir), "targets", "sample.png"),
    "base64",
  ),
  image.toString("base64"),
);
assert.equal(
  fs.existsSync(path.join(runtimeManifest[0].data_dir, "aspect_ratio_bucket_metadata_old-job.json")),
  false,
);
assert.equal(
  fs.existsSync(path.join(runtimeManifest[0].conditioning_dir, "aspect_ratio_bucket_indices_old-job.json")),
  false,
);
assert.equal(fs.existsSync(path.join(runtimeManifest[0].conditioning_dir, "sample.txt")), false);
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
assert.equal(runtimeLinkConfig.training.max_train_attempts, 7);
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
  ["cap-test-v3"],
);

const second = spawnSync("/usr/bin/python3", [
  stageScript,
  "--source-manifest", path.join(queue, "captioned-lora-manifest.json"),
  "--job-id", "cap-test-v3",
  "--runtime-root", runtimeRoot,
  "--base-link-config", configPath,
  "--caption-overlay-root", overlayRoot,
], { encoding: "utf8", timeout: 30000 });
assert.equal(second.status, 0, second.stderr);
assert.equal(JSON.parse(second.stdout).already_present, true);

fs.writeFileSync(path.join(dataset, "aspect_ratio_bucket_indices_new-cache.json"), "{}\n");
fs.writeFileSync(path.join(conditioning, "aspect_ratio_bucket_metadata_new-cache.json"), "{}\n");
const afterSourceCacheMutation = spawnSync("/usr/bin/python3", [
  stageScript,
  "--source-manifest", path.join(queue, "captioned-lora-manifest.json"),
  "--job-id", "cap-test-v3",
  "--runtime-root", runtimeRoot,
  "--base-link-config", configPath,
  "--caption-overlay-root", overlayRoot,
], { encoding: "utf8", timeout: 30000 });
assert.equal(afterSourceCacheMutation.status, 0, afterSourceCacheMutation.stderr);
assert.equal(JSON.parse(afterSourceCacheMutation.stdout).already_present, true);
assert.equal(JSON.parse(afterSourceCacheMutation.stdout).runtime_job_root, JSON.parse(second.stdout).runtime_job_root);

const stagedRoot = JSON.parse(second.stdout).runtime_job_root;
fs.rmSync(path.join(stagedRoot, "STAGE-MANIFEST.json"));
fs.writeFileSync(path.join(stagedRoot, "partial-attempt-marker"), "incomplete\n");
const recovered = spawnSync("/usr/bin/python3", [
  stageScript,
  "--source-manifest", path.join(queue, "captioned-lora-manifest.json"),
  "--job-id", "cap-test-v3",
  "--runtime-root", runtimeRoot,
  "--base-link-config", configPath,
  "--caption-overlay-root", overlayRoot,
], { encoding: "utf8", timeout: 30000 });
assert.equal(recovered.status, 0, recovered.stderr);
assert.equal(JSON.parse(recovered.stdout).staged, true);
assert.equal(fs.existsSync(path.join(stagedRoot, "partial-attempt-marker")), false);
assert.equal(fs.existsSync(path.join(stagedRoot, "STAGE-MANIFEST.json")), true);
process.stdout.write("LoRA runtime staging test passed\n");
