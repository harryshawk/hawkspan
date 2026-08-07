import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export const HAWKSPAN_ENV_NAMES = Object.freeze([
  "HAWKSPAN_CONFIG",
  "HAWKSPAN_CONFIG_PATH",
  "HAWKSPAN_NODE_ID",
  "HAWKSPAN_ACTIVE_RELEASE_ROOT",
  "HAWKSPAN_APPLICATION_PLUGIN_ROOT",
  "HAWKSPAN_PEER_NODE_ID",
  "HAWKSPAN_PEER_USER",
  "HAWKSPAN_PEER_THREAD_ID",
  "HAWKSPAN_REMOTE_NODE",
  "HAWKSPAN_PRIMARY_ENABLED",
  "HAWKSPAN_PRIMARY_LABEL",
  "HAWKSPAN_PRIMARY_LOCAL_HOST",
  "HAWKSPAN_PRIMARY_HOST",
  "HAWKSPAN_FALLBACK_ENABLED",
  "HAWKSPAN_FALLBACK_LABEL",
  "HAWKSPAN_FALLBACK_LOCAL_HOST",
  "HAWKSPAN_FALLBACK_HOST",
  "HAWKSPAN_SSH_IDENTITY",
  "HAWKSPAN_REMOTE_INBOX",
  "HAWKSPAN_REMOTE_ARTIFACTS",
  "HAWKSPAN_REMOTE_AUDIT",
  "HAWKSPAN_LOCAL_CONTROL_PORT",
  "HAWKSPAN_REPOSITORY_DIR",
  "HAWKSPAN_REMOTE_STATE_DIR",
  "HAWKSPAN_STATE_DIR",
  "HAWKSPAN_WORKLOAD_INBOX_ROOT",
  "HAWKSPAN_WORKLOAD_DATASET_ROOT",
  "HAWKSPAN_WORKLOAD_RECIPE_ROOT",
  "HAWKSPAN_WORKLOAD_OUTPUT_ROOT",
  "HAWKSPAN_WORKLOAD_STATE_ROOT",
  "HAWKSPAN_WORKLOAD_DISK_ROOT",
  "HAWKSPAN_WORKLOAD_RUNTIME_ROOT",
  "HAWKSPAN_WORKLOAD_LOG_ROOT",
  "HAWKSPAN_SIMPLETUNER_ROOT",
  "HAWKSPAN_LOCAL_TRAINER_START_SCRIPT",
  "HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT",
  "HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT",
  "HAWKSPAN_TRAINER_STOP_TERM_TIMEOUT_MS",
  "HAWKSPAN_TRAINER_STOP_KILL_TIMEOUT_MS",
  "HAWKSPAN_TRAINER_STOP_POLL_INTERVAL_MS",
  "HAWKSPAN_READINESS_LOCAL_CONFIG_TIMEOUT_MS",
  "HAWKSPAN_READINESS_PEER_PING_TIMEOUT_MS",
  "HAWKSPAN_READINESS_SSH_PORT_TIMEOUT_MS",
  "HAWKSPAN_READINESS_SSH_LOGIN_TIMEOUT_MS",
  "HAWKSPAN_READINESS_AGENT_TIMEOUT_MS",
  "HAWKSPAN_READINESS_TRAINER_TIMEOUT_MS",
  "HAWKSPAN_READINESS_TOTAL_TIMEOUT_MS",
  "HAWKSPAN_READINESS_RETRY_DELAYS_MS",
  "HAWKSPAN_QUEUE_SUPERVISOR_ENABLED",
  "HAWKSPAN_QUEUE_SUPERVISOR_POLL_INTERVAL_MS",
  "HAWKSPAN_QUEUE_WORKER_RESTART_DELAYS_MS",
  "HAWKSPAN_QUEUE_ITEM_LEASE_MS",
  "HAWKSPAN_QUEUE_MAX_ITEMS_PER_WORKER",
  "HAWKSPAN_QUEUE_DEFAULT_MAXIMUM_ATTEMPTS",
  "HAWKSPAN_QUEUE_DEFAULT_MAX_PENDING_ITEMS",
  "HAWKSPAN_QUEUE_DEFAULT_MAX_PAYLOAD_BYTES",
  "HAWKSPAN_QUEUE_RETRY_JITTER",
  "HAWKSPAN_PACKAGE_RETURN_LOCK_WAIT_MS",
  "HAWKSPAN_SIMPLETUNER_STATE_LOCK_WAIT_MS",
  "HAWKSPAN_LINK_OPERATION_RETRY_DELAYS_MS",
  "HAWKSPAN_LINK_OPERATION_ATTEMPT_TIMEOUT_MS",
  "HAWKSPAN_LINK_CONNECT_TIMEOUT_MS",
  "HAWKSPAN_LINK_CYCLE_TIMEOUT_MS",
  "HAWKSPAN_LINK_SERVER_ALIVE_INTERVAL_SECONDS",
  "HAWKSPAN_LINK_SERVER_ALIVE_COUNT_MAX",
  "HAWKSPAN_LINK_PRIMARY_REPROBE_MS",
]);

