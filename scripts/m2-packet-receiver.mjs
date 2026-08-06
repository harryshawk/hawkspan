#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const configPath = process.env.HAWKSPAN_CONFIG ||
  path.join(process.env.HOME, ".hawkspan", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const receiver = config.packet_receiver || {};
const stagingRoot = path.resolve(
  receiver.staging_root || path.join(process.env.HOME, "M4-LoRA-Incoming"),
);
const destinationRoot = receiver.destination_root
  ? path.resolve(receiver.destination_root)
  : null;
const lockDirectory = path.join(path.dirname(configPath), "packet-receiver.lock");

function acquireLock() {
  try {
    fs.mkdirSync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pidPath = path.join(lockDirectory, "pid");
    const pid = Number(fs.existsSync(pidPath) ? fs.readFileSync(pidPath, "utf8") : 0);
    try {
      if (pid > 0) process.kill(pid, 0);
      return false;
    } catch {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
    }
  }
  fs.writeFileSync(path.join(lockDirectory, "pid"), `${process.pid}\n`, { mode: 0o600 });
  return true;
}

if (!acquireLock()) {
  process.stdout.write(`${new Date().toISOString()} receiver already active\n`);
  process.exit(0);
}
for (const signal of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    } catch {}
    if (signal !== "exit") process.exit(0);
  });
}
const callTool = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "call-tool.mjs",
);

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function fail(message) {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
  process.exitCode = 1;
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

function updatePacketRegistry(receipt) {
  const registryPath = path.join(destinationRoot, "packet-registry.json");
  const registry = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, "utf8"))
    : { schema_version: 1, packets: {} };
  const packetName = path.basename(receipt.destination);
  const jobId = packetName.match(/^(cap-[^_]+)__/)?.[1] || null;
  registry.updated_at = new Date().toISOString();
  registry.packets[receipt.sha256] = {
    job_id: jobId,
    packet_name: packetName,
    packet_path: receipt.destination,
    receipt_path: path.join(
      destinationRoot,
      "Transfer Receipts",
      `${packetName}.receipt.json`,
    ),
    size_bytes: receipt.size_bytes,
    sha256: receipt.sha256,
    transport_verified: receipt.transport_verified,
    received_at: receipt.received_at,
    staging_removed: receipt.staging_removed,
    receipt_message_id: receipt.receipt_message_id || null,
    validation_state: "not_started",
    quality_state: "awaiting_validation",
  };
  atomicJson(registryPath, registry);
  refreshProvenanceRegistry();
  return registryPath;
}

function refreshProvenanceRegistry() {
  const sourcePath = path.join(
    destinationRoot,
    "Automation Metadata",
    "lora-registry.json",
  );
  if (!fs.existsSync(sourcePath)) return null;
  const registry = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const revisions = registry.revisions || {};
  const packetRegistryPath = path.join(destinationRoot, "packet-registry.json");
  const packetRegistry = fs.existsSync(packetRegistryPath)
    ? JSON.parse(fs.readFileSync(packetRegistryPath, "utf8"))
    : { packets: {} };
  for (const revision of Object.values(revisions)) {
    revision.secured_packets = Object.values(packetRegistry.packets || {})
      .filter((packet) => packet.job_id === revision.job_id)
      .map((packet) => ({
        packet_name: packet.packet_name,
        packet_path: packet.packet_path,
        receipt_path: packet.receipt_path,
        size_bytes: packet.size_bytes,
        sha256: packet.sha256,
        quality_state: packet.quality_state,
        validation_state: packet.validation_state,
      }));
  }
  registry.m2_updated_at = new Date().toISOString();
  registry.m2_packet_registry = packetRegistryPath;
  const destination = path.join(destinationRoot, "lora-provenance-registry.json");
  atomicJson(destination, registry);
  return destination;
}

function sendReceipt(receiptPath, receipt) {
  const args = {
    recipient: "m4-codex",
    kind: "artifact-receipt",
    subject: `configured artifact destination receipt verified: ${path.basename(receipt.destination)}`,
    body: [
      `${path.basename(receipt.destination)} is secured on configured artifact destination.`,
      `Size ${receipt.size_bytes} bytes; SHA-256 ${receipt.sha256}; transport verification passed.`,
      `Receipt: ${receiptPath}.`,
      "Package contents were not opened or audited by transport.",
      "The M2 staging copy may be removed under the owner's recorded authorization.",
      "No M4 source deletion is authorized by this receipt.",
    ].join(" "),
    correlation_id: receipt.sha256,
    metadata: {
      packet: path.basename(receipt.destination),
      destination: receipt.destination,
      receipt: receiptPath,
      size_bytes: receipt.size_bytes,
      sha256: receipt.sha256,
      transport_verified: receipt.transport_verified,
      expansion_secured: true,
      m4_source_deletion_authorized: false,
    },
    deliver: true,
    wake: true,
  };
  const result = spawnSync(process.execPath, [
    callTool,
    "send_message",
    JSON.stringify(args),
  ], {
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      result.stderr?.trim() || result.error?.message || "durable receipt delivery failed",
    );
  }
  const response = JSON.parse(result.stdout);
  if (response.isError) {
    throw new Error(response.content?.[0]?.text || "durable receipt delivery failed");
  }
  return response.structuredContent?.message_id || null;
}

