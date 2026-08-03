#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const receiver = path.join(root, "examples/plugins/application-workflows/bin/hawkspan-packet-receiver.mjs");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fixture({ removeStaging = false, workflowType = "controlnet_loha", omit = [] } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-packet-receiver-"));
  const staging = path.join(temporary, "staging");
  const destination = path.join(temporary, "destination");
  const contents = path.join(temporary, "contents");
  const omitted = new Set(omit);
  const target = `hawkspan-robot-${workflowType || "missing"}-acceptance-v1`;
  fs.mkdirSync(staging);
  fs.mkdirSync(contents);
  fs.mkdirSync(path.join(contents, "logs"));
  fs.mkdirSync(path.join(contents, "DATASET"));
  fs.mkdirSync(path.join(contents, "CONFIG"));
  fs.mkdirSync(path.join(contents, "OUTPUTS"));
  if (!omitted.has("final_weights")) {
    fs.writeFileSync(path.join(contents, "OUTPUTS", "pytorch_lora_weights.safetensors"), "weights");
  }
  fs.writeFileSync(path.join(contents, "CONFIG", "config.json"), "{}\n");
  if (!omitted.has("training_images")) {
    fs.writeFileSync(path.join(contents, "DATASET", "robot-001.png"), "training image fixture");
  }
  fs.writeFileSync(path.join(contents, "DATASET", "robot-001.txt"), "public robot caption\n");
  if (workflowType === "controlnet_loha") {
    fs.mkdirSync(path.join(contents, "DATASET", "conditioning"));
    if (!omitted.has("conditioning_inputs")) {
      fs.writeFileSync(path.join(contents, "DATASET", "conditioning", "robot-001.png"), "conditioning fixture");
    }
    if (!omitted.has("conditioning_config")) {
      fs.writeFileSync(path.join(contents, "CONFIG", "multidatabackend.json"), '[{"dataset_type":"conditioning"}]\n');
    }
  }
  fs.writeFileSync(path.join(contents, "logs", "train.log"), "complete\n");
  const payloadFiles = [];
  const pending = [contents];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else payloadFiles.push(target);
    }
  }
  const rows = payloadFiles.map((file) => ({
    packet_path: path.relative(contents, file).split(path.sep).join("/"),
    size_bytes: fs.statSync(file).size,
    sha256: sha256(file),
  })).sort((left, right) => left.packet_path.localeCompare(right.packet_path));
  const csv = `packet_path,size_bytes,sha256\n${rows.map((row) => `${row.packet_path},${row.size_bytes},${row.sha256}`).join("\n")}\n`;
  const inventoryJson = `${JSON.stringify({ schema_version: 1, files: rows }, null, 2)}\n`;
  fs.writeFileSync(path.join(contents, "SHA256-INVENTORY.csv"), csv);
  fs.writeFileSync(path.join(contents, "SHA256-INVENTORY.json"), inventoryJson);
  const trainingEvidence = {};
  if (workflowType !== null) trainingEvidence.workflow_type = workflowType;
  fs.writeFileSync(path.join(contents, "PACKET-SUMMARY.json"), JSON.stringify({
    schema_version: 1,
    authorization_job_id: "public-acceptance-1",
    target,
    revision_fingerprint: "a".repeat(64),
    inventory_sha256: crypto.createHash("sha256").update(csv).digest("hex"),
    inventory_json_sha256: crypto.createHash("sha256").update(inventoryJson).digest("hex"),
    training_evidence: trainingEvidence,
  }));
  const packet = path.join(staging, "sample-packet.zip");
  const zip = spawnSync("zip", ["-qr", packet, "."], { cwd: contents, encoding: "utf8" });
  assert.equal(zip.status, 0, zip.stderr);
  const config = path.join(temporary, "receiver.json");
  fs.writeFileSync(config, JSON.stringify({
    staging_root: staging,
    destination_root: destination,
    receipt_recipient: "peer",
    expected_target: target,
    expected_revision_fingerprint: "a".repeat(64),
    allow_remove_verified_staging: removeStaging,
    authorization_evidence: removeStaging ? "standing-authorization-1" : null,
  }));
  return { temporary, staging, destination, packet, config, target, workflowType };
}

function invoke(item, overrides = {}) {
  const size = overrides.size ?? fs.statSync(item.packet).size;
  const hash = overrides.hash ?? sha256(item.packet);
  return spawnSync(process.execPath, [receiver,
    "--config", item.config,
    "--source", item.packet,
    "--expected-size", String(size),
    "--expected-sha256", hash,
  ], { encoding: "utf8" });
}

