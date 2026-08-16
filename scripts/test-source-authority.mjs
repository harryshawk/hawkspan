#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertSourceLineage,
  createReleaseProvenance,
  verifyPackagedRelease,
} from "./source-authority.mjs";

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-source-authority-"));
const repositoryRoot = path.join(temporaryRoot, "repository");
fs.mkdirSync(path.join(repositoryRoot, ".codex-plugin"), { recursive: true });
fs.mkdirSync(path.join(repositoryRoot, "config"), { recursive: true });
fs.mkdirSync(path.join(repositoryRoot, "acceptance"), { recursive: true });
git(repositoryRoot, "init", "-b", "main");
git(repositoryRoot, "config", "user.name", "HawkSpan Test");
git(repositoryRoot, "config", "user.email", "hawkspan-test@example.invalid");
fs.writeFileSync(path.join(repositoryRoot, "baseline.txt"), "public baseline\n");
fs.writeFileSync(path.join(repositoryRoot, "ARCHITECTURE.md"), "Mixed-case root path.\n");
fs.writeFileSync(path.join(repositoryRoot, "acceptance", "evidence.md"), "Nested path.\n");
git(repositoryRoot, "add", "baseline.txt", "ARCHITECTURE.md", "acceptance/evidence.md");
git(repositoryRoot, "commit", "-m", "Public baseline");
const baseline = git(repositoryRoot, "rev-parse", "HEAD");
const sourceAuthority = {
  schema_version: 1,
  release_version: "0.3.8",
  canonical_repository: "https://github.com/harryshawk/hawkspan.git",
  production_branch: "main",
  staging_repository: "https://github.com/harryshawk/hawkspan-clean-staging.git",
  required_public_ancestor: baseline,
};
fs.writeFileSync(
  path.join(repositoryRoot, ".codex-plugin", "plugin.json"),
  `${JSON.stringify({ name: "hawkspan", version: "0.3.8" }, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(repositoryRoot, "config", "source-authority.json"),
  `${JSON.stringify(sourceAuthority, null, 2)}\n`,
);
git(repositoryRoot, "add", ".codex-plugin/plugin.json", "config/source-authority.json");
git(repositoryRoot, "commit", "-m", "Release candidate");
git(repositoryRoot, "remote", "add", "origin", "git@github.com:harryshawk/hawkspan.git");

const lineage = assertSourceLineage(repositoryRoot);
assert.equal(lineage.authority.required_public_ancestor, baseline);
assert.equal(lineage.revision, git(repositoryRoot, "rev-parse", "HEAD"));

fs.writeFileSync(path.join(repositoryRoot, "untracked.txt"), "not committed\n");
assert.throws(
  () => assertSourceLineage(repositoryRoot),
  /release source must be committed and clean/,
);
fs.unlinkSync(path.join(repositoryRoot, "untracked.txt"));
git(repositoryRoot, "remote", "set-url", "origin", "https://github.com/example/fork.git");
assert.throws(
  () => assertSourceLineage(repositoryRoot),
  /origin is not an authorized HawkSpan repository/,
);
git(repositoryRoot, "remote", "set-url", "origin", sourceAuthority.canonical_repository);

const packageRoot = path.join(temporaryRoot, "package");
fs.cpSync(repositoryRoot, packageRoot, {
  recursive: true,
  filter: (source) => path.basename(source) !== ".git",
});
const provenance = createReleaseProvenance(packageRoot, {
  revision: lineage.revision,
  tree: lineage.tree,
  sourceAuthority,
  publishedRepository: sourceAuthority.staging_repository,
  publishedRef: "refs/heads/test-release",
});
assert.equal(verifyPackagedRelease(packageRoot, lineage.revision).tree, provenance.tree);
fs.appendFileSync(path.join(packageRoot, "baseline.txt"), "changed\n");
assert.throws(
  () => verifyPackagedRelease(packageRoot, lineage.revision),
  /packaged release file differs from provenance/,
);
assert.throws(
  () => verifyPackagedRelease(packageRoot, "local-label"),
  /exact 40-character Git commit SHA/,
);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.stdout.write("source authority tests passed\n");
