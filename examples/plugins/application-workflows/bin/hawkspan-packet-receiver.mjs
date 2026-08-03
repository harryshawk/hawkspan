#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid arguments");
    result[key.slice(2)] = value;
  }
  return result;
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let count;
    do {
      count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count) hash.update(buffer.subarray(0, count));
    } while (count);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filePath);
}

function confinedFile(root, candidate, label) {
  const resolvedRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(candidate);
  if (path.dirname(resolved) !== resolvedRoot) {
    fail(`${label} must be a direct file under its configured root`);
  }
  return resolved;
}

function archiveEntries(filePath) {
  const integrity = spawnSync("unzip", ["-t", filePath], {
    encoding: "utf8",
    timeout: 60 * 60 * 1000,
  });
  if (integrity.error || integrity.status !== 0) fail("archive integrity verification failed");
  const listing = spawnSync("unzip", ["-Z1", filePath], {
    encoding: "utf8",
    timeout: 60 * 60 * 1000,
  });
  if (listing.error || listing.status !== 0) fail("archive inventory failed");
  return listing.stdout.split("\n").filter(Boolean);
}

function verifyPacket(filePath) {
  const verifier = path.join(path.dirname(fileURLToPath(import.meta.url)), "hawkspan-packet-verify.py");
  const result = spawnSync("/usr/bin/python3", [verifier, filePath], {
    encoding: "utf8",
    timeout: 60 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail(`internal packet verification failed: ${(result.stderr || "").trim()}`);
  try { return JSON.parse(result.stdout); } catch { fail("internal packet verifier returned invalid JSON"); }
}

function archiveJson(filePath, entry) {
  const extracted = spawnSync("unzip", ["-p", filePath, entry], {
    encoding: "utf8",
    timeout: 60 * 1000,
  });
  if (extracted.error || extracted.status !== 0) fail(`archive is missing ${entry}`);
  try {
    const document = JSON.parse(extracted.stdout);
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error();
    return document;
  } catch {
    fail(`${entry} is not valid JSON`);
  }
}

function packetRequirements(entries, workflowType) {
  const requirements = {
    final_weights: entries.some((name) =>
      /^OUTPUTS\/.+\.safetensors$/i.test(name) && !/(^|\/)checkpoint-/i.test(name)),
    config: entries.includes("CONFIG/config.json"),
    captions: entries.some((name) => /(^|\/)DATASET\/.+\.txt$/i.test(name)),
    training_images: entries.some((name) =>
      /^DATASET\/.+\.(jpe?g|png|webp)$/i.test(name) &&
      !/(^|\/)(conditioning|control|controlnet)\//i.test(name)),
    logs: entries.some((name) => /(^|\/)logs?\//i.test(name) || name.endsWith(".log")),
    checksums: entries.includes("SHA256-INVENTORY.csv") && entries.includes("SHA256-INVENTORY.json"),
    summary: entries.includes("PACKET-SUMMARY.json"),
  };
  if (workflowType === "controlnet_loha") {
    requirements.conditioning_inputs = entries.some((name) =>
      /(^|\/)DATASET\/(conditioning|control|controlnet)\/.+\.(jpe?g|png|webp)$/i.test(name));
    requirements.conditioning_config = entries.some((name) =>
      /(^|\/)CONFIG\/.*(controlnet|conditioning|multidatabackend).*\.json$/i.test(name));
  } else if (workflowType !== "standard_lora") {
    fail("PACKET-SUMMARY.json has a missing or unsupported training workflow type");
  }
  const missing = Object.entries(requirements)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  return { requirements, missing, complete: missing.length === 0 };
}

function loadRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return { schema_version: 1, packets: {} };
  const stat = fs.lstatSync(registryPath);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("packet registry must be a non-symlink regular file");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (registry.schema_version !== 1 || typeof registry.packets !== "object") {
    fail("packet registry has an unsupported format");
  }
  return registry;
}

const args = parseArguments(process.argv.slice(2));
for (const required of ["config", "source", "expected-size", "expected-sha256"]) {
  if (!args[required]) fail(`--${required} is required`);
}
if (!/^\d+$/.test(args["expected-size"])) fail("expected size must be a non-negative integer");
if (!/^[a-f0-9]{64}$/i.test(args["expected-sha256"])) fail("expected SHA-256 must be 64 hexadecimal characters");

const config = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
if (!config.staging_root || !config.destination_root) {
  fail("staging_root and destination_root are required");
}
if (typeof config.expected_target !== "string" || !config.expected_target ||
    typeof config.expected_revision_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/i.test(config.expected_revision_fingerprint)) {
  fail("expected_target and expected_revision_fingerprint are required");
}
const stagingPath = path.resolve(config.staging_root);
const destinationPath = path.resolve(config.destination_root);
if (!fs.existsSync(stagingPath)) fail("configured staging root does not exist");
const stagingStat = fs.lstatSync(stagingPath);
if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) fail("configured staging root must be a non-symlink directory");
const stagingRoot = fs.realpathSync(stagingPath);
if (!fs.existsSync(destinationPath)) fs.mkdirSync(destinationPath, { recursive: true, mode: 0o700 });
const destinationStat = fs.lstatSync(destinationPath);
if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) fail("configured destination root must be a non-symlink directory");
const destinationRoot = fs.realpathSync(destinationPath);
const source = confinedFile(stagingRoot, path.resolve(args.source), "source");
if (path.extname(source).toLowerCase() !== ".zip") fail("source must be a ZIP archive");

const expectedSize = Number(args["expected-size"]);
const expectedSha256 = args["expected-sha256"].toLowerCase();
const sourceStat = fs.statSync(source);
if (!sourceStat.isFile() || sourceStat.size !== expectedSize) fail("staged archive size does not match expected size");
const sourceSha256 = sha256(source);
if (sourceSha256 !== expectedSha256) fail("staged archive SHA-256 does not match expected SHA-256");
const entries = archiveEntries(source);
const verifiedPacket = verifyPacket(source);
const packetSummary = verifiedPacket.summary;
if (typeof packetSummary.target !== "string" || !packetSummary.target ||
    typeof packetSummary.revision_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/i.test(packetSummary.revision_fingerprint)) {
  fail("PACKET-SUMMARY.json does not identify an exact target revision");
}
if (packetSummary.target !== config.expected_target) {
  fail("packet target does not match configured expected target");
}
if (packetSummary.revision_fingerprint.toLowerCase() !== config.expected_revision_fingerprint.toLowerCase()) {
  fail("packet revision does not match configured expected revision");
}
if (!packetSummary.training_evidence || typeof packetSummary.training_evidence !== "object" ||
    Array.isArray(packetSummary.training_evidence)) {
  fail("PACKET-SUMMARY.json has missing or invalid training evidence");
}
const workflowType = packetSummary.training_evidence.workflow_type;
const packet = packetRequirements(entries, workflowType);
const packetIdentity = {
  target: packetSummary.target,
  revision_fingerprint: packetSummary.revision_fingerprint.toLowerCase(),
  authorization_job_id: packetSummary.authorization_job_id || null,
};

const packetName = path.basename(source);
const destination = path.join(destinationRoot, packetName);
const temporary = path.join(destinationRoot, `.${packetName}.partial-${process.pid}`);
if (fs.existsSync(destination)) {
  const destinationStat = fs.statSync(destination);
  const destinationLinkStat = fs.lstatSync(destination);
  if (destinationLinkStat.isSymbolicLink() || !destinationLinkStat.isFile() ||
      destinationStat.size !== expectedSize || sha256(destination) !== expectedSha256) {
    fail("destination already exists with different content");
  }
} else {
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  const copiedStat = fs.statSync(temporary);
  if (copiedStat.size !== expectedSize || sha256(temporary) !== expectedSha256) {
    fs.unlinkSync(temporary);
    fail("atomic copy verification failed");
  }
  fs.renameSync(temporary, destination);
}

const receiptRoot = path.join(destinationRoot, "receipts");
if (!fs.existsSync(receiptRoot)) fs.mkdirSync(receiptRoot, { recursive: false, mode: 0o700 });
const receiptRootStat = fs.lstatSync(receiptRoot);
if (receiptRootStat.isSymbolicLink() || !receiptRootStat.isDirectory() || fs.realpathSync(receiptRoot) !== receiptRoot) {
  fail("receipt root must be a non-symlink directory under the destination root");
}
const receiptPath = path.join(receiptRoot, `${packetName}.receipt.json`);
const receivedAt = new Date().toISOString();
const receipt = {
  schema_version: 1,
  received_at: receivedAt,
  source,
  destination,
  size_bytes: expectedSize,
  sha256: expectedSha256,
  archive_integrity: true,
  internal_inventory_verified: true,
  inventory_sha256: verifiedPacket.inventory_sha256,
  inventory_json_sha256: verifiedPacket.inventory_json_sha256,
  workflow_type: workflowType,
  packet_identity: packetIdentity,
  packet_complete: packet.complete,
  packet_requirements: packet.requirements,
  packet_missing: packet.missing,
  staging_removed: false,
  authorization_evidence: config.authorization_evidence || null,
};
atomicJson(receiptPath, receipt);

if (config.allow_remove_verified_staging === true &&
    typeof config.authorization_evidence === "string" &&
    config.authorization_evidence.trim()) {
  fs.unlinkSync(source);
  receipt.staging_removed = true;
  atomicJson(receiptPath, receipt);
}

const registryPath = path.join(destinationRoot, "packet-registry.json");
const registry = loadRegistry(registryPath);
registry.updated_at = receivedAt;
registry.packets[expectedSha256] = {
  packet_name: packetName,
  packet_path: destination,
  receipt_path: receiptPath,
  size_bytes: expectedSize,
  sha256: expectedSha256,
  archive_integrity: true,
  internal_inventory_verified: true,
  workflow_type: workflowType,
  packet_identity: packetIdentity,
  packet_complete: packet.complete,
  packet_requirements: packet.requirements,
  packet_missing: packet.missing,
  received_at: receivedAt,
  staging_removed: receipt.staging_removed,
  validation_state: "not_started",
  quality_state: packet.complete ? "awaiting_validation" : "incomplete_return_packet",
};
atomicJson(registryPath, registry);

const message = {
  recipient: config.receipt_recipient || null,
  kind: "artifact-receipt",
  subject: `Packet receipt verified: ${packetName}`,
  correlation_id: expectedSha256,
  metadata: {
    packet: packetName,
    destination,
    receipt: receiptPath,
    registry: registryPath,
    size_bytes: expectedSize,
    sha256: expectedSha256,
    archive_integrity: true,
    workflow_type: workflowType,
    packet_identity: packetIdentity,
    packet_complete: packet.complete,
    packet_requirements: packet.requirements,
    packet_missing: packet.missing,
    destination_secured: true,
    staging_removed: receipt.staging_removed,
    source_deletion_authorized: false,
  },
};
process.stdout.write(`${JSON.stringify({ receipt, receipt_path: receiptPath, registry_path: registryPath, message })}\n`);
