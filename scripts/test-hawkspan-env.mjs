#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyHawkspanEnv, minimalChildEnvironment, readHawkspanEnv, writeHawkspanEnv,
} from "./hawkspan-env.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-env-"));
const envPath = path.join(root, "hawkspan.env");
const values = {
  HAWKSPAN_NODE_ID: "working-node",
  HAWKSPAN_PEER_NODE_ID: "worker-node",
  HAWKSPAN_PEER_USER: "operator",
  HAWKSPAN_PRIMARY_ENABLED: "true",
  HAWKSPAN_PRIMARY_LABEL: "Direct cable",
  HAWKSPAN_PRIMARY_HOST: "192.0.2.20",
  HAWKSPAN_FALLBACK_ENABLED: "false",
  HAWKSPAN_FALLBACK_LABEL: "Fallback cable",
  HAWKSPAN_SSH_IDENTITY: "/private/tmp/hawkspan-fixture-key",
  HAWKSPAN_LOCAL_CONTROL_PORT: "8765",
};
writeHawkspanEnv(envPath, values);
assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
assert.deepEqual(readHawkspanEnv(envPath), Object.freeze(values));
const applied = applyHawkspanEnv({ local_control: {}, peer: {} }, values);
assert.equal(applied.node_id, "working-node");
assert.equal(applied.peer.primary_enabled, true);
assert.equal(applied.peer.fallback_enabled, false);
assert.equal(applied.local_control.port, 8765);

const literalPath = path.join(root, "literal-round-trip.env");
const literalValues = {
  HAWKSPAN_NODE_ID: "node#literal $HOME; $(not-executed)",
  HAWKSPAN_PEER_NODE_ID: 'node with "quotes"',
  HAWKSPAN_PEER_USER: "user with 'quotes'",
  HAWKSPAN_PRIMARY_LABEL: " leading and trailing ",
  HAWKSPAN_FALLBACK_LABEL: "",
  HAWKSPAN_SSH_IDENTITY: "/private/tmp/path\\with\\backslashes",
};
writeHawkspanEnv(literalPath, literalValues);
assert.deepEqual(readHawkspanEnv(literalPath), Object.freeze(literalValues));
assert.equal(fs.existsSync(path.join(root, "not-executed")), false);
assert.throws(
  () => writeHawkspanEnv(path.join(root, "unrepresentable.env"), {
    HAWKSPAN_NODE_ID: `contains "double", 'single', and \`backtick\` quotes`,
  }),
  /all three Node \.env quote characters/,
);

function rejected(name, body, mode = 0o600) {
  const target = path.join(root, name);
  fs.writeFileSync(target, body, { mode });
  assert.throws(() => readHawkspanEnv(target));
}
rejected("unknown.env", "UNREVIEWED_NAME=value\n");
rejected("duplicate.env", "HAWKSPAN_NODE_ID=one\nHAWKSPAN_NODE_ID=two\n");
assert.equal(readHawkspanEnv((() => {
  const target = path.join(root, "literal.env");
  fs.writeFileSync(target, 'HAWKSPAN_NODE_ID="working $Mac; literal"\n', { mode: 0o600 });
  return target;
})()).HAWKSPAN_NODE_ID, "working $Mac; literal");
rejected("mode.env", "HAWKSPAN_NODE_ID=value\n", 0o644);
rejected("oversized.env", `HAWKSPAN_NODE_ID=${"x".repeat(4097)}\n`);
const linked = path.join(root, "linked.env");
fs.symlinkSync(envPath, linked);
assert.throws(() => readHawkspanEnv(linked), /regular non-symbolic-link/);
fs.chmodSync(envPath, 0o400);
assert.equal(readHawkspanEnv(envPath).HAWKSPAN_NODE_ID, values.HAWKSPAN_NODE_ID);
fs.chmodSync(envPath, 0o600);
process.env.HAWKSPAN_PRIVATE_FIXTURE = "must-not-propagate";
assert.equal(Object.hasOwn(minimalChildEnvironment(), "HAWKSPAN_PRIVATE_FIXTURE"), false);

