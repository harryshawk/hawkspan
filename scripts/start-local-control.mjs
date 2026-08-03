#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { minimalChildEnvironment } from "./hawkspan-env.mjs";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs");
const child = spawn(process.execPath, [serverPath], {
  env: minimalChildEnvironment({
    ...(process.env.HAWKSPAN_STATE_DIR ? { HAWKSPAN_STATE_DIR: process.env.HAWKSPAN_STATE_DIR } : {}),
    ...(process.env.HAWKSPAN_CONFIG ? { HAWKSPAN_CONFIG: process.env.HAWKSPAN_CONFIG } : {}),
  }),
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
let ready = false;
const timeout = setTimeout(() => {
  process.stderr.write("timed out starting HawkSpan local control\n");
  child.kill("SIGTERM");
  process.exitCode = 1;
}, 30000);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    if (response.id !== 2) continue;
    const status = response.result?.structuredContent;
    const url = status?.local_control?.url;
    if (response.result?.isError || !status?.local_control?.enabled || !url) {
      clearTimeout(timeout);
      process.stderr.write("HawkSpan local control did not become available\n");
      child.kill("SIGTERM");
      process.exitCode = 1;
      continue;
    }
    ready = true;
    clearTimeout(timeout);
    process.stdout.write(`HawkSpan dashboard: ${url}\n`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

child.once("exit", (code, signal) => {
  clearTimeout(timeout);
  if (signal && signal !== "SIGTERM") process.kill(process.pid, signal);
  else if ((code ?? 0) !== 0 || !ready) process.exitCode = code || 1;
});

child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "hawkspan-local-control", version: "1" },
  },
})}\n`);
child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: "link_status", arguments: {} },
})}\n`);
