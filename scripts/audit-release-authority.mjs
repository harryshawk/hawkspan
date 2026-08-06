#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyHawkspanEnv, readHawkspanEnv } from "./hawkspan-env.mjs";
import {
  readReleaseAuthority,
  validateLiveReleaseConfiguration,
} from "./release-authority.mjs";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function releasePathsIn(text) {
  return text.match(/\/[^\s<]+\/\.local\/share\/hawkspan\/releases\/[^/\s<]+/g) || [];
}

export function auditLocalRelease({ stateRoot, launchAgentsRoot, checkProcesses = true } = {}) {
  const resolvedStateRoot = path.resolve(stateRoot || process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"));
  const resolvedLaunchAgents = path.resolve(launchAgentsRoot || process.env.HAWKSPAN_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents"));
  const authority = readReleaseAuthority(resolvedStateRoot);
  const envPath = path.join(resolvedStateRoot, "hawkspan.env");
  const configPath = path.resolve(process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH || path.join(resolvedStateRoot, "config.json"));
  const envValues = readHawkspanEnv(envPath);
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const labels = [
    "org.hawkspan.local-control",
    "org.hawkspan.link-agent",
    "org.hawkspan.queue-supervisor",
    "org.hawkspan.lora-scheduler",
    "org.hawkspan.packet-receiver",
  ];
  const launchdBodies = labels.map((label) => {
    const filePath = path.join(resolvedLaunchAgents, `${label}.plist`);
    return { location: filePath, body: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "" };
  });
  const mismatches = [...validateLiveReleaseConfiguration(authority, { envValues, config, launchdBodies })];
  let stableResolvesTo = null;
  try {
    stableResolvesTo = fs.realpathSync(authority.stable_release_root);
  } catch (error) {
    mismatches.push({ location: authority.stable_release_root, observed: String(error.message || error), expected: authority.active_release_root });
  }
  if (stableResolvesTo && stableResolvesTo !== authority.active_release_root) {
    mismatches.push({ location: authority.stable_release_root, observed: stableResolvesTo, expected: authority.active_release_root });
  }
  const processResult = checkProcesses
    ? spawnSync("ps", ["axww", "-o", "pid=,command="], { encoding: "utf8", timeout: 10000 })
    : { stdout: "" };
  const processLines = (processResult.stdout || "").split("\n").filter((line) => /hawkspan|\.hawkspan/.test(line));
  for (const line of processLines) {
    for (const observed of releasePathsIn(line)) {
      if (observed !== authority.active_release_root) {
        mismatches.push({ location: `process:${line.trim().split(/\s+/, 1)[0]}`, observed, expected: authority.active_release_root });
      }
    }
  }
  return {
    valid: mismatches.length === 0,
    host: os.hostname(),
    authority,
    stable_resolves_to: stableResolvesTo,
    config_path: configPath,
    env_path: envPath,
    launchd_paths: launchdBodies.map(({ location }) => location),
    mismatches,
  };
}

function sshArgs(config, host, command) {
  const args = [];
  if (config.peer?.ssh_identity) args.push("-i", config.peer.ssh_identity);
  args.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=8", `${config.peer.user}@${host}`, command);
  return args;
}

function auditPeer(config) {
  if (!config.peer) return { valid: true, skipped: true, reason: "peer is not configured" };
  const hosts = [config.peer.primary_host, config.peer.fallback_host].filter(Boolean);
  const remoteStateRoot = config.peer.remote_state_dir || path.posix.join("/Users", config.peer.user || "", ".hawkspan");
  const authorityPath = path.posix.join(remoteStateRoot, "installed-revision.json");
  const attempts = [];
  for (const host of hosts) {
    const authorityResult = spawnSync("ssh", sshArgs(config, host, `cat ${shellQuote(authorityPath)}`), { encoding: "utf8", timeout: 15000 });
    if (authorityResult.status !== 0) {
      attempts.push({ host, phase: "release_discovery", error: authorityResult.stderr?.trim() || "failed" });
      continue;
    }
    let authority;
    try {
      authority = JSON.parse(authorityResult.stdout);
    } catch {
      attempts.push({ host, phase: "release_discovery", error: "invalid authority JSON" });
      continue;
    }
    const remoteRoot = authority.active_release_root;
    if (authority.schema_version !== 2 || !authority.revision ||
        typeof remoteRoot !== "string" || !path.posix.isAbsolute(remoteRoot)) {
      attempts.push({ host, phase: "release_discovery", error: "incomplete authority" });
      continue;
    }
    const remoteNode = config.peer.remote_node || "node";
    const command = `${shellQuote(remoteNode)} ${shellQuote(path.posix.join(remoteRoot, "scripts", "audit-release-authority.mjs"))} --local-only`;
    const auditResult = spawnSync("ssh", sshArgs(config, host, command), { encoding: "utf8", timeout: 30000 });
    if (auditResult.status !== 0) {
      attempts.push({ host, phase: "audit", revision: authority.revision, error: auditResult.stderr?.trim() || auditResult.stdout?.trim() || "failed" });
      continue;
    }
    try {
      return { ...JSON.parse(auditResult.stdout), route: host, attempts };
    } catch {
      attempts.push({ host, phase: "audit", revision: authority.revision, error: "invalid audit JSON" });
    }
  }
  return { valid: false, error: "peer audit failed on every route", attempts };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const local = auditLocalRelease({ checkProcesses: !process.argv.includes("--skip-processes") });
    if (process.argv.includes("--local-only")) {
      process.stdout.write(`${JSON.stringify(local, null, 2)}\n`);
      process.exitCode = local.valid ? 0 : 1;
    } else {
      const stateRoot = path.resolve(process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"));
      const envValues = readHawkspanEnv(path.join(stateRoot, "hawkspan.env"));
      const configPath = path.resolve(process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH || path.join(stateRoot, "config.json"));
      const rawConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
      const peer = auditPeer(applyHawkspanEnv(rawConfig, envValues));
      const result = { valid: local.valid && peer.valid, local, peer };
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.valid ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ valid: false, error: String(error.message || error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
