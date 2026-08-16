import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function atomicWrite(filePath, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, body, { mode, flag: "wx" });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, mode);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function installedRevisionPath(stateRoot) {
  return path.join(stateRoot, "installed-revision.json");
}

export function readReleaseAuthority(stateRoot) {
  const authorityPath = installedRevisionPath(stateRoot);
  if (!fs.existsSync(authorityPath)) {
    throw new Error(`installed release authority is missing: ${authorityPath}`);
  }
  const stat = fs.lstatSync(authorityPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("installed release authority must be a regular file");
  }
  const record = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  const activeReleaseRoot = record.active_release_root;
  if (record.schema_version !== 2 || !record.revision ||
      typeof activeReleaseRoot !== "string" || !path.isAbsolute(activeReleaseRoot) ||
      typeof record.stable_release_root !== "string" || !path.isAbsolute(record.stable_release_root)) {
    throw new Error("installed release authority is incomplete");
  }
  const resolvedRoot = fs.realpathSync(activeReleaseRoot);
  if (!fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error("installed release authority root is not a directory");
  }
  return Object.freeze({
    schema_version: record.schema_version,
    revision: String(record.revision),
    active_release_root: resolvedRoot,
    stable_release_root: path.resolve(record.stable_release_root),
    activated_at: record.activated_at || null,
  });
}

export function prepareReleaseAuthority(stateRoot, {
  revision,
  activeReleaseRoot,
  stableReleaseRoot = path.join(os.homedir(), ".local", "share", "hawkspan", "current"),
}) {
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("revision must be an exact 40-character Git commit SHA");
  }
  if (!path.isAbsolute(activeReleaseRoot)) throw new Error("active release root must be absolute");
  const resolvedRoot = fs.realpathSync(activeReleaseRoot);
  if (!fs.statSync(resolvedRoot).isDirectory()) throw new Error("active release root must be a directory");
  for (const required of ["scripts/call-tool.mjs", "scripts/mcp-server.mjs", "launchd"]) {
    if (!fs.existsSync(path.join(resolvedRoot, required))) {
      throw new Error(`active release is missing ${required}`);
    }
  }
  if (!path.isAbsolute(stableReleaseRoot)) throw new Error("stable release root must be absolute");
  if (fs.existsSync(stableReleaseRoot) && !fs.lstatSync(stableReleaseRoot).isSymbolicLink()) {
    throw new Error(`stable release path exists and is not a symbolic link: ${stableReleaseRoot}`);
  }
  const record = {
    schema_version: 2,
    revision,
    active_release_root: resolvedRoot,
    stable_release_root: stableReleaseRoot,
    activated_at: new Date().toISOString(),
  };
  return Object.freeze(record);
}

