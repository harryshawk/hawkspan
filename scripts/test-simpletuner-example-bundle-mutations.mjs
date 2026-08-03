#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repository, "examples", "simpletuner", "hawkspan-robots");
const validator = path.join(repository, "scripts", "test-simpletuner-example-bundle.mjs");

function mutateJson(root, relative, mutate) {
  const target = path.join(root, relative);
  const value = JSON.parse(fs.readFileSync(target, "utf8"));
  mutate(value);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function run(root) {
  return spawnSync(process.execPath, [validator], {
    cwd: repository,
    env: { ...process.env, HAWKSPAN_SIMPLETUNER_EXAMPLE_ROOT: root },
    encoding: "utf8",
  });
}

function rejects(name, expected, mutate) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-simpletuner-example-mutation-"));
  const root = path.join(temporary, "bundle");
  try {
    fs.cpSync(source, root, { recursive: true });
    mutate(root);
    const result = run(root);
    assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
    assert.match(`${result.stdout}\n${result.stderr}`, expected, `${name} failed for the wrong reason`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

assert.equal(run(source).status, 0, "unmodified public example must pass before mutation tests");

rejects("insufficient checkpoint retention", /cannot retain both 600 and 900/, (root) => {
  mutateJson(root, "lora/config/recipe.template.json", (value) => { value.config.checkpoints_total_limit = 1; });
});

rejects("misaligned validation interval", /validation interval does not align with milestone/, (root) => {
  mutateJson(root, "controlnet/config/recipe.template.json", (value) => { value.config.validation_step_interval = 400; });
});

rejects("release LoRA changed to ControlNet", /must not train a ControlNet adapter/, (root) => {
  mutateJson(root, "lora/config/recipe.template.json", (value) => { value.config.controlnet = true; });
});

rejects("release LoRA changed to LoHa", /must produce a conventional LoRA/, (root) => {
  mutateJson(root, "lora/config/recipe.template.json", (value) => { value.config.lora_type = "loha"; });
});

rejects("release LoRA repeats omitted", /image backend must explicitly satisfy the readiness repeat contract/, (root) => {
  mutateJson(root, "lora/config/multidatabackend.template.json", (value) => { delete value[0].repeats; });
});

rejects("release LoRA optimizer omitted", /must declare the proven M4 optimizer/, (root) => {
  mutateJson(root, "lora/config/recipe.template.json", (value) => { delete value.config.optimizer; });
});

rejects("release LoRA target downsample omitted", /maximum_image_size must have a target_downsample_size/, (root) => {
  mutateJson(root, "lora/config/multidatabackend.template.json", (value) => { delete value[0].target_downsample_size; });
});

rejects("release LoRA text backend omitted", /must define a text-embedding backend/, (root) => {
  mutateJson(root, "lora/config/multidatabackend.template.json", (value) => value.splice(1, 1));
});

rejects("ControlNet format mislabeled as standard LoRA", /must declare its actual PEFT LoHa format/, (root) => {
  mutateJson(root, "controlnet/config/recipe.template.json", (value) => { value.config.lora_type = "standard"; });
});

rejects("contradictory checkpoint aliases", /simultaneous aliases are invalid/, (root) => {
  mutateJson(root, "lora/config/recipe.template.json", (value) => { value.config.checkpointing_steps = 200; });
});

rejects("equal duplicate checkpoint aliases", /simultaneous aliases are invalid/, (root) => {
  mutateJson(root, "lora/config/recipe.template.json", (value) => { value.config.checkpointing_steps = 300; });
});

rejects("contradictory validation aliases", /simultaneous aliases are invalid/, (root) => {
  mutateJson(root, "controlnet/config/recipe.template.json", (value) => { value.config.validation_steps = 450; });
});

rejects("equal duplicate validation aliases", /simultaneous aliases are invalid/, (root) => {
  mutateJson(root, "controlnet/config/recipe.template.json", (value) => { value.config.validation_steps = 300; });
});

rejects("missing second SDXL tokenizer", /tokenizer receipt tokenizers has an unexpected structure/, (root) => {
  mutateJson(root, "caption-tokenizer-validation.json", (value) => { delete value.tokenizers.tokenizer_2; });
});

rejects("falsified tokenizer receipt structure", /tokenizer result has an unexpected structure/, (root) => {
  mutateJson(root, "caption-tokenizer-validation.json", (value) => { value.tokenizers.tokenizer.unreviewed = true; });
});

rejects("falsified tokenizer measurements", /recorded maximum is not the reviewed value/, (root) => {
  mutateJson(root, "caption-tokenizer-validation.json", (value) => { value.tokenizers.tokenizer.maximum_tokens = 41; });
});

rejects("stale canonical review", /canonical caption review is stale/, (root) => {
  fs.appendFileSync(path.join(root, "review", "HawkSpan-Robot-Caption-Review.md"), "\nstale\n");
});

rejects("wrong PDF hash", /review receipt has a wrong corpus binding, canonical hash, or PDF hash/, (root) => {
  mutateJson(root, "review/review-receipt.json", (value) => { value.convenience_pdf.sha256 = "0".repeat(64); });
});

rejects("wrong caption corpus binding", /review receipt has a wrong corpus binding, canonical hash, or PDF hash/, (root) => {
  mutateJson(root, "review/review-receipt.json", (value) => { value.caption_bundle_sha256 = "0".repeat(64); });
});

process.stdout.write("hawkspan SimpleTuner robot example mutation tests passed (19 fail-closed mutations)\n");
