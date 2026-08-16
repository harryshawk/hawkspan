#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditLocalRelease } from "./audit-release-authority.mjs";
import {
  HAWKSPAN_OPERATIONAL_ENV_DEFAULTS,
  readHawkspanEnv,
  writeHawkspanEnv,
} from "./hawkspan-env.mjs";
import { readReleaseAuthority, validateLiveReleaseConfiguration } from "./release-authority.mjs";
import { createReleaseProvenance } from "./source-authority.mjs";

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-release-authority-"));
const homeRoot = path.join(temporaryRoot, "home");
// State may live on an external SSD; the stable launcher still belongs under
// the user's HOME and must not be derived from the state volume.
const stateRoot = path.join(temporaryRoot, "external-state", ".hawkspan");
const launchAgentsRoot = path.join(homeRoot, "Library", "LaunchAgents");
// Keep the candidate outside HOME so activation must create the stable-link parent
// exactly as it would for a genuinely fresh installation.
const releaseRoot = path.join(temporaryRoot, "release-candidate");
const testRevision = "a".repeat(40);
const testTree = "b".repeat(40);
fs.mkdirSync(path.join(releaseRoot, "scripts"), { recursive: true });
fs.mkdirSync(path.join(releaseRoot, "launchd"), { recursive: true });
fs.mkdirSync(path.join(releaseRoot, ".codex-plugin"), { recursive: true });
fs.mkdirSync(path.join(releaseRoot, "config"), { recursive: true });
fs.copyFileSync(
  path.join(sourceRoot, ".codex-plugin/plugin.json"),
  path.join(releaseRoot, ".codex-plugin/plugin.json"),
);
fs.copyFileSync(path.join(sourceRoot, ".mcp.json"), path.join(releaseRoot, ".mcp.json"));
fs.copyFileSync(
  path.join(sourceRoot, "config", "source-authority.json"),
  path.join(releaseRoot, "config", "source-authority.json"),
);
const resolvedReleaseRoot = fs.realpathSync(releaseRoot);
for (const name of [
  "call-tool.mjs", "mcp-server.mjs", "m4-trainer-start.sh", "m4-trainer-stop.sh",
  "m4-trainer-package.sh", "run_captioned_loras.py.managed", "lora-automation.mjs",
  "build_return_packets.py.managed",
]) fs.writeFileSync(path.join(releaseRoot, "scripts", name), "\n");
fs.copyFileSync(
  path.join(sourceRoot, "scripts", "audit-release-authority.mjs"),
  path.join(releaseRoot, "scripts", "audit-release-authority.mjs"),
);
fs.copyFileSync(
  path.join(sourceRoot, "scripts", "product-separation.mjs"),
  path.join(releaseRoot, "scripts", "product-separation.mjs"),
);
for (const name of ["hawkspan-env.mjs", "release-authority.mjs"]) {
  fs.copyFileSync(
    path.join(sourceRoot, "scripts", name),
    path.join(releaseRoot, "scripts", name),
  );
}
const launchdLabels = [
  "org.hawkspan.local-control",
  "org.hawkspan.link-agent",
  "org.hawkspan.queue-supervisor",
  "org.hawkspan.lora-scheduler",
  "org.hawkspan.packet-receiver",
];
for (const label of launchdLabels) {
  fs.copyFileSync(
    path.join(sourceRoot, "launchd", `${label}.plist.template`),
    path.join(releaseRoot, "launchd", `${label}.plist.template`),
  );
}
createReleaseProvenance(releaseRoot, {
  revision: testRevision,
  tree: testTree,
  sourceAuthority: JSON.parse(
    fs.readFileSync(path.join(releaseRoot, "config", "source-authority.json"), "utf8"),
  ),
  publishedRepository: "https://github.com/harryshawk/hawkspan-clean-staging.git",
  publishedRef: "refs/heads/test-release",
});
fs.mkdirSync(stateRoot, { recursive: true });
writeHawkspanEnv(path.join(stateRoot, "hawkspan.env"), {
  HAWKSPAN_ACTIVE_RELEASE_ROOT: "/old/release",
  HAWKSPAN_LINK_CONNECT_TIMEOUT_MS: "7000",
});
fs.appendFileSync(
  path.join(stateRoot, "hawkspan.env"),
  'HAWKSPAN_PLUGIN_ROOT="/old/release"\nHAWKSPAN_LOCAL_CONTROL_URL="http://127.0.0.1:8765"\n',
);
fs.writeFileSync(path.join(stateRoot, "config.json"), `${JSON.stringify({
  node_role: "controller",
  peer: { user: "peer", remote_plugin_root: "/remote/old", remote_call_tool: "/remote/old/scripts/call-tool.mjs" },
  training: {},
}, null, 2)}\n`, { mode: 0o600 });

