#!/usr/bin/env node

import assert from "node:assert/strict";
import { __test } from "./hawkspan-readiness-monitor.mjs";

const config = {
  peer: {
    primary_enabled: true,
    primary_label: "Thunderbolt",
    primary_local_host: "10.44.45.2",
    primary_host: "10.44.45.3",
    fallback_enabled: false,
    fallback_label: "Ethernet",
    fallback_local_host: "10.44.44.2",
    fallback_host: "10.44.44.3",
  },
  readiness: {
    ssh_login_timeout_ms: 7000,
    retry_delays_ms: [1000, 2000],
  },
  link: {
    connect_timeout_ms: 9000,
    server_alive_interval_seconds: 11,
    server_alive_count_max: 4,
  },
};

assert.deepEqual(__test.routeDefinitions(config), [{
  role: "primary",
  label: "Thunderbolt",
  local_host: "10.44.45.2",
  host: "10.44.45.3",
}]);

assert.equal(__test.readinessConfig(config).ssh_login_timeout_ms, 7000);
assert.deepEqual(__test.readinessConfig(config).retry_delays_ms, [1000, 2000]);
assert.equal(__test.readinessConfig({}).total_timeout_ms, __test.DEFAULTS.total_timeout_ms);
assert.equal(__test.shellQuote("a'b"), "'a'\"'\"'b'");
const sshArgs = __test.sshArgs(config, "10.44.45.3", "true");
assert(sshArgs.includes("ConnectTimeout=9"));
assert(sshArgs.includes("ServerAliveInterval=11"));
assert(sshArgs.includes("ServerAliveCountMax=4"));
assert.equal(__test.sshOperationTimeout(config), 54000);

process.stdout.write("hawkspan readiness monitor tests passed\n");