test("accepts a verified ControlNet/LoHa packet with conditioning requirements", () => {
  const item = fixture();
  try {
    const result = invoke(item);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.receipt.sha256, sha256(item.packet));
    assert.equal(output.receipt.archive_integrity, true);
    assert.equal(output.receipt.internal_inventory_verified, true);
    assert.equal(output.receipt.packet_complete, true);
    assert.equal(output.receipt.workflow_type, "controlnet_loha");
    assert.equal(output.receipt.packet_identity.target, item.target);
    assert.equal(output.receipt.packet_requirements.final_weights, true);
    assert.equal(output.receipt.packet_requirements.captions, true);
    assert.equal(output.receipt.packet_requirements.conditioning_inputs, true);
    assert.equal(output.receipt.packet_requirements.conditioning_config, true);
    assert.equal(output.receipt.staging_removed, false);
    assert.equal(fs.existsSync(item.packet), true);
    assert.equal(sha256(output.receipt.destination), output.receipt.sha256);
    const registry = JSON.parse(fs.readFileSync(output.registry_path, "utf8"));
    assert.equal(registry.packets[output.receipt.sha256].quality_state, "awaiting_validation");
    assert.equal(output.message.kind, "artifact-receipt");
    assert.equal(output.message.correlation_id, output.receipt.sha256);
    assert.equal(output.message.metadata.workflow_type, "controlnet_loha");
    assert.deepEqual(output.message.metadata.packet_requirements, output.receipt.packet_requirements);
    assert.equal(output.message.metadata.source_deletion_authorized, false);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("accepts a verified standard LoRA packet without conditioning requirements", () => {
  const item = fixture({ workflowType: "standard_lora" });
  try {
    const result = invoke(item);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.receipt.packet_complete, true);
    assert.equal(output.receipt.workflow_type, "standard_lora");
    assert.deepEqual(Object.keys(output.receipt.packet_requirements), [
      "final_weights", "config", "captions", "training_images", "logs", "checksums", "summary",
    ]);
    assert.equal(output.receipt.packet_requirements.final_weights, true);
    assert.equal(output.receipt.packet_requirements.training_images, true);
    assert.equal("conditioning_inputs" in output.receipt.packet_requirements, false);
    const registry = JSON.parse(fs.readFileSync(output.registry_path, "utf8"));
    const record = registry.packets[output.receipt.sha256];
    assert.equal(record.workflow_type, "standard_lora");
    assert.equal(record.quality_state, "awaiting_validation");
    assert.equal(output.message.metadata.workflow_type, "standard_lora");
    assert.deepEqual(output.message.metadata.packet_requirements, output.receipt.packet_requirements);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("records missing workflow-specific contents as incomplete instead of acceptance-ready", () => {
  for (const [workflowType, missing] of [
    ["standard_lora", "final_weights"],
    ["standard_lora", "training_images"],
    ["controlnet_loha", "training_images"],
    ["controlnet_loha", "conditioning_inputs"],
    ["controlnet_loha", "conditioning_config"],
  ]) {
    const item = fixture({ workflowType, omit: [missing] });
    try {
      const result = invoke(item);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.receipt.packet_complete, false);
      assert.deepEqual(output.receipt.packet_missing, [missing]);
      assert.equal(output.receipt.packet_requirements[missing], false);
      const registry = JSON.parse(fs.readFileSync(output.registry_path, "utf8"));
      assert.equal(registry.packets[output.receipt.sha256].quality_state, "incomplete_return_packet");
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }
});

test("rejects missing or unsupported verified workflow types before packet placement", () => {
  for (const workflowType of [null, "unsupported_workflow"]) {
    const item = fixture({ workflowType });
    try {
      const result = invoke(item);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing or unsupported training workflow type/);
      assert.equal(fs.existsSync(item.packet), true);
      assert.equal(fs.existsSync(path.join(item.destination, path.basename(item.packet))), false);
      assert.equal(fs.existsSync(path.join(item.destination, "packet-registry.json")), false);
      assert.equal(fs.existsSync(path.join(item.destination, "receipts")), false);
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }
});

test("removes only the verified staging copy under explicit standing authorization", () => {
  const item = fixture({ removeStaging: true });
  try {
    const result = invoke(item);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.receipt.staging_removed, true);
    assert.equal(fs.existsSync(item.packet), false);
    assert.equal(fs.existsSync(output.receipt.destination), true);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});

test("fails closed before placement or removal on identity, transfer, archive, or inventory failure", () => {
  for (const failure of ["size", "hash", "archive", "internal", "revision"]) {
    const item = fixture({ removeStaging: true });
    try {
      if (failure === "archive") fs.writeFileSync(item.packet, "not a zip");
      if (failure === "internal") {
        const replacement = path.join(item.temporary, "model.safetensors");
        fs.writeFileSync(replacement, "different weights");
        const updated = spawnSync("zip", ["-q", item.packet, "model.safetensors"], { cwd: item.temporary, encoding: "utf8" });
        assert.equal(updated.status, 0, updated.stderr);
      }
      if (failure === "revision") {
        const config = JSON.parse(fs.readFileSync(item.config, "utf8"));
        config.expected_revision_fingerprint = "b".repeat(64);
        fs.writeFileSync(item.config, JSON.stringify(config));
      }
      const result = invoke(item, failure === "size"
        ? { size: fs.statSync(item.packet).size + 1 }
        : failure === "hash" ? { hash: "0".repeat(64) } : {});
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(item.packet), true);
      assert.equal(fs.existsSync(path.join(item.destination, path.basename(item.packet))), false);
      assert.equal(fs.existsSync(path.join(item.destination, "packet-registry.json")), false);
      assert.equal(fs.existsSync(path.join(item.destination, "receipts")), false);
    } finally {
      fs.rmSync(item.temporary, { recursive: true, force: true });
    }
  }
});

test("rejects a linked destination root without writing outside it", () => {
  const item = fixture();
  const outside = path.join(item.temporary, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, item.destination);
  try {
    const result = invoke(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /destination root must be a non-symlink directory/);
    assert.equal(fs.existsSync(item.packet), true);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(item.temporary, { recursive: true, force: true });
  }
});
