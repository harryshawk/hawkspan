#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkgrokspan-boundary-"));
const allowed = path.join(root, "exchange");
const outside = path.join(root, "private");
const bin = path.join(root, "bin");
const identity = path.join(root, "hawkgrokspan_ed25519");
const knownHosts = path.join(root, "known_hosts");
const transportLog = path.join(root, "transport.log");
const configPath = path.join(root, "config.json");
fs.mkdirSync(allowed);
fs.mkdirSync(outside);
fs.mkdirSync(bin);
fs.writeFileSync(identity, "test-only-private-key\n", { mode: 0o600 });
fs.writeFileSync(knownHosts, "grok-vm ssh-ed25519 TEST\n", { mode: 0o600 });
fs.writeFileSync(path.join(allowed, "allowed.txt"), "allowed artifact\n");
fs.writeFileSync(path.join(outside, "private.txt"), "must not transfer\n");
fs.symlinkSync(path.join(outside, "private.txt"), path.join(allowed, "escape.txt"));

const config = {
  schema_version: 1,
  node_id: "m2-hawkgrokspan",
  surface_profile: "message-files",
  application_plugins: { enabled: false },
  local_control: { enabled: false },
  transfer: { allowed_artifact_roots: [allowed] },
  queue_supervisor: { enabled: false },
  peer: {
    node_id: "grok-vm",
    user: "grok",
    allow_remote_wake: false,
    primary_enabled: true,
    primary_host: "192.0.2.40",
    fallback_enabled: false,
    ssh_identity: identity,
    known_hosts: knownHosts,
    remote_inbox: "/home/grok/.hawkgrokspan/inbox",
    remote_artifacts: "/home/grok/.hawkgrokspan/artifacts",
    remote_audit: "/home/grok/.hawkgrokspan/audit",
  },
  link: {
    operation_retry_delays_ms: [100],
    operation_attempt_timeout_ms: 1000,
    connect_timeout_ms: 1000,
    cycle_timeout_ms: 3000,
    server_alive_interval_seconds: 1,
    server_alive_count_max: 1,
    primary_reprobe_ms: 1000,
  },
};
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf 'ssh %s\n' "$*" >> "$HAWKSPAN_TEST_TRANSPORT_LOG"
exit 0
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "rsync"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\n' '--partial --append-verify'
  exit 0
fi
printf 'rsync %s\n' "$*" >> "$HAWKSPAN_TEST_TRANSPORT_LOG"
exit 0
`, { mode: 0o755 });

const server = spawn(process.execPath, [path.join(scripts, "mcp-server.mjs")], {
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HAWKSPAN_STATE_DIR: root,
    HAWKSPAN_CONFIG: configPath,
    HAWKSPAN_TEST_TRANSPORT_LOG: transportLog,
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let sequence = 0;
let buffer = "";
const pending = new Map();
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  }
});

function request(method, params = {}) {
  const id = ++sequence;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 5000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

const initialized = await request("initialize", { protocolVersion: "2025-06-18" });
assert.equal(initialized.result.serverInfo.name, "hawkgrokspan");
const listed = await request("tools/list");
assert.deepEqual(
  listed.result.tools.map(({ name }) => name).sort(),
  [
    "acknowledge_message", "flush_outbox", "link_status", "list_artifacts",
    "list_messages", "queue_artifact_delivery", "receive_artifacts",
    "receive_messages", "register_artifact", "retry_message", "send_artifact",
    "send_message", "verify_artifact",
  ],
);

const deniedCommand = await request("tools/call", {
  name: "run_command",
  arguments: { command: "touch should-never-run" },
});
assert.equal(deniedCommand.error.code, -32602);
assert.match(deniedCommand.error.message, /unknown tool: run_command/);

const deniedPeerCall = await request("tools/call", {
  name: "peer_call_tool",
  arguments: { tool_name: "run_command", arguments: { command: "true" } },
});
assert.equal(deniedPeerCall.error.code, -32602);

const registered = await request("tools/call", {
  name: "register_artifact",
  arguments: { path: path.join(allowed, "allowed.txt") },
});
assert.equal(registered.result.isError, false, registered.result.content?.[0]?.text);

for (const candidate of [path.join(outside, "private.txt"), path.join(allowed, "escape.txt")]) {
  const denied = await request("tools/call", {
    name: "register_artifact",
    arguments: { path: candidate },
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /outside transfer\.allowed_artifact_roots/);
}

const sent = await request("tools/call", {
  name: "send_message",
  arguments: { subject: "boundary", body: "strict transport", wake: false },
});
assert.equal(sent.result.isError, false, sent.result.content?.[0]?.text);
assert.equal(sent.result.structuredContent.delivery.ok, true);

const unusualName = path.join(allowed, "name;with shell.txt");
fs.writeFileSync(unusualName, "safe filename handling\n");
const unusualRegistration = await request("tools/call", {
  name: "register_artifact",
  arguments: { path: unusualName },
});
const unusualDelivery = await request("tools/call", {
  name: "send_artifact",
  arguments: { artifact_id: unusualRegistration.result.structuredContent.artifact_id },
});
assert.equal(unusualDelivery.result.isError, false);

fs.writeFileSync(path.join(root, "artifacts", "traversal.artifact.json"), JSON.stringify({
  artifact_id: "artifact-traversal",
  file_name: "../../private/private.txt",
  size_bytes: 18,
  sha256: "0".repeat(64),
}));
const rejectedManifest = await request("tools/call", {
  name: "receive_artifacts",
  arguments: {},
});
assert.equal(rejectedManifest.result.isError, false);
assert.match(rejectedManifest.result.structuredContent.artifacts[0].error, /file_name is invalid/);

const transport = fs.readFileSync(transportLog, "utf8");
for (const expected of [
  `-i ${identity}`,
  "-o IdentitiesOnly=yes",
  "-o StrictHostKeyChecking=yes",
  `-o UserKnownHostsFile=${knownHosts}`,
  "-o GlobalKnownHostsFile=/dev/null",
]) assert.match(transport, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(transport, /name_with_shell\.txt/);
assert.doesNotMatch(transport, /\.hawkgrokspan\/artifacts\/[^\n]*name;with shell\.txt/);

server.stdin.end();
await new Promise((resolve) => server.once("exit", resolve));

for (const mutation of [
  (value) => { value.application_plugins.enabled = true; },
  (value) => { delete value.peer.known_hosts; },
  (value) => { value.peer.allow_remote_wake = true; },
  (value) => { value.transfer.allowed_artifact_roots = [outside, "relative"]; },
]) {
  const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkgrokspan-invalid-"));
  const invalidConfig = structuredClone(config);
  mutation(invalidConfig);
  const invalidPath = path.join(invalidRoot, "config.json");
  fs.writeFileSync(invalidPath, JSON.stringify(invalidConfig));
  const result = spawnSync(process.execPath, [path.join(scripts, "mcp-server.mjs")], {
    env: { ...process.env, HAWKSPAN_STATE_DIR: invalidRoot, HAWKSPAN_CONFIG: invalidPath },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.notEqual(result.status, 0, "invalid HawkGrokSpan configuration must fail startup");
  fs.rmSync(invalidRoot, { recursive: true, force: true });
}

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("HawkGrokSpan messages/files boundary tests passed\n");
