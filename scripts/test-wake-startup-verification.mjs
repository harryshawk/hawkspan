#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-wake-verification-"));
const bin = path.join(root, "bin");
const sshLog = path.join(root, "ssh.log");
fs.mkdirSync(bin, { recursive: true });

fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf '%s\n' "$*" >> "$HAWKSPAN_TEST_SSH_LOG"
case "$*" in
  *installed-revision.json*)
    printf '%s\n' '{"schema_version":2,"revision":"d95d5f8556acac260620d3703bb8ff961fc25537","active_release_root":"/tmp/hawkspan-release"}'
    exit 0
    ;;
esac
for remote_command do :; done
/bin/sh -n -c "$remote_command" || exit 65
case "$HAWKSPAN_TEST_WAKE_MODE" in
  resume-failed)
    printf '%s\n' 'WAKE_RESUME_FAILED:1' >&2
    exit 70
    ;;
  already-running)
    printf '%s\n' 'WAKE_ALREADY_IN_PROGRESS' >&2
    exit 75
    ;;
  success)
    exit 0
    ;;
esac
exit 2
`, { mode: 0o755 });

const configPath = path.join(root, "config.json");
const baseConfig = {
  schema_version: 1,
  node_id: "wake-test-controller",
  peer: {
    node_id: "wake-test-worker",
    user: "peeruser",
    thread_id: "01a008f3-825f-7e71-9e4c-eb29af26d48d",
    codex_command: "/Applications/ChatGPT.app/Contents/Resources/codex",
    codex_workdir: "/Users/peeruser/Documents/Codex/HawkSpan-Wake-Receiver",
    codex_sandbox: "workspace-write",
    allow_remote_wake: true,
    remote_node: "/usr/local/bin/node",
    primary_enabled: true,
    primary_host: "192.0.2.11",
    fallback_enabled: false,
    remote_inbox: "/Users/peeruser/.hawkspan/inbox",
    remote_audit: "/Users/peeruser/.hawkspan/audit",
    remote_state_dir: "/Users/peeruser/.hawkspan",
  },
  link: {
    operation_retry_delays_ms: [0],
    operation_attempt_timeout_ms: 15000,
    connect_timeout_ms: 1000,
    cycle_timeout_ms: 30000,
    server_alive_interval_seconds: 1,
    server_alive_count_max: 1,
    primary_reprobe_ms: 1000,
  },
};

function writeConfig(configuration = baseConfig) {
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
}

function assertStartupFails(change, pattern) {
  const configuration = structuredClone(baseConfig);
  change(configuration);
  writeConfig(configuration);
  const result = spawnSync(process.execPath, [
    path.join(scripts, "call-tool.mjs"),
    "wake_peer_thread",
    JSON.stringify({ message_id: "invalid-wake-config" }),
  ], {
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      HAWKSPAN_STATE_DIR: root,
      HAWKSPAN_CONFIG: configPath,
      HAWKSPAN_TEST_SSH_LOG: sshLog,
    },
  });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(`${result.stderr}\n${result.stdout}`, pattern);
}

assertStartupFails(
  (configuration) => { delete configuration.peer.codex_workdir; },
  /peer.codex_workdir must be an absolute dedicated receiver directory/,
);
assertStartupFails(
  (configuration) => { configuration.peer.codex_workdir = "/Users/peeruser"; },
  /peer.codex_workdir must not be a filesystem, volume, or user-home root/,
);
assertStartupFails(
  (configuration) => { configuration.peer.codex_sandbox = "danger-full-access"; },
  /peer.codex_sandbox must be workspace-write/,
);
assertStartupFails(
  (configuration) => { configuration.peer.codex_command = "codex"; },
  /peer.codex_command must be an absolute executable path/,
);
assertStartupFails(
  (configuration) => { configuration.peer.thread_id = "current"; },
  /peer.thread_id must be an exact Codex task UUID/,
);
assertStartupFails(
  (configuration) => { configuration.peer.allow_remote_wake = "yes"; },
  /peer.allow_remote_wake must be a boolean/,
);
writeConfig();

function callWake(mode) {
  fs.writeFileSync(sshLog, "");
  const result = spawnSync(process.execPath, [
    path.join(scripts, "call-tool.mjs"),
    "wake_peer_thread",
    JSON.stringify({ message_id: `wake-${mode}`, subject: mode }),
  ], {
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HAWKSPAN_STATE_DIR: root,
      HAWKSPAN_CONFIG: configPath,
      HAWKSPAN_TEST_SSH_LOG: sshLog,
      HAWKSPAN_TEST_WAKE_MODE: mode,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    response: JSON.parse(result.stdout).structuredContent,
    ssh: fs.readFileSync(sshLog, "utf8"),
  };
}

const failed = callWake("resume-failed");
assert.equal(failed.response.ok, false);
assert.match(failed.response.error, /resume failed/);
assert.match(failed.response.log_path, /wake-.*\.log$/);
assert.match(failed.response.status_path, /wake-.*\.status$/);
assert.equal((failed.ssh.match(/^.*$/gm) || []).filter(Boolean).length, 2);

const duplicate = callWake("already-running");
assert.equal(duplicate.response.ok, false);
assert.match(duplicate.response.error, /already in progress/);
assert.equal((duplicate.ssh.match(/^.*$/gm) || []).filter(Boolean).length, 2);

const success = callWake("success");
assert.equal(success.response.ok, true);
assert.equal(success.response.host, "192.0.2.11");
assert.match(success.response.verification, /startup grace period/);
assert.match(success.ssh, /wake_check/);
assert.match(success.ssh, /WAKE_RESUME_FAILED/);
assert.match(success.ssh, /sandbox_workspace_write\.writable_roots=\[\]/);
assert.match(success.ssh, /workspace-write/);
assert.match(success.ssh, /HawkSpan-Wake-Receiver/);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("wake startup verification tests passed\n");
