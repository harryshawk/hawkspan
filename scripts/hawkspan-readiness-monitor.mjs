#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyHawkspanEnv, readHawkspanEnv } from "./hawkspan-env.mjs";

const DEFAULTS = Object.freeze({
  local_config_timeout_ms: 10000,
  peer_ping_timeout_ms: 60000,
  ssh_port_timeout_ms: 90000,
  ssh_login_timeout_ms: 120000,
  agent_timeout_ms: 90000,
  trainer_timeout_ms: 60000,
  total_timeout_ms: 300000,
  retry_delays_ms: [2000, 3000, 5000, 8000],
});

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function nowIso() {
  return new Date().toISOString();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function routeDefinitions(config) {
  if (!config.peer) return [];
  return [
    config.peer.primary_enabled === false ? null : {
      role: "primary",
      label: config.peer.primary_label || "Primary",
      local_host: config.peer.primary_local_host || null,
      host: config.peer.primary_host || null,
    },
    config.peer.fallback_enabled === false ? null : {
      role: "fallback",
      label: config.peer.fallback_label || "Fallback",
      local_host: config.peer.fallback_local_host || null,
      host: config.peer.fallback_host || null,
    },
  ].filter((route) => route?.host);
}

function readinessConfig(config) {
  return {
    ...DEFAULTS,
    ...(config.readiness || {}),
    retry_delays_ms: Array.isArray(config.readiness?.retry_delays_ms) &&
      config.readiness.retry_delays_ms.length
      ? config.readiness.retry_delays_ms
      : DEFAULTS.retry_delays_ms,
  };
}

function run(command, args, timeoutMs, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: options.env || process.env,
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal || null,
    duration_ms: Date.now() - started,
    stdout: result.stdout?.trim() || "",
    stderr: result.stderr?.trim() || "",
    ok: result.status === 0,
  };
}