export const HAWKSPAN_OPERATIONAL_ENV_DEFAULTS = Object.freeze({
  HAWKSPAN_TRAINER_STOP_TERM_TIMEOUT_MS: "30000",
  HAWKSPAN_TRAINER_STOP_KILL_TIMEOUT_MS: "5000",
  HAWKSPAN_TRAINER_STOP_POLL_INTERVAL_MS: "100",
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
  HAWKSPAN_QUEUE_DEFAULT_MAX_PENDING_ITEMS: "10000",
  HAWKSPAN_QUEUE_DEFAULT_MAX_PAYLOAD_BYTES: "1048576",
  HAWKSPAN_QUEUE_RETRY_JITTER: "true",
  HAWKSPAN_PACKAGE_RETURN_LOCK_WAIT_MS: "30000",
  HAWKSPAN_SIMPLETUNER_STATE_LOCK_WAIT_MS: "30000",
  HAWKSPAN_LINK_OPERATION_RETRY_DELAYS_MS: "2000,5000,10000,20000",
  HAWKSPAN_LINK_OPERATION_ATTEMPT_TIMEOUT_MS: "15000",
  HAWKSPAN_LINK_CONNECT_TIMEOUT_MS: "5000",
  HAWKSPAN_LINK_CYCLE_TIMEOUT_MS: "120000",
  HAWKSPAN_LINK_SERVER_ALIVE_INTERVAL_SECONDS: "15",
  HAWKSPAN_LINK_SERVER_ALIVE_COUNT_MAX: "3",
  HAWKSPAN_LINK_PRIMARY_REPROBE_MS: "60000",
});

export const HAWKSPAN_INTERNAL_ENV_NAMES = Object.freeze([
  "HAWKSPAN_CONFIG",
  "HAWKSPAN_CONFIG_PATH",
  "HAWKSPAN_REPOSITORY_DIR",
  "HAWKSPAN_STATE_DIR",
]);

const allowed = new Set(HAWKSPAN_ENV_NAMES);
export const RETIRED_HAWKSPAN_ENV_NAMES = Object.freeze([
  "HAWKSPAN_PLUGIN_ROOT",
  "HAWKSPAN_LOCAL_CONTROL_URL",
  "HAWKSPAN_REMOTE_PLUGIN_ROOT",
  "HAWKSPAN_REMOTE_CALL_TOOL",
  "HAWKSPAN_REMOTE_REPOSITORY_DIR",
]);
const retired = new Set(RETIRED_HAWKSPAN_ENV_NAMES);

