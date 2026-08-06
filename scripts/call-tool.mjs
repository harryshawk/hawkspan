#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

const [toolName, rawArguments = "{}"] = process.argv.slice(2);
if (!toolName) {
  process.stderr.write("usage: call-tool.mjs TOOL_NAME [JSON_ARGUMENTS]\n");
  process.exit(2);
}

let toolArguments;
try {
  toolArguments = JSON.parse(rawArguments);
} catch (error) {
  process.stderr.write(`invalid JSON arguments: ${error.message}\n`);
  process.exit(2);
}

const configuredTimeout = Number(process.env.HAWKSPAN_CALL_TIMEOUT_MS || 0);
const operationTimeout = Number(toolArguments?.timeout_ms || 0);
const requestTimeoutMs = Math.max(
  30000,
  Number.isFinite(configuredTimeout) ? configuredTimeout : 0,
  Number.isFinite(operationTimeout) ? operationTimeout + 15000 : 0,
);

const serverPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "mcp-server.mjs",
);
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    ...(process.env.HAWKSPAN_CALL_ORIGIN
      ? { HAWKSPAN_CALL_ORIGIN: process.env.HAWKSPAN_CALL_ORIGIN }
      : {}),
    HAWKSPAN_LOCAL_CONTROL_DISABLED: "1",
  },
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
  const id = ++sequence;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, requestTimeoutMs);
    pending.set(id, { resolve, timer });
  });
}

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "hawkspan-cli", version: "1" },
});
const response = await request("tools/call", {
  name: toolName,
  arguments: toolArguments,
});
if (response.error) {
  process.stderr.write(`${JSON.stringify(response.error, null, 2)}\n`);
  process.exitCode = 1;
} else {
  const stream = response.result?.isError ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(response.result, null, 2)}\n`);
  if (response.result?.isError) process.exitCode = 1;
}
child.stdin.end();
await new Promise((resolve) => child.once("exit", resolve));
