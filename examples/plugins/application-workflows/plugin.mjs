import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FEATURES = ["inspect", "stage", "validate", "local_trainer_start", "local_trainer_stop", "local_trainer_package", "packet_intake"];
const UPGRADE_OPTIONAL_FEATURES = new Set(["local_trainer_start", "local_trainer_stop", "local_trainer_package", "packet_intake"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"]);
const CONTROLLER_TARGET = Symbol("controllerTarget");
const CONTROLLER_REVISION = Symbol("controllerRevision");
export const DEFAULT_SIMPLETUNER_CHECKPOINT_STEPS = Object.freeze([600, 800, 900, 1000, 1200]);

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value, label, maximum = 4096) {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  return value;
}
function safeId(value, label) {
  const result = string(value, label, 128);
  if (!SAFE_ID.test(result)) throw new Error(`${label} must be a safe exact ID`);
  return result;
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function revision(value) { return digest(canonical(value)); }
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function environmentName(value, label) {
  if (typeof value !== "string" || !/^HAWKSPAN_[A-Z0-9_]+$/.test(value)) throw new Error(`${label} must name an allowlisted HAWKSPAN_ environment entry`);
  return value;
}
function environmentPath(reference, label, environment) {
  if (!object(reference) || Object.keys(reference).length !== 1) throw new Error(`${label} must contain only an env reference`);
  const name = environmentName(reference.env, `${label}.env`);
  const value = string(environment[name], `${name} from ~/.hawkspan/hawkspan.env`);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}
function optionalEnvironment(reference, label, environment) {
  if (!object(reference) || Object.keys(reference).length !== 1) throw new Error(`${label} must contain only an env reference`);
  const name = environmentName(reference.env, `${label}.env`);
  return environment[name] === undefined ? null : string(environment[name], `${name} from ~/.hawkspan/hawkspan.env`);
}
function checkedRoot(root, label) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a non-symlink directory`);
  return fs.realpathSync(root);
}
function existingBelow(root, relative, label, type = "directory") {
  const realRoot = checkedRoot(root, `${label} root`);
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) throw new Error(`${label} is outside its configured root`);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`${label} may not be a symbolic link`);
  if (type === "directory" && !stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if (type === "file" && !stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (!inside(realRoot, fs.realpathSync(candidate))) throw new Error(`${label} resolves outside its configured root`);
  return candidate;
}
function walkFiles(directory, limits) {
  const output = [];
  const pending = [directory];
  let total = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
      if (entry.isSymbolicLink()) throw new Error("symbolic links are not allowed in SimpleTuner artifacts");
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        const size_bytes = fs.statSync(file).size;
        total += size_bytes;
        output.push({ path: path.relative(directory, file).split(path.sep).join("/"), size_bytes, sha256: digest(fs.readFileSync(file)) });
      } else throw new Error("special files are not allowed in SimpleTuner artifacts");
      if (output.length > limits.maxFiles || total > limits.maxBytes) throw new Error("SimpleTuner artifact inventory exceeds configured limits");
    }
  }
  return { file_count: output.length, total_bytes: total, files: output.sort((a, b) => a.path.localeCompare(b.path)) };
}
function safeRelative(value, label) {
  const candidate = string(value, label, 1024);
  if (path.isAbsolute(candidate) || candidate === "." || candidate === ".." || candidate.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw new Error(`${label} must be a safe relative path`);
  return candidate.split("\\").join("/");
}
function validateManifest(raw, limits) {
  if (!object(raw) || raw.schema_version !== 1 || !Array.isArray(raw.files)) throw new Error("manifest must be a schema-version 1 object with files");
  if (raw.files.length < 1 || raw.files.length > limits.maxFiles) throw new Error("manifest file count is outside configured limits");
  const files = raw.files.map((entry, index) => {
    if (!object(entry)) throw new Error(`manifest.files[${index}] must be an object`);
    const item = { path: safeRelative(entry.path, `manifest.files[${index}].path`), size_bytes: entry.size_bytes, sha256: entry.sha256 };
    if (!Number.isSafeInteger(item.size_bytes) || item.size_bytes < 0 || !SHA256.test(item.sha256)) throw new Error(`manifest.files[${index}] has invalid size or SHA256`);
    return item;
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(files.map(({ path: item }) => item)).size !== files.length) throw new Error("manifest contains duplicate paths");
  const total_bytes = files.reduce((sum, item) => sum + item.size_bytes, 0);
  const normalized = { schema_version: 1, file_count: files.length, total_bytes, files };
  if (total_bytes > limits.maxBytes || raw.file_count !== files.length || raw.total_bytes !== total_bytes || raw.revision !== revision(normalized)) throw new Error("manifest count, size, or revision does not match its exact contents");
  return { ...normalized, revision: raw.revision };
}
function exactInventory(directory, manifest, limits) {
  const actual = walkFiles(directory, limits);
  if (canonical(actual) !== canonical({ file_count: manifest.file_count, total_bytes: manifest.total_bytes, files: manifest.files })) throw new Error("delivered files do not exactly match the manifest");
}
function captionedDataset(directory, limits) {
  const files = walkFiles(directory, limits).files;
  const names = new Map(files.map((entry) => [entry.path, entry]));
  const images = files.filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry.path).toLowerCase()));
  return images.length > 0 && images.every((entry) => names.get(`${entry.path.slice(0, -path.extname(entry.path).length)}.txt`)?.size_bytes > 0);
}
function atomicJson(root, relative, value, maximum) {
  const realRoot = checkedRoot(root, "state root");
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new Error("state document is outside configured root");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!inside(realRoot, fs.realpathSync(path.dirname(target)))) throw new Error("state document parent escapes configured root");
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload) > maximum) throw new Error("state document exceeds configured JSON limit");
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, payload, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
}
function readJson(file, maximum) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maximum) throw new Error("JSON document is not a bounded regular file");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function boundedText(value, maximum = 8192) {
  const text = String(value || "").replaceAll("\r", "\n");
  return text.length > maximum ? `${text.slice(0, maximum)}\n[truncated]` : text;
}
function optionalCommandPath(reference, label, environment) {
  if (reference === undefined || reference === null) return null;
  if (!object(reference) || Object.keys(reference).length !== 1) throw new Error(`${label} must contain only an env reference`);
  const name = environmentName(reference.env, `${label}.env`);
  if (environment[name] === undefined) return null;
  const candidate = string(environment[name], `${name} from ~/.hawkspan/hawkspan.env`);
  if (!path.isAbsolute(candidate)) throw new Error(`${name} must be an absolute path`);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a non-symlink regular file`);
  return path.resolve(candidate);
}

function decodeDatasetBundle(file, expectedArtifactSha256, limits) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limits.maxJson) {
    throw new Error("dataset bundle must be a bounded regular JSON file");
  }
  const bytes = fs.readFileSync(file);
  if (digest(bytes) !== expectedArtifactSha256) throw new Error("dataset artifact SHA256 does not match");
  let bundle;
  try { bundle = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("dataset bundle must contain valid JSON"); }
  if (!object(bundle) || bundle.schema_version !== 1 || bundle.kind !== "hawkspan.dataset-bundle" ||
      !object(bundle.manifest) || !Array.isArray(bundle.files) ||
      Object.keys(bundle).some((key) => !["schema_version", "kind", "manifest", "files"].includes(key))) {
    throw new Error("dataset bundle has an unsupported structure");
  }
  const manifest = validateManifest(bundle.manifest, limits);
  if (bundle.files.length !== manifest.file_count) throw new Error("dataset bundle file count does not match its manifest");
  const payloadByPath = new Map();
  let decodedBytes = 0;
  for (const [index, entry] of bundle.files.entries()) {
    if (!object(entry) || Object.keys(entry).some((key) => !["path", "content_base64", "artifact_id", "artifact_sha256"].includes(key))) {
      throw new Error(`dataset bundle files[${index}] has an unsupported structure`);
    }
    const relative = safeRelative(entry.path, `dataset bundle files[${index}].path`);
    if (payloadByPath.has(relative)) throw new Error(`dataset bundle files[${index}] has a duplicate path`);
    const embedded = typeof entry.content_base64 === "string";
    const referenced = typeof entry.artifact_id === "string" || typeof entry.artifact_sha256 === "string";
    if (embedded === referenced) throw new Error(`dataset bundle files[${index}] must contain exactly one embedded payload or artifact reference`);
    if (embedded) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content_base64)) {
        throw new Error(`dataset bundle files[${index}] has invalid base64 content`);
      }
      const content = Buffer.from(entry.content_base64, "base64");
      decodedBytes += content.length;
      if (decodedBytes > limits.maxBytes) throw new Error("dataset bundle exceeds configured decoded-byte limit");
      payloadByPath.set(relative, { content });
    } else {
      payloadByPath.set(relative, {
        artifact_id: safeId(entry.artifact_id, `dataset bundle files[${index}].artifact_id`),
        artifact_sha256: SHA256.test(entry.artifact_sha256) ? entry.artifact_sha256 : (() => { throw new Error(`dataset bundle files[${index}].artifact_sha256 must be SHA256`); })(),
      });
    }
  }
  for (const item of manifest.files) {
    const payload = payloadByPath.get(item.path);
    if (!payload || (payload.content && (payload.content.length !== item.size_bytes || digest(payload.content) !== item.sha256)) ||
        (payload.artifact_sha256 && payload.artifact_sha256 !== item.sha256)) {
      throw new Error(`dataset bundle content does not match manifest entry: ${item.path}`);
    }
  }
  return { manifest, payloadByPath };
}

