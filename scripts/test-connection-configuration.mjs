#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-connections-"));
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
const probeCapture = path.join(root, "probes.txt");

function executable(name, body) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

executable("ping", `printf 'ping %s\\n' "$*" >> "$HAWKSPAN_PROBE_CAPTURE"\nexit 0`);
executable("ssh", `printf 'ssh %s\\n' "$*" >> "$HAWKSPAN_PROBE_CAPTURE"\nexit 0`);

const configPath = path.join(root, "config.json");
const initial = {
  schema_version: 1,
  node_id: "connection-test-a",
  role_profile: "symmetric",
  features: { allow_peer_messages: false },
  local_control: {
    enabled: false,
    route_labels: { primary: "Direct legacy link", fallback: "Backup legacy link" },
  },
  plugin_root: "/private/unchanged/plugins",
  peer: {
    node_id: "connection-test-b",
    user: "peer",
    primary_host: "primary.test",
    ssh_identity: "/private/unchanged/key",
  },
};
fs.writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`);

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs");
const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HAWKSPAN_STATE_DIR: root,
    HAWKSPAN_PROBE_CAPTURE: probeCapture,
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
    const waiter = pending.get(response.id);
    if (waiter) {
      pending.delete(response.id);
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    }
  }
});

function request(method, params = {}) {
  const requestId = ++id;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
    pending.set(requestId, { resolve, reject, timer });
  });
}

async function call(name, args = {}, expectError = false) {
  const response = await request("tools/call", { name, arguments: args });
  assert.equal(response.result.isError, expectError, JSON.stringify(response));
  return response.result.structuredContent;
}

try {
  await request("initialize");
  const legacy = await call("get_connection_configuration");
  assert.deepEqual(legacy.routes.primary, {
    enabled: true, label: "Direct legacy link", host: "primary.test",
  });
  assert.deepEqual(legacy.routes.fallback, {
    enabled: false, label: "Backup legacy link", host: "",
  });
  assert.equal(legacy.automatic_fallback, false);

  await call("update_connection_configuration", {
    routes: { fallback: { enabled: false } },
  }, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), initial);

  const updated = await call("update_connection_configuration", {
    routes: {
      primary: { label: "Direct cable", host: "direct.test" },
      fallback: { enabled: false, label: "Office LAN", host: "" },
    },
    confirm: true,
  });
  assert.equal(updated.routes.primary.host, "direct.test");
  assert.equal(updated.routes.fallback.enabled, false);
  assert.equal(updated.automatic_fallback, false);
  assert.equal(updated.restart_required, true);

  const status = await call("link_status");
  assert.equal(status.routes.length, 2);
  assert.equal(status.routes[0].label, "Direct cable");
  assert.equal(status.routes[0].status, "connected");
  assert.deepEqual(status.routes[1], {
    role: "fallback",
    label: "Office LAN",
    host: "",
    enabled: false,
    status: "disabled",
    network_reachable: null,
    transport_ready: null,
    transport_error: "",
  });
  const probes = fs.readFileSync(probeCapture, "utf8");
  assert.match(probes, /direct\.test/);
  assert.doesNotMatch(probes, /fallback\.test|Office LAN/);

  const beforeInvalid = fs.readFileSync(configPath, "utf8");
  await call("update_connection_configuration", {
    routes: { primary: { enabled: false } }, confirm: true,
  }, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeInvalid);
  await call("update_connection_configuration", {
    routes: { primary: { host: " " } }, confirm: true,
  }, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeInvalid);

  const saved = await call("save_configuration_profile", { name: "Network isolation check" });
  assert.equal(Object.hasOwn(saved.profile.settings, "peer"), false);
  await call("apply_configuration_profile", {
    profile_id: "builtin-coordination-only", confirm: true,
  });
  await call("reset_configuration", { confirm: true });
  const preserved = await call("get_connection_configuration");
  assert.equal(preserved.routes.primary.label, "Direct cable");
  assert.equal(preserved.routes.primary.host, "direct.test");
  assert.equal(preserved.routes.fallback.enabled, false);

  const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(stored.plugin_root, initial.plugin_root);
  assert.equal(stored.peer.ssh_identity, initial.peer.ssh_identity);
  process.stdout.write("hawkspan connection configuration tests passed\n");
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
