#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-test-"));
const sample = path.join(testRoot, "sample.txt");
fs.writeFileSync(sample, "hawkspan regression artifact\n");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(testRoot, "plugins");
fs.mkdirSync(pluginRoot);
fs.cpSync(
  path.join(repositoryRoot, "examples", "plugins", "application-workflows"),
  path.join(pluginRoot, "application-workflows"),
  { recursive: true },
);
const configuration = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "config", "example.json"), "utf8"));
configuration.local_control.enabled = false;
configuration.application_plugins.roots = [pluginRoot];
configuration.application_plugins.entries = { "application-workflows": { enabled: false } };
fs.writeFileSync(path.join(testRoot, "config.json"), `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });

const serverPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "mcp-server.mjs",
);
const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, HAWKSPAN_STATE_DIR: testRoot },
  stdio: ["pipe", "pipe", "inherit"],
});

let sequence = 0;
let buffer = "";
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) {
      pending.delete(response.id);
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    }
  }
});

function request(method, params = {}) {
  const requestId = ++sequence;
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method,
    params,
  })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error(`timeout: ${method}`));
    }, 10000);
    pending.set(requestId, { resolve, reject, timer });
  });
}

async function tool(name, args = {}) {
  const response = await request("tools/call", { name, arguments: args });
  assert.equal(response.result?.isError, false, JSON.stringify(response));
  return response.result.structuredContent;
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hawkspan-test", version: "1" },
  });
  assert.equal(initialized.result.serverInfo.name, "hawkspan");

  const listed = await request("tools/list");
  const names = new Set(listed.result.tools.map((entry) => entry.name));
  for (const required of [
    "link_status", "run_command", "peer_call_tool", "send_message",
    "retry_message", "wake_peer_thread", "receive_messages", "list_messages",
    "acknowledge_message", "create_job", "update_job_status", "list_jobs",
    "register_artifact", "verify_artifact", "send_artifact", "list_artifacts",
    "receive_artifacts", "flush_outbox", "list_audit_events",
  ]) {
    assert.equal(names.has(required), true, `missing tool ${required}`);
  }
  assert.equal([...names].some((name) => name.startsWith("trainer_")), false);
  const applicationPluginStatus = await tool("application_plugin_status");
  assert.equal(
    applicationPluginStatus.rejected.some(({ candidate }) => candidate === "application-workflows"),
    false,
    JSON.stringify(applicationPluginStatus.rejected),
  );

  const message = await tool("send_message", {
    recipient: "peer-test",
    subject: "regression",
    body: "durable test message",
    deliver: false,
    wake: false,
  });
  assert.match(message.message_id, /^msg-/);

  const messages = await tool("list_messages", { direction: "outbound" });
  assert.equal(messages.find((entry) => entry.id === message.message_id)?.state, "queued");

  const inboundId = "msg-public-inbound-fixture";
  fs.writeFileSync(path.join(testRoot, "inbox", `${inboundId}.json`), `${JSON.stringify({
    schema_version: 1,
    id: inboundId,
    created_at: "2026-01-01T00:00:00.000Z",
    sender: "fixture-peer",
    recipient: "fixture-local",
    kind: "message",
    subject: "Public fixture",
    body: "Public acceptance fixture",
  }, null, 2)}\n`);
  const received = await tool("receive_messages");
  assert.equal(received.messages.some((entry) => entry.id === inboundId), true);
  const acknowledged = await tool("acknowledge_message", {
    message_id: inboundId,
    deliver: false,
  });
  const acknowledgementEnvelope = JSON.parse(fs.readFileSync(acknowledged.envelope_path, "utf8"));
  assert.equal(acknowledgementEnvelope.kind, "acknowledgement");
  assert.equal(acknowledgementEnvelope.correlation_id, inboundId);
  assert.equal(
    (await tool("list_messages", { direction: "inbound" }))
      .find((entry) => entry.id === inboundId)?.state,
    "acknowledged",
  );

  fs.writeFileSync(path.join(testRoot, "inbox", "ack-public-fixture.json"), `${JSON.stringify({
    schema_version: 1,
    id: "ack-public-fixture",
    created_at: "2026-01-01T00:00:01.000Z",
    sender: "fixture-peer",
    recipient: "fixture-local",
    kind: "acknowledgement",
    subject: "Public acknowledgement fixture",
    body: "Acknowledged",
    correlation_id: message.message_id,
  }, null, 2)}\n`);
  await tool("receive_messages", { include_acknowledged: true });
  assert.equal(
    (await tool("list_messages", { direction: "outbound" }))
      .find((entry) => entry.id === message.message_id)?.state,
    "acknowledged",
  );

  const job = await tool("create_job", {
    kind: "test",
    title: "Regression job",
    requires_authorization: true,
  });
  await tool("update_job_status", {
    job_id: job.job_id,
    state: "authorized",
    authorization_evidence: "synthetic regression authorization",
  });
  const jobs = await tool("list_jobs", {});
  assert.equal(jobs.some((entry) => entry.id === job.job_id), true);

  const artifact = await tool("register_artifact", { path: sample });
  const verified = await tool("verify_artifact", {
    artifact_id: artifact.artifact_id,
    expected_sha256: artifact.sha256,
  });
  assert.equal(verified.matches, true);

  const receivedArtifactId = "artifact-public-received-fixture";
  const receivedArtifactName = "artifact-public-received-fixture.txt";
  const receivedArtifactPath = path.join(testRoot, "artifacts", receivedArtifactName);
  fs.writeFileSync(receivedArtifactPath, "hawkspan received artifact fixture\n");
  const receivedArtifactDigest = (await import("node:crypto"))
    .createHash("sha256")
    .update(fs.readFileSync(receivedArtifactPath))
    .digest("hex");
  fs.writeFileSync(path.join(testRoot, "artifacts", `${receivedArtifactName}.artifact.json`), `${JSON.stringify({
    schema_version: 1,
    artifact_id: receivedArtifactId,
    owner: "fixture-peer",
    name: receivedArtifactName,
    file_name: receivedArtifactName,
    size_bytes: fs.statSync(receivedArtifactPath).size,
    sha256: receivedArtifactDigest,
  }, null, 2)}\n`);
  const importedArtifacts = await tool("receive_artifacts");
  assert.equal(
    importedArtifacts.artifacts.find((entry) => entry.artifact_id === receivedArtifactId)?.verified,
    true,
  );

  const command = await tool("run_command", {
    command: "printf hawkspan",
    cwd: testRoot,
  });
  assert.equal(command.ok, true);
  assert.equal(command.stdout, "hawkspan");

  const audit = await tool("list_audit_events", { limit: 100 });
  assert.equal(audit.some((entry) => entry.object_type === "command"), true);
  process.stdout.write("hawkspan MCP regression tests passed\n");
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(testRoot, { recursive: true, force: true });
}
