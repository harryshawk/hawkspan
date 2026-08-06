#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertProductSeparated } from "./product-separation.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.dirname(scriptRoot);
const rootArgument = process.argv.indexOf("--release-root");
const releaseRoot = path.resolve(
  rootArgument === -1 ? defaultRoot : process.argv[rootArgument + 1] || "",
);

if (rootArgument !== -1 && !process.argv[rootArgument + 1]) {
  throw new Error("--release-root requires a path");
}

const separation = assertProductSeparated(releaseRoot);
process.stdout.write(`Product separation passed for ${separation.root}\n`);

const scriptsRoot = path.join(releaseRoot, "scripts");
const tests = fs.readdirSync(scriptsRoot)
  .filter((name) => /^test-.*\.(mjs|py)$/.test(name))
  .sort();

for (const test of tests) {
  const executable = test.endsWith(".py") ? "python3" : process.execPath;
  const result = spawnSync(executable, [path.join(scriptsRoot, test)], {
    cwd: releaseRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`release test failed (${result.status}): ${test}`);
  }
}

process.stdout.write(`HawkSpan release gate passed (${tests.length} tests)\n`);