function sshArgs(config, host, remoteCommand) {
  const args = [];
  if (config.peer?.ssh_identity) args.push("-i", config.peer.ssh_identity);
  const connectSeconds = Math.max(1, Math.ceil(Number(config.link?.connect_timeout_ms || 5000) / 1000));
  const aliveInterval = Number(config.link?.server_alive_interval_seconds || 15);
  const aliveCount = Number(config.link?.server_alive_count_max || 3);
  args.push(
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectSeconds}`,
    "-o", `ServerAliveInterval=${aliveInterval}`,
    "-o", `ServerAliveCountMax=${aliveCount}`,
    `${config.peer?.user}@${host}`,
    remoteCommand,
  );
  return args;
}

function sshOperationTimeout(config) {
  const connectMs = Number(config.link?.connect_timeout_ms || 5000);
  const keepaliveMs = Number(config.link?.server_alive_interval_seconds || 15) *
    Number(config.link?.server_alive_count_max || 3) * 1000;
  return Math.min(600000, connectMs + keepaliveMs + 1000);
}

function attemptTimeout(config, budgetMs, operations = 1) {
  return Math.max(1, Math.min(sshOperationTimeout(config), Math.floor(budgetMs / operations)));
}

function layer(name, route, state, details = {}) {
  return {
    name,
    route: route?.role || null,
    label: route?.label || null,
    host: route?.host || null,
    state,
    checked_at: nowIso(),
    ...details,
  };
}

function localConfigProbe(route, config) {
  if (!route.local_host) {
    return layer("local_config", route, "not_configured", {
      ok: true,
      evidence: "no expected local host configured",
    });
  }
  const result = run("/sbin/ifconfig", [], 5000);
  const ok = result.stdout.includes(`inet ${route.local_host} `);
  return layer("local_config", route, ok ? "ok" : "failed", {
    ok,
    expected_local_host: route.local_host,
    evidence: ok
      ? "expected local host is configured"
      : (result.stderr || result.error || "expected local host not found in ifconfig"),
    duration_ms: result.duration_ms,
  });
}

function pingProbe(route) {
  const result = run("ping", ["-c", "1", "-W", "1000", route.host], 3000);
  return layer("peer_ping", route, result.ok ? "ok" : "failed", {
    ok: result.ok,
    evidence: result.ok ? result.stdout.split("\n").at(-1) || "ping ok" : result.stderr || result.stdout || "ping failed",
    duration_ms: result.duration_ms,
  });
}

function tcpPortProbe(route) {
  const result = run("nc", ["-vz", "-G", "3", route.host, "22"], 5000);
  return layer("ssh_port", route, result.ok ? "ok" : "failed", {
    ok: result.ok,
    evidence: result.ok ? result.stderr || result.stdout || "tcp 22 open" : result.stderr || result.stdout || "tcp 22 unavailable",
    duration_ms: result.duration_ms,
  });
}

function sshLoginProbe(route, config, budgetMs) {
  const result = run("ssh", sshArgs(config, route.host, "true"), attemptTimeout(config, budgetMs));
  return layer("ssh_login", route, result.ok ? "ok" : "failed", {
    ok: result.ok,
    evidence: result.ok ? "authenticated command succeeded" : result.stderr || result.stdout || "ssh login failed",
    duration_ms: result.duration_ms,
  });
}

function agentProbe(route, config, budgetMs) {
  const stateRoot = config.peer?.remote_state_dir || path.join("/Users", config.peer?.user || "", ".hawkspan");
  const authorityPath = path.join(stateRoot, "installed-revision.json");
  const timeout = attemptTimeout(config, budgetMs, 2);
  const authorityResult = run("ssh", sshArgs(config, route.host, `cat ${shellQuote(authorityPath)}`), timeout);
  if (!authorityResult.ok) {
    return layer("hawkspan_agent", route, "failed", {
      ok: false,
      expected_remote_authority: authorityPath,
      evidence: authorityResult.stderr || authorityResult.stdout || "remote release authority unavailable",
      duration_ms: authorityResult.duration_ms,
    });
  }
  let authority;
  try {
    authority = JSON.parse(authorityResult.stdout);
  } catch {
    return layer("hawkspan_agent", route, "failed", {
      ok: false,
      expected_remote_authority: authorityPath,
      evidence: "remote release authority returned invalid JSON",
      duration_ms: authorityResult.duration_ms,
    });
  }
  const remoteRoot = authority.active_release_root;
  if (authority.schema_version !== 2 || !authority.revision ||
      typeof remoteRoot !== "string" || !path.isAbsolute(remoteRoot)) {
    return layer("hawkspan_agent", route, "failed", {
      ok: false,
      expected_remote_authority: authorityPath,
      evidence: "remote release authority is incomplete",
      duration_ms: authorityResult.duration_ms,
    });
  }
  const localControlPath = path.join(remoteRoot || "", "scripts", "local-control-agent.mjs");
  const mcpPath = path.join(remoteRoot || "", "scripts", "mcp-server.mjs");
  const command = [
    `test -f ${shellQuote(path.join(remoteRoot || "", "scripts", "call-tool.mjs"))}`,
    "&&",
    "ps axww -o command=",
    "|",
    `grep -F ${shellQuote(localControlPath)}`,
    ">/dev/null",
    "&&",
    "ps axww -o command=",
    "|",
    `grep -F ${shellQuote(mcpPath)}`,
    ">/dev/null",
  ].join(" ");
  const result = run("ssh", sshArgs(config, route.host, command), timeout);
  return layer("hawkspan_agent", route, result.ok ? "ok" : "failed", {
    ok: result.ok,
    remote_revision: String(authority.revision),
    expected_remote_plugin_root: remoteRoot,
    evidence: result.ok ? "remote HawkSpan scripts and process are present" : result.stderr || result.stdout || "remote HawkSpan agent unavailable",
    duration_ms: result.duration_ms,
  });
}

function trainerProbe(route, config, budgetMs) {
  if (config.node_role === "worker") {
    return layer("trainer_ready", route, "not_required", {
      ok: true,
      evidence: "worker node does not require trainer readiness on controller peer",
    });
  }
  const stateRoot = config.peer?.remote_state_dir || path.join("/Users", config.peer?.user || "", ".hawkspan");
  const commands = [
    `test -d ${shellQuote(stateRoot)}`,
    `test -d ${shellQuote(path.join(stateRoot, "trainer-control"))}`,
    `test -d ${shellQuote(path.join(stateRoot, "workloads"))}`,
  ];
  const result = run("ssh", sshArgs(config, route.host, commands.join(" && ")), attemptTimeout(config, budgetMs));
  return layer("trainer_ready", route, result.ok ? "ok" : "failed", {
    ok: result.ok,
    expected_remote_state_root: stateRoot,
    evidence: result.ok ? "remote trainer state directories are present" : result.stderr || result.stdout || "remote trainer state unavailable",
    duration_ms: result.duration_ms,
  });
}

function boundedProbe(name, route, timeoutMs, totalDeadline, delays, probe) {
  const deadline = Math.min(Date.now() + timeoutMs, totalDeadline);
  let attempts = 0;
  let last = null;
  while (Date.now() < deadline) {
    attempts += 1;
    last = probe(deadline - Date.now());
    last.attempts = attempts;
    if (last.ok) return last;
    const delay = delays[Math.min(attempts - 1, delays.length - 1)] || 1000;
    if (Date.now() + delay > deadline) break;
    last.state = "recovering";
    last.next_retry_ms = delay;
    sleep(delay);
  }
  return {
    ...(last || layer(name, route, "failed", { ok: false, evidence: "probe did not run" })),
    state: "failed",
    attempts,
    timed_out: true,
  };
}

function routeReadiness(route, config, limits, totalDeadline, options) {
  const delays = limits.retry_delays_ms;
  const layers = [];
  const add = (name, timeout, probe) => {
    if (Date.now() >= totalDeadline) {
      layers.push(layer(name, route, "failed", { ok: false, evidence: "total readiness timeout reached", timed_out: true }));
      return false;
    }
    const result = options.once
      ? probe(timeout)
      : boundedProbe(name, route, timeout, totalDeadline, delays, probe);
    layers.push(result);
    return result.ok;
  };
  const ok = add("local_config", limits.local_config_timeout_ms, () => localConfigProbe(route, config)) &&
    add("peer_ping", limits.peer_ping_timeout_ms, () => pingProbe(route)) &&
    add("ssh_port", limits.ssh_port_timeout_ms, () => tcpPortProbe(route)) &&
    add("ssh_login", limits.ssh_login_timeout_ms, (budget) => sshLoginProbe(route, config, budget)) &&
    add("hawkspan_agent", limits.agent_timeout_ms, (budget) => agentProbe(route, config, budget)) &&
    add("trainer_ready", limits.trainer_timeout_ms, (budget) => trainerProbe(route, config, budget));
  return {
    role: route.role,
    label: route.label,
    host: route.host,
    local_host: route.local_host,
    ready: ok,
    transport_ready: layers.some((entry) => entry.name === "ssh_login" && entry.ok),
    network_reachable: layers.some((entry) => entry.name === "peer_ping" && entry.ok),
    failed_layer: ok ? null : layers.find((entry) => !entry.ok)?.name || null,
    layers,
  };
}

export function runReadinessMonitor(config, options = {}) {
  const started = Date.now();
  const limits = readinessConfig(config);
  const totalDeadline = started + limits.total_timeout_ms;
  const routes = routeDefinitions(config);
  const route_results = routes.map((route) => routeReadiness(route, config, limits, totalDeadline, options));
  const selected = route_results.find((route) => route.ready) ||
    route_results.find((route) => route.transport_ready) ||
    null;
  return {
    schema_version: 1,
    generated_at: nowIso(),
    duration_ms: Date.now() - started,
    state: selected?.ready ? "ready" : selected?.transport_ready ? "partial" : "failed",
    selected_route_role: selected?.role || null,
    selected_route: selected?.host || null,
    limits,
    routes: route_results,
  };
}

function readConfigForCli() {
  const stateRoot = path.resolve(process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"));
  const configPath = path.resolve(process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH || path.join(stateRoot, "config.json"));
  const envPath = path.join(stateRoot, "hawkspan.env");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  return applyHawkspanEnv(config, readHawkspanEnv(envPath));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = {
    once: process.argv.includes("--once"),
  };
  const result = runReadinessMonitor(readConfigForCli(), options);
  if (process.env.HAWKSPAN_READINESS_AUDIT_PATH) {
    fs.mkdirSync(path.dirname(process.env.HAWKSPAN_READINESS_AUDIT_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(process.env.HAWKSPAN_READINESS_AUDIT_PATH, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.state === "failed" ? 1 : 0);
}

export const __test = {
  DEFAULTS,
  readinessConfig,
  routeDefinitions,
  sshArgs,
  sshOperationTimeout,
  shellQuote,
};