const destinationParts = destinationRoot ? path.resolve(destinationRoot).split(path.sep) : [];
const destinationVolumeRoot = destinationParts[1] === "Volumes" && destinationParts[2]
  ? path.join(path.sep, destinationParts[1], destinationParts[2])
  : null;

if (!destinationRoot) {
  fail("packet_receiver.destination_root is not configured");
} else if (destinationVolumeRoot && !fs.existsSync(destinationVolumeRoot)) {
  fail(`configured artifact destination is not mounted: ${destinationVolumeRoot}`);
} else {
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(destinationRoot, { recursive: true });
  const receiptRoot = path.join(destinationRoot, "Transfer Receipts");
  fs.mkdirSync(receiptRoot, { recursive: true });
  const packets = fs.readdirSync(stagingRoot)
    .filter((name) => name.toLowerCase().endsWith(".zip") && !name.startsWith("._"))
    .sort();

  for (const name of packets) {
    const source = path.join(stagingRoot, name);
    const sourceStat = fs.statSync(source);
    const sourceSha256 = sha256(source);
    const destination = path.join(destinationRoot, name);
    const temporary = `${destination}.partial`;
    if (!fs.existsSync(destination) || sha256(destination) !== sourceSha256) {
      let copiedStat = fs.existsSync(temporary) ? fs.statSync(temporary) : null;
      let copiedSha256 = copiedStat?.size === sourceStat.size
        ? sha256(temporary)
        : null;
      if (copiedSha256 !== sourceSha256) {
        const transfer = spawnSync(
          "rsync",
          ["-a", "--partial", "--inplace", source, temporary],
          {
          encoding: "utf8",
          timeout: 24 * 60 * 60 * 1000,
          },
        );
        if (transfer.status !== 0) {
          fail(`rsync failed for ${name}: ${transfer.stderr?.trim() || "unknown error"}`);
          continue;
        }
        copiedStat = fs.statSync(temporary);
        copiedSha256 = sha256(temporary);
      }
      if (copiedStat.size !== sourceStat.size || copiedSha256 !== sourceSha256) {
        fail(`copy verification failed; retained staging file: ${source}`);
        continue;
      }
      fs.renameSync(temporary, destination);
    }

    const destinationStat = fs.statSync(destination);
    const receipt = {
      schema_version: 1,
      received_at: new Date().toISOString(),
      source,
      destination,
      size_bytes: sourceStat.size,
      sha256: sourceSha256,
      transport_verified: true,
      package_contents_inspected: false,
      staging_removed: false,
      authorization_evidence: receiver.authorization_evidence || null,
    };
    const receiptPath = path.join(receiptRoot, `${name}.receipt.json`);
    atomicJson(receiptPath, receipt);
    if (receiver.send_durable_receipt !== false) {
      try {
        receipt.receipt_message_id = sendReceipt(receiptPath, receipt);
        atomicJson(receiptPath, receipt);
      } catch (error) {
        fail(`durable receipt failed; retained staging file: ${source}: ${error.message}`);
        continue;
      }
    }
    if (receiver.allow_remove_verified_staging === true &&
        receiver.authorization_evidence?.trim()) {
      fs.unlinkSync(source);
      receipt.staging_removed = true;
      atomicJson(receiptPath, receipt);
    }
    updatePacketRegistry(receipt);
    process.stdout.write(`${new Date().toISOString()} secured ${name} ${sourceSha256}\n`);
  }

  const metadataRoot = path.join(destinationRoot, "Automation Metadata");
  try {
    fs.mkdirSync(metadataRoot, { recursive: true });
  } catch (error) {
    fail(`unable to create metadata destination; staging remains intact: ${error.message}`);
    process.exit();
  }
  const sidecars = fs.readdirSync(stagingRoot)
    .filter((name) =>
      !name.startsWith("._") &&
      (name.toLowerCase().endsWith(".json") || name.toLowerCase().endsWith(".md")))
    .sort();
  for (const name of sidecars) {
    const source = path.join(stagingRoot, name);
    const sourceStat = fs.statSync(source);
    const sourceSha256 = sha256(source);
    const destination = path.join(metadataRoot, name);
    const temporary = `${destination}.partial`;
    const transfer = spawnSync("rsync", ["-a", "--partial", source, temporary], {
      encoding: "utf8",
      timeout: 60 * 60 * 1000,
    });
    if (transfer.status !== 0) {
      fail(`metadata rsync failed for ${name}: ${transfer.stderr?.trim() || "unknown error"}`);
      continue;
    }
    const copiedStat = fs.statSync(temporary);
    const copiedSha256 = sha256(temporary);
    if (copiedStat.size !== sourceStat.size || copiedSha256 !== sourceSha256) {
      fail(`metadata verification failed; retained staging file: ${source}`);
      continue;
    }
    fs.renameSync(temporary, destination);
    if (name === "lora-registry.json") {
      const registry = JSON.parse(fs.readFileSync(destination, "utf8"));
      if (Object.keys(registry.revisions || {}).length !== 34) {
        fail(`LoRA registry snapshot is incomplete; retained staging file: ${source}`);
        continue;
      }
      refreshProvenanceRegistry();
    }
    if (receiver.allow_remove_verified_staging === true &&
        receiver.authorization_evidence?.trim()) {
      fs.unlinkSync(source);
    }
    process.stdout.write(
      `${new Date().toISOString()} secured metadata ${name} ${sourceSha256}\n`,
    );
  }
}
