#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const gateway = path.join(scripts, "hawkgrokspan-ssh-gateway.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkgrokspan-gateway-"));
const state = path.join(root, "state");
const bin = path.join(root, "bin");
for (const directory of [state, path.join(state, "inbox"), path.join(state, "artifacts"), path.join(state, "audit"), bin]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
const rsyncLog = path.join(root, "rsync.log");
fs.writeFileSync(path.join(bin, "rsync"), `#!/bin/sh\nprintf '%s\\n' "$*" > "$HAWKGROKSPAN_RSYNC_LOG"\n`, { mode: 0o755 });

function run(original) {
  return spawnSync(process.execPath, [gateway, "--state-root", state], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HAWKGROKSPAN_RSYNC_LOG: rsyncLog,
      SSH_ORIGINAL_COMMAND: original,
    },
  });
}

assert.equal(run("true").status, 0);
assert.equal(run(`mkdir -p '${path.join(state, "inbox")}'`).status, 0);
assert.equal(run(`mkdir -p '${path.join(root, "outside")}'`).status, 126);

const received = path.join(state, "artifacts", "artifact-safe.txt");
assert.equal(run(`rsync --server -logDtpre.iLsfxCIvu --log-format=X --partial --append --dirs . ${received}`).status, 0);
assert.match(fs.readFileSync(rsyncLog, "utf8"), /--server .*artifact-safe\.txt/);
assert.equal(run(`rsync --server -logDtpre.iLsfxCIvu -g --dirs . ${received}`).status, 0);
assert.equal(run(`rsync --server -logDtpre.iLsfxCIvu --dirs . ${path.join(state, "artifacts")}/`).status, 0);
for (const command of [
  `rsync --server --sender -logDtpre.iLsfxCIvu . ${path.join(state, "inbox")}`,
  `rsync --server --delete -logDtpre.iLsfxCIvu . ${path.join(state, "inbox")}`,
  `rsync --server -logDtpre.iLsfxCIvu . ${path.join(root, "outside")}`,
  "uname -a",
  "/bin/sh",
]) assert.equal(run(command).status, 126, command);

fs.writeFileSync(received, "verified gateway artifact\n", { mode: 0o600 });
const digestCommand = [
  "if command -v shasum >/dev/null 2>&1; then",
  `shasum -a 256 '${received}'`,
  "; elif command -v sha256sum >/dev/null 2>&1; then",
  `sha256sum '${received}'`,
  "; else printf '%s\\n' 'no SHA-256 utility available' >&2; exit 127; fi",
].join(" ");
const digest = run(digestCommand);
assert.equal(digest.status, 0, digest.stderr);
assert.match(digest.stdout, /^[a-f0-9]{64}  \/.*artifact-safe\.txt\n$/);

const symlink = path.join(state, "artifacts", "artifact-link.txt");
fs.symlinkSync(path.join(root, "outside"), symlink);
const deniedDigest = run(digestCommand.replace(received, symlink).replace(received, symlink));
assert.equal(deniedDigest.status, 126);
const missing = path.join(state, "artifacts", "artifact-missing.txt");
const deniedMissing = run(digestCommand.replace(received, missing).replace(received, missing));
assert.equal(deniedMissing.status, 126);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("HawkGrokSpan forced-command SSH gateway tests passed\n");
