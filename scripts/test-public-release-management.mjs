#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

const issueForms = [
  [".github/ISSUE_TEMPLATE/bug.yml", "bug"],
  [".github/ISSUE_TEMPLATE/installation.yml", "installation"],
  [".github/ISSUE_TEMPLATE/feature.yml", "feature"],
];

for (const [relative, label] of issueForms) {
  const content = read(relative);
  assert.match(content, new RegExp(`\\n  - ${label}\\n`));
  assert.match(content, /private|credentials|machine-specific/i);
  assert.match(content, /required: true/);
}

const issueConfig = read(".github/ISSUE_TEMPLATE/config.yml");
assert.match(issueConfig, /blank_issues_enabled: false/);
assert.match(issueConfig, /security\/advisories\/new/);

const security = read("SECURITY.md");
assert.match(security, /security\/advisories\/new/);

const support = read("SUPPORT.md");
assert.match(support, /scripts\/check-release\.sh/);
assert.match(support, /private vulnerability/i);

const releaseGate = read(".github/workflows/release-gate.yml");
assert.match(releaseGate, /runs-on: macos-14/);
assert.match(releaseGate, /brew install ripgrep/);
assert.match(releaseGate, /github\.event\.pull_request\.head\.sha \|\| github\.sha/);
assert.match(releaseGate, /zsh scripts\/check-release\.sh/);
assert.doesNotMatch(releaseGate, /uses: actions\/(?:checkout|setup-node)@v\d/);

const traffic = read(".github/workflows/traffic-snapshot.yml");
for (const endpoint of ["views", "clones", "popular/referrers", "popular/paths"]) {
  assert.match(traffic, new RegExp(`traffic/${endpoint.replace("/", "\\/")}`));
}
assert.match(traffic, /HEAD:traffic-history/);
assert.match(traffic, /metrics@hawkspan\.invalid/);
assert.doesNotMatch(traffic, /users|stargazers|subscribers/);

const releaseNotes = read("release/RELEASE_NOTES.md");
assert.match(releaseNotes, /HawkSpan 0\.1\.0/);
assert.match(releaseNotes, /SHA256SUMS/);
assert.match(releaseNotes, /Known limitations/);

console.log("public release management checks passed");