function materializeDataset(root, datasetId, bundle, limits) {
  const realRoot = checkedRoot(root, "dataset root");
  const destination = path.resolve(root, datasetId);
  if (!inside(root, destination)) throw new Error("dataset destination is outside its configured root");
  if (fs.existsSync(destination)) {
    exactInventory(existingBelow(root, datasetId, "dataset"), bundle.manifest, limits);
    return false;
  }
  const temporary = path.join(root, `.hawkspan-import-${datasetId}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(temporary, { mode: 0o700, recursive: false });
  try {
    for (const item of bundle.manifest.files) {
      const target = path.resolve(temporary, item.path);
      if (!inside(temporary, target)) throw new Error("dataset entry escapes temporary root");
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (!inside(fs.realpathSync(temporary), fs.realpathSync(path.dirname(target)))) throw new Error("dataset parent escapes temporary root");
      const payload = bundle.payloadByPath.get(item.path);
      if (payload.content) fs.writeFileSync(target, payload.content, { mode: 0o600, flag: "wx" });
      else fs.copyFileSync(payload.source_path, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
    }
    exactInventory(temporary, bundle.manifest, limits);
    if (!captionedDataset(temporary, limits)) throw new Error("sample set requires an image and a non-empty sidecar caption per image");
    if (!inside(realRoot, fs.realpathSync(path.dirname(destination)))) throw new Error("dataset destination parent escapes configured root");
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return true;
}

function validateConfig(configuration, environment) {
  if (!object(configuration) || configuration.mode !== "simpletuner-workflows") throw new Error("configuration.mode must be simpletuner-workflows");
  if (!["controller", "worker"].includes(configuration.role)) throw new Error("SimpleTuner workflows require controller or worker role");
  const features = { ...configuration.features };
  for (const feature of FEATURES) {
    if (features[feature] === undefined && UPGRADE_OPTIONAL_FEATURES.has(feature)) features[feature] = false;
    if (typeof features[feature] !== "boolean") throw new Error(`features.${feature} must be explicitly true or false`);
  }
  const paths = {};
  for (const name of ["inbox_root", "dataset_root", "recipe_root", "output_root", "state_root", "disk_root"]) paths[name] = environmentPath(configuration.paths?.[name], `configuration.paths.${name}`, environment);
  paths.runtime_root = configuration.paths?.runtime_root
    ? environmentPath(configuration.paths.runtime_root, "configuration.paths.runtime_root", environment)
    : path.join(paths.state_root, "simpletuner-runtime");
  paths.log_root = configuration.paths?.log_root
    ? environmentPath(configuration.paths.log_root, "configuration.paths.log_root", environment)
    : path.join(paths.runtime_root, "logs");
  const maxFiles = configuration.limits?.max_files;
  const maxBytes = configuration.limits?.max_total_bytes;
  const maxJson = configuration.limits?.max_json_bytes;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(maxJson) || maxJson < 256 || maxJson > 16 * 1024 * 1024) throw new Error("limits are invalid");
  const prefix = safeId(configuration.required_job?.kind_prefix, "required_job.kind_prefix");
  const state = string(configuration.required_job?.state, "required_job.state", 64);
  const checkpointSteps = configuration.checkpoint_steps ?? DEFAULT_SIMPLETUNER_CHECKPOINT_STEPS;
  if (!Array.isArray(checkpointSteps) || checkpointSteps.length < 1 || checkpointSteps.length > 100 ||
      checkpointSteps.some((step) => !Number.isSafeInteger(step) || step < 1) ||
      new Set(checkpointSteps).size !== checkpointSteps.length) throw new Error("checkpoint_steps must contain unique positive integers");
  const localTrainerRaw = object(configuration.local_trainer) ? configuration.local_trainer : {};
  const simpletunerRootValue = localTrainerRaw.simpletuner_root === undefined
    ? null
    : optionalEnvironment(localTrainerRaw.simpletuner_root, "local_trainer.simpletuner_root", environment);
  if (simpletunerRootValue !== null && !path.isAbsolute(simpletunerRootValue)) throw new Error("HAWKSPAN_SIMPLETUNER_ROOT must be an absolute path");
  const localTrainer = {
    start_script: optionalCommandPath(localTrainerRaw.start_script, "local_trainer.start_script", environment),
    stop_script: optionalCommandPath(localTrainerRaw.stop_script, "local_trainer.stop_script", environment),
    package_script: optionalCommandPath(localTrainerRaw.package_script, "local_trainer.package_script", environment),
    simpletuner_root: simpletunerRootValue === null ? null : path.resolve(simpletunerRootValue),
    timeout_ms: localTrainerRaw.timeout_ms === undefined ? 30000 : localTrainerRaw.timeout_ms,
    package_timeout_ms: localTrainerRaw.package_timeout_ms === undefined ? 60 * 60 * 1000 : localTrainerRaw.package_timeout_ms,
  };
  if (!Number.isInteger(localTrainer.timeout_ms) || localTrainer.timeout_ms < 100 || localTrainer.timeout_ms > 30000) throw new Error("local_trainer.timeout_ms must be from 100 through 30000");
  if (!Number.isInteger(localTrainer.package_timeout_ms) || localTrainer.package_timeout_ms < 30000 || localTrainer.package_timeout_ms > 4 * 60 * 60 * 1000) throw new Error("local_trainer.package_timeout_ms must be from 30000 through 14400000");
  return { ...configuration, features: Object.freeze(features), paths, limits: { maxFiles, maxBytes, maxJson }, requiredJob: { prefix, state }, checkpointSteps: Object.freeze([...checkpointSteps]), localTrainer };
}

function fileSha256(file) { return digest(fs.readFileSync(file)); }
function directoryInventory(directory, limits) { return walkFiles(directory, limits).files; }
function readOptionalJson(file, maximum) {
  try { return readJson(file, maximum); } catch { return null; }
}
function datasetReadiness(directory, limits) {
  const files = walkFiles(directory, limits).files;
  const images = files.filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry.path).toLowerCase()));
  const captions = files.filter((entry) => path.extname(entry.path).toLowerCase() === ".txt");
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  const problems = [];
  for (const image of images) {
    const stem = image.path.slice(0, -path.extname(image.path).length);
    const caption = byPath.get(`${stem}.txt`);
    if (!caption) problems.push({ issue: "missing_caption", file: image.path });
    else if (caption.size_bytes <= 0) problems.push({ issue: "empty_caption", file: caption.path });
  }
  const imageStems = new Set(images.map((entry) => entry.path.slice(0, -path.extname(entry.path).length)));
  for (const caption of captions) {
    const stem = caption.path.slice(0, -path.extname(caption.path).length);
    if (!imageStems.has(stem)) problems.push({ issue: "orphan_caption", file: caption.path });
  }
  const normalized = { schema_version: 1, file_count: files.length, total_bytes: files.reduce((sum, item) => sum + item.size_bytes, 0), files };
  return {
    image_count: images.length,
    caption_count: captions.length,
    dataset_revision_sha256: revision(normalized),
    problems,
  };
}
function promptLibraryReadiness(validation) {
  const problems = [];
  if (!object(validation)) return [{ issue: "missing_or_invalid_validation_prompt_library" }];
  if (typeof validation.trigger !== "string" || !validation.trigger.trim()) problems.push({ issue: "missing_validation_trigger" });
  if (!Array.isArray(validation.prompts) || validation.prompts.length < 1) {
    problems.push({ issue: "missing_validation_prompts" });
    return problems;
  }
  const ids = new Set();
  for (const [index, entry] of validation.prompts.entries()) {
    if (!object(entry) || typeof entry.id !== "string" || !SAFE_ID.test(entry.id)) problems.push({ issue: "invalid_validation_prompt_id", index });
    else if (ids.has(entry.id)) problems.push({ issue: "duplicate_validation_prompt_id", prompt_id: entry.id });
    else ids.add(entry.id);
    if (typeof entry.prompt !== "string" || !entry.prompt.trim()) problems.push({ issue: "invalid_validation_prompt", index });
  }
  return problems;
}
function cloneDirectory(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("runtime staging source must be a non-symlink directory");
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true, mode: fs.constants.COPYFILE_EXCL });
}
function optionalJsonBelow(root, relative, label, maximum, fallback) {
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw new Error(`${label} is outside its configured root`);
  if (!fs.existsSync(file)) return fallback;
  return readJson(existingBelow(root, relative, label, "file"), maximum);
}
function durationTextToSeconds(value) {
  if (!value) return null;
  const parts = String(value).split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
function parseTrainingProgress(text) {
  let progress = null;
  const cleaned = text.replaceAll("\r", "\n").replace(/\u001b\[[0-9;]*m/g, "");
  const pattern = /Epoch\s+(\d+)\/(\d+),\s+Steps:\s+(\d+)%[^\n]*?(\d+)\/(\d+)\s+\[[^<\]]*<([^,\]]+),\s*([\d.]+)s\/it,\s*lr=([^,\]]+),\s*step_loss=([^\]\s]+)/g;
  for (const match of cleaned.matchAll(pattern)) {
    progress = {
      epoch: Number(match[1]),
      epochs_total: Number(match[2]),
      percent: Number(match[3]),
      step: Number(match[4]),
      steps_total: Number(match[5]),
      eta: match[6],
      eta_seconds: durationTextToSeconds(match[6]),
      seconds_per_iteration: Number(match[7]),
      learning_rate: Number(match[8]),
      step_loss: Number(match[9]),
    };
  }
  return progress;
}
function tailFile(file, lines, maximumBytes, minimumOffset = 0) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("log must be a bounded regular file");
  const safeOffset = Number.isSafeInteger(minimumOffset) && minimumOffset >= 0 && minimumOffset <= stat.size ? minimumOffset : 0;
  const bytes = Math.min(stat.size - safeOffset, maximumBytes);
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(bytes);
  try {
    fs.readSync(fd, buffer, 0, bytes, Math.max(safeOffset, stat.size - bytes));
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf8").replaceAll("\r", "\n").split("\n").slice(-lines).join("\n");
}
function checkpointEntries(outputDirectory) {
  if (!outputDirectory || !fs.existsSync(outputDirectory)) return [];
  const root = checkedRoot(outputDirectory, "run output root");
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("checkpoint entry may not be a symbolic link");
    if (entry.isDirectory() && entry.name.startsWith("checkpoint-")) output.push({ name: entry.name, path: path.join(root, entry.name), preserved: false });
  }
  const preserved = path.join(root, "PRESERVED_CHECKPOINTS");
  if (fs.existsSync(preserved)) {
    const preservedRoot = checkedRoot(preserved, "preserved checkpoint root");
    for (const entry of fs.readdirSync(preservedRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("preserved checkpoint entry may not be a symbolic link");
      if (entry.isDirectory() && entry.name.startsWith("checkpoint-")) output.push({ name: entry.name, path: path.join(preservedRoot, entry.name), preserved: true });
    }
  }
  return output.sort((a, b) => a.name.localeCompare(b.name) || String(a.preserved).localeCompare(String(b.preserved)));
}
function walkJsonFilesReadonly(root, maximumFiles) {
  const realRoot = checkedRoot(root, "JSON scan root");
  const output = [];
  const pending = [realRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("._")) continue;
      if (entry.isSymbolicLink()) throw new Error("JSON scan may not traverse symbolic links");
      const candidate = path.join(current, entry.name);
      if (!inside(realRoot, fs.realpathSync(candidate))) throw new Error("JSON scan entry escapes configured root");
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) output.push(candidate);
      if (output.length > maximumFiles) throw new Error("JSON scan exceeds configured file limit");
    }
  }
  return output.sort((a, b) => a.localeCompare(b));
}
function containedPath(root, candidate) {
  const resolvedRoot = checkedRoot(root, "containment root");
  const resolvedCandidate = path.resolve(candidate);
  if (inside(root, resolvedCandidate)) return true;
  return fs.existsSync(resolvedCandidate) && inside(resolvedRoot, fs.realpathSync(resolvedCandidate));
}
function processLines(dependencies) {
  if (typeof dependencies.process_list === "function") return dependencies.process_list();
  const result = spawnSync("ps", ["-axo", "pid,ppid,etime,%cpu,%mem,command"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return { lines: [], error: result.error?.message || result.stderr?.trim() || `ps exited ${result.status}` };
  return { lines: String(result.stdout || "").split("\n"), error: null };
}
function trainerProcesses(lines) {
  const output = [];
  for (const raw of lines) {
    const match = String(raw).match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const command = match[6];
    const simpleTunerTrain = /(?:^|[\/\s])simpletuner\s+train(?:\s|$)/i.test(command);
    const trainerController = /(?:^|[\/\s])hawkspan-trainer-control\.py(?:\s|$)/i.test(command)
      && /(?:^|\s)--action(?:=|\s+)run(?:\s|$)/i.test(command);
    const acceleratedTrain = /(?:^|[\/\s])accelerate\s+launch[^\n]*\/site-packages\/simpletuner\/train\.py(?:\s|$)/i.test(command);
    const directTrain = /\/site-packages\/simpletuner\/train\.py(?:\s|$)/i.test(command);
    const captionedRunner = /(?:^|[\/\s])run_captioned_loras\.py(?:\s|$)/i.test(command);
    if (!simpleTunerTrain && !trainerController && !acceleratedTrain && !directTrain && !captionedRunner) continue;
    const process = {
      pid: Number(match[1]),
      parent_pid: Number(match[2]),
      elapsed: match[3],
      cpu_percent: match[4],
      memory_percent: match[5],
      trainer: simpleTunerTrain ? "simpletuner-train" : trainerController ? "hawkspan-trainer-controller" : acceleratedTrain ? "simpletuner-accelerate" : directTrain ? "simpletuner-train-process" : "captioned-lora-runner",
    };
    if (trainerController) {
      const target = command.match(/(?:^|\s)--target(?:=|\s+)([A-Za-z0-9._-]+)(?=\s|$)/);
      const revision = command.match(/(?:^|\s)--expected-revision-fingerprint(?:=|\s+)([a-f0-9]{64})(?=\s|$)/);
      Object.defineProperties(process, {
        [CONTROLLER_TARGET]: { value: target?.[1] || null },
        [CONTROLLER_REVISION]: { value: revision?.[1] || null },
      });
    }
    output.push(process);
  }
  return output;
}
function managedTrainerProcessTree(processes, record) {
  if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) return [];
  const controller = processes.find((process) => process.pid === record.pid
    && process.trainer === "hawkspan-trainer-controller"
    && process[CONTROLLER_TARGET] === record.target
    && process[CONTROLLER_REVISION] === record.revision_fingerprint);
  if (!controller) return [];
  const tree = new Set([record.pid]);
  const matched = [controller];
  let added = true;
  while (added) {
    added = false;
    for (const process of processes) {
      if (tree.has(process.pid) || tree.has(process.parent_pid)) {
        if (!tree.has(process.pid)) added = true;
        tree.add(process.pid);
        if (!matched.includes(process)) matched.push(process);
      }
    }
  }
  return matched;
}
function localTrainerStateRelative(target) {
  return path.join("local-trainer", "targets", `${safeId(target, "target")}.json`);
}
function localTrainerState(config, target) {
  const file = path.join(config.paths.state_root, localTrainerStateRelative(target));
  return fs.existsSync(file) ? readJson(file, config.limits.maxJson) : null;
}
function trainerControlState(config, target) {
  const relative = path.join("trainer-control", `${safeId(target, "target")}.json`);
  const file = path.join(config.paths.state_root, relative);
  if (!fs.existsSync(file)) return null;
  const state = readJson(file, config.limits.maxJson);
  if (!object(state) || state.target !== target || !SHA256.test(state.revision_fingerprint || "")) throw new Error("authoritative trainer record is invalid");
  return state;
}
function activeTrainerControl(config, processes) {
  const root = path.join(checkedRoot(config.paths.state_root, "state root"), "trainer-control");
  if (!fs.existsSync(root)) return null;
  const records = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({
      record: readJson(path.join(root, entry.name), config.limits.maxJson),
      modified: fs.statSync(path.join(root, entry.name)).mtimeMs,
    }))
    .filter(({ record }) => object(record) && ["started", "running"].includes(record.state));
  if (records.length === 0) return null;
  const live = records
    .map(({ record, modified }) => ({ record, modified, processes: managedTrainerProcessTree(processes, record) }))
    .filter((entry) => entry.processes.length > 0);
  if (live.length > 1) throw new Error("multiple authoritative trainer processes are active");
  if (live.length === 0) return null;
  const selected = live[0];
  const { record, processes: managedProcesses } = selected;
  const target = safeId(record.target, "authoritative trainer target");
  if (!SHA256.test(record.revision_fingerprint || "") || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new Error("authoritative running trainer record is invalid");
  }
  const adapter = localTrainerState(config, target);
  if (!adapter || adapter.target !== target || adapter.revision_fingerprint !== record.revision_fingerprint || adapter.stage_manifest !== record.stage_manifest) {
    throw new Error("adapter and authoritative running trainer records do not match");
  }
  const stagePath = path.resolve(record.stage_manifest || "");
  if (!containedPath(config.paths.runtime_root, stagePath) || !fs.existsSync(stagePath)) throw new Error("authoritative trainer stage manifest is outside the runtime root");
  const stage = readJson(stagePath, config.limits.maxJson);
  if (stage.job_id !== target || stage.revision_fingerprint !== record.revision_fingerprint || stage.ready !== true || !object(stage.runtime_job)) {
    throw new Error("authoritative trainer stage manifest does not match the running revision");
  }
  return { record, adapter, stage, stage_path: stagePath, processes: managedProcesses };
}
function trainerRecordTime(record, modified) {
  if (typeof record.updated_at === "number" && Number.isFinite(record.updated_at)) {
    return record.updated_at < 1_000_000_000_000 ? record.updated_at * 1000 : record.updated_at;
  }
  if (typeof record.updated_at === "string") {
    const parsed = Date.parse(record.updated_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return modified;
}
function latestTrainerControl(config) {
  const root = path.join(checkedRoot(config.paths.state_root, "state root"), "trainer-control");
  if (!fs.existsSync(root)) return null;
  const records = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({
      record: readJson(path.join(root, entry.name), config.limits.maxJson),
      modified: fs.statSync(path.join(root, entry.name)).mtimeMs,
    }))
    .filter(({ record }) => object(record) && typeof record.stage_manifest === "string" && ["started", "running", "completed", "failed", "stopped", "stop_requested"].includes(record.state))
    .sort((left, right) => trainerRecordTime(right.record, right.modified) - trainerRecordTime(left.record, left.modified) || right.modified - left.modified || String(left.record.target).localeCompare(String(right.record.target)));
  if (records.length === 0) return null;
  const record = records[0].record;
  const target = safeId(record.target, "authoritative trainer target");
  if (!SHA256.test(record.revision_fingerprint || "")) throw new Error("authoritative trainer record is invalid");
  const adapter = localTrainerState(config, target);
  if (!adapter || adapter.target !== target || adapter.revision_fingerprint !== record.revision_fingerprint || adapter.stage_manifest !== record.stage_manifest) {
    throw new Error("adapter and authoritative trainer records do not match");
  }
  const stagePath = path.resolve(record.stage_manifest || "");
  if (!containedPath(config.paths.runtime_root, stagePath) || !fs.existsSync(stagePath)) throw new Error("authoritative trainer stage manifest is outside the runtime root");
  const stage = readJson(stagePath, config.limits.maxJson);
  if (stage.job_id !== target || stage.revision_fingerprint !== record.revision_fingerprint || !object(stage.runtime_job)) {
    throw new Error("authoritative trainer stage manifest does not match the recorded revision");
  }
  return { record, adapter, stage, stage_path: stagePath, processes: [] };
}
function reconciledLocalTrainerState(config, target, stamp) {
  const adapter = localTrainerState(config, target);
  const authoritative = trainerControlState(config, target);
  if (!adapter || !authoritative) return adapter;
  if (adapter.target !== authoritative.target || adapter.revision_fingerprint !== authoritative.revision_fingerprint) {
    throw new Error("adapter and authoritative trainer records do not match");
  }
  const state = {
    ...adapter,
    state: authoritative.state,
    trainer_pid: authoritative.pid ?? null,
    trainer_process_group: authoritative.process_group ?? null,
    trainer_returncode: authoritative.returncode ?? null,
    trainer_record: path.join(config.paths.state_root, "trainer-control", `${target}.json`),
    updated_at: stamp,
  };
  atomicJson(config.paths.state_root, localTrainerStateRelative(target), state, config.limits.maxJson);
  return state;
}
function stageManifestForTarget(config, target, expectedRevision) {
  const jobsRoot = path.join(checkedRoot(config.paths.runtime_root, "runtime root"), "jobs");
  const candidates = fs.existsSync(jobsRoot)
    ? fs.readdirSync(jobsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${target}--`))
      .map((entry) => path.join(jobsRoot, entry.name, "STAGE-MANIFEST.json"))
      .filter((file) => fs.existsSync(file))
    : [];
  if (candidates.length !== 1) throw new Error("target is not exactly one staged runtime job");
  const manifest = readJson(candidates[0], config.limits.maxJson);
  if (manifest.job_id !== target || manifest.revision_fingerprint !== expectedRevision || manifest.ready !== true || manifest.training_started !== false) {
    throw new Error("staged target does not match the exact authorized revision");
  }
  return { manifest, path: candidates[0] };
}
function runLocalTrainerScript(config, dependencies, script, args, timeoutMs = config.localTrainer.timeout_ms) {
  if (!script) throw new Error("local trainer command is not configured");
  if (!config.localTrainer.simpletuner_root) throw new Error("HAWKSPAN_SIMPLETUNER_ROOT is not configured");
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HAWKSPAN_WORKLOAD_RUNTIME_ROOT: config.paths.runtime_root,
    HAWKSPAN_WORKLOAD_STATE_ROOT: config.paths.state_root,
    HAWKSPAN_WORKLOAD_OUTPUT_ROOT: config.paths.output_root,
    HAWKSPAN_WORKLOAD_LOG_ROOT: config.paths.log_root,
    HAWKSPAN_SIMPLETUNER_ROOT: config.localTrainer.simpletuner_root,
  };
  const runner = dependencies.command_runner || ((command, commandArgs, options) => spawnSync(command, commandArgs, { ...options, encoding: "utf8" }));
  const result = runner(script, args, {
    cwd: config.paths.runtime_root,
    env: environment,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const status = Number.isInteger(result?.status) ? result.status : result?.error ? 1 : 0;
  const output = {
    status,
    stdout: boundedText(result?.stdout),
    stderr: boundedText(result?.stderr),
  };
  if (result?.error) output.error = boundedText(result.error.message, 1024);
  if (status !== 0 || result?.error) throw Object.assign(new Error(`local trainer command failed with status ${status}`), { result: output });
  return output;
}

function runPacketReceiver(config, dependencies, args) {
  const receiver = fileURLToPath(new URL("./bin/hawkspan-packet-receiver.mjs", import.meta.url));
  const stat = fs.lstatSync(receiver);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("bundled packet receiver must be a non-symlink regular file");
  const runner = dependencies.command_runner || ((command, commandArgs, options) => spawnSync(command, commandArgs, { ...options, encoding: "utf8" }));
  const result = runner(process.execPath, [receiver, ...args], {
    cwd: config.paths.state_root,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    timeout: 60 * 60 * 1000,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const status = Number.isInteger(result?.status) ? result.status : result?.error ? 1 : 0;
  if (status !== 0 || result?.error) {
    const error = new Error(`packet receiver failed with status ${status}`);
    error.result = {
      status,
      stdout: boundedText(result?.stdout),
      stderr: boundedText(result?.stderr),
      ...(result?.error ? { error: boundedText(result.error.message, 1024) } : {}),
    };
    throw error;
  }
  try {
    return JSON.parse(String(result?.stdout || "").trim());
  } catch {
    throw new Error("packet receiver returned invalid JSON");
  }
}

export function createApplicationWorkflows(rawConfiguration, dependencies = {}) {
  const sourceConfiguration = rawConfiguration;
  const config = validateConfig(rawConfiguration, dependencies.environment || process.env);
  if (typeof dependencies.require_authorized_job !== "function") throw new Error("HawkSpan require_authorized_job is required");
  if (typeof dependencies.call_core_tool !== "function") throw new Error("HawkSpan call_core_tool is required");
  const now = dependencies.now || (() => new Date().toISOString());
  const enabled = (name) => { if (!config.features[name]) throw new Error(`${name} feature is disabled`); };
  const authorize = (args, action, target, exactRevision) => dependencies.require_authorized_job({
    job_id: safeId(args.job_id, "job_id"),
    kind: `${config.requiredJob.prefix}:${action}:${safeId(target, "authorization target")}:${exactRevision}`,
    states: [config.requiredJob.state],
  });
  const recipe = (id, expectedRevision) => {
    safeId(id, "recipe_id");
    if (!SHA256.test(expectedRevision)) throw new Error("recipe_revision must be SHA256");
    const file = existingBelow(config.paths.recipe_root, `${id}.json`, "recipe", "file");
    const bytes = fs.readFileSync(file);
    if (digest(bytes) !== expectedRevision) throw new Error("recipe revision does not match the authorized recipe");
    const document = JSON.parse(bytes.toString("utf8"));
    if (!object(document) || document.schema_version !== 1 || !object(document.config)) throw new Error("recipe must contain schema_version 1 and a SimpleTuner config object");
    return document;
  };

  return Object.freeze({
    async worker_disk_status() {
      enabled("inspect");
      const root = checkedRoot(config.paths.disk_root, "disk root");
      const stat = dependencies.disk_status ? await dependencies.disk_status(root) : fs.statfsSync(root);
      const blockSize = Number(stat.bsize ?? stat.block_size), blocks = Number(stat.blocks ?? stat.total_blocks), available = Number(stat.bavail ?? stat.available_blocks);
      if (![blockSize, blocks, available].every(Number.isFinite)) throw new Error("disk status returned invalid values");
      return { total_bytes: blockSize * blocks, available_bytes: blockSize * available, used_bytes: blockSize * (blocks - available) };
    },
    async training_local_process_status() {
      enabled("inspect");
      checkedRoot(config.paths.state_root, "state root");
      const runtimeRoot = checkedRoot(config.paths.runtime_root, "runtime root");
      const logRoot = checkedRoot(config.paths.log_root, "log root");
      const status = optionalJsonBelow(runtimeRoot, "captioned-lora-status.json", "runtime status", config.limits.maxJson, {});
      const current = typeof status.current === "string" && SAFE_ID.test(status.current) ? status.current : null;
      const logPath = current ? path.join(logRoot, `${current}.log`) : null;
      let logHeartbeat = null;
      if (logPath && inside(logRoot, logPath) && fs.existsSync(logPath)) {
        const file = existingBelow(logRoot, `${current}.log`, "training log", "file");
        const ageSeconds = Math.max(0, (Date.now() - fs.statSync(file).mtimeMs) / 1000);
        logHeartbeat = { current, log_path: file, age_seconds: ageSeconds, fresh: ageSeconds <= 120 };
      }
      const inspected = await processLines(dependencies);
      const processes = trainerProcesses(inspected.lines);
      const heartbeatFallback = Boolean(inspected.error && logHeartbeat?.fresh);
      const active = processes.length > 0 || heartbeatFallback;
      return {
        active,
        active_source: processes.length > 0 ? "process-list" : heartbeatFallback ? "fresh-log-heartbeat" : "none",
        processes,
        process_inspection_error: inspected.error || null,
        log_heartbeat: logHeartbeat,
      };
    },
    async training_runtime_run_status() {
      enabled("inspect");
      const runtimeRoot = checkedRoot(config.paths.runtime_root, "runtime root");
      const logRoot = checkedRoot(config.paths.log_root, "log root");
      checkedRoot(config.paths.output_root, "output root");
      const status = optionalJsonBelow(runtimeRoot, "captioned-lora-status.json", "runtime status", config.limits.maxJson, {});
      const manifest = optionalJsonBelow(runtimeRoot, "captioned-lora-manifest.json", "runtime manifest", config.limits.maxJson, []);
      if (!Array.isArray(manifest)) throw new Error("runtime manifest must be an array");
      const process = await this.training_local_process_status({});
      const authoritative = activeTrainerControl(config, process.processes) || latestTrainerControl(config);
      const managedProcesses = authoritative?.processes || [];
      const managedProcessActive = managedProcesses.length > 0;
      const current = authoritative?.record.target || (typeof status.current === "string" && SAFE_ID.test(status.current) ? status.current : null);
      const currentJob = authoritative?.stage.runtime_job || manifest.find((entry) => object(entry) && entry.job_id === current) || null;
      const configuredLogPath = authoritative?.record.log_path ? path.resolve(authoritative.record.log_path) : null;
      if (configuredLogPath && !containedPath(logRoot, configuredLogPath)) throw new Error("authoritative training log is outside configured log root");
      const logPath = configuredLogPath || (current ? path.join(logRoot, `${current}.log`) : null);
      let progress = null;
      if (logPath && fs.existsSync(logPath)) progress = parseTrainingProgress(tailFile(logPath, 2000, 1024 * 1024, authoritative?.record.log_start_offset));
      const outputDirectory = currentJob?.output_dir ? path.resolve(currentJob.output_dir) : null;
      if (outputDirectory && !containedPath(config.paths.output_root, outputDirectory) && !containedPath(config.paths.runtime_root, outputDirectory)) {
        throw new Error("runtime job output_dir is outside configured output roots");
      }
      return {
        batch: status.batch || null,
        queue_total: Number(status.total || manifest.length),
        current,
        current_job: currentJob,
        revision_fingerprint: authoritative?.record.revision_fingerprint || null,
        trainer_pid: authoritative?.record.pid || null,
        terminal_state: authoritative?.record.state || null,
        completed: Array.isArray(status.completed) ? status.completed : [],
        failed: Array.isArray(status.failed) ? status.failed : [],
        remaining: Math.max(0, Number(status.total || manifest.length) - (status.completed?.length || 0) - (status.failed?.length || 0)),
        started_at: status.started_at || null,
        current_started_at: status.current_started_at || null,
        process_active: managedProcessActive,
        activity_source: managedProcessActive ? "managed-process-tree" : "none",
        process_inspection_error: process.process_inspection_error,
        log_heartbeat: process.log_heartbeat,
        progress,
        log_path: logPath && fs.existsSync(logPath) ? logPath : null,
        checkpoints: checkpointEntries(outputDirectory),
      };
    },
    async training_local_queue_detail() {
      enabled("inspect");
      const runtimeRoot = checkedRoot(config.paths.runtime_root, "runtime root");
      const status = optionalJsonBelow(runtimeRoot, "captioned-lora-status.json", "runtime status", config.limits.maxJson, {});
      const manifest = optionalJsonBelow(runtimeRoot, "captioned-lora-manifest.json", "runtime manifest", config.limits.maxJson, []);
      if (!Array.isArray(manifest)) throw new Error("runtime manifest must be an array");
      const completed = new Set((Array.isArray(status.completed) ? status.completed : []).map((entry) => typeof entry === "string" ? entry : entry?.job_id).filter(Boolean));
      const failed = new Set((Array.isArray(status.failed) ? status.failed : []).map((entry) => typeof entry === "string" ? entry : entry?.job_id).filter(Boolean));
      return {
        batch: status.batch || null,
        jobs: manifest.map((job) => {
          if (!object(job) || !SAFE_ID.test(job.job_id || "")) throw new Error("runtime manifest job is invalid");
          return {
            ...job,
            state: job.job_id === status.current ? "running" : completed.has(job.job_id) ? "completed" : failed.has(job.job_id) ? "failed" : "pending",
          };
        }),
      };
    },
    async training_validate_local_dataset(args) {
      enabled("inspect");
      const datasetId = safeId(args.dataset_id, "dataset_id");
      const dataset = existingBelow(config.paths.dataset_root, datasetId, "dataset");
      const evidence = datasetReadiness(dataset, config.limits);
      const missingCaptions = evidence.problems.filter((entry) => entry.issue === "missing_caption").map((entry) => entry.file);
      const emptyCaptions = evidence.problems.filter((entry) => entry.issue === "empty_caption").map((entry) => entry.file);
      return {
        dataset_id: datasetId,
        path: dataset,
        image_count: evidence.image_count,
        caption_count: evidence.caption_count,
        missing_captions: missingCaptions,
        empty_captions: emptyCaptions,
        problems: evidence.problems,
        dataset_revision_sha256: evidence.dataset_revision_sha256,
        valid: evidence.image_count > 0 && missingCaptions.length === 0 && emptyCaptions.length === 0,
      };
    },
    async training_tail_local_log(args) {
      enabled("inspect");
      const relativePath = safeRelative(args.relative_path, "relative_path");
      const lines = Math.min(Math.max(Number(args.lines || 100), 1), 2000);
      const file = existingBelow(config.paths.log_root, relativePath, "training log", "file");
      return { path: file, lines, content: tailFile(file, lines, config.limits.maxBytes) };
    },
    async training_checkpoint_retention_audit(args = {}) {
      enabled("inspect");
      const root = checkedRoot(config.paths.runtime_root, "runtime root");
      checkedRoot(config.paths.output_root, "output root");
      const minimum = Number.isSafeInteger(args.minimum) && args.minimum > 0 ? args.minimum : Math.min(...config.checkpointSteps.map((step) => 10));
      const configs = [];
      for (const filePath of walkJsonFilesReadonly(root, config.limits.maxFiles)) {
        try {
          const parsed = readJson(filePath, config.limits.maxJson);
          const rawConfig = object(parsed.config) ? parsed.config : parsed;
          if (!Object.hasOwn(rawConfig, "checkpoints_total_limit")) continue;
          const retention = Number(rawConfig.checkpoints_total_limit);
          const outputDir = typeof rawConfig.output_dir === "string" ? path.resolve(rawConfig.output_dir) : null;
          if (outputDir && !containedPath(config.paths.output_root, outputDir) && !containedPath(config.paths.runtime_root, outputDir)) throw new Error("checkpoint audit output_dir is outside configured output roots");
          const preservedRoot = outputDir ? path.join(outputDir, "PRESERVED_CHECKPOINTS") : null;
          const protectedByPreservedCheckpoints = Boolean(preservedRoot && fs.existsSync(preservedRoot) && checkpointEntries(outputDir).some((entry) => entry.preserved));
          configs.push({
            path: filePath,
            checkpoints_total_limit: retention,
            meets_minimum: Number.isFinite(retention) && retention >= minimum,
            output_dir: outputDir,
            preserved_root: preservedRoot,
            protected_by_preserved_checkpoints: protectedByPreservedCheckpoints,
          });
        } catch {
          // Ignore unrelated or incomplete JSON; malformed candidate configs do not mutate local state.
        }
      }
      const belowMinimum = configs.filter((entry) => !entry.meets_minimum);
      const unprotectedBelowMinimum = belowMinimum.filter((entry) => !entry.protected_by_preserved_checkpoints);
      return {
        runtime_root: root,
        minimum,
        config_count: configs.length,
        below_minimum_count: belowMinimum.length,
        below_minimum: belowMinimum,
        unprotected_below_minimum_count: unprotectedBelowMinimum.length,
        valid: configs.length > 0 && unprotectedBelowMinimum.length === 0,
      };
    },
    async training_preservation_status() {
      enabled("inspect");
      const outputRoot = checkedRoot(config.paths.output_root, "output root");
      const preservedRoots = [];
      const pending = [outputRoot];
      while (pending.length) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          if (entry.isSymbolicLink()) throw new Error("preservation scan may not traverse symbolic links");
          if (!entry.isDirectory()) continue;
          const candidate = path.join(current, entry.name);
          if (!inside(outputRoot, fs.realpathSync(candidate))) throw new Error("preservation scan entry escapes configured output root");
          if (entry.name === "PRESERVED_CHECKPOINTS") {
            preservedRoots.push({ path: candidate, checkpoints: checkpointEntries(path.dirname(candidate)).filter((item) => item.preserved).map((item) => item.name) });
          } else pending.push(candidate);
        }
      }
      return {
        preservation_root: outputRoot,
        exists: true,
        preserved_roots: preservedRoots.sort((a, b) => a.path.localeCompare(b.path)),
        preserved_checkpoint_count: preservedRoots.reduce((total, entry) => total + entry.checkpoints.length, 0),
      };
    },
    async training_stage_sample_set(args) {
      enabled("stage");
      const sourceId = safeId(args.source_id, "source_id"), datasetId = safeId(args.dataset_id, "dataset_id");
      const manifest = validateManifest(args.manifest, config.limits);
      const authorization = authorize(args, "stage", datasetId, manifest.revision);
      const source = existingBelow(config.paths.inbox_root, sourceId, "sample-set inbox");
      exactInventory(source, manifest, config.limits);
      if (!captionedDataset(source, config.limits)) throw new Error("sample set requires an image and a non-empty sidecar caption per image");
      const destination = path.join(config.paths.dataset_root, datasetId);
      if (fs.existsSync(destination)) {
        exactInventory(existingBelow(config.paths.dataset_root, datasetId, "dataset"), manifest, config.limits);
        return { changed: false, dataset_id: datasetId, revision: manifest.revision, authorization };
      }
      fs.cpSync(source, destination, { recursive: true, errorOnExist: true, mode: fs.constants.COPYFILE_EXCL });
      exactInventory(destination, manifest, config.limits);
      return { changed: true, dataset_id: datasetId, revision: manifest.revision, authorization };
    },
    async training_import_dataset_bundle(args) {
      enabled("stage");
      const artifactId = safeId(args.artifact_id, "artifact_id");
      const datasetId = safeId(args.dataset_id, "dataset_id");
      if (!SHA256.test(args.artifact_sha256)) throw new Error("artifact_sha256 must be SHA256");
      const authorization = authorize(args, "import", datasetId, args.artifact_sha256);
      const verified = await dependencies.call_core_tool("verify_artifact", {
        artifact_id: artifactId,
        expected_sha256: args.artifact_sha256,
      });
      if (!object(verified) || verified.matches !== true || verified.sha256 !== args.artifact_sha256 || typeof verified.path !== "string") {
        throw new Error("dataset artifact is not registered and verified by HawkSpan");
      }
      const bundle = decodeDatasetBundle(verified.path, args.artifact_sha256, config.limits);
      for (const [relative, payload] of bundle.payloadByPath) {
        if (!payload.artifact_id) continue;
        const fileArtifact = await dependencies.call_core_tool("verify_artifact", {
          artifact_id: payload.artifact_id,
          expected_sha256: payload.artifact_sha256,
        });
        if (!object(fileArtifact) || fileArtifact.matches !== true || fileArtifact.sha256 !== payload.artifact_sha256 || typeof fileArtifact.path !== "string") {
          throw new Error(`dataset file artifact is not registered and verified: ${relative}`);
        }
        const stat = fs.lstatSync(fileArtifact.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bundle.manifest.files.find(({ path: item }) => item === relative).size_bytes) {
          throw new Error(`dataset file artifact is not an exact regular file: ${relative}`);
        }
        payload.source_path = fileArtifact.path;
      }
      const changed = materializeDataset(config.paths.dataset_root, datasetId, bundle, config.limits);
      return {
        changed,
        dataset_id: datasetId,
        revision: bundle.manifest.revision,
        file_count: bundle.manifest.file_count,
        total_bytes: bundle.manifest.total_bytes,
        artifact_id: artifactId,
        artifact_sha256: args.artifact_sha256,
        authorization,
      };
    },
    async training_readiness(args) {
      enabled("validate");
      const jobId = safeId(args.job_id, "job_id");
      const datasetId = safeId(args.dataset_id, "dataset_id");
      const recipeId = safeId(args.recipe_id, "recipe_id");
      const dataset = existingBelow(config.paths.dataset_root, datasetId, "dataset");
      const recipeDocument = recipe(recipeId, args.recipe_revision);
      const configuredBackendPath = typeof recipeDocument.config.data_backend_config === "string"
        ? path.resolve(recipeDocument.config.data_backend_config)
        : null;
      const defaultBackendPath = path.join(config.paths.recipe_root, `${recipeId}.multidatabackend.json`);
      const backendPath = configuredBackendPath && inside(config.paths.recipe_root, configuredBackendPath) && fs.existsSync(configuredBackendPath)
        ? existingBelow(config.paths.recipe_root, path.relative(config.paths.recipe_root, configuredBackendPath), "backend", "file")
        : existingBelow(config.paths.recipe_root, path.relative(config.paths.recipe_root, defaultBackendPath), "backend", "file");
      const policyPath = existingBelow(config.paths.recipe_root, `${recipeId}.policy.json`, "policy", "file");
      const validationPromptPath = existingBelow(config.paths.recipe_root, `${recipeId}.validation-prompts.json`, "validation prompt library", "file");
      const backend = readJson(backendPath, config.limits.maxJson);
      const policy = readJson(policyPath, config.limits.maxJson);
      const validation = readJson(validationPromptPath, config.limits.maxJson);
      const problems = [];
      const datasetEvidence = datasetReadiness(dataset, config.limits);
      problems.push(...datasetEvidence.problems);
      if (!object(recipeDocument.config)) problems.push({ issue: "missing_or_invalid_config" });
      if (!Array.isArray(backend)) problems.push({ issue: "missing_or_invalid_data_backend" });
      if (!object(policy)) problems.push({ issue: "missing_training_readiness_policy" });
      const imageBackends = Array.isArray(backend) ? backend.filter((entry) => entry.type === "local" && (entry.dataset_type === undefined || entry.dataset_type === "image")) : [];
      const conditioningBackends = Array.isArray(backend) ? backend.filter((entry) => entry.type === "local" && entry.dataset_type === "conditioning") : [];
      const textBackends = Array.isArray(backend) ? backend.filter((entry) => entry.dataset_type === "text_embeds") : [];
      if (imageBackends.length !== 1) problems.push({ issue: "expected_exactly_one_image_backend", actual: imageBackends.length });
      if (textBackends.length < 1) problems.push({ issue: "missing_text_embedding_backend" });
      const imageBackend = imageBackends[0] || null;
      if (imageBackend) {
        const imagePath = path.resolve(imageBackend.instance_data_dir || "");
        if (!inside(path.resolve(dataset), imagePath)) problems.push({ issue: "backend_dataset_path_mismatch" });
        if (imageBackend.caption_strategy !== "textfile") problems.push({ issue: "caption_strategy_must_be_textfile" });
        if (!Number.isSafeInteger(imageBackend.repeats) || imageBackend.repeats < 1) problems.push({ issue: "image_backend_repeats_must_be_positive" });
        if (imageBackend.maximum_image_size !== undefined && !(Number(imageBackend.target_downsample_size) > 0)) {
          problems.push({ issue: "maximum_image_size_requires_target_downsample_size" });
        }
        if (imageBackend.conditioning !== undefined) {
          const nested = imageBackend.conditioning;
          if (!object(nested) || nested.type !== "canny" || nested.conditioning_type !== "controlnet") {
            problems.push({ issue: "invalid_nested_controlnet_conditioning" });
          } else if (!inside(path.resolve(dataset), path.resolve(nested.instance_data_dir || ""))) {
            problems.push({ issue: "conditioning_dataset_path_mismatch" });
          } else if (recipeDocument.config.eval_dataset_id !== `${imageBackend.id}_conditioning_${nested.type}`) {
            problems.push({ issue: "controlnet_eval_dataset_id_mismatch" });
          }
        } else if (imageBackend.conditioning_data !== undefined) {
          const linked = Array.isArray(imageBackend.conditioning_data) ? imageBackend.conditioning_data : [];
          if (linked.length !== 1 || typeof linked[0] !== "string") {
            problems.push({ issue: "expected_exactly_one_conditioning_link", actual: linked.length });
          } else {
            const conditioning = conditioningBackends.find((entry) => entry.id === linked[0]);
            if (!conditioning) problems.push({ issue: "missing_conditioning_backend", id: linked[0] });
            else if (!inside(path.resolve(dataset), path.resolve(conditioning.instance_data_dir || ""))) problems.push({ issue: "conditioning_dataset_path_mismatch" });
          }
        }
      }
      for (const conditioning of conditioningBackends) {
        if (!Number.isSafeInteger(conditioning.repeats) || conditioning.repeats < 1) problems.push({ issue: "conditioning_backend_repeats_must_be_positive", id: conditioning.id || null });
      }
      if (recipeDocument.config.controlnet === true && !imageBackend?.conditioning && conditioningBackends.length !== 1) problems.push({ issue: "expected_controlnet_conditioning", actual: conditioningBackends.length });
      const configuredBackend = recipeDocument.config.data_backend_config ?? recipeDocument.config["--data_backend_config"];
      if (configuredBackend && path.resolve(configuredBackend) !== path.resolve(backendPath)) problems.push({ issue: "config_backend_path_mismatch" });
      if (Number(recipeDocument.config.checkpoint_step_interval || 0) <= 0) problems.push({ issue: "missing_checkpoint_interval" });
      if (Number(recipeDocument.config.max_train_steps || 0) <= 0) problems.push({ issue: "missing_max_train_steps" });
      if (typeof recipeDocument.config.optimizer !== "string" || !recipeDocument.config.optimizer) problems.push({ issue: "missing_optimizer" });
      if (recipeDocument.config.optimizer === "adamw_bf16" && recipeDocument.config.mixed_precision !== "bf16") {
        problems.push({ issue: "adamw_bf16_requires_bf16_mixed_precision" });
      }
      if (Number(recipeDocument.config.checkpoints_total_limit || 0) < Number(policy.minimum_checkpoint_retention || 1)) {
        problems.push({ issue: "insufficient_checkpoint_retention", actual: Number(recipeDocument.config.checkpoints_total_limit || 0), required: Number(policy.minimum_checkpoint_retention || 1) });
      }
      problems.push(...promptLibraryReadiness(validation));
      const evidence = {
        schema_version: 1,
        generated_at: now(),
        job_id: jobId,
        dataset_id: datasetId,
        recipe_id: recipeId,
        dataset_path: dataset,
        config_path: path.join(config.paths.recipe_root, `${recipeId}.json`),
        backend_path: backendPath,
        policy_path: policyPath,
        validation_prompt_library: validationPromptPath,
        dataset_revision_sha256: datasetEvidence.dataset_revision_sha256,
        config_sha256: fileSha256(path.join(config.paths.recipe_root, `${recipeId}.json`)),
        backend_sha256: fileSha256(backendPath),
        policy_sha256: fileSha256(policyPath),
        validation_sha256: fileSha256(validationPromptPath),
        image_count: datasetEvidence.image_count,
        caption_count: datasetEvidence.caption_count,
        recovery_checkpoint: policy.recovery_checkpoint || null,
        problems,
      };
      evidence.revision_fingerprint = revision({
        job_id: evidence.job_id,
        dataset_revision_sha256: evidence.dataset_revision_sha256,
        config_sha256: evidence.config_sha256,
        backend_sha256: evidence.backend_sha256,
        policy_sha256: evidence.policy_sha256,
        validation_sha256: evidence.validation_sha256,
        recovery_checkpoint: evidence.recovery_checkpoint,
      });
      evidence.ready = problems.length === 0;
      const readinessRelative = path.join("readiness", `${jobId}-${evidence.revision_fingerprint.slice(0, 16)}.json`);
      atomicJson(config.paths.state_root, readinessRelative, evidence, config.limits.maxJson);
      return { ...evidence, readiness_path: path.join(config.paths.state_root, readinessRelative) };
    },
    async training_stage_runtime_job(args) {
      enabled("stage"); enabled("validate");
      const jobId = safeId(args.job_id, "job_id");
      const datasetId = safeId(args.dataset_id, "dataset_id");
      const recipeId = safeId(args.recipe_id, "recipe_id");
      const sourceDataset = existingBelow(config.paths.dataset_root, datasetId, "dataset");
      const sourceConfigPath = existingBelow(config.paths.recipe_root, `${recipeId}.json`, "recipe", "file");
      const sourceBackendPath = existingBelow(config.paths.recipe_root, `${recipeId}.multidatabackend.json`, "backend", "file");
      const sourcePolicyPath = existingBelow(config.paths.recipe_root, `${recipeId}.policy.json`, "policy", "file");
      const sourceValidationPath = existingBelow(config.paths.recipe_root, `${recipeId}.validation-prompts.json`, "validation prompt library", "file");
      const sourceRevision = revision({
        job_id: jobId,
        dataset_id: datasetId,
        recipe_id: recipeId,
        dataset: directoryInventory(sourceDataset, config.limits),
        config_sha256: fileSha256(sourceConfigPath),
        backend_sha256: fileSha256(sourceBackendPath),
        policy_sha256: fileSha256(sourcePolicyPath),
        validation_sha256: fileSha256(sourceValidationPath),
      });
      const runtimeRoot = checkedRoot(config.paths.runtime_root, "runtime root");
      const jobsRoot = path.join(runtimeRoot, "jobs");
      fs.mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
      const finalRoot = path.join(jobsRoot, `${jobId}--${sourceRevision.slice(0, 12)}`);
      const stageManifestPath = path.join(finalRoot, "STAGE-MANIFEST.json");
      if (fs.existsSync(finalRoot)) {
        const existing = readJson(stageManifestPath, config.limits.maxJson);
        if (existing.source_revision_sha256 !== sourceRevision) throw new Error("existing staged path has a different source revision");
        return { staged: true, already_present: true, runtime_job_root: finalRoot, runtime_manifest: existing.runtime_manifest, revision_fingerprint: existing.revision_fingerprint, ready: existing.ready, problems: existing.problems, training_started: existing.training_started === true };
      }
      const temporary = path.join(jobsRoot, `.hawkspan-stage-${jobId}-${process.pid}-${Date.now()}`);
      fs.mkdirSync(temporary, { recursive: false, mode: 0o700 });
      try {
        const datasetTarget = path.join(temporary, "dataset");
        const configTarget = path.join(temporary, "config");
        cloneDirectory(sourceDataset, datasetTarget);
        fs.mkdirSync(configTarget, { recursive: true, mode: 0o700 });
        fs.copyFileSync(sourceConfigPath, path.join(configTarget, "hawkspan-recipe.json"), fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(sourceBackendPath, path.join(configTarget, "multidatabackend.json"), fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(sourcePolicyPath, path.join(configTarget, "TRAINING_READINESS_POLICY.json"), fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(sourceValidationPath, path.join(configTarget, "validation-prompts.json"), fs.constants.COPYFILE_EXCL);
        const runtimeOutput = path.join(runtimeRoot, "outputs", jobId);
        const runtimeCache = path.join(runtimeRoot, "cache", jobId);
        const recipeDocument = readJson(path.join(configTarget, "hawkspan-recipe.json"), config.limits.maxJson);
        const backend = readJson(path.join(configTarget, "multidatabackend.json"), config.limits.maxJson);
        const policy = readJson(path.join(configTarget, "TRAINING_READINESS_POLICY.json"), config.limits.maxJson);
        recipeDocument.config.data_backend_config = path.join(configTarget, "multidatabackend.json");
        recipeDocument.config.output_dir = runtimeOutput;
        if (policy.recovery_checkpoint) recipeDocument.config.resume_from_checkpoint = policy.recovery_checkpoint;
        else delete recipeDocument.config.resume_from_checkpoint;
        for (const entry of backend) {
          if (entry.type === "local" && entry.dataset_type !== "text_embeds") {
            const sourceInstance = path.resolve(entry.instance_data_dir || "");
            if (!inside(path.resolve(sourceDataset), sourceInstance)) throw new Error("backend dataset path is outside the staged source dataset");
            entry.instance_data_dir = path.join(datasetTarget, path.relative(sourceDataset, sourceInstance));
            entry.cache_dir_vae = path.join(runtimeCache, "vae");
            if (object(entry.conditioning) && typeof entry.conditioning.instance_data_dir === "string") {
              const sourceConditioning = path.resolve(entry.conditioning.instance_data_dir);
              if (!inside(path.resolve(sourceDataset), sourceConditioning)) throw new Error("nested conditioning path is outside the staged source dataset");
              entry.conditioning.instance_data_dir = path.join(datasetTarget, path.relative(sourceDataset, sourceConditioning));
            }
          } else if (entry.dataset_type === "text_embeds") {
            entry.cache_dir = path.join(runtimeCache, "text");
          }
        }
        policy.validation_prompt_library = path.join(configTarget, "validation-prompts.json");
        fs.writeFileSync(path.join(configTarget, "hawkspan-recipe.json"), `${JSON.stringify(recipeDocument, null, 2)}\n`);
        fs.writeFileSync(path.join(configTarget, "multidatabackend.json"), `${JSON.stringify(backend, null, 2)}\n`);
        fs.writeFileSync(path.join(configTarget, "TRAINING_READINESS_POLICY.json"), `${JSON.stringify(policy, null, 2)}\n`);
        fs.renameSync(temporary, finalRoot);
        for (const jsonPath of ["config/hawkspan-recipe.json", "config/multidatabackend.json", "config/TRAINING_READINESS_POLICY.json"]) {
          const file = path.join(finalRoot, jsonPath);
          fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(temporary, finalRoot));
        }
        const finalRecipeDocument = readJson(path.join(finalRoot, "config", "hawkspan-recipe.json"), config.limits.maxJson);
        fs.writeFileSync(path.join(finalRoot, "config", "config.json"), `${JSON.stringify(finalRecipeDocument.config, null, 2)}\n`);
        fs.copyFileSync(path.join(finalRoot, "config", "multidatabackend.json"), path.join(finalRoot, "config", "hawkspan-recipe.multidatabackend.json"));
        fs.copyFileSync(path.join(finalRoot, "config", "TRAINING_READINESS_POLICY.json"), path.join(finalRoot, "config", "hawkspan-recipe.policy.json"));
        fs.copyFileSync(path.join(finalRoot, "config", "validation-prompts.json"), path.join(finalRoot, "config", "hawkspan-recipe.validation-prompts.json"));
        for (const directory of [runtimeOutput, path.join(runtimeRoot, "logs"), path.join(runtimeRoot, "manifests"), path.join(runtimeCache, "vae"), path.join(runtimeCache, "text")]) {
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        }
        const runtimeManifestPath = path.join(runtimeRoot, "captioned-lora-manifest.json");
        const runtimeJob = { job_id: jobId, dataset_id: datasetId, recipe_id: recipeId, data_dir: path.join(finalRoot, "dataset"), config_dir: path.join(finalRoot, "config"), output_dir: runtimeOutput, runtime_staged: true, source_revision_sha256: sourceRevision };
        const runtimeManifest = readOptionalJson(runtimeManifestPath, config.limits.maxJson) || [];
        const nextManifest = [...runtimeManifest.filter((entry) => entry.job_id !== jobId), runtimeJob].sort((a, b) => a.job_id.localeCompare(b.job_id));
        fs.writeFileSync(runtimeManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
        const runtimeReadiness = createApplicationWorkflows({
          ...sourceConfiguration,
          paths: {
            inbox_root: { env: "HAWKSPAN_WORKLOAD_INBOX_ROOT" },
            dataset_root: { env: "HAWKSPAN_RUNTIME_DATASET_ROOT" },
            recipe_root: { env: "HAWKSPAN_RUNTIME_RECIPE_ROOT" },
            output_root: { env: "HAWKSPAN_RUNTIME_OUTPUT_ROOT" },
            state_root: { env: "HAWKSPAN_RUNTIME_STATE_ROOT" },
            disk_root: { env: "HAWKSPAN_RUNTIME_DISK_ROOT" },
            runtime_root: { env: "HAWKSPAN_RUNTIME_ROOT" },
          },
        }, {
          ...dependencies,
          environment: {
            ...(dependencies.environment || process.env),
            HAWKSPAN_RUNTIME_DATASET_ROOT: path.dirname(runtimeJob.data_dir),
            HAWKSPAN_RUNTIME_RECIPE_ROOT: runtimeJob.config_dir,
            HAWKSPAN_RUNTIME_OUTPUT_ROOT: path.join(runtimeRoot, "outputs"),
            HAWKSPAN_RUNTIME_STATE_ROOT: path.join(runtimeRoot, "manifests"),
            HAWKSPAN_RUNTIME_DISK_ROOT: runtimeRoot,
            HAWKSPAN_RUNTIME_ROOT: runtimeRoot,
          },
        });
        const readiness = await runtimeReadiness.training_readiness({ job_id: jobId, dataset_id: path.basename(runtimeJob.data_dir), recipe_id: "hawkspan-recipe", recipe_revision: fileSha256(path.join(runtimeJob.config_dir, "hawkspan-recipe.json")) });
        const revisionFingerprint = revision({
          readiness_revision_fingerprint: readiness.revision_fingerprint,
          simpletuner_config_sha256: fileSha256(path.join(runtimeJob.config_dir, "config.json")),
        });
        const stageManifest = {
          schema_version: 1,
          created_at: now(),
          job_id: jobId,
          source_revision_sha256: sourceRevision,
          source_dataset_inventory: directoryInventory(sourceDataset, config.limits),
          source_config_inventory: [sourceConfigPath, sourceBackendPath, sourcePolicyPath, sourceValidationPath].map((file) => ({ path: path.basename(file), size_bytes: fs.statSync(file).size, sha256: fileSha256(file) })),
          runtime_manifest: runtimeManifestPath,
          runtime_job: runtimeJob,
          runtime_readiness_path: readiness.readiness_path,
          revision_fingerprint: revisionFingerprint,
          recovery_checkpoint: readiness.recovery_checkpoint,
          ready: readiness.ready,
          problems: readiness.problems,
          training_authorized: false,
          training_started: false,
        };
        fs.writeFileSync(stageManifestPath, `${JSON.stringify(stageManifest, null, 2)}\n`);
        return { staged: true, already_present: false, runtime_job_root: finalRoot, runtime_manifest: runtimeManifestPath, ready: stageManifest.ready, problems: stageManifest.problems, revision_fingerprint: stageManifest.revision_fingerprint, recovery_checkpoint: stageManifest.recovery_checkpoint, training_started: false };
      } catch (error) {
        fs.rmSync(temporary, { recursive: true, force: true });
        throw error;
      }
    },
    async training_local_trainer_start(args) {
      enabled("local_trainer_start");
      const jobId = safeId(args.job_id, "job_id");
      const target = safeId(args.target, "target");
      if (!SHA256.test(args.expected_revision_fingerprint)) throw new Error("expected_revision_fingerprint must be SHA256");
      const staged = stageManifestForTarget(config, target, args.expected_revision_fingerprint);
      const authorization = authorize(args, "local-trainer-start", target, args.expected_revision_fingerprint);
      const result = runLocalTrainerScript(config, dependencies, config.localTrainer.start_script, [
        "--job-id", jobId,
        "--target", target,
        "--expected-revision-fingerprint", args.expected_revision_fingerprint,
      ]);
      const state = { schema_version: 1, target, authorization_job_id: jobId, revision_fingerprint: args.expected_revision_fingerprint, state: "started", stage_manifest: staged.path, updated_at: now() };
      atomicJson(config.paths.state_root, localTrainerStateRelative(target), state, config.limits.maxJson);
      return { authorization, target, revision_fingerprint: args.expected_revision_fingerprint, invoked: true, result };
    },
    async training_local_trainer_stop(args) {
      enabled("local_trainer_stop");
      const jobId = safeId(args.job_id, "job_id");
      const target = safeId(args.target, "target");
      const managed = reconciledLocalTrainerState(config, target, now());
      if (!managed || managed.target !== target || !["started", "running"].includes(managed.state)) throw new Error("no adapter-managed running target found");
      const authorization = authorize(args, "local-trainer-stop", target, managed.revision_fingerprint);
      const result = runLocalTrainerScript(config, dependencies, config.localTrainer.stop_script, ["--job-id", jobId, "--target", target]);
      atomicJson(config.paths.state_root, localTrainerStateRelative(target), { ...managed, stop_authorization_job_id: jobId, state: "stop_requested", updated_at: now() }, config.limits.maxJson);
      return { authorization, target, invoked: true, result };
    },
    async training_local_trainer_package(args) {
      enabled("local_trainer_package");
      const jobId = safeId(args.job_id, "job_id");
      const target = safeId(args.target, "target");
      const managed = reconciledLocalTrainerState(config, target, now());
      if (!managed || managed.target !== target || !["completed", "stopped", "failed"].includes(managed.state) || !SHA256.test(managed.revision_fingerprint)) throw new Error("no adapter-managed terminal target state found");
      const authorization = dependencies.require_authorized_job({
        job_id: jobId,
        kind: `${config.requiredJob.prefix}:local-trainer-package:${target}:${managed.revision_fingerprint}`,
        states: [config.requiredJob.state, "completed"],
      });
      const result = runLocalTrainerScript(config, dependencies, config.localTrainer.package_script, ["--job-id", jobId, "--target", target], config.localTrainer.package_timeout_ms);
      let packet;
      try { packet = JSON.parse(result.stdout.trim()); } catch { throw new Error("local trainer package command returned invalid packet JSON"); }
      if (!object(packet) || packet.target !== target || packet.revision_fingerprint !== managed.revision_fingerprint || packet.status !== "packaged" ||
          typeof packet.packet_path !== "string" || !SHA256.test(packet.packet_sha256 || "") || typeof packet.identity !== "string") {
        throw new Error("local trainer package command returned an invalid packet identity");
      }
      const packetPath = existingBelow(config.paths.output_root, packet.packet_path, "return packet", "file");
      const packetSize = fs.statSync(packetPath).size;
      if (fileSha256(packetPath) !== packet.packet_sha256) throw new Error("return packet does not match its declared SHA256");
      let artifact = null;
      if (managed.package_artifact?.packet_sha256 === packet.packet_sha256 && typeof managed.package_artifact.artifact_id === "string") {
        try {
          const verified = await dependencies.call_core_tool("verify_artifact", {
            artifact_id: managed.package_artifact.artifact_id,
            expected_sha256: packet.packet_sha256,
          });
          if (object(verified) && verified.matches === true && verified.sha256 === packet.packet_sha256 && path.resolve(verified.path || "") === packetPath) {
            artifact = { ...managed.package_artifact, size_bytes: packetSize };
          }
        } catch {}
      }
      if (!artifact) {
        const registered = await dependencies.call_core_tool("register_artifact", {
          path: packetPath,
          name: path.basename(packetPath),
          metadata: {
            kind: "hawkspan-simpletuner-return-packet",
            target,
            revision_fingerprint: managed.revision_fingerprint,
            packet_sha256: packet.packet_sha256,
          },
        });
        if (!object(registered) || typeof registered.artifact_id !== "string" || registered.sha256 !== packet.packet_sha256 || Number(registered.size_bytes) !== packetSize) {
          throw new Error("HawkSpan did not register the exact return packet");
        }
        artifact = {
          artifact_id: safeId(registered.artifact_id, "registered packet artifact_id"),
          name: path.basename(packetPath),
          size_bytes: packetSize,
          packet_sha256: packet.packet_sha256,
        };
      }
      atomicJson(config.paths.state_root, localTrainerStateRelative(target), {
        ...managed,
        package_authorization_job_id: jobId,
        package_identity: packet.identity,
        package_artifact: artifact,
        state: "packaged",
        updated_at: now(),
      }, config.limits.maxJson);
      return {
        authorization,
        target,
        revision_fingerprint: managed.revision_fingerprint,
        invoked: true,
        package: {
          built: packet.built === true,
          identity: packet.identity,
          artifact_id: artifact.artifact_id,
          name: artifact.name,
          size_bytes: artifact.size_bytes,
          packet_sha256: artifact.packet_sha256,
        },
        result: { status: result.status, stderr: result.stderr },
      };
    },
    async training_receive_return_packet(args) {
      enabled("packet_intake");
      if (config.role !== "controller") throw new Error("packet intake requires controller role");
      const artifactId = safeId(args.artifact_id, "artifact_id");
      const target = safeId(args.expected_target, "expected_target");
      const expectedSha256 = string(args.expected_sha256, "expected_sha256", 64).toLowerCase();
      const expectedRevision = string(args.expected_revision_fingerprint, "expected_revision_fingerprint", 64).toLowerCase();
      if (!SHA256.test(expectedSha256)) throw new Error("expected_sha256 must be SHA256");
      if (!SHA256.test(expectedRevision)) throw new Error("expected_revision_fingerprint must be SHA256");
      const recipient = args.receipt_recipient === undefined
        ? null
        : string(args.receipt_recipient, "receipt_recipient", 256);

      const received = await dependencies.call_core_tool("receive_artifacts", {});
      if (!object(received) || !Array.isArray(received.artifacts)) throw new Error("HawkSpan artifact receipt returned an invalid result");
      const exactReceived = received.artifacts.filter((entry) => object(entry) && entry.artifact_id === artifactId);
      if (exactReceived.length !== 1 || exactReceived[0].verified !== true || typeof exactReceived[0].path !== "string") {
        throw new Error("exact return packet artifact was not received verified");
      }

      const verified = await dependencies.call_core_tool("verify_artifact", {
        artifact_id: artifactId,
        expected_sha256: expectedSha256,
      });
      if (!object(verified) || verified.matches !== true || verified.sha256 !== expectedSha256 || typeof verified.path !== "string") {
        throw new Error("exact return packet artifact SHA256 was not verified");
      }
      const receivedPath = path.resolve(exactReceived[0].path);
      if (path.resolve(verified.path) !== receivedPath) throw new Error("received and verified artifact paths do not match");
      const sourceStat = fs.lstatSync(receivedPath);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error("received return packet must be a non-symlink regular file");
      const source = fs.realpathSync(receivedPath);
      const stateRoot = checkedRoot(config.paths.state_root, "state root");
      const artifactRoot = checkedRoot(path.join(stateRoot, "artifacts"), "HawkSpan artifact root");
      if (path.dirname(source) !== artifactRoot) throw new Error("received return packet is outside the HawkSpan artifact root");

      const destinationPath = path.join(stateRoot, "received-packets");
      if (!fs.existsSync(destinationPath)) fs.mkdirSync(destinationPath, { recursive: false, mode: 0o700 });
      const destinationRoot = checkedRoot(destinationPath, "received packet destination");
      fs.chmodSync(destinationRoot, 0o700);
      const packetDestination = path.join(destinationRoot, path.basename(source));
      const receiptRoot = path.join(destinationRoot, "receipts");
      const registryDestination = path.join(destinationRoot, "packet-registry.json");
      for (const [candidate, label, expectedType] of [
        [packetDestination, "received packet destination", "file"],
        [receiptRoot, "packet receipt root", "directory"],
        [registryDestination, "packet registry", "file"],
      ]) {
        if (!fs.existsSync(candidate)) continue;
        const candidateStat = fs.lstatSync(candidate);
        if (candidateStat.isSymbolicLink() || (expectedType === "file" ? !candidateStat.isFile() : !candidateStat.isDirectory())) {
          throw new Error(`${label} has an unsafe existing type`);
        }
      }
      const temporaryRoot = fs.mkdtempSync(path.join(stateRoot, ".packet-intake-"));
      fs.chmodSync(temporaryRoot, 0o700);
      const configPath = path.join(temporaryRoot, "receiver-config.json");
      const receiverConfig = {
        staging_root: path.dirname(source),
        destination_root: destinationRoot,
        expected_target: target,
        expected_revision_fingerprint: expectedRevision,
        ...(recipient ? { receipt_recipient: recipient } : {}),
      };
      fs.writeFileSync(configPath, `${JSON.stringify(receiverConfig, null, 2)}\n`, { mode: 0o600, flag: "wx" });

      let intake;
      try {
        intake = runPacketReceiver(config, dependencies, [
          "--config", configPath,
          "--source", source,
          "--expected-size", String(sourceStat.size),
          "--expected-sha256", expectedSha256,
        ]);
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }

      if (!object(intake) || !object(intake.receipt) || !object(intake.message) ||
          intake.receipt.sha256 !== expectedSha256 || Number(intake.receipt.size_bytes) !== sourceStat.size ||
          path.resolve(intake.receipt.source || "") !== source || intake.receipt.archive_integrity !== true ||
          intake.receipt.internal_inventory_verified !== true || intake.receipt.packet_complete !== true ||
          !Array.isArray(intake.receipt.packet_missing) || intake.receipt.packet_missing.length !== 0 ||
          !object(intake.receipt.packet_identity) ||
          intake.receipt.packet_identity.target !== target ||
          String(intake.receipt.packet_identity.revision_fingerprint || "").toLowerCase() !== expectedRevision ||
          typeof intake.receipt_path !== "string" || typeof intake.registry_path !== "string") {
        throw new Error("packet receiver returned mismatched receipt identity");
      }
      const destination = path.resolve(intake.receipt.destination || "");
      if (path.dirname(destination) !== destinationRoot || !fs.existsSync(destination) ||
          path.resolve(intake.receipt_path) !== path.join(destinationRoot, "receipts", `${path.basename(source)}.receipt.json`) ||
          path.resolve(intake.registry_path) !== path.join(destinationRoot, "packet-registry.json")) {
        throw new Error("packet receiver returned paths outside the configured receipt destination");
      }
      for (const [candidate, label] of [
        [destination, "received packet"],
        [path.resolve(intake.receipt_path), "packet receipt"],
        [path.resolve(intake.registry_path), "packet registry"],
      ]) {
        const candidateStat = fs.lstatSync(candidate);
        if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) throw new Error(`${label} must be a non-symlink regular file`);
      }
      if (intake.message.correlation_id !== expectedSha256 || !object(intake.message.metadata) ||
          intake.message.kind !== "artifact-receipt" ||
          (recipient !== null && intake.message.recipient !== recipient) ||
          intake.message.metadata.sha256 !== expectedSha256 ||
          intake.message.metadata.packet_complete !== true ||
          !Array.isArray(intake.message.metadata.packet_missing) || intake.message.metadata.packet_missing.length !== 0 ||
          intake.message.metadata.packet_identity?.target !== target ||
          String(intake.message.metadata.packet_identity?.revision_fingerprint || "").toLowerCase() !== expectedRevision) {
        throw new Error("packet receiver returned mismatched receipt message identity");
      }

      const body = `Verified complete HawkSpan return packet ${artifactId} for ${target} at revision ${expectedRevision}. SHA-256 ${expectedSha256}; receipt ${path.resolve(intake.receipt_path)}.`;
      const message = await dependencies.call_core_tool("send_message", {
        ...(recipient ? { recipient } : {}),
        kind: "artifact-receipt",
        subject: string(intake.message.subject, "receipt message subject", 512),
        body,
        correlation_id: expectedSha256,
        metadata: intake.message.metadata,
        deliver: true,
        wake: false,
      });
      if (!object(message) || typeof message.message_id !== "string" || !message.message_id) {
        throw new Error("HawkSpan did not persist the verified packet receipt message");
      }
      return {
        artifact_id: artifactId,
        target,
        revision_fingerprint: expectedRevision,
        size_bytes: sourceStat.size,
        sha256: expectedSha256,
        packet_path: destination,
        receipt_path: path.resolve(intake.receipt_path),
        registry_path: path.resolve(intake.registry_path),
        message,
      };
    },
  });
}

export async function activate(context) {
  const workflows = createApplicationWorkflows(context.configuration, {
    environment: context.environment,
    require_authorized_job: context.require_authorized_job,
    call_core_tool: context.callCoreTool,
  });
  return { operations: workflows };
}

export const createPlugin = activate;
