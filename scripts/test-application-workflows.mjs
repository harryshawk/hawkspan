import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createApplicationPluginFramework } from "./application-plugins.mjs";
import { createApplicationWorkflows, DEFAULT_SIMPLETUNER_CHECKPOINT_STEPS } from "../examples/plugins/application-workflows/plugin.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDirectory = path.join(repository, "examples", "plugins", "application-workflows");
const pluginSource = fs.readFileSync(path.join(pluginDirectory, "plugin.mjs"), "utf8");
const publicPluginConfig = fs.readFileSync(path.join(pluginDirectory, "config.example.json"), "utf8");
const publicPluginEnvironment = fs.readFileSync(path.join(pluginDirectory, "hawkspan.env.example"), "utf8");
assert.equal(JSON.parse(publicPluginConfig).local_trainer.package_timeout_ms, 60 * 60 * 1000);
for (const removed of [
  "HAWKSPAN_SIMPLETUNER_BASE_URL", "HAWKSPAN_SIMPLETUNER_API_TOKEN", "/openapi.json",
  "/api/version", "/api/queue/submit", "createRestClient", "simpletuner_capabilities",
]) {
  assert.equal(`${pluginSource}\n${publicPluginConfig}\n${publicPluginEnvironment}`.includes(removed), false, `removed REST identifier remains: ${removed}`);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-simpletuner-workflows-test-"));
const mkdir = (...parts) => { const result = path.join(temporary, ...parts); fs.mkdirSync(result, { recursive: true }); return result; };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : object(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const revision = (value) => digest(canonical(value));
const inventory = (directory) => {
  const files = [];
  const visit = (current) => fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) { const bytes = fs.readFileSync(file); files.push({ path: path.relative(directory, file).split(path.sep).join("/"), size_bytes: bytes.length, sha256: digest(bytes) }); }
  });
  visit(directory); files.sort((a, b) => a.path.localeCompare(b.path));
  const normalized = { schema_version: 1, file_count: files.length, total_bytes: files.reduce((sum, item) => sum + item.size_bytes, 0), files };
  return { ...normalized, revision: revision(normalized) };
};

const roots = Object.freeze({ inbox: mkdir("inbox"), datasets: mkdir("datasets"), recipes: mkdir("recipes"), output: mkdir("output"), state: mkdir("state"), disk: mkdir("disk"), runtime: mkdir("runtime"), logs: mkdir("runtime", "logs") });
const fakeTrainerStart = path.join(temporary, "fake-trainer-start.sh");
const fakeTrainerStop = path.join(temporary, "fake-trainer-stop.sh");
const fakeTrainerPackage = path.join(temporary, "fake-trainer-package.sh");
const fakeReturnPacket = path.join(roots.output, "runtime-job--return-packet.zip");
write(fakeTrainerStart, "#!/bin/sh\nexit 0\n");
write(fakeTrainerStop, "#!/bin/sh\nexit 0\n");
write(fakeTrainerPackage, "#!/bin/sh\nexit 0\n");
write(fakeReturnPacket, "verified return packet bytes\n");
const fakeReturnPacketSha256 = digest(fs.readFileSync(fakeReturnPacket));
const source = mkdir("inbox", "delivered-sample");
write(path.join(source, "sample.png"), "synthetic image bytes");
write(path.join(source, "sample.txt"), "synthetic caption");
const manifest = inventory(source);
const datasetBundleBytes = Buffer.from(JSON.stringify({
  schema_version: 1,
  kind: "hawkspan.dataset-bundle",
  manifest,
  files: manifest.files.map((entry) => ({
    path: entry.path,
    content_base64: fs.readFileSync(path.join(source, entry.path)).toString("base64"),
  })),
}));
const datasetBundlePath = path.join(temporary, "dataset-bundle.json");
write(datasetBundlePath, datasetBundleBytes);
const datasetBundleSha256 = digest(datasetBundleBytes);
const referencedBundleBytes = Buffer.from(JSON.stringify({
  schema_version: 1,
  kind: "hawkspan.dataset-bundle",
  manifest,
  files: manifest.files.map((entry, index) => ({
    path: entry.path,
    artifact_id: `artifact-dataset-file-${index}`,
    artifact_sha256: entry.sha256,
  })),
}));
const referencedBundlePath = path.join(temporary, "referenced-dataset-bundle.json");
write(referencedBundlePath, referencedBundleBytes);
const referencedBundleSha256 = digest(referencedBundleBytes);
const runtimeDataset = mkdir("datasets", "runtime-sample");
const runtimeTargets = mkdir("datasets", "runtime-sample", "targets");
const runtimeConditioning = mkdir("datasets", "runtime-sample", "conditioning");
write(path.join(runtimeTargets, "subject.jpg"), "runtime image bytes");
write(path.join(runtimeTargets, "subject.txt"), "runtime caption");
write(path.join(runtimeConditioning, "subject.png"), "runtime canny bytes");
write(path.join(runtimeConditioning, "subject.txt"), "runtime caption");
const runtimeRecipeDocument = {
  schema_version: 1,
  config_name: "runtime-config",
  config: {
    data_backend_config: path.join(roots.recipes, "runtime-recipe.multidatabackend.json"),
    output_dir: path.join(roots.output, "runtime-job"),
    max_train_steps: 100,
    optimizer: "adamw_bf16",
    mixed_precision: "bf16",
    checkpoint_step_interval: 25,
    checkpoints_total_limit: 2,
    controlnet: true,
    eval_dataset_id: "images_conditioning_canny",
  },
};
const runtimeRecipeBytes = Buffer.from(JSON.stringify(runtimeRecipeDocument));
write(path.join(roots.recipes, "runtime-recipe.json"), runtimeRecipeBytes);
write(path.join(roots.recipes, "runtime-recipe.multidatabackend.json"), JSON.stringify([
  { id: "images", type: "local", dataset_type: "image", conditioning: { type: "canny", conditioning_type: "controlnet", instance_data_dir: runtimeConditioning }, instance_data_dir: runtimeTargets, caption_strategy: "textfile", repeats: 1, cache_dir_vae: path.join(temporary, "source-cache", "vae") },
  { id: "text", dataset_type: "text_embeds", cache_dir: path.join(temporary, "source-cache", "text") },
]));
write(path.join(roots.recipes, "runtime-recipe.policy.json"), JSON.stringify({
  schema_version: 1,
  minimum_checkpoint_retention: 2,
  validation_prompt_library: path.join(roots.recipes, "runtime-recipe.validation-prompts.json"),
}));
write(path.join(roots.recipes, "runtime-recipe.validation-prompts.json"), JSON.stringify({
  schema_version: 1,
  trigger: "hawkspan robots",
  prompts: [
    { id: "cute-hero-product", prompt: "hawkspan robots, two cute friendly robots in a product scene" },
    { id: "cute-creative-workflow", prompt: "hawkspan robots, cute paired robots collaborating in a studio" },
    { id: "cute-redundant-links", prompt: "hawkspan robots, two cute robots connected by redundant links" },
    { id: "cute-campaign-span", prompt: "hawkspan robots, two cute helper robots across a glowing span" },
  ],
}));
const runtimeRecipeRevision = digest(runtimeRecipeBytes);

