#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stateRoot = process.env.HAWKSPAN_STATE_DIR
  ? path.resolve(process.env.HAWKSPAN_STATE_DIR)
  : path.join(os.homedir(), ".hawkspan");
const configPath = process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH
  ? path.resolve(process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH)
  : path.join(stateRoot, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const automation = config.lora_automation || {};
const imageExtensions = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff",
]);

function requiredPath(key) {
  const value = automation[key];
  if (!value) throw new Error(`lora_automation.${key} is not configured`);
  return path.resolve(value);
}

function readJson(filePath, fallback = null) {
  const resolved = path.resolve(filePath);
  const queueRoot = automation.queue_root
    ? path.resolve(automation.queue_root)
    : null;
  if (
    queueRoot &&
    (resolved === queueRoot || resolved.startsWith(`${queueRoot}${path.sep}`))
  ) {
    return readQueueJsonBounded(resolved, fallback);
  }
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : fallback;
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 30000,
    cwd: options.cwd,
    env: options.env || process.env,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error) : null,
  };
}

function readQueueJsonBounded(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  const reader = [
    "import json,signal,sys",
    "class ReadTimeout(Exception): pass",
    "def alarm_handler(signum, frame): raise ReadTimeout('timed out reading queue JSON')",
    "signal.signal(signal.SIGALRM, alarm_handler)",
    "signal.alarm(3)",
    "with open(sys.argv[1], 'r', encoding='utf-8') as handle: value=json.load(handle)",
    "signal.alarm(0)",
    "json.dump(value, sys.stdout, separators=(',', ':'))",
  ].join("\n");
  const result = run("/usr/bin/python3", ["-c", reader, filePath], {
    timeout: 5000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!result.ok) {
    throw new Error(
      `queue JSON unavailable: ${filePath}: ${
        result.stderr.trim() || result.error || `reader exited ${result.status}`
      }`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`invalid queue JSON: ${filePath}: ${error.message}`);
  }
}

function sha256(filePath) {
  const digest = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytes;
    do {
      bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes) digest.update(buffer.subarray(0, bytes));
    } while (bytes);
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

function walk(root, predicate = () => true) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && predicate(entryPath)) found.push(entryPath);
    }
  }
  return found.sort();
}

function directoryBytes(root) {
  return walk(root).reduce((total, filePath) => {
    try {
      return total + fs.statSync(filePath).size;
    } catch {
      return total;
    }
  }, 0);
}

function directoryRevisionSha256(root) {
  const target = path.resolve(root);
  return fileSetRevisionSha256(target, walk(target));
}

function fileSetRevisionSha256(root, filePaths) {
  const target = path.resolve(root);
  const digest = crypto.createHash("sha256");
  for (const filePath of [...filePaths].sort()) {
    const relative = path.relative(target, filePath);
    const stat = fs.statSync(filePath);
    digest.update(relative);
    digest.update("\0");
    digest.update(String(stat.size));
    digest.update("\0");
    digest.update(sha256(filePath));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function checkpointEvidence(checkpointPath) {
  const target = path.resolve(checkpointPath);
  const checkpointName = path.basename(target);
  const checkpointMatch = checkpointName.match(/^checkpoint-(\d+)$/);
  const required = [
    "pytorch_lora_weights.safetensors",
    "optimizer.bin",
    "scheduler.bin",
    "training_state.json",
  ];
  const exists = fs.existsSync(target) && fs.lstatSync(target).isDirectory();
  const files = {};
  const problems = [];
  if (!exists) problems.push("checkpoint_directory_missing_or_not_regular");
  if (!checkpointMatch) problems.push("checkpoint_basename_must_be_checkpoint_N");
  if (exists) {
    for (const name of required) {
      const filePath = path.join(target, name);
      if (!fs.existsSync(filePath)) {
        problems.push(`missing_required_file:${name}`);
        continue;
      }
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile()) {
        problems.push(`required_path_not_regular_file:${name}`);
        continue;
      }
      if (stat.size <= 0) {
        problems.push(`required_file_empty:${name}`);
        continue;
      }
      files[name] = {
        path: filePath,
        size_bytes: stat.size,
        sha256: sha256(filePath),
      };
    }
  }
  let trainingState = null;
  if (files["training_state.json"]) {
    try {
      trainingState = JSON.parse(fs.readFileSync(files["training_state.json"].path, "utf8"));
      if (!trainingState || typeof trainingState !== "object" || Array.isArray(trainingState)) {
        problems.push("training_state_json_must_be_an_object");
      }
    } catch {
      problems.push("training_state_json_invalid");
    }
  }
  const expectedStep = checkpointMatch ? Number(checkpointMatch[1]) : null;
  const globalStep = trainingState?.global_step;
  if (trainingState && (!Number.isSafeInteger(globalStep) || globalStep < 1)) {
    problems.push("training_state_global_step_invalid");
  } else if (trainingState && expectedStep !== null && globalStep !== expectedStep) {
    problems.push("checkpoint_basename_global_step_mismatch");
  }
  const complete = problems.length === 0;
  return {
    path: target,
    checkpoint_name: checkpointName,
    step: expectedStep,
    global_step: Number.isSafeInteger(globalStep) && globalStep > 0 ? globalStep : null,
    exists,
    complete,
    missing: problems.filter((problem) => problem.startsWith("missing_required_file:"))
      .map((problem) => problem.slice("missing_required_file:".length)),
    problems,
    required_files: files,
    bytes: exists ? directoryBytes(target) : 0,
    revision_sha256: complete
      ? directoryRevisionSha256(target)
      : null,
  };
}

function pathWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function canonicalPath(candidate) {
  const resolved = path.resolve(candidate);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function recoveryCheckpointProvenance(checkpointPath, sourceJob) {
  const checkpoint = canonicalPath(checkpointPath);
  const sourceOutput = canonicalPath(sourceJob.output_dir);
  const configuredPreservation = automation.preservation_root
    ? canonicalPath(path.join(
        automation.preservation_root,
        path.basename(sourceOutput),
        "PRESERVED_CHECKPOINTS",
      ))
    : null;
  const roots = [
    { kind: "source_output", path: sourceOutput },
    ...(configuredPreservation
      ? [{ kind: "source_job_preservation_root", path: configuredPreservation }]
      : []),
  ];
  const matched = roots.find((root) => pathWithin(checkpoint, root.path));
  if (!matched) {
    throw new Error(
      "recovery checkpoint must be under the source job output or configured preservation root",
    );
  }
  return {
    source_job_id: sourceJob.job_id,
    source_checkpoint_path: checkpoint,
    source_output_root: sourceOutput,
    configured_preservation_root: configuredPreservation,
    matched_root_kind: matched.kind,
    matched_root_path: matched.path,
  };
}

function imageMetadata(filePath) {
  const result = run("/usr/bin/sips", [
    "-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", filePath,
  ], { timeout: 30000 });
  const width = Number(result.stdout.match(/pixelWidth:\s*(\d+)/)?.[1] || 0);
  const height = Number(result.stdout.match(/pixelHeight:\s*(\d+)/)?.[1] || 0);
  const format = result.stdout.match(/format:\s*(\S+)/)?.[1] || null;
  return {
    valid: result.ok && width > 0 && height > 0,
    width,
    height,
    format,
    error: result.ok ? null : (result.stderr.trim() || "sips validation failed"),
  };
}

function structuredCaption(text, requiredSections) {
  const required = Array.isArray(requiredSections) ? requiredSections : [];
  const labels = {};
  for (const name of required) {
    if (!/^[A-Za-z0-9 _/-]+$/.test(name)) {
      throw new Error(`invalid caption section: ${name}`);
    }
    const expression = name
      .split(/[_ /-]+/)
      .filter(Boolean)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("(?:_|[ /-])");
    labels[name] = new RegExp(`${expression}\\s*:`, "i");
  }
  const present = Object.fromEntries(
    required.map((name) => [name, labels[name].test(text)]),
  );
  return { present, complete: Object.values(present).every(Boolean) };
}

function preflightDataset(datasetPath, writeManifest = false, options = {}) {
  const root = path.resolve(datasetPath);
  if (!fs.statSync(root).isDirectory()) throw new Error("dataset is not a directory");
  const images = walk(root, (filePath) =>
    imageExtensions.has(path.extname(filePath).toLowerCase()));
  const captions = walk(root, (filePath) => path.extname(filePath).toLowerCase() === ".txt");
  const captionByStem = new Map(captions.map((filePath) => [
    path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath))),
    filePath,
  ]));
  const hashes = new Map();
  const captionVariantOwners = new Map();
  const rows = [];
  const problems = [];
  for (const imagePath of images) {
    const stem = path.join(
      path.dirname(imagePath),
      path.basename(imagePath, path.extname(imagePath)),
    );
    const captionPath = captionByStem.get(stem) || null;
    const metadata = imageMetadata(imagePath);
    const digest = sha256(imagePath);
    const duplicateOf = hashes.get(digest) || null;
    if (!duplicateOf) hashes.set(digest, imagePath);
    const captionText = captionPath
      ? fs.readFileSync(captionPath, "utf8").trim()
      : "";
    const captionVariants = captionText
      ? captionText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : [];
    const structuredVariants = captionVariants.map((variant) =>
      structuredCaption(variant, options.required_caption_sections));
    for (const [index, variant] of captionVariants.entries()) {
      const owner = captionVariantOwners.get(variant);
      if (owner && owner.file !== path.relative(root, imagePath)) {
        problems.push({
          file: path.relative(root, imagePath),
          issue: "duplicate_caption_across_dataset",
          variant: index + 1,
          duplicate_of: owner.file,
          duplicate_variant: owner.variant,
        });
      } else if (!owner) {
        captionVariantOwners.set(variant, {
          file: path.relative(root, imagePath),
          variant: index + 1,
        });
      }
    }
    const captionStructure = structuredCaption(captionText, options.required_caption_sections);
    const row = {
      relative_path: path.relative(root, imagePath),
      size_bytes: fs.statSync(imagePath).size,
      sha256: digest,
      duplicate_of: duplicateOf ? path.relative(root, duplicateOf) : null,
      ...metadata,
      caption: captionPath ? path.relative(root, captionPath) : null,
      caption_bytes: Buffer.byteLength(captionText),
      caption_sha256: captionPath ? sha256(captionPath) : null,
      caption_variant_count: captionVariants.length,
      unique_caption_variant_count: new Set(captionVariants).size,
      structured_caption_variant_count: structuredVariants.filter((item) => item.complete).length,
      caption_structure: captionStructure,
    };
    rows.push(row);
    if (!metadata.valid) problems.push({ file: row.relative_path, issue: "corrupt_or_unreadable" });
    if (!captionPath) problems.push({ file: row.relative_path, issue: "missing_caption" });
    else if (!captionText) problems.push({ file: row.relative_path, issue: "empty_caption" });
    if (duplicateOf) problems.push({
      file: row.relative_path,
      issue: "duplicate_image",
      duplicate_of: row.duplicate_of,
    });
    if (captionText && !captionStructure.complete) problems.push({
      file: row.relative_path,
      issue: "caption_structure_incomplete",
      missing: Object.entries(captionStructure.present)
        .filter(([, present]) => !present).map(([name]) => name),
    });
    if (
      Number.isInteger(options.expected_caption_variants) &&
      captionVariants.length !== options.expected_caption_variants
    ) problems.push({
      file: row.relative_path,
      issue: "unexpected_caption_variant_count",
      expected: options.expected_caption_variants,
      actual: captionVariants.length,
    });
    if (captionVariants.length !== new Set(captionVariants).size) problems.push({
      file: row.relative_path,
      issue: "duplicate_caption_variant",
    });
    if (options.required_trigger && captionVariants.some(
      (caption) => !caption.includes(options.required_trigger),
    )) problems.push({
      file: row.relative_path,
      issue: "caption_variant_missing_trigger",
      required_trigger: options.required_trigger,
    });
    if (options.required_adult_phrase && captionVariants.some(
      (caption) => !caption.includes(options.required_adult_phrase),
    )) problems.push({
      file: row.relative_path,
      issue: "caption_variant_missing_adult_phrase",
      required_adult_phrase: options.required_adult_phrase,
    });
    if (options.required_adult_pattern) {
      let adultPattern;
      try {
        adultPattern = new RegExp(options.required_adult_pattern, "i");
      } catch (error) {
        throw new Error(`invalid required_adult_pattern: ${error.message}`);
      }
      if (captionVariants.some((caption) => !adultPattern.test(caption))) problems.push({
        file: row.relative_path,
        issue: "caption_variant_missing_adult_pattern",
        required_adult_pattern: options.required_adult_pattern,
      });
    }
  }
  const imageStems = new Set(images.map((filePath) => path.join(
    path.dirname(filePath),
    path.basename(filePath, path.extname(filePath)),
  )));
  for (const captionPath of captions) {
    const stem = path.join(
      path.dirname(captionPath),
      path.basename(captionPath, path.extname(captionPath)),
    );
    if (!imageStems.has(stem)) problems.push({
      file: path.relative(root, captionPath),
      issue: "orphan_caption",
    });
  }
  let tokenAudit = null;
  if (options.tokenizer_root) {
    const python = path.join(requiredPath("simpletuner_root"), ".venv/bin/python");
    const tokenAuditScript = path.join(
      path.dirname(path.resolve(process.argv[1])),
      "caption-token-audit.py",
    );
    const tokenResult = run(python, [
      tokenAuditScript,
      "--dataset", root,
      "--tokenizer-root", path.resolve(options.tokenizer_root),
      "--maximum-tokens", String(options.maximum_tokens || 77),
    ], { timeout: 120000 });
    if (!tokenResult.ok) {
      problems.push({
        file: ".",
        issue: "caption_token_audit_failed",
        error: tokenResult.stderr.trim() || tokenResult.error || "unknown tokenizer error",
      });
    } else {
      tokenAudit = JSON.parse(tokenResult.stdout);
      for (const violation of tokenAudit.over_limit || []) {
        problems.push({
          file: violation.caption,
          issue: "caption_variant_exceeds_token_limit",
          variant: violation.variant,
          token_counts: violation.token_counts,
          maximum_tokens: tokenAudit.maximum_tokens,
        });
      }
    }
  }
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    dataset: root,
    image_count: images.length,
    caption_count: captions.length,
    total_image_bytes: rows.reduce((total, row) => total + row.size_bytes, 0),
    dimensions: {
      minimum_width: rows.length ? Math.min(...rows.map((row) => row.width || 0)) : 0,
      maximum_width: rows.length ? Math.max(...rows.map((row) => row.width || 0)) : 0,
      minimum_height: rows.length ? Math.min(...rows.map((row) => row.height || 0)) : 0,
      maximum_height: rows.length ? Math.max(...rows.map((row) => row.height || 0)) : 0,
    },
    valid: images.length > 0 && problems.length === 0,
    problem_count: problems.length,
    problems,
    token_audit: tokenAudit,
    files: rows,
  };
  report.dataset_revision_sha256 = crypto.createHash("sha256")
    .update(JSON.stringify(rows.map((row) => ({
      relative_path: row.relative_path,
      image_sha256: row.sha256,
      caption: row.caption,
      caption_sha256: row.caption_sha256,
    }))))
    .digest("hex");
  if (writeManifest) {
    const manifestRoot = requiredPath("manifest_root");
    const manifestName = `${path.basename(root).replaceAll(/[^A-Za-z0-9._-]/g, "-")}` +
      `-${Date.now()}-preflight.json`;
    const manifestPath = path.join(manifestRoot, manifestName);
    atomicJson(manifestPath, report);
    report.manifest_path = manifestPath;
  }
  return report;
}

