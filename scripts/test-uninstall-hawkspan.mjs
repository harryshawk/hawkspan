#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uninstaller = path.join(repository, "scripts", "uninstall-hawkspan.sh");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-uninstall-test-"));
const home = path.join(root, "home");
const state = path.join(home, ".hawkspan");
const launchAgents = path.join(home, "Library", "LaunchAgents");
const archive = path.join(home, ".hawkspan-uninstalled");
const launchctlLog = path.join(root, "launchctl.log");
const launchctlMock = path.join(root, "launchctl-mock");

fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(launchAgents, { recursive: true });
fs.writeFileSync(path.join(state, "config.json"), "{\"node_id\":\"test-node\"}\n");
fs.writeFileSync(path.join(state, "coordination.sqlite"), "test state\n");
for (const name of ["org.hawkspan.link-agent.plist", "org.hawkspan.local-control.plist"]) {
  fs.writeFileSync(path.join(launchAgents, name), `${name}\n`);
}
fs.writeFileSync(launchctlMock, `#!/bin/zsh\nprint -r -- "$*" >> ${JSON.stringify(launchctlLog)}\n`);
fs.chmodSync(launchctlMock, 0o700);

const environment = {
  ...process.env,
  HOME: home,
  HAWKSPAN_STATE_DIR: state,
  HAWKSPAN_UNINSTALL_ARCHIVE_DIR: archive,
  HAWKSPAN_LAUNCH_AGENTS_DIR: launchAgents,
  HAWKSPAN_LAUNCHCTL: launchctlMock,
  HAWKSPAN_UID: "501",
  HAWKSPAN_UNINSTALL_TIMESTAMP: "20260731T120000Z",
};
const run = (...args) => spawnSync("zsh", [uninstaller, ...args], {
  encoding: "utf8", env: environment,
});
const runWithEnvironment = (overrides, ...args) => spawnSync("zsh", [uninstaller, ...args], {
  encoding: "utf8", env: { ...environment, ...overrides },
});

try {
  const preview = run();
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /dry-run/);
  assert.match(preview.stdout, /No changes made/);
  assert.ok(fs.existsSync(path.join(state, "config.json")));
  assert.ok(fs.existsSync(path.join(launchAgents, "org.hawkspan.link-agent.plist")));
  assert.equal(fs.existsSync(launchctlLog), false);

  const badArgument = run("--force");
  assert.equal(badArgument.status, 2);
  assert.ok(fs.existsSync(state));

  for (const unsafeState of ["/", home]) {
    const unsafe = runWithEnvironment({ HAWKSPAN_STATE_DIR: unsafeState }, "--confirm");
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /refusing unsafe HawkSpan state path/);
  }

  const nestedArchive = runWithEnvironment({
    HAWKSPAN_UNINSTALL_ARCHIVE_DIR: path.join(state, "uninstall-archive"),
  }, "--confirm");
  assert.equal(nestedArchive.status, 1);
  assert.match(nestedArchive.stderr, /must be outside/);

  const realSymlinkTarget = path.join(root, "symlink-target");
  const symlinkState = path.join(root, "symlink-state");
  fs.mkdirSync(realSymlinkTarget);
  fs.symlinkSync(realSymlinkTarget, symlinkState);
  const symlinked = runWithEnvironment({ HAWKSPAN_STATE_DIR: symlinkState }, "--confirm");
  assert.equal(symlinked.status, 1);
  assert.match(symlinked.stderr, /symbolic-link/);

  const confirmed = run("--confirm");
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const destination = path.join(archive, "20260731T120000Z");
  assert.equal(fs.existsSync(state), false);
  assert.equal(fs.existsSync(path.join(launchAgents, "org.hawkspan.link-agent.plist")), false);
  assert.ok(fs.existsSync(path.join(destination, "state", "config.json")));
  assert.ok(fs.existsSync(path.join(destination, "state", "coordination.sqlite")));
  assert.ok(fs.existsSync(path.join(destination, "LaunchAgents", "org.hawkspan.link-agent.plist")));
  assert.ok(fs.existsSync(path.join(destination, "LaunchAgents", "org.hawkspan.local-control.plist")));
  assert.match(fs.readFileSync(path.join(destination, "RESTORE.txt"), "utf8"), /To restore state/);
  assert.deepEqual(fs.readFileSync(launchctlLog, "utf8").trim().split("\n"), [
    "bootout gui/501/org.hawkspan.link-agent",
    "bootout gui/501/org.hawkspan.local-control",
  ]);

  const repeated = run("--confirm");
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /archive destination already exists/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write("hawkspan recoverable uninstall tests passed\n");
