#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guide = fs.readFileSync(path.join(repository, "AGENTS.md"), "utf8");
const claude = fs.readFileSync(path.join(repository, "CLAUDE.md"), "utf8");

for (const required of [
  "two Macs owned and trusted by the same person",
  "Coexistence is the default",
  "Never commit local installation data",
  "~/.hawkspan/hawkspan.env",
  "strict allowlisted parser",
  "Owner checkpoints",
  "scripts/check-release.sh",
  "release/release-manifest.json",
  "tree-sha256:",
  "strict host-key checking",
  "127.0.0.1",
  "symmetric",
  "controller/worker",
  "peer.allow_remote_wake",
  "link_status",
  "SHA-256",
  "scripts/install-link-agent.sh",
  "scripts/install-local-control-agent.sh",
  "scripts/uninstall-hawkspan.sh --confirm",
  "~/.hawkspan-uninstalled",
  "Required completion report",
]) {
  assert.ok(guide.includes(required), `AGENTS.md is missing: ${required}`);
}

assert.match(claude, /AGENTS\.md/);
const example = JSON.parse(fs.readFileSync(path.join(repository, "config/example.json"), "utf8"));
assert.equal(example.peer.allow_remote_wake, false);
assert.deepEqual(example.application_plugins.core_tool_allowlist, []);
assert.deepEqual(example.application_plugins.entries["example-plugin"].core_tool_allowlist, []);
const simpleTunerSetup = fs.readFileSync(path.join(repository, "docs/SIMPLETUNER-SETUP.md"), "utf8");
for (const tool of ["verify_artifact", "register_artifact", "send_artifact"]) assert.ok(simpleTunerSetup.includes(tool));
for (const key of ["node_id", "plugin_root"]) assert.equal(Object.hasOwn(example, key), false);
for (const key of ["node_id", "user", "primary_host", "fallback_host", "ssh_identity"])
  assert.equal(Object.hasOwn(example.peer, key), false);
const envExample = fs.readFileSync(path.join(repository, "config/hawkspan.env.example"), "utf8");
assert.match(envExample, /HAWKSPAN_SSH_IDENTITY=\/Users\/localuser\/\.ssh\/hawkspan_peer/);
assert.doesNotMatch(envExample, /BEGIN (?:OPENSSH|RSA) PRIVATE KEY/);
assert.doesNotMatch(guide, /\/Users\/(?!localuser|peeruser)/);
assert.doesNotMatch(guide, /(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d/);
process.stdout.write("hawkspan agent installation guide tests passed\n");
