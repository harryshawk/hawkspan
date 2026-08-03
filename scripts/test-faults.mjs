#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-faults-"));
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
const fallbackMarker = path.join(root, "use-fallback");

function executable(name, body) {
  const target = path.join(bin, name);
  fs.writeFileSync(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

executable("ping", `
case "$*" in
  *primary.test*) test -f "$HAWKSPAN_FALLBACK_MARKER" && exit 1; exit 0 ;;
  *fallback.test*) exit 0 ;;
esac
exit 1
`);
executable("ssh", `
printf '%s\\n' "$*" >> "$HAWKSPAN_SSH_CAPTURE"
case "$*" in
  *primary.test*) test -f "$HAWKSPAN_FALLBACK_MARKER" && exit 1; test "$1" = "-o"; printf '{"content":[{"type":"text","text":"primary-ok"}],"isError":false}\\n'; exit 0 ;;
  *fallback.test*true*) exit 0 ;;
  *fallback.test*) printf '{"content":[{"type":"text","text":"fallback-ok"}],"isError":false}\\n'; exit 0 ;;
esac
exit 1
`);

fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
  schema_version: 1,
  node_id: "fault-test-a",
  peer: {
    node_id: "fault-test-b",
    user: "peer",
    primary_host: "primary.test",
    fallback_host: "fallback.test",
    remote_node: "/usr/bin/node",
    remote_call_tool: "/opt/hawkspan/scripts/call-tool.mjs",
    allowed_tools: ["app_synthetic_render_render"],
  },
}, null, 2)}\n`);
const sshCapture = path.join(root, "ssh-arguments.txt");

const server = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "mcp-server.mjs",
);
const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HAWKSPAN_STATE_DIR: root,
    HAWKSPAN_SSH_CAPTURE: sshCapture,
    HAWKSPAN_FALLBACK_MARKER: fallbackMarker,
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
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: requestId, method, params,
  })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
    pending.set(requestId, { resolve, reject, timer });
  });
}

async function tool(name, args = {}) {
  const response = await request("tools/call", { name, arguments: args });
  assert.equal(response.result.isError, false, JSON.stringify(response));
  return response.result.structuredContent;
}

try {
  await request("initialize");
  const primaryStatus = await tool("link_status");
  assert.equal(primaryStatus.routes[0].transport_ready, true);
  assert.equal(primaryStatus.selected_route, "[configured]");
  assert.equal(primaryStatus.selected_route_role, "primary");
  const primaryCall = await tool("peer_call_tool", {
    tool_name: "list_jobs",
    arguments: {},
  });
  assert.equal(primaryCall.host, "primary.test");
  const unchangedArguments = { state: "completed", nested: { timeout_ms: 17 } };
  const longCall = await tool("peer_call_tool", {
    tool_name: "list_jobs",
    arguments: unchangedArguments,
    timeout_ms: 4 * 60 * 60 * 1000,
  });
  assert.equal(longCall.host, "primary.test");
  const longCallSsh = fs.readFileSync(sshCapture, "utf8").split("\n")
    .find((line) => line.includes("HAWKSPAN_CALL_TIMEOUT_MS=14400000"));
  assert.ok(longCallSsh, "peer timeout was not forwarded to the remote call environment");
  assert.ok(longCallSsh.includes(`'${JSON.stringify(unchangedArguments)}'`),
    "peer timeout forwarding changed the remote tool arguments");
  assert.equal(longCallSsh.includes('"timeout_ms":14400000'), false,
    "peer timeout leaked into remote tool arguments");
  const excessiveTimeout = await request("tools/call", {
    name: "peer_call_tool",
    arguments: { tool_name: "list_jobs", arguments: {}, timeout_ms: 4 * 60 * 60 * 1000 + 1 },
  });
  assert.equal(excessiveTimeout.result.isError, true);

  fs.writeFileSync(fallbackMarker, "owner-assisted fixture\n");
  const status = await tool("link_status");
  assert.equal(status.routes[0].role, "primary");
  assert.equal(status.routes[0].transport_ready, false);
  assert.equal(status.routes[1].role, "fallback");
  assert.equal(status.routes[1].transport_ready, true);
  assert.equal(status.selected_route, "[configured]");
  assert.equal(status.selected_route_role, "fallback");

  const called = await tool("peer_call_tool", {
    tool_name: "list_jobs",
    arguments: {},
  });
  assert.equal(called.host, "fallback.test");
  assert.equal(called.result.isError, false);
  const capturedSsh = fs.readFileSync(sshCapture, "utf8");
  assert.match(capturedSsh, /StrictHostKeyChecking=yes/);
  assert.match(
    capturedSsh,
    new RegExp(`UserKnownHostsFile=${path.join(root, "ssh", "known_hosts")}`),
  );

  const pluginCalled = await tool("peer_call_tool", {
    tool_name: "app_synthetic_render_render",
    arguments: { title: "Live test" },
  });
  assert.equal(pluginCalled.host, "fallback.test");
  assert.equal(pluginCalled.result.isError, false);

  const rejected = await request("tools/call", {
    name: "peer_call_tool",
    arguments: { tool_name: "not_allowlisted", arguments: {} },
  });
  assert.equal(rejected.result.isError, true);
  process.stdout.write("hawkspan route-fallback and allowlist tests passed\n");
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
