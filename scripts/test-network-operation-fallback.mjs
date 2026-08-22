#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-network-fallback-"));
const bin = path.join(root, "bin");
const log = path.join(root, "route-attempts.log");
fs.mkdirSync(bin, { recursive: true });

const fakeSsh = path.join(bin, "ssh");
fs.writeFileSync(fakeSsh, `#!/bin/sh
printf 'ssh %s\n' "$*" >> "$HAWKSPAN_TEST_ROUTE_LOG"
exit 0
`, { mode: 0o755 });

const fakeRsync = path.join(bin, "rsync");
fs.writeFileSync(fakeRsync, `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\n' '--partial --append-verify'
  exit 0
fi
printf 'rsync %s\n' "$*" >> "$HAWKSPAN_TEST_ROUTE_LOG"
case "$*" in
  *192.0.2.11*) exec /bin/sleep 5 ;;
  *198.51.100.11*) exit 0 ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });

const configPath = path.join(root, "config.json");
fs.writeFileSync(configPath, `${JSON.stringify({
  schema_version: 1,
  node_id: "fallback-test-controller",
  peer: {
    node_id: "fallback-test-worker",
    user: "peeruser",
    primary_enabled: true,
    primary_host: "192.0.2.11",
    fallback_enabled: true,
    fallback_host: "198.51.100.11",
    remote_inbox: "/Users/peeruser/.hawkspan/inbox",
    allow_remote_wake: false,
  },
  link: {
    operation_retry_delays_ms: [100],
    operation_attempt_timeout_ms: 1000,
    connect_timeout_ms: 1000,
    cycle_timeout_ms: 5000,
    server_alive_interval_seconds: 1,
    server_alive_count_max: 1,
    primary_reprobe_ms: 1000,
  },
}, null, 2)}\n`);

const started = Date.now();
const result = spawnSync(process.execPath, [
  path.join(scripts, "call-tool.mjs"),
  "send_message",
  JSON.stringify({
    target_thread_id: "00000000-0000-0000-0000-000000000010",
    subject: "bounded fallback test",
    body: "The same immutable envelope must retry on primary before fallback.",
  }),
], {
  encoding: "utf8",
  timeout: 15000,
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HAWKSPAN_STATE_DIR: root,
    HAWKSPAN_CONFIG: configPath,
    HAWKSPAN_TEST_ROUTE_LOG: log,
  },
});
assert.equal(result.status, 0, result.stderr);
const response = JSON.parse(result.stdout);
assert.equal(response.isError, false, response.content?.[0]?.text);
const delivery = response.structuredContent.delivery;
assert.equal(delivery.ok, true);
assert.equal(delivery.host, "198.51.100.11");
assert.deepEqual(
  delivery.attempts.map(({ host, cycle, stage }) => ({ host, cycle, stage })),
  [
    { host: "192.0.2.11", cycle: 1, stage: "rsync" },
    { host: "192.0.2.11", cycle: 2, stage: "rsync" },
    { host: "198.51.100.11", cycle: 1, stage: "rsync" },
  ],
);
assert(
  Date.now() - started < 5000,
  "per-attempt timeout must preserve enough cycle budget to reach fallback",
);
assert(fs.existsSync(response.structuredContent.envelope_path));
const routeLog = fs.readFileSync(log, "utf8");
assert.equal((routeLog.match(/rsync .*192\.0\.2\.11/g) || []).length, 2);
assert.equal((routeLog.match(/rsync .*198\.51\.100\.11/g) || []).length, 1);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("bounded application retry and Ethernet fallback tests passed\n");
