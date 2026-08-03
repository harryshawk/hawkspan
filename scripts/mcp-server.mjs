#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createApplicationPluginFramework } from "./application-plugins.mjs";
import {
  applyHawkspanEnv, minimalChildEnvironment, readHawkspanEnv, redactedHawkspanEnv,
  writeHawkspanEnv,
} from "./hawkspan-env.mjs";
import { startLocalControlSurface } from "./local-control-surface.mjs";

const STATE_ROOT = process.env.HAWKSPAN_STATE_DIR
  ? path.resolve(process.env.HAWKSPAN_STATE_DIR)
  : path.join(os.homedir(), ".hawkspan");
const CONFIG_PATH = process.env.HAWKSPAN_CONFIG
  ? path.resolve(process.env.HAWKSPAN_CONFIG)
  : path.join(STATE_ROOT, "config.json");
const ENV_PATH = path.join(STATE_ROOT, "hawkspan.env");
const DB_PATH = path.join(STATE_ROOT, "spool.sqlite3");
const INBOX = path.join(STATE_ROOT, "inbox");
const OUTBOX = path.join(STATE_ROOT, "outbox");
const ARTIFACTS = path.join(STATE_ROOT, "artifacts");
const AUDIT = path.join(STATE_ROOT, "audit");
const CONFIGURATION_PROFILES_PATH = path.join(STATE_ROOT, "configuration-profiles.json");
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
let localControl = null;

for (const dir of [STATE_ROOT, INBOX, OUTBOX, ARTIFACTS, AUDIT]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const defaultConfig = {
  schema_version: 1,
  node_id: "unconfigured-node",
  role_profile: "symmetric",
  features: {},
  local_control: {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
  },
  peer: null,
};

function readConfig() {
  const loaded = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    : {};
  return applyHawkspanEnv({
    ...defaultConfig,
    ...loaded,
  }, machineEnvironment);
}

let machineEnvironment = readHawkspanEnv(ENV_PATH);
const config = readConfig();

const nonSecretMachineNames = new Set([
  "HAWKSPAN_PRIMARY_ENABLED", "HAWKSPAN_FALLBACK_ENABLED",
  "HAWKSPAN_PRIMARY_LABEL", "HAWKSPAN_FALLBACK_LABEL",
  "HAWKSPAN_LOCAL_CONTROL_PORT",
]);
function redactResolvedMachineValues(value) {
  const secrets = Object.entries(machineEnvironment)
    .filter(([name]) => !nonSecretMachineNames.has(name))
    .map(([, configured]) => configured)
    .filter((configured) => configured.length >= 3)
    .sort((left, right) => right.length - left.length);
  const redactString = (input) => secrets.reduce(
    (result, configured) => result.replaceAll(configured, "[configured]"),
    input,
  );
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactResolvedMachineValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, redactResolvedMachineValues(item),
    ]));
  }
  return value;
}

function redactResolvedMachineError(error) {
  const configuredValues = Object.values(machineEnvironment)
    .filter((configured) => configured.length >= 3)
    .sort((left, right) => right.length - left.length);
  return configuredValues.reduce(
    (message, configured) => message.replaceAll(configured, "[configured]"),
    String(error?.message || error),
  );
}

const approvedFeatureDefaults = Object.freeze({
  allow_peer_commands: { inbound: true, outbound: true },
  require_authorized_job_for_all_commands: false,
  require_authorized_job_for_consequential_commands: false,
  allowed_peer_tools: { inbound: "current", outbound: "current" },
  allow_peer_wakeup: { inbound: true, outbound: true },
  allow_peer_messages: { inbound: true, outbound: true },
  allow_peer_acknowledgements: { inbound: true, outbound: true },
  allow_peer_jobs: { inbound: true, outbound: true },
  allow_peer_artifact_send: { inbound: true, outbound: true },
  allow_peer_artifact_receive: { inbound: true, outbound: true },
  enable_background_outbox: true,
  enable_background_artifact_sender: true,
  enable_background_artifact_receiver: true,
  enable_scoped_operation_adapters: true,
  enable_broad_run_command: { inbound: true, outbound: true },
  audit_command_content: true,
  artifact_verification_mode: "on-change",
  wake_prompt_mode: "embedded-message",
  strict_host_key_checking: true,
});
const approvedFeatureKeys = new Set(Object.keys(approvedFeatureDefaults));

function validateDirectionalBoolean(name, value) {
  if (typeof value === "boolean") return { inbound: value, outbound: value };
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => ["inbound", "outbound"].includes(key)) &&
    ["inbound", "outbound"].every((key) => value[key] === undefined || typeof value[key] === "boolean")
  ) {
    return {
      inbound: value.inbound ?? approvedFeatureDefaults[name].inbound,
      outbound: value.outbound ?? approvedFeatureDefaults[name].outbound,
    };
  }
  throw new Error(`${name} must be a boolean or an inbound/outbound boolean object`);
}

function validateFeature(name, value) {
  if (!approvedFeatureKeys.has(name)) throw new Error(`unsupported configuration key: ${name}`);
  if (name === "artifact_verification_mode") {
    if (!["always", "on-change", "cached"].includes(value)) {
      throw new Error("artifact_verification_mode must be always, on-change, or cached");
    }
    return value;
  }
  if (name === "wake_prompt_mode") {
    if (!["notification", "embedded-message"].includes(value)) {
      throw new Error("wake_prompt_mode must be notification or embedded-message");
    }
    return value;
  }
  if (name === "allowed_peer_tools") {
    if (value === "current") return { inbound: "current", outbound: "current" };
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).every((key) => ["inbound", "outbound"].includes(key)) &&
      ["inbound", "outbound"].every((key) => value[key] === undefined || value[key] === "current" ||
        (Array.isArray(value[key]) && value[key].every((item) =>
          typeof item === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(item))))
    ) {
      return {
        inbound: value.inbound ?? "current",
        outbound: value.outbound ?? "current",
      };
    }
    throw new Error("allowed_peer_tools must be current or inbound/outbound arrays (or current)");
  }
  if (typeof approvedFeatureDefaults[name] === "object") {
    return validateDirectionalBoolean(name, value);
  }
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function effectiveConfiguration() {
  const features = {};
  for (const [name, fallback] of Object.entries(approvedFeatureDefaults)) {
    features[name] = config.features?.[name] === undefined
      ? structuredClone(fallback)
      : validateFeature(name, config.features[name]);
  }
  const roleProfile = config.role_profile ?? "symmetric";
  if (!["symmetric", "controller-worker"].includes(roleProfile)) {
    throw new Error("role_profile must be symmetric or controller-worker");
  }
  const nodeRole = config.node_role ?? null;
  if (roleProfile === "controller-worker" && !["controller", "worker"].includes(nodeRole)) {
    throw new Error("node_role must be controller or worker when role_profile is controller-worker");
  }
  if (roleProfile === "symmetric" && nodeRole !== null && !["controller", "worker"].includes(nodeRole)) {
    throw new Error("node_role must be controller, worker, or omitted");
  }
  return { role_profile: roleProfile, node_role: nodeRole, features };
}

let effective = effectiveConfiguration();

function directionEnabled(name, direction) {
  const explicitlyConfigured = config.features?.[name];
  if (
    effective.role_profile === "controller-worker" &&
    (explicitlyConfigured === undefined ||
      (typeof explicitlyConfigured === "object" && explicitlyConfigured[direction] === undefined))
  ) {
    return effective.node_role === "controller" ? direction === "outbound" : direction === "inbound";
  }
  return effective.features[name][direction];
}

function getConfiguration() {
  const result = structuredClone(effective);
  result.configured_features = structuredClone(config.features || {});
  for (const [name, value] of Object.entries(result.features)) {
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      typeof value.inbound === "boolean" && typeof value.outbound === "boolean"
    ) {
      result.features[name] = {
        inbound: directionEnabled(name, "inbound"),
        outbound: directionEnabled(name, "outbound"),
      };
    }
  }
  if (effective.role_profile === "controller-worker") {
    const explicit = config.features?.allowed_peer_tools;
    for (const direction of ["inbound", "outbound"]) {
      if (
        (explicit === undefined || explicit?.[direction] === undefined) &&
        (effective.node_role === "controller" ? direction === "inbound" : direction === "outbound")
      ) {
        result.features.allowed_peer_tools[direction] = [];
      }
    }
  }
  return result;
}

function updateConfiguration(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("configuration update must be an object");
  }
  const allowedTop = new Set(["role_profile", "node_role", "features"]);
  for (const key of Object.keys(args)) {
    if (!allowedTop.has(key)) throw new Error(`unsupported configuration key: ${key}`);
  }
  const next = JSON.parse(JSON.stringify(config));
  const roleSelectionChanged = (
    (args.role_profile !== undefined && args.role_profile !== (config.role_profile ?? "symmetric")) ||
    (args.node_role !== undefined && args.node_role !== (config.node_role ?? null))
  );
  if (args.role_profile !== undefined) {
    if (!["symmetric", "controller-worker"].includes(args.role_profile)) {
      throw new Error("role_profile must be symmetric or controller-worker");
    }
    next.role_profile = args.role_profile;
  }
  if (args.node_role !== undefined) {
    if (args.node_role !== null && !["controller", "worker"].includes(args.node_role)) {
      throw new Error("node_role must be controller, worker, or null");
    }
    if (args.node_role === null) delete next.node_role;
    else next.node_role = args.node_role;
  }
  if (roleSelectionChanged) {
    next.features = { ...(next.features || {}) };
    for (const [name, fallback] of Object.entries(approvedFeatureDefaults)) {
      if (
        fallback && typeof fallback === "object" && !Array.isArray(fallback) &&
        args.features?.[name] === undefined
      ) {
        delete next.features[name];
      }
    }
  }
  if (args.features !== undefined) {
    if (!args.features || typeof args.features !== "object" || Array.isArray(args.features)) {
      throw new Error("features must be an object");
    }
    next.features = { ...(next.features || {}) };
    for (const [name, value] of Object.entries(args.features)) {
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        typeof approvedFeatureDefaults[name] === "object"
      ) {
        const partial = {
          ...(config.features?.[name] &&
              typeof config.features[name] === "object" &&
              !Array.isArray(config.features[name])
            ? config.features[name]
            : {}),
          ...value,
        };
        validateFeature(name, partial);
        next.features[name] = partial;
      } else {
        next.features[name] = validateFeature(name, value);
      }
    }
  }
  const nextProfile = next.role_profile ?? "symmetric";
  if (nextProfile === "controller-worker" && !["controller", "worker"].includes(next.node_role)) {
    throw new Error("node_role is required when role_profile is controller-worker");
  }
  writeConfiguration(next);
  audit("update", "configuration", config.node_id, "saved", {
    role_profile: effective.role_profile,
    node_role: effective.node_role,
    changed_features: Object.keys(args.features || {}),
  });
  return { ...getConfiguration(), restart_required: true };
}

