#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { minimalChildEnvironment } from "./hawkspan-env.mjs";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs");
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...minimalChildEnvironment({
      ...(process.env.HAWKSPAN_STATE_DIR ? { HAWKSPAN_STATE_DIR: process.env.HAWKSPAN_STATE_DIR } : {}),
      ...(process.env.HAWKSPAN_CONFIG ? { HAWKSPAN_CONFIG: process.env.HAWKSPAN_CONFIG } : {}),
    }),
    HAWKSPAN_LOCAL_CONTROL_DISABLED: "1",
    HAWKSPAN_BACKGROUND: "1",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const timeout = setTimeout(() => {
  process.stderr.write("hawkspan agent timed out\n");
  child.kill("SIGTERM");
  process.exitCode = 1;
}, 120000);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    if (response.id !== 1) continue;
    clearTimeout(timeout);
    const content = response.result?.structuredContent || response.error || response.result;
    process.stdout.write(`${new Date().toISOString()} ${JSON.stringify(content)}\n`);
    child.stdin.end();
  }
});

child.once("exit", (code) => {
  clearTimeout(timeout);
  if (code && process.exitCode === undefined) process.exitCode = code;
});

child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "flush_outbox", arguments: { wake: true } },
})}\n`);
