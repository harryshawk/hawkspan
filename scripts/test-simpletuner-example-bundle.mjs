#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApplicationWorkflows } from "../examples/plugins/application-workflows/plugin.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.HAWKSPAN_SIMPLETUNER_EXAMPLE_ROOT
  ? path.resolve(process.env.HAWKSPAN_SIMPLETUNER_EXAMPLE_ROOT)
  : path.join(repository, "examples", "simpletuner", "hawkspan-robots");
const write = process.argv.includes("--write-manifests");
const trigger = "hawkspan robots,";
const captionCategories = [
  "Literal visible facts",
  "Visible physical interaction and action",
  "Composition and technical visual details",
  "Scene story beat with concrete HawkSpan function",
  "Artistic style and concise tags",
  "Emotional subtext and characterization shown through behavior",
  "Robot type and design",
];
const expectedTokenizerModel = "stabilityai/stable-diffusion-xl-base-1.0";
const expectedTokenizerRevision = "462165984030d82259a11f4367a4eed129e94a7b";
const expectedTokenizerRows = 140;
const expectedMaximumTokens = 71;
const expectedTotalTokens = 8673;

function sha256(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function json(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function regularFiles(relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function jpegDimensions(target) {
  const data = fs.readFileSync(target);
  assert.equal(data.readUInt16BE(0), 0xffd8, `${target} is not a JPEG`);
  let offset = 2;
  while (offset + 9 < data.length) {
    while (offset < data.length && data[offset] !== 0xff) offset += 1;
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    const marker = data[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = data.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw new Error(`JPEG dimensions not found: ${target}`);
}

function pngDimensions(target) {
  const data = fs.readFileSync(target);
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${target} is not a PNG`);
  assert.equal(data.subarray(12, 16).toString("ascii"), "IHDR", `${target} has no PNG IHDR`);
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

function captionRows(target) {
  const rows = fs.readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean);
  assert.equal(rows.length, 7, `${target} must contain exactly seven non-empty rows`);
  for (const row of rows) assert.ok(row.startsWith(trigger), `${target} row lacks the trigger`);
  return rows;
}

function captionBundleHash(captions) {
  const digest = crypto.createHash("sha256");
  for (const target of captions) {
    digest.update(path.basename(target), "utf8");
    digest.update("\0");
    digest.update(fs.readFileSync(target));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function exactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has an unexpected structure`);
}

function canonicalReview(lora, corpusHash) {
  const lines = [
    "# HawkSpan Robot Caption Review",
    "",
    "This is the canonical, automatically synchronized text review reconstructed from the 20 LoRA caption sidecars.",
    "",
    `Caption corpus SHA-256: \`${corpusHash}\``,
    "",
  ];
  for (const item of lora.files) {
    const rows = captionRows(path.join(root, "lora", item.caption));
    lines.push(`## ${item.basename}`, "");
    for (let index = 0; index < rows.length; index += 1) {
      lines.push(`### ${index + 1}. ${captionCategories[index]}`, "", rows[index], "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function reviewReceipt(corpusHash, canonicalText) {
  const pdf = "review/HawkSpan-Robot-Caption-Review-Text-Only.pdf";
  return {
    schema_version: 1,
    caption_bundle_sha256: corpusHash,
    canonical_review: {
      path: "review/HawkSpan-Robot-Caption-Review.md",
      sha256: crypto.createHash("sha256").update(canonicalText, "utf8").digest("hex"),
    },
    convenience_pdf: {
      path: pdf,
      sha256: sha256(path.join(root, pdf)),
      validation: "hash-bound convenience artifact; content is not parsed in automated validation",
    },
  };
}

function walk(relative = "") {
  const directory = path.join(root, relative);
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    const target = path.join(root, child);
    const stat = fs.lstatSync(target);
    assert.ok(!stat.isSymbolicLink(), `symlink rejected: ${child}`);
    assert.ok(stat.isDirectory() || stat.isFile(), `special file rejected: ${child}`);
    assert.ok(entry.name !== ".DS_Store" && !entry.name.startsWith("._"), `Apple metadata rejected: ${child}`);
    if (stat.isDirectory()) found.push(...walk(child));
    else found.push(child.split(path.sep).join("/"));
  }
  return found.sort();
}

function loraManifest() {
  const dataset = path.join(root, "lora", "dataset");
  const files = [];
  for (let index = 1; index <= 20; index += 1) {
    const stem = `hawkspan-robot-${String(index).padStart(3, "0")}`;
    const image = path.join(dataset, `${stem}.jpg`);
    const caption = path.join(dataset, `${stem}.txt`);
    assert.deepEqual(jpegDimensions(image), [1280, 1280], `${stem} must be 1280 square`);
    captionRows(caption);
    files.push({
      basename: stem,
      image: `dataset/${stem}.jpg`,
      image_sha256: sha256(image),
      caption: `dataset/${stem}.txt`,
      caption_sha256: sha256(caption),
      width: 1280,
      height: 1280,
      mime_type: "image/jpeg",
    });
  }
  return {
    schema_version: 1,
    dataset_id: "hawkspan-robot-acceptance",
    purpose: "public reproducible acceptance and demonstration set; not a production-quality general model",
    trigger: "hawkspan robots",
    image_count: 20,
    caption_count: 20,
    caption_alternatives_per_image: 7,
    caption_alternative_count: 140,
    files,
  };
}

function controlnetManifest(lora) {
  const targets = path.join(root, "controlnet", "dataset", "targets");
  const controls = path.join(root, "controlnet", "dataset", "conditioning");
  const pairs = lora.files.map((source) => {
    const stem = source.basename;
    const target = path.join(targets, `${stem}.jpg`);
    const targetCaption = path.join(targets, `${stem}.txt`);
    const conditioning = path.join(controls, `${stem}.png`);
    const conditioningCaption = path.join(controls, `${stem}.txt`);
    assert.deepEqual(jpegDimensions(target), [1280, 1280]);
    assert.deepEqual(pngDimensions(conditioning), [1280, 1280]);
    assert.equal(sha256(target), source.image_sha256, `${stem} target differs from LoRA source`);
    assert.equal(sha256(targetCaption), source.caption_sha256, `${stem} target caption differs`);
    assert.equal(sha256(conditioningCaption), source.caption_sha256, `${stem} conditioning caption differs`);
    return {
      basename: stem,
      target: `dataset/targets/${stem}.jpg`,
      target_sha256: sha256(target),
      target_caption: `dataset/targets/${stem}.txt`,
      target_caption_sha256: sha256(targetCaption),
      conditioning: `dataset/conditioning/${stem}.png`,
      conditioning_sha256: sha256(conditioning),
      conditioning_caption: `dataset/conditioning/${stem}.txt`,
      conditioning_caption_sha256: sha256(conditioningCaption),
      width: 1280,
      height: 1280,
    };
  });
  return {
    schema_version: 1,
    dataset_id: "hawkspan-robot-controlnet-acceptance-v1",
    purpose: "public reproducible SDXL ControlNet LoRA pipeline demonstration; not a production-quality general model",
    target_count: 20,
    conditioning_count: 20,
    caption_count: 40,
    pairing: "matching basenames in targets and conditioning directories",
    canny: {
      generator: "tools/generate_canny.py",
      implementation: "OpenCV 4.9.0",
      conversion: "cv2.COLOR_BGR2GRAY",
      low_threshold: 100,
      high_threshold: 200,
      output: "three-channel 8-bit RGB-compatible PNG",
      png_compression: 9,
    },
    pairs,
  };
}

function assertConfiguration() {
  const requiredCheckpoints = [600, 900];
  for (const example of ["lora", "controlnet"]) {
    const policy = json(`${example}/config/hawkspan-workflow-policy.json`);
    assert.deepEqual(policy.checkpoint_steps, requiredCheckpoints);
    assert.equal(policy.features.local_trainer_start, true);
    assert.equal(policy.features.local_trainer_stop, true);
    assert.equal(policy.features.local_trainer_package, true);
    assert.equal(policy.local_trainer.timeout_ms, 30000);
    assert.equal(policy.local_trainer.package_timeout_ms, 60 * 60 * 1000);
    assert.equal(Object.hasOwn(policy, "rest"), false);
    const backend = json(`${example}/config/multidatabackend.template.json`);
    const imageBackends = backend.filter((item) => item.type === "local" && item.dataset_type === "image");
    const textBackends = backend.filter((item) => item.dataset_type === "text_embeds");
    assert.equal(imageBackends.length, 1, `${example} must define exactly one image backend`);
    assert.ok(textBackends.length >= 1, `${example} must define a text-embedding backend`);
    for (const entry of imageBackends) {
      assert.equal(entry.caption_strategy, "textfile");
      assert.equal(entry.disable_multiline_split, false);
      assert.ok(Number.isSafeInteger(entry.repeats) && entry.repeats > 0,
        `${example} image backend must explicitly satisfy the readiness repeat contract`);
      if (entry.maximum_image_size !== undefined) {
        assert.ok(Number(entry.target_downsample_size) > 0,
          `${example} maximum_image_size must have a target_downsample_size`);
      }
    }
    const recipe = json(`${example}/config/recipe.template.json`);
    assert.equal(recipe.config.model_family, "sdxl");
    assert.equal(recipe.config.model_type, "lora");
    assert.equal(recipe.config.optimizer, "adamw_bf16", `${example} must declare the proven M4 optimizer`);
    assert.equal(recipe.config.mixed_precision, "bf16", `${example} must declare the matching M4 precision`);
    assert.ok(Number.isSafeInteger(recipe.config.max_train_steps) && recipe.config.max_train_steps >= 900);
    const checkpointAliases = ["checkpoint_step_interval", "checkpointing_steps"]
      .filter((name) => Object.hasOwn(recipe.config, name));
    const validationAliases = ["validation_step_interval", "validation_steps"]
      .filter((name) => Object.hasOwn(recipe.config, name));
    assert.equal(checkpointAliases.length, 1,
      `${example} must declare exactly one checkpoint interval alias; simultaneous aliases are invalid`);
    assert.equal(validationAliases.length, 1,
      `${example} must declare exactly one validation interval alias; simultaneous aliases are invalid`);
    assert.equal(checkpointAliases[0], "checkpoint_step_interval",
      `${example} must use canonical checkpoint_step_interval`);
    assert.equal(validationAliases[0], "validation_step_interval",
      `${example} must use canonical validation_step_interval`);
    const checkpointInterval = recipe.config.checkpoint_step_interval;
    const validationInterval = recipe.config.validation_step_interval;
    assert.ok(Number.isSafeInteger(checkpointInterval) && checkpointInterval > 0, `${example} checkpoint interval must be positive`);
    assert.ok(Number.isSafeInteger(validationInterval) && validationInterval > 0, `${example} validation interval must be positive`);
    for (const milestone of requiredCheckpoints) {
      assert.equal(milestone % checkpointInterval, 0, `${example} checkpoint interval does not produce milestone ${milestone}`);
      assert.equal(milestone % validationInterval, 0, `${example} validation interval does not align with milestone ${milestone}`);
    }
    const retainedFromFirstRequired = Math.floor(requiredCheckpoints.at(-1) / checkpointInterval)
      - Math.ceil(requiredCheckpoints[0] / checkpointInterval) + 1;
    assert.ok(Number.isSafeInteger(recipe.config.checkpoints_total_limit)
      && recipe.config.checkpoints_total_limit >= retainedFromFirstRequired,
    `${example} checkpoints_total_limit cannot retain both 600 and 900`);
    assert.ok(recipe.config.output_dir.endsWith(example === "lora" ? "/hawkspan-robot-acceptance-run" : "/hawkspan-robot-controlnet-acceptance-v1"));
  }
  const loraRecipe = json("lora/config/recipe.template.json");
  assert.equal(loraRecipe.config.lora_type, "standard",
    "release/Draw Things acceptance must produce a conventional LoRA");
  assert.equal(Object.hasOwn(loraRecipe.config, "controlnet"), false,
    "release/Draw Things acceptance must not train a ControlNet adapter");
  const loraBackend = json("lora/config/multidatabackend.template.json");
  assert.equal(loraBackend.find((entry) => entry.dataset_type === "image").repeats, 1);
  const backend = json("controlnet/config/multidatabackend.template.json");
  const targets = backend.find((item) => item.dataset_type === "image");
  const conditioning = targets.conditioning;
  assert.equal(conditioning.type, "canny");
  assert.equal(targets.repeats, 1);
  assert.equal(conditioning.conditioning_type, "controlnet");
  assert.ok(conditioning.instance_data_dir.endsWith("/conditioning"));
  const recipe = json("controlnet/config/recipe.template.json");
  assert.equal(recipe.config.controlnet, true);
  assert.equal(recipe.config.lora_type, "loha",
    "SimpleTuner ControlNet training must declare its actual PEFT LoHa format");
  assert.equal(recipe.config.eval_dataset_id, `${targets.id}_conditioning_${conditioning.type}`);
  assert.equal(recipe.config.optimizer, "adamw_bf16");
  assert.equal(recipe.config.mixed_precision, "bf16");
  assert.equal(recipe.config.num_train_epochs, 0);
  const map = json("controlnet/config/validation-prompts.json");
  assert.equal(map.trigger, "hawkspan robots");
  assert.equal(map.prompts.length, 4);
  for (const item of map.prompts) {
    assert.ok(fs.existsSync(path.join(root, "controlnet", "dataset", item.control_image)));
    assert.ok(fs.existsSync(path.join(root, "controlnet", "dataset", item.source_target)));
    assert.match(item.prompt, /left robot Hawk with a readable Hawk nameplate/);
    assert.match(item.prompt, /right robot Span with a readable Span nameplate/);
    assert.match(item.prompt, /physical span visibly/);
    assert.doesNotMatch(item.prompt, /no (?:readable )?(?:words|logos)/i);
  }
}

async function assertReleaseLoraReadiness() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-public-lora-readiness-"));
  try {
    const roots = Object.fromEntries(["inbox", "datasets", "recipes", "output", "state", "disk", "runtime", "logs"]
      .map((name) => [name, path.join(temporary, name)]));
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true });
    const datasetId = "hawkspan-robot-lora-acceptance-v1";
    const jobId = "public-lora-readiness";
    const dataset = path.join(roots.datasets, datasetId);
    fs.cpSync(path.join(root, "lora", "dataset"), dataset, { recursive: true });

    const recipe = json("lora/config/recipe.template.json");
    recipe.config.pretrained_model_name_or_path = expectedTokenizerModel;
    recipe.config.data_backend_config = path.join(roots.recipes, `${datasetId}.multidatabackend.json`);
    recipe.config.output_dir = path.join(roots.output, jobId);
    const backend = json("lora/config/multidatabackend.template.json");
    for (const entry of backend) {
      if (entry.dataset_type === "image") {
        entry.instance_data_dir = dataset;
        entry.cache_dir_vae = path.join(temporary, "source-cache", "vae");
      } else if (entry.dataset_type === "text_embeds") {
        entry.cache_dir = path.join(temporary, "source-cache", "text");
      }
    }
    const documents = {
      [`${datasetId}.json`]: recipe,
      [`${datasetId}.multidatabackend.json`]: backend,
      [`${datasetId}.policy.json`]: json("lora/config/hawkspan-workflow-policy.json"),
      [`${datasetId}.validation-prompts.json`]: json("lora/config/validation-prompts.json"),
    };
    for (const [name, value] of Object.entries(documents)) {
      fs.writeFileSync(path.join(roots.recipes, name), `${JSON.stringify(value, null, 2)}\n`);
    }
    const environment = {
      HAWKSPAN_WORKLOAD_INBOX_ROOT: roots.inbox,
      HAWKSPAN_WORKLOAD_DATASET_ROOT: roots.datasets,
      HAWKSPAN_WORKLOAD_RECIPE_ROOT: roots.recipes,
      HAWKSPAN_WORKLOAD_OUTPUT_ROOT: roots.output,
      HAWKSPAN_WORKLOAD_STATE_ROOT: roots.state,
      HAWKSPAN_WORKLOAD_DISK_ROOT: roots.disk,
      HAWKSPAN_WORKLOAD_RUNTIME_ROOT: roots.runtime,
      HAWKSPAN_WORKLOAD_LOG_ROOT: roots.logs,
    };
    const workflows = createApplicationWorkflows({
      mode: "simpletuner-workflows",
      role: "worker",
      features: { inspect: true, stage: true, validate: true },
      paths: Object.fromEntries(Object.entries({
        inbox_root: "INBOX", dataset_root: "DATASET", recipe_root: "RECIPE", output_root: "OUTPUT",
        state_root: "STATE", disk_root: "DISK", runtime_root: "RUNTIME", log_root: "LOG",
      }).map(([key, suffix]) => [key, { env: `HAWKSPAN_WORKLOAD_${suffix}_ROOT` }])),
      limits: { max_files: 10000, max_total_bytes: 107374182400, max_json_bytes: 16777216 },
      required_job: { kind_prefix: "simpletuner-workflow", state: "authorized" },
    }, {
      environment,
      require_authorized_job: (requirement) => requirement,
      call_core_tool: async () => { throw new Error("core tools are not used by readiness or staging"); },
    });
    const recipePath = path.join(roots.recipes, `${datasetId}.json`);
    const readiness = await workflows.training_readiness({
      job_id: jobId,
      dataset_id: datasetId,
      recipe_id: datasetId,
      recipe_revision: sha256(recipePath),
    });
    assert.equal(readiness.ready, true, JSON.stringify(readiness.problems));
    assert.deepEqual(readiness.problems, []);
    assert.equal(readiness.image_count, 20);
    assert.equal(readiness.caption_count, 20);
    const staged = await workflows.training_stage_runtime_job({ job_id: jobId, dataset_id: datasetId, recipe_id: datasetId });
    assert.equal(staged.ready, true, JSON.stringify(staged.problems));
    const stagedRecipe = JSON.parse(fs.readFileSync(path.join(staged.runtime_job_root, "config", "config.json"), "utf8"));
    assert.equal(stagedRecipe.lora_type, "standard");
    assert.equal(Object.hasOwn(stagedRecipe, "controlnet"), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const files = walk();
assert.ok(files.includes("review/HawkSpan-Robot-Caption-Review-Text-Only.pdf"));
assert.ok(!files.some((item) => /\.docx$/i.test(item) || /Caption-Review\.pdf$/.test(item)));
assert.equal(regularFiles("lora/dataset").length, 40);
assert.equal(regularFiles("controlnet/dataset/targets").length, 40);
assert.equal(regularFiles("controlnet/dataset/conditioning").length, 40);

const lora = loraManifest();
const rows = lora.files.flatMap((item) => captionRows(path.join(root, "lora", item.caption)));
assert.equal(rows.length, 140);
assert.equal(new Set(rows).size, 140, "all caption alternatives must be image-specific and unique");
for (const row of rows) {
  assert.match(row, /\bHawk\b/, "every caption alternative must identify Hawk");
  assert.match(row, /\bSpan\b/, "every caption alternative must identify Span");
  assert.match(row, /distinct connecting span is visible/, "every caption alternative must teach the visible span");
}
assert.equal(rows.filter((row) => /readable Hawk nameplate/.test(row)).length, 19 * 7,
  "all caption alternatives except the full rear view must teach readable nameplates");
assert.equal(rows.filter((row) => /Hawk is left and Span is right in rear view/.test(row)).length, 7,
  "the one full rear view must use its truthful nameplate exception");
const corpusHash = captionBundleHash(lora.files.map((item) => path.join(root, "lora", item.caption)));
const tokenReceipt = json("caption-tokenizer-validation.json");
exactKeys(tokenReceipt, ["schema_version", "model", "model_revision", "caption_bundle_sha256", "caption_row_count", "token_ceiling", "tokenizers"], "tokenizer receipt");
assert.equal(tokenReceipt.schema_version, 1);
assert.equal(tokenReceipt.model, expectedTokenizerModel);
assert.equal(tokenReceipt.model_revision, expectedTokenizerRevision);
assert.equal(tokenReceipt.caption_bundle_sha256, corpusHash);
assert.equal(tokenReceipt.caption_row_count, 140);
assert.equal(tokenReceipt.token_ceiling, 77);
exactKeys(tokenReceipt.tokenizers, ["tokenizer", "tokenizer_2"], "tokenizer receipt tokenizers");
for (const name of ["tokenizer", "tokenizer_2"]) {
  const result = tokenReceipt.tokenizers[name];
  exactKeys(result, ["validated_rows", "maximum_tokens", "total_tokens"], `${name} result`);
  assert.equal(result.validated_rows, expectedTokenizerRows, `${name} must cover all 140 rows`);
  assert.equal(result.maximum_tokens, expectedMaximumTokens, `${name} recorded maximum is not the reviewed value`);
  assert.ok(result.maximum_tokens <= tokenReceipt.token_ceiling, `${name} exceeds the tokenizer ceiling`);
  assert.equal(result.total_tokens, expectedTotalTokens, `${name} recorded total is not the reviewed value`);
}

const controlnet = controlnetManifest(lora);
const controlnetCompatibilityPatch = fs.readFileSync(
  path.join(root, "controlnet", "compat", "simpletuner-4.5-controlnet-pixels.patch"),
  "utf8",
);
assert.match(controlnetCompatibilityPatch, /needs_reference_pixels or StateTracker\.get_args\(\)\.controlnet/);
assert.equal((controlnetCompatibilityPatch.match(/^\+\s+if latent_source_backends/gm) || []).length, 1);
const installedCompatibilityPatchPath = path.join(
  path.dirname(root), "..", "plugins", "application-workflows", "bin", "compat", "simpletuner-4.5-controlnet-pixels.patch",
);
if (fs.existsSync(installedCompatibilityPatchPath)) {
  assert.equal(fs.readFileSync(installedCompatibilityPatchPath, "utf8"), controlnetCompatibilityPatch);
}
const validationCompatibilityPatch = fs.readFileSync(
  path.join(root, "controlnet", "compat", "simpletuner-4.5-sdxl-controlnet-validation.patch"),
  "utf8",
);
assert.match(validationCompatibilityPatch, /getattr\(self\.unet\.config, "time_cond_proj_dim", None\)/);
assert.match(validationCompatibilityPatch, /self\.model\.unwrap_model\(model=self\.model\.model\)/);
const installedValidationPatchPath = path.join(
  path.dirname(root), "..", "plugins", "application-workflows", "bin", "compat", "simpletuner-4.5-sdxl-controlnet-validation.patch",
);
if (fs.existsSync(installedValidationPatchPath)) {
  assert.equal(fs.readFileSync(installedValidationPatchPath, "utf8"), validationCompatibilityPatch);
}
const canonicalText = canonicalReview(lora, corpusHash);
const expectedReviewReceipt = reviewReceipt(corpusHash, canonicalText);
if (write) {
  fs.writeFileSync(path.join(root, "lora", "manifest.json"), `${JSON.stringify(lora, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "controlnet", "manifest.json"), `${JSON.stringify(controlnet, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "review", "HawkSpan-Robot-Caption-Review.md"), canonicalText);
  fs.writeFileSync(path.join(root, "review", "review-receipt.json"), `${JSON.stringify(expectedReviewReceipt, null, 2)}\n`);
} else {
  assert.deepEqual(json("lora/manifest.json"), lora, "LoRA manifest does not match exact files");
  assert.deepEqual(json("controlnet/manifest.json"), controlnet, "ControlNet manifest does not match exact files");
  assert.equal(fs.readFileSync(path.join(root, "review", "HawkSpan-Robot-Caption-Review.md"), "utf8"), canonicalText,
    "canonical caption review is stale");
  assert.deepEqual(json("review/review-receipt.json"), expectedReviewReceipt,
    "review receipt has a wrong corpus binding, canonical hash, or PDF hash");
}

assertConfiguration();
await assertReleaseLoraReadiness();
const privateFragments = [
  "/" + "Users" + "/",
  "/" + "Volumes" + "/",
  "10" + ".44.",
  "019" + "f",
  "@" + "gmail.com",
];
for (const relative of files) {
  const bytes = fs.readFileSync(path.join(root, relative));
  for (const fragment of privateFragments) {
    const encodings = [
      Buffer.from(fragment, "utf8"),
      Buffer.from([...fragment].map((character) => `\0${character}`).join(""), "latin1"),
      Buffer.from([...fragment].map((character) => `${character}\0`).join(""), "latin1"),
    ];
    assert.ok(!encodings.some((needle) => bytes.includes(needle)), `private binary/text fragment in ${relative}`);
  }
}
const textual = files.filter((item) => /\.(?:md|json|mjs|py|txt)$/i.test(item));
const privatePatterns = [
  new RegExp("/" + "Users" + "/", "i"),
  new RegExp("/" + "Volumes" + "/", "i"),
  new RegExp("019" + "f[a-f0-9-]{12,}", "i"),
  new RegExp("10\\.44\\.", "i"),
  new RegExp("BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY", "i"),
];
for (const relative of textual) {
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  for (const pattern of privatePatterns) assert.ok(!pattern.test(text), `private pattern in ${relative}`);
}
const license = fs.readFileSync(path.join(root, "ASSET-LICENSE.md"), "utf8");
assert.match(license, /GPT Image 2/);
assert.match(license, /CC BY 4\.0/);
assert.match(license, /Apache License 2\.0/);

process.stdout.write(`hawkspan public SimpleTuner robot examples verified (${lora.image_count} LoRA images; ${controlnet.target_count} ControlNet pairs; ${rows.length} caption rows)\n`);