const BOOLEAN_NAMES = new Set([
  "HAWKSPAN_PRIMARY_ENABLED", "HAWKSPAN_FALLBACK_ENABLED",
  "HAWKSPAN_QUEUE_SUPERVISOR_ENABLED",
  "HAWKSPAN_QUEUE_RETRY_JITTER",
]);
const EMPTY_STRING_NAMES = new Set(["HAWKSPAN_PRIMARY_LABEL", "HAWKSPAN_FALLBACK_LABEL"]);
const INTEGER_NAMES = new Set([
  "HAWKSPAN_READINESS_LOCAL_CONFIG_TIMEOUT_MS",
  "HAWKSPAN_READINESS_PEER_PING_TIMEOUT_MS",
  "HAWKSPAN_READINESS_SSH_PORT_TIMEOUT_MS",
  "HAWKSPAN_READINESS_SSH_LOGIN_TIMEOUT_MS",
  "HAWKSPAN_READINESS_AGENT_TIMEOUT_MS",
  "HAWKSPAN_READINESS_TRAINER_TIMEOUT_MS",
  "HAWKSPAN_READINESS_TOTAL_TIMEOUT_MS",
  "HAWKSPAN_TRAINER_STOP_TERM_TIMEOUT_MS",
  "HAWKSPAN_TRAINER_STOP_KILL_TIMEOUT_MS",
  "HAWKSPAN_QUEUE_SUPERVISOR_POLL_INTERVAL_MS",
  "HAWKSPAN_QUEUE_ITEM_LEASE_MS",
  "HAWKSPAN_LINK_CONNECT_TIMEOUT_MS",
  "HAWKSPAN_LINK_CYCLE_TIMEOUT_MS",
  "HAWKSPAN_LINK_OPERATION_ATTEMPT_TIMEOUT_MS",
  "HAWKSPAN_LINK_PRIMARY_REPROBE_MS",
]);
const SHORT_INTERVAL_NAMES = new Set([
  "HAWKSPAN_TRAINER_STOP_POLL_INTERVAL_MS",
]);
const LARGE_INTEGER_NAMES = new Set([
  "HAWKSPAN_PACKAGE_RETURN_LOCK_WAIT_MS",
  "HAWKSPAN_SIMPLETUNER_STATE_LOCK_WAIT_MS",
  "HAWKSPAN_QUEUE_DEFAULT_MAX_PAYLOAD_BYTES",
]);
const COUNT_INTEGER_NAMES = new Set(["HAWKSPAN_QUEUE_DEFAULT_MAX_PENDING_ITEMS"]);
const SMALL_INTEGER_NAMES = new Set([
  "HAWKSPAN_QUEUE_MAX_ITEMS_PER_WORKER",
  "HAWKSPAN_QUEUE_DEFAULT_MAXIMUM_ATTEMPTS",
  "HAWKSPAN_LINK_SERVER_ALIVE_INTERVAL_SECONDS",
  "HAWKSPAN_LINK_SERVER_ALIVE_COUNT_MAX",
]);
const DELAY_LIST_NAMES = new Set([
  "HAWKSPAN_READINESS_RETRY_DELAYS_MS",
  "HAWKSPAN_QUEUE_WORKER_RESTART_DELAYS_MS",
  "HAWKSPAN_LINK_OPERATION_RETRY_DELAYS_MS",
]);
const ABSOLUTE_PATH_NAMES = new Set([
  "HAWKSPAN_CONFIG", "HAWKSPAN_CONFIG_PATH", "HAWKSPAN_ACTIVE_RELEASE_ROOT",
  "HAWKSPAN_APPLICATION_PLUGIN_ROOT", "HAWKSPAN_REMOTE_NODE", "HAWKSPAN_SSH_IDENTITY",
  "HAWKSPAN_REMOTE_INBOX", "HAWKSPAN_REMOTE_ARTIFACTS", "HAWKSPAN_REMOTE_AUDIT",
  "HAWKSPAN_REPOSITORY_DIR", "HAWKSPAN_REMOTE_STATE_DIR", "HAWKSPAN_STATE_DIR",
  "HAWKSPAN_WORKLOAD_INBOX_ROOT", "HAWKSPAN_WORKLOAD_DATASET_ROOT",
  "HAWKSPAN_WORKLOAD_RECIPE_ROOT", "HAWKSPAN_WORKLOAD_OUTPUT_ROOT",
  "HAWKSPAN_WORKLOAD_STATE_ROOT", "HAWKSPAN_WORKLOAD_DISK_ROOT",
  "HAWKSPAN_WORKLOAD_RUNTIME_ROOT", "HAWKSPAN_WORKLOAD_LOG_ROOT",
  "HAWKSPAN_SIMPLETUNER_ROOT",
  "HAWKSPAN_LOCAL_TRAINER_START_SCRIPT", "HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT",
  "HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT",
]);

