#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sourceRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-packet-receiver-test-"));
const stateRoot = path.join(root, ".hawkspan");
const launchAgentsRoot = path.join(root, "Library", "LaunchAgents");
const staging = path.join(root, "staging");
const destination = path.join(root, "destination");
fs.mkdirSync(staging, { recursive: true });

const packet = path.join(
  staging,
  "artifact-1786104067045-8288ebcbb807-hawkspan-robot-100-r32__training__M4-return-packet.zip",
);
fs.writeFileSync(packet, "opaque transport fixture; contents must not be inspected\n");
const unrelatedPacket = path.join(staging, "unrelated-artifact.zip");
fs.writeFileSync(unrelatedPacket, "must remain outside packet intake\n");
const historicalReturnPacket = path.join(staging, "historical-return-packet.zip");
fs.writeFileSync(historicalReturnPacket, "must not be admitted without automatic-return metadata\n");
const packetStat = fs.statSync(packet);
const packetSha256 = crypto.createHash("sha256").update(fs.readFileSync(packet)).digest("hex");
fs.writeFileSync(
  path.join(staging, "artifact-1786104067045-8288ebcbb807.artifact.json"),
  `${JSON.stringify({
    schema_version: 1,
    artifact_id: "artifact-1786104067045-8288ebcbb807",
    file_name: path.basename(packet),
    size_bytes: packetStat.size,
    sha256: packetSha256,
    metadata: {
      kind: "lora-return-packet",
      automatic_return: true,
      automatic_return_job_id: "hawkspan-robot-100-r32",
      durable_job_id: "job-r32",
      simpletuner_queue_item_id: "queue-r32",
    },
  }, null, 2)}\n`,
);
const notice = path.join(staging, "synthetic-notice.md");
const registry = path.join(staging, "lora-registry.json");
fs.writeFileSync(notice, "Synthetic packet notice.\n");
fs.writeFileSync(registry, `${JSON.stringify({
  schema_version: 1,
  revisions: Object.fromEntries(
    Array.from({ length: 34 }, (_, index) => {
      const jobId = `cap-test-${index + 1}`;
      return [jobId, { job_id: jobId }];
    }),
  ),
})}\n`);

fs.mkdirSync(stateRoot, { recursive: true });
const configPath = path.join(stateRoot, "config.json");
fs.writeFileSync(configPath, `${JSON.stringify({
  packet_receiver: {
    staging_root: staging,
    destination_root: destination,
    allow_remove_verified_staging: false,
    return_packets_only: true,
    require_automatic_return_metadata: true,
    authorization_evidence: "Synthetic test authorization.",
  },
})}\n`);
const activation = spawnSync(process.execPath, [
  path.join(sourceRoot, "scripts", "activate-release.mjs"),
  "--release-root", sourceRoot,
  "--revision", "packet-receiver-test",
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: root,
    HAWKSPAN_CONFIG: configPath,
    HAWKSPAN_STATE_DIR: stateRoot,
    HAWKSPAN_LAUNCH_AGENTS_DIR: launchAgentsRoot,
  },
});
assert.equal(activation.status, 0, activation.stderr);

const receiver = spawnSync(process.execPath, [
  path.join(path.dirname(new URL(import.meta.url).pathname), "m2-packet-receiver.mjs"),
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: root,
    HAWKSPAN_CONFIG: configPath,
    HAWKSPAN_STATE_DIR: stateRoot,
    HAWKSPAN_LAUNCH_AGENTS_DIR: launchAgentsRoot,
  },
  timeout: 120000,
});
assert.equal(receiver.status, 0, receiver.stderr);

const securedPacket = path.join(destination, path.basename(packet));
const receiptPath = path.join(
  destination,
  "Transfer Receipts",
  `${path.basename(packet)}.receipt.json`,
);
assert(fs.existsSync(securedPacket));
assert(fs.existsSync(receiptPath));
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
assert.equal(receipt.transport_verified, true);
assert.equal(receipt.package_contents_inspected, false);
assert.equal(receipt.staging_removed, false);
assert.equal(Object.hasOwn(receipt, "packet_missing"), false);
assert.equal(Object.hasOwn(receipt, "packet_complete"), false);
assert.equal(
  receipt.sha256,
  crypto.createHash("sha256").update(fs.readFileSync(securedPacket)).digest("hex"),
);
assert(fs.existsSync(packet));
assert(fs.existsSync(unrelatedPacket));
assert(fs.existsSync(historicalReturnPacket));
const packetRegistry = JSON.parse(
  fs.readFileSync(path.join(destination, "packet-registry.json"), "utf8"),
);
assert.equal(
  packetRegistry.packets[receipt.sha256].job_id,
  "hawkspan-robot-100-r32",
);
assert.equal(receipt.artifact_id, "artifact-1786104067045-8288ebcbb807");
assert.equal(receipt.durable_job_id, "job-r32");
const firstReceiptBody = fs.readFileSync(receiptPath, "utf8");
const secondReceiver = spawnSync(process.execPath, [
  path.join(path.dirname(new URL(import.meta.url).pathname), "m2-packet-receiver.mjs"),
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: root,
    HAWKSPAN_CONFIG: configPath,
    HAWKSPAN_STATE_DIR: stateRoot,
    HAWKSPAN_LAUNCH_AGENTS_DIR: launchAgentsRoot,
  },
  timeout: 120000,
});
assert.equal(secondReceiver.status, 0, secondReceiver.stderr);
assert.match(secondReceiver.stdout, /already secured/);
assert.equal(fs.readFileSync(receiptPath, "utf8"), firstReceiptBody);
assert.equal(
  fs.readFileSync(path.join(destination, "Automation Metadata", path.basename(notice)), "utf8"),
  "Synthetic packet notice.\n",
);
assert(fs.existsSync(
  path.join(destination, "Automation Metadata", path.basename(registry)),
));
assert(fs.existsSync(notice));
assert(fs.existsSync(registry));

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("M2 packet receiver test passed\n");
