#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  REAL_PAIR_CHECKS,
  parseMachineEnvironment,
  validateReceipt,
} from "./real-pair-acceptance-lib.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(repository, "scripts", "real-pair-acceptance.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-real-pair-test-"));
const imported = path.join(root, "adapter-imported");
const receiptPath = path.join(root, "receipt.json");
const environmentPath = path.join(root, "hawkspan.env");
const secretFragments = [
  path.join(path.sep, "machine-specific-home", "sensitive-value"),
  "MACHINE_SPECIFIC_HOST_CANARY",
  "MACHINE_SPECIFIC_ADDRESS_CANARY",
  "MACHINE_SPECIFIC_TASK_CANARY",
  "MACHINE_SPECIFIC_MESSAGE_CANARY",
  "MACHINE_SPECIFIC_COMMAND_CANARY",
];

const assertions = Object.fromEntries(REAL_PAIR_CHECKS.map((check) => [
  check.id,
  Object.fromEntries(check.assertions.map((name) => [name, true])),
]));

fs.writeFileSync(environmentPath, [
  `HAWKSPAN_STATE_DIR=${secretFragments[0]}`,
  `HAWKSPAN_PEER_PRIMARY_HOST=${secretFragments[1]}`,
  `HAWKSPAN_PEER_FALLBACK_HOST=${secretFragments[2]}`,
  "",
].join("\n"), { mode: 0o600 });
assert.equal(parseMachineEnvironment(environmentPath).HAWKSPAN_STATE_DIR, secretFragments[0]);

const adapter = path.join(root, "fake-adapter.mjs");
fs.writeFileSync(adapter, `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(imported)}, "yes");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const assertions = ${JSON.stringify(assertions)};
if (process.env.HAWKSPAN_PARENT_SECRET_CANARY !== undefined) process.exit(9);
if (request.operation === "preflight") {
  process.stdout.write(JSON.stringify({ ready: Boolean(request.config.HAWKSPAN_STATE_DIR), ignored_machine_value: request.config.HAWKSPAN_STATE_DIR }));
} else {
  const id = request.check_id;
  if (id === "artifacts-bidirectional" &&
      (!request.context.fixtures.controller_to_worker || !request.context.fixtures.worker_to_controller)) process.exit(8);
  process.stdout.write(JSON.stringify({ ...assertions[id], ignored_machine_values: Object.values(request.config) }));
}
`);

try {
  const plan = spawnSync(process.execPath, [runner], { encoding: "utf8" });
  assert.equal(plan.status, 0);
  assert.equal(fs.existsSync(imported), false, "default preflight imported an adapter");
  const parsedPlan = JSON.parse(plan.stdout);
  assert.equal(parsedPlan.mode, "preflight");
  assert.equal(parsedPlan.safety.runtime_accessed, false);
  assert.equal(parsedPlan.safety.network_accessed, false);

  const unauthorized = spawnSync(process.execPath, [runner, "--execute", "--adapter", adapter, "--receipt", receiptPath, "--env-file", environmentPath], {
    encoding: "utf8",
  });
  assert.equal(unauthorized.status, 2);
  assert.equal(fs.existsSync(imported), false, "unauthorized execution imported an adapter");
  assert.equal(fs.existsSync(receiptPath), false);

  const authorized = spawnSync(process.execPath, [runner, "--execute", "--adapter", adapter, "--receipt", receiptPath, "--env-file", environmentPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HAWKSPAN_REAL_PAIR_AUTHORIZED: "YES",
      HAWKSPAN_PARENT_SECRET_CANARY: "must-not-reach-adapter",
    },
  });
  assert.equal(authorized.status, 0, authorized.stderr);
  const receiptText = fs.readFileSync(receiptPath, "utf8");
  const receipt = JSON.parse(receiptText);
  assert.equal(validateReceipt(receipt), true);
  assert.equal(receipt.overall, "passed");
  assert.equal(receipt.checks.length, REAL_PAIR_CHECKS.length);
  const duplicateReceipt = structuredClone(receipt);
  duplicateReceipt.checks[1] = structuredClone(duplicateReceipt.checks[0]);
  assert.equal(validateReceipt(duplicateReceipt), false);
  const inconsistentReceipt = structuredClone(receipt);
  inconsistentReceipt.checks[0].status = "failed";
  assert.equal(validateReceipt(inconsistentReceipt), false);
  for (const fragment of secretFragments) {
    assert.doesNotMatch(receiptText, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(`${authorized.stdout}\n${authorized.stderr}`, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const failingAdapter = path.join(root, "failing-adapter.mjs");
  const failingReceipt = path.join(root, "failing-receipt.json");
  fs.writeFileSync(failingAdapter, `let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.operation === "preflight") process.stdout.write(JSON.stringify({ ready: true }));
else throw new Error(${JSON.stringify(secretFragments.join(" "))});\n`);
  const failed = spawnSync(process.execPath, [runner, "--execute", "--adapter", failingAdapter, "--receipt", failingReceipt, "--env-file", environmentPath], {
    encoding: "utf8",
    env: { ...process.env, HAWKSPAN_REAL_PAIR_AUTHORIZED: "YES" },
  });
  assert.equal(failed.status, 1);
  const failedText = fs.readFileSync(failingReceipt, "utf8");
  assert.equal(validateReceipt(JSON.parse(failedText)), true);
  assert.match(failedText, /adapter-error/);
  for (const fragment of secretFragments) assert.doesNotMatch(`${failedText}\n${failed.stdout}\n${failed.stderr}`, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const [name, content, mode = 0o600] of [
    ["unknown", "UNKNOWN_KEY=value\n"],
    ["duplicate", "HAWKSPAN_STATE_DIR=one\nHAWKSPAN_STATE_DIR=two\n"],
    ["relative", "HAWKSPAN_STATE_DIR=relative/path\n"],
    ["permissions", "HAWKSPAN_STATE_DIR=value\n", 0o644],
  ]) {
    const invalid = path.join(root, `${name}.env`);
    fs.writeFileSync(invalid, content, { mode });
    assert.throws(() => parseMachineEnvironment(invalid));
  }
  for (const content of [
    'HAWKSPAN_STATE_DIR="/tmp/${HOME};whoami"\n',
    "HAWKSPAN_STATE_DIR='/tmp/path with spaces'\n",
  ]) {
    const literal = path.join(root, `literal-${Math.random()}.env`);
    fs.writeFileSync(literal, content, { mode: 0o600 });
    assert.match(parseMachineEnvironment(literal).HAWKSPAN_STATE_DIR, /^\/tmp\//);
  }
  const link = path.join(root, "linked.env");
  fs.symlinkSync(environmentPath, link);
  assert.throws(() => parseMachineEnvironment(link));

  process.stdout.write("hawkspan real-pair acceptance harness tests passed\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