function validateValue(name, value) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`hawkspan.env ${name} must have a single-line printable value`);
  }
  if (value.length === 0 && !EMPTY_STRING_NAMES.has(name)) {
    throw new Error(`hawkspan.env ${name} must have a nonempty value`);
  }
  if (BOOLEAN_NAMES.has(name) && !new Set(["true", "false"]).has(value)) {
    throw new Error(`${name} must be true or false`);
  }
  if (name === "HAWKSPAN_LOCAL_CONTROL_PORT") integerValue({ [name]: value }, name, 0, 65535);
  if (INTEGER_NAMES.has(name)) integerValue({ [name]: value }, name, 1000, 600000);
  if (SHORT_INTERVAL_NAMES.has(name)) integerValue({ [name]: value }, name, 10, 1000);
  if (LARGE_INTEGER_NAMES.has(name)) integerValue({ [name]: value }, name, 1000, 16777216);
  if (COUNT_INTEGER_NAMES.has(name)) integerValue({ [name]: value }, name, 1, 1000000);
  if (SMALL_INTEGER_NAMES.has(name)) integerValue({ [name]: value }, name, 1, 1000);
  if (DELAY_LIST_NAMES.has(name)) {
    const delays = value.split(",").map((item) => item.trim());
    if (delays.length < 1 || delays.length > 16 || delays.some((item) => !/^\d+$/.test(item))) {
      throw new Error(`${name} must be a comma-separated list of 1 to 16 millisecond integers`);
    }
    for (const item of delays) integerValue({ [name]: item }, name, 100, 60000);
  }
  if (ABSOLUTE_PATH_NAMES.has(name) && !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
}

function parseHawkspanEnvInternal(text, { allowRetired = false } = {}) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 64 * 1024) {
    throw new Error("hawkspan.env must be no larger than 64 KiB");
  }
  const values = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(raw);
    if (!match) throw new Error(`hawkspan.env line ${index + 1} must be NAME=value`);
    const name = match[1];
    if (!allowed.has(name) && !(allowRetired && retired.has(name))) {
      throw new Error(`hawkspan.env line ${index + 1} uses unsupported name: ${name}`);
    }
    if (Object.hasOwn(values, name)) throw new Error(`hawkspan.env contains duplicate name: ${name}`);
    let lineValues;
    try { lineValues = parseEnv(raw); } catch {
      throw new Error(`hawkspan.env line ${index + 1} is not valid Node .env syntax`);
    }
    if (Object.keys(lineValues).length !== 1 || !Object.hasOwn(lineValues, name)) {
      throw new Error(`hawkspan.env line ${index + 1} must contain one NAME=value entry`);
    }
    if (allowed.has(name)) validateValue(name, lineValues[name]);
    values[name] = lineValues[name];
  }
  return Object.freeze(values);
}

export function parseHawkspanEnv(text) {
  return parseHawkspanEnvInternal(text);
}

function readHawkspanEnvText(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("hawkspan.env must be a regular non-symbolic-link file");
  }
  if (![0o400, 0o600].includes(stat.mode & 0o777)) {
    throw new Error("hawkspan.env must have mode 400 or 600");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("hawkspan.env must be owned by the current user");
  }
  if (stat.size > 64 * 1024) throw new Error("hawkspan.env must be no larger than 64 KiB");
  return fs.readFileSync(filePath, "utf8");
}