export function commitReleaseAuthority(stateRoot, record) {
  const stableReleaseRoot = record.stable_release_root;
  fs.mkdirSync(path.dirname(stableReleaseRoot), { recursive: true, mode: 0o700 });
  const temporaryLink = `${stableReleaseRoot}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.symlinkSync(record.active_release_root, temporaryLink);
    fs.renameSync(temporaryLink, stableReleaseRoot);
  } finally {
    if (fs.existsSync(temporaryLink)) fs.unlinkSync(temporaryLink);
  }
  atomicWrite(installedRevisionPath(stateRoot), `${JSON.stringify(record, null, 2)}\n`);
  return Object.freeze(record);
}

export function writeReleaseAuthority(stateRoot, options) {
  const record = prepareReleaseAuthority(stateRoot, options);
  return commitReleaseAuthority(stateRoot, record);
}

export function derivedReleasePaths(authority) {
  const scripts = path.join(authority.active_release_root, "scripts");
  return Object.freeze({
    active_release_root: authority.active_release_root,
    service_root: authority.stable_release_root,
    repository_dir: authority.active_release_root,
    call_tool: path.join(scripts, "call-tool.mjs"),
    trainer_start: path.join(scripts, "m4-trainer-start.sh"),
    trainer_stop: path.join(scripts, "m4-trainer-stop.sh"),
    trainer_package: path.join(scripts, "m4-trainer-package.sh"),
    trainer_runner: path.join(scripts, "run_captioned_loras.py.managed"),
    trainer_automation: path.join(scripts, "lora-automation.mjs"),
    packet_builder: path.join(scripts, "build_return_packets.py.managed"),
  });
}

const launchdServices = Object.freeze([
  "org.hawkspan.local-control",
  "org.hawkspan.link-agent",
  "org.hawkspan.queue-supervisor",
  "org.hawkspan.lora-scheduler",
  "org.hawkspan.packet-receiver",
]);

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchdPlistBodies(authority, {
  stateRoot,
  nodePath = process.execPath,
  launchAgentsRoot,
} = {}) {
  if (!stateRoot || !launchAgentsRoot) throw new Error("stateRoot and launchAgentsRoot are required");
  const renderedBodies = [];
  for (const label of launchdServices) {
    const templatePath = path.join(authority.active_release_root, "launchd", `${label}.plist.template`);
    if (!fs.existsSync(templatePath)) throw new Error(`launchd template is missing: ${templatePath}`);
    const rendered = fs.readFileSync(templatePath, "utf8")
      .replaceAll("__NODE__", xmlEscape(nodePath))
      .replaceAll("__PLUGIN_ROOT__", xmlEscape(authority.stable_release_root))
      .replaceAll("__STATE_ROOT__", xmlEscape(stateRoot));
    if (/__[A-Z0-9_]+__/.test(rendered)) throw new Error(`unresolved placeholder in ${templatePath}`);
    const targetPath = path.join(launchAgentsRoot, `${label}.plist`);
    renderedBodies.push({ targetPath, rendered });
  }
  return Object.freeze(renderedBodies);
}

export function renderLaunchdPlists(authority, options = {}) {
  const renderedBodies = renderLaunchdPlistBodies(authority, options);
  for (const { targetPath, rendered } of renderedBodies) {
    atomicWrite(targetPath, rendered, 0o644);
  }
  return Object.freeze(renderedBodies.map(({ targetPath }) => targetPath));
}

export function validateLiveReleaseConfiguration(authority, { envValues, config, launchdBodies = [] }) {
  const expected = derivedReleasePaths(authority);
  const mismatches = [];
  const compare = (location, observed, wanted) => {
    if (observed !== wanted) mismatches.push({ location, observed: observed ?? null, expected: wanted });
  };
  compare("hawkspan.env:HAWKSPAN_ACTIVE_RELEASE_ROOT", envValues.HAWKSPAN_ACTIVE_RELEASE_ROOT, expected.active_release_root);
  compare("hawkspan.env:HAWKSPAN_REPOSITORY_DIR", envValues.HAWKSPAN_REPOSITORY_DIR, expected.repository_dir);
  compare("hawkspan.env:HAWKSPAN_LOCAL_TRAINER_START_SCRIPT", envValues.HAWKSPAN_LOCAL_TRAINER_START_SCRIPT, expected.trainer_start);
  compare("hawkspan.env:HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT", envValues.HAWKSPAN_LOCAL_TRAINER_STOP_SCRIPT, expected.trainer_stop);
  compare("hawkspan.env:HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT", envValues.HAWKSPAN_LOCAL_TRAINER_PACKAGE_SCRIPT, expected.trainer_package);
  if (Object.hasOwn(config, "plugin_root")) {
    mismatches.push({ location: "config.json:plugin_root", observed: config.plugin_root, expected: "absent" });
  }
  compare("config.json:training.start_script", config.training?.start_script, expected.trainer_start);
  compare("config.json:training.stop_script", config.training?.stop_script, expected.trainer_stop);
  compare("config.json:training.package_script", config.training?.package_script, expected.trainer_package);
  compare("config.json:training.runner_script", config.training?.runner_script, expected.trainer_runner);
  compare("config.json:training.automation_script", config.training?.automation_script, expected.trainer_automation);
  compare("config.json:training.packet_builder", config.training?.packet_builder, expected.packet_builder);
  if (!path.isAbsolute(config.training?.node_path || "")) {
    mismatches.push({
      location: "config.json:training.node_path",
      observed: config.training?.node_path ?? null,
      expected: "absolute executable path",
    });
  }
  for (const name of ["HAWKSPAN_REMOTE_PLUGIN_ROOT", "HAWKSPAN_REMOTE_CALL_TOOL", "HAWKSPAN_REMOTE_REPOSITORY_DIR"]) {
    if (Object.hasOwn(envValues, name)) mismatches.push({ location: `hawkspan.env:${name}`, observed: envValues[name], expected: "absent" });
  }
  for (const name of ["remote_plugin_root", "remote_call_tool"]) {
    if (Object.hasOwn(config.peer || {}, name)) mismatches.push({ location: `config.json:peer.${name}`, observed: config.peer[name], expected: "absent" });
  }
  for (const { location, body } of launchdBodies) {
    if (!body.includes(authority.stable_release_root)) {
      mismatches.push({ location, observed: "stable release root missing", expected: authority.stable_release_root });
    }
    const releaseRoots = body.match(/\/[^<\s]+\/\.local\/share\/hawkspan\/releases\/[^/<\s]+/g) || [];
    for (const observed of releaseRoots) {
      if (observed !== authority.active_release_root) {
        mismatches.push({ location, observed, expected: authority.active_release_root });
      }
    }
  }
  return Object.freeze(mismatches);
}

export function assertExecutingRelease(authority, executingRoot) {
  const observed = fs.realpathSync(executingRoot);
  if (observed !== authority.active_release_root) {
    throw new Error(
      `executing release does not match installed authority: ${observed} != ${authority.active_release_root}`,
    );
  }
}

export function atomicJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
