#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHawkspanEnvForUpgrade, serializeHawkspanEnv } from "./hawkspan-env.mjs";
import { assertProductSeparated } from "./product-separation.mjs";
import {
  atomicWrite,
  commitReleaseAuthority,
  derivedReleasePaths,
  prepareReleaseAuthority,
  renderLaunchdPlistBodies,
} from "./release-authority.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultReleaseRoot = path.dirname(scriptRoot);
const stateRoot = path.resolve(process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"));
const configPath = path.resolve(
  process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH || path.join(stateRoot, "config.json"),
);
const releaseRootIndex = process.argv.indexOf("--release-root");
const revisionIndex = process.argv.indexOf("--revision");
const releaseRoot = path.resolve(releaseRootIndex >= 0 ? process.argv[releaseRootIndex + 1] : defaultReleaseRoot);
const revision = revisionIndex >= 0
  ? process.argv[revisionIndex + 1]
  : path.basename(releaseRoot).replace(/^hawkspan-d-/, "").replace(/^hawkspan-/, "");

const separation = assertProductSeparated(releaseRoot);
const envPath = path.join(stateRoot, "hawkspan.env");
const envUpgrade = readHawkspanEnvForUpgrade(envPath);
const envValues = { ...envUpgrade.values };
const linkEnvDefaults = {
  HAWKSPAN_LINK_OPERATION_RETRY_DELAYS_MS: "2000,5000,10000,20000",
  HAWKSPAN_LINK_OPERATION_ATTEMPT_TIMEOUT_MS: "15000",
  HAWKSPAN_LINK_CONNECT_TIMEOUT_MS: "5000",
  HAWKSPAN_LINK_CYCLE_TIMEOUT_MS: "120000",
  HAWKSPAN_LINK_SERVER_ALIVE_INTERVAL_SECONDS: "15",
  HAWKSPAN_LINK_SERVER_ALIVE_COUNT_MAX: "3",
  HAWKSPAN_LINK_PRIMARY_REPROBE_MS: "60000",
};
for (const [name, value] of Object.entries(linkEnvDefaults)) {
  if (!Object.hasOwn(envValues, name)) envValues[name] = value;
}
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
for (const name of ["remote_plugin_root", "remote_call_tool"]) {
  if (Object.hasOwn(config.peer || {}, name)) {
    throw new Error(`static peer release path is unsupported: config.json peer.${name}`);
  }
}

const authority = prepareReleaseAuthority(stateRoot, {
  revision,
  activeReleaseRoot: releaseRoot,
  stableReleaseRoot: path.join(os.homedir(), ".local", "share", "hawkspan", "current"),
});
const derived = derivedReleasePaths(authority);
envValues.HAWKSPAN_ACTIVE_RELEASE_ROOT = derived.active_release_root;
envValues.HAWKSPAN_REPOSITORY_DIR = derived.repository_dir;
envValues.HAWKSPAN_LOCAL_TRAINER_START_SCRIPT = derived.trainer_start;
envValues.HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT = derived.trainer_stop;
envValues.HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT = derived.trainer_package;
const envBody = serializeHawkspanEnv(envValues);

delete config.plugin_root;
config.training = {
  ...(config.training || {}),
  start_script: derived.trainer_start,
  stop_script: derived.trainer_stop,
  package_script: derived.trainer_package,
  runner_script: derived.trainer_runner,
  automation_script: derived.trainer_automation,
  packet_builder: derived.packet_builder,
};
const renderedLaunchd = renderLaunchdPlistBodies(authority, {
  stateRoot,
  nodePath: process.env.HAWKSPAN_NODE || process.execPath,
  launchAgentsRoot: process.env.HAWKSPAN_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents"),
});

const publishTargets = [
  { targetPath: envPath, body: envBody, mode: 0o600 },
  { targetPath: configPath, body: `${JSON.stringify(config, null, 2)}\n`, mode: 0o600 },
  ...renderedLaunchd.map(({ targetPath, rendered }) => ({ targetPath, body: rendered, mode: 0o644 })),
];
const snapshots = publishTargets.map(({ targetPath }) => ({
  targetPath,
  existed: fs.existsSync(targetPath),
  body: fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null,
  mode: fs.existsSync(targetPath) ? fs.statSync(targetPath).mode & 0o777 : null,
}));
const authorityPath = path.join(stateRoot, "installed-revision.json");
const authoritySnapshot = {
  existed: fs.existsSync(authorityPath),
  body: fs.existsSync(authorityPath) ? fs.readFileSync(authorityPath) : null,
  mode: fs.existsSync(authorityPath) ? fs.statSync(authorityPath).mode & 0o777 : null,
};
const stableSnapshot = fs.existsSync(authority.stable_release_root)
  ? fs.readlinkSync(authority.stable_release_root)
  : null;

// installed-revision.json is the transaction commit marker. Everything it
// names is fully validated and published before the authority becomes active.
try {
  for (const { targetPath, body, mode } of publishTargets) atomicWrite(targetPath, body, mode);
  commitReleaseAuthority(stateRoot, authority);
} catch (error) {
  for (const snapshot of snapshots.reverse()) {
    if (snapshot.existed) atomicWrite(snapshot.targetPath, snapshot.body, snapshot.mode);
    else if (fs.existsSync(snapshot.targetPath)) fs.unlinkSync(snapshot.targetPath);
  }
  if (authoritySnapshot.existed) atomicWrite(authorityPath, authoritySnapshot.body, authoritySnapshot.mode);
  else if (fs.existsSync(authorityPath)) fs.unlinkSync(authorityPath);
  if (fs.existsSync(authority.stable_release_root)) fs.unlinkSync(authority.stable_release_root);
  if (stableSnapshot !== null) fs.symlinkSync(stableSnapshot, authority.stable_release_root);
  throw error;
}
const launchdPaths = renderedLaunchd.map(({ targetPath }) => targetPath);

process.stdout.write(`${JSON.stringify({
  activated: true,
  product_separation: separation,
  authority,
  config_path: configPath,
  env_path: envPath,
  retired_environment_names: envUpgrade.retired_names,
  launchd_paths: launchdPaths,
}, null, 2)}\n`);