export function readHawkspanEnv(filePath) {
  const text = readHawkspanEnvText(filePath);
  return text === null ? Object.freeze({}) : parseHawkspanEnv(text);
}

export function readHawkspanEnvForUpgrade(filePath) {
  const text = readHawkspanEnvText(filePath);
  if (text === null) return Object.freeze({ values: Object.freeze({}), retired_names: Object.freeze([]) });
  const parsed = parseHawkspanEnvInternal(text, { allowRetired: true });
  const retiredNames = Object.keys(parsed).filter((name) => retired.has(name)).sort();
  const values = Object.fromEntries(Object.entries(parsed).filter(([name]) => allowed.has(name)));
  return Object.freeze({
    values: Object.freeze(values),
    retired_names: Object.freeze(retiredNames),
  });
}

function booleanValue(values, name) {
  if (!Object.hasOwn(values, name)) return undefined;
  if (!new Set(["true", "false"]).has(values[name])) {
    throw new Error(`${name} must be true or false`);
  }
  return values[name] === "true";
}

function integerValue(values, name, minimum, maximum) {
  if (!Object.hasOwn(values, name)) return undefined;
  if (!/^\d+$/.test(values[name])) throw new Error(`${name} must be an integer`);
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function applyHawkspanEnv(configuration, values) {
  const next = structuredClone(configuration);
  const assign = (target, key, name) => {
    if (Object.hasOwn(values, name)) target[key] = values[name];
  };
  assign(next, "node_id", "HAWKSPAN_NODE_ID");
  next.application_plugins = { ...(next.application_plugins || {}) };
  if (values.HAWKSPAN_APPLICATION_PLUGIN_ROOT) {
    next.application_plugins.roots = [values.HAWKSPAN_APPLICATION_PLUGIN_ROOT];
  }
  next.local_control = { ...(next.local_control || {}) };
  const port = integerValue(values, "HAWKSPAN_LOCAL_CONTROL_PORT", 0, 65535);
  if (port !== undefined) next.local_control.port = port;
  next.training = { ...(next.training || {}) };
  for (const [key, name] of [
    ["simpletuner_root", "HAWKSPAN_SIMPLETUNER_ROOT"],
    ["start_script", "HAWKSPAN_LOCAL_TRAINER_START_SCRIPT"],
    ["stop_script", "HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT"],
    ["package_script", "HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT"],
  ]) assign(next.training, key, name);
  for (const [key, name, minimum, maximum] of [
    ["stop_term_timeout_ms", "HAWKSPAN_TRAINER_STOP_TERM_TIMEOUT_MS", 1000, 600000],
    ["stop_kill_timeout_ms", "HAWKSPAN_TRAINER_STOP_KILL_TIMEOUT_MS", 1000, 600000],
    ["stop_poll_interval_ms", "HAWKSPAN_TRAINER_STOP_POLL_INTERVAL_MS", 10, 1000],
  ]) {
    const value = integerValue(values, name, minimum, maximum);
    if (value !== undefined) next.training[key] = value;
  }
  const peerEnvironmentNames = HAWKSPAN_ENV_NAMES.filter((name) =>
    name.startsWith("HAWKSPAN_PEER_") || name.startsWith("HAWKSPAN_REMOTE_") ||
    name.startsWith("HAWKSPAN_PRIMARY_") || name.startsWith("HAWKSPAN_FALLBACK_") ||
    name === "HAWKSPAN_SSH_IDENTITY");
  const hasPeerEnvironment = peerEnvironmentNames.some((name) => Object.hasOwn(values, name));
  if (next.peer || hasPeerEnvironment) next.peer = { ...(next.peer || {}) };
  const peer = next.peer || {};
  for (const [key, name] of [
    ["node_id", "HAWKSPAN_PEER_NODE_ID"], ["user", "HAWKSPAN_PEER_USER"],
    ["thread_id", "HAWKSPAN_PEER_THREAD_ID"], ["remote_node", "HAWKSPAN_REMOTE_NODE"],
    ["primary_label", "HAWKSPAN_PRIMARY_LABEL"], ["primary_local_host", "HAWKSPAN_PRIMARY_LOCAL_HOST"],
    ["primary_host", "HAWKSPAN_PRIMARY_HOST"],
    ["fallback_label", "HAWKSPAN_FALLBACK_LABEL"], ["fallback_local_host", "HAWKSPAN_FALLBACK_LOCAL_HOST"],
    ["fallback_host", "HAWKSPAN_FALLBACK_HOST"],
    ["ssh_identity", "HAWKSPAN_SSH_IDENTITY"], ["remote_inbox", "HAWKSPAN_REMOTE_INBOX"],
    ["remote_artifacts", "HAWKSPAN_REMOTE_ARTIFACTS"], ["remote_audit", "HAWKSPAN_REMOTE_AUDIT"],
    ["remote_state_dir", "HAWKSPAN_REMOTE_STATE_DIR"],
  ]) assign(peer, key, name);
  for (const [key, name] of [
    ["primary_enabled", "HAWKSPAN_PRIMARY_ENABLED"],
    ["fallback_enabled", "HAWKSPAN_FALLBACK_ENABLED"],
  ]) {
    const value = booleanValue(values, name);
    if (value !== undefined) peer[key] = value;
  }
  next.readiness = { ...(next.readiness || {}) };
  for (const [key, name] of [
    ["local_config_timeout_ms", "HAWKSPAN_READINESS_LOCAL_CONFIG_TIMEOUT_MS"],
    ["peer_ping_timeout_ms", "HAWKSPAN_READINESS_PEER_PING_TIMEOUT_MS"],
    ["ssh_port_timeout_ms", "HAWKSPAN_READINESS_SSH_PORT_TIMEOUT_MS"],
    ["ssh_login_timeout_ms", "HAWKSPAN_READINESS_SSH_LOGIN_TIMEOUT_MS"],
    ["agent_timeout_ms", "HAWKSPAN_READINESS_AGENT_TIMEOUT_MS"],
    ["trainer_timeout_ms", "HAWKSPAN_READINESS_TRAINER_TIMEOUT_MS"],
    ["total_timeout_ms", "HAWKSPAN_READINESS_TOTAL_TIMEOUT_MS"],
  ]) {
    const value = integerValue(values, name, 1000, 600000);
    if (value !== undefined) next.readiness[key] = value;
  }
  if (Object.hasOwn(values, "HAWKSPAN_READINESS_RETRY_DELAYS_MS")) {
    next.readiness.retry_delays_ms = values.HAWKSPAN_READINESS_RETRY_DELAYS_MS
      .split(",")
      .map((item) => Number(item.trim()));
  }
  next.queue_supervisor = { ...(next.queue_supervisor || {}) };
  for (const [key, name, minimum, maximum] of [
    ["poll_interval_ms", "HAWKSPAN_QUEUE_SUPERVISOR_POLL_INTERVAL_MS", 1000, 600000],
    ["item_lease_ms", "HAWKSPAN_QUEUE_ITEM_LEASE_MS", 1000, 600000],
    ["max_items_per_worker", "HAWKSPAN_QUEUE_MAX_ITEMS_PER_WORKER", 1, 1000],
    ["default_maximum_attempts", "HAWKSPAN_QUEUE_DEFAULT_MAXIMUM_ATTEMPTS", 1, 100],
    ["default_maximum_pending_items", "HAWKSPAN_QUEUE_DEFAULT_MAX_PENDING_ITEMS", 1, 1000000],
    ["default_maximum_payload_bytes", "HAWKSPAN_QUEUE_DEFAULT_MAX_PAYLOAD_BYTES", 1024, 16777216],
  ]) {
    const value = integerValue(values, name, minimum, maximum);
    if (value !== undefined) next.queue_supervisor[key] = value;
  }
  const supervisorEnabled = booleanValue(values, "HAWKSPAN_QUEUE_SUPERVISOR_ENABLED");
  if (supervisorEnabled !== undefined) next.queue_supervisor.enabled = supervisorEnabled;
  const retryJitter = booleanValue(values, "HAWKSPAN_QUEUE_RETRY_JITTER");
  if (retryJitter !== undefined) next.queue_supervisor.retry_jitter = retryJitter;
  if (Object.hasOwn(values, "HAWKSPAN_QUEUE_WORKER_RESTART_DELAYS_MS")) {
    next.queue_supervisor.worker_restart_delays_ms = values.HAWKSPAN_QUEUE_WORKER_RESTART_DELAYS_MS
      .split(",").map((item) => Number(item.trim()));
  }
  next.link = { ...(next.link || {}) };
  for (const [key, name, minimum, maximum] of [
    ["connect_timeout_ms", "HAWKSPAN_LINK_CONNECT_TIMEOUT_MS", 1000, 600000],
    ["cycle_timeout_ms", "HAWKSPAN_LINK_CYCLE_TIMEOUT_MS", 1000, 600000],
    ["operation_attempt_timeout_ms", "HAWKSPAN_LINK_OPERATION_ATTEMPT_TIMEOUT_MS", 1000, 600000],
    ["server_alive_interval_seconds", "HAWKSPAN_LINK_SERVER_ALIVE_INTERVAL_SECONDS", 1, 1000],
    ["server_alive_count_max", "HAWKSPAN_LINK_SERVER_ALIVE_COUNT_MAX", 1, 1000],
    ["primary_reprobe_ms", "HAWKSPAN_LINK_PRIMARY_REPROBE_MS", 1000, 600000],
  ]) {
    const value = integerValue(values, name, minimum, maximum);
    if (value !== undefined) next.link[key] = value;
  }
  if (Object.hasOwn(values, "HAWKSPAN_LINK_OPERATION_RETRY_DELAYS_MS")) {
    next.link.operation_retry_delays_ms = values.HAWKSPAN_LINK_OPERATION_RETRY_DELAYS_MS
      .split(",").map((item) => Number(item.trim()));
  }
  return next;
}

export function redactedHawkspanEnv(values) {
  return Object.fromEntries(Object.keys(values).map((name) => [name, "[configured]" ]));
}

export function serializeHawkspanEnv(values) {
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) throw new Error(`unsupported HawkSpan environment name: ${name}`);
    validateValue(name, values[name]);
  }
  const quoteLiteral = (value) => {
    for (const quote of ['"', "'", "`"]) {
      if (!value.includes(quote)) return `${quote}${value}${quote}`;
    }
    throw new Error("hawkspan.env values cannot contain all three Node .env quote characters");
  };
  const body = `${HAWKSPAN_ENV_NAMES
    .filter((name) => Object.hasOwn(values, name))
    .map((name) => `${name}=${quoteLiteral(values[name])}`)
    .join("\n")}\n`;
  const roundTrip = parseHawkspanEnv(body);
  if (
    Object.keys(values).length !== Object.keys(roundTrip).length ||
    Object.entries(values).some(([name, value]) => roundTrip[name] !== value)
  ) {
    throw new Error("hawkspan.env serialization did not round-trip exactly");
  }
  return body;
}

export function writeHawkspanEnv(filePath, values) {
  const body = serializeHawkspanEnv(values);
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    readHawkspanEnv(temporary);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const CHILD_ENV_ALLOWLIST = Object.freeze([
  "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "SSH_AUTH_SOCK",
  "TMPDIR", "USER", "XPC_FLAGS", "XPC_SERVICE_NAME",
  "HAWKSPAN_FALLBACK_MARKER", "HAWKSPAN_PROBE_CAPTURE", "HAWKSPAN_SSH_CAPTURE",
  "HAWKSPAN_TEST_SSH_LOG",
]);

export function minimalChildEnvironment(overrides = {}) {
  const environment = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  return { ...environment, ...overrides };
}