function writeConfiguration(next) {
  const persisted = JSON.parse(JSON.stringify(next));
  const remove = (name, target, key) => {
    if (Object.hasOwn(machineEnvironment, name) && target) delete target[key];
  };
  remove("HAWKSPAN_NODE_ID", persisted, "node_id");
  remove("HAWKSPAN_PLUGIN_ROOT", persisted, "plugin_root");
  if (Object.hasOwn(machineEnvironment, "HAWKSPAN_APPLICATION_PLUGIN_ROOT")) {
    delete persisted.application_plugins?.roots;
  }
  if (Object.hasOwn(machineEnvironment, "HAWKSPAN_LOCAL_CONTROL_PORT")) {
    delete persisted.local_control?.port;
  }
  for (const [name, key] of [
    ["HAWKSPAN_PEER_NODE_ID", "node_id"], ["HAWKSPAN_PEER_USER", "user"],
    ["HAWKSPAN_PEER_THREAD_ID", "thread_id"], ["HAWKSPAN_REMOTE_NODE", "remote_node"],
    ["HAWKSPAN_REMOTE_PLUGIN_ROOT", "remote_plugin_root"],
    ["HAWKSPAN_REMOTE_CALL_TOOL", "remote_call_tool"],
    ["HAWKSPAN_PRIMARY_ENABLED", "primary_enabled"], ["HAWKSPAN_PRIMARY_LABEL", "primary_label"],
    ["HAWKSPAN_PRIMARY_HOST", "primary_host"], ["HAWKSPAN_FALLBACK_ENABLED", "fallback_enabled"],
    ["HAWKSPAN_FALLBACK_LABEL", "fallback_label"], ["HAWKSPAN_FALLBACK_HOST", "fallback_host"],
    ["HAWKSPAN_SSH_IDENTITY", "ssh_identity"], ["HAWKSPAN_REMOTE_INBOX", "remote_inbox"],
    ["HAWKSPAN_REMOTE_ARTIFACTS", "remote_artifacts"], ["HAWKSPAN_REMOTE_AUDIT", "remote_audit"],
  ]) remove(name, persisted.peer, key);
  const temporary = `${CONFIG_PATH}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, CONFIG_PATH);
  Object.keys(config).forEach((key) => delete config[key]);
  Object.assign(config, applyHawkspanEnv(persisted, machineEnvironment));
  effective = effectiveConfiguration();
}

function approvedConfigurationOverrides(source = config) {
  const settings = {};
  if (Object.hasOwn(source, "role_profile")) settings.role_profile = source.role_profile;
  if (Object.hasOwn(source, "node_role")) settings.node_role = source.node_role;
  if (Object.hasOwn(source, "features")) settings.features = structuredClone(source.features);
  return settings;
}

function validateApprovedConfigurationOverrides(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("profile settings must be an object");
  }
  for (const key of Object.keys(settings)) {
    if (!["role_profile", "node_role", "features"].includes(key)) {
      throw new Error(`profile contains unsupported configuration key: ${key}`);
    }
  }
  if (
    settings.role_profile !== undefined &&
    !["symmetric", "controller-worker"].includes(settings.role_profile)
  ) {
    throw new Error("profile role_profile must be symmetric or controller-worker");
  }
  if (
    settings.node_role !== undefined &&
    !["controller", "worker"].includes(settings.node_role)
  ) {
    throw new Error("profile node_role must be controller or worker");
  }
  if (
    settings.features !== undefined &&
    (!settings.features || typeof settings.features !== "object" ||
      Array.isArray(settings.features))
  ) {
    throw new Error("profile features must be an object");
  }
  for (const [name, value] of Object.entries(settings.features || {})) {
    validateFeature(name, value);
  }
  const profile = settings.role_profile ?? "symmetric";
  if (profile === "controller-worker" && !["controller", "worker"].includes(settings.node_role)) {
    throw new Error("profile node_role is required for controller-worker mode");
  }
  return structuredClone(settings);
}

function normalizeProfileName(value) {
  if (typeof value !== "string") throw new Error("profile name must be a string");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("profile name must contain 1 to 80 printable characters");
  }
  return name;
}

function readConfigurationProfiles() {
  if (!fs.existsSync(CONFIGURATION_PROFILES_PATH)) {
    return { schema_version: 1, profiles: [] };
  }
  const document = JSON.parse(fs.readFileSync(CONFIGURATION_PROFILES_PATH, "utf8"));
  if (
    document?.schema_version !== 1 ||
    !Array.isArray(document.profiles)
  ) {
    throw new Error("configuration profile store is invalid");
  }
  for (const profile of document.profiles) {
    if (
      !profile || typeof profile !== "object" ||
      typeof profile.id !== "string" || !/^profile-[a-f0-9]{24}$/.test(profile.id) ||
      normalizeProfileName(profile.name) !== profile.name ||
      typeof profile.created_at !== "string" || typeof profile.updated_at !== "string"
    ) {
      throw new Error("configuration profile store contains an invalid profile");
    }
    validateApprovedConfigurationOverrides(profile.settings);
  }
  return document;
}

function writeConfigurationProfiles(document) {
  const temporary = `${CONFIGURATION_PROFILES_PATH}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, CONFIGURATION_PROFILES_PATH);
}

function publicConfigurationProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    source: profile.source || "user",
    description: profile.description || "",
    impact: profile.impact || "Applies the role and feature choices saved in this profile.",
    read_only: profile.source === "builtin",
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    settings: structuredClone(profile.settings),
  };
}

const coordinationFeatures = Object.freeze({
  allowed_peer_tools: { inbound: "current", outbound: "current" },
  allow_peer_messages: { inbound: true, outbound: true },
  allow_peer_acknowledgements: { inbound: true, outbound: true },
  allow_peer_jobs: { inbound: true, outbound: true },
  allow_peer_wakeup: { inbound: true, outbound: true },
  allow_peer_artifact_send: { inbound: true, outbound: true },
  allow_peer_artifact_receive: { inbound: true, outbound: true },
  strict_host_key_checking: true,
});
const builtinConfigurationProfiles = Object.freeze([
  {
    id: "builtin-current-symmetric",
    name: "Current symmetric",
    source: "builtin",
    description: "Both Macs retain the inherited symmetric defaults with no feature overrides.",
    impact: "Removes role-specific restrictions and returns all approved features to their inherited defaults.",
    created_at: null,
    updated_at: null,
    settings: { role_profile: "symmetric" },
  },
  {
    id: "builtin-high-value-controller",
    name: "High-value controller",
    source: "builtin",
    description: "This Mac initiates commands but rejects inbound commands; coordination and artifacts remain bidirectional.",
    impact: "Protects the higher-value Mac from peer-initiated commands while allowing it to direct the worker.",
    created_at: null,
    updated_at: null,
    settings: {
      role_profile: "controller-worker",
      node_role: "controller",
      features: {
        ...coordinationFeatures,
        allow_peer_commands: { inbound: false, outbound: true },
        enable_broad_run_command: { inbound: false, outbound: true },
      },
    },
  },
  {
    id: "builtin-compute-worker",
    name: "Compute worker",
    source: "builtin",
    description: "This Mac accepts controller commands but cannot send commands; coordination and artifacts remain bidirectional.",
    impact: "Lets the compute Mac perform requested work without allowing it to initiate commands on the controller.",
    created_at: null,
    updated_at: null,
    settings: {
      role_profile: "controller-worker",
      node_role: "worker",
      features: {
        ...coordinationFeatures,
        allow_peer_commands: { inbound: true, outbound: false },
        enable_broad_run_command: { inbound: true, outbound: false },
      },
    },
  },
  {
    id: "builtin-coordination-only",
    name: "Coordination only",
    source: "builtin",
    description: "Commands are blocked in both directions while messages, jobs, wakeups, and artifacts remain bidirectional.",
    impact: "Keeps coordination and file exchange available while preventing either Mac from running peer commands.",
    created_at: null,
    updated_at: null,
    settings: {
      role_profile: "symmetric",
      features: {
        ...coordinationFeatures,
        allow_peer_commands: { inbound: false, outbound: false },
        enable_broad_run_command: { inbound: false, outbound: false },
      },
    },
  },
]);

function listConfigurationProfiles() {
  return {
    profiles: [
      ...builtinConfigurationProfiles.map(publicConfigurationProfile),
      ...readConfigurationProfiles().profiles.map(publicConfigurationProfile),
    ],
  };
}