const stateRoot = path.join(root, "state");
fs.mkdirSync(stateRoot);
fs.writeFileSync(path.join(stateRoot, "config.json"), `${JSON.stringify({
  schema_version: 1,
  role_profile: "symmetric",
  local_control: { enabled: false },
  peer: { allow_remote_wake: false },
}, null, 2)}\n`, { mode: 0o600 });
const persistedBoundaryValues = {
  ...values,
  HAWKSPAN_PLUGIN_ROOT: path.join(root, "private-plugin-root"),
  HAWKSPAN_APPLICATION_PLUGIN_ROOT: path.join(root, "private-application-plugin-root"),
  HAWKSPAN_FALLBACK_HOST: "198.51.100.44",
  HAWKSPAN_REMOTE_NODE: path.join(root, "private-node"),
  HAWKSPAN_REMOTE_PLUGIN_ROOT: path.join(root, "private-remote-plugin-root"),
  HAWKSPAN_REMOTE_CALL_TOOL: path.join(root, "private-call-tool"),
  HAWKSPAN_REMOTE_INBOX: path.join(root, "private-inbox"),
  HAWKSPAN_REMOTE_ARTIFACTS: path.join(root, "private-artifacts"),
  HAWKSPAN_REMOTE_AUDIT: path.join(root, "private-audit"),
  HAWKSPAN_WORKLOAD_OUTPUT_ROOT: path.join(root, "private-simpletuner-output"),
  HAWKSPAN_WORKLOAD_RUNTIME_ROOT: path.join(root, "private-simpletuner-runtime"),
  HAWKSPAN_WORKLOAD_LOG_ROOT: path.join(root, "private-simpletuner-logs"),
  HAWKSPAN_SIMPLETUNER_ROOT: path.join(root, "private-simpletuner-install"),
  HAWKSPAN_LOCAL_TRAINER_START_SCRIPT: path.join(root, "private-trainer-start"),
  HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT: path.join(root, "private-trainer-stop"),
  HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT: path.join(root, "private-trainer-package"),
};
writeHawkspanEnv(path.join(stateRoot, "hawkspan.env"), persistedBoundaryValues);
const server = spawn(process.execPath, [
  path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs"),
], {
  env: { ...process.env, HAWKSPAN_STATE_DIR: stateRoot, HAWKSPAN_LOCAL_CONTROL_DISABLED: "1" },
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
    const response = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  }
});
function request(name, argumentsValue = {}) {
  const id = ++sequence;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
    name, arguments: argumentsValue,
  } })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${name}`)), 10000);
    pending.set(id, (response) => { clearTimeout(timer); resolve(response.result.structuredContent); });
  });
}
try {
  const status = await request("link_status");
  const serialized = JSON.stringify(status);
  for (const secret of [
    values.HAWKSPAN_NODE_ID, values.HAWKSPAN_PEER_NODE_ID, values.HAWKSPAN_PEER_USER,
    values.HAWKSPAN_PRIMARY_HOST, values.HAWKSPAN_SSH_IDENTITY, stateRoot,
  ]) {
    assert.equal(serialized.includes(secret), false, `diagnostic leaked ${secret}`);
  }
  assert.equal(status.machine_settings.values.HAWKSPAN_PRIMARY_HOST, "[configured]");
  await request("update_configuration", {
    features: { audit_command_content: false },
  });
  const publicSettingNames = new Set([
    "HAWKSPAN_PRIMARY_ENABLED", "HAWKSPAN_FALLBACK_ENABLED",
    "HAWKSPAN_PRIMARY_LABEL", "HAWKSPAN_FALLBACK_LABEL", "HAWKSPAN_LOCAL_CONTROL_PORT",
  ]);
  const assertNoMachineValuesPersisted = (persisted) => {
    for (const [, secret] of Object.entries(persistedBoundaryValues)
      .filter(([name, value]) => !publicSettingNames.has(name) && value.length >= 3)) {
      assert.equal(persisted.includes(secret), false, `config.json persisted machine value ${secret}`);
    }
  };
  assertNoMachineValuesPersisted(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"));
  await request("apply_configuration_profile", {
    profile_id: "builtin-current-symmetric", confirm: true,
  });
  const persisted = fs.readFileSync(path.join(stateRoot, "config.json"), "utf8");
  assertNoMachineValuesPersisted(persisted);
} finally {
  server.stdin.end();
  await new Promise((resolve) => server.once("exit", resolve));
}

process.stdout.write("hawkspan machine environment parser and redaction tests passed\n");
