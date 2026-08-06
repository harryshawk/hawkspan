#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHawkspanEnv, serializeHawkspanEnv } from "./hawkspan-env.mjs";
import { assertProductSeparated } from "./product-separation.mjs";
import {
  atomicJson,
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
const envValues = { ...readHawkspanEnv(envPath) };
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

// installed-revision.json is the transaction commit marker. Everything it
// names is fully validated and published before the authority becomes active.
atomicWrite(envPath, envBody);
atomicJson(configPath, config);
for (const { targetPath, rendered } of renderedLaunchd) {
  atomicWrite(targetPath, rendered, 0o644);
}
commitReleaseAuthority(stateRoot, authority);
const launchdPaths = renderedLaunchd.map(({ targetPath }) => targetPath);

process.stdout.write(`${JSON.stringify({
  activated: true,
  product_separation: separation,
  authority,
  config_path: configPath,
  env_path: envPath,
  launchd_paths: launchdPaths,
}, null, 2)}\n`);