function saveConfigurationProfile(args) {
  const name = normalizeProfileName(args?.name);
  const document = readConfigurationProfiles();
  if (builtinConfigurationProfiles.some(
    (profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  )) {
    throw new Error("built-in profile names are reserved and cannot be replaced");
  }
  const existing = document.profiles.find(
    (profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  if (existing && args.confirm_replace !== true) {
    throw new Error("a profile with this name exists; set confirm_replace to true to replace it");
  }
  const timestamp = now();
  const settings = validateApprovedConfigurationOverrides(approvedConfigurationOverrides());
  const profile = existing || {
    id: `profile-${crypto.randomBytes(12).toString("hex")}`,
    created_at: timestamp,
  };
  profile.name = name;
  profile.updated_at = timestamp;
  profile.settings = settings;
  if (!existing) document.profiles.push(profile);
  writeConfigurationProfiles(document);
  audit(existing ? "replace" : "save", "configuration_profile", profile.id, "saved", {
    name,
  });
  return { profile: publicConfigurationProfile(profile), replaced: Boolean(existing) };
}

function findConfigurationProfile(document, profileId) {
  if (typeof profileId !== "string") {
    throw new Error("profile_id is invalid");
  }
  const builtin = builtinConfigurationProfiles.find((profile) => profile.id === profileId);
  if (builtin) return builtin;
  if (!/^profile-[a-f0-9]{24}$/.test(profileId)) throw new Error("profile_id is invalid");
  const profile = document.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`configuration profile not found: ${profileId}`);
  return profile;
}

function applyConfigurationProfile(args) {
  if (args?.confirm !== true) {
    throw new Error("applying a configuration profile requires confirm: true");
  }
  const document = readConfigurationProfiles();
  const profile = findConfigurationProfile(document, args.profile_id);
  const settings = validateApprovedConfigurationOverrides(profile.settings);
  const next = JSON.parse(JSON.stringify(config));
  delete next.role_profile;
  delete next.node_role;
  delete next.features;
  Object.assign(next, settings);
  writeConfiguration(next);
  audit("apply", "configuration_profile", profile.id, "saved", { name: profile.name });
  return {
    profile: publicConfigurationProfile(profile),
    configuration: getConfiguration(),
    restart_required: true,
  };
}

function deleteConfigurationProfile(args) {
  if (args?.confirm !== true) {
    throw new Error("deleting a configuration profile requires confirm: true");
  }
  const document = readConfigurationProfiles();
  const profile = findConfigurationProfile(document, args.profile_id);
  if (profile.source === "builtin") {
    throw new Error("built-in configuration profiles cannot be deleted");
  }
  document.profiles = document.profiles.filter((candidate) => candidate.id !== profile.id);
  writeConfigurationProfiles(document);
  audit("delete", "configuration_profile", profile.id, "deleted", { name: profile.name });
  return { deleted: true, profile: publicConfigurationProfile(profile) };
}

function resetConfiguration(args) {
  if (args?.confirm !== true) {
    throw new Error("resetting configuration requires confirm: true");
  }
  const next = JSON.parse(JSON.stringify(config));
  delete next.role_profile;
  delete next.node_role;
  delete next.features;
  writeConfiguration(next);
  audit("reset", "configuration", config.node_id, "saved", {
    removed_keys: ["role_profile", "node_role", "features"],
  });
  return { ...getConfiguration(), reset: true, restart_required: true };
}

let applicationPresets = [];
const APPLICATION_PRESET_CORE_COORDINATION_TOOLS = new Set([
  "acknowledge_message",
  "create_job",
  "link_status",
  "receive_messages",
  "register_artifact",
  "send_artifact",
  "update_job_status",
  "list_jobs",
  "receive_artifacts",
]);

function findApplicationPreset(presetId) {
  if (typeof presetId !== "string" ||
      !/^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/.test(presetId)) {
    throw new Error("application preset_id is invalid");
  }
  const preset = applicationPresets.find((candidate) => candidate.id === presetId);
  if (!preset) throw new Error(`application preset not found: ${presetId}`);
  return preset;
}

function approvedApplicationPresetSettings(preset) {
  const settings = preset.settings || {};
  const configuration = {};
  for (const key of ["role_profile", "node_role", "features"]) {
    if (Object.hasOwn(settings, key)) configuration[key] = structuredClone(settings[key]);
  }
  const approved = validateApprovedConfigurationOverrides(configuration);
  const prefix = `app_${preset.plugin_id.replaceAll("-", "_")}_`;
  const toolRestriction = approved.features?.allowed_peer_tools;
  if (toolRestriction !== undefined) {
    const normalized = validateFeature("allowed_peer_tools", toolRestriction);
    for (const direction of ["inbound", "outbound"]) {
      if (!Array.isArray(normalized[direction]) || normalized[direction].some((name) =>
        !name.startsWith(prefix) && !APPLICATION_PRESET_CORE_COORDINATION_TOOLS.has(name))) {
        throw new Error("application preset peer tools must be same-plugin tools or the fixed safe core coordination subset");
      }
    }
  }
  const broad = approved.features?.enable_broad_run_command;
  if (broad === true || broad?.inbound === true || broad?.outbound === true) {
    throw new Error("application presets cannot enable broad commands");
  }
  if (!Array.isArray(settings.enabled_operations)) {
    throw new Error("application preset must declare enabled_operations");
  }
  return { configuration: approved, enabled_operations: [...settings.enabled_operations] };
}

function publicApplicationPreset(preset) {
  const approved = approvedApplicationPresetSettings(preset);
  return {
    id: preset.id,
    plugin_id: preset.plugin_id,
    plugin_name: preset.plugin_name,
    plugin_version: preset.plugin_version,
    name: preset.name,
    description: preset.description,
    impact: preset.impact,
    settings: {
      ...approved.configuration,
      enabled_operations: approved.enabled_operations,
    },
    read_only: true,
  };
}

function listApplicationPresets() {
  return { presets: applicationPresets.map(publicApplicationPreset) };
}

function previewApplicationPreset(args) {
  const preset = findApplicationPreset(args?.preset_id);
  const publicPreset = publicApplicationPreset(preset);
  return {
    preset: publicPreset,
    changes: {
      role_and_capabilities: structuredClone(publicPreset.settings),
      plugin_id: preset.plugin_id,
      enabled_operations: [...publicPreset.settings.enabled_operations],
    },
    preserved: [
      "connections", "credentials", "paths", "tokens", "local_control",
      "plugin_configuration", "other_plugin_entries", "application_data",
    ],
    confirmation_required: true,
  };
}

function applyApplicationPreset(args) {
  if (args?.confirm !== true) {
    throw new Error("applying an application preset requires confirm: true");
  }
  const preset = findApplicationPreset(args.preset_id);
  const approved = approvedApplicationPresetSettings(preset);
  const next = JSON.parse(JSON.stringify(config));
  delete next.role_profile;
  delete next.node_role;
  delete next.features;
  Object.assign(next, approved.configuration);
  next.application_plugins = { ...(next.application_plugins || {}) };
  next.application_plugins.entries = { ...(next.application_plugins.entries || {}) };
  const priorEntry = next.application_plugins.entries[preset.plugin_id];
  if (priorEntry !== undefined && (!priorEntry || typeof priorEntry !== "object" || Array.isArray(priorEntry))) {
    throw new Error("application plugin entry configuration must be an object");
  }
  next.application_plugins.entries[preset.plugin_id] = {
    ...(priorEntry || {}),
    enabled_operations: approved.enabled_operations,
  };
  writeConfiguration(next);
  audit("apply", "application_preset", preset.id, "saved", {
    plugin_id: preset.plugin_id,
    enabled_operations: approved.enabled_operations,
  });
  return {
    preset: publicApplicationPreset(preset),
    configuration: getConfiguration(),
    restart_required: true,
  };
}

function resetApplicationPreset(args) {
  if (args?.confirm !== true) {
    throw new Error("resetting an application preset requires confirm: true");
  }
  const preset = findApplicationPreset(args.preset_id);
  const next = JSON.parse(JSON.stringify(config));
  delete next.role_profile;
  delete next.node_role;
  delete next.features;
  const entry = next.application_plugins?.entries?.[preset.plugin_id];
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    delete entry.enabled_operations;
  }
  writeConfiguration(next);
  audit("reset", "application_preset", preset.id, "saved", {
    plugin_id: preset.plugin_id,
    removed_keys: ["role_profile", "node_role", "features", "enabled_operations"],
  });
  return {
    preset: publicApplicationPreset(preset),
    configuration: getConfiguration(),
    reset: true,
    restart_required: true,
  };
}

function normalizeConnectionLabel(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("connection label must be a string");
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 40 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error("connection label must contain 1 to 40 printable characters");
  }
  return label;
}

function normalizeConnectionHost(value) {
  if (typeof value !== "string") throw new Error("connection host must be a string");
  const host = value.trim();
  if (!host || host.length > 253 || /\s|[\u0000-\u001f\u007f]/u.test(host)) {
    throw new Error("enabled connection host must be a nonempty hostname or address");
  }
  return host;
}

function connectionConfiguration(source = config) {
  const peer = source.peer || {};
  return {
    primary: {
      enabled: peer.primary_enabled ?? Boolean(peer.primary_host),
      label: normalizeConnectionLabel(
        peer.primary_label,
        source.local_control?.route_labels?.primary || "Thunderbolt",
      ),
      host: typeof peer.primary_host === "string" ? peer.primary_host : "",
    },
    fallback: {
      enabled: peer.fallback_enabled ?? Boolean(peer.fallback_host),
      label: normalizeConnectionLabel(
        peer.fallback_label,
        source.local_control?.route_labels?.fallback || "Ethernet",
      ),
      host: typeof peer.fallback_host === "string" ? peer.fallback_host : "",
    },
  };
}

function validateConnectionConfiguration(settings) {
  for (const role of ["primary", "fallback"]) {
    const route = settings[role];
    if (typeof route.enabled !== "boolean") {
      throw new Error(`${role} connection enabled must be a boolean`);
    }
    route.label = normalizeConnectionLabel(
      route.label,
      role === "primary" ? "Thunderbolt" : "Ethernet",
    );
    if (route.enabled) route.host = normalizeConnectionHost(route.host);
    else if (route.host !== "" && typeof route.host !== "string") {
      throw new Error(`${role} connection host must be a string`);
    } else if (typeof route.host === "string") {
      route.host = route.host.trim();
    }
  }
  if (!settings.primary.enabled && !settings.fallback.enabled) {
    throw new Error("at least one connection must be enabled");
  }
  return settings;
}

function getConnectionConfiguration() {
  const connections = validateConnectionConfiguration(connectionConfiguration());
  return {
    routes: structuredClone(connections),
    automatic_fallback: connections.primary.enabled && connections.fallback.enabled,
  };
}

function updateConnectionConfiguration(args) {
  if (args?.confirm !== true) {
    throw new Error("updating connection configuration requires confirm: true");
  }
  for (const key of Object.keys(args || {})) {
    if (!["routes", "confirm"].includes(key)) {
      throw new Error(`unsupported connection configuration key: ${key}`);
    }
  }
  if (!args.routes || typeof args.routes !== "object" || Array.isArray(args.routes)) {
    throw new Error("connection routes update must be an object");
  }
  for (const key of Object.keys(args.routes)) {
    if (!["primary", "fallback"].includes(key)) {
      throw new Error(`unsupported connection route: ${key}`);
    }
  }
  const nextConnections = connectionConfiguration();
  for (const role of ["primary", "fallback"]) {
    if (args.routes[role] === undefined) continue;
    if (!args.routes[role] || typeof args.routes[role] !== "object" || Array.isArray(args.routes[role])) {
      throw new Error(`${role} connection update must be an object`);
    }
    for (const key of Object.keys(args.routes[role])) {
      if (!["enabled", "label", "host"].includes(key)) {
        throw new Error(`unsupported ${role} connection key: ${key}`);
      }
    }
    Object.assign(nextConnections[role], args.routes[role]);
  }
  validateConnectionConfiguration(nextConnections);
  const nextEnvironment = {
    ...machineEnvironment,
    HAWKSPAN_PRIMARY_ENABLED: String(nextConnections.primary.enabled),
    HAWKSPAN_PRIMARY_LABEL: nextConnections.primary.label,
    ...(nextConnections.primary.host ? { HAWKSPAN_PRIMARY_HOST: nextConnections.primary.host } : {}),
    HAWKSPAN_FALLBACK_ENABLED: String(nextConnections.fallback.enabled),
    HAWKSPAN_FALLBACK_LABEL: nextConnections.fallback.label,
    ...(nextConnections.fallback.host ? { HAWKSPAN_FALLBACK_HOST: nextConnections.fallback.host } : {}),
  };
  if (!nextConnections.primary.host) delete nextEnvironment.HAWKSPAN_PRIMARY_HOST;
  if (!nextConnections.fallback.host) delete nextEnvironment.HAWKSPAN_FALLBACK_HOST;
  writeHawkspanEnv(ENV_PATH, nextEnvironment);
  machineEnvironment = Object.freeze(nextEnvironment);
  const next = JSON.parse(JSON.stringify(config));
  next.peer = { ...(next.peer || {}) };
  for (const role of ["primary", "fallback"]) {
    next.peer[`${role}_enabled`] = nextConnections[role].enabled;
    next.peer[`${role}_label`] = nextConnections[role].label;
    next.peer[`${role}_host`] = nextConnections[role].host;
  }
  writeConfiguration(next);
  audit("update", "connection_configuration", config.node_id, "saved", {
    primary_enabled: nextConnections.primary.enabled,
    fallback_enabled: nextConnections.fallback.enabled,
  });
  return { ...getConnectionConfiguration(), restart_required: true };
}
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 10000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    correlation_id TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    state TEXT NOT NULL,
    envelope_path TEXT NOT NULL,
    delivered_via TEXT,
    acknowledged_at TEXT,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    creator TEXT NOT NULL,
    assignee TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    state TEXT NOT NULL,
    authorization_state TEXT NOT NULL,
    authorization_evidence TEXT,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    owner TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    state TEXT NOT NULL,
    delivered_via TEXT,
    metadata_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    node_id TEXT NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT,
    result TEXT NOT NULL,
    details_json TEXT NOT NULL
  );
