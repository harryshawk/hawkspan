#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-readiness-policy-"));
const dataset = path.join(root, "dataset");
fs.mkdirSync(dataset);
fs.writeFileSync(
  path.join(dataset, "robot.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
fs.writeFileSync(path.join(dataset, "robot.txt"), "hawkspan robots, Hawk linked to Span\n");

const configPath = path.join(root, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  database_path: path.join(root, "state.sqlite"),
  artifact_root: path.join(root, "artifacts"),
  inbox_root: path.join(root, "inbox"),
  outbox_root: path.join(root, "outbox"),
}));

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "lora-automation.mjs");
const env = { ...process.env, HAWKSPAN_CONFIG: configPath };
function preflight(options) {
  return JSON.parse(execFileSync(process.execPath, [
    script,
    "preflight",
    JSON.stringify({ path: dataset, expected_caption_variants: 1, ...options }),
  ], { env, encoding: "utf8" }));
}

const generic = preflight({
  required_trigger: "hawkspan robots",
  required_caption_sections: [],
});
assert.equal(generic.valid, true);
assert.equal(generic.image_count, 1);
assert.equal(generic.caption_count, 1);

const defaultPolicy = preflight({ required_trigger: "hawkspan robots" });
assert.equal(defaultPolicy.valid, true);

const unknown = spawnSync(process.execPath, [
  script,
  "preflight",
  JSON.stringify({ path: dataset, required_caption_sections: ["invalid:section"] }),
], { env, encoding: "utf8" });
assert.notEqual(unknown.status, 0);
assert.match(unknown.stderr, /invalid caption section/);

const queueRoot = path.join(root, "policy-queue");
const configDir = path.join(queueRoot, "configs", "policy-job");
const outputDir = path.join(queueRoot, "outputs", "policy-job");
const conditioningDir = path.join(queueRoot, "conditioning", "policy-job");
const cacheRoot = path.join(queueRoot, "cache", "policy-job");
const manifestRoot = path.join(queueRoot, "manifests");
const simpletunerRoot = path.join(root, "simpletuner");
for (const directory of [
  configDir, outputDir, conditioningDir, cacheRoot, manifestRoot,
  path.join(simpletunerRoot, ".venv/bin"),
]) fs.mkdirSync(directory, { recursive: true });
fs.copyFileSync(path.join(dataset, "robot.png"), path.join(conditioningDir, "robot.png"));

const backendPath = path.join(configDir, "multidatabackend.json");
const trainingConfigPath = path.join(configDir, "config.json");
const policyPath = path.join(configDir, "TRAINING_READINESS_POLICY.json");
const validationPath = path.join(configDir, "validation-prompts.json");
fs.writeFileSync(backendPath, JSON.stringify([
  {
    id: "policy-images",
    type: "local",
    dataset_type: "image",
    instance_data_dir: dataset,
    caption_strategy: "textfile",
    disable_multiline_split: false,
    crop_style: "center",
    crop_aspect: "square",
    cache_dir_vae: path.join(cacheRoot, "vae"),
    conditioning: { instance_data_dir: conditioningDir, type: "canny" },
  },
  {
    id: "policy-text",
    type: "local",
    dataset_type: "text_embeds",
    cache_dir: path.join(cacheRoot, "text"),
  },
]));
fs.writeFileSync(trainingConfigPath, JSON.stringify({
  controlnet: true,
  data_backend_config: backendPath,
  output_dir: outputDir,
  checkpoints_total_limit: 3,
  checkpoint_step_interval: 1,
  max_train_steps: 1,
}));
fs.writeFileSync(validationPath, JSON.stringify({ prompts: [] }));
fs.writeFileSync(policyPath, JSON.stringify({
  version_tag: "policy",
  expected_caption_variants: 1,
  required_trigger: "hawkspan robots",
  required_caption_sections: [],
  allowed_crop_styles: ["center"],
  allowed_crop_aspects: ["square"],
  minimum_checkpoint_retention: 3,
  minimum_free_bytes: 1,
  validation_prompt_library: validationPath,
  required_validation_prompt_ids: [],
}));
fs.writeFileSync(path.join(queueRoot, "captioned-lora-manifest.json"), JSON.stringify([{
  job_id: "policy-job",
  data_dir: dataset,
  config_dir: configDir,
  output_dir: outputDir,
}]));
const fakePython = path.join(simpletunerRoot, ".venv/bin/python");
fs.writeFileSync(fakePython, "#!/bin/sh\nprintf '%s\\n' '{\"python\":\"test\",\"platform\":\"test\",\"torch\":\"test\",\"mps_built\":true,\"mps_available\":true,\"packages\":{}}'\n", { mode: 0o755 });
fs.writeFileSync(configPath, JSON.stringify({
  database_path: path.join(root, "state.sqlite"),
  artifact_root: path.join(root, "artifacts"),
  inbox_root: path.join(root, "inbox"),
  outbox_root: path.join(root, "outbox"),
  lora_automation: {
    queue_root: queueRoot,
    output_root: outputDir,
    manifest_root: manifestRoot,
    simpletuner_root: simpletunerRoot,
  },
}));

function readiness(options = {}) {
  return JSON.parse(execFileSync(process.execPath, [
    script, "training-readiness", JSON.stringify({ job_id: "policy-job", ...options }),
  ], { env, encoding: "utf8" }));
}
const bound = readiness();
assert.equal(bound.ready, true);
assert.equal(bound.conditioning.control_image_count, 1);
assert.equal(bound.conditioning.target_image_count, 1);
const firstFingerprint = bound.revision_fingerprint;

const queueSupervisor = spawn(process.execPath, [
  "-e", "setTimeout(() => {}, 60000)",
  "call-tool.mjs", "supervise_queue", "simpletuner-training",
], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 250));
try {
  assert.equal(readiness().ready, true);
} finally {
  queueSupervisor.kill();
}

const ownGroupRunner = spawn(process.execPath, [
  "-e", "setTimeout(() => {}, 60000)", "run_captioned_loras.py",
], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 250));
try {
  const blockedByRunner = readiness();
  assert.equal(blockedByRunner.ready, false);
  assert.ok(blockedByRunner.problems.some(
    (problem) => problem.issue === "training_already_active",
  ));
  const ownProcessGroup = Number(execFileSync("ps", [
    "-p", String(process.pid), "-o", "pgid=",
  ], { encoding: "utf8" }).trim());
  const ignoredOwnRunner = readiness({ ignore_process_group: ownProcessGroup });
  assert.equal(ignoredOwnRunner.ready, true);
} finally {
  ownGroupRunner.kill();
}

fs.appendFileSync(path.join(conditioningDir, "robot.png"), "revision-change");
const changed = readiness();
assert.notEqual(changed.revision_fingerprint, firstFingerprint);
fs.renameSync(
  path.join(conditioningDir, "robot.png"),
  path.join(conditioningDir, "different.png"),
);
const mismatched = readiness();
assert.equal(mismatched.ready, false);
assert.ok(mismatched.problems.some(
  (problem) => problem.issue === "controlnet_conditioning_pair_mismatch",
));

process.stdout.write("LoRA readiness policy tests passed\n");
