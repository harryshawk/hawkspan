#!/usr/bin/env node

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  acceptancePlan,
  executeAcceptance,
  parseMachineEnvironment,
  validateReceipt,
  writeReceipt,
} from "./real-pair-acceptance-lib.mjs";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const adapterIndex = args.indexOf("--adapter");
const receiptIndex = args.indexOf("--receipt");
const environmentIndex = args.indexOf("--env-file");

function usageFailure(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write("usage: real-pair-acceptance.mjs [--plan] | --execute --adapter MODULE --receipt NEW_FILE [--env-file FILE]\n");
  process.exit(2);
}

if (!execute) {
  process.stdout.write(`${JSON.stringify(acceptancePlan(), null, 2)}\n`);
  process.exit(0);
}

if (process.env.HAWKSPAN_REAL_PAIR_AUTHORIZED !== "YES") {
  usageFailure("real-pair execution requires HAWKSPAN_REAL_PAIR_AUTHORIZED=YES");
}
if (adapterIndex < 0 || !args[adapterIndex + 1]) usageFailure("real-pair execution requires --adapter");
if (receiptIndex < 0 || !args[receiptIndex + 1]) usageFailure("real-pair execution requires --receipt");

const adapterPath = path.resolve(args[adapterIndex + 1]);
const environmentPath = environmentIndex >= 0 && args[environmentIndex + 1]
  ? path.resolve(args[environmentIndex + 1])
  : path.join(os.homedir(), ".hawkspan", "hawkspan.env");
let machineConfig;
try {
  const adapterStat = fs.lstatSync(adapterPath);
  if (adapterStat.isSymbolicLink() || !adapterStat.isFile()) throw new Error("invalid adapter");
  machineConfig = parseMachineEnvironment(environmentPath);
} catch {
  process.stderr.write("real-pair adapter or machine environment was rejected; details were suppressed\n");
  process.exit(1);
}

function callAdapter(operation, payload = {}) {
  const child = spawnSync(process.execPath, [adapterPath], {
    input: `${JSON.stringify({ operation, config: machineConfig, ...payload })}\n`,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 1024 * 1024,
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
    },
  });
  if (child.status !== 0 || child.error) throw new Error("adapter failed");
  return JSON.parse(child.stdout);
}

const adapter = {
  preflight: () => callAdapter("preflight"),
  runCheck: (checkId, context) => callAdapter("run-check", { check_id: checkId, context }),
};

const receipt = await executeAcceptance(adapter);
if (!validateReceipt(receipt)) {
  process.stderr.write("real-pair result did not match the public receipt schema\n");
  process.exit(1);
}

try {
  writeReceipt(path.resolve(args[receiptIndex + 1]), receipt);
} catch {
  process.stderr.write("real-pair receipt could not be written; target details were suppressed\n");
  process.exit(1);
}

process.stdout.write(`hawkspan real-pair acceptance ${receipt.overall}; privacy-safe receipt written\n`);
if (receipt.overall !== "passed") process.exitCode = 1;
