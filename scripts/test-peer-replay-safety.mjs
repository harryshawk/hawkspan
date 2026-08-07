#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-peer-replay-"));
const bin = path.join(root, "bin");
const log = path.join(root, "ssh.log");
fs.mkdirSync(bin, { recursive: true });

fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf '%s\n' "$*" >> "$HAWKSPAN_TEST_SSH_LOG"
case "$*" in
  *installed-revision.json*)
    printf '%s\n' '{"schema_version":2,"revision":"remote-test","active_release_root":"/remote/hawkspan"}'
    exit 0
    ;;
  *run_command*)
    printf '%s\n' dispatch >> "$HAWKSPAN_TEST_SSH_LOG"
    exit 255
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });

const configPath = path.join(root, "config.json");
fs.writeFileSync(configPath, `${JSON.stringify({
  schema_version: 1,
  node_id: "replay-test-controller",
  peer: {
    node_id: "replay-test-worker",
    user: "peeruser",
    remote_node: "/remote/node",
    remote_state_dir: "/Users/peeruser/.hawkspan",
    primary_enabled: true,
    primary_host: "192.0.2.11",
    fallback_enabled: true,
    fallback_host: "198.51.100.11",
  },
  link: {
    operation_retry_delays_ms: [10, 20],
    operation_attempt_timeout_ms: 1000,
    connect_timeout_ms: 1000,
    cycle_timeout_ms: 5000,
    server_alive_interval_seconds: 1,
    server_alive_count_max: 1,
    primary_reprobe_ms: 1000,
  },
}, null, 2)}\n`);

const result = spawnSync(process.execPath, [
  path.join(scripts, "call-tool.mjs"),
  "peer_call_tool",
  JSON.stringify({
    tool_name: "run_command",
    arguments: { command: "long-running-command" },
    timeout_ms: 3000,
  }),
], {
  encoding: "utf8",
  timeout: 10000,
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HAWKSPAN_STATE_DIR: root,
    HAWKSPAN_CONFIG: configPath,
    HAWKSPAN_TEST_SSH_LOG: log,
  },
});

assert.equal(result.status, 0, result.stderr);
const response = JSON.parse(result.stdout);
assert.equal(response.isError, false, response.content?.[0]?.text);
assert.equal(response.structuredContent.outcome, "unknown");
assert.equal(response.structuredContent.replay_suppressed, true);
assert.equal(response.structuredContent.attempts.length, 1);
assert.equal(response.structuredContent.attempts[0].phase, "tool_dispatch");
const logText = fs.readFileSync(log, "utf8");
assert.equal((logText.match(/^dispatch$/gm) || []).length, 1);
assert.equal((logText.match(/installed-revision\.json/g) || []).length, 1);
assert.equal(logText.includes("198.51.100.11"), false);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("ambiguous peer command replay suppression test passed\n");