const environment = Object.freeze({
  HAWKSPAN_WORKLOAD_INBOX_ROOT: roots.inbox, HAWKSPAN_WORKLOAD_DATASET_ROOT: roots.datasets,
  HAWKSPAN_WORKLOAD_RECIPE_ROOT: roots.recipes, HAWKSPAN_WORKLOAD_OUTPUT_ROOT: roots.output,
  HAWKSPAN_WORKLOAD_STATE_ROOT: roots.state, HAWKSPAN_WORKLOAD_DISK_ROOT: roots.disk,
  HAWKSPAN_WORKLOAD_RUNTIME_ROOT: roots.runtime,
  HAWKSPAN_WORKLOAD_LOG_ROOT: roots.logs,
  HAWKSPAN_SIMPLETUNER_ROOT: roots.disk,
  HAWKSPAN_LOCAL_TRAINER_START_SCRIPT: fakeTrainerStart,
  HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT: fakeTrainerStop,
  HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT: fakeTrainerPackage,
  HAWKSPAN_PRIVATE_SHOULD_NOT_LEAK: "private-value",
});
const features = Object.fromEntries(["inspect", "stage", "validate", "local_trainer_start", "local_trainer_stop", "local_trainer_package"].map((name) => [name, true]));
const configuration = Object.freeze({
  mode: "simpletuner-workflows", role: "worker", features,
  paths: Object.freeze({
    inbox_root: { env: "HAWKSPAN_WORKLOAD_INBOX_ROOT" }, dataset_root: { env: "HAWKSPAN_WORKLOAD_DATASET_ROOT" },
    recipe_root: { env: "HAWKSPAN_WORKLOAD_RECIPE_ROOT" }, output_root: { env: "HAWKSPAN_WORKLOAD_OUTPUT_ROOT" },
    state_root: { env: "HAWKSPAN_WORKLOAD_STATE_ROOT" }, disk_root: { env: "HAWKSPAN_WORKLOAD_DISK_ROOT" },
    runtime_root: { env: "HAWKSPAN_WORKLOAD_RUNTIME_ROOT" },
    log_root: { env: "HAWKSPAN_WORKLOAD_LOG_ROOT" },
  }),
  limits: Object.freeze({ max_files: 1000, max_total_bytes: 1024 * 1024, max_json_bytes: 1024 * 1024 }),
  required_job: Object.freeze({ kind_prefix: "simpletuner-workflow", state: "authorized" }),
  local_trainer: Object.freeze({
    simpletuner_root: { env: "HAWKSPAN_SIMPLETUNER_ROOT" },
    start_script: { env: "HAWKSPAN_LOCAL_TRAINER_START_SCRIPT" },
    stop_script: { env: "HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT" },
    package_script: { env: "HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT" },
    timeout_ms: 2000,
  }),
});
const authorizations = [];
const coreCalls = [];
const coreArtifacts = new Map([["artifact-dataset-bundle", {
  path: datasetBundlePath,
  sha256: datasetBundleSha256,
}], ["artifact-referenced-dataset-bundle", {
  path: referencedBundlePath,
  sha256: referencedBundleSha256,
}], ...manifest.files.map((entry, index) => [`artifact-dataset-file-${index}`, {
  path: path.join(source, entry.path),
  sha256: entry.sha256,
}])]);
const callCoreTool = async (name, args) => {
  coreCalls.push({ name, args: structuredClone(args) });
  if (name === "verify_artifact") {
    const artifact = coreArtifacts.get(args.artifact_id);
    if (!artifact) throw new Error("artifact not found");
    return { artifact_id: args.artifact_id, path: artifact.path, sha256: artifact.sha256, expected_sha256: args.expected_sha256, matches: artifact.sha256 === args.expected_sha256 };
  }
  if (name === "register_artifact") {
    const bytes = fs.readFileSync(args.path);
    const artifact = { path: args.path, sha256: digest(bytes) };
    coreArtifacts.set("artifact-returned-result", artifact);
    return { artifact_id: "artifact-returned-result", path: args.path, size_bytes: bytes.length, sha256: artifact.sha256 };
  }
  if (name === "send_artifact") return { artifact_id: args.artifact_id, delivery: { ok: true, verified: true } };
  throw new Error(`unexpected core tool: ${name}`);
};
const workflows = createApplicationWorkflows(configuration, {
  environment, disk_status: async () => ({ bsize: 4096, blocks: 100, bavail: 40 }),
  now: () => "2000-01-01T00:00:00.000Z",
  require_authorized_job(requirement) { authorizations.push(requirement); return { ...requirement, recorded: true }; },
  call_core_tool: callCoreTool,
});

for (const packageTimeoutMs of [29999, 4 * 60 * 60 * 1000 + 1]) {
  assert.throws(() => createApplicationWorkflows({
    ...configuration,
    local_trainer: { ...configuration.local_trainer, package_timeout_ms: packageTimeoutMs },
  }, { environment, require_authorized_job() {}, call_core_tool() {} }),
  /local_trainer\.package_timeout_ms must be from 30000 through 14400000/);
}
for (const packageTimeoutMs of [30000, 4 * 60 * 60 * 1000]) {
  assert.doesNotThrow(() => createApplicationWorkflows({
    ...configuration,
    local_trainer: { ...configuration.local_trainer, package_timeout_ms: packageTimeoutMs },
  }, { environment, require_authorized_job() {}, call_core_tool() {} }));
}

