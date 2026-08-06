#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyHawkspanEnv, minimalChildEnvironment, parseHawkspanEnv, readHawkspanEnv,
  writeHawkspanEnv,
} from "./hawkspan-env.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-env-"));
const envPath = path.join(root, "hawkspan.env");
const values = {
  HAWKSPAN_NODE_ID: "working-node",
  HAWKSPAN_APPLICATION_PLUGIN_ROOT: path.join(root, "plugins"),
  HAWKSPAN_PEER_NODE_ID: "worker-node",
  HAWKSPAN_PEER_USER: "operator",
  HAWKSPAN_REMOTE_STATE_DIR: path.join(root, "remote-state"),
  HAWKSPAN_PRIMARY_ENABLED: "true",
  HAWKSPAN_PRIMARY_LABEL: "Direct cable",
  HAWKSPAN_PRIMARY_LOCAL_HOST: "192.0.2.19",
  HAWKSPAN_PRIMARY_HOST: "192.0.2.20",
  HAWKSPAN_FALLBACK_ENABLED: "false",
  HAWKSPAN_FALLBACK_LABEL: "Fallback cable",
  HAWKSPAN_FALLBACK_LOCAL_HOST: "198.51.100.19",
  HAWKSPAN_FALLBACK_HOST: "198.51.100.20",
  HAWKSPAN_SSH_IDENTITY: "/private/tmp/hawkspan-fixture-key",
  HAWKSPAN_LOCAL_CONTROL_PORT: "8765",
  HAWKSPAN_WORKLOAD_OUTPUT_ROOT: path.join(root, "workload-output"),
  HAWKSPAN_SIMPLETUNER_ROOT: path.join(root, "simpletuner"),
  HAWKSPAN_LOCAL_TRAINER_START_SCRIPT: path.join(root, "trainer-start"),
  HAWKSPAN_READINESS_LOCAL_CONFIG_TIMEOUT_MS: "10000",
  HAWKSPAN_READINESS_PEER_PING_TIMEOUT_MS: "60000",
  HAWKSPAN_READINESS_SSH_PORT_TIMEOUT_MS: "90000",
  HAWKSPAN_READINESS_SSH_LOGIN_TIMEOUT_MS: "120000",
  HAWKSPAN_READINESS_AGENT_TIMEOUT_MS: "90000",
  HAWKSPAN_READINESS_TRAINER_TIMEOUT_MS: "60000",
  HAWKSPAN_READINESS_TOTAL_TIMEOUT_MS: "300000",
  HAWKSPAN_READINESS_RETRY_DELAYS_MS: "2000,3000,5000,8000",
  HAWKSPAN_QUEUE_SUPERVISOR_ENABLED: "true",
  HAWKSPAN_QUEUE_SUPERVISOR_POLL_INTERVAL_MS: "120000",
  HAWKSPAN_QUEUE_WORKER_RESTART_DELAYS_MS: "2000,5000,10000,20000",
  HAWKSPAN_QUEUE_ITEM_LEASE_MS: "300000",
  HAWKSPAN_QUEUE_MAX_ITEMS_PER_WORKER: "10",
  HAWKSPAN_QUEUE_DEFAULT_MAXIMUM_ATTEMPTS: "5",
  HAWKSPAN_PACKAGE_RETURN_LOCK_WAIT_MS: "30000",
  HAWKSPAN_LINK_OPERATION_RETRY_DELAYS_MS: "2000,5000,10000,20000",
  HAWKSPAN_LINK_OPERATION_ATTEMPT_TIMEOUT_MS: "15000",
  HAWKSPAN_LINK_CONNECT_TIMEOUT_MS: "5000",
  HAWKSPAN_LINK_CYCLE_TIMEOUT_MS: "120000",
  HAWKSPAN_LINK_SERVER_ALIVE_INTERVAL_SECONDS: "15",
  HAWKSPAN_LINK_SERVER_ALIVE_COUNT_MAX: "3",
  HAWKSPAN_LINK_PRIMARY_REPROBE_MS: "60000",
};
writeHawkspanEnv(envPath, values);
assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
assert.deepEqual(readHawkspanEnv(envPath), Object.freeze(values));

