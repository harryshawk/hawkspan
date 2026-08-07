#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
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

const license = fs.readFileSync(path.join(releaseRoot, "LICENSE"), "utf8");
assert.match(license, /^MIT License$/m);
assert.match(license, /Copyright \(c\) 2026 Harry Hawk/);
assert.match(license, /Permission is hereby granted, free of charge/);

for (const relativePath of [
  "README.md",
  "NOTICE",
  "static/media/help/README.md",
]) {
  const text = fs.readFileSync(path.join(releaseRoot, relativePath), "utf8");
  assert.match(text, /MIT License/);
}

const scriptsRoot = path.join(releaseRoot, "scripts");
const pythonExecutable = process.env.PYTHON || "python3";
const tests = fs.readdirSync(scriptsRoot)
  .filter((name) => /^test-.*\.(mjs|py)$/.test(name))
  .sort();

for (const test of tests) {
  const executable = test.endsWith(".py") ? pythonExecutable : process.execPath;
  const result = spawnSync(executable, [path.join(scriptsRoot, test)], {
    cwd: releaseRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE: process.execPath,
      PYTHON: pythonExecutable,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`release test failed (${result.status}): ${test}`);
  }
}

process.stdout.write(`HawkSpan release gate passed (${tests.length} tests)\n`);
