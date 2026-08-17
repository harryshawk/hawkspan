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
const tailscaleCommand = path.join(bin, "tailscale");
const writableProxyCommand = path.join(bin, "writable-proxy");
const symlinkProxyCommand = path.join(bin, "symlink-proxy");
const transportLog = path.join(root, "transport.log");
const configPath = path.join(root, "config.json");
const tailscaleSocket = path.join(root, "tailscaled.sock");
const receiverWorkdir = path.join(root, "receiver", "primary");
const writableReceiverWorkdir = path.join(root, "receiver", "writable");
fs.mkdirSync(allowed);
fs.mkdirSync(outside);
fs.mkdirSync(bin);
fs.mkdirSync(receiverWorkdir, { recursive: true });
fs.mkdirSync(writableReceiverWorkdir, { recursive: true });
fs.chmodSync(writableReceiverWorkdir, 0o777);
fs.writeFileSync(identity, "test-only-private-key\n", { mode: 0o600 });
fs.writeFileSync(knownHosts, "grok-vm ssh-ed25519 TEST\n", { mode: 0o600 });
fs.writeFileSync(tailscaleCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
fs.writeFileSync(writableProxyCommand, "#!/bin/sh\nexit 0\n", { mode: 0o777 });
fs.chmodSync(writableProxyCommand, 0o777);
fs.symlinkSync(tailscaleCommand, symlinkProxyCommand);
fs.writeFileSync(path.join(allowed, "allowed.txt"), "allowed artifact\n");
fs.writeFileSync(path.join(outside, "private.txt"), "must not transfer\n");
fs.symlinkSync(path.join(outside, "private.txt"), path.join(allowed, "escape.txt"));

const config = {
  schema_version: 1,
  node_id: "m2-hawkgrokspan",
  surface_profile: "message-files",
  application_plugins: { enabled: false },
  local_control: { enabled: false },
  message_receiver: {
    enabled: true,
    start_on_mcp_server: true,
    reconcile_interval_seconds: 30,
    default_target: "m2-primary",
    targets: {
      "m2-primary": {
        adapter: "codex",
        command: tailscaleCommand,
        workdir: receiverWorkdir,
        session_id: "00000000-0000-0000-0000-000000000001",
        sandbox: "workspace-write",
        maximum_runtime_seconds: 60,
      },
    },
  },
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
    transport: {
      kind: "tailscale-nc",
      command: tailscaleCommand,
      socket: tailscaleSocket,
    },
    remote_state_dir: "/home/grok/.hawkgrokspan",
    remote_inbox: "/home/grok/.hawkgrokspan/inbox",
    remote_artifacts: "/home/grok/.hawkgrokspan/artifacts",
    remote_audit: "/home/grok/.hawkgrokspan/audit",
  },
  features: {
    allowed_peer_tools: { inbound: [], outbound: [] },
    allow_peer_commands: false,
    enable_broad_run_command: false,
  },
  training: { allow_start: false, allow_stop: false, allow_package: false },
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
const releaseRoot = path.resolve(scripts, "..");
fs.writeFileSync(path.join(root, "installed-revision.json"), `${JSON.stringify({
  schema_version: 2,
  revision: "a".repeat(40),
  active_release_root: releaseRoot,
  stable_release_root: releaseRoot,
}, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(root, "hawkspan.env"), [
  `HAWKSPAN_ACTIVE_RELEASE_ROOT=${releaseRoot}`,
  `HAWKSPAN_REPOSITORY_DIR=${releaseRoot}`,
  "",
].join("\n"), { mode: 0o600 });

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
assert.equal(initialized.result.serverInfo.version, "0.4.0");
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

const status = await request("tools/call", { name: "link_status", arguments: {} });
assert.equal(status.result.isError, false, status.result.content?.[0]?.text);
assert.equal(status.result.structuredContent.routes[0].ready, true);
assert.equal(status.result.structuredContent.routes[0].failed_layer, null);

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
  arguments: {
    subject: "boundary",
    body: "strict transport",
    target_bot_id: "grok-primary",
    wake: false,
  },
});
assert.equal(sent.result.isError, false, sent.result.content?.[0]?.text);
assert.equal(sent.result.structuredContent.delivery.ok, true);
const sentEnvelope = JSON.parse(fs.readFileSync(sent.result.structuredContent.envelope_path, "utf8"));
assert.equal(sentEnvelope.target_bot_id, "grok-primary");
assert.equal(sentEnvelope.metadata.target_bot_id, "grok-primary");
assert.equal(sentEnvelope.notify_receiver, true);
assert.equal(sentEnvelope.metadata.notify_receiver, true);
assert.equal(sent.result.structuredContent.wake?.mode, "delivery-triggered-local-receiver");
const retriedQuietMessage = await request("tools/call", {
  name: "retry_message",
  arguments: { message_id: sent.result.structuredContent.message_id, wake: false },
});
assert.equal(retriedQuietMessage.result.isError, false);
assert.equal(retriedQuietMessage.result.structuredContent.delivery.ok, true);
assert.equal(retriedQuietMessage.result.structuredContent.wake?.mode, "delivery-triggered-local-receiver");
const deniedReservedMetadata = await request("tools/call", {
  name: "send_message",
  arguments: {
    subject: "reserved metadata",
    body: "must fail",
    metadata: { target_bot_id: "grok-primary" },
  },
});
assert.equal(deniedReservedMetadata.result.isError, true);
assert.match(deniedReservedMetadata.result.content[0].text, /reserved envelope fields/);

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
  `-o ProxyCommand=${tailscaleCommand} --socket=${tailscaleSocket} nc %h %p`,
]) assert.match(transport, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(transport, /name_with_shell\.txt/);
assert.doesNotMatch(transport, /\.hawkgrokspan\/artifacts\/[^\n]*name;with shell\.txt/);

server.stdin.end();
await new Promise((resolve) => server.once("exit", resolve));

const supervisorLeaseRoot = path.join(root, "audit", "message-receiver-supervisor.lock");
const supervisorLeasePath = path.join(supervisorLeaseRoot, "lease.json");
assert.equal(fs.existsSync(supervisorLeasePath), true, "MCP startup must start the HGS reconciler");
const supervisorLease = JSON.parse(fs.readFileSync(supervisorLeasePath, "utf8"));
process.kill(Number(supervisorLease.pid), "SIGTERM");
const supervisorDeadline = Date.now() + 5000;
while (fs.existsSync(supervisorLeaseRoot) && Date.now() < supervisorDeadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
assert.equal(fs.existsSync(supervisorLeaseRoot), false, "HGS reconciler must clean its lease on stop");

// A receiver-bound MCP process cannot read or acknowledge another bot's message.
const inboxDefault = {
  schema_version: 1,
  id: "msg-bound-default",
  created_at: new Date().toISOString(),
  sender: "grok-vm",
  recipient: "m2-hawkgrokspan",
  kind: "message",
  subject: "default route",
  body: "for m2-primary",
  notify_receiver: false,
  metadata: { notify_receiver: false },
};
const inboxOther = {
  ...inboxDefault,
  id: "msg-bound-other",
  subject: "other route",
  body: "not for m2-primary",
  target_bot_id: "other-bot",
  metadata: { notify_receiver: false, target_bot_id: "other-bot" },
};
for (const envelope of [inboxDefault, inboxOther]) {
  fs.writeFileSync(path.join(root, "inbox", `${envelope.id}.json`), JSON.stringify(envelope));
}
const noStartupReceiverConfig = structuredClone(config);
noStartupReceiverConfig.message_receiver.start_on_mcp_server = false;
fs.writeFileSync(configPath, `${JSON.stringify(noStartupReceiverConfig, null, 2)}\n`);
const boundEnvironment = {
  ...process.env,
  HAWKSPAN_STATE_DIR: root,
  HAWKSPAN_CONFIG: configPath,
  HAWKGROKSPAN_TARGET_BOT_ID: "m2-primary",
};
const boundReceive = spawnSync(process.execPath, [
  path.join(scripts, "call-tool.mjs"),
  "receive_messages",
  JSON.stringify({ limit: 20 }),
], { encoding: "utf8", env: boundEnvironment, timeout: 10000 });
assert.equal(boundReceive.status, 0, boundReceive.stderr);
const boundReceiveResult = JSON.parse(boundReceive.stdout);
assert.deepEqual(
  boundReceiveResult.structuredContent.messages.map(({ id }) => id),
  ["msg-bound-default"],
);
const deniedCrossTargetAck = spawnSync(process.execPath, [
  path.join(scripts, "call-tool.mjs"),
  "acknowledge_message",
  JSON.stringify({ message_id: "msg-bound-other", reply: false }),
], { encoding: "utf8", env: boundEnvironment, timeout: 10000 });
assert.notEqual(deniedCrossTargetAck.status, 0);
assert.match(deniedCrossTargetAck.stderr, /cannot acknowledge another target_bot_id/);

for (const mutation of [
  (value) => { value.application_plugins.enabled = true; },
  (value) => { value.queue_supervisor.enabled = true; },
  (value) => { value.features.allowed_peer_tools.outbound = ["run_command"]; },
  (value) => { value.training.allow_start = true; },
  (value) => { delete value.peer.known_hosts; },
  (value) => { delete value.peer.transport.command; },
  (value) => { value.peer.transport.kind = "arbitrary-proxy"; },
  (value) => { value.peer.transport.command = writableProxyCommand; },
  (value) => { value.peer.transport.command = symlinkProxyCommand; },
  (value) => { value.peer.transport.socket = "relative.sock"; },
  (value) => { value.peer.allow_remote_wake = true; },
  (value) => { value.message_receiver.targets["m2-primary"].session_id = "friendly-name"; },
  (value) => { value.message_receiver.targets["m2-primary"].session_id = "00000000-0000-0000-0000-000000000000"; },
  (value) => {
    value.message_receiver.targets.duplicate = {
      ...value.message_receiver.targets["m2-primary"],
      workdir: path.join(root, "receiver", "duplicate"),
    };
    fs.mkdirSync(value.message_receiver.targets.duplicate.workdir, { recursive: true });
  },
  (value) => { value.message_receiver.targets["m2-primary"].sandbox = "danger-full-access"; },
  (value) => { value.message_receiver.targets["m2-primary"].command = writableProxyCommand; },
  (value) => { value.message_receiver.targets["m2-primary"].workdir = writableReceiverWorkdir; },
  (value) => { value.message_receiver.default_target = "missing"; },
  (value) => { value.peer.remote_artifacts = "/home/grok/elsewhere"; },
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
