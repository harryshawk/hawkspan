#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-profiles-"));
const configPath = path.join(root, "config.json");
const originalUnrelated = {
  schema_version: 1,
  node_id: "profile-test",
  install_marker: { preserve: "exactly" },
  local_control: { enabled: false, port: 8765 },
  peer: {
    node_id: "peer",
    user: "operator",
    primary_host: "private.example",
    ssh_identity: "/private/key",
  },
  plugins: {
    root: "/private/plugins",
    entries: [{ id: "private-plugin", token: "not-a-profile-value" }],
  },
};
fs.writeFileSync(configPath, `${JSON.stringify({
  ...originalUnrelated,
  role_profile: "controller-worker",
  node_role: "controller",
  features: {
    allow_peer_commands: { inbound: false, outbound: true },
    strict_host_key_checking: true,
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
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let requestId = 0;
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
  const id = ++requestId;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout for ${method}`)), 10000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function call(name, args = {}, expectError = false) {
  const response = await request("tools/call", { name, arguments: args });
  assert.equal(response.result?.isError, expectError, JSON.stringify(response));
  return response.result?.structuredContent;
}

function activeDocument() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function assertUnrelatedPreserved() {
  const current = activeDocument();
  for (const [key, value] of Object.entries(originalUnrelated)) {
    assert.deepEqual(current[key], value, `unrelated key changed: ${key}`);
  }
}

