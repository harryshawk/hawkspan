#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkgrokspan-exchange-"));
const bin = path.join(root, "bin");
fs.mkdirSync(bin);

fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
for argument do command=$argument; done
case "$command" in
  "mkdir -p "*|"if command -v shasum"*) exec /bin/sh -c "$command" ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "rsync"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\n' '--partial --append-verify'
  exit 0
fi
previous=
for argument do
  source=$previous
  target=$argument
  previous=$argument
done
destination=\${target#*:}
case "$destination" in
  */) mkdir -p "$destination"; cp "$source" "$destination/" ;;
  *) mkdir -p "$(dirname "$destination")"; cp "$source" "$destination" ;;
esac
`, { mode: 0o755 });

function makeNode(name, peerName) {
  const state = path.join(root, name);
  const exchange = path.join(state, "exchange");
  const identity = path.join(state, "id_ed25519");
  const knownHosts = path.join(state, "known_hosts");
  for (const directory of [state, exchange, path.join(state, "inbox"), path.join(state, "artifacts"), path.join(state, "audit")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(identity, "test key\n", { mode: 0o600 });
  fs.writeFileSync(knownHosts, `${peerName} ssh-ed25519 TEST\n`, { mode: 0o600 });
  return { name, state, exchange, identity, knownHosts };
}

const m2 = makeNode("m2-hawkgrokspan", "grok-vm");
const grok = makeNode("grok-vm", "m2-hawkgrokspan");

function writeConfig(node, peer) {
  const configPath = path.join(node.state, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    schema_version: 1,
    node_id: node.name,
    surface_profile: "message-files",
    application_plugins: { enabled: false },
    local_control: { enabled: false },
    transfer: { allowed_artifact_roots: [node.exchange] },
    queue_supervisor: { enabled: false },
    peer: {
      node_id: peer.name,
      user: "testuser",
      allow_remote_wake: false,
      primary_enabled: true,
      primary_host: peer.name,
      fallback_enabled: false,
      ssh_identity: node.identity,
      known_hosts: node.knownHosts,
      remote_state_dir: peer.state,
      remote_inbox: path.join(peer.state, "inbox"),
      remote_artifacts: path.join(peer.state, "artifacts"),
      remote_audit: path.join(peer.state, "audit"),
    },
    features: {
      allowed_peer_tools: { inbound: [], outbound: [] },
      allow_peer_commands: false,
      enable_broad_run_command: false,
    },
    training: { allow_start: false, allow_stop: false, allow_package: false },
    link: {
      operation_retry_delays_ms: [100],
      operation_attempt_timeout_ms: 2000,
      connect_timeout_ms: 1000,
      cycle_timeout_ms: 5000,
      server_alive_interval_seconds: 1,
      server_alive_count_max: 1,
      primary_reprobe_ms: 1000,
    },
  }, null, 2)}\n`);
  return configPath;
}

function startNode(node, peer) {
  const configPath = writeConfig(node, peer);
  const child = spawn(process.execPath, [path.join(scripts, "mcp-server.mjs")], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HAWKSPAN_STATE_DIR: node.state,
      HAWKSPAN_CONFIG: configPath,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let id = 0;
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
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${node.name} timeout waiting for ${method}`));
    }, 10000);
    pending.set(requestId, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  return { child, request };
}

const m2Server = startNode(m2, grok);
const grokServer = startNode(grok, m2);
await Promise.all([
  m2Server.request("initialize", { protocolVersion: "2025-06-18" }),
  grokServer.request("initialize", { protocolVersion: "2025-06-18" }),
]);
const tool = (server, name, argumentsValue = {}) =>
  server.request("tools/call", { name, arguments: argumentsValue });

const sent = await tool(m2Server, "send_message", {
  subject: "HawkGrokSpan exchange",
  body: "M2 to Grok VM durable envelope",
  wake: false,
});
assert.equal(sent.result.isError, false, sent.result.content?.[0]?.text);
assert.equal(sent.result.structuredContent.delivery.ok, true);
const received = await tool(grokServer, "receive_messages", {});
assert.equal(received.result.structuredContent.imported, 1);
assert.equal(received.result.structuredContent.messages[0].subject, "HawkGrokSpan exchange");
const messageId = received.result.structuredContent.messages[0].id;

const acknowledged = await tool(grokServer, "acknowledge_message", {
  message_id: messageId,
  note: "Grok VM received the durable message",
});
assert.equal(acknowledged.result.isError, false, acknowledged.result.content?.[0]?.text);
const m2Messages = await tool(m2Server, "list_messages", { direction: "outbound" });
assert.equal(m2Messages.result.structuredContent[0].state, "acknowledged");

const artifactPath = path.join(m2.exchange, "handoff.txt");
fs.writeFileSync(artifactPath, "verified HawkGrokSpan file\n");
const registration = await tool(m2Server, "register_artifact", { path: artifactPath });
assert.equal(registration.result.isError, false, registration.result.content?.[0]?.text);
const artifactId = registration.result.structuredContent.artifact_id;
const delivery = await tool(m2Server, "send_artifact", { artifact_id: artifactId });
assert.equal(
  delivery.result.structuredContent.delivery.verified,
  true,
  JSON.stringify(delivery.result.structuredContent.delivery, null, 2),
);
const imported = await tool(grokServer, "receive_artifacts", {});
assert.equal(imported.result.structuredContent.artifacts.length, 1);
assert.equal(imported.result.structuredContent.artifacts[0].artifact_id, artifactId);
assert.equal(imported.result.structuredContent.artifacts[0].verified, true);
assert.equal(
  fs.readFileSync(imported.result.structuredContent.artifacts[0].path, "utf8"),
  "verified HawkGrokSpan file\n",
);

for (const server of [m2Server, grokServer]) server.child.stdin.end();
await Promise.all([
  new Promise((resolve) => m2Server.child.once("exit", resolve)),
  new Promise((resolve) => grokServer.child.once("exit", resolve)),
]);
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("HawkGrokSpan bidirectional acknowledgement and verified-file exchange tests passed\n");