function manifestJob(jobId) {
  const queueRoot = requiredPath("queue_root");
  const manifestPath = path.join(queueRoot, "captioned-lora-manifest.json");
  const manifest = readJson(manifestPath, []);
  const matches = manifest.filter((entry) => entry.job_id === jobId);
  if (matches.length !== 1) {
    throw new Error(`job_id must match exactly one manifest entry: ${jobId}`);
  }
  return { job: matches[0], manifestPath };
}

function trainingReadiness(args) {
  const { job, manifestPath } = manifestJob(args.job_id);
  const configPath = path.join(job.config_dir, "config.json");
  const backendPath = path.join(job.config_dir, "multidatabackend.json");
  const policyPath = path.join(job.config_dir, "TRAINING_READINESS_POLICY.json");
  const configJson = readJson(configPath, null);
  const backendJson = readJson(backendPath, null);
  const policy = readJson(policyPath, null);
  const problems = [];
  if (!configJson) problems.push({ issue: "missing_or_invalid_config", file: configPath });
  if (!Array.isArray(backendJson)) {
    problems.push({ issue: "missing_or_invalid_data_backend", file: backendPath });
  }
  if (!policy) {
    problems.push({ issue: "missing_training_readiness_policy", file: policyPath });
  }

  const preflightOptions = policy ? {
    expected_caption_variants: Number(policy.expected_caption_variants),
    required_trigger: policy.required_trigger,
    required_adult_phrase: policy.required_adult_phrase,
    required_adult_pattern: policy.required_adult_pattern,
    required_caption_sections: policy.required_caption_sections,
    tokenizer_root: policy.tokenizer_root,
    maximum_tokens: Number(policy.maximum_tokens || 77),
  } : {};
  const dataset = preflightDataset(job.data_dir, true, preflightOptions);
  problems.push(...dataset.problems);

  const imageBackends = Array.isArray(backendJson)
    ? backendJson.filter((entry) =>
      entry.type === "local" && entry.dataset_type !== "text_embeds")
    : [];
  const textBackends = Array.isArray(backendJson)
    ? backendJson.filter((entry) => entry.dataset_type === "text_embeds")
    : [];
  if (imageBackends.length !== 1) {
    problems.push({
      issue: "expected_exactly_one_image_backend",
      actual: imageBackends.length,
    });
  }
  const imageBackend = imageBackends[0] || null;
  const textBackend = textBackends[0] || null;
  let conditioning = null;
  if (imageBackend) {
    if (path.resolve(imageBackend.instance_data_dir || "") !== path.resolve(job.data_dir)) {
      problems.push({ issue: "backend_dataset_path_mismatch" });
    }
    if (imageBackend.caption_strategy !== "textfile") {
      problems.push({ issue: "caption_strategy_must_be_textfile" });
    }
    if (imageBackend.disable_multiline_split !== false) {
      problems.push({ issue: "multiline_caption_selection_not_enabled" });
    }
    const allowedCropStyles = policy?.allowed_crop_styles || ["centre", "center", "face"];
    if (!allowedCropStyles.includes(
      String(imageBackend.crop_style || "").toLowerCase(),
    )) {
      problems.push({
        issue: "crop_policy_not_deliberately_preserving_subject",
        actual: imageBackend.crop_style || null,
      });
    }
    const allowedCropAspects = policy?.allowed_crop_aspects || ["preserve", "closest"];
    if (!allowedCropAspects.includes(
      String(imageBackend.crop_aspect || "").toLowerCase(),
    )) {
      problems.push({
        issue: "crop_aspect_not_preserving_source_composition",
        actual: imageBackend.crop_aspect || null,
      });
    }
    const conditioningPath = imageBackend.conditioning?.instance_data_dir
      ? path.resolve(imageBackend.conditioning.instance_data_dir)
      : null;
    if (conditioningPath) {
      const targetImages = walk(job.data_dir, (filePath) =>
        imageExtensions.has(path.extname(filePath).toLowerCase()));
      const controlImages = walk(conditioningPath, (filePath) =>
        imageExtensions.has(path.extname(filePath).toLowerCase()));
      const targetStems = new Set(targetImages.map((filePath) =>
        path.basename(filePath, path.extname(filePath))));
      const controlStems = new Set(controlImages.map((filePath) =>
        path.basename(filePath, path.extname(filePath))));
      const missingControls = [...targetStems].filter((stem) => !controlStems.has(stem));
      const unexpectedControls = [...controlStems].filter((stem) => !targetStems.has(stem));
      if (!fs.existsSync(conditioningPath) || !fs.statSync(conditioningPath).isDirectory()) {
        problems.push({ issue: "missing_controlnet_conditioning_directory", path: conditioningPath });
      } else if (
        targetImages.length !== controlImages.length ||
        missingControls.length || unexpectedControls.length
      ) {
        problems.push({
          issue: "controlnet_conditioning_pair_mismatch",
          target_images: targetImages.length,
          control_images: controlImages.length,
          missing_controls: missingControls,
          unexpected_controls: unexpectedControls,
        });
      }
      conditioning = {
        path: conditioningPath,
        target_image_count: targetImages.length,
        control_image_count: controlImages.length,
        revision_sha256: fs.existsSync(conditioningPath) &&
          fs.statSync(conditioningPath).isDirectory()
          ? fileSetRevisionSha256(conditioningPath, controlImages)
          : null,
      };
    } else if (configJson?.controlnet) {
      problems.push({ issue: "missing_controlnet_conditioning_configuration" });
    }
  }
  if (!textBackend) problems.push({ issue: "missing_text_embedding_backend" });

  let recoveryCheckpoint = null;
  if (configJson) {
    if (path.resolve(configJson.data_backend_config || "") !== path.resolve(backendPath)) {
      problems.push({ issue: "config_backend_path_mismatch" });
    }
    if (path.resolve(configJson.output_dir || "") !== path.resolve(job.output_dir)) {
      problems.push({ issue: "config_output_path_mismatch" });
    }
    if (configJson.resume_from_checkpoint) {
      const configuredRecovery = path.resolve(String(configJson.resume_from_checkpoint));
      const policyRecovery = policy?.recovery_checkpoint
        ? path.resolve(String(policy.recovery_checkpoint))
        : null;
      if (!policyRecovery || configuredRecovery !== policyRecovery) {
        problems.push({
          issue: "recovery_checkpoint_not_bound_by_policy",
          configured: configuredRecovery,
          policy: policyRecovery,
        });
      }
      recoveryCheckpoint = checkpointEvidence(configuredRecovery);
      if (!recoveryCheckpoint.complete) {
        problems.push({
          issue: "recovery_checkpoint_incomplete",
          checkpoint: recoveryCheckpoint,
        });
      }
    } else if (policy?.recovery_checkpoint) {
      problems.push({
        issue: "policy_recovery_checkpoint_missing_from_config",
        policy: path.resolve(String(policy.recovery_checkpoint)),
      });
    }
    if (Number(configJson.checkpoints_total_limit || 0) <
      Number(policy?.minimum_checkpoint_retention || 10)) {
      problems.push({
        issue: "insufficient_checkpoint_retention",
        actual: Number(configJson.checkpoints_total_limit || 0),
        required: Number(policy?.minimum_checkpoint_retention || 10),
      });
    }
    if (Number(configJson.checkpoint_step_interval || 0) <= 0) {
      problems.push({ issue: "missing_checkpoint_interval" });
    }
    if (Number(configJson.max_train_steps || 0) <= 0) {
      problems.push({ issue: "missing_max_train_steps" });
    }
  }

  const versionTag = String(policy?.version_tag || "");
  if (!versionTag) {
    problems.push({ issue: "missing_version_tag" });
  } else {
    for (const [label, candidate] of [
      ["job_id", job.job_id],
      ["config_dir", job.config_dir],
      ["output_dir", job.output_dir],
      ["vae_cache", imageBackend?.cache_dir_vae],
      ["text_cache", textBackend?.cache_dir],
    ]) {
      if (!String(candidate || "").includes(versionTag)) {
        problems.push({
          issue: "version_tag_missing_from_path",
          field: label,
          required: versionTag,
          actual: candidate || null,
        });
      }
    }
  }

  const validationPath = policy?.validation_prompt_library
    ? path.resolve(policy.validation_prompt_library)
    : null;
  const validation = validationPath ? readJson(validationPath, null) : null;
  const requiredPromptIds = new Set(policy?.required_validation_prompt_ids || []);
  const presentPromptIds = new Set(
    Array.isArray(validation?.prompts)
      ? validation.prompts.map((entry) => entry.id)
      : [],
  );
  if (!validation) {
    problems.push({ issue: "missing_validation_prompt_library", file: validationPath });
  } else {
    try {
      validationFixedSettings(validation);
    } catch (error) {
      problems.push({
        issue: "invalid_validation_fixed_settings",
        detail: error.message,
      });
    }
    for (const promptId of requiredPromptIds) {
      if (!presentPromptIds.has(promptId)) {
        problems.push({ issue: "missing_required_validation_prompt", prompt_id: promptId });
      }
    }
  }
  const validationInputs = [];
  if (validation && Array.isArray(validation.prompts)) {
    const datasetRoot = path.dirname(path.resolve(job.data_dir));
    for (const prompt of validation.prompts) {
      for (const key of ["control_image", "source_target"]) {
        const declared = String(prompt[key] || "").trim();
        if (!declared) continue;
        const resolved = path.resolve(datasetRoot, declared);
        const valid = validation.controls_are_relative_to === "dataset" &&
          resolved.startsWith(`${datasetRoot}${path.sep}`) &&
          fs.existsSync(resolved) && fs.statSync(resolved).isFile() &&
          imageExtensions.has(path.extname(resolved).toLowerCase());
        if (!valid) {
          problems.push({
            issue: "missing_or_invalid_validation_input",
            prompt_id: prompt.id || null,
            kind: key,
            declared,
            resolved,
          });
          continue;
        }
        validationInputs.push({
          prompt_id: prompt.id || null,
          kind: key,
          relative_path: declared,
          path: resolved,
          sha256: sha256(resolved),
        });
      }
    }
  }
  const validationInputsRevisionSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(validationInputs.map((entry) => ({
      prompt_id: entry.prompt_id,
      kind: entry.kind,
      relative_path: entry.relative_path,
      sha256: entry.sha256,
    }))))
    .digest("hex");

  const inventory = installedInventory();
  if (!inventory.environment?.mps_available) {
    problems.push({ issue: "mps_not_available" });
  }
  const disk = run("/bin/df", ["-Pk", path.dirname(job.output_dir)]);
  const availableKb = Number(disk.stdout.trim().split(/\s+/).at(-3) || 0);
  const minimumFreeBytes = Number(policy?.minimum_free_bytes || 20 * 1024 ** 3);
  if (!disk.ok || availableKb * 1024 < minimumFreeBytes) {
    problems.push({
      issue: "insufficient_or_unknown_free_space",
      available_bytes: disk.ok ? availableKb * 1024 : null,
      required_bytes: minimumFreeBytes,
    });
  }
  const telemetry = processSnapshot(args.ignore_process_group);
  if (telemetry.active && args.allow_active_training_for_enqueue !== true) {
    problems.push({ issue: "training_already_active" });
  }

  const evidence = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    job_id: job.job_id,
    manifest_path: manifestPath,
    config_path: configPath,
    backend_path: backendPath,
    policy_path: policyPath,
    validation_prompt_library: validationPath,
    dataset_manifest: dataset.manifest_path,
    dataset_manifest_sha256: dataset.manifest_path
      ? sha256(dataset.manifest_path)
      : null,
    dataset_revision_sha256: dataset.dataset_revision_sha256,
    config_sha256: configJson ? sha256(configPath) : null,
    backend_sha256: Array.isArray(backendJson) ? sha256(backendPath) : null,
    policy_sha256: policy ? sha256(policyPath) : null,
    validation_sha256: validation ? sha256(validationPath) : null,
    validation_inputs: validationInputs,
    validation_inputs_revision_sha256: validationInputsRevisionSha256,
    image_count: dataset.image_count,
    caption_count: dataset.caption_count,
    caption_variant_count: dataset.token_audit?.variant_count || null,
    maximum_observed_tokens: dataset.token_audit?.maximum_observed_tokens || null,
    mps_available: Boolean(inventory.environment?.mps_available),
    free_bytes: disk.ok ? availableKb * 1024 : null,
    active_training: telemetry.active,
    conditioning,
    recovery_checkpoint: recoveryCheckpoint,
    problems,
  };
  evidence.revision_fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({
      job_id: evidence.job_id,
      dataset_revision_sha256: evidence.dataset_revision_sha256,
      config_sha256: evidence.config_sha256,
      backend_sha256: evidence.backend_sha256,
      policy_sha256: evidence.policy_sha256,
      validation_sha256: evidence.validation_sha256,
      validation_inputs_revision_sha256:
        evidence.validation_inputs_revision_sha256,
      conditioning_revision_sha256: evidence.conditioning?.revision_sha256 || null,
      recovery_checkpoint_sha256:
        evidence.recovery_checkpoint?.revision_sha256 || null,
    }))
    .digest("hex");
  evidence.ready = problems.length === 0;
  const readinessPath = path.join(
    requiredPath("manifest_root"),
    `${job.job_id}-${Date.now()}-training-readiness.json`,
  );
  atomicJson(readinessPath, evidence);
  return { ...evidence, readiness_path: readinessPath };
}

