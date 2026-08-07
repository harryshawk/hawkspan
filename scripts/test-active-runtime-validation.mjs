#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const automationScript = path.join(scriptsRoot, "lora-automation.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-runtime-validation-"));
const runtimeRoot = path.join(root, "runtime");
const runtimeConfig = path.join(runtimeRoot, "hawkspan-runtime-config.json");
const runtimeRegistry = path.join(runtimeRoot, "lora-registry.json");
const mainConfig = path.join(root, "config.json");

fs.mkdirSync(runtimeRoot, { recursive: true });
fs.writeFileSync(mainConfig, `${JSON.stringify({ lora_automation: {} })}\n`);
fs.writeFileSync(
  runtimeConfig,
  `${JSON.stringify({ lora_automation: { registry_path: runtimeRegistry } })}\n`,
);
fs.writeFileSync(runtimeRegistry, `${JSON.stringify({ schema_version: 1, revisions: {} })}\n`);
fs.writeFileSync(
  path.join(root, "active-lora-runtime.json"),
  `${JSON.stringify({ config_path: runtimeConfig, runtime_root: runtimeRoot })}\n`,
);

for (const action of ["draw-things-plan", "draw-things-ingest"]) {
  const result = spawnSync(process.execPath, [
    automationScript,
    action,
    JSON.stringify({ job_id: "active-runtime-only" }),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HAWKSPAN_CONFIG: mainConfig,
      HAWKSPAN_STATE_DIR: root,
    },
  });
  assert.notEqual(result.status, 0, `${action} unexpectedly succeeded`);
  assert.match(
    result.stderr,
    /registry entry not found: active-runtime-only/,
    `${action} did not use the active runtime registry: ${result.stderr}`,
  );
  assert.doesNotMatch(result.stderr, /registry_path is not configured/);
}

process.stdout.write("active runtime validation delegation passed\n");
