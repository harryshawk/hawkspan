#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const featureRoot = path.join(repository, "features");
const suiteScripts = {
  "suite-plugin": "scripts/test-application-plugins.mjs",
  "suite-synthetic": "scripts/test-synthetic-plugins.mjs",
  "suite-regression": "scripts/test-mcp.mjs",
  "suite-isolation": "scripts/test-isolation.mjs",
  "suite-flags": "scripts/test-configuration-flags.mjs",
  "suite-profiles": "scripts/test-configuration-profiles.mjs",
  "suite-connections": "scripts/test-connection-configuration.mjs",
  "suite-machine-env": "scripts/test-hawkspan-env.mjs",
  "suite-uninstall": "scripts/test-uninstall-hawkspan.mjs",
  "suite-real-pair-harness": "scripts/test-real-pair-acceptance.mjs",
  "suite-real-pair-adapter": "scripts/test-hawkspan-real-pair-adapter.mjs",
  "suite-release-tree": "scripts/test-release-tree.mjs",
  "suite-application-workflows": "scripts/test-application-workflows.mjs",
  "suite-simpletuner-examples": "scripts/test-simpletuner-example-bundle.mjs",
  "suite-faults": "scripts/test-faults.mjs",
};
const selectedSuites = new Set();
let automatedScenarios = 0;

for (const name of fs.readdirSync(featureRoot).filter((entry) => entry.endsWith(".feature"))) {
  const lines = fs.readFileSync(path.join(featureRoot, name), "utf8").split(/\r?\n/);
  let tags = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@")) {
      tags = trimmed.split(/\s+/).map((tag) => tag.slice(1));
      continue;
    }
    if (/^Scenario(?: Outline)?:/.test(trimmed)) {
      if (tags.includes("automated")) {
        automatedScenarios += 1;
        const suites = tags.filter((tag) => tag.startsWith("suite-"));
        assert.equal(suites.length, 1, `${name}: automated scenario needs exactly one suite tag`);
        assert.ok(suiteScripts[suites[0]], `${name}: unknown suite ${suites[0]}`);
        selectedSuites.add(suites[0]);
      }
      tags = [];
    }
  }
}
assert.ok(automatedScenarios > 0, "no automated Gherkin scenarios found");

for (const suite of selectedSuites) {
  const result = spawnSync(process.execPath, [path.join(repository, suiteScripts[suite])], {
    cwd: repository,
    encoding: "utf8",
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  assert.equal(result.status, 0, `${suite} failed`);
}
process.stdout.write(`hawkspan executable acceptance tests passed (${automatedScenarios} scenarios)\n`);