function prepareVersionedJob(args) {
  const { job: sourceJob, manifestPath } = manifestJob(args.job_id);
  const versionTag = String(args.version_tag || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(versionTag)) {
    throw new Error("version_tag must contain only letters, numbers, dots, underscores, or hyphens");
  }
  const targetJobId = String(args.target_job_id || `${sourceJob.job_id}-v2`);
  if (!targetJobId.includes(versionTag)) {
    throw new Error("target_job_id must include version_tag");
  }
  const sourceConfigPath = path.join(sourceJob.config_dir, "config.json");
  const sourceBackendPath = path.join(sourceJob.config_dir, "multidatabackend.json");
  const sourcePolicyPath = path.join(
    sourceJob.config_dir,
    "TRAINING_READINESS_POLICY.json",
  );
  const sourceConfig = readJson(sourceConfigPath, null);
  const sourceBackends = readJson(sourceBackendPath, null);
  const sourcePolicy = readJson(sourcePolicyPath, {});
  if (!sourceConfig || !Array.isArray(sourceBackends)) {
    throw new Error("source job has no valid config packet");
  }
  const queueRoot = requiredPath("queue_root");
  const outputRoot = requiredPath("output_root");
  const targetConfigDir = path.join(queueRoot, "configs", targetJobId);
  const targetOutputDir = path.join(outputRoot, `${targetJobId}-sdxl-lora`);
  const targetConfigPath = path.join(targetConfigDir, "config.json");
  const targetBackendPath = path.join(targetConfigDir, "multidatabackend.json");
  const validationPath = path.join(targetConfigDir, "validation-prompts.json");
  const policyPath = path.join(targetConfigDir, "TRAINING_READINESS_POLICY.json");
  const manifest = readJson(manifestPath, []);
  const existingTarget = manifest.find((entry) => entry.job_id === targetJobId);
  const trigger = String(args.required_trigger || sourceJob.trigger || "").trim();
  if (!trigger) throw new Error("required_trigger is required");

  const imageBackend = sourceBackends.find((entry) =>
    entry.type === "local" && entry.dataset_type !== "text_embeds");
  const textBackend = sourceBackends.find((entry) => entry.dataset_type === "text_embeds");
  if (!imageBackend || !textBackend) {
    throw new Error("source backend packet needs image and text-embedding backends");
  }
  const configJson = {
    ...sourceConfig,
    lora_rank: Number(args.lora_rank ?? sourceConfig.lora_rank ?? 32),
    lora_alpha: Number(args.lora_alpha ?? sourceConfig.lora_alpha ?? 32),
    data_backend_config: targetBackendPath,
    output_dir: targetOutputDir,
    checkpoint_step_interval: Number(
      args.checkpoint_step_interval ?? sourceConfig.checkpoint_step_interval ?? 200,
    ),
    checkpoints_total_limit: Number(
      args.minimum_checkpoint_retention ?? sourceConfig.checkpoints_total_limit ?? 10,
    ),
    max_train_steps: Number(args.max_train_steps ?? sourceConfig.max_train_steps ?? 1200),
    validation_steps: 0,
    validation_disable: true,
    validation_disable_unconditional: true,
  };
  const requestedRecoveryCheckpoint = args.recovery_checkpoint
    ? path.resolve(String(args.recovery_checkpoint))
    : null;
  let recoveryCheckpoint = null;
  let stagedRecoveryCheckpoint = null;
  let recoveryProvenance = null;
  if (requestedRecoveryCheckpoint) {
    recoveryCheckpoint = checkpointEvidence(requestedRecoveryCheckpoint);
    if (!recoveryCheckpoint.complete) {
      throw new Error(
        `recovery checkpoint is incomplete: ${JSON.stringify(recoveryCheckpoint)}`,
      );
    }
    recoveryProvenance = {
      ...recoveryCheckpointProvenance(requestedRecoveryCheckpoint, sourceJob),
      checkpoint_name: recoveryCheckpoint.checkpoint_name,
      step: recoveryCheckpoint.step,
      global_step: recoveryCheckpoint.global_step,
      revision_sha256: recoveryCheckpoint.revision_sha256,
    };
    stagedRecoveryCheckpoint = path.join(
      targetOutputDir,
      path.basename(requestedRecoveryCheckpoint),
    );
    if (requestedRecoveryCheckpoint !== stagedRecoveryCheckpoint) {
      if (fs.existsSync(stagedRecoveryCheckpoint)) {
        const stagedEvidence = checkpointEvidence(stagedRecoveryCheckpoint);
        if (!stagedEvidence.complete ||
            stagedEvidence.revision_sha256 !== recoveryCheckpoint.revision_sha256) {
          throw new Error(
            `refusing differing staged recovery checkpoint: ${stagedRecoveryCheckpoint}`,
          );
        }
      } else {
        fs.mkdirSync(targetOutputDir, { recursive: true });
        const temporaryRoot = fs.mkdtempSync(path.join(targetOutputDir, ".checkpoint-stage-"));
        const temporary = path.join(temporaryRoot, path.basename(stagedRecoveryCheckpoint));
        try {
          fs.cpSync(requestedRecoveryCheckpoint, temporary, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          const stagedEvidence = checkpointEvidence(temporary);
          if (!stagedEvidence.complete ||
              stagedEvidence.revision_sha256 !== recoveryCheckpoint.revision_sha256) {
            throw new Error("staged recovery checkpoint failed content verification");
          }
          fs.renameSync(temporary, stagedRecoveryCheckpoint);
        } catch (error) {
          throw error;
        } finally {
          fs.rmSync(temporaryRoot, { recursive: true, force: true });
        }
      }
    }
    configJson.resume_from_checkpoint = stagedRecoveryCheckpoint;
  } else {
    delete configJson.resume_from_checkpoint;
  }
  const backendJson = [
    {
      ...imageBackend,
      id: `${targetJobId}-images`,
      instance_data_dir: sourceJob.data_dir,
      crop: imageBackend.crop ?? true,
      crop_style: imageBackend.crop_style ?? "center",
      crop_aspect: imageBackend.crop_aspect ?? "square",
      caption_strategy: "textfile",
      disable_multiline_split: false,
      cache_dir_vae: path.join(queueRoot, "cache", "vae", targetJobId),
    },
    {
      ...textBackend,
      id: `${targetJobId}-text-embeds`,
      cache_dir: path.join(queueRoot, "cache", "text", targetJobId),
    },
  ];
  const requestedValidationLibrary = String(
    args.validation_prompt_library || sourcePolicy.validation_prompt_library || "",
  ).trim();
  if (!requestedValidationLibrary) {
    throw new Error("validation_prompt_library is required");
  }
  const suppliedValidationPath = path.resolve(requestedValidationLibrary);
  const validation = structuredClone(readJson(suppliedValidationPath, null));
  if (!validation || !Array.isArray(validation.prompts) || !validation.prompts.length) {
    throw new Error("validation_prompt_library must name a JSON file with a non-empty prompts array");
  }
  validation.fixed_settings = validationFixedSettings(validation);
  validation.seed_policy = `Use ${validation.fixed_settings.seeds.length === 1 ? "seed" : "seeds"} ` +
    `${validation.fixed_settings.seeds.join(", ")} for every mapped prompt.`;
  const requiredValidationPromptIds = args.required_validation_prompt_ids ||
    sourcePolicy.required_validation_prompt_ids ||
    validation.prompts.map((entry) => entry.id);
  if (requiredValidationPromptIds.some((id) => !String(id || "").trim())) {
    throw new Error("every validation prompt needs a non-empty id");
  }
  const requestedTokenizerRoot = String(
    args.tokenizer_root || sourcePolicy.tokenizer_root || "",
  ).trim();
  if (!requestedTokenizerRoot) throw new Error("tokenizer_root is required");
  const policy = {
    ...sourcePolicy,
    schema_version: 1,
    version_tag: versionTag,
    expected_caption_variants: Number(
      args.expected_caption_variants ??
        sourcePolicy.expected_caption_variants ??
        sourceJob.caption_variants_per_image ??
        5,
    ),
    required_trigger: trigger,
    ...(args.required_adult_pattern
      ? { required_adult_pattern: args.required_adult_pattern }
      : {}),
    tokenizer_root: path.resolve(requestedTokenizerRoot),
    maximum_tokens: Number(args.maximum_tokens ?? sourcePolicy.maximum_tokens ?? 77),
    minimum_checkpoint_retention: configJson.checkpoints_total_limit,
    minimum_free_bytes: Number(
      args.minimum_free_bytes ?? sourcePolicy.minimum_free_bytes ?? 20 * 1024 ** 3,
    ),
    validation_prompt_library: validationPath,
    required_validation_prompt_ids: requiredValidationPromptIds,
    base_model_decision: {
      training_base: configJson.pretrained_model_name_or_path,
      reason: args.base_model_reason ||
        sourcePolicy.base_model_decision?.reason ||
        "Clean versioned rerun using the already configured and cached training base; no download.",
      target_inference_base: validation.fixed_settings?.base_model ||
        configJson.pretrained_model_name_or_path,
      compatibility_status: "must be evaluated by the fixed validation suite after training",
    },
    recovery_checkpoint: stagedRecoveryCheckpoint,
    source_recovery_checkpoint: requestedRecoveryCheckpoint,
    staged_recovery_checkpoint: stagedRecoveryCheckpoint,
    recovery_checkpoint_revision_sha256:
      recoveryCheckpoint?.revision_sha256 || null,
    recovery_checkpoint_provenance: recoveryProvenance,
  };
  const {
    hawkspan_revision: _sourceHawkSpanRevision,
    readiness_path: _sourceReadinessPath,
    readiness_revision_fingerprint: _sourceReadinessFingerprint,
    runtime_staged: _sourceRuntimeStaged,
    ...versionableSourceJob
  } = sourceJob;
  const targetJob = {
    ...versionableSourceJob,
    index: Number(
      args.index ||
      existingTarget?.index ||
      1 + Math.max(...manifest.map((entry) => Number(entry.index || 0))),
    ),
    job_id: targetJobId,
    trigger,
    config_dir: targetConfigDir,
    output_dir: targetOutputDir,
    revision_of: sourceJob.job_id,
    runtime_staged: false,
    state: "ready_unapproved",
  };

  const proposed = {
    [targetConfigPath]: configJson,
    [targetBackendPath]: backendJson,
    [validationPath]: validation,
    [policyPath]: policy,
  };
  for (const [filePath, value] of Object.entries(proposed)) {
    if (fs.existsSync(filePath)) {
      const current = readJson(filePath, null);
      if (JSON.stringify(current) !== JSON.stringify(value)) {
        throw new Error(`refusing to overwrite differing versioned file: ${filePath}`);
      }
    } else {
      atomicJson(filePath, value);
    }
  }
  const existing = manifest.filter((entry) => entry.job_id === targetJobId);
  if (existing.length > 1) throw new Error(`duplicate target job in manifest: ${targetJobId}`);
  if (existing.length === 1) {
    if (JSON.stringify(existing[0]) !== JSON.stringify(targetJob)) {
      throw new Error(`refusing to replace differing manifest job: ${targetJobId}`);
    }
  } else {
    atomicJson(manifestPath, [...manifest, targetJob]);
  }
  return {
    prepared: true,
    source_job_id: sourceJob.job_id,
    target_job: targetJob,
    files: Object.keys(proposed),
    recovery_checkpoint: recoveryCheckpoint,
    recovery_checkpoint_provenance: recoveryProvenance,
    staged_recovery_checkpoint: stagedRecoveryCheckpoint,
    training_started: false,
  };
}

function schedulerEnqueue(args) {
  const target = String(args.job_id || "").trim();
  const authorizationJobId = String(args.authorization_job_id || "").trim();
  const expectedFingerprint = String(args.revision_fingerprint || "").trim();
  const safe = /^[A-Za-z0-9._-]+$/;
  if (![target, authorizationJobId, expectedFingerprint].every((value) =>
    safe.test(value))) {
    throw new Error("job_id, authorization_job_id, and revision_fingerprint are required");
  }
  // Admission validates immutable inputs while another queue item may be
  // running. The scheduler still enforces single-trainer execution.
  const readiness = trainingReadiness({
    job_id: target,
    allow_active_training_for_enqueue: true,
  });
  if (!readiness.ready) {
    throw new Error(`cannot enqueue a job that fails readiness: ${readiness.readiness_path}`);
  }
  if (readiness.revision_fingerprint !== expectedFingerprint) {
    throw new Error("cannot enqueue because the authorized revision fingerprint is stale");
  }
  const jobsPath = automation.scheduler_jobs_path
    ? path.resolve(automation.scheduler_jobs_path)
    : path.join(requiredPath("scheduler_root"), "lora-jobs.json");
  const document = readJson(jobsPath, {
    schema_version: 2,
    jobs: [],
  });
  const schedulerJobId = String(
    args.scheduler_job_id || `${target}--${authorizationJobId}`,
  );
  if (!safe.test(schedulerJobId)) throw new Error("invalid scheduler_job_id");
  const entry = {
    job_id: schedulerJobId,
    target,
    authorization_job_id: authorizationJobId,
    revision_fingerprint: readiness.revision_fingerprint,
    readiness_path: readiness.readiness_path,
    authorized: true,
    priority: Number(args.priority || 1000),
    maximum_attempts: 1,
    log_path: path.join(
      requiredPath("queue_root"),
      "logs",
      `${target}-scheduler-adapter.log`,
    ),
    enqueued_at: new Date().toISOString(),
  };
  const existing = (document.jobs || []).filter((job) => job.job_id === schedulerJobId);
  if (existing.length > 1) throw new Error(`duplicate scheduler job: ${schedulerJobId}`);
  const targetEntries = (document.jobs || []).filter((job) => job.target === target);
  if (targetEntries.some((job) => job.job_id !== schedulerJobId)) {
    throw new Error(`scheduler target already has a different queue item: ${target}`);
  }
  if (existing.length === 1) {
    const stableKeys = [
      "target", "authorization_job_id", "revision_fingerprint", "authorized",
    ];
    if (stableKeys.some((key) => existing[0][key] !== entry[key])) {
      throw new Error(`refusing to replace differing scheduler job: ${schedulerJobId}`);
    }
    return {
      enqueued: true,
      already_present: true,
      scheduler_jobs_path: jobsPath,
      entry: existing[0],
      training_started: false,
    };
  }
  document.schema_version = 2;
  document.jobs = [...(document.jobs || []), entry];
  atomicJson(jobsPath, document);
  return {
    enqueued: true,
    already_present: false,
    scheduler_jobs_path: jobsPath,
    entry,
    training_started: false,
  };
}

function stageRuntimeJob(args) {
  const jobId = String(args.job_id || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(jobId)) {
    throw new Error("job_id is required and contains unsupported characters");
  }
  const runtimeRoot = path.resolve(
    args.runtime_root || automation.runtime_root ||
      path.join(os.homedir(), "AI/LoRA-Runtime"),
  );
  const sourceManifest = path.resolve(
    args.source_manifest ||
      path.join(requiredPath("queue_root"), "captioned-lora-manifest.json"),
  );
  const script = path.join(
    path.dirname(path.resolve(process.argv[1])),
    "stage-lora-runtime-job.py",
  );
  const commandArgs = [
    script,
    "--source-manifest", sourceManifest,
    "--job-id", jobId,
    "--runtime-root", runtimeRoot,
    "--base-link-config", configPath,
  ];
  if (args.caption_overlay_root) {
    commandArgs.push(
      "--caption-overlay-root",
      path.resolve(args.caption_overlay_root),
    );
  }
  const staged = run("/usr/bin/python3", commandArgs, {
    timeout: Number(args.timeout_ms || 24 * 60 * 60 * 1000),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!staged.ok) {
    throw new Error(
      staged.stderr.trim() || staged.error || `runtime staging exited ${staged.status}`,
    );
  }
  return JSON.parse(staged.stdout);
}

function installedInventory() {
  const simpletunerRoot = requiredPath("simpletuner_root");
  const queueRoot = requiredPath("queue_root");
  const outputRoot = requiredPath("output_root");
  const manifest = readJson(path.join(queueRoot, "captioned-lora-manifest.json"), []);
  const status = readJson(path.join(queueRoot, "captioned-lora-status.json"), {});
  const python = path.join(simpletunerRoot, ".venv/bin/python");
  const environment = run(python, ["-c", [
    "import importlib.metadata,json,platform,sys;",
    "import torch;",
    "packages={};",
    "names=['simpletuner','accelerate','diffusers','transformers','peft','safetensors'];",
    "[(packages.update({name:importlib.metadata.version(name)}) ",
    "if importlib.metadata.packages_distributions().get(name) ",
    "else None) for name in names];",
    "print(json.dumps({'python':sys.version,'platform':platform.platform(),",
    "'torch':torch.__version__,'mps_built':torch.backends.mps.is_built(),",
    "'mps_available':torch.backends.mps.is_available(),'packages':packages}))",
  ].join("")]);
  const git = run("/usr/bin/git", ["-C", simpletunerRoot, "rev-parse", "HEAD"]);
  const hubRoot = path.join(simpletunerRoot, "cache", "huggingface", "hub");
  const cachedModels = fs.existsSync(hubRoot)
    ? fs.readdirSync(hubRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("models--"))
        .map((entry) => {
          const modelRoot = path.join(hubRoot, entry.name);
          const snapshotsRoot = path.join(modelRoot, "snapshots");
          const revisions = fs.existsSync(snapshotsRoot)
            ? fs.readdirSync(snapshotsRoot, { withFileTypes: true })
                .filter((revision) => revision.isDirectory())
                .map((revision) => revision.name)
                .sort()
            : [];
          return {
            id: entry.name.slice("models--".length).replaceAll("--", "/"),
            path: modelRoot,
            bytes: directoryBytes(modelRoot),
            revisions,
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];
  return {
    generated_at: new Date().toISOString(),
    host: os.hostname(),
    environment: environment.ok ? JSON.parse(environment.stdout) : {
      error: environment.stderr || environment.error,
    },
    simpletuner: {
      root: simpletunerRoot,
      git_commit: git.ok ? git.stdout.trim() : null,
      environment: environment.ok ? JSON.parse(environment.stdout) : {
        error: environment.stderr || environment.error,
      },
    },
    queue: {
      root: queueRoot,
      jobs: manifest.length,
      current: status.current || null,
      completed: status.completed?.length || 0,
      failed: status.failed?.length || 0,
    },
    datasets: manifest.map((job) => ({
      job_id: job.job_id,
      source: job.source,
      path: job.data_dir,
      image_count: job.image_count,
      caption_count: job.caption_count,
      trigger: job.trigger,
    })),
    outputs: {
      root: outputRoot,
      bytes: directoryBytes(outputRoot),
      loras: walk(outputRoot, (filePath) => filePath.endsWith(".safetensors"))
        .map((filePath) => ({
          path: filePath,
          bytes: fs.statSync(filePath).size,
          modified_at: fs.statSync(filePath).mtime.toISOString(),
        })),
    },
    cached_models: cachedModels,
  };
}

function processSnapshot(ignoreProcessGroup = null) {
  const ignoredPgid = Number(ignoreProcessGroup || 0);
  if (ignoreProcessGroup !== null &&
      (!Number.isSafeInteger(ignoredPgid) || ignoredPgid <= 0)) {
    throw new Error("ignore_process_group must be a positive integer");
  }
  const processes = run("ps", [
    "-axo", "pid=,ppid=,pgid=,%cpu=,%mem=,rss=,etime=,command=",
  ]);
  const configuredProcessMatch = String(config.training?.process_match || "").trim();
  const processMatcher = configuredProcessMatch
    ? new RegExp(configuredProcessMatch, "i")
    : /(?:simpletuner train|simpletuner\/train\.py|accelerate launch|run_captioned_loras\.py)/i;
  const matching = processes.stdout.split("\n").filter((line) => {
    const fields = line.trim().split(/\s+/);
    const pgid = Number(fields[2] || 0);
    const command = fields.slice(7).join(" ");
    return processMatcher.test(command) &&
      (!ignoredPgid || pgid !== ignoredPgid) &&
      !command.includes("lora-automation.mjs") &&
      !command.includes("mcp-server.mjs") &&
      !command.includes("call-tool.mjs") &&
      !command.includes("queue-supervisor.mjs") &&
      !command.includes("codex exec resume") &&
      !command.includes("/Applications/ChatGPT.app/Contents/Resources/codex");
  });
  const vm = run("/usr/bin/vm_stat");
  // With no arguments memory_pressure is a pressure generator and can remain
  // active indefinitely. -Q is its undocumented-but-supported read-only query
  // mode on the M2 and M4 hosts.
  const pressure = run("/usr/bin/memory_pressure", ["-Q"], { timeout: 5000 });
  const disk = run("/bin/df", ["-Pk", requiredPath("output_root")]);
  const queueRoot = requiredPath("queue_root");
  let status = {};
  let statusReadError = null;
  try {
    status = readJson(path.join(queueRoot, "captioned-lora-status.json"), {});
  } catch (error) {
    statusReadError = error.message;
  }
  const logPath = status.current
    ? path.join(queueRoot, "logs", `${status.current}.log`)
    : null;
  const logStat = logPath && fs.existsSync(logPath) ? fs.statSync(logPath) : null;
  const logTail = logPath && fs.existsSync(logPath)
    ? run("/usr/bin/tail", ["-n", "300", logPath]).stdout
    : "";
  let progress = null;
  const stripped = logTail.replace(/\x1b\[[0-9;]*m/g, "");
  const progressPattern =
    /Epoch\s+(\d+)\/(\d+),\s+Steps:\s+(\d+)%[^\n]*?(\d+)\/(\d+)\s+\[[^<\]]*<([^,\]]+),\s*([\d.]+)s\/it,\s*lr=([^,\]]+),\s*step_loss=([^\]\s]+)/g;
  for (const match of stripped.matchAll(progressPattern)) {
    progress = {
      epoch: Number(match[1]),
      epochs_total: Number(match[2]),
      percent: Number(match[3]),
      step: Number(match[4]),
      steps_total: Number(match[5]),
      eta: match[6],
      seconds_per_iteration: Number(match[7]),
      learning_rate: Number(match[8]),
      step_loss: Number(match[9]),
    };
  }
  const warnings = stripped.split("\n").filter((line) =>
    /warning|error|exception|traceback|out of memory|no space left/i.test(line));
  const now = Date.now();
  const staleSeconds = logStat ? Math.floor((now - logStat.mtimeMs) / 1000) : null;
  const freshLogHeartbeat = Boolean(
    status.current &&
    staleSeconds !== null &&
    staleSeconds <= Number(automation.log_heartbeat_seconds || 120),
  );
  const active = matching.length > 0 || freshLogHeartbeat;
  const activeSource = matching.length > 0
    ? "process-list"
    : freshLogHeartbeat
      ? "fresh-log-heartbeat"
      : "none";
  return {
    generated_at: new Date().toISOString(),
    current_job: status.current || null,
    queue_status_read_error: statusReadError,
    active,
    active_source: activeSource,
    process_inspection_error: processes.ok
      ? null
      : processes.stderr || processes.error || `ps exited ${processes.status}`,
    processes: matching,
    progress,
    log_path: logPath,
    log_stale_seconds: staleSeconds,
    stalled: active && staleSeconds !== null &&
      staleSeconds > Number(automation.stall_seconds || 900),
    warnings: warnings.slice(-100),
    memory: {
      vm_stat: vm.stdout.trim(),
      pressure: pressure.stdout.trim(),
    },
    disk: disk.stdout.trim(),
    temperature: {
      available: false,
      reason: "macOS does not expose Apple Silicon package temperature without privileged powermetrics",
    },
    mps: {
      process_level_utilization_available: false,
      reason: "PyTorch confirms MPS availability; macOS has no stable unprivileged per-process MPS utilization API",
    },
  };
}

function queuePlan() {
  const queueRoot = requiredPath("queue_root");
  const manifest = readJson(path.join(queueRoot, "captioned-lora-manifest.json"), []);
  const status = readJson(path.join(queueRoot, "captioned-lora-status.json"), {});
  const policyPath = automation.queue_policy_path ||
    path.join(queueRoot, "lora-queue-policy.json");
  const policy = readJson(policyPath, {
    schema_version: 1,
    priorities: {},
  });
  const completed = new Set((status.completed || []).map((entry) =>
    typeof entry === "string" ? entry : entry.job_id));
  const failed = new Set((status.failed || []).map((entry) =>
    typeof entry === "string" ? entry : entry.job_id));
  const jobs = manifest.map((job) => ({
    ...job,
    priority: Number(policy.priorities?.[job.job_id] ?? 1000 + Number(job.index || 0)),
    state: job.job_id === status.current ? "running"
      : completed.has(job.job_id) ? "completed"
        : failed.has(job.job_id) ? "failed" : "pending",
  })).sort((a, b) => a.priority - b.priority || Number(a.index) - Number(b.index));
  return { policy_path: policyPath, policy, current: status.current || null, jobs };
}

function checkpointComparison(jobId) {
  const queueRoot = requiredPath("queue_root");
  const outputRoot = requiredPath("output_root");
  const manifest = readJson(path.join(queueRoot, "captioned-lora-manifest.json"), []);
  const job = manifest.find((entry) => entry.job_id === jobId);
  if (!job) throw new Error(`unknown job: ${jobId}`);
  const root = path.resolve(job.output_dir || path.join(outputRoot, jobId));
  const logPath = path.join(queueRoot, "logs", `${jobId}.log`);
  const log = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf8").replace(/\x1b\[[0-9;]*m/g, "")
    : "";
  const losses = [];
  const expression =
    /Steps:\s*\d+%[^\n]*?(\d+)\/(\d+)[^\n]*?step_loss=([0-9.eE+-]+)/g;
  for (const match of log.matchAll(expression)) {
    losses.push({ step: Number(match[1]), loss: Number(match[3]) });
  }
  const checkpointPaths = new Map();
  for (const candidate of [
    { root, source: "live" },
    automation.preservation_root
      ? {
          root: path.join(
            path.resolve(automation.preservation_root),
            path.basename(root),
            "PRESERVED_CHECKPOINTS",
          ),
          source: "preserved",
        }
      : null,
  ].filter(Boolean)) {
    const candidateRoot = candidate.root;
    if (!fs.existsSync(candidateRoot)) continue;
    for (const entry of fs.readdirSync(candidateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^checkpoint-\d+$/.test(entry.name)) continue;
      // Prefer the live output copy; use the preserved copy only when SimpleTuner
      // has pruned that checkpoint from the live directory.
      if (!checkpointPaths.has(entry.name)) {
        checkpointPaths.set(entry.name, {
          path: path.join(candidateRoot, entry.name),
          source: candidate.source,
        });
      }
    }
  }
  const checkpoints = [...checkpointPaths.entries()].map(([checkpoint, candidate]) => {
    const checkpointPath = candidate.path;
    const step = Number(checkpoint.slice("checkpoint-".length));
    const nearby = losses.filter((row) => row.step <= step).slice(-20);
    const averageLoss = nearby.length
      ? nearby.reduce((total, row) => total + row.loss, 0) / nearby.length
      : null;
    return {
      checkpoint,
      step,
      path: checkpointPath,
      source: candidate.source,
      bytes: directoryBytes(checkpointPath),
      recent_average_loss: averageLoss,
    };
  }).sort((a, b) => a.step - b.step);
  const lossCandidate = checkpoints.filter((entry) =>
    Number.isFinite(entry.recent_average_loss))
    .sort((a, b) => a.recent_average_loss - b.recent_average_loss)[0] || null;
  return {
    job_id: jobId,
    checkpoints,
    loss_only_candidate: lossCandidate?.checkpoint || null,
    recommendation: checkpoints.length
      ? "Render the fixed validation suite for every checkpoint; loss alone cannot determine visual quality."
      : "No checkpoints found.",
  };
}

function refreshRegistry() {
  const inventory = installedInventory();
  const queue = queuePlan();
  const telemetry = processSnapshot();
  const ledgerPath = automation.packet_ledger_path;
  const ledger = ledgerPath ? readJson(ledgerPath, { packets: [] }) : { packets: [] };
  const priorPath = requiredPath("registry_path");
  const prior = readJson(priorPath, { schema_version: 1, revisions: {} });
  const manifestRoot = requiredPath("manifest_root");
  const preflightSummaries = fs.existsSync(manifestRoot)
    ? fs.readdirSync(manifestRoot)
      .filter((name) => /^all-datasets-.*-preflight-summary\.json$/.test(name))
      .map((name) => path.join(manifestRoot, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  const latestPreflightPath = preflightSummaries[0] || null;
  const latestPreflight = latestPreflightPath
    ? readJson(latestPreflightPath, { results: [] })
    : { results: [] };
  const preflightByJob = new Map(
    (latestPreflight.results || []).map((entry) => [entry.job_id, entry]),
  );
  const readinessByJob = new Map();
  if (fs.existsSync(manifestRoot)) {
    const readinessPaths = fs.readdirSync(manifestRoot)
      .filter((name) => /-training-readiness\.json$/.test(name))
      .map((name) => path.join(manifestRoot, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const readinessPath of readinessPaths) {
      const readiness = readJson(readinessPath, null);
      if (!readiness?.job_id || readinessByJob.has(readiness.job_id)) continue;
      readinessByJob.set(readiness.job_id, {
        ...readiness,
        readiness_path: readinessPath,
      });
    }
  }
  const revisions = { ...prior.revisions };
  for (const job of queue.jobs) {
    const packets = (ledger.packets || []).filter((entry) => entry.run_name === job.job_id);
    const outputFiles = inventory.outputs.loras.filter((entry) =>
      entry.path.startsWith(path.resolve(job.output_dir)));
    const configPath = path.join(job.config_dir, "config.json");
    const dataBackendPath = path.join(job.config_dir, "multidatabackend.json");
    const preflight = preflightByJob.get(job.job_id) || null;
    const readiness = readinessByJob.get(job.job_id) || null;
    const datasetManifestPath = preflight?.dataset_manifest || null;
    revisions[job.job_id] = {
      job_id: job.job_id,
      revision_id: job.job_id,
      source: job.source,
      trigger: job.trigger,
      dataset_path: job.data_dir,
      conditioning_path: job.conditioning_dir || null,
      dataset_manifest_path: datasetManifestPath,
      dataset_manifest_sha256: datasetManifestPath && fs.existsSync(datasetManifestPath)
        ? sha256(datasetManifestPath)
        : null,
      dataset_preflight: preflight
        ? {
            technical_ready: preflight.technical_ready,
            caption_structure_ready: preflight.caption_structure_ready,
            config_ready: preflight.config_ready,
            problem_count: preflight.problems?.length || 0,
            summary_path: latestPreflightPath,
          }
        : null,
      training_readiness: readiness
        ? {
            ready: Boolean(readiness.ready),
            readiness_path: readiness.readiness_path,
            revision_fingerprint: readiness.revision_fingerprint || null,
            recovery_checkpoint: readiness.recovery_checkpoint || null,
            generated_at: readiness.generated_at || null,
            problem_count: readiness.problems?.length || 0,
          }
        : prior.revisions?.[job.job_id]?.training_readiness || null,
      revision_fingerprint:
        readiness?.revision_fingerprint ||
        prior.revisions?.[job.job_id]?.revision_fingerprint ||
        null,
      config_path: configPath,
      config_sha256: fs.existsSync(configPath) ? sha256(configPath) : null,
      data_backend_path: dataBackendPath,
      data_backend_sha256: fs.existsSync(dataBackendPath) ? sha256(dataBackendPath) : null,
      output_path: job.output_dir,
      priority: job.priority,
      state: job.state,
      outputs: outputFiles,
      packets,
      validation: prior.revisions?.[job.job_id]?.validation || [],
      draw_things: prior.revisions?.[job.job_id]?.draw_things || { imports: [] },
      recommended_checkpoint:
        prior.revisions?.[job.job_id]?.recommended_checkpoint || null,
      child_revisions:
        prior.revisions?.[job.job_id]?.child_revisions || [],
      parent_revision: prior.revisions?.[job.job_id]?.parent_revision || null,
      created_at: prior.revisions?.[job.job_id]?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
  const registry = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    host: os.hostname(),
    active_job: telemetry.current_job,
    revisions,
  };
  atomicJson(priorPath, registry);
  return { registry_path: priorPath, revision_count: Object.keys(revisions).length };
}

function validationPlan(jobId) {
  const registry = readJson(requiredPath("registry_path"), { revisions: {} });
  const revision = registry.revisions?.[jobId];
  if (!revision) throw new Error(`registry entry not found: ${jobId}`);
  const finalPath = path.join(
    path.resolve(revision.output_path),
    "pytorch_lora_weights.safetensors",
  );
  const output = revision.outputs?.find((entry) =>
    path.resolve(entry.path) === finalPath) ||
    revision.outputs?.find((entry) =>
      path.basename(entry.path) === "pytorch_lora_weights.safetensors") ||
    revision.outputs?.[0];
  if (!output) throw new Error(`no LoRA output found for ${jobId}`);
  const configDir = path.dirname(path.resolve(revision.config_path));
  const policy = readJson(path.join(configDir, "TRAINING_READINESS_POLICY.json"), {});
  const validationPath = path.resolve(
    policy.validation_prompt_library || path.join(configDir, "validation-prompts.json"),
  );
  const validation = readJson(validationPath, null);
  if (!validation || !Array.isArray(validation.prompts) || !validation.prompts.length) {
    throw new Error(`validation prompt library is missing or empty: ${validationPath}`);
  }
  const controlsDeclared = validation.prompts.some((entry) => entry.control_image);
  let prompts = validation.prompts;
  if (controlsDeclared) {
    const conditioningRoot = path.resolve(String(revision.conditioning_path || ""));
    if (!revision.conditioning_path || !fs.existsSync(conditioningRoot) ||
        !fs.statSync(conditioningRoot).isDirectory()) {
      throw new Error(`validation controls require a conditioning directory: ${conditioningRoot}`);
    }
    prompts = validation.prompts.map((entry) => {
      const declared = String(entry.control_image || "").trim();
      if (!declared) {
        throw new Error(`validation prompt ${entry.id || "<missing-id>"} has no control image`);
      }
      const relative = declared.replace(/^conditioning[\\/]/, "");
      const controlPath = path.resolve(conditioningRoot, relative);
      if (!controlPath.startsWith(`${conditioningRoot}${path.sep}`) ||
          !fs.existsSync(controlPath) || !fs.statSync(controlPath).isFile()) {
        throw new Error(
          `validation control is missing or outside conditioning directory: ${declared}`,
        );
      }
      return {
        ...entry,
        control_image_path: controlPath,
        control_image_sha256: sha256(controlPath),
      };
    });
  }
  const comparison = checkpointComparison(jobId);
  const fixedSettings = validationFixedSettings(validation);
  const plan = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    job_id: jobId,
    trigger: revision.trigger,
    lora_path: output.path,
    lora_sha256: sha256(output.path),
    checkpoint_candidates: comparison.checkpoints.map((entry) => ({
      checkpoint: entry.checkpoint,
      path: entry.path,
      lora_path: path.join(entry.path, "pytorch_lora_weights.safetensors"),
      recent_average_loss: entry.recent_average_loss,
    })),
    fixed_settings: fixedSettings,
    prompts,
    control_inputs_bound: controlsDeclared,
    result_schema: {
      checkpoint: "checkpoint name or final",
      score: "numeric overall score",
      validation_plan_path: "absolute path to this saved plan",
      validation_plan_sha256: "SHA-256 of the saved plan",
      lora_path: "exact final or checkpoint LoRA used",
      lora_sha256: "SHA-256 of that exact LoRA",
      settings: "the fixed_settings object used unchanged",
      renders: [{
        prompt_id: "one of the package-supplied fixed prompt IDs",
        image_path: "absolute exported image path",
        seed: "integer",
        live_metadata: "Draw Things sampling metadata including actual LoRA weight",
        score: "numeric prompt score",
        notes: "identity, anatomy, pose, artifacts, and skin notes",
      }],
      notes: "overall checkpoint assessment",
    },
    state: "awaiting_m2_draw_things_render",
  };
  const root = requiredPath("validation_queue_root");
  fs.mkdirSync(root, { recursive: true });
  const planPath = path.join(root, `${jobId}-${Date.now()}-validation-plan.json`);
  atomicJson(planPath, plan);
  return { plan_path: planPath, plan_sha256: sha256(planPath), plan };
}

function validationFixedSettings(validation) {
  const fixed = structuredClone(
    validation.fixed_settings || validation.fixed_generation_policy || {},
  );
  if (!Array.isArray(fixed.seeds) || !fixed.seeds.length) {
    const seed = String(validation.seed_policy || "").match(/\bseed\s+(\d+)\b/i)?.[1];
    if (!seed) throw new Error("validation library has no fixed seeds");
    fixed.seeds = [Number(seed)];
  }
  if (fixed.seeds.some((seed) => !Number.isInteger(Number(seed)))) {
    throw new Error("validation library contains a non-integer fixed seed");
  }
  fixed.seeds = fixed.seeds.map(Number);
  const requiredStrings = ["base_model", "sampler"];
  for (const key of requiredStrings) {
    if (!String(fixed[key] || "").trim()) {
      throw new Error(`validation library fixed_settings.${key} must be a non-empty string`);
    }
  }
  for (const key of ["width", "height", "steps"]) {
    if (!Number.isInteger(fixed[key]) || fixed[key] <= 0) {
      throw new Error(`validation library fixed_settings.${key} must be a positive integer`);
    }
  }
  for (const key of ["guidance_scale", "lora_weight"]) {
    if (typeof fixed[key] !== "number" || !Number.isFinite(fixed[key])) {
      throw new Error(`validation library fixed_settings.${key} must be a finite number`);
    }
  }
  const controlsDeclared = validation.prompts?.some((entry) => entry.control_image);
  if (controlsDeclared) {
    const control = fixed.controlnet;
    if (!control || typeof control !== "object" || Array.isArray(control)) {
      throw new Error("controlled validation requires fixed_settings.controlnet");
    }
    for (const key of ["model", "mode"]) {
      if (!String(control[key] || "").trim()) {
        throw new Error(
          `controlled validation fixed_settings.controlnet.${key} must be a non-empty string`,
        );
      }
    }
    for (const key of ["weight", "start", "end"]) {
      if (typeof control[key] !== "number" || !Number.isFinite(control[key])) {
        throw new Error(
          `controlled validation fixed_settings.controlnet.${key} must be a finite number`,
        );
      }
    }
  }
  return fixed;
}

function drawThingsPlan(jobId) {
  const registry = readJson(requiredPath("registry_path"), { revisions: {} });
  const revision = registry.revisions?.[jobId];
  if (!revision) throw new Error(`registry entry not found: ${jobId}`);
  const comparison = checkpointComparison(jobId);
  const preferredCheckpoint = revision.recommended_checkpoint || null;
  const preferred = preferredCheckpoint
    ? comparison.checkpoints.find((entry) => entry.checkpoint === preferredCheckpoint)
    : null;
  const finalPath = path.join(
    path.resolve(revision.output_path),
    "pytorch_lora_weights.safetensors",
  );
  const loraPath = preferred
    ? path.join(preferred.path, "pytorch_lora_weights.safetensors")
    : fs.existsSync(finalPath)
      ? finalPath
      : revision.outputs?.find((entry) =>
        path.extname(entry.path).toLowerCase() === ".safetensors")?.path;
  if (!loraPath || !fs.existsSync(loraPath)) {
    throw new Error(`no importable LoRA weights found for ${jobId}`);
  }
  const loraSha256 = sha256(loraPath);
  const validation = validationPlan(jobId);
  const configDir = path.dirname(path.resolve(revision.config_path));
  const policy = readJson(path.join(configDir, "TRAINING_READINESS_POLICY.json"), {});
  const configJson = readJson(revision.config_path, {});
  const expectedBaseModel =
    validation.plan.fixed_settings.base_model ||
    policy.base_model_decision?.target_inference_base ||
    configJson.pretrained_model_name_or_path;
  if (!String(expectedBaseModel || "").trim()) {
    throw new Error("Draw Things plan has no policy-selected base model");
  }
  const plan = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    job_id: jobId,
    revision_fingerprint:
      revision.revision_fingerprint || revision.dataset_manifest_sha256 || null,
    selected_checkpoint: preferredCheckpoint || "final",
    lora_path: path.resolve(loraPath),
    lora_sha256: loraSha256,
    conversion: {
      required: false,
      reason:
        "SimpleTuner SDXL PEFT output is already a safetensors LoRA; attempt direct Draw Things import first.",
      fallback:
        "If Draw Things rejects the file, preserve the source and create a separately named converted copy; record tool, version, command, and SHA-256.",
    },
    import: {
      application: "Draw Things",
      expected_base_model: expectedBaseModel,
      imported_name: `${jobId} ${preferredCheckpoint || "final"}`,
      never_open_weights_as_document: true,
      instruction:
        "Import through Draw Things model/LoRA management, not Finder's Open command.",
    },
    validation_plan_path: validation.plan_path,
    validation_plan_sha256: validation.plan_sha256,
    validation_settings: validation.plan.fixed_settings,
    required_prompt_ids: validation.plan.prompts.map((entry) => entry.id),
    required_live_metadata:
      "Record actual Draw Things live sampling metadata, including the imported LoRA name and weight.",
    state: "awaiting_draw_things_import_and_controlled_validation",
    training_authorized: false,
  };
  const root = requiredPath("validation_queue_root");
  fs.mkdirSync(root, { recursive: true });
  const planPath = path.join(root, `${jobId}-${Date.now()}-draw-things-plan.json`);
  atomicJson(planPath, plan);
  return { plan_path: planPath, plan_sha256: sha256(planPath), plan };
}

function safeFileStem(value) {
  return String(value || "render")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "render";
}

function assertLiveSettingsMatchFixed(liveMetadata, fixed, index) {
  if (JSON.stringify(liveMetadata.settings || null) !== JSON.stringify(fixed)) {
    throw new Error(`validation render ${index} live settings differ from the bound fixed settings`);
  }
  const expectedControl = fixed.controlnet || fixed.control || null;
  if (expectedControl) {
    const actualControl = liveMetadata.control || {};
    for (const [key, expectedValue] of Object.entries(expectedControl)) {
      if (actualControl[key] !== expectedValue) {
        throw new Error(`validation render ${index} ControlNet settings differ from the bound fixed settings`);
      }
    }
  }
  if (Object.hasOwn(fixed, "lora_weight") &&
      Number(liveMetadata.lora_weight) !== Number(fixed.lora_weight)) {
    throw new Error(`validation render ${index} LoRA weight differs from the bound fixed settings`);
  }
}

function ingestControlledValidationResult(revision, result, drawThingsPlanDocument) {
  if (!Array.isArray(result.renders)) return null;
  const validationPlanPath = path.resolve(String(result.validation_plan_path || ""));
  if (!validationPlanPath || !fs.existsSync(validationPlanPath)) {
    throw new Error("controlled validation ingest requires validation_plan_path");
  }
  if (
    result.validation_plan_sha256 &&
    result.validation_plan_sha256 !== sha256(validationPlanPath)
  ) {
    throw new Error("validation_plan_sha256 does not match validation_plan_path");
  }
  const plan = readJson(validationPlanPath, null);
  if (!plan || plan.job_id !== revision.revision_id) {
    throw new Error("validation plan does not match this revision");
  }
  const fixed = plan.fixed_settings || {};
  if (JSON.stringify(result.settings || null) !== JSON.stringify(fixed)) {
    throw new Error("validation settings differ from the bound fixed settings");
  }
  if (drawThingsPlanDocument) {
    if (result.checkpoint !== drawThingsPlanDocument.selected_checkpoint) {
      throw new Error("validation checkpoint differs from the bound Draw Things plan");
    }
    if (path.resolve(String(result.lora_path || "")) !==
        path.resolve(String(drawThingsPlanDocument.lora_path || "")) ||
        result.lora_sha256 !== drawThingsPlanDocument.lora_sha256) {
      throw new Error("validation LoRA differs from the bound Draw Things plan");
    }
    if (validationPlanPath !==
        path.resolve(String(drawThingsPlanDocument.validation_plan_path || "")) ||
        sha256(validationPlanPath) !== drawThingsPlanDocument.validation_plan_sha256) {
      throw new Error("validation plan differs from the bound Draw Things plan");
    }
  }
  const seeds = Array.isArray(fixed.seeds) ? fixed.seeds.map(Number) : [];
  if (!seeds.length || seeds.some((seed) => !Number.isInteger(seed))) {
    throw new Error("validation plan has no fixed integer seeds");
  }
  const promptIds = new Set((plan.prompts || []).map((prompt) => String(prompt.id)));
  const promptsById = new Map(
    (plan.prompts || []).map((prompt) => [String(prompt.id), prompt]),
  );
  const expected = new Set(
    [...promptIds].flatMap((promptId) => seeds.map((seed) => `${promptId}\0${seed}`)),
  );
  const seen = new Set();
  const imageHashes = new Set();
  const validatedRenders = [];
  for (const [index, render] of result.renders.entries()) {
    const promptId = String(render.prompt_id || "");
    const seed = render.seed;
    const key = Number.isInteger(seed) && !Number.isNaN(seed)
      ? `${promptId}\0${seed}`
      : null;
    if (!key || !expected.has(key) || seen.has(key)) {
      throw new Error(`validation render ${index} has unexpected or duplicate prompt/seed`);
    }
    if (!render.live_metadata || typeof render.live_metadata !== "object" ||
        Array.isArray(render.live_metadata)) {
      throw new Error(`validation render ${index} has no live metadata`);
    }
    if (render.live_metadata.imported_name !== result.imported_name) {
      throw new Error(`validation render ${index} has the wrong imported LoRA name`);
    }
    if (!Number.isFinite(Number(render.live_metadata.lora_weight))) {
      throw new Error(`validation render ${index} has no numeric LoRA weight`);
    }
    if (render.live_metadata.base_model !== result.base_model) {
      throw new Error(`validation render ${index} has the wrong base model`);
    }
    const prompt = promptsById.get(promptId);
    if (prompt?.control_image_path) {
      const control = render.live_metadata.control;
      if (!control || typeof control !== "object" || Array.isArray(control)) {
        throw new Error(`validation render ${index} has no ControlNet metadata`);
      }
      if (control.input_sha256 !== prompt.control_image_sha256) {
        throw new Error(`validation render ${index} used the wrong control input`);
      }
      if (!String(control.model || "").trim() ||
          !Number.isFinite(Number(control.weight)) ||
          !Number.isFinite(Number(control.start)) ||
          !Number.isFinite(Number(control.end))) {
        throw new Error(`validation render ${index} has incomplete ControlNet metadata`);
      }
    }
    assertLiveSettingsMatchFixed(render.live_metadata, fixed, index);
    if (typeof render.score !== "number" || Number.isNaN(render.score)) {
      throw new Error(`validation render ${index} has no numeric score`);
    }
    const source = path.resolve(String(render.image_path || ""));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile() ||
        !imageExtensions.has(path.extname(source).toLowerCase())) {
      throw new Error(`validation render ${index} image is missing or unsupported`);
    }
    const imageSha256 = sha256(source);
    if (imageHashes.has(imageSha256)) {
      throw new Error(`validation render ${index} duplicates another render image`);
    }
    imageHashes.add(imageSha256);
    validatedRenders.push({ render, promptId, seed, source, imageSha256 });
    seen.add(key);
  }
  if (seen.size !== expected.size) {
    const missing = [...expected].filter((key) => !seen.has(key))
      .map((key) => {
        const [promptId, seed] = key.split("\0");
        return [promptId, Number(seed)];
      });
    throw new Error(`controlled validation result is missing renders: ${JSON.stringify(missing)}`);
  }
  const outputRoot = path.resolve(revision.output_path);
  const renderParent = path.join(outputRoot, "validation-renders");
  const matrixSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(validatedRenders.map(({ promptId, seed, imageSha256 }) => ({
      prompt_id: promptId,
      seed,
      image_sha256: imageSha256,
    }))))
    .digest("hex");
  const renderRoot = path.join(renderParent, matrixSha256);
  const stagingRoot = `${renderRoot}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const portableRenders = [];
  if (!fs.existsSync(renderRoot)) {
    fs.mkdirSync(stagingRoot, { recursive: true });
  }
  try {
    for (const { render, promptId, seed, source, imageSha256 } of validatedRenders) {
      const targetName = `${safeFileStem(promptId)}--seed-${seed}${path.extname(source).toLowerCase()}`;
      const target = path.join(renderRoot, targetName);
      const stagingTarget = path.join(stagingRoot, targetName);
      if (!fs.existsSync(renderRoot)) {
        fs.copyFileSync(source, stagingTarget);
        if (sha256(stagingTarget) !== imageSha256) {
          throw new Error(`copied validation render failed SHA-256 verification: ${targetName}`);
        }
      } else if (!fs.existsSync(target) || sha256(target) !== imageSha256) {
        throw new Error(`immutable validation render set is incomplete or changed: ${targetName}`);
      }
      portableRenders.push({
        ...render,
        image_path: path.relative(outputRoot, target),
        image_sha256: imageSha256,
      });
    }
    if (!fs.existsSync(renderRoot)) fs.renameSync(stagingRoot, renderRoot);
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  const validationResult = {
    schema_version: 1,
    checkpoint: result.checkpoint || plan.selected_checkpoint || "final",
    score: result.score,
    draw_things_plan_path: path.resolve(String(result.draw_things_plan_path)),
    draw_things_plan_sha256: result.draw_things_plan_sha256,
    validation_plan_path: validationPlanPath,
    validation_plan_sha256: sha256(validationPlanPath),
    lora_path: result.lora_path,
    lora_sha256: result.lora_sha256,
    imported_name: result.imported_name,
    base_model: result.base_model,
    application_version: result.application_version,
    settings: result.settings || fixed,
    render_matrix_sha256: matrixSha256,
    renders: portableRenders,
    notes: result.validation_notes || result.notes || "",
    generated_at: result.generated_at || new Date().toISOString(),
  };
  const validationResultPath = path.join(outputRoot, "validation-result.json");
  atomicJson(validationResultPath, validationResult);
  return {
    validation_result_path: validationResultPath,
    render_count: portableRenders.length,
  };
}

function ingestDrawThings(args) {
  const registryPath = requiredPath("registry_path");
  const registry = readJson(registryPath, { schema_version: 1, revisions: {} });
  const revision = registry.revisions?.[args.job_id];
  if (!revision) throw new Error(`registry entry not found: ${args.job_id}`);
  const resultPath = path.resolve(args.result_path);
  const result = readJson(resultPath, null);
  if (!result) throw new Error(`Draw Things result is missing or invalid: ${resultPath}`);
  const problems = [];
  const drawThingsPlanPath = path.resolve(String(result.draw_things_plan_path || ""));
  let drawThingsPlanDocument = null;
  if (!path.isAbsolute(String(result.draw_things_plan_path || "")) ||
      !fs.existsSync(drawThingsPlanPath) ||
      !fs.statSync(drawThingsPlanPath).isFile()) {
    problems.push("draw_things_plan_path must be an existing absolute file");
  } else {
    const actualPlanSha256 = sha256(drawThingsPlanPath);
    if (actualPlanSha256 !== result.draw_things_plan_sha256) {
      problems.push("Draw Things plan SHA-256 mismatch");
    }
    drawThingsPlanDocument = readJson(drawThingsPlanPath, null);
    if (!drawThingsPlanDocument || drawThingsPlanDocument.job_id !== args.job_id) {
      problems.push("Draw Things plan does not match job_id");
    }
  }
  const loraPath = path.resolve(String(result.lora_path || ""));
  if (!result.import_succeeded) problems.push("Draw Things import did not succeed");
  if (!String(result.imported_name || "").trim()) problems.push("missing imported_name");
  if (!path.isAbsolute(String(result.lora_path || "")) ||
      !fs.existsSync(loraPath) ||
      !fs.statSync(loraPath).isFile()) {
    problems.push("lora_path must be an existing absolute file");
  }
  const actualSha256 = fs.existsSync(loraPath) && fs.statSync(loraPath).isFile()
    ? sha256(loraPath)
    : null;
  if (!/^[a-f0-9]{64}$/.test(String(result.lora_sha256 || "")) ||
      actualSha256 !== result.lora_sha256) {
    problems.push("LoRA SHA-256 does not match the imported source file");
  }
  if (!String(result.base_model || "").trim()) problems.push("missing base_model");
  if (!String(result.application_version || "").trim()) {
    problems.push("missing Draw Things application_version");
  }
  if (drawThingsPlanDocument) {
    if (path.resolve(String(drawThingsPlanDocument.lora_path || "")) !== loraPath ||
        drawThingsPlanDocument.lora_sha256 !== result.lora_sha256) {
      problems.push("LoRA differs from the bound Draw Things plan");
    }
    if (result.imported_name !== drawThingsPlanDocument.import?.imported_name) {
      problems.push("imported_name differs from the bound Draw Things plan");
    }
    if (result.base_model !== drawThingsPlanDocument.import?.expected_base_model) {
      problems.push("base_model differs from the bound Draw Things plan");
    }
    if (path.resolve(String(result.validation_plan_path || "")) !==
        path.resolve(String(drawThingsPlanDocument.validation_plan_path || "")) ||
        result.validation_plan_sha256 !== drawThingsPlanDocument.validation_plan_sha256) {
      problems.push("validation plan differs from the bound Draw Things plan");
    }
  }
  if (result.converted) {
    if (!String(result.conversion_tool || "").trim() ||
        !String(result.conversion_version || "").trim() ||
        !String(result.conversion_command || "").trim() ||
        !String(result.source_lora_sha256 || "").match(/^[a-f0-9]{64}$/)) {
      problems.push("converted import is missing conversion provenance");
    }
  }
  if (problems.length) {
    throw new Error(`Draw Things result failed import checks: ${problems.join("; ")}`);
  }
  const entry = {
    result_path: resultPath,
    draw_things_plan_path: drawThingsPlanPath,
    draw_things_plan_sha256: result.draw_things_plan_sha256,
    imported_name: result.imported_name,
    application_version: result.application_version,
    base_model: result.base_model,
    lora_path: loraPath,
    lora_sha256: actualSha256,
    converted: Boolean(result.converted),
    conversion_tool: result.conversion_tool || null,
    conversion_version: result.conversion_version || null,
    conversion_command: result.conversion_command || null,
    source_lora_sha256: result.source_lora_sha256 || null,
    notes: result.notes || "",
    imported_at: result.imported_at || new Date().toISOString(),
    ingested_at: new Date().toISOString(),
  };
  revision.draw_things ||= { imports: [] };
  revision.draw_things.imports = [
    ...revision.draw_things.imports.filter((item) =>
      item.lora_sha256 !== entry.lora_sha256 ||
      item.imported_name !== entry.imported_name),
    entry,
  ];
  const controlledValidation = ingestControlledValidationResult(
    revision,
    result,
    drawThingsPlanDocument,
  );
  if (controlledValidation) {
    revision.validation ||= [];
    revision.validation = [
      ...revision.validation.filter((item) =>
        item.validation_result_path !== controlledValidation.validation_result_path),
      {
        ...controlledValidation,
        ingested_at: new Date().toISOString(),
      },
    ];
  }
  revision.updated_at = new Date().toISOString();
  atomicJson(registryPath, registry);
  return {
    registry_path: registryPath,
    job_id: args.job_id,
    import_count: revision.draw_things.imports.length,
    imported: entry,
    controlled_validation: controlledValidation,
    next_action:
      controlledValidation
        ? "Controlled validation evidence was written to output/validation-result.json; package may run after confirming training is inactive."
        : "Run and ingest the fixed controlled validation suite; do not treat import success as model acceptance.",
  };
}

function estimate(jobId) {
  const queue = queuePlan();
  const job = queue.jobs.find((entry) => entry.job_id === jobId);
  if (!job) throw new Error(`unknown job: ${jobId}`);
  const configJson = readJson(path.join(job.config_dir, "config.json"), {});
  const datasetBytes = directoryBytes(job.data_dir);
  const imageCount = Number(job.image_count || 0);
  const steps = Number(configJson.max_train_steps || 0);
  const secondsPerIteration = Number(automation.default_seconds_per_iteration || 5.8);
  const checkpoints = steps && configJson.checkpoint_step_interval
    ? Math.floor(steps / Number(configJson.checkpoint_step_interval))
    : 0;
  const checkpointBytes = Number(automation.estimated_checkpoint_bytes || 745000000);
  return {
    job_id: jobId,
    dataset_bytes: datasetBytes,
    image_count: imageCount,
    steps,
    estimated_training_seconds: Math.round(steps * secondsPerIteration),
    estimated_training_hours: Number((steps * secondsPerIteration / 3600).toFixed(2)),
    estimated_checkpoints: checkpoints,
    estimated_output_bytes: checkpoints * checkpointBytes +
      Number(automation.estimated_final_lora_bytes || 190000000),
    recommended_free_space_bytes: checkpoints * checkpointBytes +
      Number(automation.estimated_final_lora_bytes || 190000000) +
      10 * 1024 ** 3,
    ram_note: "Configured for the M4 24 GB unified-memory MPS environment; live memory pressure remains authoritative.",
    basis: {
      seconds_per_iteration: secondsPerIteration,
      checkpoint_bytes: checkpointBytes,
    },
  };
}

function recoveryPlan(jobId = null) {
  const queue = queuePlan();
  const job = jobId
    ? queue.jobs.find((entry) => entry.job_id === jobId)
    : queue.jobs.find((entry) => entry.state === "running") ||
      queue.jobs.find((entry) => entry.state === "failed");
  if (!job) return { recoverable: false, reason: "no running or failed job" };
  const candidates = [];
  for (const root of [
    path.resolve(job.output_dir),
    automation.preservation_root
      ? path.join(
          path.resolve(automation.preservation_root),
          path.basename(path.resolve(job.output_dir)),
          "PRESERVED_CHECKPOINTS",
        )
      : null,
  ].filter(Boolean)) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^checkpoint-\d+$/.test(entry.name)) continue;
      const checkpointPath = path.join(root, entry.name);
      candidates.push(checkpointEvidence(checkpointPath));
    }
  }
  candidates.sort((a, b) => b.step - a.step);
  const selected = candidates.find((entry) => entry.complete) || null;
  return {
    job_id: job.job_id,
    recoverable: Boolean(selected),
    selected_checkpoint: selected,
    candidates,
    action: selected
      ? "Use resume_from_checkpoint=latest or the selected path on the next authorized start."
      : "No complete checkpoint is available; restart only with explicit authorization.",
  };
}

function packetAudit(packetPath) {
  const target = path.resolve(packetPath);
  if (!fs.existsSync(target)) throw new Error(`packet not found: ${target}`);
  const listing = run("/usr/bin/unzip", ["-Z1", target], { timeout: 120000 });
  const integrity = run("/usr/bin/unzip", ["-tqq", target], { timeout: 300000 });
  const entries = listing.stdout.split("\n").filter(Boolean);
  const requirements = {
    weights: entries.some((name) => name.endsWith(".safetensors")),
    config: entries.some((name) => /(^|\/)(config\.json|config\.env)$/.test(name)),
    data_backend: entries.some((name) => /multidatabackend.*\.json$/.test(name)),
    captions: entries.some((name) =>
      /(^|\/)DATASET\/captions\/.+\.txt$/i.test(name)),
    dataset_manifest: entries.some((name) => /manifest.*\.json$/i.test(name)),
    logs: entries.some((name) => /(^|\/)logs?\//i.test(name) || name.endsWith(".log")),
    validation_prompts: entries.some((name) => /validation.*(prompt|plan)/i.test(name)),
    sample_renders: entries.some((name) =>
      /sample|validation/i.test(name) &&
      imageExtensions.has(path.extname(name).toLowerCase())),
    checksums: entries.some((name) => /sha256|checksum/i.test(name)),
    run_summary: entries.some((name) => /run.*summary/i.test(name)),
    evaluation_notes: entries.some((name) => /evaluation.*notes/i.test(name)),
    environment: entries.some((name) => /environment|versions/i.test(name)),
  };
  return {
    packet: target,
    bytes: fs.statSync(target).size,
    sha256: sha256(target),
    zip_integrity_ok: integrity.ok,
    entry_count: entries.length,
    requirements,
    complete: integrity.ok && Object.values(requirements).every(Boolean),
    missing: Object.entries(requirements).filter(([, present]) => !present)
      .map(([name]) => name),
  };
}

function packetValidationPlan(args) {
  const target = path.resolve(args.path);
  if (!fs.existsSync(target)) throw new Error(`packet not found: ${target}`);
  const listing = run("/usr/bin/zipinfo", ["-1", target], { timeout: 120000 });
  if (!listing.ok) throw new Error(listing.stderr || "unable to list packet");
  const entries = listing.stdout.split("\n").filter(Boolean);
  const packetName = path.basename(target);
  const jobId = args.job_id ||
    packetName.match(/^(cap-[^_]+)__/)?.[1] ||
    packetName.replace(/\.zip$/i, "");
  const checkpoints = [...new Set(entries.map((name) =>
    name.match(/OUTPUTS\/(checkpoint-\d+)\/pytorch_lora_weights\.safetensors$/)?.[1])
    .filter(Boolean))]
    .sort((a, b) => Number(a.slice(11)) - Number(b.slice(11)));
  const finalEntry = entries.find((name) =>
    /OUTPUTS\/pytorch_lora_weights\.safetensors$/.test(name)) || null;
  const includeFinal = Boolean(finalEntry) && !checkpoints.includes("checkpoint-1200");
  const trigger = args.trigger || jobId.replace(/^cap-/, "");
  const validationEntry = entries.find((name) =>
    /CONFIG\/validation-(?:prompt-library|prompts)\.json$/i.test(name));
  if (!validationEntry) {
    throw new Error("packet does not contain a validation prompt library");
  }
  const validationResult = run("/usr/bin/unzip", ["-p", target, validationEntry], {
    timeout: 120000,
  });
  if (!validationResult.ok) {
    throw new Error(validationResult.stderr || "unable to read validation prompt library");
  }
  let validation;
  try {
    validation = JSON.parse(validationResult.stdout);
  } catch (error) {
    throw new Error(`invalid validation prompt library: ${error.message}`);
  }
  if (!Array.isArray(validation.prompts) || !validation.prompts.length) {
    throw new Error("validation prompt library has no prompts");
  }
  const plan = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    job_id: jobId,
    packet_path: target,
    packet_sha256: sha256(target),
    trigger,
    checkpoint_candidates: [
      ...checkpoints.map((checkpoint) => ({
        checkpoint,
        archive_entry: entries.find((name) =>
          name.endsWith(`OUTPUTS/${checkpoint}/pytorch_lora_weights.safetensors`)),
      })),
      ...(includeFinal ? [{ checkpoint: "final", archive_entry: finalEntry }] : []),
    ],
    fixed_settings: validationFixedSettings(validation),
    prompts: validation.prompts,
    required_render_count: checkpoints.length + (includeFinal ? 1 : 0),
    render_matrix: "Each checkpoint candidate × every fixed prompt × every fixed seed.",
    state: "awaiting_m2_draw_things_import_and_render",
  };
  plan.required_render_count *= plan.prompts.length * plan.fixed_settings.seeds.length;
  const root = args.output_dir
    ? path.resolve(args.output_dir)
    : path.join(stateRoot, "lora-validation-queue");
  fs.mkdirSync(root, { recursive: true });
  const planPath = path.join(root, `${jobId}-packet-validation-plan.json`);
  atomicJson(planPath, plan);
  return { plan_path: planPath, plan };
}

function ingestValidation(args) {
  const registryPath = requiredPath("registry_path");
  const registry = readJson(registryPath, { schema_version: 1, revisions: {} });
  const revision = registry.revisions?.[args.job_id];
  if (!revision) throw new Error(`registry entry not found: ${args.job_id}`);
  const resultPath = path.resolve(args.result_path);
  if (!fs.existsSync(resultPath)) {
    throw new Error(`validation result not found: ${resultPath}`);
  }
  const result = readJson(resultPath);
  if (!result || !Array.isArray(result.renders)) {
    throw new Error("validation result must contain a renders array");
  }
  const seenRenderKeys = new Set();
  const renderProblems = [];
  const validationPlanPath = String(result.validation_plan_path || "").trim();
  let validationPlanDocument = null;
  if (!validationPlanPath || !path.isAbsolute(validationPlanPath) ||
      !fs.existsSync(validationPlanPath) ||
      !fs.statSync(validationPlanPath).isFile()) {
    renderProblems.push("validation_plan_path must be an existing absolute file");
  } else {
    const actualPlanSha256 = sha256(validationPlanPath);
    if (actualPlanSha256 !== result.validation_plan_sha256) {
      renderProblems.push("validation plan SHA-256 mismatch");
    }
    validationPlanDocument = readJson(validationPlanPath, null);
    if (!validationPlanDocument ||
        validationPlanDocument.job_id !== args.job_id) {
      renderProblems.push("validation plan does not match job_id");
    }
  }
  const requiredPromptIds = new Set(
    Array.isArray(validationPlanDocument?.prompts)
      ? validationPlanDocument.prompts.map((entry) => entry.id)
      : [],
  );
  if (!requiredPromptIds.size || [...requiredPromptIds].some((id) => !id)) {
    renderProblems.push("validation plan must contain prompts with non-empty IDs");
  }
  const seedsByPrompt = new Map(
    [...requiredPromptIds].map((promptId) => [promptId, new Set()]),
  );
  const requiredSeeds = new Set(
    Array.isArray(validationPlanDocument?.fixed_settings?.seeds)
      ? validationPlanDocument.fixed_settings.seeds.map(Number)
      : [],
  );
  if (!requiredSeeds.size || [...requiredSeeds].some((seed) => !Number.isInteger(seed))) {
    renderProblems.push("validation plan must contain fixed integer seeds");
  }
  for (const [index, render] of result.renders.entries()) {
    if (!requiredPromptIds.has(render.prompt_id)) {
      renderProblems.push(`render ${index}: invalid prompt_id`);
    }
    const seed = Number(render.seed);
    if (!Number.isInteger(seed)) {
      renderProblems.push(`render ${index}: seed must be an integer`);
    }
    const renderKey = `${render.prompt_id}:${seed}`;
    if (Number.isInteger(seed) && !requiredSeeds.has(seed)) {
      renderProblems.push(`render ${index}: seed is not in the fixed seed set`);
    }
    if (requiredPromptIds.has(render.prompt_id) && requiredSeeds.has(seed)) {
      if (seenRenderKeys.has(renderKey)) {
        renderProblems.push(
          `render ${index}: duplicate prompt/seed pair ${renderKey}`,
        );
      } else {
        seenRenderKeys.add(renderKey);
        seedsByPrompt.get(render.prompt_id).add(seed);
      }
    }
    const imagePath = String(render.image_path || "").trim();
    if (!imagePath) {
      renderProblems.push(`render ${index}: missing image_path`);
    } else if (!path.isAbsolute(imagePath)) {
      renderProblems.push(`render ${index}: image_path must be absolute`);
    } else if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
      renderProblems.push(`render ${index}: image_path does not exist`);
    }
    if (!render.live_metadata ||
        (typeof render.live_metadata === "object" &&
          !Object.keys(render.live_metadata).length)) {
      renderProblems.push(`render ${index}: missing live_metadata`);
    }
    if (!Number.isFinite(Number(render.score))) {
      renderProblems.push(`render ${index}: score must be numeric`);
    }
  }
  const requiredSeedSignature = [...requiredSeeds].sort((a, b) => a - b).join(",");
  for (const promptId of requiredPromptIds) {
    const actualSeedSignature = [...seedsByPrompt.get(promptId)]
      .sort((a, b) => a - b).join(",");
    if (actualSeedSignature !== requiredSeedSignature) {
      renderProblems.push(`fixed prompt ${promptId} does not have the exact fixed seed set`);
    }
  }
  if (!String(result.checkpoint || "").trim()) {
    renderProblems.push("missing checkpoint");
  }
  let expectedLoraPath = null;
  if (validationPlanDocument) {
    if (result.checkpoint === "final") {
      expectedLoraPath = validationPlanDocument.lora_path;
    } else {
      expectedLoraPath = validationPlanDocument.checkpoint_candidates?.find(
        (entry) => entry.checkpoint === result.checkpoint,
      )?.lora_path || null;
    }
    if (!expectedLoraPath) {
      renderProblems.push("checkpoint is not present in the bound validation plan");
    }
    if (JSON.stringify(result.settings || null) !==
        JSON.stringify(validationPlanDocument.fixed_settings || null)) {
      renderProblems.push("validation settings differ from the bound fixed settings");
    }
  }
  const resultLoraPath = String(result.lora_path || "").trim();
  if (!resultLoraPath || !path.isAbsolute(resultLoraPath) ||
      !fs.existsSync(resultLoraPath) ||
      !fs.statSync(resultLoraPath).isFile()) {
    renderProblems.push("lora_path must be an existing absolute file");
  } else {
    if (expectedLoraPath &&
        path.resolve(resultLoraPath) !== path.resolve(expectedLoraPath)) {
      renderProblems.push("lora_path differs from the bound checkpoint");
    }
    if (sha256(resultLoraPath) !== result.lora_sha256) {
      renderProblems.push("LoRA SHA-256 mismatch");
    }
  }
  if (!Number.isFinite(Number(result.score))) {
    renderProblems.push("overall score must be numeric");
  }
  if (renderProblems.length) {
    throw new Error(
      `validation result failed controlled-suite checks: ${renderProblems.join("; ")}`,
    );
  }
  revision.validation = [
    ...(revision.validation || []).filter((entry) => entry.result_path !== resultPath),
    {
      result_path: resultPath,
      checkpoint: result.checkpoint || null,
      validation_plan_path: validationPlanPath,
      validation_plan_sha256: result.validation_plan_sha256,
      lora_path: resultLoraPath,
      lora_sha256: result.lora_sha256,
      settings: result.settings,
      renders: result.renders,
      score: Number.isFinite(Number(result.score)) ? Number(result.score) : null,
      notes: result.notes || "",
      ingested_at: new Date().toISOString(),
    },
  ];
  const ranked = revision.validation.filter((entry) => entry.score !== null)
    .sort((a, b) => b.score - a.score);
  revision.recommended_checkpoint = ranked[0]?.checkpoint || null;
  revision.updated_at = new Date().toISOString();
  atomicJson(registryPath, registry);
  return {
    registry_path: registryPath,
    job_id: args.job_id,
    validation_count: revision.validation.length,
    recommended_checkpoint: revision.recommended_checkpoint,
  };
}

function ingestRevision(args) {
  const source = path.resolve(args.source_path);
  if (!fs.statSync(source).isDirectory()) {
    throw new Error("source_path is not a directory");
  }
  const preflight = preflightDataset(source, true);
  if (!preflight.valid) {
    return { accepted: false, reason: "preflight failed", preflight };
  }
  const root = requiredPath("revision_root");
  const revisionId = `${String(args.job_id).replaceAll(/[^A-Za-z0-9._-]/g, "-")}` +
    `-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const destination = path.join(root, revisionId, "dataset");
  fs.mkdirSync(destination, { recursive: true });
  const copied = run("/usr/bin/ditto", [source, destination], { timeout: 3600000 });
  if (!copied.ok) throw new Error(copied.stderr || "dataset copy failed");
  const record = {
    schema_version: 1,
    revision_id: revisionId,
    parent_job_id: args.job_id,
    source_path: source,
    dataset_path: destination,
    trigger: args.trigger || null,
    notes: args.notes || "",
    created_at: new Date().toISOString(),
    preflight_manifest: preflight.manifest_path,
  };
  const recordPath = path.join(root, revisionId, "revision.json");
  atomicJson(recordPath, record);
  const registryPath = requiredPath("registry_path");
  const registry = readJson(registryPath, {
    schema_version: 1,
    revisions: {},
  });
  registry.revisions ||= {};
  registry.revisions[revisionId] = {
    job_id: revisionId,
    kind: "dataset_revision",
    parent_revision: args.job_id,
    source: source,
    trigger: record.trigger,
    dataset_path: destination,
    preflight_manifest: preflight.manifest_path,
    revision_record: recordPath,
    state: "ready_unapproved",
    training_authorized: false,
    outputs: [],
    packets: [],
    validation: [],
    created_at: record.created_at,
    updated_at: record.created_at,
  };
  if (registry.revisions[args.job_id]) {
    registry.revisions[args.job_id].child_revisions = [
      ...new Set([
        ...(registry.revisions[args.job_id].child_revisions || []),
        revisionId,
      ]),
    ];
    registry.revisions[args.job_id].updated_at = record.created_at;
  }
  registry.generated_at = record.created_at;
  atomicJson(registryPath, registry);
  return {
    accepted: true,
    record_path: recordPath,
    revision_path: recordPath,
    registry_path: registryPath,
    revision: record,
  };
}

function preflightAll() {
  const queue = queuePlan();
  const results = [];
  for (const job of queue.jobs) {
    const dataset = preflightDataset(job.data_dir, true);
    const configPath = path.join(job.config_dir, "config.json");
    const backendPath = path.join(job.config_dir, "multidatabackend.json");
    const configJson = readJson(configPath, null);
    const backendJson = readJson(backendPath, null);
    const configProblems = [];
    if (!configJson) configProblems.push("missing_or_invalid_config");
    if (!backendJson) configProblems.push("missing_or_invalid_data_backend");
    if (configJson && !configJson.max_train_steps) {
      configProblems.push("missing_max_train_steps");
    }
    if (configJson && !configJson.checkpoint_step_interval) {
      configProblems.push("missing_checkpoint_interval");
    }
    if (configJson && !configJson.validation_prompt) {
      configProblems.push("missing_validation_prompt");
    }
    if (Number(job.image_count || 0) !== dataset.image_count) {
      configProblems.push("manifest_image_count_mismatch");
    }
    if (Number(job.caption_count || 0) !== dataset.caption_count) {
      configProblems.push("manifest_caption_count_mismatch");
    }
    results.push({
      job_id: job.job_id,
      state: job.state,
      dataset_path: job.data_dir,
      dataset_manifest: dataset.manifest_path,
      technical_ready: dataset.image_count > 0 &&
        !dataset.problems.some((problem) => [
          "corrupt_or_unreadable", "missing_caption", "empty_caption",
          "duplicate_image", "orphan_caption",
        ].includes(problem.issue)),
      caption_structure_ready: !dataset.problems.some((problem) =>
        problem.issue === "caption_structure_incomplete"),
      config_ready: configProblems.length === 0,
      problems: [...dataset.problems, ...configProblems.map((issue) => ({ issue }))],
      config: configJson ? {
        model_family: configJson.model_family || null,
        pretrained_model_name_or_path: configJson.pretrained_model_name_or_path || null,
        resolution: configJson.resolution || null,
        max_train_steps: configJson.max_train_steps || null,
        checkpoint_step_interval: configJson.checkpoint_step_interval || null,
        resume_from_checkpoint: configJson.resume_from_checkpoint || null,
        lora_rank: configJson.lora_rank || null,
        lora_alpha: configJson.lora_alpha || null,
      } : null,
    });
  }
  const summary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    job_count: results.length,
    technically_ready: results.filter((entry) => entry.technical_ready).length,
    caption_structure_ready: results.filter((entry) => entry.caption_structure_ready).length,
    config_ready: results.filter((entry) => entry.config_ready).length,
    results,
  };
  const summaryPath = path.join(
    requiredPath("manifest_root"),
    `all-datasets-${Date.now()}-preflight-summary.json`,
  );
  atomicJson(summaryPath, summary);
  return { summary_path: summaryPath, ...summary };
}

function delegateToActiveRuntime(action, args) {
  const runtimeAware = new Set([
    "training-readiness",
    "scheduler-enqueue",
    "telemetry",
    "queue",
    "compare",
    "recovery",
    "registry-refresh",
    "validation-plan",
    "validation-ingest",
    "draw-things-plan",
    "draw-things-ingest",
    "revision-ingest",
    "estimate",
  ]);
  if (!runtimeAware.has(action) || args._runtime_delegated === true) return null;
  const pointerPath = path.resolve(
    automation.active_runtime_pointer ||
      path.join(path.dirname(configPath), "active-lora-runtime.json"),
  );
  const pointer = readJson(pointerPath, null);
  if (!pointer?.config_path) return null;
  const runtimeConfig = path.resolve(pointer.config_path);
  if (runtimeConfig === configPath) return null;
  if (path.basename(runtimeConfig) !== "hawkspan-runtime-config.json") {
    throw new Error("refusing to delegate HawkSpan-D through an unrecognized runtime config");
  }
  if (
    pointer.runtime_root &&
    !runtimeConfig.startsWith(`${path.resolve(pointer.runtime_root)}${path.sep}`)
  ) {
    throw new Error("active runtime config is outside its recorded runtime root");
  }
  const delegated = run(process.execPath, [
    path.resolve(process.argv[1]),
    action,
    JSON.stringify({ ...args, _runtime_delegated: true }),
  ], {
    env: {
      ...process.env,
      HAWKSPAN_CONFIG: runtimeConfig,
      HAWKSPAN_STATE_DIR: stateRoot,
    },
    timeout: Number(args.timeout_ms || 24 * 60 * 60 * 1000),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!delegated.ok) {
    throw new Error(
      delegated.stderr.trim() || delegated.error ||
        `active runtime delegation exited ${delegated.status}`,
    );
  }
  return JSON.parse(delegated.stdout);
}

function main() {
  const [action, encoded = "{}"] = process.argv.slice(2);
  const args = JSON.parse(encoded);
  let result = delegateToActiveRuntime(action, args);
  if (result !== null) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  switch (action) {
    case "inventory":
      result = installedInventory();
      break;
    case "preflight":
      result = preflightDataset(args.path, args.write_manifest === true, args);
      break;
    case "preflight-all":
      result = preflightAll();
      break;
    case "training-readiness":
      result = trainingReadiness(args);
      break;
    case "prepare-versioned-job":
      result = prepareVersionedJob(args);
      break;
    case "scheduler-enqueue":
      result = schedulerEnqueue(args);
      break;
    case "stage-runtime-job":
      result = stageRuntimeJob(args);
      break;
    case "telemetry":
      result = processSnapshot();
      break;
    case "queue":
      result = queuePlan();
      break;
    case "compare":
      result = checkpointComparison(args.job_id);
      break;
    case "recovery":
      result = recoveryPlan(args.job_id || null);
      break;
    case "packet-audit":
      result = packetAudit(args.path);
      break;
    case "packet-validation-plan":
      result = packetValidationPlan(args);
      break;
    case "registry-refresh":
      result = refreshRegistry();
      break;
    case "validation-plan":
      result = validationPlan(args.job_id);
      break;
    case "validation-ingest":
      result = ingestValidation(args);
      break;
    case "draw-things-plan":
      result = drawThingsPlan(args.job_id);
      break;
    case "draw-things-ingest":
      result = ingestDrawThings(args);
      break;
    case "revision-ingest":
      result = ingestRevision(args);
      break;
    case "estimate":
      result = estimate(args.job_id);
      break;
    default:
      throw new Error(`unknown action: ${action}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