`);

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function audit(action, objectType, objectId, result, details = {}) {
  db.prepare(`
    INSERT INTO audit_events
      (timestamp,node_id,action,object_type,object_id,result,details_json)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    now(),
    redactResolvedMachineValues(config.node_id),
    action,
    objectType,
    redactResolvedMachineValues(objectId || null),
    result,
    json(redactResolvedMachineValues(details)),
  );
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function writeEnvelope(envelope) {
  const filePath = path.join(OUTBOX, `${envelope.id}.json`);
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
  return filePath;
}

function ingestInbox() {
  let imported = 0;
  for (const name of fs.readdirSync(INBOX)) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(INBOX, name);
    let envelope;
    try {
      envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!envelope.id || !envelope.sender || !envelope.recipient) {
        throw new Error("missing required envelope fields");
      }
      const acknowledgement = envelope.kind === "acknowledgement";
      const inboundFeature = acknowledgement
        ? "allow_peer_acknowledgements"
        : "allow_peer_messages";
      if (!directionEnabled(inboundFeature, "inbound")) {
        audit("ingest", "message", envelope.id, "rejected", {
          reason: `${inboundFeature} is disabled for inbound envelopes`,
          envelope_path: filePath,
        });
        continue;
      }
      const exists = db.prepare("SELECT 1 FROM messages WHERE id=?").get(envelope.id);
      if (exists) continue;
      db.prepare(`
        INSERT INTO messages
          (id,created_at,sender,recipient,kind,subject,body,correlation_id,
           direction,state,envelope_path,delivered_via,metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        envelope.id,
        envelope.created_at || now(),
        envelope.sender,
        envelope.recipient,
        envelope.kind || "message",
        envelope.subject || "",
        envelope.body || "",
        envelope.correlation_id || null,
        "inbound",
        envelope.kind === "acknowledgement" ? "acknowledged" : "received",
        filePath,
        envelope.delivered_via || null,
        json(envelope.metadata),
      );
      if (envelope.kind === "acknowledgement" && envelope.correlation_id) {
        db.prepare(`
          UPDATE messages
          SET state='acknowledged', acknowledged_at=?
          WHERE id=? AND direction='outbound'
        `).run(envelope.created_at || now(), envelope.correlation_id);
      }
      audit("ingest", "message", envelope.id, "received", { file_path: filePath });
      imported += 1;
    } catch (error) {
      audit("ingest", "message", name, "rejected", { error: String(error) });
    }
  }
  return imported;
}

function configuredRoutes() {
  if (!config.peer) return [];
  const connections = connectionConfiguration();
  return ["primary", "fallback"].map((role) => ({
    role,
    ...connections[role],
  }));
}

function peerCandidates() {
  return configuredRoutes()
    .filter((route) => route.enabled && route.host)
    .map((route) => route.host);
}

function strictSshOptions() {
  return [
    "-o", "BatchMode=yes",
    "-o", `StrictHostKeyChecking=${effective.features.strict_host_key_checking ? "yes" : "accept-new"}`,
    "-o", `UserKnownHostsFile=${path.join(STATE_ROOT, "ssh", "known_hosts")}`,
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
  ];
}

function sshArgs(host, remoteCommand) {
  const args = [];
  if (config.peer.ssh_identity) args.push("-i", config.peer.ssh_identity);
  args.push(
    ...strictSshOptions(),
    `${config.peer.user}@${host}`,
    remoteCommand,
  );
  return args;
}

function ensureRemoteDirectory(host, remoteDir) {
  const result = spawnSync("ssh", sshArgs(host, `mkdir -p ${shellQuote(remoteDir)}`), {
    encoding: "utf8",
    timeout: 15000,
    env: minimalChildEnvironment(),
  });
  return { ok: result.status === 0, stderr: result.stderr?.trim() || "" };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

let rsyncAppendVerify;

function supportsAppendVerify() {
  if (rsyncAppendVerify !== undefined) return rsyncAppendVerify;
  const result = spawnSync("rsync", ["--help"], {
    encoding: "utf8",
    timeout: 5000,
    env: minimalChildEnvironment(),
  });
  rsyncAppendVerify = result.status === 0 &&
    `${result.stdout || ""}\n${result.stderr || ""}`.includes("--append-verify");
  return rsyncAppendVerify;
}

function rsyncFile(localPath, remoteDir, remoteName = null) {
  if (!config.peer) {
    return { ok: false, error: "peer is not configured", attempts: [] };
  }
  const attempts = [];
  for (const host of peerCandidates()) {
    const prepared = ensureRemoteDirectory(host, remoteDir);
    if (!prepared.ok) {
      attempts.push({ host, stage: "mkdir", error: prepared.stderr });
      continue;
    }
    const sshCommand = [
      "ssh",
      ...(config.peer.ssh_identity ? ["-i", config.peer.ssh_identity] : []),
      ...strictSshOptions(),
    ].join(" ");
    const resumeArgs = supportsAppendVerify()
      ? ["--partial", "--append-verify"]
      : ["--partial"];
    const remoteTarget = remoteName
      ? `${remoteDir.replaceAll(" ", "\\ ")}/${remoteName.replaceAll(" ", "\\ ")}`
      : `${remoteDir.replaceAll(" ", "\\ ")}/`;
    const result = spawnSync("rsync", [
      "-a",
      ...resumeArgs,
      "-e", sshCommand,
      localPath,
      `${config.peer.user}@${host}:${remoteTarget}`,
    ], {
      encoding: "utf8",
      timeout: 24 * 60 * 60 * 1000,
      env: minimalChildEnvironment(),
    });
    attempts.push({
      host,
      stage: "rsync",
      resume_mode: supportsAppendVerify() ? "append-verify" : "partial",
      status: result.status,
      error: result.stderr?.trim() || "",
    });
    if (result.status === 0) return { ok: true, host, attempts };
  }
  return { ok: false, error: "all routes failed", attempts };
}

function retryMessage(args) {
  if (!directionEnabled("allow_peer_messages", "outbound")) {
    throw new Error("outbound peer messages are disabled");
  }
  const row = db.prepare(`
    SELECT * FROM messages WHERE id=? AND direction='outbound'
  `).get(args.message_id);
  if (!row) throw new Error(`outbound message not found: ${args.message_id}`);
  if (!fs.existsSync(row.envelope_path)) {
    throw new Error(`immutable envelope is missing: ${row.envelope_path}`);
  }
  if (!config.peer?.remote_inbox) throw new Error("peer.remote_inbox is not configured");
  const delivery = rsyncFile(row.envelope_path, config.peer.remote_inbox);
  if (delivery.ok) {
    db.prepare("UPDATE messages SET state='delivered', delivered_via=? WHERE id=?")
      .run(delivery.host, row.id);
  }
  let wake = null;
  if (delivery.ok && row.kind !== "acknowledgement" && args.wake !== false) {
    wake = wakePeerThread({
      message_id: row.id,
      subject: row.subject,
      body: row.body,
    });
  }
  audit("retry", "message", row.id, delivery.ok ? "delivered" : "queued", {
    delivery,
    wake,
  });
  return { message_id: row.id, envelope_path: row.envelope_path, delivery, wake };
}

function sendMessage(args) {
  const acknowledgement = args.kind === "acknowledgement";
  if (!directionEnabled(
    acknowledgement ? "allow_peer_acknowledgements" : "allow_peer_messages",
    "outbound",
  )) {
    throw new Error(`outbound peer ${acknowledgement ? "acknowledgements" : "messages"} are disabled`);
  }
  const messageId = id("msg");
  const envelope = {
    schema_version: 1,
    id: messageId,
    created_at: now(),
    sender: config.node_id,
    recipient: args.recipient || config.peer?.node_id || "peer",
    kind: args.kind || "message",
    subject: args.subject,
    body: args.body,
    correlation_id: args.correlation_id || null,
    metadata: args.metadata || {},
  };
  const envelopePath = writeEnvelope(envelope);
  db.prepare(`
    INSERT INTO messages
      (id,created_at,sender,recipient,kind,subject,body,correlation_id,
       direction,state,envelope_path,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    messageId,
    envelope.created_at,
    envelope.sender,
    envelope.recipient,
    envelope.kind,
    envelope.subject,
    envelope.body,
    envelope.correlation_id,
    "outbound",
    "queued",
    envelopePath,
    json(envelope.metadata),
  );
  let delivery = null;
  if (args.deliver !== false && config.peer?.remote_inbox) {
    delivery = rsyncFile(envelopePath, config.peer.remote_inbox);
    if (delivery.ok) {
      db.prepare("UPDATE messages SET state='delivered', delivered_via=? WHERE id=?")
        .run(delivery.host, messageId);
    }
  }
  let wake = null;
  if (delivery?.ok && envelope.kind !== "acknowledgement" && args.wake !== false) {
    wake = wakePeerThread({
      message_id: messageId,
      subject: envelope.subject,
      body: envelope.body,
    });
  }
  audit("send", "message", messageId, delivery?.ok ? "delivered" : "queued", {
    delivery,
    wake,
  });
  return { message_id: messageId, envelope_path: envelopePath, delivery, wake };
}

function wakePeerThread(args) {
  if (!directionEnabled("allow_peer_wakeup", "outbound")) {
    return { ok: false, skipped: true, error: "outbound peer wakeups are disabled", attempts: [] };
  }
  if (!config.peer?.allow_remote_wake) {
    return {
      ok: false,
      skipped: true,
      error: "peer.allow_remote_wake is disabled; the durable inbox remains authoritative",
      attempts: [],
    };
  }
  if (!config.peer?.thread_id) {
    return { ok: false, error: "peer.thread_id is not configured", attempts: [] };
  }
  const codexCommand = config.peer.codex_command || "codex";
  const remoteNode = config.peer.remote_node || "node";
  const remoteCallTool = config.peer.remote_call_tool || "call-tool.mjs";
  const auditDir = config.peer.remote_audit || `${config.peer.remote_inbox}/../audit`;
  const wakeId = id("wake");
  const logPath = path.posix.join(auditDir, `${wakeId}.log`);
  const leasePath = path.posix.join(
    auditDir,
    `wake-${String(config.peer.thread_id).replace(/[^A-Za-z0-9._-]/g, "_")}.lock`,
  );
  const prompt = effective.features.wake_prompt_mode === "notification"
    ? [
      `HawkSpan delivered message ${args.message_id || "unknown"}.`,
      "Import and acknowledge the durable envelope when MCP tools are available.",
    ].join(" ")
    : [
    `HawkSpan delivered message ${args.message_id || "unknown"}.`,
    args.subject ? `Subject: ${args.subject}.` : "",
    args.body ? `Message body: ${args.body}` : "",
    "Import and acknowledge the durable envelope when MCP tools are available.",
    "If exec mode cannot load dynamic MCP tools, this embedded message body is authoritative.",
    `Direct receive fallback: ${remoteNode} ${remoteCallTool} receive_messages '{"limit":20}'`,
    `Direct acknowledge fallback: ${remoteNode} ${remoteCallTool} acknowledge_message ` +
      `'{"message_id":"${args.message_id || "unknown"}","deliver":true}'`,
    "Continue the existing task without repeating completed work.",
    ].filter(Boolean).join(" ");
  const resumedCommand = [
    "trap",
    shellQuote(`rm -rf ${shellQuote(leasePath)}`),
    "EXIT HUP INT TERM",
    ";",
    shellQuote(codexCommand),
    "exec",
    "resume",
    "--skip-git-repo-check",
    shellQuote(config.peer.thread_id),
    shellQuote(prompt),
  ].join(" ");
  const command = [
    `mkdir -p ${shellQuote(auditDir)}`,
    "&&",
    "(",
    `mkdir ${shellQuote(leasePath)} 2>/dev/null`,
    "||",
    "exit 0",
    ")",
    "&&",
    "nohup",
    "/bin/sh",
    "-c",
    shellQuote(resumedCommand),
    ">",
    shellQuote(logPath),
    "2>&1",
    "<",
    "/dev/null",
    "&",
  ].join(" ");
  const attempts = [];
  for (const host of peerCandidates()) {
    const result = spawnSync("ssh", sshArgs(host, command), {
      encoding: "utf8",
      timeout: 15000,
      env: minimalChildEnvironment(),
    });
    attempts.push({
      host,
      status: result.status,
      error: result.stderr?.trim() || "",
    });
    if (result.status === 0) {
      audit("wake", "thread", config.peer.thread_id, "started", {
        host,
        wake_id: wakeId,
        log_path: logPath,
        message_id: args.message_id || null,
      });
      return { ok: true, host, wake_id: wakeId, log_path: logPath, attempts };
    }
  }
  audit("wake", "thread", config.peer.thread_id, "failed", { attempts });
  return { ok: false, error: "all routes failed", wake_id: wakeId, attempts };
}

function receiveMessages(args) {
  const imported = ingestInbox();
  const limit = Math.min(Math.max(Number(args.limit || 50), 1), 500);
  const states = args.include_acknowledged
    ? ["received", "acknowledged"]
    : ["received"];
  const placeholders = states.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id,created_at,sender,recipient,kind,subject,body,correlation_id,state,
           metadata_json
    FROM messages
    WHERE direction='inbound' AND state IN (${placeholders})
    ORDER BY created_at ASC
    LIMIT ?
  `).all(...states, limit);
  return {
    imported,
    messages: rows.map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata_json),
      metadata_json: undefined,
    })),
  };
}

function listMessages(args) {
  ingestInbox();
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 1000);
  const clauses = [];
  const values = [];
  if (args.direction) {
    clauses.push("direction=?");
    values.push(args.direction);
  }
  if (args.state) {
    clauses.push("state=?");
    values.push(args.state);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT id,created_at,sender,recipient,kind,subject,body,correlation_id,
           direction,state,envelope_path,delivered_via,acknowledged_at,metadata_json
    FROM messages ${where}
    ORDER BY created_at DESC LIMIT ?
  `).all(...values, limit);
  return rows.map((row) => ({
    ...row,
    metadata: JSON.parse(row.metadata_json),
    metadata_json: undefined,
  }));
}

