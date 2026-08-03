import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export const HAWKSPAN_ENV_NAMES = Object.freeze([
  "HAWKSPAN_CONFIG",
  "HAWKSPAN_CONFIG_PATH",
  "HAWKSPAN_NODE_ID",
  "HAWKSPAN_PLUGIN_ROOT",
  "HAWKSPAN_APPLICATION_PLUGIN_ROOT",
  "HAWKSPAN_PEER_NODE_ID",
  "HAWKSPAN_PEER_PRIMARY_HOST",
  "HAWKSPAN_PEER_FALLBACK_HOST",
  "HAWKSPAN_PEER_USER",
  "HAWKSPAN_PEER_THREAD_ID",
  "HAWKSPAN_REMOTE_NODE",
  "HAWKSPAN_REMOTE_PLUGIN_ROOT",
  "HAWKSPAN_REMOTE_CALL_TOOL",
  "HAWKSPAN_PRIMARY_ENABLED",
  "HAWKSPAN_PRIMARY_LABEL",
  "HAWKSPAN_PRIMARY_HOST",
  "HAWKSPAN_FALLBACK_ENABLED",
  "HAWKSPAN_FALLBACK_LABEL",
  "HAWKSPAN_FALLBACK_HOST",
  "HAWKSPAN_SSH_IDENTITY",
  "HAWKSPAN_REMOTE_INBOX",
  "HAWKSPAN_REMOTE_ARTIFACTS",
  "HAWKSPAN_REMOTE_AUDIT",
  "HAWKSPAN_LOCAL_CONTROL_PORT",
  "HAWKSPAN_LOCAL_CONTROL_URL",
  "HAWKSPAN_REPOSITORY_DIR",
  "HAWKSPAN_REMOTE_CONFIG_PATH",
  "HAWKSPAN_REMOTE_REPOSITORY_DIR",
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
  "HAWKSPAN_REAL_PAIR_FALLBACK_EVIDENCE",
]);

const allowed = new Set(HAWKSPAN_ENV_NAMES);

