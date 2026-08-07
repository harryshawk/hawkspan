#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertProductSeparated, auditProductSeparation } from "./product-separation.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
assertProductSeparated(root);

const contaminated = fs.mkdtempSync(path.join(path.dirname(root), ".separation-test-"));
try {
  fs.mkdirSync(path.join(contaminated, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(contaminated, ".codex-plugin/plugin.json"), JSON.stringify({
    name: "hawkspan", interface: { displayName: "HawkSpan" },
  }));
  fs.writeFileSync(path.join(contaminated, ".mcp.json"), JSON.stringify({
    mcpServers: { hawkspan: {} },
  }));
  fs.mkdirSync(path.join(contaminated, "scripts"));
  fs.writeFileSync(
    path.join(contaminated, "scripts", "bad.mjs"),
    `const state = process.env.${["CODEX", "MAC", "LINK"].join("_")}_STATE_DIR;\n` +
      "const trainer_queue_policy = { schedule_decision: 'overnight_window' };\n",
  );
  fs.linkSync(
    path.join(contaminated, "scripts", "bad.mjs"),
    path.join(contaminated, "scripts", "hard-linked.mjs"),
  );
  fs.writeFileSync(
    path.join(contaminated, "scripts", [["codex", "mac", "link"].join("-"), "agent.mjs"].join("-")),
    "export default true;\n",
  );
  const result = auditProductSeparation(contaminated);
  assert.equal(result.valid, false);
  assert(result.violations.some((entry) => entry.path === "scripts/bad.mjs"));
  assert(result.violations.some((entry) => entry.reason.includes("hard-linked")));
  assert(result.violations.some((entry) => entry.reason.includes("path contains predecessor identifier")));
  assert(result.violations.some((entry) => entry.reason.includes("alternate trainer queue policy")));
  assert(result.violations.some((entry) => entry.reason.includes("time-window scheduling decision")));

  const releaseGate = spawnSync(path.join(root, "scripts", "check-release.sh"), [
    "--release-root", contaminated,
  ], {
    encoding: "utf8",
    env: { ...process.env, NODE: process.execPath },
  });
  assert.notEqual(releaseGate.status, 0);
  assert.match(releaseGate.stderr, /product separation failed/i);
} finally {
  fs.rmSync(contaminated, { recursive: true, force: true });
}

process.stdout.write("HawkSpan product-separation tests passed\n");