function acknowledgeMessage(args) {
  const row = db.prepare(`
    SELECT * FROM messages WHERE id=? AND direction='inbound'
  `).get(args.message_id);
  if (!row) throw new Error(`inbound message not found: ${args.message_id}`);
  const acknowledgedAt = now();
  db.prepare(`
    UPDATE messages SET state='acknowledged', acknowledged_at=? WHERE id=?
  `).run(acknowledgedAt, args.message_id);
  const shouldReply = args.reply === undefined
    ? row.kind !== "acknowledgement"
    : args.reply;
  if (!shouldReply) {
    audit("acknowledge", "message", row.id, "acknowledged_local", {
      reply: false,
      inbound_kind: row.kind,
    });
    return {
      acknowledged_message_id: row.id,
      acknowledged_at: acknowledgedAt,
      reply_sent: false,
    };
  }
  const acknowledgement = sendMessage({
    recipient: row.sender,
    kind: "acknowledgement",
    subject: `Acknowledged: ${row.subject}`,
    body: args.note || "Received and acknowledged.",
    correlation_id: row.id,
    metadata: { acknowledged_message_id: row.id, acknowledged_at: acknowledgedAt },
    deliver: args.deliver,
  });
  audit("acknowledge", "message", row.id, "acknowledged", {
    acknowledgement_id: acknowledgement.message_id,
  });
  return { acknowledged_message_id: row.id, ...acknowledgement };
}

const jobTransitions = {
  proposed: new Set(["awaiting_authorization", "authorized", "queued", "cancelled"]),
  awaiting_authorization: new Set(["authorized", "cancelled"]),
  authorized: new Set(["queued", "cancelled"]),
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["paused", "completed", "failed", "cancel_requested"]),
  paused: new Set(["queued", "cancelled"]),
  cancel_requested: new Set(["cancelled", "failed"]),
  completed: new Set(["verified"]),
  failed: new Set(["queued", "cancelled"]),
  verified: new Set(),
  cancelled: new Set(),
};

