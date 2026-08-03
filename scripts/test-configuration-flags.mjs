#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-flags-"));
const configPath = path.join(root, "config.json");
const mockBin = path.join(root, "mock-bin");
const sshLog = path.join(root, "ssh.log");
fs.mkdirSync(mockBin);
fs.writeFileSync(path.join(mockBin, "ssh"), `#!/bin/sh
printf '%s\n' "$*" >> "$HAWKSPAN_TEST_SSH_LOG"
case "$*" in *nohup*) exit 0;; *) exit 1;; esac
`, { mode: 0o700 });
fs.writeFileSync(configPath, `${JSON.stringify({
  schema_version: 1,
  node_id: "flags-test",
  unrelated: { preserved: "exactly" },
  local_control: { enabled: false },
  peer: {
    node_id: "fixture-peer",
    user: "fixture",
    primary_host: "127.0.0.1",
    remote_call_tool: "/fixture/call-tool.mjs",
    remote_artifacts: path.join(root, "remote-artifacts"),
    allow_remote_wake: true,
    thread_id: "fixture-thread",
    allowed_tools: ["wake_peer_thread"],
  },
}, null, 2)}\n`);

const server = spawn(process.execPath, [
  path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs"),
], {
  env: {
    ...process.env,
    HAWKSPAN_STATE_DIR: root,
    HAWKSPAN_CONFIG: configPath,
    HAWKSPAN_LOCAL_CONTROL_DISABLED: "1",
    HAWKSPAN_BACKGROUND: "1",
    HAWKSPAN_TEST_SSH_LOG: sshLog,
    PATH: `${mockBin}:${process.env.PATH}`,
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let id = 0;
let buffer = "";
const pending = new Map();
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const response = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  }
});

