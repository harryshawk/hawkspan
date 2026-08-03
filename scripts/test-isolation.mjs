#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = fs.readFileSync(path.join(repository, "scripts/mcp-server.mjs"), "utf8");
const installer = fs.readFileSync(path.join(repository, "scripts/install-link-agent.sh"), "utf8");
const plist = fs.readFileSync(
  path.join(repository, "launchd/org.hawkspan.link-agent.plist.template"),
  "utf8",
);

assert.match(server, /"\.hawkspan"/);
assert.match(installer, /\.hawkspan/);
assert.match(plist, /org\.hawkspan\.link-agent/);
assert.doesNotMatch(plist, /(?<!hawkspan)\.link-agent/);
assert.equal(
  fs.readdirSync(path.join(repository, "scripts"))
    .filter((name) => name.startsWith("test-"))
    .some((name) => fs.readFileSync(path.join(repository, "scripts", name), "utf8")
      .includes(`/${"Users"}/`)),
  false,
);
process.stdout.write("hawkspan namespace and fixture-isolation tests passed\n");
