#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fail(message) {
  process.stderr.write(`HawkGrokSpan SSH gateway denied request: ${message}\n`);
  process.exit(126);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) fail(`${name} is required`);
  return path.resolve(process.argv[index + 1]);
}

function assertOwnedDirectory(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail(`${label} must be owned by the SSH account`);
  }
}

const stateRoot = argument("--state-root");
if (!path.isAbsolute(stateRoot) || !/^\/[A-Za-z0-9_./-]+$/.test(stateRoot)) {
  fail("state root must be an absolute normalized path without shell metacharacters");
}
const inbox = path.join(stateRoot, "inbox");
const artifacts = path.join(stateRoot, "artifacts");
const audit = path.join(stateRoot, "audit");
const receiverScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "hawkgrokspan-message-receiver.mjs");
for (const [directory, label] of [
  [stateRoot, "state root"],
  [inbox, "inbox"],
  [artifacts, "artifact inbox"],
  [audit, "audit directory"],
]) assertOwnedDirectory(directory, label);

function requestLocalMessageReceiver() {
  const configPath = path.join(stateRoot, "config.json");
  if (!fs.existsSync(configPath)) fail("local receiver configuration is unavailable");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`local receiver configuration is unreadable: ${error.message}`);
  }
  if (config.surface_profile !== "message-files" || config.message_receiver?.enabled !== true) {
    fail("local message receiver is not enabled");
  }
  const child = spawn(process.execPath, [
    receiverScript,
    "--state-root", stateRoot,
    "--ensure-supervisor",
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const original = process.env.SSH_ORIGINAL_COMMAND || "";
if (original === "true") process.exit(0);

const mkdirMatch = /^mkdir -p '([^']+)'$/.exec(original);
if (mkdirMatch) {
  const requested = path.normalize(mkdirMatch[1]);
  if (![inbox, artifacts, audit].includes(requested)) fail("directory is outside the receive boundary");
  assertOwnedDirectory(requested, "requested receive directory");
  process.exit(0);
}

const digestMatch = /^if command -v shasum >\/dev\/null 2>&1; then shasum -a 256 '([^']+)' ; elif command -v sha256sum >\/dev\/null 2>&1; then sha256sum '([^']+)' ; else printf '%s\\n' 'no SHA-256 utility available' >&2; exit 127; fi$/.exec(original);
if (digestMatch) {
  if (digestMatch[1] !== digestMatch[2]) fail("digest paths disagree");
  const requested = path.normalize(digestMatch[1]);
  if (path.dirname(requested) !== artifacts || !/^[A-Za-z0-9._-]+$/.test(path.basename(requested))) {
    fail("digest target is outside the artifact inbox");
  }
  let stat;
  try {
    stat = fs.lstatSync(requested);
  } catch {
    fail("digest target is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("digest target must be a regular file");
  const digest = crypto.createHash("sha256").update(fs.readFileSync(requested)).digest("hex");
  process.stdout.write(`${digest}  ${requested}\n`);
  process.exit(0);
}

if (original.startsWith("rsync --server ")) {
  if (!/^[A-Za-z0-9_./=+,% -]+$/.test(original)) fail("rsync command contains forbidden characters");
  const tokens = original.split(/ +/);
  if (tokens[0] !== "rsync" || tokens[1] !== "--server" || tokens.includes("--sender")) {
    fail("rsync mode is not receive-only");
  }
  const dot = tokens.indexOf(".");
  if (dot < 3 || dot !== tokens.length - 2) fail("rsync server command shape is invalid");
  for (const option of tokens.slice(2, dot)) {
    const allowed = option === "-logDtpre.iLsfxCIvu" ||
      /^--(?:dirs|partial|append|append-verify|log-format=[A-Za-z0-9%._-]+)$/.test(option);
    if (!allowed) fail(`rsync option is not allowed: ${option}`);
  }
  const requested = path.resolve(tokens.at(-1));
  const receivesDirectory = requested === inbox || requested === artifacts;
  const receivesArtifact = path.dirname(requested) === artifacts &&
    /^[A-Za-z0-9._-]+$/.test(path.basename(requested));
  if (!receivesDirectory && !receivesArtifact) fail("rsync target is outside the receive boundary");
  const result = spawnSync("rsync", tokens.slice(1), { stdio: "inherit" });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (requested === inbox) requestLocalMessageReceiver();
  process.exit(0);
}

fail("command is not part of the message/file transport protocol");