function request(method, params = {}) {
  const requestId = ++id;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout for ${method}`)), 10000);
    pending.set(requestId, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function call(name, args = {}, expectError = false) {
  const response = await request("tools/call", { name, arguments: args });
  assert.equal(response.result?.isError, expectError, JSON.stringify(response));
  return response.result;
}

function parseOneShotJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (originalError) {
    const lines = raw.split(/\r?\n/);
    const payloadLine = lines.findIndex((line) => /^[\t ]*[\[{]/.test(line));
    if (payloadLine <= 0) throw originalError;

    const diagnostics = lines.slice(0, payloadLine).filter((line) => line.trim());
    const warningLine = /^\(node:\d+\) [A-Za-z]+Warning:/;
    const warningHint = /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/;
    if (!diagnostics.every((line) => warningLine.test(line) || warningHint.test(line))) {
      throw new Error("one-shot stderr contained non-warning diagnostics before JSON", {
        cause: originalError,
      });
    }
    return JSON.parse(lines.slice(payloadLine).join("\n"));
  }
}

function oneShot(stateRoot, configuration, toolName, args = {}, extraEnv = {}) {
  const oneShotConfig = path.join(stateRoot, "config.json");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(oneShotConfig, `${JSON.stringify(configuration, null, 2)}\n`);
  const result = spawnSync(process.execPath, [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "call-tool.mjs"),
    toolName,
    JSON.stringify(args),
  ], {
    env: {
      ...process.env,
      HAWKSPAN_STATE_DIR: stateRoot,
      HAWKSPAN_CONFIG: oneShotConfig,
      HAWKSPAN_LOCAL_CONTROL_DISABLED: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  const raw = result.status === 0 ? result.stdout : result.stderr;
  return { status: result.status, output: parseOneShotJson(raw) };
}

const warningPrefixedError = `(node:12345) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use \`node --trace-warnings ...\` to show where the warning was created)
${JSON.stringify({ isError: true, content: [{ type: "text", text: "expected" }] }, null, 2)}
`;
assert.equal(parseOneShotJson(warningPrefixedError).content[0].text, "expected");
assert.throws(
  () => parseOneShotJson(`database failed\n${JSON.stringify({ isError: true })}\n`),
  /non-warning diagnostics/,
);

try {
  await request("initialize");
  const defaults = (await call("get_configuration")).structuredContent;
  assert.equal(defaults.role_profile, "symmetric");
  assert.equal(defaults.node_role, null);
  assert.deepEqual(defaults.features.allow_peer_commands, { inbound: true, outbound: true });
  assert.equal(defaults.features.require_authorized_job_for_all_commands, false);
  assert.equal(defaults.features.artifact_verification_mode, "on-change");
  assert.equal(defaults.features.strict_host_key_checking, true);

  const beforeInvalid = fs.readFileSync(configPath, "utf8");
  await call("update_configuration", { features: { invented_flag: true } }, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeInvalid);
  await call("update_configuration", { features: { allow_peer_messages: "yes" } }, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeInvalid);
  await call("update_configuration", {
    features: { allowed_peer_tools: { inbound: ["Not-A-Tool"] } },
  }, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeInvalid);
  await call("update_configuration", { role_profile: "controller-worker" }, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeInvalid);

  const legacyDirectionalDefaults = {};
  for (const name of [
    "allow_peer_commands",
    "allow_peer_wakeup",
    "allow_peer_messages",
    "allow_peer_acknowledgements",
    "allow_peer_jobs",
    "allow_peer_artifact_send",
    "allow_peer_artifact_receive",
    "enable_broad_run_command",
  ]) {
    legacyDirectionalDefaults[name] = { inbound: true, outbound: true };
  }
  legacyDirectionalDefaults.allowed_peer_tools = { inbound: "current", outbound: "current" };
  await call("update_configuration", { features: legacyDirectionalDefaults });

  const updated = (await call("update_configuration", {
    role_profile: "controller-worker",
    node_role: "controller",
    features: {
      allow_peer_commands: { inbound: false, outbound: true },
      allow_peer_messages: { inbound: true, outbound: false },
      require_authorized_job_for_all_commands: true,
      audit_command_content: false,
      artifact_verification_mode: "always",
      wake_prompt_mode: "notification",
    },
  })).structuredContent;
  assert.equal(updated.restart_required, true);
  assert.equal(updated.role_profile, "controller-worker");
  assert.equal(updated.node_role, "controller");
  assert.deepEqual(updated.features.allow_peer_commands, { inbound: false, outbound: true });
  assert.deepEqual(updated.features.allow_peer_messages, { inbound: true, outbound: false });
  assert.deepEqual(updated.features.allow_peer_wakeup, { inbound: false, outbound: true });
  assert.deepEqual(updated.features.allowed_peer_tools.inbound, []);
  assert.equal("allow_peer_wakeup" in updated.configured_features, false);
  assert.deepEqual(updated.configured_features.allow_peer_messages, {
    inbound: true,
    outbound: false,
  });
  await call("update_configuration", {
    features: { allow_peer_wakeup: { inbound: true } },
  });
  const workerProfile = (await call("update_configuration", {
    node_role: "worker",
    features: { allow_peer_wakeup: { inbound: true } },
  })).structuredContent;
  assert.deepEqual(workerProfile.features.allow_peer_wakeup, { inbound: true, outbound: false });
  await call("update_configuration", { node_role: "controller" });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.unrelated, { preserved: "exactly" });
  assert.equal(saved.features.artifact_verification_mode, "always");
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith("config.json.tmp-")),
    false,
  );

  await call("update_configuration", {
    features: { allow_peer_messages: { inbound: false } },
  });
  const partial = (await call("update_configuration", {
    features: { allow_peer_messages: { outbound: false } },
  })).structuredContent;
  assert.deepEqual(partial.features.allow_peer_messages, { inbound: false, outbound: false });
  await call("update_configuration", {
    features: {
      allowed_peer_tools: {
        inbound: ["link_status"],
        outbound: ["list_jobs"],
      },
    },
  });
  const toolsPartial = (await call("update_configuration", {
    features: { allowed_peer_tools: { inbound: ["list_messages"] } },
  })).structuredContent;
  assert.deepEqual(toolsPartial.features.allowed_peer_tools, {
    inbound: ["list_messages"],
    outbound: ["list_jobs"],
  });

  const inboundId = "msg-disabled-inbound";
  fs.writeFileSync(path.join(root, "inbox", `${inboundId}.json`), JSON.stringify({
    id: inboundId,
    sender: "peer",
    recipient: "flags-test",
    kind: "message",
    subject: "must not ingest",
    body: "disabled",
  }));
  const received = (await call("receive_messages")).structuredContent;
  assert.equal(received.messages.some((message) => message.id === inboundId), false);

  const outbound = (await call("send_message", {
    subject: "correlation target",
    body: "queued",
    deliver: false,
    wake: false,
  }, true));
  assert.equal(outbound.isError, true);

  await call("update_configuration", {
    features: {
      allow_peer_messages: true,
      allow_peer_acknowledgements: { inbound: false, outbound: true },
    },
  });
  const target = (await call("send_message", {
    subject: "correlation target",
    body: "queued",
    deliver: false,
    wake: false,
  })).structuredContent;
  const acknowledgementId = "ack-disabled-inbound";
  fs.writeFileSync(path.join(root, "inbox", `${acknowledgementId}.json`), JSON.stringify({
    id: acknowledgementId,
    sender: "peer",
    recipient: "flags-test",
    kind: "acknowledgement",
    subject: "disabled acknowledgement",
    body: "disabled",
    correlation_id: target.message_id,
  }));
  await call("receive_messages", { include_acknowledged: true });
  const outboundRows = (await call("list_messages", { direction: "outbound" })).structuredContent;
  assert.equal(outboundRows.find((row) => row.id === target.message_id).state, "queued");
  await call("update_configuration", {
    features: { allow_peer_acknowledgements: { inbound: true, outbound: true } },
  });
  const enabledAcknowledgementId = "ack-enabled-inbound";
  fs.writeFileSync(path.join(root, "inbox", `${enabledAcknowledgementId}.json`), JSON.stringify({
    id: enabledAcknowledgementId,
    sender: "peer",
    recipient: "flags-test",
    kind: "acknowledgement",
    subject: "enabled acknowledgement",
    body: "enabled",
    correlation_id: target.message_id,
  }));
  await call("receive_messages", { include_acknowledged: true });
  const acknowledgedRows = (await call("list_messages", { direction: "outbound" })).structuredContent;
  assert.equal(acknowledgedRows.find((row) => row.id === target.message_id).state, "acknowledged");

  await call("update_configuration", {
    features: {
      require_authorized_job_for_all_commands: false,
      require_authorized_job_for_consequential_commands: true,
    },
  });
  await call("run_command", { command: "printf routine" });
  const consequentialDenied = await call("run_command", {
    command: "printf consequential",
    consequential: true,
  }, true);
  assert.match(consequentialDenied.content[0].text, /recorded authorization/);
  await call("update_configuration", {
    features: {
      require_authorized_job_for_all_commands: true,
      require_authorized_job_for_consequential_commands: false,
    },
  });
  const denied = await call("run_command", { command: "printf denied" }, true);
  assert.match(denied.content[0].text, /recorded authorization/);

  const job = (await call("create_job", {
    kind: "test",
    title: "Authorized command",
    requires_authorization: true,
  })).structuredContent;
  await call("update_job_status", {
    job_id: job.job_id,
    state: "authorized",
    authorization_evidence: "test authorization",
  });
  await call("run_command", {
    command: "printf allowed",
    job_id: job.job_id,
  });
  const audit = (await call("list_audit_events", { object_type: "command" })).structuredContent;
  assert.equal("command" in audit[0].details, false);
  assert.match(audit[0].details.command_sha256, /^[a-f0-9]{64}$/);
  await call("update_configuration", {
    features: {
      require_authorized_job_for_all_commands: false,
      audit_command_content: true,
    },
  });
  await call("run_command", { command: "printf visible-audit" });
  const visibleAudit = (await call(
    "list_audit_events",
    { object_type: "command" },
  )).structuredContent;
  assert.equal(visibleAudit[0].details.command, "printf visible-audit");

  const peerFamilies = [
    ["allow_peer_commands", "run_command", { command: "printf peer" }],
    ["enable_broad_run_command", "run_command", { command: "printf peer" }],
    ["allow_peer_wakeup", "wake_peer_thread", { message_id: "fixture-message" }],
    ["allow_peer_messages", "list_messages", {}],
    ["allow_peer_acknowledgements", "acknowledge_message", { message_id: "missing" }],
    ["allow_peer_jobs", "list_jobs", {}],
    ["allow_peer_artifact_send", "send_artifact", { artifact_id: "missing" }],
    ["allow_peer_artifact_receive", "receive_artifacts", {}],
  ];
  for (const [name, toolName, argumentsValue] of peerFamilies) {
    await call("update_configuration", {
      features: { [name]: { outbound: false } },
    });
    const blocked = await call("peer_call_tool", {
      tool_name: toolName,
      arguments: argumentsValue,
    }, true);
    assert.match(blocked.content[0].text, /disabled/);
    await call("update_configuration", {
      features: { [name]: { outbound: true } },
    });
    const permitted = await call("peer_call_tool", {
      tool_name: toolName,
      arguments: argumentsValue,
    });
    assert.equal(permitted.structuredContent.error, "all routes failed");
  }

  await call("update_configuration", {
    features: { enable_background_outbox: false },
  });
  const backgroundBlocked = await call("flush_outbox", {}, true);
  assert.match(backgroundBlocked.content[0].text, /background outbox processing is disabled/);
  const queuedArtifactPath = path.join(root, "queued-background-artifact.txt");
  fs.writeFileSync(queuedArtifactPath, "queued artifact");
  const queuedArtifact = (await call("register_artifact", {
    path: queuedArtifactPath,
  })).structuredContent;
  await call("send_artifact", { artifact_id: queuedArtifact.artifact_id });
  const receivedFixtureId = "artifact-background-receive";
  const receivedFixtureName = `${receivedFixtureId}-received.txt`;
  const receivedFixtureBody = "received artifact";
  fs.writeFileSync(path.join(root, "artifacts", receivedFixtureName), receivedFixtureBody);
  fs.writeFileSync(
    path.join(root, "artifacts", `${receivedFixtureName}.artifact.json`),
    JSON.stringify({
      schema_version: 1,
      artifact_id: receivedFixtureId,
      owner: "fixture-peer",
      name: "received.txt",
      file_name: receivedFixtureName,
      size_bytes: Buffer.byteLength(receivedFixtureBody),
      sha256: crypto.createHash("sha256").update(receivedFixtureBody).digest("hex"),
      metadata: {},
    }),
  );
  await call("update_configuration", {
    features: {
      enable_background_outbox: true,
      enable_background_artifact_sender: false,
      enable_background_artifact_receiver: false,
      allow_peer_artifact_receive: { inbound: true, outbound: true },
    },
  });
  const backgroundRestricted = (await call("flush_outbox")).structuredContent;
  assert.deepEqual(backgroundRestricted.artifacts, []);
  assert.equal(backgroundRestricted.received.skipped, true);
  await call("update_configuration", {
    features: {
      enable_background_artifact_sender: true,
      enable_background_artifact_receiver: true,
    },
  });
  const backgroundEnabled = (await call("flush_outbox")).structuredContent;
  assert.equal(backgroundEnabled.received.skipped, undefined);
  assert.ok(backgroundEnabled.artifacts.length > 0);
  assert.ok(backgroundEnabled.received.artifacts.some(
    (artifact) => artifact.artifact_id === receivedFixtureId,
  ));
  await call("update_configuration", {
    features: { artifact_verification_mode: "on-change" },
  });
  const onChangeReceive = (await call("receive_artifacts")).structuredContent;
  const onChangeArtifact = onChangeReceive.artifacts.find(
    (artifact) => artifact.artifact_id === receivedFixtureId,
  );
  assert.equal(onChangeArtifact.verified, true);
  assert.equal(onChangeArtifact.cached, undefined);
  const tamperedFixtureBody = "tampered artifact";
  assert.equal(Buffer.byteLength(tamperedFixtureBody), Buffer.byteLength(receivedFixtureBody));
  fs.writeFileSync(path.join(root, "artifacts", receivedFixtureName), tamperedFixtureBody);
  const mismatchReceive = (await call("receive_artifacts")).structuredContent;
  assert.equal(
    mismatchReceive.artifacts.find(
      (artifact) => artifact.artifact_id === receivedFixtureId,
    ).verified,
    false,
  );
  const mismatchRecord = (await call("list_artifacts")).structuredContent.find(
    (artifact) => artifact.id === receivedFixtureId,
  );
  assert.equal(mismatchRecord.state, "received_mismatch");
  assert.equal(
    mismatchRecord.sha256,
    crypto.createHash("sha256").update(tamperedFixtureBody).digest("hex"),
  );
  fs.writeFileSync(path.join(root, "artifacts", receivedFixtureName), receivedFixtureBody);
  await call("update_configuration", {
    features: { artifact_verification_mode: "always" },
  });
  const alwaysReceive = (await call("receive_artifacts")).structuredContent;
  assert.equal(
    alwaysReceive.artifacts.find(
      (artifact) => artifact.artifact_id === receivedFixtureId,
    ).cached,
    undefined,
  );
  const restoredRecord = (await call("list_artifacts")).structuredContent.find(
    (artifact) => artifact.id === receivedFixtureId,
  );
  assert.equal(restoredRecord.state, "received_verified");
  assert.equal(
    restoredRecord.sha256,
    crypto.createHash("sha256").update(receivedFixtureBody).digest("hex"),
  );
  fs.unlinkSync(path.join(root, "artifacts", receivedFixtureName));
  const missingReceive = (await call("receive_artifacts")).structuredContent;
  const missingArtifact = missingReceive.artifacts.find(
    (artifact) => artifact.manifest?.endsWith(`${receivedFixtureName}.artifact.json`),
  );
  assert.equal(missingArtifact.verified, false);
  assert.match(missingArtifact.error, /artifact file is missing/);
  const missingRecord = (await call("list_artifacts")).structuredContent.find(
    (artifact) => artifact.id === receivedFixtureId,
  );
  assert.equal(missingRecord.state, "received_missing");

  const cachedPath = path.join(root, "cached-artifact.txt");
  fs.writeFileSync(cachedPath, "first");
  const cachedArtifact = (await call("register_artifact", {
    path: cachedPath,
  })).structuredContent;
  fs.writeFileSync(cachedPath, "other");
  await call("update_configuration", {
    features: { artifact_verification_mode: "cached" },
  });
  const cachedDelivery = (await call("send_artifact", {
    artifact_id: cachedArtifact.artifact_id,
  })).structuredContent;
  assert.equal(cachedDelivery.delivery.error, "all routes failed");

  const alwaysPath = path.join(root, "always-artifact.txt");
  fs.writeFileSync(alwaysPath, "first");
  const alwaysArtifact = (await call("register_artifact", {
    path: alwaysPath,
  })).structuredContent;
  fs.writeFileSync(alwaysPath, "other");
  await call("update_configuration", {
    features: { artifact_verification_mode: "always" },
  });
  const alwaysDelivery = (await call("send_artifact", {
    artifact_id: alwaysArtifact.artifact_id,
  })).structuredContent;
  assert.match(alwaysDelivery.delivery.error, /source file changed/);

  fs.writeFileSync(sshLog, "");
  await call("update_configuration", {
    features: { strict_host_key_checking: true },
  });
  await call("link_status");
  assert.match(fs.readFileSync(sshLog, "utf8"), /StrictHostKeyChecking=yes/);
  fs.writeFileSync(sshLog, "");
  await call("update_configuration", {
    features: { strict_host_key_checking: false },
  });
  await call("link_status");
  assert.match(fs.readFileSync(sshLog, "utf8"), /StrictHostKeyChecking=accept-new/);

  fs.writeFileSync(sshLog, "");
  await call("update_configuration", {
    features: {
      allow_peer_wakeup: { outbound: true },
      wake_prompt_mode: "embedded-message",
    },
  });
  await call("wake_peer_thread", {
    message_id: "wake-embedded",
    subject: "Visible subject",
    body: "VISIBLE_BODY_FIXTURE",
  });
  assert.match(fs.readFileSync(sshLog, "utf8"), /VISIBLE_BODY_FIXTURE/);
  fs.writeFileSync(sshLog, "");
  await call("update_configuration", {
    features: { wake_prompt_mode: "notification" },
  });
  await call("wake_peer_thread", {
    message_id: "wake-notification",
    subject: "Hidden subject",
    body: "HIDDEN_BODY_FIXTURE",
  });
  assert.doesNotMatch(fs.readFileSync(sshLog, "utf8"), /HIDDEN_BODY_FIXTURE/);

  const pluginRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../examples/plugins",
  );
  const adapterBase = {
    schema_version: 1,
    node_id: "adapter-fixture",
    local_control: { enabled: false },
    application_plugins: {
      enabled: true,
      roles: ["controller", "worker"],
      roots: [pluginRoot],
      feature_flags: {},
      core_tool_allowlist: [],
    },
  };
  const adapterEnabled = oneShot(
    path.join(root, "adapter-enabled"),
    { ...adapterBase, features: { enable_scoped_operation_adapters: true } },
    "application_plugin_status",
  );
  assert.equal(adapterEnabled.status, 0);
  assert.ok(adapterEnabled.output.structuredContent.plugins.length > 0);
  const adapterDisabled = oneShot(
    path.join(root, "adapter-disabled"),
    { ...adapterBase, features: { enable_scoped_operation_adapters: false } },
    "application_plugin_status",
  );
  assert.equal(adapterDisabled.status, 0);
  assert.deepEqual(adapterDisabled.output.structuredContent.plugins, []);

  const toolGateBase = {
    schema_version: 1,
    node_id: "tool-gate-fixture",
    local_control: { enabled: false },
  };
  const inboundToolAllowed = oneShot(
    path.join(root, "tool-inbound-allowed"),
    {
      ...toolGateBase,
      features: { allowed_peer_tools: { inbound: ["list_jobs"], outbound: "current" } },
    },
    "list_jobs",
    {},
    { HAWKSPAN_CALL_ORIGIN: "peer" },
  );
  assert.equal(inboundToolAllowed.status, 0);
  const inboundToolDenied = oneShot(
    path.join(root, "tool-inbound-denied"),
    {
      ...toolGateBase,
      features: { allowed_peer_tools: { inbound: [], outbound: "current" } },
    },
    "list_jobs",
    {},
    { HAWKSPAN_CALL_ORIGIN: "peer" },
  );
  assert.equal(inboundToolDenied.status, 1);
  assert.match(inboundToolDenied.output.content[0].text, /peer tool is not allowed/);
  const outboundBase = {
    ...toolGateBase,
    peer: {
      node_id: "fixture-peer",
      user: "fixture",
      remote_call_tool: "/fixture/call-tool.mjs",
    },
  };
  const outboundToolAllowed = oneShot(
    path.join(root, "tool-outbound-allowed"),
    {
      ...outboundBase,
      features: { allowed_peer_tools: { inbound: "current", outbound: ["list_jobs"] } },
    },
    "peer_call_tool",
    { tool_name: "list_jobs", arguments: {} },
  );
  assert.equal(outboundToolAllowed.status, 0);
  assert.equal(outboundToolAllowed.output.structuredContent.error, "all routes failed");
  const outboundToolDenied = oneShot(
    path.join(root, "tool-outbound-denied"),
    {
      ...outboundBase,
      features: { allowed_peer_tools: { inbound: "current", outbound: [] } },
    },
    "peer_call_tool",
    { tool_name: "list_jobs", arguments: {} },
  );
  assert.equal(outboundToolDenied.status, 1);
  assert.match(outboundToolDenied.output.content[0].text, /peer tool is not allowed/);

  const switches = [
    "enable_background_outbox",
    "enable_background_artifact_sender",
    "enable_background_artifact_receiver",
    "enable_scoped_operation_adapters",
    "strict_host_key_checking",
  ];
  for (const name of switches) {
    const disabled = (await call("update_configuration", {
      features: { [name]: false },
    })).structuredContent;
    assert.equal(disabled.features[name], false, `${name} did not disable`);
    const enabled = (await call("update_configuration", {
      features: { [name]: true },
    })).structuredContent;
    assert.equal(enabled.features[name], true, `${name} did not enable`);
  }

  process.stdout.write("hawkspan configuration flag tests passed\n");
} finally {
  server.stdin.end();
  await new Promise((resolve) => server.once("exit", resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
