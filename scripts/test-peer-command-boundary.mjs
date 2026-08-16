#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(scripts, "mcp-server.mjs");

function writeConfig(root, extra = {}) {
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    schema_version: 1,
    node_id: extra.node_id || "boundary-node",
    local_control: { enabled: false },
    peer: {
      node_id: "boundary-peer",
      user: "peeruser",
      remote_node: "/remote/node",
      remote_state_dir: "/Users/peeruser/.hawkspan",
      primary_enabled: true,
      primary_host: "192.0.2.11",
      fallback_enabled: false,
      ...(extra.peer || {}),
    },
    link: {
      operation_retry_delays_ms: [10],
      operation_attempt_timeout_ms: 1000,
      connect_timeout_ms: 1000,
      cycle_timeout_ms: 3000,
      server_alive_interval_seconds: 1,
      server_alive_count_max: 1,
      primary_reprobe_ms: 1000,
    },
    role_profile: extra.role_profile,
    node_role: extra.node_role ?? null,
    features: extra.features || {},
  }, null, 2)}\n`);
  return configPath;
}

function installFakeSsh(root) {
  const bin = path.join(root, "bin");
  const log = path.join(root, "ssh.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HAWKSPAN_TEST_SSH_LOG"
case "$*" in
  *installed-revision.json*)
    printf '%s\\n' '{"schema_version":2,"revision":"remote-test","active_release_root":"/remote/hawkspan"}'
    exit 0
    ;;
  *)
    printf '%s\\n' dispatched >> "$HAWKSPAN_TEST_SSH_LOG"
    printf '%s\\n' '{"isError":false,"structuredContent":{"ok":true,"extended":true}}'
    exit 0
    ;;
esac
`, { mode: 0o755 });
  return { bin, log };
}

async function withServer(root, env, fn) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      HAWKSPAN_STATE_DIR: root,
      HAWKSPAN_CONFIG: path.join(root, "config.json"),
      HAWKSPAN_LOCAL_CONTROL_DISABLED: "1",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sequence = 0;
  let buffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
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
  function settlePending(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }
  child.on("exit", (code, signal) => {
    if (pending.size) {
      settlePending(new Error(`server exited ${code ?? signal} before responding: ${stderr.trim()}`));
    }
  });
  function request(method, params = {}) {
    const id = ++sequence;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, 10000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
    });
  }
  const tool = (name, args = {}) => request("tools/call", { name, arguments: args });
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    return await fn({ tool });
  } finally {
    settlePending(new Error("server closed"));
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", resolve);
    });
  }
}

function assertError(result, pattern) {
  assert.equal(result.result.isError, true, JSON.stringify(result));
  assert.match(result.result.content[0].text, pattern);
}

function assertOk(result) {
  assert.equal(result.result.isError, false, result.result.content?.[0]?.text);
  return result.result.structuredContent;
}

function assertContainsSentinel(stdout, sentinel) {
  assert.equal(typeof stdout, "string");
  assert.match(stdout, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

function assertStartupFails(extra, pattern) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-bad-"));
  writeConfig(root, extra);
  const result = spawnSync(process.execPath, [serverPath], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      HAWKSPAN_STATE_DIR: root,
      HAWKSPAN_CONFIG: path.join(root, "config.json"),
      HAWKSPAN_LOCAL_CONTROL_DISABLED: "1",
    },
  });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(`${result.stderr}\n${result.stdout}`, pattern);
}

const reverseCommandFeatures = {
  allowed_peer_tools: { inbound: ["run_command"], outbound: ["run_command"] },
  allow_peer_commands: true,
  enable_broad_run_command: true,
};

const inboundRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-in-role-"));
writeConfig(inboundRoot, {
  node_id: "controller-mac",
  role_profile: "controller-worker",
  node_role: "controller",
});
await withServer(inboundRoot, { HAWKSPAN_CALL_ORIGIN: "peer" }, async ({ tool }) => {
  assertError(
    await tool("list_jobs", {}),
    /inbound peer tool is not allowed: list_jobs/,
  );
});

const inboundCommandDeniedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-in-cmd-"));
const inboundDeniedMarker = path.join(inboundCommandDeniedRoot, "must-not-run");
writeConfig(inboundCommandDeniedRoot, {
  node_id: "controller-mac",
  role_profile: "controller-worker",
  node_role: "controller",
  features: {
    allowed_peer_tools: { inbound: ["run_command"], outbound: "current" },
    enable_broad_run_command: { inbound: true, outbound: true },
  },
});
await withServer(inboundCommandDeniedRoot, { HAWKSPAN_CALL_ORIGIN: "peer" }, async ({ tool }) => {
  assertError(
    await tool("run_command", { command: `printf x > '${inboundDeniedMarker}'` }),
    /worker cannot command the controller unless allow_peer_commands is explicitly enabled/,
  );
  assert.equal(fs.existsSync(inboundDeniedMarker), false);
});

const inboundEnabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-in-on-"));
const inboundEnabledSentinel = `HAWKSPAN_BOUNDARY_${process.pid}_in`;
writeConfig(inboundEnabledRoot, {
  node_id: "controller-mac",
  role_profile: "controller-worker",
  node_role: "controller",
  features: reverseCommandFeatures,
});
await withServer(inboundEnabledRoot, { HAWKSPAN_CALL_ORIGIN: "peer" }, async ({ tool }) => {
  const allowed = assertOk(await tool("run_command", {
    command: `printf '%s' '${inboundEnabledSentinel}'`,
  }));
  assertContainsSentinel(allowed.stdout, inboundEnabledSentinel);
  assert.equal(allowed.ok, true);
});

const inboundAllowlistRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-in-list-"));
writeConfig(inboundAllowlistRoot, {
  features: {
    allowed_peer_tools: { inbound: ["list_audit_events"], outbound: "current" },
  },
});
await withServer(inboundAllowlistRoot, { HAWKSPAN_CALL_ORIGIN: "peer" }, async ({ tool }) => {
  assertError(
    await tool("list_jobs", {}),
    /inbound peer tool is not allowed: list_jobs/,
  );
  const events = assertOk(await tool("list_audit_events", { limit: 1 }));
  assert.equal(Array.isArray(events), true);
});

const outboundRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-out-"));
const outboundSsh = installFakeSsh(outboundRoot);
writeConfig(outboundRoot, {
  features: {
    allowed_peer_tools: { inbound: "current", outbound: ["link_status"] },
  },
});
await withServer(outboundRoot, {
  PATH: `${outboundSsh.bin}:${process.env.PATH}`,
  HAWKSPAN_TEST_SSH_LOG: outboundSsh.log,
}, async ({ tool }) => {
  assertError(
    await tool("peer_call_tool", { tool_name: "run_command", arguments: { command: "true" } }),
    /peer tool is not allowed: run_command/,
  );
  assert.equal(fs.existsSync(outboundSsh.log), false);
});

const outboundPeerKeyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-out-peer-"));
const outboundPeerSsh = installFakeSsh(outboundPeerKeyRoot);
writeConfig(outboundPeerKeyRoot, {
  peer: { allowed_tools: ["link_status"] },
  features: {
    allowed_peer_tools: { inbound: "current", outbound: ["link_status"] },
  },
});
await withServer(outboundPeerKeyRoot, {
  PATH: `${outboundPeerSsh.bin}:${process.env.PATH}`,
  HAWKSPAN_TEST_SSH_LOG: outboundPeerSsh.log,
}, async ({ tool }) => {
  assertError(
    await tool("peer_call_tool", { tool_name: "list_jobs", arguments: {} }),
    /peer tool is not allowed: list_jobs/,
  );
  assert.equal(fs.existsSync(outboundPeerSsh.log), false);
});

const outboundPeerExtendRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-out-ext-"));
const outboundPeerExtendSsh = installFakeSsh(outboundPeerExtendRoot);
writeConfig(outboundPeerExtendRoot, {
  peer: { allowed_tools: ["app_synthetic_render_render"] },
  features: {
    allowed_peer_tools: { inbound: "current", outbound: "current" },
  },
});
await withServer(outboundPeerExtendRoot, {
  PATH: `${outboundPeerExtendSsh.bin}:${process.env.PATH}`,
  HAWKSPAN_TEST_SSH_LOG: outboundPeerExtendSsh.log,
}, async ({ tool }) => {
  assertError(
    await tool("peer_call_tool", { tool_name: "not_a_peer_tool", arguments: {} }),
    /peer tool is not allowed: not_a_peer_tool/,
  );
  const sent = assertOk(await tool("peer_call_tool", {
    tool_name: "app_synthetic_render_render",
    arguments: {},
  }));
  assert.equal(sent.tool_name, "app_synthetic_render_render");
  assert.match(fs.readFileSync(outboundPeerExtendSsh.log, "utf8"), /dispatched/);
});

const broadOffRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-broad-off-"));
const broadOffMarker = path.join(broadOffRoot, "broad-must-not-run");
writeConfig(broadOffRoot, {
  features: {
    enable_broad_run_command: { inbound: false, outbound: false },
  },
});
await withServer(broadOffRoot, { HAWKSPAN_CALL_ORIGIN: "peer" }, async ({ tool }) => {
  assertError(
    await tool("run_command", { command: `printf x > '${broadOffMarker}'` }),
    /broad run_command is disabled for inbound peer use/,
  );
  assert.equal(fs.existsSync(broadOffMarker), false);
});

const broadOnRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-broad-on-"));
const broadOnSentinel = `HAWKSPAN_BOUNDARY_${process.pid}_broad`;
writeConfig(broadOnRoot, {
  features: {
    enable_broad_run_command: { inbound: true, outbound: true },
  },
});
await withServer(broadOnRoot, { HAWKSPAN_CALL_ORIGIN: "peer" }, async ({ tool }) => {
  const allowed = assertOk(await tool("run_command", {
    command: `printf '%s' '${broadOnSentinel}'`,
  }));
  assertContainsSentinel(allowed.stdout, broadOnSentinel);
});

const workerOutboundRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-worker-role-"));
const workerSsh = installFakeSsh(workerOutboundRoot);
writeConfig(workerOutboundRoot, {
  node_id: "worker-mac",
  role_profile: "controller-worker",
  node_role: "worker",
});
await withServer(workerOutboundRoot, {
  PATH: `${workerSsh.bin}:${process.env.PATH}`,
  HAWKSPAN_TEST_SSH_LOG: workerSsh.log,
}, async ({ tool }) => {
  assertError(
    await tool("peer_call_tool", { tool_name: "list_jobs", arguments: {} }),
    /peer tool is not allowed: list_jobs/,
  );
  assert.equal(fs.existsSync(workerSsh.log), false);
});

const workerOutboundDeniedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-worker-cmd-"));
const workerDeniedSsh = installFakeSsh(workerOutboundDeniedRoot);
writeConfig(workerOutboundDeniedRoot, {
  node_id: "worker-mac",
  role_profile: "controller-worker",
  node_role: "worker",
  features: {
    allowed_peer_tools: { inbound: "current", outbound: ["run_command"] },
    enable_broad_run_command: { inbound: true, outbound: true },
  },
});
await withServer(workerOutboundDeniedRoot, {
  PATH: `${workerDeniedSsh.bin}:${process.env.PATH}`,
  HAWKSPAN_TEST_SSH_LOG: workerDeniedSsh.log,
}, async ({ tool }) => {
  assertError(
    await tool("peer_call_tool", { tool_name: "run_command", arguments: { command: "true" } }),
    /worker cannot command the controller unless allow_peer_commands is explicitly enabled/,
  );
  assert.equal(fs.existsSync(workerDeniedSsh.log), false);
});

const workerOutboundOnRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-worker-out-on-"));
const workerOnSsh = installFakeSsh(workerOutboundOnRoot);
writeConfig(workerOutboundOnRoot, {
  node_id: "worker-mac",
  role_profile: "controller-worker",
  node_role: "worker",
  features: reverseCommandFeatures,
});
await withServer(workerOutboundOnRoot, {
  PATH: `${workerOnSsh.bin}:${process.env.PATH}`,
  HAWKSPAN_TEST_SSH_LOG: workerOnSsh.log,
}, async ({ tool }) => {
  const sent = assertOk(await tool("peer_call_tool", {
    tool_name: "run_command",
    arguments: { command: "true" },
  }));
  assert.equal(sent.tool_name, "run_command");
  assert.match(fs.readFileSync(workerOnSsh.log, "utf8"), /dispatched/);
});

const symmetricRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-sym-"));
const symmetricSentinel = `HAWKSPAN_BOUNDARY_${process.pid}_sym`;
const symmetricSsh = installFakeSsh(symmetricRoot);
writeConfig(symmetricRoot, {
  node_id: "symmetric-mac",
});
await withServer(symmetricRoot, {
  HAWKSPAN_CALL_ORIGIN: "peer",
  PATH: `${symmetricSsh.bin}:${process.env.PATH}`,
  HAWKSPAN_TEST_SSH_LOG: symmetricSsh.log,
}, async ({ tool }) => {
  const allowed = assertOk(await tool("run_command", {
    command: `printf '%s' '${symmetricSentinel}'`,
  }));
  assertContainsSentinel(allowed.stdout, symmetricSentinel);
  const jobs = assertOk(await tool("list_jobs", {}));
  assert.equal(Array.isArray(jobs), true);
});

const symmetricOutboundRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-boundary-sym-out-"));
const symmetricOutboundSsh = installFakeSsh(symmetricOutboundRoot);
writeConfig(symmetricOutboundRoot, {
  node_id: "symmetric-mac",
});
await withServer(symmetricOutboundRoot, {
  PATH: `${symmetricOutboundSsh.bin}:${process.env.PATH}`,
  HAWKSPAN_TEST_SSH_LOG: symmetricOutboundSsh.log,
}, async ({ tool }) => {
  const sent = assertOk(await tool("peer_call_tool", {
    tool_name: "link_status",
    arguments: {},
  }));
  assert.equal(sent.tool_name, "link_status");
  assert.match(fs.readFileSync(symmetricOutboundSsh.log, "utf8"), /dispatched/);
});

assertStartupFails(
  { role_profile: "asymmetric" },
  /role_profile must be symmetric or controller-worker/,
);
assertStartupFails(
  { role_profile: "controller-worker" },
  /node_role is required for controller-worker/,
);
assertStartupFails(
  { features: { allow_peer_commands: "yes" } },
  /features.allow_peer_commands must be a boolean or an inbound\/outbound boolean object/,
);
assertStartupFails(
  { features: { enable_broad_run_command: "yes" } },
  /features.enable_broad_run_command must be a boolean or an inbound\/outbound boolean object/,
);
assertStartupFails(
  { features: { allowed_peer_tools: { inbound: "all", outbound: "current" } } },
  /features.allowed_peer_tools.inbound must be "current" or an array of exact tool names/,
);
assertStartupFails(
  { features: { allowed_peer_tools: { inbound: ["Not-A-Tool"], outbound: "current" } } },
  /features.allowed_peer_tools.inbound must be "current" or an array of exact tool names/,
);
assertStartupFails(
  { peer: { allowed_tools: "link_status" } },
  /peer.allowed_tools must be an array of exact tool names/,
);
assertStartupFails(
  { peer: { allowed_tools: ["bad tool"] } },
  /peer.allowed_tools must be an array of exact tool names/,
);

process.stdout.write("hawkspan peer/command boundary tests passed\n");
