#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readHawkspanEnv } from "./hawkspan-env.mjs";
import {
  assertExecutingRelease,
  readReleaseAuthority,
  validateLiveReleaseConfiguration,
} from "./release-authority.mjs";

const args = new Set(process.argv.slice(2));
const repairJobs = !args.has("--no-repair-jobs");
const checkReadiness = !args.has("--no-readiness");
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(scriptRoot);
const stateRoot = path.resolve(process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"));
const auditRoot = path.join(stateRoot, "audit");
const configPath = path.resolve(process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH || path.join(stateRoot, "config.json"));
const envPath = path.join(stateRoot, "hawkspan.env");
const uid = String(process.getuid?.() ?? spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim());
const authority = readReleaseAuthority(stateRoot);
assertExecutingRelease(authority, pluginRoot);

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertLiveReleaseConfiguration() {
  const launchAgentsRoot = process.env.HAWKSPAN_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents");
  const launchdBodies = [
    "org.hawkspan.local-control",
    "org.hawkspan.link-agent",
    "org.hawkspan.queue-supervisor",
    "org.hawkspan.lora-scheduler",
    "org.hawkspan.packet-receiver",
  ].map((label) => {
    const filePath = path.join(launchAgentsRoot, `${label}.plist`);
    return { location: filePath, body: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "" };
  });
  const mismatches = validateLiveReleaseConfiguration(authority, {
    envValues: readHawkspanEnv(envPath),
    config: readJson(configPath, {}),
    launchdBodies,
  });
  if (mismatches.length) {
    throw new Error(`live release configuration disagrees with installed authority: ${JSON.stringify(mismatches)}`);
  }
  return { config_path: configPath, env_path: envPath, authority, mismatches: [] };
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: pluginRoot,
    encoding: "utf8",
    timeout: options.timeout || 30000,
    env: options.env || {
      ...process.env,
      HAWKSPAN_STATE_DIR: stateRoot,
      HAWKSPAN_NODE: process.execPath,
      HAWKSPAN_ACTIVE_RELEASE_ROOT: authority.active_release_root,
      HAWKSPAN_SERVICE_ROOT: authority.stable_release_root,
    },
  });
  return {
    command: [command, ...commandArgs].join(" "),
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    ok: result.status === 0,
  };
}

function launchctlList(label) {
  const result = run("launchctl", ["list"]);
  const line = result.stdout.split("\n").find((entry) => entry.includes(label)) || "";
  if (!line) return { label, loaded: false, pid: null, last_status: null, line: "" };
  const [pid, status] = line.trim().split(/\s+/, 3);
  return {
    label,
    loaded: true,
    pid: pid === "-" ? null : Number(pid),
    last_status: Number(status),
    line: line.trim(),
  };
}

function waitForService(label, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let current = launchctlList(label);
  while (Date.now() < deadline) {
    if (predicate(current)) return current;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    current = launchctlList(label);
  }
  return current;
}

function launchctlPrint(label) {
  const result = run("launchctl", ["print", `gui/${uid}/${label}`]);
  return result.status === 0 ? result.stdout : "";
}

function serviceUsesPluginRoot(label) {
  return launchctlPrint(label).includes(authority.stable_release_root);
}

function disabledEntries() {
  const result = run("launchctl", ["print-disabled", `gui/${uid}`]);
  return (result.stdout || "")
    .split("\n")
    .filter((line) => /hawkspan|captioned-lora|codex-mps|lora-scheduler/.test(line))
    .map((line) => line.trim());
}

function matchingProcesses() {
  const result = run("ps", ["axww", "-o", "pid=,ppid=,comm=,args="], { timeout: 10000 });
  return (result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /hawkspan|\.hawkspan|captioned-lora|codex-mps|caffeinate|SimpleTuner|simpletuner|run_captioned_loras|m4-trainer|lora-scheduler/.test(line))
    .filter((line) => !line.includes("hawkspan-startup.mjs"));
}

function deactivateOptionalService(label) {
  const bootout = run("launchctl", ["bootout", `gui/${uid}/${label}`]);
  const disable = run("launchctl", ["disable", `gui/${uid}/${label}`]);
  return {
    command: `deactivate ${label}`,
    status: disable.status,
    stdout: `${bootout.stdout}${disable.stdout}`,
    stderr: `${bootout.stderr}${disable.stderr}`,
    ok: disable.ok,
    already_absent: !bootout.ok,
  };
}

fs.mkdirSync(auditRoot, { recursive: true, mode: 0o700 });

const liveReleaseValidation = assertLiveReleaseConfiguration();
const liveConfig = readJson(configPath, {});
const schedulerExpected = liveConfig.training?.allow_start === true &&
  typeof liveConfig.lora_automation?.scheduler_jobs_path === "string";
const packetReceiverExpected = typeof liveConfig.packet_receiver?.destination_root === "string" &&
  liveConfig.packet_receiver.destination_root.length > 0;
const actions = [
  run(path.join(scriptRoot, "install-local-control-agent.sh"), []),
  run(path.join(scriptRoot, "install-link-agent.sh"), []),
  run(path.join(scriptRoot, "install-queue-supervisor.sh"), []),
];
actions.push(schedulerExpected
  ? run(path.join(scriptRoot, "install-lora-scheduler.sh"), [])
  : deactivateOptionalService("org.hawkspan.lora-scheduler"));
