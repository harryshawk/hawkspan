#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-wake-peer-runner-"));
const bin = path.join(root, "bin");
const log = path.join(root, "ssh.log");
const configPath = path.join(root, "config.json");
fs.mkdirSync(bin, { recursive: true });

fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HAWKSPAN_TEST_SSH_LOG"
case "$*" in
  *installed-revision.json*)
    printf '%s\\n' '{"schema_version":2,"revision":"test-revision","active_release_root":"/peer/release"}'
    exit 0
    ;;
  *wake-runner.mjs*)
    case "$HAWKSPAN_TEST_WAKE_MARKER" in
      started)
        printf '%s\\n' '{"schema_version":1,"status":"started","pid":1234}'
        exit 0
        ;;
      busy)
        printf '%s\\n' '{"schema_version":1,"status":"busy","active_message_id":"active-message"}'
        exit 73
        ;;
      failed)
        printf '%s\\n' '{"schema_version":1,"status":"failed","error":"runner rejected request"}'
        exit 1
        ;;
    esac
    ;;
esac
exit 2
`, { mode: 0o755 });

fs.writeFileSync(configPath, `${JSON.stringify({
  schema_version: 1,
  node_id: "wake-peer-runner-test",
  peer: {
    node_id: "peer",
    user: "peeruser",
    primary_enabled: true,
    primary_host: "192.0.2.30",
    fallback_enabled: true,
    fallback_host: "198.51.100.30",
    remote_inbox: "/Users/peeruser/.hawkspan/inbox",
    remote_audit: "/Users/peeruser/.hawkspan/audit",
    remote_state_dir: "/Users/peeruser/.hawkspan",
    remote_node: "/peer/node",
    codex_command: "/peer/codex",
    codex_ipc_socket: "/peer/codex-home/ipc/ipc.sock",
    thread_id: "00000000-0000-0000-0000-000000000002",
    allow_remote_wake: true,
  },
  link: {
    operation_retry_delays_ms: [0],
    operation_attempt_timeout_ms: 1000,
    connect_timeout_ms: 500,
    cycle_timeout_ms: 5000,
    server_alive_interval_seconds: 1,
    server_alive_count_max: 1,
    primary_reprobe_ms: 100,
  },
}, null, 2)}\n`);

function tool(name, args, marker = "started") {
  const result = spawnSync(
    process.execPath,
    [path.join(scripts, "call-tool.mjs"), name, JSON.stringify(args)],
    {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HAWKSPAN_STATE_DIR: root,
        HAWKSPAN_CONFIG: configPath,
        HAWKSPAN_TEST_SSH_LOG: log,
        HAWKSPAN_TEST_WAKE_MARKER: marker,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.isError, false, response.content?.[0]?.text);
  return response.structuredContent;
}

const queuedMessage = tool("enqueue_queue_item", {
  queue_id: "hawkspan-messages",
  item_id: "wake-runner-marker-message",
  payload: {
    recipient: "peer",
    target_thread_id: "00000000-0000-0000-0000-000000000003",
    subject: "wake runner marker test",
    body: "test body",
  },
});
const message = tool("list_messages", { direction: "outbound" })
  .find((entry) => entry.id === queuedMessage.item.payload.message_id);
assert.ok(message);
assert.equal(
  JSON.parse(fs.readFileSync(message.envelope_path, "utf8")).target_thread_id,
  "00000000-0000-0000-0000-000000000003",
);

const started = tool("wake_peer_thread", { message_id: message.id }, "started");
assert.equal(started.ok, true);
assert.match(started.result_path, /\.result\.json$/);
assert.equal(started.attempts.at(-1).marker.status, "started");
const startedWakeLine = fs.readFileSync(log, "utf8").split("\n")
  .findLast((line) => line.includes("wake-runner.mjs"));
const encodedWakeRequest = startedWakeLine?.match(/\blaunch '([A-Za-z0-9+/=]+)'/)?.[1];
assert.ok(encodedWakeRequest, "wake request must be present in the SSH command");
const wakeRequest = JSON.parse(Buffer.from(encodedWakeRequest, "base64").toString("utf8"));
assert.equal(wakeRequest.thread_id, "00000000-0000-0000-0000-000000000002");
assert.equal(wakeRequest.target_thread_id, "00000000-0000-0000-0000-000000000003");
assert.equal(wakeRequest.codex_ipc_socket, "/peer/codex-home/ipc/ipc.sock");
assert.match(wakeRequest.prompt, /fenced HawkSpan runner owns/);
assert.match(wakeRequest.prompt, /00000000-0000-0000-0000-000000000003/);
assert.match(wakeRequest.handoff_prompt, /wake runner marker test/);
assert.match(wakeRequest.handoff_prompt, /test body/);

const beforeBusy = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
const busy = tool("wake_peer_thread", { message_id: message.id }, "busy");
assert.equal(busy.ok, false);
assert.equal(busy.skipped, true);
assert.equal(busy.busy, true);
assert.equal(busy.attempts.at(-1).marker.status, "busy");
const busyLines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).slice(beforeBusy);
assert.equal(busyLines.filter((line) => line.includes("wake-runner.mjs")).length, 1);

const beforeFailure = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
const failed = tool("wake_peer_thread", { message_id: message.id }, "failed");
assert.equal(failed.ok, false);
assert.equal(failed.error, "runner rejected request");
const failureLines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).slice(beforeFailure);
assert.equal(failureLines.filter((line) => line.includes("wake-runner.mjs")).length, 1);

const configWithoutEndpoint = JSON.parse(fs.readFileSync(configPath, "utf8"));
delete configWithoutEndpoint.peer.codex_ipc_socket;
fs.writeFileSync(configPath, `${JSON.stringify(configWithoutEndpoint, null, 2)}\n`);
const missingEndpoint = tool("wake_peer_thread", { message_id: message.id });
assert.equal(missingEndpoint.ok, false);
assert.equal(
  missingEndpoint.error,
  "peer.codex_ipc_socket is required for a targeted wake; message remains unacknowledged",
);
assert.deepEqual(missingEndpoint.attempts, []);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("wake-peer runner marker tests passed\n");
