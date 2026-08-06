#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-package-"));
const source = path.join(root, "source", "preset-example");
const stateRoot = path.join(root, "state");
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(stateRoot, { recursive: true });
fs.writeFileSync(path.join(source, "hawkspan-plugin.json"), `${JSON.stringify({
  schema_version: 1,
  id: "preset-example",
  name: "Preset example",
  version: "1.0.0",
  entrypoint: "plugin.mjs",
  presets: [{
    id: "greeting-only",
    name: "Greeting only",
    description: "Enable the harmless greeting operation.",
    impact: "Restricts this package to its greeting operation.",
    settings: { enabled_operations: ["greet"] },
  }],
  operations: [{
    name: "greet",
    description: "Return a greeting.",
    roles: ["controller", "worker"],
    access: ["local", "peer", "html"],
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", maxLength: 80 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }],
}, null, 2)}\n`);
fs.writeFileSync(path.join(source, "plugin.mjs"), `
export async function activate() {
  return { operations: { greet(args) { return { greeting: \`Hello, \${args.name || "world"}!\` }; } } };
}
`);

const environment = { ...process.env, HAWKSPAN_STATE_DIR: stateRoot };
const installed = spawnSync(process.execPath, [path.join(scripts, "install-application-plugin.mjs"), source], {
  encoding: "utf8", env: environment,
});
assert.equal(installed.status, 0, installed.stderr);
assert.equal(JSON.parse(installed.stdout).plugin_id, "preset-example");

fs.writeFileSync(path.join(stateRoot, "config.json"), `${JSON.stringify({
  schema_version: 1,
  local_control: { enabled: false },
}, null, 2)}\n`, { mode: 0o600 });
const child = spawn(process.execPath, [path.join(scripts, "mcp-server.mjs")], {
  env: { ...environment, HAWKSPAN_LOCAL_CONTROL_DISABLED: "1" },
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
    const response = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  }
});
function request(name, args = {}) {
  const id = ++sequence;
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
  })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${name}`)), 10000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      assert.equal(response.result.isError, false, JSON.stringify(response));
      resolve(response.result.structuredContent);
    });
  });
}

const status = await request("application_plugin_status");
assert.deepEqual(status.plugins.map((plugin) => plugin.id), ["preset-example"]);
const greeting = await request("app_preset_example_greet", { name: "HawkSpan" });
assert.equal(greeting.result.greeting, "Hello, HawkSpan!");
const listed = await request("list_application_presets");
assert.deepEqual(listed.presets.map((preset) => preset.id), ["preset-example/greeting-only"]);
const preview = await request("preview_application_preset", { preset_id: "preset-example/greeting-only" });
assert.deepEqual(preview.preset.settings.enabled_operations, ["greet"]);
await request("apply_application_preset", { preset_id: "preset-example/greeting-only", confirm: true });
let persisted = JSON.parse(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"));
assert.deepEqual(persisted.application_plugins.entries["preset-example"].enabled_operations, ["greet"]);
await request("reset_application_preset", { preset_id: "preset-example/greeting-only", confirm: true });
persisted = JSON.parse(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"));
assert.equal(
  Object.hasOwn(persisted.application_plugins.entries["preset-example"] || {}, "enabled_operations"),
  false,
);

child.stdin.end();
await new Promise((resolve) => child.once("exit", resolve));
const peerCall = spawnSync(process.execPath, [
  path.join(scripts, "call-tool.mjs"),
  "app_preset_example_greet",
  JSON.stringify({ name: "peer" }),
], {
  encoding: "utf8",
  env: { ...environment, HAWKSPAN_CALL_ORIGIN: "peer" },
});
assert.equal(peerCall.status, 0, peerCall.stderr);
assert.equal(JSON.parse(peerCall.stdout).structuredContent.result.greeting, "Hello, peer!");
const uninstalled = spawnSync(process.execPath, [path.join(scripts, "uninstall-application-plugin.mjs"), "preset-example"], {
  encoding: "utf8", env: environment,
});
assert.equal(uninstalled.status, 0, uninstalled.stderr);
assert.equal(JSON.parse(uninstalled.stdout).installed, false);
process.stdout.write("hawkspan package and lightweight preset tests passed\n");
