#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyHawkspanEnv, minimalChildEnvironment, readHawkspanEnv } from "./hawkspan-env.mjs";

const stateRoot = path.resolve(
  process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"),
);
const configPath = path.join(stateRoot, "config.json");
const configuration = applyHawkspanEnv(
  JSON.parse(fs.readFileSync(configPath, "utf8")),
  readHawkspanEnv(path.join(stateRoot, "hawkspan.env")),
);
const port = Number(configuration.local_control?.port);

if (!configuration.local_control?.enabled) {
  throw new Error("local_control must be enabled");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("persistent local control requires a fixed port from 1 through 65535");
}

const serverPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "mcp-server.mjs",
);
const child = spawn(process.execPath, [serverPath], {
  env: minimalChildEnvironment({
    ...(process.env.HAWKSPAN_STATE_DIR ? { HAWKSPAN_STATE_DIR: process.env.HAWKSPAN_STATE_DIR } : {}),
    ...(process.env.HAWKSPAN_CONFIG ? { HAWKSPAN_CONFIG: process.env.HAWKSPAN_CONFIG } : {}),
  }),
  stdio: ["pipe", "ignore", "inherit"],
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
