#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HAWKSPAN_OPERATIONAL_ENV_DEFAULTS,
  readHawkspanEnvForUpgrade,
  serializeHawkspanEnv,
} from "./hawkspan-env.mjs";
import { assertProductSeparated } from "./product-separation.mjs";
import { verifyActivatableRelease } from "./source-authority.mjs";
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
const provenance = verifyActivatableRelease(releaseRoot, revision);
const envPath = path.join(stateRoot, "hawkspan.env");
const envUpgrade = readHawkspanEnvForUpgrade(envPath);
const envValues = { ...envUpgrade.values };
for (const [name, value] of Object.entries(HAWKSPAN_OPERATIONAL_ENV_DEFAULTS)) {
  if (!Object.hasOwn(envValues, name)) envValues[name] = value;
}
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
// An explicit JSON switch is owner configuration, not a weaker suggestion than
// the generated operational default. Preserve it when materializing the env
// authority so restricted profiles cannot be silently broadened on activation.
if (typeof config.queue_supervisor?.enabled === "boolean") {
  envValues.HAWKSPAN_QUEUE_SUPERVISOR_ENABLED = String(config.queue_supervisor.enabled);
}
for (const name of ["remote_plugin_root", "remote_call_tool"]) {
  if (Object.hasOwn(config.peer || {}, name)) {
    throw new Error(`static peer release path is unsupported: config.json peer.${name}`);
  }
}

const authority = prepareReleaseAuthority(stateRoot, {
  revision,
  activeReleaseRoot: releaseRoot,
  stableReleaseRoot: path.resolve(
    process.env.HAWKSPAN_STABLE_RELEASE_ROOT ||
      path.join(os.homedir(), ".local", "share", "hawkspan", "current"),
  ),
});
const derived = derivedReleasePaths(authority);
const nodePath = path.resolve(process.env.HAWKSPAN_NODE || process.execPath);
envValues.HAWKSPAN_ACTIVE_RELEASE_ROOT = derived.active_release_root;
envValues.HAWKSPAN_REPOSITORY_DIR = derived.repository_dir;
envValues.HAWKSPAN_LOCAL_TRAINER_START_SCRIPT = derived.trainer_start;
envValues.HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT = derived.trainer_stop;
envValues.HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT = derived.trainer_package;
const envBody = serializeHawkspanEnv(envValues);

delete config.plugin_root;
config.training = {
  ...(config.training || {}),
  node_path: nodePath,
  start_script: derived.trainer_start,
  stop_script: derived.trainer_stop,
  package_script: derived.trainer_package,
  runner_script: derived.trainer_runner,
  automation_script: derived.trainer_automation,
  packet_builder: derived.packet_builder,
};
if (config.node_role === "controller") {
  config.packet_receiver = {
    staging_root: path.join(stateRoot, "artifacts"),
    destination_root: path.join(stateRoot, "received-packets"),
    send_durable_receipt: true,
    allow_remove_verified_staging: false,
    return_packets_only: true,
    require_automatic_return_metadata: true,
    copy_metadata_sidecars: false,
    ...(config.packet_receiver || {}),
  };
}
const renderedLaunchd = renderLaunchdPlistBodies(authority, {
  stateRoot,
  nodePath,
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
  source_provenance: provenance,
  authority,
  config_path: configPath,
  env_path: envPath,
  retired_environment_names: envUpgrade.retired_names,
  launchd_paths: launchdPaths,
}, null, 2)}\n`);
