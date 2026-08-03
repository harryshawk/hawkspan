#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const serverPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "mcp-server.mjs",
);
const installPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "install-application-plugin.mjs",
);
const uninstallPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "uninstall-application-plugin.mjs",
);
const examplePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../examples/plugins/hello-world",
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-plugins-"));

function writeJson(target, value) {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function makePlugin(pluginRoot, id, operations, source, manifestExtra = {}) {
  const directory = path.join(pluginRoot, id);
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "hawkspan-plugin.json"), {
    schema_version: 1,
    id,
    name: `Fixture ${id}`,
    version: "1.0.0",
    entrypoint: "plugin.mjs",
    operations,
    ...manifestExtra,
  });
  fs.writeFileSync(path.join(directory, "plugin.mjs"), source);
  return directory;
}

function operation(name, extra = {}) {
  return {
    name,
    roles: ["controller", "worker"],
    access: ["local", "peer", "html"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    ...extra,
  };
}

function startServer(stateRoot, config, extraEnv = {}) {
  writeJson(path.join(stateRoot, "config.json"), config);
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, HAWKSPAN_STATE_DIR: stateRoot, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0;
  let buffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
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
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`timeout: ${method}; stderr=${stderr}`));
      }, 10000);
      pending.set(requestId, { resolve, reject, timer });
    });
  }
  async function tool(name, args = {}, expectError = false) {
    const response = await request("tools/call", { name, arguments: args });
    assert.equal(response.result?.isError, expectError, JSON.stringify(response));
    return expectError ? response.result.content[0].text : response.result.structuredContent;
  }
  return {
    child,
    request,
    tool,
    async close() {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

const pluginRoot = path.join(root, "plugin-source");
const stateRoot = path.join(root, "state");
fs.mkdirSync(pluginRoot, { recursive: true });
fs.mkdirSync(stateRoot, { recursive: true });
makePlugin(pluginRoot, "safe-app", [
  operation("echo", {
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: {
        value: { type: "string", minLength: 2, maxLength: 200 },
        count: { type: "integer", minimum: 1, maximum: 3 },
        mode: { type: "string", const: "safe" },
        labels: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
        optional: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
  }),
  operation("configuration"),
  operation("authorized", {
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
  }),
  operation("controller_only", { roles: ["controller"] }),
  operation("flagged", { required_flags: ["danger-zone"] }),
  operation("delay"),
  operation("fail_private"),
  operation("artifact", {
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: { content: { type: "string", maxLength: 200 } },
      additionalProperties: false,
    },
  }),
], `
import fs from "node:fs";
import path from "node:path";
export async function activate(context) {
  return { operations: {
    echo(args) { return { value: args.value }; },
    configuration() {
      return {
        configuration: context.configuration,
        frozen: Object.isFrozen(context.configuration) && Object.isFrozen(context.configuration.nested),
      };
    },
    authorized(args) {
      return context.require_authorized_job({ job_id: args.job_id, kind: "generic-work", states: ["authorized"] });
    },
    controller_only() { return { allowed: true }; },
    flagged() { return { enabled: true }; },
    delay(args, run) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ finished: true }), 5000);
        run.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("cancelled by test"));
        }, { once: true });
      });
    },
    fail_private() {
      throw new Error("adapter-private-detail " + context.environment.HAWKSPAN_WORKLOAD_DISK_ROOT + " /private/adapter/path");
    },
    async artifact(args, run) {
      const output = path.join(context.stateDirectory, run.runId + ".txt");
      fs.writeFileSync(output, args.content);
      return context.callCoreTool("register_artifact", { path: output });
    },
  }};
}
`, {
  presets: [
    {
      id: "headless-worker",
      name: "Headless worker",
      description: "Configure this Mac as a scoped worker for the reviewed example application.",
      impact: "Accepts only the selected application operations while preserving coordination and artifact return.",
      settings: {
        role_profile: "controller-worker",
        node_role: "worker",
        features: {
          allowed_peer_tools: {
            inbound: ["app_safe_app_echo", "app_safe_app_artifact", "create_job"],
            outbound: [],
          },
          allow_peer_commands: { inbound: false, outbound: false },
          enable_broad_run_command: { inbound: false, outbound: false },
        },
        enabled_operations: ["echo", "artifact"],
      },
    },
  ],
});

makePlugin(pluginRoot, "unscoped-app", [operation("artifact")], `
import fs from "node:fs";
import path from "node:path";
export async function activate(context) {
  return { operations: {
    async artifact() {
      const output = path.join(context.stateDirectory, "unscoped.txt");
      fs.writeFileSync(output, "unscoped");
      return context.callCoreTool("register_artifact", { path: output });
    },
  }};
}
`);

const escaped = path.join(pluginRoot, "traversal");
fs.mkdirSync(escaped);
writeJson(path.join(escaped, "hawkspan-plugin.json"), {
  schema_version: 1,
  id: "traversal",
  name: "Traversal",
  version: "1.0.0",
  entrypoint: "../outside.mjs",
  operations: [operation("test")],
});
fs.writeFileSync(path.join(pluginRoot, "outside.mjs"), "export function activate(){}\n");

const linked = path.join(pluginRoot, "linked");
fs.symlinkSync(path.join(pluginRoot, "safe-app"), linked);

makePlugin(pluginRoot, "secret-config", [operation("test")], `
export function activate() { return { operations: { test() { return {}; } } }; }
`);
makePlugin(pluginRoot, "bad-config-type", [operation("test")], `
export function activate() { return { operations: { test() { return {}; } } }; }
`);
makePlugin(pluginRoot, "large-config", [operation("test")], `
export function activate() { return { operations: { test() { return {}; } } }; }
`);
makePlugin(pluginRoot, "unsafe-preset", [operation("test")], `
export function activate() { return { operations: { test() { return {}; } } }; }
`, {
  presets: [{
    id: "unsafe",
    name: "Unsafe preset",
    description: "A fixture that attempts to enable the broad command surface.",
    impact: "This fixture must be rejected before the plugin is activated.",
    settings: {
      role_profile: "symmetric",
      features: { enable_broad_run_command: { inbound: true, outbound: true } },
      enabled_operations: ["test"],
    },
  }],
});
makePlugin(pluginRoot, "private-preset", [operation("test")], `
export function activate() { return { operations: { test() { return {}; } } }; }
`, {
  presets: [{
    id: "private",
    name: "Private fixture",
    description: "A fixture that attempts to place connection data in a preset.",
    impact: "This fixture must be rejected before the plugin is activated.",
    settings: {
      connection: { host: "private.invalid" },
      enabled_operations: ["test"],
    },
  }],
});
makePlugin(pluginRoot, "unsafe-core-preset", [operation("test")], `
export function activate() { return { operations: { test() { return {}; } } }; }
`, {
  presets: [{
    id: "unsafe-core",
    name: "Unsafe core fixture",
    description: "A fixture that attempts to add an arbitrary core tool.",
    impact: "This fixture must be rejected before the plugin is activated.",
    settings: {
      role_profile: "controller-worker",
      node_role: "worker",
      features: { allowed_peer_tools: { inbound: ["run_command"], outbound: [] } },
      enabled_operations: ["test"],
    },
  }],
});

const baseConfig = {
  schema_version: 1,
  node_id: "plugin-test",
  application_plugins: {
    roles: ["worker"],
    roots: [pluginRoot],
    feature_flags: { "danger-zone": false },
    core_tool_allowlist: ["register_artifact"],
    entries: {
      "safe-app": {
        core_tool_allowlist: ["register_artifact"],
        configuration: { quality: 2, nested: { labels: ["generic"] }, optional: null },
      },
      "secret-config": {
        configuration: { apiToken: "must-not-reach-plugin" },
      },
      "bad-config-type": {
        configuration: ["invalid"],
      },
      "large-config": {
        configuration: { payload: "x".repeat(64 * 1024) },
      },
    },
  },
  local_control: {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    allowed_tools: [
      "application_plugin_status",
      "app_safe_app_fail_private",
      "app_safe_app_echo",
      "get_configuration",
      "update_configuration",
      "get_connection_configuration",
      "update_connection_configuration",
      "reset_configuration",
      "list_configuration_profiles",
      "save_configuration_profile",
      "apply_configuration_profile",
      "delete_configuration_profile",
      "list_application_presets",
      "preview_application_preset",
      "apply_application_preset",
      "reset_application_preset",
    ],
  },
  peer: null,
};

let server;
try {
  const privateCanary = "/private/tmp/hawkspan-private-canary-should-never-appear";
  fs.writeFileSync(
    path.join(stateRoot, "hawkspan.env"),
    `HAWKSPAN_WORKLOAD_DISK_ROOT="${privateCanary}"\n`,
    { mode: 0o600 },
  );
  server = startServer(stateRoot, baseConfig);
  await server.request("initialize");
  const listed = await server.request("tools/list");
  const names = new Set(listed.result.tools.map((entry) => entry.name));
  const status = await server.tool("application_plugin_status");
  assert.equal(names.has("app_safe_app_echo"), true, JSON.stringify(status));
  assert.equal(names.has("app_traversal_test"), false);

  assert.deepEqual(status.roles, ["worker"]);
  assert.equal(status.plugins.some((plugin) => plugin.id === "safe-app"), true);
  for (const candidate of [
    "traversal", "linked", "secret-config", "bad-config-type", "large-config",
    "unsafe-preset", "private-preset", "unsafe-core-preset",
  ]) {
    assert.equal(status.rejected.some((entry) =>
      entry.candidate === candidate && entry.error === "application plugin validation failed"), true);
  }
  assert.equal(JSON.stringify(status).includes(pluginRoot), false);

  const presets = await server.tool("list_application_presets");
  assert.deepEqual(presets.presets.map((preset) => preset.id), ["safe-app/headless-worker"]);
  assert.equal(presets.presets[0].plugin_name, "Fixture safe-app");
  assert.deepEqual(presets.presets[0].settings.enabled_operations, ["echo", "artifact"]);
  const beforePreview = fs.readFileSync(path.join(stateRoot, "config.json"), "utf8");
  const preview = await server.tool("preview_application_preset", {
    preset_id: "safe-app/headless-worker",
  });
  assert.equal(preview.confirmation_required, true);
  assert.equal(preview.preserved.includes("connections"), true);
  assert.equal(preview.preserved.includes("plugin_configuration"), true);
  assert.equal(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"), beforePreview);
  assert.match(
    await server.tool("apply_application_preset", {
      preset_id: "safe-app/headless-worker",
    }, true),
    /requires confirm: true/,
  );
  assert.equal(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"), beforePreview);
  const appliedPreset = await server.tool("apply_application_preset", {
    preset_id: "safe-app/headless-worker",
    confirm: true,
  });
  assert.equal(appliedPreset.configuration.role_profile, "controller-worker");
  assert.equal(appliedPreset.configuration.node_role, "worker");
  const afterPreset = JSON.parse(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"));
  assert.deepEqual(afterPreset.application_plugins.entries["safe-app"].enabled_operations, ["echo", "artifact"]);
  assert.deepEqual(afterPreset.application_plugins.entries["safe-app"].configuration,
    baseConfig.application_plugins.entries["safe-app"].configuration);
  assert.deepEqual(afterPreset.application_plugins.roots, baseConfig.application_plugins.roots);
  assert.deepEqual(afterPreset.local_control, baseConfig.local_control);
  assert.deepEqual(afterPreset.peer, baseConfig.peer);
  assert.match(
    await server.tool("reset_application_preset", {
      preset_id: "safe-app/headless-worker",
    }, true),
    /requires confirm: true/,
  );
  const resetPreset = await server.tool("reset_application_preset", {
    preset_id: "safe-app/headless-worker",
    confirm: true,
  });
  assert.equal(resetPreset.configuration.role_profile, "symmetric");
  const afterPresetReset = JSON.parse(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"));
  assert.equal(Object.hasOwn(afterPresetReset, "role_profile"), false);
  assert.equal(Object.hasOwn(afterPresetReset.application_plugins.entries["safe-app"], "enabled_operations"), false);
  assert.deepEqual(afterPresetReset.application_plugins.entries["safe-app"].configuration,
    baseConfig.application_plugins.entries["safe-app"].configuration);

  const pluginConfiguration = await server.tool("app_safe_app_configuration");
  assert.deepEqual(pluginConfiguration.result.configuration, {
    quality: 2,
    nested: { labels: ["generic"] },
    optional: null,
  });
  assert.equal(pluginConfiguration.result.frozen, true);

  const injection = "$(touch should-not-exist); `id`; ../../";
  const echoed = await server.tool("app_safe_app_echo", { value: injection });
  assert.equal(echoed.result.value, injection);
  assert.equal(fs.existsSync(path.join(stateRoot, "should-not-exist")), false);
  assert.match(
    await server.tool("app_safe_app_echo", { value: "x", extra: true }, true),
    /extra is not allowed/,
  );
  assert.match(await server.tool("app_safe_app_echo", { value: "x" }, true), /too short/);
  assert.match(await server.tool("app_safe_app_echo", { value: "ok", count: 0 }, true), /below minimum/);
  assert.match(await server.tool("app_safe_app_echo", { value: "ok", count: 4 }, true), /above maximum/);
  assert.match(await server.tool("app_safe_app_echo", { value: "ok", mode: "other" }, true), /constant/);
  assert.match(await server.tool("app_safe_app_echo", { value: "ok", labels: [] }, true), /too few items/);
  assert.match(await server.tool("app_safe_app_echo", { value: "ok", optional: false }, true), /string or null/);
  assert.equal((await server.tool("app_safe_app_echo", { value: "ok", optional: null })).result.value, "ok");

  const privateFailure = await server.tool("app_safe_app_fail_private", {}, true);
  assert.equal(privateFailure, "application plugin operation failed");
  assert.equal(privateFailure.includes(privateCanary), false);
  assert.equal(privateFailure.includes("/private/adapter/path"), false);
  const failedRunStatus = await server.tool("application_plugin_status", {
    operation: "fail_private",
  });
  assert.equal(failedRunStatus.runs[0].error, "application plugin operation failed");
  assert.equal(JSON.stringify(failedRunStatus).includes(privateCanary), false);
  const failedRunAudit = await server.tool("list_audit_events", {
    object_type: "application_plugin",
  });
  assert.equal(JSON.stringify(failedRunAudit).includes(privateCanary), false);

  const unauthorizedJob = await server.tool("create_job", {
    kind: "generic-work", title: "Generic fixture", requires_authorization: true,
  });
  assert.match(
    await server.tool("app_safe_app_authorized", { job_id: unauthorizedJob.job_id }, true),
    /authorization is not recorded/,
  );
  await server.tool("update_job_status", {
    job_id: unauthorizedJob.job_id,
    state: "authorized",
    authorization_evidence: "recorded fixture authorization",
  });
  const authorized = await server.tool("app_safe_app_authorized", { job_id: unauthorizedJob.job_id });
  assert.equal(authorized.result.authorization_state, "recorded");
  const otherKindJob = await server.tool("create_job", {
    kind: "other-work", title: "Other generic fixture", requires_authorization: true,
  });
  await server.tool("update_job_status", {
    job_id: otherKindJob.job_id,
    state: "authorized",
    authorization_evidence: "recorded fixture authorization",
  });
  assert.match(
    await server.tool("app_safe_app_authorized", { job_id: otherKindJob.job_id }, true),
    /kind does not match/,
  );
  await server.tool("update_job_status", { job_id: unauthorizedJob.job_id, state: "queued" });
  assert.match(
    await server.tool("app_safe_app_authorized", { job_id: unauthorizedJob.job_id }, true),
    /state is not authorized/,
  );
  assert.match(await server.tool("app_safe_app_authorized", { job_id: "job-missing" }, true), /not found/);
  const authorizationAudit = await server.tool("list_audit_events", { object_type: "job" });
  assert.equal(authorizationAudit.some((event) =>
    event.action === "authorize" && event.result === "allowed" &&
    event.details.plugin_id === "safe-app"), true);
  assert.equal(authorizationAudit.some((event) =>
    event.action === "authorize" && event.result === "denied" &&
    event.details.plugin_id === "safe-app"), true);
  assert.match(await server.tool("app_safe_app_controller_only", {}, true), /not authorized/);
  assert.match(await server.tool("app_safe_app_flagged", {}, true), /feature flag is disabled/);
  const artifactRun = await server.tool("app_safe_app_artifact", { content: "safe fixture artifact\n" });
  assert.match(artifactRun.result.artifact_id, /^artifact-/);
  const artifactsBeforeDeniedPlugin = await server.tool("list_artifacts");
  assert.equal(await server.tool("app_unscoped_app_artifact", {}, true), "application plugin operation failed");
  assert.equal((await server.tool("list_artifacts")).length, artifactsBeforeDeniedPlugin.length);
  const verifiedArtifact = await server.tool("verify_artifact", {
    artifact_id: artifactRun.result.artifact_id,
    expected_sha256: artifactRun.result.sha256,
  });
  assert.equal(verifiedArtifact.matches, true);

  const pendingDelay = server.request("tools/call", {
    name: "app_safe_app_delay",
    arguments: {},
  });
  let activeRun;
  for (let attempt = 0; attempt < 20 && !activeRun; attempt += 1) {
    const current = await server.tool("application_plugin_status");
    activeRun = current.runs.find((run) => run.operation === "delay" && run.state === "running");
    if (!activeRun) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(activeRun, "delay run should become visible while active");
  const cancel = await server.tool("application_plugin_cancel", { run_id: activeRun.id });
  assert.equal(cancel.state, "cancel_requested");
  const cancelledResponse = await pendingDelay;
  assert.equal(cancelledResponse.result.isError, true);
  const afterCancel = await server.tool("application_plugin_status");
  assert.equal(afterCancel.runs.find((run) => run.id === activeRun.id).state, "cancelled");
  assert.deepEqual(
    (await server.tool("application_plugin_status", { run_id: activeRun.id })).runs.map((run) => run.id),
    [activeRun.id],
  );
  assert.equal((await server.tool("application_plugin_status", { plugin: "safe-app" })).runs.every((run) => run.plugin_id === "safe-app"), true);
  assert.equal((await server.tool("application_plugin_status", { operation: "delay" })).runs.every((run) => run.operation === "delay"), true);
  assert.equal((await server.tool("application_plugin_status", { state: "cancelled" })).runs.every((run) => run.state === "cancelled"), true);
  assert.match(await server.tool("application_plugin_status", { state: "unknown" }, true), /invalid plugin run state/);

  const link = await server.tool("link_status");
  assert.equal(link.local_control.enabled, true);
  assert.equal(link.local_control.host, "127.0.0.1");
  const pageResponse = await fetch(link.local_control.url);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /Behavior and compatibility/);
  assert.match(page, /Direction-specific capabilities/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /Configuration profiles/);
  assert.match(page, /Application quick starts/);
  assert.match(page, /const applicationPresetManagementEnabled=true/);
  assert.match(page, /Connections, credentials, paths, tokens, local-control/);
  assert.match(page, /Save connection settings/);
  assert.match(page, /const connectionManagementEnabled=true/);
  assert.match(page, /route-name">'\+safe\(name\)/);
  assert.match(page, /safe\(value\.host\|\|"Not configured"\)/);
  assert.match(page, /safe\(value\.transport_error\)/);
  assert.match(page, /Reset flags to defaults/);
  assert.match(page, /aria-label="'\+attributeText\(label\)\+' inbound"/);
  assert.match(page, /aria-label="'\+attributeText\(label\)\+'" data-config/);
  assert.match(page, /id="config-state" aria-live="polite"/);
  assert.match(page, /role="note" aria-label="Help: Choose a reviewed built-in starting point/);
  assert.match(page, /const profileManagementEnabled=true/);
  const token = page.match(/const token="([a-f0-9]+)"/)?.[1];
  assert.ok(token);
  const htmlCall = await fetch(`${link.local_control.url}api/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hawkspan-token": token },
    body: JSON.stringify({ tool_name: "app_safe_app_echo", arguments: { value: "html" } }),
  });
  assert.equal(htmlCall.status, 200);
  assert.equal((await htmlCall.json()).result.value, "html");
  const failedHtmlCall = await fetch(`${link.local_control.url}api/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hawkspan-token": token },
    body: JSON.stringify({ tool_name: "app_safe_app_fail_private", arguments: {} }),
  });
  assert.equal(failedHtmlCall.status, 400);
  const failedHtmlBody = JSON.stringify(await failedHtmlCall.json());
  assert.match(failedHtmlBody, /application plugin operation failed/);
  assert.equal(failedHtmlBody.includes(privateCanary), false);
  assert.equal(failedHtmlBody.includes("\/private\/adapter\/path"), false);
  const configurationCall = await fetch(`${link.local_control.url}api/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hawkspan-token": token },
    body: JSON.stringify({ tool_name: "get_configuration", arguments: {} }),
  });
  assert.equal(configurationCall.status, 200);
  assert.equal((await configurationCall.json()).role_profile, "symmetric");
  const profilesCall = await fetch(`${link.local_control.url}api/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hawkspan-token": token },
    body: JSON.stringify({ tool_name: "list_configuration_profiles", arguments: {} }),
  });
  assert.equal(profilesCall.status, 200);
  const profiles = (await profilesCall.json()).profiles;
  assert.equal(profiles.length, 4);
  assert.equal(profiles.some((profile) => profile.name === "High-value controller"), true);
  assert.equal(profiles.some((profile) => profile.id === "builtin-high-value-controller"), true);
  const applicationPresetsCall = await fetch(`${link.local_control.url}api/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hawkspan-token": token },
    body: JSON.stringify({ tool_name: "list_application_presets", arguments: {} }),
  });
  assert.equal(applicationPresetsCall.status, 200);
  assert.deepEqual((await applicationPresetsCall.json()).presets.map((preset) => preset.id), [
    "safe-app/headless-worker",
  ]);
  const deniedHtml = await fetch(`${link.local_control.url}api/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hawkspan-token": token },
    body: JSON.stringify({ tool_name: "run_command", arguments: { command: "true" } }),
  });
  assert.equal(deniedHtml.status, 400);
  await server.close();
  server = null;

  const legacyState = path.join(root, "legacy-html-allowlist-state");
  fs.mkdirSync(legacyState);
  const legacyServer = startServer(legacyState, {
    ...baseConfig,
    local_control: {
      ...baseConfig.local_control,
      allowed_tools: ["get_configuration", "update_configuration"],
    },
  });
  await legacyServer.request("initialize");
  const legacyLink = await legacyServer.tool("link_status");
  const legacyPage = await (await fetch(legacyLink.local_control.url)).text();
  assert.match(legacyPage, /const profileManagementEnabled=false/);
  assert.match(legacyPage, /const connectionManagementEnabled=false/);
  assert.match(legacyPage, /Profile tools not enabled/);
  await legacyServer.close();

  const peerState = path.join(root, "peer-state");
  fs.mkdirSync(peerState);
  const peerServer = startServer(peerState, {
    ...baseConfig,
    local_control: { enabled: false },
  }, { HAWKSPAN_CALL_ORIGIN: "peer" });
  await peerServer.request("initialize");
  assert.equal(
    (await peerServer.tool("app_safe_app_echo", { value: "peer" })).result.value,
    "peer",
  );
  assert.match(await peerServer.tool("app_safe_app_controller_only", {}, true), /not authorized/);
  await peerServer.close();

  const defaultState = path.join(root, "default-state");
  fs.mkdirSync(defaultState);
  const defaultServer = startServer(defaultState, {
    schema_version: 1,
    node_id: "default-test",
    peer: null,
  });
  await defaultServer.request("initialize");
  assert.deepEqual((await defaultServer.tool("application_plugin_status")).roles, ["controller", "worker"]);
  const defaultLink = await defaultServer.tool("link_status");
  assert.equal(defaultLink.local_control.enabled, true);
  assert.equal(defaultLink.local_control.host, "127.0.0.1");
  await defaultServer.close();

  const disabledState = path.join(root, "disabled-state");
  fs.mkdirSync(disabledState);
  const disabledServer = startServer(disabledState, {
    schema_version: 1,
    node_id: "disabled-test",
    local_control: { enabled: false },
    peer: null,
  });
  await disabledServer.request("initialize");
  assert.equal((await disabledServer.tool("link_status")).local_control.enabled, false);
  await disabledServer.close();

  const badBindState = path.join(root, "bad-bind");
  fs.mkdirSync(badBindState);
  writeJson(path.join(badBindState, "config.json"), {
    schema_version: 1,
    node_id: "bad-bind",
    local_control: { enabled: true, host: "0.0.0.0" },
    peer: null,
  });
  const badBind = spawnSync(process.execPath, [serverPath], {
    env: { ...process.env, HAWKSPAN_STATE_DIR: badBindState },
    input: "",
    encoding: "utf8",
  });
  assert.notEqual(badBind.status, 0);
  assert.match(badBind.stderr, /must be 127\.0\.0\.1/);

  const installState = path.join(root, "install-state");
  fs.mkdirSync(installState);
  const installed = spawnSync(process.execPath, [installPath, examplePath], {
    env: { ...process.env, HAWKSPAN_STATE_DIR: installState },
    encoding: "utf8",
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.existsSync(path.join(installState, "plugins", "hello-world")), true);
  const duplicate = spawnSync(process.execPath, [installPath, examplePath], {
    env: { ...process.env, HAWKSPAN_STATE_DIR: installState },
    encoding: "utf8",
  });
  assert.notEqual(duplicate.status, 0);
  const uninstalled = spawnSync(process.execPath, [uninstallPath, "hello-world"], {
    env: { ...process.env, HAWKSPAN_STATE_DIR: installState },
    encoding: "utf8",
  });
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(fs.existsSync(path.join(installState, "plugins", "hello-world")), false);
  assert.equal(fs.readdirSync(path.join(installState, "uninstalled-plugins")).length, 1);

  const recoveryState = path.join(root, "recovery");
  fs.mkdirSync(recoveryState);
  const recoveryServerOne = startServer(recoveryState, {
    schema_version: 1,
    node_id: "recovery",
    peer: null,
  });
  await recoveryServerOne.request("initialize");
  await recoveryServerOne.close();
  const recoveryDb = new DatabaseSync(path.join(recoveryState, "spool.sqlite3"));
  recoveryDb.prepare(`
    INSERT INTO plugin_runs
      (id,plugin_id,operation,origin,state,created_at,updated_at)
    VALUES ('stale-run','fixture','work','local','running',datetime('now'),datetime('now'))
  `).run();
  recoveryDb.close();
  const recoveryServerTwo = startServer(recoveryState, {
    schema_version: 1,
    node_id: "recovery",
    peer: null,
  });
  await recoveryServerTwo.request("initialize");
  const recovered = await recoveryServerTwo.tool("application_plugin_status");
  assert.equal(recovered.runs.find((run) => run.id === "stale-run").state, "interrupted");
  await recoveryServerTwo.close();

  process.stdout.write("hawkspan application-plugin and local-control tests passed\n");
} finally {
  if (server) await server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