const BOOLEAN_NAMES = new Set(["HAWKSPAN_PRIMARY_ENABLED", "HAWKSPAN_FALLBACK_ENABLED"]);
const EMPTY_STRING_NAMES = new Set(["HAWKSPAN_PRIMARY_LABEL", "HAWKSPAN_FALLBACK_LABEL"]);
const ABSOLUTE_PATH_NAMES = new Set([
  "HAWKSPAN_CONFIG", "HAWKSPAN_CONFIG_PATH", "HAWKSPAN_PLUGIN_ROOT",
  "HAWKSPAN_APPLICATION_PLUGIN_ROOT", "HAWKSPAN_REMOTE_NODE",
  "HAWKSPAN_REMOTE_PLUGIN_ROOT", "HAWKSPAN_REMOTE_CALL_TOOL", "HAWKSPAN_SSH_IDENTITY",
  "HAWKSPAN_REMOTE_INBOX", "HAWKSPAN_REMOTE_ARTIFACTS", "HAWKSPAN_REMOTE_AUDIT",
  "HAWKSPAN_REPOSITORY_DIR", "HAWKSPAN_REMOTE_CONFIG_PATH",
  "HAWKSPAN_REMOTE_REPOSITORY_DIR", "HAWKSPAN_REMOTE_STATE_DIR", "HAWKSPAN_STATE_DIR",
  "HAWKSPAN_WORKLOAD_INBOX_ROOT", "HAWKSPAN_WORKLOAD_DATASET_ROOT",
  "HAWKSPAN_WORKLOAD_RECIPE_ROOT", "HAWKSPAN_WORKLOAD_OUTPUT_ROOT",
  "HAWKSPAN_WORKLOAD_STATE_ROOT", "HAWKSPAN_WORKLOAD_DISK_ROOT",
  "HAWKSPAN_WORKLOAD_RUNTIME_ROOT", "HAWKSPAN_WORKLOAD_LOG_ROOT",
  "HAWKSPAN_SIMPLETUNER_ROOT",
  "HAWKSPAN_LOCAL_TRAINER_START_SCRIPT", "HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT",
  "HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT",
  "HAWKSPAN_REAL_PAIR_FALLBACK_EVIDENCE",
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
  if (ABSOLUTE_PATH_NAMES.has(name) && !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  if (name === "HAWKSPAN_LOCAL_CONTROL_URL") {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error(`${name} must use http or https`);
  }
}

export function parseHawkspanEnv(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 64 * 1024) {
    throw new Error("hawkspan.env must be no larger than 64 KiB");
  }
  const values = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(raw);
    if (!match) throw new Error(`hawkspan.env line ${index + 1} must be NAME=value`);
    const name = match[1];
    if (!allowed.has(name)) throw new Error(`hawkspan.env line ${index + 1} uses unsupported name: ${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`hawkspan.env contains duplicate name: ${name}`);
    let lineValues;
    try { lineValues = parseEnv(raw); } catch {
      throw new Error(`hawkspan.env line ${index + 1} is not valid Node .env syntax`);
    }
    if (Object.keys(lineValues).length !== 1 || !Object.hasOwn(lineValues, name)) {
      throw new Error(`hawkspan.env line ${index + 1} must contain one NAME=value entry`);
    }
    validateValue(name, lineValues[name]);
    values[name] = lineValues[name];
  }
  return Object.freeze(values);
}

export function readHawkspanEnv(filePath) {
  if (!fs.existsSync(filePath)) return Object.freeze({});
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
  return parseHawkspanEnv(fs.readFileSync(filePath, "utf8"));
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
  assign(next, "plugin_root", "HAWKSPAN_PLUGIN_ROOT");
  next.application_plugins = { ...(next.application_plugins || {}) };
  if (values.HAWKSPAN_APPLICATION_PLUGIN_ROOT) {
    next.application_plugins.roots = [values.HAWKSPAN_APPLICATION_PLUGIN_ROOT];
  }
  next.local_control = { ...(next.local_control || {}) };
  const port = integerValue(values, "HAWKSPAN_LOCAL_CONTROL_PORT", 0, 65535);
  if (port !== undefined) next.local_control.port = port;
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
    ["remote_plugin_root", "HAWKSPAN_REMOTE_PLUGIN_ROOT"],
    ["remote_call_tool", "HAWKSPAN_REMOTE_CALL_TOOL"],
    ["primary_label", "HAWKSPAN_PRIMARY_LABEL"], ["primary_host", "HAWKSPAN_PRIMARY_HOST"],
    ["fallback_label", "HAWKSPAN_FALLBACK_LABEL"], ["fallback_host", "HAWKSPAN_FALLBACK_HOST"],
    ["ssh_identity", "HAWKSPAN_SSH_IDENTITY"], ["remote_inbox", "HAWKSPAN_REMOTE_INBOX"],
    ["remote_artifacts", "HAWKSPAN_REMOTE_ARTIFACTS"], ["remote_audit", "HAWKSPAN_REMOTE_AUDIT"],
  ]) assign(peer, key, name);
  for (const [key, name] of [
    ["primary_enabled", "HAWKSPAN_PRIMARY_ENABLED"],
    ["fallback_enabled", "HAWKSPAN_FALLBACK_ENABLED"],
  ]) {
    const value = booleanValue(values, name);
    if (value !== undefined) peer[key] = value;
  }
  return next;
}

export function redactedHawkspanEnv(values) {
  return Object.fromEntries(Object.keys(values).map((name) => [name, "[configured]" ]));
}

export function writeHawkspanEnv(filePath, values) {
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
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    const roundTrip = readHawkspanEnv(temporary);
    if (
      Object.keys(values).length !== Object.keys(roundTrip).length ||
      Object.entries(values).some(([name, value]) => roundTrip[name] !== value)
    ) {
      throw new Error("hawkspan.env serialization did not round-trip exactly");
    }
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