const activation = spawnSync(process.execPath, [
  path.join(sourceRoot, "scripts", "activate-release.mjs"),
  "--release-root", releaseRoot,
  "--revision", testRevision,
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: homeRoot,
    HAWKSPAN_STATE_DIR: stateRoot,
    HAWKSPAN_LAUNCH_AGENTS_DIR: launchAgentsRoot,
  },
});
assert.notEqual(activation.status, 0);
assert.match(activation.stderr, /static peer release path is unsupported/);
assert.equal(fs.existsSync(path.join(stateRoot, "installed-revision.json")), false);
assert.match(fs.readFileSync(path.join(stateRoot, "hawkspan.env"), "utf8"), /HAWKSPAN_PLUGIN_ROOT/);

fs.writeFileSync(path.join(stateRoot, "config.json"), `${JSON.stringify({
  node_role: "controller",
  peer: { user: "peer" },
  training: {},
}, null, 2)}\n`, { mode: 0o600 });
const envBeforeFailedPreflight = fs.readFileSync(path.join(stateRoot, "hawkspan.env"), "utf8");
const configBeforeFailedPreflight = fs.readFileSync(path.join(stateRoot, "config.json"), "utf8");
const missingTemplate = path.join(releaseRoot, "launchd", "org.hawkspan.queue-supervisor.plist.template");
fs.unlinkSync(missingTemplate);
const incompleteActivation = spawnSync(process.execPath, [
  path.join(sourceRoot, "scripts", "activate-release.mjs"),
  "--release-root", releaseRoot,
  "--revision", testRevision,
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: homeRoot,
    HAWKSPAN_STATE_DIR: stateRoot,
    HAWKSPAN_LAUNCH_AGENTS_DIR: launchAgentsRoot,
  },
});
assert.notEqual(incompleteActivation.status, 0);
assert.match(incompleteActivation.stderr, /packaged release file set differs from provenance/);
assert.equal(fs.existsSync(path.join(stateRoot, "installed-revision.json")), false);
assert.equal(fs.readFileSync(path.join(stateRoot, "hawkspan.env"), "utf8"), envBeforeFailedPreflight);
assert.equal(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"), configBeforeFailedPreflight);
assert.equal(fs.existsSync(launchAgentsRoot), false);
fs.copyFileSync(
  path.join(sourceRoot, "launchd", "org.hawkspan.queue-supervisor.plist.template"),
  missingTemplate,
);
const cleanActivation = spawnSync(process.execPath, [
  path.join(sourceRoot, "scripts", "activate-release.mjs"),
  "--release-root", releaseRoot,
  "--revision", testRevision,
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: homeRoot,
    HAWKSPAN_STATE_DIR: stateRoot,
    HAWKSPAN_LAUNCH_AGENTS_DIR: launchAgentsRoot,
  },
});
assert.equal(cleanActivation.status, 0, cleanActivation.stderr);
const cleanActivationReceipt = JSON.parse(cleanActivation.stdout);
assert.equal(cleanActivationReceipt.product_separation.valid, true);
assert.deepEqual(
  cleanActivationReceipt.retired_environment_names,
  ["HAWKSPAN_LOCAL_CONTROL_URL", "HAWKSPAN_PLUGIN_ROOT"],
);
const authority = readReleaseAuthority(stateRoot);
assert.equal(authority.revision, testRevision);
assert.equal(authority.active_release_root, resolvedReleaseRoot);
assert.equal(
  authority.stable_release_root,
  path.join(homeRoot, ".local", "share", "hawkspan", "current"),
);
assert.equal(fs.realpathSync(authority.stable_release_root), resolvedReleaseRoot);

const envBeforePublishFailure = fs.readFileSync(path.join(stateRoot, "hawkspan.env"));
const configBeforePublishFailure = fs.readFileSync(path.join(stateRoot, "config.json"));
const authorityBeforePublishFailure = fs.readFileSync(path.join(stateRoot, "installed-revision.json"));
const stableTargetBeforePublishFailure = fs.readlinkSync(authority.stable_release_root);
const blockedLaunchAgentsRoot = path.join(temporaryRoot, "blocked-launch-agents");
fs.writeFileSync(blockedLaunchAgentsRoot, "not a directory\n");
const failedPublish = spawnSync(process.execPath, [
  path.join(sourceRoot, "scripts", "activate-release.mjs"),
  "--release-root", releaseRoot,
  "--revision", testRevision,
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: homeRoot,
    HAWKSPAN_STATE_DIR: stateRoot,
    HAWKSPAN_LAUNCH_AGENTS_DIR: blockedLaunchAgentsRoot,
  },
});
assert.notEqual(failedPublish.status, 0);
assert.deepEqual(fs.readFileSync(path.join(stateRoot, "hawkspan.env")), envBeforePublishFailure);
assert.deepEqual(fs.readFileSync(path.join(stateRoot, "config.json")), configBeforePublishFailure);
assert.deepEqual(
  fs.readFileSync(path.join(stateRoot, "installed-revision.json")),
  authorityBeforePublishFailure,
);
assert.equal(fs.readlinkSync(authority.stable_release_root), stableTargetBeforePublishFailure);