const applied = applyHawkspanEnv({ application_plugins: {}, local_control: {}, peer: {} }, values);
assert.equal(applied.node_id, "working-node");
assert.deepEqual(applied.application_plugins.roots, [path.join(root, "plugins")]);
assert.equal(applied.peer.primary_enabled, true);
assert.equal(applied.peer.primary_local_host, "192.0.2.19");
assert.equal(applied.peer.fallback_enabled, false);
assert.equal(applied.peer.fallback_local_host, "198.51.100.19");
assert.equal(applied.peer.remote_state_dir, path.join(root, "remote-state"));
assert.equal(applied.local_control.port, 8765);
assert.equal(applied.training.simpletuner_root, path.join(root, "simpletuner"));
assert.equal(applied.training.start_script, path.join(root, "trainer-start"));
assert.equal(applied.readiness.ssh_login_timeout_ms, 120000);
assert.deepEqual(applied.readiness.retry_delays_ms, [2000, 3000, 5000, 8000]);
assert.equal(applied.queue_supervisor.enabled, true);
assert.equal(applied.queue_supervisor.item_lease_ms, 300000);
assert.deepEqual(applied.queue_supervisor.worker_restart_delays_ms, [2000, 5000, 10000, 20000]);
assert.deepEqual(applied.link.operation_retry_delays_ms, [2000, 5000, 10000, 20000]);
assert.equal(applied.link.operation_attempt_timeout_ms, 15000);
assert.equal(applied.link.server_alive_count_max, 3);

const literalPath = path.join(root, "literal.env");
const literalValues = {
  HAWKSPAN_NODE_ID: "node#literal $HOME; $(not-executed)",
  HAWKSPAN_PEER_USER: "user with 'quotes'",
  HAWKSPAN_PRIMARY_LABEL: " leading and trailing ",
  HAWKSPAN_FALLBACK_LABEL: "",
};
writeHawkspanEnv(literalPath, literalValues);
assert.deepEqual(readHawkspanEnv(literalPath), Object.freeze(literalValues));
assert.equal(fs.existsSync(path.join(root, "not-executed")), false);

function rejected(name, body, mode = 0o600) {
  const target = path.join(root, name);
  fs.writeFileSync(target, body, { mode });
  assert.throws(() => readHawkspanEnv(target));
}
rejected("unknown.env", "UNREVIEWED_NAME=value\n");
rejected("duplicate-release-authority.env", "HAWKSPAN_PLUGIN_ROOT=/wrong/release\n");
rejected("static-remote-release.env", "HAWKSPAN_REMOTE_PLUGIN_ROOT=/wrong/release\n");
rejected("replacement.env", "HAWKSPAN_REAL_PAIR_FALLBACK_EVIDENCE=/private/tmp/evidence.json\n");
rejected("duplicate.env", "HAWKSPAN_NODE_ID=one\nHAWKSPAN_NODE_ID=two\n");
rejected("mode.env", "HAWKSPAN_NODE_ID=value\n", 0o644);
const linked = path.join(root, "linked.env");
fs.symlinkSync(envPath, linked);
assert.throws(() => readHawkspanEnv(linked), /regular non-symbolic-link/);

const example = parseHawkspanEnv(fs.readFileSync(
  path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "config", "hawkspan.env.example"),
  "utf8",
));
assert.equal(example.HAWKSPAN_REMOTE_STATE_DIR, "/Users/peeruser/.hawkspan");
assert.equal(Object.hasOwn(example, "HAWKSPAN_REMOTE_PLUGIN_ROOT"), false);
assert.equal(Object.hasOwn(example, "HAWKSPAN_REMOTE_CALL_TOOL"), false);

process.env.HAWKSPAN_PRIVATE_FIXTURE = "must-not-propagate";
assert.equal(Object.hasOwn(minimalChildEnvironment(), "HAWKSPAN_PRIVATE_FIXTURE"), false);
process.stdout.write("hawkspan environment parser tests passed\n");