function createJob(args) {
  const jobId = id("job");
  const createdAt = now();
  const authorizationState = args.requires_authorization === true
    ? "required"
    : "not_required";
  db.prepare(`
    INSERT INTO jobs
      (id,created_at,updated_at,creator,assignee,kind,title,description,state,
       authorization_state,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    jobId,
    createdAt,
    createdAt,
    config.node_id,
    args.assignee || config.peer?.node_id || config.node_id,
    args.kind,
    args.title,
    args.description || "",
    authorizationState === "required" ? "awaiting_authorization" : "proposed",
    authorizationState,
    json(args.metadata),
  );
  audit("create", "job", jobId, "created", { authorization_state: authorizationState });
  return { job_id: jobId, state: authorizationState === "required" ? "awaiting_authorization" : "proposed" };
}

function updateJobStatus(args) {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(args.job_id);
  if (!row) throw new Error(`job not found: ${args.job_id}`);
  if (args.state === "authorized") {
    if (!args.authorization_evidence?.trim()) {
      throw new Error("authorization_evidence is required to authorize a job");
    }
  } else if (!jobTransitions[row.state]?.has(args.state)) {
    throw new Error(`invalid job transition: ${row.state} -> ${args.state}`);
  }
  let authorizationState = row.authorization_state;
  let authorizationEvidence = row.authorization_evidence;
  if (args.state === "authorized") {
    authorizationState = "recorded";
    authorizationEvidence = args.authorization_evidence;
  }
  if (["queued", "running"].includes(args.state) && authorizationState === "required") {
    throw new Error("job requires recorded authorization before it can be queued or run");
  }
  db.prepare(`
    UPDATE jobs
    SET state=?,updated_at=?,authorization_state=?,authorization_evidence=?,
        metadata_json=?
    WHERE id=?
  `).run(
    args.state,
    now(),
    authorizationState,
    authorizationEvidence,
    json({ ...JSON.parse(row.metadata_json), ...(args.metadata || {}) }),
    args.job_id,
  );
  audit("transition", "job", args.job_id, args.state, {
    previous_state: row.state,
    authorization_state: authorizationState,
  });
  return { job_id: args.job_id, previous_state: row.state, state: args.state, authorization_state: authorizationState };
}

function listJobs(args) {
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 500);
  const rows = args.state
    ? db.prepare("SELECT * FROM jobs WHERE state=? ORDER BY updated_at DESC LIMIT ?")
        .all(args.state, limit)
    : db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?").all(limit);
  return rows.map((row) => ({
    ...row,
    metadata: JSON.parse(row.metadata_json),
    metadata_json: undefined,
  }));
}

function registerArtifact(args) {
  const filePath = path.resolve(args.path);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("artifact path must be a regular file");
  const artifactId = id("artifact");
  const digest = sha256(filePath);
  db.prepare(`
    INSERT INTO artifacts
      (id,created_at,owner,path,name,size_bytes,sha256,state,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    artifactId,
    now(),
    config.node_id,
    filePath,
    args.name || path.basename(filePath),
    stat.size,
    digest,
    "registered",
    json(args.metadata),
  );
  audit("register", "artifact", artifactId, "registered", {
    path: filePath,
    size_bytes: stat.size,
    sha256: digest,
  });
  return { artifact_id: artifactId, path: filePath, size_bytes: stat.size, sha256: digest };
}

function verifyArtifact(args) {
  const row = args.artifact_id
    ? db.prepare("SELECT * FROM artifacts WHERE id=?").get(args.artifact_id)
    : null;
  const filePath = path.resolve(args.path || row?.path || "");
  if (!filePath) throw new Error("path or artifact_id is required");
  const digest = sha256(filePath);
  const expected = args.expected_sha256 || row?.sha256 || null;
  const matches = expected ? digest === expected : null;
  if (row && matches === true) {
    db.prepare("UPDATE artifacts SET state='verified' WHERE id=?").run(row.id);
  }
  audit("verify", "artifact", row?.id || filePath, matches === false ? "mismatch" : "verified", {
    sha256: digest,
    expected_sha256: expected,
  });
  return { path: filePath, sha256: digest, expected_sha256: expected, matches };
}

function sendArtifact(args) {
  if (!directionEnabled("allow_peer_artifact_send", "outbound")) {
    throw new Error("outbound artifact sending is disabled");
  }
  const row = db.prepare("SELECT * FROM artifacts WHERE id=?").get(args.artifact_id);
  if (!row) throw new Error(`artifact not found: ${args.artifact_id}`);
  if (!config.peer?.remote_artifacts) throw new Error("peer.remote_artifacts is not configured");
  if (!fs.existsSync(row.path)) {
    db.prepare("UPDATE artifacts SET state='source_missing' WHERE id=?").run(row.id);
    const delivery = { ok: false, verified: false, error: "registered source file is missing" };
    audit("send", "artifact", row.id, "source_missing", { delivery });
    return { artifact_id: row.id, delivery };
  }
  const currentStat = fs.statSync(row.path);
  const verifySource = effective.features.artifact_verification_mode !== "cached";
  const currentSha256 = verifySource ? sha256(row.path) : row.sha256;
  if (Number(currentStat.size) !== Number(row.size_bytes) || currentSha256 !== row.sha256) {
    db.prepare("UPDATE artifacts SET state='source_changed' WHERE id=?").run(row.id);
    const delivery = {
      ok: false,
      verified: false,
      error: "registered source file changed; register the current revision as a new artifact",
      registered_size_bytes: row.size_bytes,
      current_size_bytes: currentStat.size,
      registered_sha256: row.sha256,
      current_sha256: currentSha256,
    };
    audit("send", "artifact", row.id, "source_changed", { delivery });
    return { artifact_id: row.id, delivery };
  }
  const remoteFileName = `${row.id}-${path.basename(row.path)}`;
  const delivery = rsyncFile(row.path, config.peer.remote_artifacts, remoteFileName);
  if (delivery.ok) {
    const remotePath = path.posix.join(config.peer.remote_artifacts, remoteFileName);
    const verified = spawnSync(
      "ssh",
      sshArgs(delivery.host, `shasum -a 256 ${shellQuote(remotePath)}`),
      { encoding: "utf8", timeout: 24 * 60 * 60 * 1000, env: minimalChildEnvironment() },
    );
    const remoteSha256 = verified.status === 0
      ? verified.stdout.trim().split(/\s+/)[0]
      : null;
    delivery.remote_path = remotePath;
    delivery.remote_sha256 = remoteSha256;
    delivery.verified = remoteSha256 === row.sha256;
    if (delivery.verified) {
      const manifestPath = path.join(OUTBOX, `${row.id}.artifact.json`);
      fs.writeFileSync(manifestPath, `${JSON.stringify({
        schema_version: 1,
        artifact_id: row.id,
        owner: row.owner,
        name: row.name,
        file_name: remoteFileName,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        delivered_at: now(),
        delivered_via: delivery.host,
        metadata: JSON.parse(row.metadata_json),
      }, null, 2)}\n`, { mode: 0o600 });
      const manifestDelivery = rsyncFile(manifestPath, config.peer.remote_artifacts);
      delivery.manifest = manifestDelivery;
      if (!manifestDelivery.ok) delivery.verified = false;
    }
    if (delivery.verified) {
      db.prepare("UPDATE artifacts SET state='delivered', delivered_via=? WHERE id=?")
        .run(delivery.host, row.id);
    } else {
      db.prepare("UPDATE artifacts SET state='delivery_queued' WHERE id=?").run(row.id);
      delivery.error = verified.stderr?.trim() || "remote SHA-256 verification failed";
    }
  } else {
    db.prepare("UPDATE artifacts SET state='delivery_queued' WHERE id=?").run(row.id);
  }
  audit("send", "artifact", row.id, delivery.verified ? "delivered" : "failed", { delivery });
  return { artifact_id: row.id, delivery };
}

function flushOutbox(args) {
  if (process.env.HAWKSPAN_BACKGROUND === "1" && !effective.features.enable_background_outbox) {
    throw new Error("background outbox processing is disabled");
  }
  const messageRows = db.prepare(`
    SELECT id FROM messages
    WHERE direction='outbound' AND state='queued'
    ORDER BY created_at ASC
  `).all();
  const artifactRows = db.prepare(`
    SELECT id FROM artifacts
    WHERE state='delivery_queued'
    ORDER BY created_at ASC
  `).all();
  const messages = [];
  const artifacts = [];
  for (const row of effective.features.enable_background_artifact_sender || process.env.HAWKSPAN_BACKGROUND !== "1"
    ? artifactRows : []) {
    try {
      artifacts.push(sendArtifact({ artifact_id: row.id }));
    } catch (error) {
      artifacts.push({ artifact_id: row.id, error: String(error?.message || error) });
    }
  }
  for (const row of messageRows) {
    try {
      messages.push(retryMessage({ message_id: row.id, wake: args.wake !== false }));
    } catch (error) {
      messages.push({ message_id: row.id, error: String(error?.message || error) });
    }
  }
  ingestInbox();
  const received = effective.features.enable_background_artifact_receiver ||
      process.env.HAWKSPAN_BACKGROUND !== "1"
    ? receiveArtifacts()
    : { artifacts: [], skipped: true };
  audit("flush", "outbox", null, "complete", {
    message_count: messages.length,
    artifact_count: artifacts.length,
    received_artifact_count: received.artifacts.length,
  });
  return { messages, artifacts, received };
}

function listArtifacts(args) {
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 500);
  const rows = args.state
    ? db.prepare("SELECT * FROM artifacts WHERE state=? ORDER BY created_at DESC LIMIT ?")
        .all(args.state, limit)
    : db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map((row) => ({
    ...row,
    metadata: JSON.parse(row.metadata_json),
    metadata_json: undefined,
  }));
}