const envValues = readHawkspanEnv(path.join(stateRoot, "hawkspan.env"));
assert.equal(envValues.HAWKSPAN_ACTIVE_RELEASE_ROOT, resolvedReleaseRoot);
for (const [name, value] of Object.entries(HAWKSPAN_OPERATIONAL_ENV_DEFAULTS)) {
  const expected = name === "HAWKSPAN_LINK_CONNECT_TIMEOUT_MS" ? "7000" : value;
  assert.equal(envValues[name], expected, `activation must materialize ${name}`);
}
assert.equal(envValues.HAWKSPAN_LINK_CONNECT_TIMEOUT_MS, "7000");
assert.equal(Object.hasOwn(envValues, "HAWKSPAN_PLUGIN_ROOT"), false);
assert.equal(Object.hasOwn(envValues, "HAWKSPAN_REMOTE_PLUGIN_ROOT"), false);
assert.equal(Object.hasOwn(envValues, "HAWKSPAN_REMOTE_CALL_TOOL"), false);
const config = JSON.parse(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8"));
assert.equal(Object.hasOwn(config, "plugin_root"), false);
assert.equal(config.training.node_path, process.execPath);
assert.equal(Object.hasOwn(config.peer, "remote_plugin_root"), false);
assert.equal(Object.hasOwn(config.peer, "remote_call_tool"), false);
assert.deepEqual(config.packet_receiver, {
  staging_root: path.join(stateRoot, "artifacts"),
  destination_root: path.join(stateRoot, "received-packets"),
  send_durable_receipt: true,
  allow_remove_verified_staging: false,
  return_packets_only: true,
  require_automatic_return_metadata: true,
  copy_metadata_sidecars: false,
});
for (const label of launchdLabels) {
  const body = fs.readFileSync(path.join(launchAgentsRoot, `${label}.plist`), "utf8");
  assert.match(body, new RegExp(authority.stable_release_root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(body, /__[A-Z0-9_]+__/);
}

const audit = auditLocalRelease({ stateRoot, launchAgentsRoot, checkProcesses: false });
assert.equal(audit.valid, true, JSON.stringify(audit.mismatches));
const stableAudit = spawnSync(process.execPath, [
  path.join(authority.stable_release_root, "scripts", "audit-release-authority.mjs"),
  "--local-only",
  "--skip-processes",
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: homeRoot,
    HAWKSPAN_STATE_DIR: stateRoot,
    HAWKSPAN_LAUNCH_AGENTS_DIR: launchAgentsRoot,
  },
});
assert.equal(stableAudit.status, 0, stableAudit.stderr);
assert.equal(JSON.parse(stableAudit.stdout).valid, true);
const mismatches = validateLiveReleaseConfiguration(authority, {
  envValues,
  config: { ...config, plugin_root: "/wrong/release" },
});
assert.ok(mismatches.some((entry) => entry.location === "config.json:plugin_root"));

const isolatedStateRoot = path.join(temporaryRoot, "isolated", ".hawkgrokspan");
const isolatedLaunchAgentsRoot = path.join(isolatedStateRoot, "rendered-launchd");
const isolatedStableRoot = path.join(homeRoot, ".local", "share", "hawkgrokspan", "current");
fs.mkdirSync(isolatedStateRoot, { recursive: true });
fs.writeFileSync(path.join(isolatedStateRoot, "config.json"), `${JSON.stringify({
  surface_profile: "message-files",
  node_role: "controller",
  peer: { user: "peer" },
  queue_supervisor: { enabled: false },
  training: {},
}, null, 2)}\n`, { mode: 0o600 });
const isolatedActivation = spawnSync(process.execPath, [
  path.join(sourceRoot, "scripts", "activate-release.mjs"),
  "--release-root", releaseRoot,
  "--revision", testRevision,
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: homeRoot,
    HAWKSPAN_STATE_DIR: isolatedStateRoot,
    HAWKSPAN_STABLE_RELEASE_ROOT: isolatedStableRoot,
    HAWKSPAN_LAUNCH_AGENTS_DIR: isolatedLaunchAgentsRoot,
  },
});
assert.equal(isolatedActivation.status, 0, isolatedActivation.stderr);
const isolatedAuthority = readReleaseAuthority(isolatedStateRoot);
assert.equal(isolatedAuthority.stable_release_root, isolatedStableRoot);
assert.equal(fs.realpathSync(isolatedStableRoot), resolvedReleaseRoot);
assert.equal(
  readHawkspanEnv(path.join(isolatedStateRoot, "hawkspan.env")).HAWKSPAN_QUEUE_SUPERVISOR_ENABLED,
  "false",
);
assert.equal(fs.readlinkSync(authority.stable_release_root), stableTargetBeforePublishFailure);
for (const label of launchdLabels) {
  assert.equal(fs.existsSync(path.join(isolatedLaunchAgentsRoot, `${label}.plist`)), true);
}

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.stdout.write("release authority tests passed\n");