try {
  await request("initialize");

  const listed = await call("list_configuration_profiles");
  assert.equal(listed.profiles.filter((profile) => profile.source === "builtin").length, 4);
  assert.deepEqual(
    listed.profiles.filter((profile) => profile.source === "builtin").map((profile) => profile.id),
    [
      "builtin-current-symmetric",
      "builtin-high-value-controller",
      "builtin-compute-worker",
      "builtin-coordination-only",
    ],
  );
  for (const profile of listed.profiles.filter((candidate) => candidate.source === "builtin")) {
    assert.equal(profile.read_only, true);
    assert.ok(profile.description.length > 20);
    assert.ok(profile.impact.length > 20);
  }

  const saved = await call("save_configuration_profile", { name: "My controller" });
  const profileId = saved.profile.id;
  assert.match(profileId, /^profile-[a-f0-9]{24}$/);
  assert.equal(saved.profile.source, "user");
  assert.deepEqual(Object.keys(saved.profile.settings).sort(), [
    "features", "node_role", "role_profile",
  ]);
  const storeText = fs.readFileSync(path.join(root, "configuration-profiles.json"), "utf8");
  for (const forbidden of [
    "private.example", "/private/key", "/private/plugins", "not-a-profile-value",
    "\"local_control\"", "\"peer\"", "\"plugins\"",
  ]) {
    assert.equal(storeText.includes(forbidden), false, `profile leaked ${forbidden}`);
  }
  await call("save_configuration_profile", { name: "my controller" }, true);
  await call("save_configuration_profile", {
    name: "My controller",
    confirm_replace: true,
  });
  await call("save_configuration_profile", { name: "Compute worker" }, true);

  await call("update_configuration", {
    role_profile: "symmetric",
    node_role: null,
    features: { allow_peer_commands: { inbound: true, outbound: true } },
  });
  const beforeUnconfirmedApply = fs.readFileSync(configPath, "utf8");
  await call("apply_configuration_profile", { profile_id: profileId }, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeUnconfirmedApply);
  const applied = await call("apply_configuration_profile", {
    profile_id: profileId,
    confirm: true,
  });
  assert.equal(applied.restart_required, true);
  assert.equal(applied.configuration.role_profile, "controller-worker");
  assert.equal(applied.configuration.node_role, "controller");
  assert.deepEqual(applied.configuration.features.allow_peer_commands, {
    inbound: false,
    outbound: true,
  });
  assertUnrelatedPreserved();

  const highValue = await call("apply_configuration_profile", {
    profile_id: "builtin-high-value-controller",
    confirm: true,
  });
  assert.deepEqual(highValue.configuration.features.enable_broad_run_command, {
    inbound: false,
    outbound: true,
  });
  assert.deepEqual(highValue.configuration.features.allow_peer_artifact_receive, {
    inbound: true,
    outbound: true,
  });
  assert.deepEqual(highValue.configuration.features.allowed_peer_tools, {
    inbound: "current",
    outbound: "current",
  });
  assert.equal(highValue.configuration.features.strict_host_key_checking, true);
  assertUnrelatedPreserved();

  const worker = await call("apply_configuration_profile", {
    profile_id: "builtin-compute-worker",
    confirm: true,
  });
  assert.equal(worker.configuration.node_role, "worker");
  assert.deepEqual(worker.configuration.features.allow_peer_commands, {
    inbound: true,
    outbound: false,
  });
  assert.deepEqual(worker.configuration.features.allow_peer_messages, {
    inbound: true,
    outbound: true,
  });
  assert.deepEqual(worker.configuration.features.allowed_peer_tools, {
    inbound: "current",
    outbound: "current",
  });

  const coordination = await call("apply_configuration_profile", {
    profile_id: "builtin-coordination-only",
    confirm: true,
  });
  assert.deepEqual(coordination.configuration.features.allow_peer_commands, {
    inbound: false,
    outbound: false,
  });
  assert.deepEqual(coordination.configuration.features.enable_broad_run_command, {
    inbound: false,
    outbound: false,
  });
  assert.deepEqual(coordination.configuration.features.allow_peer_jobs, {
    inbound: true,
    outbound: true,
  });

  const symmetric = await call("apply_configuration_profile", {
    profile_id: "builtin-current-symmetric",
    confirm: true,
  });
  assert.equal(symmetric.configuration.role_profile, "symmetric");
  assert.equal(Object.hasOwn(activeDocument(), "features"), false);
  assertUnrelatedPreserved();

  await call("delete_configuration_profile", {
    profile_id: "builtin-current-symmetric",
    confirm: true,
  }, true);
  await call("delete_configuration_profile", { profile_id: profileId }, true);

  const profileStorePath = path.join(root, "configuration-profiles.json");
  const validStore = fs.readFileSync(profileStorePath, "utf8");
  const invalidStore = JSON.parse(validStore);
  const invalidProfile = invalidStore.profiles.find((profile) => profile.id === profileId);
  invalidProfile.settings.features = { unsupported_private_setting: true };
  fs.writeFileSync(profileStorePath, `${JSON.stringify(invalidStore, null, 2)}\n`);
  const beforeInvalidApply = fs.readFileSync(configPath, "utf8");
  await call("apply_configuration_profile", {
    profile_id: profileId,
    confirm: true,
  }, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeInvalidApply);
  fs.writeFileSync(profileStorePath, validStore);

  await call("delete_configuration_profile", {
    profile_id: profileId,
    confirm: true,
  });

  await call("update_configuration", {
    features: { allow_peer_messages: { inbound: false, outbound: false } },
  });
  const beforeUnconfirmedReset = fs.readFileSync(configPath, "utf8");
  await call("reset_configuration", {}, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeUnconfirmedReset);
  const reset = await call("reset_configuration", { confirm: true });
  assert.equal(reset.reset, true);
  assert.equal(reset.restart_required, true);
  assert.equal(reset.role_profile, "symmetric");
  assert.equal(reset.node_role, null);
  assert.deepEqual(reset.features.allow_peer_messages, { inbound: true, outbound: true });
  assert.equal(Object.hasOwn(activeDocument(), "role_profile"), false);
  assert.equal(Object.hasOwn(activeDocument(), "node_role"), false);
  assert.equal(Object.hasOwn(activeDocument(), "features"), false);
  assertUnrelatedPreserved();

  process.stdout.write("hawkspan configuration profile tests passed\n");
} finally {
  server.kill("SIGTERM");
}