{
  // Gherkin: retain the local checkpoint policy without claiming runtime installation proof.
  assert.deepEqual(DEFAULT_SIMPLETUNER_CHECKPOINT_STEPS, [600, 800, 900, 1000, 1200]);
  const disk = await workflows.worker_disk_status({});
  assert.deepEqual(disk, { total_bytes: 409600, available_bytes: 163840, used_bytes: 245760 });

  const staged = await workflows.training_stage_sample_set({ job_id: "auth-stage", source_id: "delivered-sample", dataset_id: "sample-alpha", manifest });
  assert.equal(staged.changed, true);
  assert.equal((await workflows.training_stage_sample_set({ job_id: "auth-stage-repeat", source_id: "delivered-sample", dataset_id: "sample-alpha", manifest })).changed, false);
  assert.match(authorizations[0].kind, /^simpletuner-workflow:stage:sample-alpha:[a-f0-9]{64}$/);

  const imported = await workflows.training_import_dataset_bundle({
    job_id: "auth-import", artifact_id: "artifact-dataset-bundle",
    artifact_sha256: datasetBundleSha256, dataset_id: "artifact-sample",
  });
  assert.equal(imported.changed, true);
  assert.equal(imported.revision, manifest.revision);
  assert.equal(imported.file_count, 2);
  assert.equal(fs.readFileSync(path.join(roots.datasets, "artifact-sample", "sample.txt"), "utf8"), "synthetic caption");
  assert.equal((await workflows.training_import_dataset_bundle({
    job_id: "auth-import-repeat", artifact_id: "artifact-dataset-bundle",
    artifact_sha256: datasetBundleSha256, dataset_id: "artifact-sample",
  })).changed, false);
  assert.match(authorizations.find(({ job_id }) => job_id === "auth-import").kind, /^simpletuner-workflow:import:artifact-sample:[a-f0-9]{64}$/);
  const referencedImport = await workflows.training_import_dataset_bundle({
    job_id: "auth-import-referenced", artifact_id: "artifact-referenced-dataset-bundle",
    artifact_sha256: referencedBundleSha256, dataset_id: "artifact-sample-referenced",
  });
  assert.equal(referencedImport.changed, true);
  assert.equal(fs.readFileSync(path.join(roots.datasets, "artifact-sample-referenced", "sample.txt"), "utf8"), "synthetic caption");

  const readiness = await workflows.training_readiness({
    job_id: "runtime-job",
    dataset_id: "runtime-sample",
    recipe_id: "runtime-recipe",
    recipe_revision: runtimeRecipeRevision,
  });
  assert.equal(readiness.ready, true, JSON.stringify(readiness.problems));
  assert.match(readiness.revision_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(readiness.readiness_path), true);
  const missingOptimizerRecipe = structuredClone(runtimeRecipeDocument);
  delete missingOptimizerRecipe.config.optimizer;
  write(path.join(roots.recipes, "missing-optimizer.json"), JSON.stringify(missingOptimizerRecipe));
  write(path.join(roots.recipes, "missing-optimizer.policy.json"), fs.readFileSync(path.join(roots.recipes, "runtime-recipe.policy.json")));
  write(path.join(roots.recipes, "missing-optimizer.validation-prompts.json"), fs.readFileSync(path.join(roots.recipes, "runtime-recipe.validation-prompts.json")));
  const missingOptimizerRevision = digest(fs.readFileSync(path.join(roots.recipes, "missing-optimizer.json")));
  const missingOptimizer = await workflows.training_readiness({
    job_id: "missing-optimizer", dataset_id: "runtime-sample", recipe_id: "missing-optimizer", recipe_revision: missingOptimizerRevision,
  });
  assert.equal(missingOptimizer.ready, false);
  assert.ok(missingOptimizer.problems.some(({ issue }) => issue === "missing_optimizer"));
  const stagedRuntime = await workflows.training_stage_runtime_job({
    job_id: "runtime-job",
    dataset_id: "runtime-sample",
    recipe_id: "runtime-recipe",
  });
  assert.equal(stagedRuntime.training_started, false);
  assert.equal(stagedRuntime.ready, true, JSON.stringify(stagedRuntime.problems));
  assert.match(stagedRuntime.revision_fingerprint, /^[a-f0-9]{64}$/);
  const stageManifest = JSON.parse(fs.readFileSync(path.join(stagedRuntime.runtime_job_root, "STAGE-MANIFEST.json"), "utf8"));
  assert.equal(stageManifest.training_authorized, false);
  assert.equal(stageManifest.training_started, false);
  const stagedConfig = JSON.parse(fs.readFileSync(path.join(stagedRuntime.runtime_job_root, "config", "config.json"), "utf8"));
  const stagedBackend = JSON.parse(fs.readFileSync(path.join(stagedRuntime.runtime_job_root, "config", "multidatabackend.json"), "utf8"));
  const stagedPolicy = JSON.parse(fs.readFileSync(path.join(stagedRuntime.runtime_job_root, "config", "TRAINING_READINESS_POLICY.json"), "utf8"));
  const realRuntimeRoot = fs.realpathSync(roots.runtime);
  assert.equal(stagedConfig.output_dir, path.join(realRuntimeRoot, "outputs", "runtime-job"));
  assert.equal(stagedConfig.data_backend_config, path.join(stagedRuntime.runtime_job_root, "config", "multidatabackend.json"));
  const stagedEnvelope = JSON.parse(fs.readFileSync(path.join(stagedRuntime.runtime_job_root, "config", "hawkspan-recipe.json"), "utf8"));
  assert.deepEqual(stagedConfig, stagedEnvelope.config);
  assert.equal(stagedBackend.find((entry) => entry.id === "images").instance_data_dir, path.join(stagedRuntime.runtime_job_root, "dataset", "targets"));
  assert.equal(stagedBackend.find((entry) => entry.id === "images").conditioning.instance_data_dir, path.join(stagedRuntime.runtime_job_root, "dataset", "conditioning"));
  assert.equal(stagedPolicy.validation_prompt_library, path.join(stagedRuntime.runtime_job_root, "config", "validation-prompts.json"));
  assert.equal((await workflows.training_stage_runtime_job({ job_id: "runtime-job", dataset_id: "runtime-sample", recipe_id: "runtime-recipe" })).already_present, true);
  const commandCalls = [];
  const localTrainer = createApplicationWorkflows(configuration, {
    environment,
    now: () => "2000-01-01T00:00:00.000Z",
    require_authorized_job(requirement) { authorizations.push(requirement); return { ...requirement, recorded: true }; },
    call_core_tool: callCoreTool,
    command_runner(command, args, options) {
      commandCalls.push({ command, args: [...args], env: { ...options.env }, cwd: options.cwd, timeout: options.timeout });
      if (command === fakeTrainerStart) {
        const stageManifestPath = path.join(stagedRuntime.runtime_job_root, "STAGE-MANIFEST.json");
        const claimed = JSON.parse(fs.readFileSync(stageManifestPath, "utf8"));
        claimed.training_started = true;
        write(stageManifestPath, JSON.stringify(claimed));
      }
      if (command === fakeTrainerPackage) return {
        status: 0,
        stdout: `${JSON.stringify({
          built: true,
          identity: `runtime-job:${stagedRuntime.revision_fingerprint}:packet-inventory`,
          target: "runtime-job",
          revision_fingerprint: stagedRuntime.revision_fingerprint,
          packet_path: fakeReturnPacket,
          packet_sha256: fakeReturnPacketSha256,
          status: "packaged",
        })}\n`,
        stderr: "",
      };
      return { status: 0, stdout: "ok\n".repeat(5000), stderr: "" };
    },
  });
  const localTrainerStartDisabled = createApplicationWorkflows(
    { ...configuration, features: { ...features, local_trainer_start: false } },
    { environment, require_authorized_job() { throw new Error("authorization should not run"); }, call_core_tool: callCoreTool, command_runner() { throw new Error("command should not run"); } },
  );
  await assert.rejects(localTrainerStartDisabled.training_local_trainer_start({
    job_id: "auth-local-start-disabled",
    target: "runtime-job",
    expected_revision_fingerprint: stagedRuntime.revision_fingerprint,
  }), /local_trainer_start feature is disabled/);
  const upgradeCompatible = createApplicationWorkflows(
    { ...configuration, features: Object.fromEntries(Object.entries(features).filter(([name]) => !["local_trainer_start", "local_trainer_stop", "local_trainer_package"].includes(name))) },
    { environment, require_authorized_job() { throw new Error("authorization should not run"); }, call_core_tool: callCoreTool, command_runner() { throw new Error("command should not run"); } },
  );
  const localTrainerEnvOmitted = createApplicationWorkflows(
    { ...configuration, features: { ...features, local_trainer_start: false, local_trainer_stop: false, local_trainer_package: false } },
    { environment: Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("HAWKSPAN_LOCAL_TRAINER_"))), require_authorized_job() {}, call_core_tool: callCoreTool },
  );
  await assert.rejects(localTrainerEnvOmitted.training_local_trainer_start({
    job_id: "auth-local-start-no-script",
    target: "runtime-job",
    expected_revision_fingerprint: stagedRuntime.revision_fingerprint,
  }), /local_trainer_start feature is disabled/);
  const localTrainerUnauthorized = createApplicationWorkflows(configuration, {
    environment,
    require_authorized_job() { throw new Error("explicit authorization missing"); },
    call_core_tool: callCoreTool,
    command_runner() { throw new Error("command should not run without authorization"); },
  });
  await assert.rejects(localTrainerUnauthorized.training_local_trainer_start({
    job_id: "auth-local-start-denied",
    target: "runtime-job",
    expected_revision_fingerprint: stagedRuntime.revision_fingerprint,
  }), /explicit authorization missing/);
  await assert.rejects(localTrainer.training_local_trainer_start({
    job_id: "auth-local-start-bad-target",
    target: "../runtime-job",
    expected_revision_fingerprint: stagedRuntime.revision_fingerprint,
  }), /safe exact ID/);
  await assert.rejects(localTrainer.training_local_trainer_start({
    job_id: "auth-local-start-bad-revision",
    target: "runtime-job",
    expected_revision_fingerprint: "0".repeat(64),
  }), /exact authorized revision/);
  const localStarted = await localTrainer.training_local_trainer_start({
    job_id: "auth-local-start",
    target: "runtime-job",
    expected_revision_fingerprint: stagedRuntime.revision_fingerprint,
  });
  assert.equal(localStarted.invoked, true);
  assert.equal(localStarted.result.stdout.endsWith("[truncated]"), true);
  assert.deepEqual(commandCalls.at(-1).args, ["--job-id", "auth-local-start", "--target", "runtime-job", "--expected-revision-fingerprint", stagedRuntime.revision_fingerprint]);
  assert.equal(commandCalls.at(-1).command, fakeTrainerStart);
  assert.equal(commandCalls.at(-1).timeout, 2000);
  assert.equal(commandCalls.at(-1).env.HAWKSPAN_PRIVATE_SHOULD_NOT_LEAK, undefined);
  assert.equal(commandCalls.at(-1).env.HAWKSPAN_WORKLOAD_RUNTIME_ROOT, roots.runtime);
  assert.equal(commandCalls.at(-1).env.HAWKSPAN_SIMPLETUNER_ROOT, roots.disk);
  assert.match(authorizations.find(({ job_id }) => job_id === "auth-local-start").kind, /^simpletuner-workflow:local-trainer-start:runtime-job:[a-f0-9]{64}$/);
  const callsAfterFirstStart = commandCalls.length;
  const restagedAfterStart = await localTrainer.training_stage_runtime_job({
    job_id: "runtime-job",
    dataset_id: "runtime-sample",
    recipe_id: "runtime-recipe",
  });
  assert.equal(restagedAfterStart.already_present, true);
  assert.equal(restagedAfterStart.training_started, true);
  await assert.rejects(localTrainer.training_local_trainer_start({
    job_id: "auth-local-start-again",
    target: "runtime-job",
    expected_revision_fingerprint: stagedRuntime.revision_fingerprint,
  }), /exact authorized revision/);
  assert.equal(commandCalls.length, callsAfterFirstStart);
  const localTrainerStopDisabled = createApplicationWorkflows(
    { ...configuration, features: { ...features, local_trainer_stop: false } },
    { environment, require_authorized_job() {}, call_core_tool: callCoreTool, command_runner() { throw new Error("command should not run"); } },
  );
  await assert.rejects(localTrainerStopDisabled.training_local_trainer_stop({ job_id: "auth-local-stop-disabled", target: "runtime-job" }), /local_trainer_stop feature is disabled/);
  write(path.join(roots.state, "trainer-control", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: stagedRuntime.revision_fingerprint, state: "running", pid: 4242, process_group: 4242,
  }));
  const localStopped = await localTrainer.training_local_trainer_stop({ job_id: "auth-local-stop", target: "runtime-job" });
  assert.equal(localStopped.invoked, true);
  assert.deepEqual(commandCalls.at(-1).args, ["--job-id", "auth-local-stop", "--target", "runtime-job"]);
  assert.equal(commandCalls.at(-1).command, fakeTrainerStop);
  assert.equal(commandCalls.at(-1).timeout, 2000);
  await assert.rejects(localTrainer.training_local_trainer_stop({ job_id: "auth-local-stop-missing", target: "other-job" }), /adapter-managed running target/);

  write(path.join(roots.runtime, "captioned-lora-status.json"), JSON.stringify({
    batch: "batch-alpha",
    current: "runtime-job",
    total: 2,
    completed: ["finished-job"],
    failed: [{ job_id: "failed-job" }],
    started_at: "2000-01-01T00:00:00.000Z",
    current_started_at: "2000-01-01T00:10:00.000Z",
  }));
  write(path.join(roots.runtime, "captioned-lora-manifest.json"), JSON.stringify([
    { job_id: "runtime-job", output_dir: path.join(roots.output, "runtime-job"), config_name: "runtime-config" },
    { job_id: "finished-job", output_dir: path.join(roots.output, "finished-job"), config_name: "finished-config" },
    { job_id: "failed-job", output_dir: path.join(roots.output, "failed-job"), config_name: "failed-config" },
  ]));
  write(path.join(roots.state, "trainer-control", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: stagedRuntime.revision_fingerprint, state: "completed", pid: 4242, process_group: 4242, returncode: 0,
  }));
  const localTrainerPackageDisabled = createApplicationWorkflows(
    { ...configuration, features: { ...features, local_trainer_package: false } },
    { environment, require_authorized_job() {}, call_core_tool: callCoreTool, command_runner() { throw new Error("command should not run"); } },
  );
  await assert.rejects(localTrainerPackageDisabled.training_local_trainer_package({ job_id: "auth-local-package-disabled", target: "runtime-job" }), /local_trainer_package feature is disabled/);
  const packaged = await localTrainer.training_local_trainer_package({ job_id: "auth-local-package", target: "runtime-job" });
  assert.equal(packaged.invoked, true);
  assert.equal(packaged.package.artifact_id, "artifact-returned-result");
  assert.equal(packaged.package.packet_sha256, fakeReturnPacketSha256);
  assert.deepEqual(commandCalls.at(-1).args, ["--job-id", "auth-local-package", "--target", "runtime-job"]);
  assert.equal(commandCalls.at(-1).command, fakeTrainerPackage);
  assert.equal(commandCalls.at(-1).timeout, 60 * 60 * 1000);
  assert.deepEqual(authorizations.find(({ job_id }) => job_id === "auth-local-package").states, ["authorized", "completed"]);
  write(path.join(roots.state, "trainer-control", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: stagedRuntime.revision_fingerprint, state: "stopped", pid: 4242, process_group: 4242, returncode: -15,
  }));
  const stoppedPackage = await localTrainer.training_local_trainer_package({ job_id: "auth-local-package-stopped", target: "runtime-job" });
  assert.equal(stoppedPackage.invoked, true);
  assert.equal(stoppedPackage.package.artifact_id, "artifact-returned-result");
  assert.equal(coreCalls.filter(({ name }) => name === "register_artifact").length, 1);
  write(path.join(roots.state, "trainer-control", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: stagedRuntime.revision_fingerprint, state: "running", pid: 4242, process_group: 4242,
  }));
  await assert.rejects(
    localTrainer.training_local_trainer_package({ job_id: "auth-local-package-running", target: "runtime-job" }),
    /adapter-managed terminal target/,
  );
  fs.rmSync(path.join(roots.state, "trainer-control", "runtime-job.json"));
  write(path.join(roots.runtime, "captioned-lora-status.json"), JSON.stringify({
    batch: "batch-alpha",
    current: "runtime-job",
    total: 2,
    completed: ["finished-job"],
    failed: [{ job_id: "failed-job" }],
    started_at: "2000-01-01T00:00:00.000Z",
    current_started_at: "2000-01-01T00:10:00.000Z",
  }));
  write(path.join(roots.logs, "runtime-job.log"), [
    "setup",
    "Epoch 1/2, Steps: 40%|####      | 40/100 [00:10<00:15, 1.5s/it, lr=0.0001, step_loss=0.123]",
    "done",
  ].join("\n"));
  write(path.join(roots.output, "runtime-job", "checkpoint-25", "marker.txt"), "checkpoint");
  write(path.join(roots.output, "runtime-job", "PRESERVED_CHECKPOINTS", "checkpoint-25", "marker.txt"), "preserved");
  let localProcessLines = [
    "123 77 00:01 0.0 0.1 python run_captioned_loras.py --config runtime-config",
    "124 1 00:02 0.0 0.1 .venv/bin/simpletuner server --host 127.0.0.1",
    "125 1 00:03 0.0 0.1 codex exec discuss SimpleTuner training",
  ];
  const localMonitor = createApplicationWorkflows(configuration, {
    environment,
    process_list: () => ({ lines: localProcessLines, error: null }),
    require_authorized_job() {},
    call_core_tool: callCoreTool,
  });
  const processStatus = await localMonitor.training_local_process_status({});
  assert.equal(processStatus.active, true);
  assert.equal(processStatus.active_source, "process-list");
  assert.equal(processStatus.processes.length, 1);
  assert.deepEqual(processStatus.processes[0], {
    pid: 123, parent_pid: 77, elapsed: "00:01", cpu_percent: "0.0", memory_percent: "0.1", trainer: "captioned-lora-runner",
  });
  const processParserMonitor = createApplicationWorkflows(configuration, {
    environment,
    process_list: () => ({ lines: [
      "126 1 00:01 0.0 0.1 python /opt/hawkspan-trainer-control.py --action run --target runtime-job",
      "127 126 00:02 0.0 0.1 /opt/SimpleTuner/.venv/bin/accelerate launch /opt/site-packages/simpletuner/train.py",
      "128 127 00:03 0.0 0.1 python /opt/site-packages/simpletuner/train.py",
    ], error: null }),
    require_authorized_job() {},
    call_core_tool: callCoreTool,
  });
  assert.deepEqual((await processParserMonitor.training_local_process_status({})).processes.map(({ trainer }) => trainer), [
    "hawkspan-trainer-controller", "simpletuner-accelerate", "simpletuner-train-process",
  ]);
  const runStatus = await localMonitor.training_runtime_run_status({});
  assert.equal(runStatus.current, "runtime-job");
  assert.equal(runStatus.progress.step, 40);
  assert.equal(runStatus.progress.steps_total, 100);
  assert.equal(runStatus.checkpoints.some((entry) => entry.name === "checkpoint-25" && entry.preserved === true), true);
  const restartedLogOffset = fs.statSync(path.join(roots.logs, "runtime-job.log")).size;
  fs.appendFileSync(path.join(roots.logs, "runtime-job.log"), "\nnew trainer invocation setup\n");
  write(path.join(roots.state, "trainer-control", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: stagedRuntime.revision_fingerprint, state: "running", pid: 77, process_group: 77,
    stage_manifest: path.join(stagedRuntime.runtime_job_root, "STAGE-MANIFEST.json"), log_path: path.join(roots.logs, "runtime-job.log"), log_start_offset: restartedLogOffset,
  }));
  write(path.join(roots.state, "local-trainer", "targets", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: stagedRuntime.revision_fingerprint, state: "started",
    stage_manifest: path.join(stagedRuntime.runtime_job_root, "STAGE-MANIFEST.json"),
  }));
  localProcessLines = [
    `77 1 00:01 0.0 0.1 python /opt/hawkspan-trainer-control.py --action run --target runtime-job --expected-revision-fingerprint ${stagedRuntime.revision_fingerprint}`,
    "123 77 00:01 0.0 0.1 python run_captioned_loras.py --config runtime-config",
  ];
  const staleRecordPath = path.join(roots.state, "trainer-control", "stale-job.json");
  write(staleRecordPath, JSON.stringify({
    target: "stale-job", revision_fingerprint: "f".repeat(64), state: "started", pid: 88, process_group: 88, updated_at: 1,
  }));
  const authoritativeRunStatus = await localMonitor.training_runtime_run_status({});
  assert.equal(authoritativeRunStatus.current, "runtime-job");
  assert.equal(authoritativeRunStatus.revision_fingerprint, stagedRuntime.revision_fingerprint);
  assert.equal(authoritativeRunStatus.trainer_pid, 77);
  assert.equal(authoritativeRunStatus.terminal_state, "running");
  assert.equal(authoritativeRunStatus.process_active, true);
  assert.equal(authoritativeRunStatus.activity_source, "managed-process-tree");
  assert.equal(authoritativeRunStatus.progress, null);
  assert.equal(authoritativeRunStatus.current_job.output_dir, fs.realpathSync(path.join(roots.runtime, "outputs", "runtime-job")));
  const unrelatedTrainerMonitor = createApplicationWorkflows(configuration, {
    environment,
    process_list: () => ({ lines: [
      "77 1 00:04 1.0 0.2 /opt/SimpleTuner/.venv/bin/simpletuner train",
      "901 77 00:03 1.0 0.2 /opt/site-packages/simpletuner/train.py",
    ], error: null }),
    require_authorized_job() {},
    call_core_tool: callCoreTool,
  });
  const unrelatedTrainerStatus = await unrelatedTrainerMonitor.training_runtime_run_status({});
  assert.equal(unrelatedTrainerStatus.terminal_state, "running");
  assert.equal(unrelatedTrainerStatus.process_active, false);
  assert.equal(unrelatedTrainerStatus.activity_source, "none");
  write(path.join(roots.state, "trainer-control", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: stagedRuntime.revision_fingerprint, state: "started", pid: 77, process_group: 77,
    stage_manifest: path.join(stagedRuntime.runtime_job_root, "STAGE-MANIFEST.json"), log_path: path.join(roots.logs, "runtime-job.log"), log_start_offset: restartedLogOffset,
  }));
  const startedStatus = await localMonitor.training_runtime_run_status({});
  assert.equal(startedStatus.terminal_state, "started");
  const transitionMonitor = createApplicationWorkflows(configuration, {
    environment,
    process_list: () => ({ lines: [], error: null }),
    require_authorized_job() {},
    call_core_tool: callCoreTool,
  });
  const transitionStatus = await transitionMonitor.training_runtime_run_status({});
  assert.equal(transitionStatus.current, "runtime-job");
  assert.equal(transitionStatus.terminal_state, "started");
  assert.equal(transitionStatus.process_active, false);
  write(path.join(roots.state, "local-trainer", "targets", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: "0".repeat(64), state: "started",
    stage_manifest: path.join(stagedRuntime.runtime_job_root, "STAGE-MANIFEST.json"),
  }));
  await assert.rejects(localMonitor.training_runtime_run_status({}), /adapter and authoritative running trainer records do not match/);
  write(path.join(roots.state, "trainer-control", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: stagedRuntime.revision_fingerprint, state: "stopped", pid: 77, process_group: 77,
    stage_manifest: path.join(stagedRuntime.runtime_job_root, "STAGE-MANIFEST.json"), log_path: path.join(roots.logs, "runtime-job.log"), updated_at: 2,
  }));
  write(path.join(roots.state, "local-trainer", "targets", "runtime-job.json"), JSON.stringify({
    target: "runtime-job", revision_fingerprint: stagedRuntime.revision_fingerprint, state: "stop_requested",
    stage_manifest: path.join(stagedRuntime.runtime_job_root, "STAGE-MANIFEST.json"),
  }));
  const terminalMonitor = createApplicationWorkflows(configuration, {
    environment,
    process_list: () => ({ lines: [], error: null }),
    require_authorized_job() {},
    call_core_tool: callCoreTool,
  });
  const terminalStatus = await terminalMonitor.training_runtime_run_status({});
  assert.equal(terminalStatus.current, "runtime-job");
  assert.equal(terminalStatus.revision_fingerprint, stagedRuntime.revision_fingerprint);
  assert.equal(terminalStatus.terminal_state, "stopped");
  assert.equal(terminalStatus.process_active, false);
  fs.unlinkSync(staleRecordPath);
  const terminalSurvivorMonitor = createApplicationWorkflows(configuration, {
    environment,
    process_list: () => ({ lines: ["901 1 00:04 1.0 0.2 /opt/SimpleTuner/.venv/bin/simpletuner train"], error: null }),
    require_authorized_job() {},
    call_core_tool: callCoreTool,
  });
  const terminalSurvivorStatus = await terminalSurvivorMonitor.training_runtime_run_status({});
  assert.equal(terminalSurvivorStatus.terminal_state, "stopped");
  assert.equal(terminalSurvivorStatus.process_active, false);
  assert.equal(terminalSurvivorStatus.activity_source, "none");
  const heartbeatOnlyStatus = await terminalMonitor.training_local_process_status({});
  assert.equal(heartbeatOnlyStatus.log_heartbeat.fresh, true);
  assert.equal(heartbeatOnlyStatus.active, false);
  const heartbeatFallbackMonitor = createApplicationWorkflows(configuration, {
    environment,
    process_list: () => ({ lines: [], error: "process inspection unavailable" }),
    require_authorized_job() {},
    call_core_tool: callCoreTool,
  });
  const heartbeatFallbackStatus = await heartbeatFallbackMonitor.training_local_process_status({});
  assert.equal(heartbeatFallbackStatus.active, true);
  assert.equal(heartbeatFallbackStatus.active_source, "fresh-log-heartbeat");
  const queueDetail = await localMonitor.training_local_queue_detail({});
  assert.deepEqual(queueDetail.jobs.map(({ job_id, state }) => [job_id, state]), [["runtime-job", "running"], ["finished-job", "completed"], ["failed-job", "failed"]]);
  const localDatasetValidation = await localMonitor.training_validate_local_dataset({ dataset_id: "runtime-sample" });
  assert.equal(localDatasetValidation.valid, true);
  assert.equal(localDatasetValidation.image_count, 2);
  const logTail = await localMonitor.training_tail_local_log({ relative_path: "runtime-job.log", lines: 5 });
  assert.equal(logTail.content.includes("Epoch 1/2"), true);
  const retention = await localMonitor.training_checkpoint_retention_audit({ minimum: 2 });
  assert.equal(retention.valid, true);
  assert.equal(retention.config_count >= 1, true);
  const preservation = await localMonitor.training_preservation_status({});
  assert.equal(preservation.preserved_checkpoint_count, 1);
  await assert.rejects(localMonitor.training_tail_local_log({ relative_path: "../runtime-job.log" }), /safe relative/);

  const intakeArtifactId = "artifact-return-packet";
  const intakeArtifactRoot = mkdir("state", "artifacts");
  const intakeReturnPacket = path.join(intakeArtifactRoot, `${intakeArtifactId}-${path.basename(fakeReturnPacket)}`);
  fs.copyFileSync(fakeReturnPacket, intakeReturnPacket);
  const intakeReceivedPacket = fs.realpathSync(intakeReturnPacket);
  const intakeSha256 = digest(fs.readFileSync(intakeReturnPacket));
  const intakeRevision = stagedRuntime.revision_fingerprint;
  const controllerConfiguration = {
    ...configuration,
    role: "controller",
    features: { ...features, packet_intake: true },
  };
  const intakeCoreCalls = [];
  const intakeCore = async (name, args) => {
    intakeCoreCalls.push({ name, args: structuredClone(args) });
    if (name === "receive_artifacts") {
      return { artifacts: [{ artifact_id: intakeArtifactId, path: intakeReturnPacket, verified: true }] };
    }
    if (name === "verify_artifact") {
      return { artifact_id: intakeArtifactId, path: intakeReturnPacket, sha256: intakeSha256, expected_sha256: intakeSha256, matches: true };
    }
    if (name === "send_message") return { message_id: "msg-return-receipt", delivery: { ok: true } };
    throw new Error(`unexpected intake core tool: ${name}`);
  };
  let receiverConfigPath = null;
  const intakeRunner = (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.match(args[0], /bin\/hawkspan-packet-receiver\.mjs$/);
    assert.equal(options.cwd, roots.state);
    assert.deepEqual(options.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    const valueAfter = (flag) => args[args.indexOf(flag) + 1];
    receiverConfigPath = valueAfter("--config");
    assert.equal(fs.statSync(receiverConfigPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(receiverConfigPath)).mode & 0o777, 0o700);
    assert.equal(valueAfter("--source"), intakeReceivedPacket);
    assert.equal(valueAfter("--expected-size"), String(fs.statSync(intakeReturnPacket).size));
    assert.equal(valueAfter("--expected-sha256"), intakeSha256);
    const receiverConfig = JSON.parse(fs.readFileSync(receiverConfigPath, "utf8"));
    assert.equal(receiverConfig.staging_root, path.dirname(intakeReceivedPacket));
    assert.equal(receiverConfig.expected_target, "runtime-job");
    assert.equal(receiverConfig.expected_revision_fingerprint, intakeRevision);
    assert.equal(receiverConfig.receipt_recipient, "worker-node");
    const packetPath = path.join(receiverConfig.destination_root, path.basename(intakeReturnPacket));
    const receiptRoot = path.join(receiverConfig.destination_root, "receipts");
    const receiptPath = path.join(receiptRoot, `${path.basename(intakeReturnPacket)}.receipt.json`);
    const registryPath = path.join(receiverConfig.destination_root, "packet-registry.json");
    fs.mkdirSync(receiptRoot, { recursive: true });
    fs.copyFileSync(intakeReturnPacket, packetPath);
    write(receiptPath, "{}\n");
    write(registryPath, "{}\n");
    const packetIdentity = { target: "runtime-job", revision_fingerprint: intakeRevision };
    return {
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        receipt: {
          source: intakeReceivedPacket,
          destination: packetPath,
          size_bytes: fs.statSync(intakeReturnPacket).size,
          sha256: intakeSha256,
          archive_integrity: true,
          internal_inventory_verified: true,
          packet_complete: true,
          packet_missing: [],
          packet_identity: packetIdentity,
        },
        receipt_path: receiptPath,
        registry_path: registryPath,
        message: {
          recipient: "worker-node",
          kind: "artifact-receipt",
          subject: "Packet receipt verified: runtime-job--return-packet.zip",
          correlation_id: intakeSha256,
          metadata: { sha256: intakeSha256, packet_complete: true, packet_missing: [], packet_identity: packetIdentity },
        },
      }),
    };
  };
  const packetIntake = createApplicationWorkflows(controllerConfiguration, {
    environment,
    require_authorized_job() { throw new Error("packet intake must not require a second authorization ceremony"); },
    call_core_tool: intakeCore,
    command_runner: intakeRunner,
  });
  const intake = await packetIntake.training_receive_return_packet({
    artifact_id: intakeArtifactId,
    expected_sha256: intakeSha256,
    expected_target: "runtime-job",
    expected_revision_fingerprint: intakeRevision,
    receipt_recipient: "worker-node",
  });
  assert.equal(intake.message.message_id, "msg-return-receipt");
  assert.equal(intake.sha256, intakeSha256);
  assert.equal(fs.existsSync(receiverConfigPath), false);
  assert.deepEqual(intakeCoreCalls.map(({ name }) => name), ["receive_artifacts", "verify_artifact", "send_message"]);
  assert.equal(intakeCoreCalls[1].args.expected_sha256, intakeSha256);
  assert.equal(intakeCoreCalls[2].args.body.trim().length > 0, true);
  assert.equal(intakeCoreCalls[2].args.deliver, true);
  assert.equal(intakeCoreCalls[2].args.wake, false);

  const disabledPacketIntake = createApplicationWorkflows(
    { ...controllerConfiguration, features: { ...controllerConfiguration.features, packet_intake: false } },
    { environment, require_authorized_job() {}, call_core_tool() { throw new Error("core tool should not run"); }, command_runner() { throw new Error("receiver should not run"); } },
  );
  await assert.rejects(disabledPacketIntake.training_receive_return_packet({}), /packet_intake feature is disabled/);
  const workerPacketIntake = createApplicationWorkflows(
    { ...configuration, features: { ...features, packet_intake: true } },
    { environment, require_authorized_job() {}, call_core_tool() { throw new Error("core tool should not run"); }, command_runner() { throw new Error("receiver should not run"); } },
  );
  await assert.rejects(
    workerPacketIntake.training_receive_return_packet({ artifact_id: intakeArtifactId, expected_sha256: intakeSha256, expected_target: "runtime-job", expected_revision_fingerprint: intakeRevision }),
    /packet intake requires controller role/,
  );
  const rejectedReceipt = createApplicationWorkflows(controllerConfiguration, {
    environment, require_authorized_job() {}, command_runner() { throw new Error("receiver should not run"); },
    async call_core_tool(name) {
      assert.equal(name, "receive_artifacts");
      return { artifacts: [{ artifact_id: intakeArtifactId, path: intakeReturnPacket, verified: false }] };
    },
  });
  await assert.rejects(
    rejectedReceipt.training_receive_return_packet({ artifact_id: intakeArtifactId, expected_sha256: intakeSha256, expected_target: "runtime-job", expected_revision_fingerprint: intakeRevision }),
    /was not received verified/,
  );
  const rejectedDigest = createApplicationWorkflows(controllerConfiguration, {
    environment, require_authorized_job() {}, command_runner() { throw new Error("receiver should not run"); },
    async call_core_tool(name) {
      if (name === "receive_artifacts") return { artifacts: [{ artifact_id: intakeArtifactId, path: intakeReturnPacket, verified: true }] };
      if (name === "verify_artifact") return { path: intakeReturnPacket, sha256: "0".repeat(64), matches: false };
      throw new Error("unexpected core tool");
    },
  });
  await assert.rejects(
    rejectedDigest.training_receive_return_packet({ artifact_id: intakeArtifactId, expected_sha256: intakeSha256, expected_target: "runtime-job", expected_revision_fingerprint: intakeRevision }),
    /SHA256 was not verified/,
  );
  const rejectedArtifactPath = createApplicationWorkflows(controllerConfiguration, {
    environment, require_authorized_job() {}, command_runner() { throw new Error("receiver should not run"); },
    async call_core_tool(name) {
      if (name === "receive_artifacts") return { artifacts: [{ artifact_id: intakeArtifactId, path: fakeReturnPacket, verified: true }] };
      if (name === "verify_artifact") return { path: fakeReturnPacket, sha256: intakeSha256, matches: true };
      throw new Error("unexpected core tool");
    },
  });
  await assert.rejects(
    rejectedArtifactPath.training_receive_return_packet({ artifact_id: intakeArtifactId, expected_sha256: intakeSha256, expected_target: "runtime-job", expected_revision_fingerprint: intakeRevision }),
    /outside the HawkSpan artifact root/,
  );
  const rejectedIdentity = createApplicationWorkflows(controllerConfiguration, {
    environment, require_authorized_job() {}, call_core_tool: intakeCore,
    command_runner(command, args, options) {
      const result = intakeRunner(command, args, options);
      const output = JSON.parse(result.stdout);
      output.receipt.packet_identity.target = "different-target";
      return { ...result, stdout: JSON.stringify(output) };
    },
  });
  await assert.rejects(
    rejectedIdentity.training_receive_return_packet({ artifact_id: intakeArtifactId, expected_sha256: intakeSha256, expected_target: "runtime-job", expected_revision_fingerprint: intakeRevision, receipt_recipient: "worker-node" }),
    /mismatched receipt identity/,
  );
  const rejectedIncomplete = createApplicationWorkflows(controllerConfiguration, {
    environment, require_authorized_job() {}, call_core_tool: intakeCore,
    command_runner(command, args, options) {
      const result = intakeRunner(command, args, options);
      const output = JSON.parse(result.stdout);
      output.receipt.packet_complete = false;
      output.receipt.packet_missing = ["weights"];
      output.message.metadata.packet_complete = false;
      output.message.metadata.packet_missing = ["weights"];
      return { ...result, stdout: JSON.stringify(output) };
    },
  });
  await assert.rejects(
    rejectedIncomplete.training_receive_return_packet({ artifact_id: intakeArtifactId, expected_sha256: intakeSha256, expected_target: "runtime-job", expected_revision_fingerprint: intakeRevision, receipt_recipient: "worker-node" }),
    /mismatched receipt identity/,
  );

  assert.throws(() => createApplicationWorkflows({ ...configuration, checkpoint_steps: [600, 600] }, { environment, require_authorized_job() {}, call_core_tool: callCoreTool }), /checkpoint_steps/);

  const manifestDocument = JSON.parse(fs.readFileSync(path.join(pluginDirectory, "hawkspan-plugin.json"), "utf8"));
  assert.equal(manifestDocument.name, "SimpleTuner Workflows");
  const intakeOperation = manifestDocument.operations.find(({ name }) => name === "training_receive_return_packet");
  assert.deepEqual(intakeOperation.roles, ["controller"]);
  assert.deepEqual(intakeOperation.access, ["local"]);
  assert.deepEqual(intakeOperation.required_flags, ["workload-packet-intake"]);
  const workerPreset = manifestDocument.presets.find(({ id }) => id === "headless-simpletuner-worker");
  assert.equal(workerPreset.settings.features.allowed_peer_tools.inbound.includes("send_artifact"), true);
  assert.deepEqual(workerPreset.settings.features.allow_peer_artifact_send, { inbound: true, outbound: true });
  assert.equal(workerPreset.settings.features.allowed_peer_tools.inbound.includes("acknowledge_message"), true);
  assert.deepEqual(workerPreset.settings.features.allow_peer_acknowledgements, { inbound: true, outbound: true });
  for (const tool of ["register_artifact", "receive_artifacts"]) {
    assert.equal(workerPreset.settings.features.allowed_peer_tools.inbound.includes(tool), true);
  }
  assert.deepEqual(workerPreset.settings.features.allow_peer_artifact_receive, { inbound: true, outbound: false });
  const controllerPreset = manifestDocument.presets.find(({ id }) => id === "simpletuner-controller");
  assert.equal(controllerPreset.settings.enabled_operations.includes("training_receive_return_packet"), true);
  assert.equal(JSON.stringify(controllerPreset.settings.features.allowed_peer_tools).includes("training_receive_return_packet"), false);
  assert.deepEqual(controllerPreset.settings.features.allowed_peer_tools.inbound, ["receive_artifacts"]);
  assert.equal(controllerPreset.settings.features.allowed_peer_tools.outbound.includes("send_artifact"), true);
  assert.deepEqual(controllerPreset.settings.features.allow_peer_artifact_send, { inbound: false, outbound: true });
  assert.equal(controllerPreset.settings.features.allowed_peer_tools.outbound.includes("acknowledge_message"), true);
  assert.equal(controllerPreset.settings.features.allow_peer_acknowledgements.outbound, true);
  assert.equal(controllerPreset.settings.features.allow_peer_acknowledgements.inbound, true);
  for (const tool of ["register_artifact", "receive_artifacts"]) {
    assert.equal(controllerPreset.settings.features.allowed_peer_tools.outbound.includes(tool), true);
  }
  assert.deepEqual(controllerPreset.settings.features.allow_peer_artifact_receive, { inbound: true, outbound: true });
  const installed = mkdir("installed");
  fs.cpSync(pluginDirectory, path.join(installed, "application-workflows"), { recursive: true });
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT, state TEXT)");
  const operationNames = manifestDocument.operations.map(({ name }) => name);
  const flagNames = [...new Set(manifestDocument.operations.flatMap(({ required_flags }) => required_flags))];
  const framework = await createApplicationPluginFramework({
    config: { application_plugins: { enabled: true, roles: ["worker"], roots: [installed], feature_flags: Object.fromEntries(flagNames.map((name) => [name, { inbound: true, outbound: true }])), entries: { "application-workflows": { enabled: true, allowed_origins: ["local", "peer"], enabled_operations: operationNames, configuration } } } },
    stateRoot: mkdir("framework-state"), db: database, audit() {}, environment,
    async callCoreTool(name, args) { return callCoreTool(name, args); },
  });
  try {
    assert.equal(framework.tools.some(({ name }) => name === "app_application_workflows_training_local_process_status"), true, framework.tools.map(({ name }) => name).join(","));
    assert.equal(framework.tools.some(({ name }) => name === "app_application_workflows_simpletuner_capabilities"), false);
    assert.equal(framework.tools.some(({ name }) => name.includes("draw")), false);
  } finally { await framework.close(); database.close(); }

  const controllerDatabase = new DatabaseSync(":memory:");
  controllerDatabase.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT, state TEXT)");
  const controllerFramework = await createApplicationPluginFramework({
    config: { application_plugins: {
      enabled: true,
      roles: ["controller"],
      roots: [installed],
      feature_flags: { "workload-packet-intake": false },
      core_tool_allowlist: ["receive_artifacts", "verify_artifact", "send_message"],
      entries: { "application-workflows": {
        enabled: true,
        allowed_origins: ["local"],
        enabled_operations: ["training_receive_return_packet"],
        core_tool_allowlist: ["receive_artifacts", "verify_artifact", "send_message"],
        configuration: controllerConfiguration,
      } },
    } },
    stateRoot: mkdir("controller-framework-state"), db: controllerDatabase, audit() {}, environment,
    async callCoreTool() { throw new Error("disabled or peer-denied intake must not call a core tool"); },
  });
  try {
    const intakeTool = controllerFramework.tools.find(({ name }) => name === "app_application_workflows_training_receive_return_packet");
    assert.deepEqual([...intakeTool.allowedOrigins], ["local"]);
    const intakeArguments = { artifact_id: intakeArtifactId, expected_sha256: intakeSha256, expected_target: "runtime-job", expected_revision_fingerprint: intakeRevision };
    await assert.rejects(intakeTool.handler(intakeArguments, "peer"), /operation does not allow peer/);
    await assert.rejects(intakeTool.handler(intakeArguments, "local"), /required feature flag is disabled/);
  } finally { await controllerFramework.close(); controllerDatabase.close(); }

  console.log("public SimpleTuner local workflow tests passed");
}