actions.push(packetReceiverExpected
  ? run(path.join(scriptRoot, "install-m2-packet-receiver.sh"), [])
  : deactivateOptionalService("org.hawkspan.packet-receiver"));
if (repairJobs) {
  actions.push(run(process.execPath, [path.join(scriptRoot, "hawkspan-reconcile-jobs.mjs"), "--apply"]));
}
const readinessReceiptPath = path.join(auditRoot, `readiness-${Date.now()}.json`);
let readiness = null;
if (checkReadiness) {
  const readinessRun = run(process.execPath, [path.join(scriptRoot, "hawkspan-readiness-monitor.mjs")], {
    timeout: 330000,
    env: {
      ...process.env,
      HAWKSPAN_STATE_DIR: stateRoot,
      HAWKSPAN_CONFIG: configPath,
      HAWKSPAN_READINESS_AUDIT_PATH: readinessReceiptPath,
    },
  });
  actions.push(readinessRun);
  readiness = readJson(readinessReceiptPath, null);
}

const localControl = waitForService(
  "org.hawkspan.local-control",
  (service) => service.loaded && Number.isFinite(service.pid),
);
const linkAgent = waitForService(
  "org.hawkspan.link-agent",
  (service) => service.loaded && service.last_status === 0,
);
const queueSupervisor = waitForService(
  "org.hawkspan.queue-supervisor",
  (service) => service.loaded && Number.isFinite(service.pid),
);
const loraScheduler = schedulerExpected
  ? waitForService("org.hawkspan.lora-scheduler", (service) => service.loaded && service.last_status === 0)
  : launchctlList("org.hawkspan.lora-scheduler");
const packetReceiver = packetReceiverExpected
  ? waitForService("org.hawkspan.packet-receiver", (service) => service.loaded && service.last_status === 0)
  : launchctlList("org.hawkspan.packet-receiver");
const hawkspanLaunchdEntries = run("launchctl", ["list"]).stdout
  .split("\n")
  .filter((line) => /hawkspan|captioned-lora|codex-mps|lora-scheduler/.test(line));
const receipt = {
  generated_at: new Date().toISOString(),
  host: os.hostname(),
  state_root: stateRoot,
  plugin_root: pluginRoot,
  release_authority: authority,
  live_release_validation: liveReleaseValidation,
  readiness,
  readiness_receipt_path: readiness ? readinessReceiptPath : null,
  actions,
  services: {
    local_control: {
      ...localControl,
      uses_plugin_root: serviceUsesPluginRoot("org.hawkspan.local-control"),
      ok: localControl.loaded && Number.isFinite(localControl.pid) &&
        serviceUsesPluginRoot("org.hawkspan.local-control"),
      expected: "persistent",
    },
    link_agent: {
      ...linkAgent,
      uses_plugin_root: serviceUsesPluginRoot("org.hawkspan.link-agent"),
      ok: linkAgent.loaded && linkAgent.last_status === 0 &&
        serviceUsesPluginRoot("org.hawkspan.link-agent"),
      expected: "periodic_oneshot_startinterval_120",
    },
    queue_supervisor: {
      ...queueSupervisor,
      uses_plugin_root: serviceUsesPluginRoot("org.hawkspan.queue-supervisor"),
      ok: queueSupervisor.loaded && Number.isFinite(queueSupervisor.pid) &&
        serviceUsesPluginRoot("org.hawkspan.queue-supervisor"),
      expected: "persistent_keepalive",
    },
    lora_scheduler: {
      ...loraScheduler,
      uses_plugin_root: schedulerExpected && serviceUsesPluginRoot("org.hawkspan.lora-scheduler"),
      ok: schedulerExpected
        ? loraScheduler.loaded && loraScheduler.last_status === 0 && serviceUsesPluginRoot("org.hawkspan.lora-scheduler")
        : !loraScheduler.loaded,
      expected: schedulerExpected ? "periodic_oneshot_startinterval_300" : "disabled_for_this_role",
    },
    packet_receiver: {
      ...packetReceiver,
      uses_plugin_root: packetReceiverExpected && serviceUsesPluginRoot("org.hawkspan.packet-receiver"),
      ok: packetReceiverExpected
        ? packetReceiver.loaded && packetReceiver.last_status === 0 && serviceUsesPluginRoot("org.hawkspan.packet-receiver")
        : !packetReceiver.loaded,
      expected: packetReceiverExpected ? "periodic_oneshot_startinterval_300" : "disabled_for_this_role",
    },
  },
  hawkspan_launchd: {
    loaded_entries: hawkspanLaunchdEntries,
    disabled_entries: disabledEntries(),
  },
  process_matches: matchingProcesses(),
};
const actionsOk = actions.every((action) => action.ok);
receipt.ok = actionsOk &&
  receipt.live_release_validation.mismatches.length === 0 &&
  receipt.services.local_control.ok &&
  receipt.services.link_agent.ok &&
  receipt.services.queue_supervisor.ok &&
  receipt.services.lora_scheduler.ok &&
  receipt.services.packet_receiver.ok &&
  (!checkReadiness || receipt.readiness?.state !== "failed");

const receiptPath = path.join(auditRoot, `startup-${Date.now()}.json`);
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...receipt, receipt_path: receiptPath }, null, 2)}\n`);
process.exit(receipt.ok ? 0 : 1);