function receiveArtifacts() {
  if (!directionEnabled("allow_peer_artifact_receive", "inbound")) {
    throw new Error("inbound artifact receiving is disabled");
  }
  const results = [];
  for (const name of fs.readdirSync(ARTIFACTS)) {
    if (!name.endsWith(".artifact.json")) continue;
    const manifestPath = path.join(ARTIFACTS, name);
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const filePath = path.join(ARTIFACTS, manifest.file_name);
      const existing = db.prepare("SELECT id FROM artifacts WHERE id=?").get(manifest.artifact_id);
      if (!fs.existsSync(filePath)) {
        if (existing) {
          db.prepare("UPDATE artifacts SET state='received_missing' WHERE id=?")
            .run(manifest.artifact_id);
        }
        throw new Error(`artifact file is missing: ${manifest.file_name}`);
      }
      const stat = fs.statSync(filePath);
      const digest = sha256(filePath);
      const verified = stat.size === manifest.size_bytes && digest === manifest.sha256;
      if (!existing) {
        db.prepare(`
          INSERT INTO artifacts
            (id,created_at,owner,path,name,size_bytes,sha256,state,delivered_via,metadata_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(
          manifest.artifact_id,
          manifest.delivered_at || now(),
          manifest.owner || "peer",
          filePath,
          manifest.name || manifest.file_name,
          stat.size,
          digest,
          verified ? "received_verified" : "received_mismatch",
          manifest.delivered_via || null,
          json(manifest.metadata),
        );
      } else {
        db.prepare(`
          UPDATE artifacts
          SET path=?,name=?,size_bytes=?,sha256=?,state=?,delivered_via=?,metadata_json=?
          WHERE id=?
        `).run(
          filePath,
          manifest.name || manifest.file_name,
          stat.size,
          digest,
          verified ? "received_verified" : "received_mismatch",
          manifest.delivered_via || null,
          json(manifest.metadata),
          manifest.artifact_id,
        );
      }
      audit("receive", "artifact", manifest.artifact_id, verified ? "verified" : "mismatch", {
        path: filePath,
        size_bytes: stat.size,
        sha256: digest,
      });
      results.push({ artifact_id: manifest.artifact_id, path: filePath, verified });
    } catch (error) {
      audit("receive", "artifact", name, "rejected", { error: String(error) });
      results.push({ manifest: manifestPath, verified: false, error: String(error?.message || error) });
    }
  }
  return { artifacts: results };
}

function listAuditEvents(args) {
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 1000);
  const rows = args.object_type
    ? db.prepare(`
        SELECT * FROM audit_events WHERE object_type=?
        ORDER BY sequence DESC LIMIT ?
      `).all(args.object_type, limit)
    : db.prepare("SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?").all(limit);
  return rows.map((row) => ({
    ...row,
    details: JSON.parse(row.details_json),
    details_json: undefined,
  }));
}

const peerToolAllowlist = new Set([
  "link_status",
  "run_command",
  "receive_messages",
  "list_messages",
  "acknowledge_message",
  "create_job",
  "update_job_status",
  "list_jobs",
  "register_artifact",
  "verify_artifact",
  "send_artifact",
  "list_artifacts",
  "receive_artifacts",
  "flush_outbox",
  "list_audit_events",
]);
const outboundPeerToolAllowlist = new Set(peerToolAllowlist);
for (const name of config.peer?.allowed_tools || []) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(name)) {
    throw new Error("peer.allowed_tools must contain valid MCP tool names");
  }
  outboundPeerToolAllowlist.add(name);
}
for (const direction of ["inbound", "outbound"]) {
  const explicitlyConfigured = config.features?.allowed_peer_tools;
  const configured = (
    effective.role_profile === "controller-worker" &&
    (explicitlyConfigured === undefined || explicitlyConfigured?.[direction] === undefined) &&
    (effective.node_role === "controller" ? direction === "inbound" : direction === "outbound")
  ) ? [] : effective.features.allowed_peer_tools[direction];
  if (Array.isArray(configured)) {
    const target = direction === "inbound" ? peerToolAllowlist : outboundPeerToolAllowlist;
    target.clear();
    for (const name of configured) {
      if (!/^[a-z][a-z0-9_]{0,127}$/.test(name)) {
        throw new Error(`features.allowed_peer_tools.${direction} contains an invalid tool name`);
      }
      target.add(name);
    }
  }
}

const peerFeatureForTool = new Map([
  ["run_command", "allow_peer_commands"],
  ["wake_peer_thread", "allow_peer_wakeup"],
  ["send_message", "allow_peer_messages"],
  ["retry_message", "allow_peer_messages"],
  ["receive_messages", "allow_peer_messages"],
  ["list_messages", "allow_peer_messages"],
  ["acknowledge_message", "allow_peer_acknowledgements"],
  ["create_job", "allow_peer_jobs"],
  ["update_job_status", "allow_peer_jobs"],
  ["list_jobs", "allow_peer_jobs"],
  ["send_artifact", "allow_peer_artifact_send"],
  ["register_artifact", "allow_peer_artifact_receive"],
  ["verify_artifact", "allow_peer_artifact_receive"],
  ["receive_artifacts", "allow_peer_artifact_receive"],
]);

function enforcePeerFeature(toolName, direction) {
  if (
    toolName === "run_command" &&
    (!directionEnabled("allow_peer_commands", direction) ||
      !directionEnabled("enable_broad_run_command", direction))
  ) {
    throw new Error(`peer commands are disabled for ${direction} calls`);
  }
  const feature = peerFeatureForTool.get(toolName);
  if (feature && feature !== "allow_peer_commands" && !directionEnabled(feature, direction)) {
    throw new Error(`${feature} is disabled for ${direction} calls`);
  }
}

function runCommand(args) {
  const command = String(args.command || "").trim();
  if (!command) throw new Error("command is required");

  const trackedJob = args.job_id
    ? db.prepare("SELECT * FROM jobs WHERE id=?").get(args.job_id)
    : null;
  if (args.job_id && !trackedJob) {
    throw new Error(`job not found: ${args.job_id}`);
  }
  const authorizationRequired =
    effective.features.require_authorized_job_for_all_commands ||
    (args.consequential === true &&
      effective.features.require_authorized_job_for_consequential_commands);
  if (authorizationRequired && (!trackedJob || trackedJob.authorization_state !== "recorded")) {
    throw new Error("this command requires a job with recorded authorization");
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : os.homedir();
  const stat = fs.statSync(cwd);
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);

  const timeoutMs = Math.min(
    Math.max(Number(args.timeout_ms || 300000), 1000),
    24 * 60 * 60 * 1000,
  );
  const outputLimit = Math.min(
    Math.max(Number(args.output_limit_bytes || 1024 * 1024), 4096),
    16 * 1024 * 1024,
  );
  const startedAt = now();
  const started = Date.now();
  const result = spawnSync("/bin/zsh", ["-lc", command], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: outputLimit,
    env: minimalChildEnvironment(),
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const commandId = id("command");
  const ok = result.status === 0 && !result.error;
  const details = {
    ...(effective.features.audit_command_content
      ? { command }
      : { command_sha256: crypto.createHash("sha256").update(command).digest("hex") }),
    cwd,
    consequential: args.consequential === true,
    tracking_job_id: trackedJob?.id || null,
    started_at: startedAt,
    duration_ms: Date.now() - started,
    exit_code: result.status,
    signal: result.signal || null,
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    error: result.error ? String(result.error) : null,
  };
  audit("execute", "command", commandId, ok ? "completed" : "failed", details);
  return {
    command_id: commandId,
    ...details,
    stdout,
    stderr,
    ok,
  };
}

function peerCallTool(args) {
  if (!config.peer) throw new Error("peer is not configured");
  enforcePeerFeature(args.tool_name, "outbound");
  if (!outboundPeerToolAllowlist.has(args.tool_name)) {
    throw new Error(`peer tool is not allowed: ${args.tool_name}`);
  }
  const remoteNode = config.peer.remote_node || "node";
  const remoteCallTool = config.peer.remote_call_tool ||
    path.posix.join(config.peer.remote_plugin_root || "", "scripts/call-tool.mjs");
  if (!remoteCallTool) throw new Error("peer.remote_call_tool is not configured");
  const peerTimeoutMs = args.timeout_ms === undefined ? 300000 : args.timeout_ms;
  if (!Number.isInteger(peerTimeoutMs) || peerTimeoutMs < 1000 || peerTimeoutMs > 4 * 60 * 60 * 1000) {
    throw new Error("peer timeout_ms must be from 1000 through 14400000");
  }
  const remoteCommand = [
    "env",
    "HAWKSPAN_CALL_ORIGIN=peer",
    `HAWKSPAN_CALL_TIMEOUT_MS=${peerTimeoutMs}`,
    shellQuote(remoteNode),
    shellQuote(remoteCallTool),
    shellQuote(args.tool_name),
    shellQuote(JSON.stringify(args.arguments || {})),
  ].join(" ");
  const attempts = [];
  for (const host of peerCandidates()) {
    const result = spawnSync("ssh", sshArgs(host, remoteCommand), {
      encoding: "utf8",
      timeout: peerTimeoutMs,
      env: minimalChildEnvironment(),
    });
    attempts.push({
      host,
      status: result.status,
      error: result.stderr?.trim() || "",
    });
    if (result.status !== 0) continue;
    let output;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new Error(`peer returned invalid JSON: ${result.stdout.slice(0, 1000)}`);
    }
    audit("call", "peer_tool", args.tool_name, output.isError ? "error" : "ok", {
      host,
      remote_is_error: Boolean(output.isError),
    });
    return { host, tool_name: args.tool_name, result: output, attempts };
  }
  audit("call", "peer_tool", args.tool_name, "failed", { attempts });
  return { tool_name: args.tool_name, error: "all routes failed", attempts };
}

function linkStatus() {
  ingestInbox();
  const counts = {
    inbound_unacknowledged: db.prepare(`
      SELECT count(*) AS count FROM messages
      WHERE direction='inbound' AND state='received'
        AND kind != 'acknowledgement'
    `).get().count,
    outbound_queued: db.prepare(`
      SELECT count(*) AS count FROM messages
      WHERE direction='outbound' AND state='queued'
    `).get().count,
    active_jobs: db.prepare(`
      SELECT count(*) AS count FROM jobs
      WHERE state IN ('queued','authorized','running','started','stop_requested')
    `).get().count,
    paused_jobs: db.prepare(`
      SELECT count(*) AS count FROM jobs WHERE state='paused'
    `).get().count,
    completed_jobs: db.prepare(`
      SELECT count(*) AS count FROM jobs
      WHERE state IN ('completed','verified')
    `).get().count,
    artifacts: db.prepare("SELECT count(*) AS count FROM artifacts").get().count,
  };
  const routes = [];
  for (const route of configuredRoutes()) {
    if (!route.enabled) {
      routes.push({
        role: route.role,
        label: route.label,
        host: route.host,
        enabled: false,
        status: "disabled",
        network_reachable: null,
        transport_ready: null,
        transport_error: "",
      });
      continue;
    }
    const host = route.host;
    const ping = spawnSync("ping", ["-c", "1", "-W", "1000", host], {
      encoding: "utf8",
      timeout: 3000,
      env: minimalChildEnvironment(),
    });
    const ssh = spawnSync("ssh", sshArgs(host, "true"), {
      encoding: "utf8",
      timeout: 8000,
      env: minimalChildEnvironment(),
    });
    routes.push({
      role: route.role,
      label: route.label,
      host,
      enabled: true,
      status: ssh.status === 0 ? "connected" : "unavailable",
      network_reachable: ping.status === 0,
      transport_ready: ssh.status === 0,
      transport_error: ssh.status === 0 ? "" : ssh.stderr?.trim() || "",
    });
  }
  const selectedRoute = routes.find((route) => route.enabled && route.transport_ready) || null;
  return {
    node_id: redactResolvedMachineValues(config.node_id),
    state_root: "[local HawkSpan state]",
    config_path: "[local HawkSpan configuration]",
    machine_settings: {
      source: fs.existsSync(ENV_PATH) ? "hawkspan.env" : "defaults",
      values: redactedHawkspanEnv(machineEnvironment),
    },
    peer: config.peer ? {
      node_id: redactResolvedMachineValues(config.peer.node_id),
      primary_host: config.peer.primary_host ? "[configured]" : "",
      fallback_host: config.peer.fallback_host ? "[configured]" : "",
      primary_enabled: config.peer.primary_enabled ?? Boolean(config.peer.primary_host),
      fallback_enabled: config.peer.fallback_enabled ?? Boolean(config.peer.fallback_host),
      primary_label: connectionConfiguration().primary.label,
      fallback_label: connectionConfiguration().fallback.label,
    } : null,
    routes: routes.map((route) => ({
      ...route,
      host: route.host ? "[configured]" : "",
      transport_error: route.transport_error ? "Connection failed; inspect locally." : "",
    })),
    selected_route: selectedRoute ? "[configured]" : null,
    selected_route_role: selectedRoute?.role || null,
    local_control: localControl ? {
      enabled: true,
      host: localControl.host,
      port: localControl.port,
      url: localControl.url,
    } : { enabled: false },
    counts,
  };
}


const coreTools = [
  {
    name: "get_configuration",
    description: "Read the effective HawkSpan role profile and approved compatibility feature flags.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: getConfiguration,
  },
  {
    name: "update_configuration",
    description: "Atomically update only approved HawkSpan role and compatibility flags while preserving unrelated configuration.",
    inputSchema: {
      type: "object",
      properties: {
        role_profile: { type: "string", enum: ["symmetric", "controller-worker"] },
        node_role: { type: ["string", "null"], enum: ["controller", "worker", null] },
        features: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: updateConfiguration,
  },
  {
    name: "get_connection_configuration",
    description: "Read the independently configurable primary and fallback peer connections.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: getConnectionConfiguration,
  },
  {
    name: "update_connection_configuration",
    description: "Atomically update peer connection enablement, human labels, and hosts while preserving all other settings. Explicit confirmation is required.",
    inputSchema: {
      type: "object",
      required: ["confirm"],
      properties: {
        routes: {
          type: "object",
          properties: {
            primary: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                label: { type: "string", minLength: 1, maxLength: 40 },
                host: { type: "string", maxLength: 253 },
              },
              additionalProperties: false,
            },
            fallback: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                label: { type: "string", minLength: 1, maxLength: 40 },
                host: { type: "string", maxLength: 253 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        confirm: { type: "boolean", const: true },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: updateConnectionConfiguration,
  },
  {
    name: "reset_configuration",
    description: "Restore inherited symmetric defaults by removing only HawkSpan role and approved feature overrides. Explicit confirmation is required.",
    inputSchema: {
      type: "object",
      required: ["confirm"],
      properties: {
        confirm: {
          type: "boolean",
          const: true,
          description: "Must be true to confirm the reset.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: resetConfiguration,
  },
  {
    name: "list_configuration_profiles",
    description: "List locally saved HawkSpan role and approved-feature profiles.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listConfigurationProfiles,
  },
  {
    name: "save_configuration_profile",
    description: "Save the current explicit HawkSpan role and approved-feature overrides under a human-readable name.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        confirm_replace: {
          type: "boolean",
          default: false,
          description: "Must be true to replace an existing profile with the same name.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: saveConfigurationProfile,
  },
  {
    name: "apply_configuration_profile",
    description: "Atomically apply a named role and approved-feature profile while preserving all unrelated configuration. Explicit confirmation is required.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "confirm"],
      properties: {
        profile_id: {
          type: "string",
          pattern: "^(?:profile-[a-f0-9]{24}|builtin-(?:current-symmetric|high-value-controller|compute-worker|coordination-only))$",
        },
        confirm: {
          type: "boolean",
          const: true,
          description: "Must be true to confirm applying the profile.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: applyConfigurationProfile,
  },
  {
    name: "delete_configuration_profile",
    description: "Delete one locally saved configuration profile without changing the active configuration. Explicit confirmation is required.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "confirm"],
      properties: {
        profile_id: {
          type: "string",
          pattern: "^(?:profile-[a-f0-9]{24}|builtin-(?:current-symmetric|high-value-controller|compute-worker|coordination-only))$",
        },
        confirm: {
          type: "boolean",
          const: true,
          description: "Must be true to confirm deletion.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: deleteConfigurationProfile,
  },
  {
    name: "mcp_status",
    description: "Confirm that this HawkSpan MCP service is responding and identify its node and version.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: () => ({
      online: true,
      service: "hawkspan",
      version: "0.1.0",
      node_id: redactResolvedMachineValues(config.node_id),
    }),
  },
  {
    name: "link_status",
    description: "Read route, queue, job, and artifact status for this HawkSpan node.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: linkStatus,
  },
  {
    name: "run_command",
    description: "Run a shell command on this trusted Mac and record an audit event. The consequential flag classifies the audit entry; the active user instruction is the authority.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 86400000
        },
        output_limit_bytes: {
          type: "integer",
          minimum: 4096,
          maximum: 16777216
        },
        consequential: {
          type: "boolean",
          default: false,
          description: "Audit classification for a consequential action; it does not create a second authorization gate."
        },
        job_id: {
          type: "string",
          description: "Optional durable tracking job ID."
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: runCommand,
  },
  {
    name: "peer_call_tool",
    description: "Call one allowlisted HawkSpan tool on the paired Mac over the preferred private route with fallback. The active user instruction remains authoritative.",
    inputSchema: {
      type: "object",
      required: ["tool_name"],
      properties: {
        tool_name: { type: "string" },
        arguments: { type: "object" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 14400000 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: peerCallTool,
  },
  {
    name: "send_message",
    description: "Send routine private peer-to-peer coordination over the already-authorized HawkSpan link. This is durable, idempotent IPC, not an external communication or consequential action.",
    inputSchema: {
      type: "object",
      required: ["subject", "body"],
      properties: {
        recipient: { type: "string" },
        kind: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        correlation_id: { type: "string" },
        metadata: { type: "object" },
        deliver: { type: "boolean", default: true },
        wake: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: sendMessage,
  },
  {
    name: "retry_message",
    description: "Retry delivery of the same immutable queued outbound message without creating a duplicate.",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string" },
        wake: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: retryMessage,
  },
  {
    name: "wake_peer_thread",
    description: "Wake the configured Codex task on the paired Mac after an audited message has been delivered.",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string" },
        subject: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: wakePeerThread,
  },
  {
    name: "receive_messages",
    description: "Import and list inbound messages that have not yet been acknowledged.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500 },
        include_acknowledged: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: receiveMessages,
  },
  {
    name: "list_messages",
    description: "List durable inbound and outbound messages by direction or state.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["inbound", "outbound"] },
        state: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listMessages,
  },
  {
    name: "acknowledge_message",
    description: "Mark one inbound message acknowledged and send a correlated acknowledgement.",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string" },
        note: { type: "string" },
        deliver: { type: "boolean", default: true },
        reply: {
          type: "boolean",
          description: "Send a correlated acknowledgement envelope. Defaults false for acknowledgement-kind inbound messages and true otherwise.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: acknowledgeMessage,
  },
  {
    name: "create_job",
    description: "Create an audited job for identity, progress, recovery, and idempotency.",
    inputSchema: {
      type: "object",
      required: ["kind", "title"],
      properties: {
        kind: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        assignee: { type: "string" },
        requires_authorization: { type: "boolean", default: false },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: createJob,
  },
  {
    name: "update_job_status",
    description: "Apply a validated, audited job state transition. Authorization requires recorded evidence.",
    inputSchema: {
      type: "object",
      required: ["job_id", "state"],
      properties: {
        job_id: { type: "string" },
        state: {
          type: "string",
          enum: ["awaiting_authorization", "authorized", "queued", "running", "paused", "cancel_requested", "cancelled", "completed", "failed", "verified"],
        },
        authorization_evidence: { type: "string" },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: updateJobStatus,
  },
  {
    name: "list_jobs",
    description: "List durable jobs and authorization state.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listJobs,
  },
  {
    name: "register_artifact",
    description: "Register a local file as an immutable artifact and calculate its SHA-256 digest.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        name: { type: "string" },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: registerArtifact,
  },
  {
    name: "verify_artifact",
    description: "Calculate an artifact digest and optionally compare it with an expected SHA-256 value.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: { type: "string" },
        path: { type: "string" },
        expected_sha256: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: verifyArtifact,
  },
  {
    name: "send_artifact",
    description: "Send a registered artifact with resumable rsync over the primary route, falling back when necessary.",
    inputSchema: {
      type: "object",
      required: ["artifact_id"],
      properties: { artifact_id: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: sendArtifact,
  },
  {
    name: "list_artifacts",
    description: "List registered artifacts and their durable delivery state.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listArtifacts,
  },
  {
    name: "receive_artifacts",
    description: "Import artifact manifests delivered by the peer and verify each local file by size and SHA-256.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: receiveArtifacts,
  },
  {
    name: "flush_outbox",
    description: "Retry every queued message and previously attempted artifact over the preferred route with automatic fallback.",
    inputSchema: {
      type: "object",
      properties: {
        wake: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: flushOutbox,
  },
  {
    name: "list_audit_events",
    description: "Read the local append-only coordination audit trail.",
    inputSchema: {
      type: "object",
      properties: {
        object_type: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listAuditEvents,
  },
];

let toolMap = new Map(coreTools.map((tool) => [tool.name, tool]));

async function callToolInternal(name, args = {}, origin = "local", pluginId = null) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  if (origin === "peer" && !peerToolAllowlist.has(name)) {
    throw new Error(`peer tool is not allowed: ${name}`);
  }
  if (origin === "peer") enforcePeerFeature(name, "inbound");
  if (origin === "plugin") {
    const globalAllowlist = config.application_plugins?.core_tool_allowlist || [];
    const pluginAllowlist = typeof pluginId === "string"
      ? config.application_plugins?.entries?.[pluginId]?.core_tool_allowlist || []
      : [];
    if (!globalAllowlist.includes(name) || !pluginAllowlist.includes(name)) {
      throw new Error(`plugin core-tool access is not allowed: ${name}`);
    }
  }
  if (tool.allowedOrigins && !tool.allowedOrigins.has(origin)) {
    throw new Error(`${name} does not allow ${origin} access`);
  }
  return tool.handler(args, origin);
}

const pluginFramework = await createApplicationPluginFramework({
  config: effective.features.enable_scoped_operation_adapters
    ? config
    : { ...config, application_plugins: { ...(config.application_plugins || {}), enabled: false } },
  stateRoot: STATE_ROOT,
  db,
  audit,
  callCoreTool: callToolInternal,
  environment: machineEnvironment,
  redact: redactResolvedMachineError,
  validatePreset: approvedApplicationPresetSettings,
});
applicationPresets = pluginFramework.presets;
const applicationPresetTools = [
  {
    name: "list_application_presets",
    description: "List reviewed quick-start presets declared by installed application plugins.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: listApplicationPresets,
  },
  {
    name: "preview_application_preset",
    description: "Preview the exact role, capability, peer-tool, and plugin-operation restrictions in an installed application preset without changing configuration.",
    inputSchema: {
      type: "object",
      required: ["preset_id"],
      properties: {
        preset_id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}/[a-z][a-z0-9-]{0,62}$" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: previewApplicationPreset,
  },
  {
    name: "apply_application_preset",
    description: "Apply a reviewed installed application preset while preserving connections, credentials, paths, tokens, local control, plugin configuration, other plugins, and local application data. Explicit confirmation is required.",
    inputSchema: {
      type: "object",
      required: ["preset_id", "confirm"],
      properties: {
        preset_id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}/[a-z][a-z0-9-]{0,62}$" },
        confirm: { type: "boolean", const: true },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: applyApplicationPreset,
  },
  {
    name: "reset_application_preset",
    description: "Reset role and capability overrides plus the selected plugin's operation restriction to inherited defaults without changing local installation data. Explicit confirmation is required.",
    inputSchema: {
      type: "object",
      required: ["preset_id", "confirm"],
      properties: {
        preset_id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}/[a-z][a-z0-9-]{0,62}$" },
        confirm: { type: "boolean", const: true },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: resetApplicationPreset,
  },
];
const tools = [...coreTools, ...applicationPresetTools, ...pluginFramework.tools];
toolMap = new Map(tools.map((tool) => [tool.name, tool]));
for (const tool of pluginFramework.tools) {
  if (tool.allowedOrigins?.has("peer")) peerToolAllowlist.add(tool.name);
}
localControl = await startLocalControlSurface(
  process.env.HAWKSPAN_LOCAL_CONTROL_DISABLED === "1"
    ? { enabled: false }
    : config.local_control,
  async (name, args, origin) => {
    try {
      const output = await callToolInternal(name, args, origin);
      return ["get_connection_configuration", "update_connection_configuration", "link_status"].includes(name)
        ? output
        : redactResolvedMachineValues(output);
    } catch (error) {
      throw new Error(redactResolvedMachineError(error));
    }
  },
);

function success(idValue, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: idValue, result })}\n`);
}

function failure(idValue, code, message, data) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: idValue ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  })}\n`);
}

async function handle(request) {
  const requestId = request.id;
  if (request.method === "initialize") {
    success(requestId, {
      protocolVersion: request.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "hawkspan", version: "0.1.0" },
    });
    return;
  }
  if (request.method === "ping") {
    success(requestId, {});
    return;
  }
  if (request.method === "tools/list") {
    success(requestId, {
      tools: tools.map(({ handler, allowedOrigins, applicationPlugin, ...definition }) => definition),
    });
    return;
  }
  if (request.method === "tools/call") {
    const tool = toolMap.get(request.params?.name);
    if (!tool) {
      failure(requestId, -32602, `unknown tool: ${request.params?.name}`);
      return;
    }
    try {
      const origin = process.env.HAWKSPAN_CALL_ORIGIN === "peer" ? "peer" : "local";
      const rawOutput = await callToolInternal(tool.name, request.params?.arguments || {}, origin);
      const output = ["get_connection_configuration", "update_connection_configuration"].includes(tool.name)
        ? rawOutput
        : redactResolvedMachineValues(rawOutput);
      success(requestId, {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
        isError: false,
      });
    } catch (error) {
      const publicError = redactResolvedMachineError(error);
      audit("tool_call", "tool", tool.name, "error", { error: publicError });
      success(requestId, {
        content: [{ type: "text", text: publicError }],
        isError: true,
      });
    }
    return;
  }
  if (request.method?.startsWith("notifications/")) return;
  failure(requestId, -32601, `method not found: ${request.method}`);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

input.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    Promise.resolve(handle(request)).catch((error) => {
      failure(request.id, -32603, "internal error", redactResolvedMachineError(error));
    });
  } catch (error) {
    failure(null, -32700, "parse error", String(error));
  }
});

input.on("close", async () => {
  await pluginFramework.close();
  if (localControl) await localControl.close();
  db.close();
});
