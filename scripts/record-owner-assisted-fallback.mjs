#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMachineEnvironment } from "./real-pair-acceptance-lib.mjs";
import { createRealHawkspanClient, validateFallbackEvidence } from "./hawkspan-real-pair-adapter.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const phase = value("--phase");
const target = value("--evidence");
const envFile = value("--env-file") || path.join(os.homedir(), ".hawkspan", "hawkspan.env");
const phases = ["baseline", "interrupted", "restored"];

function fail() {
  process.stderr.write("usage: record-owner-assisted-fallback.mjs --phase baseline|interrupted|restored --evidence FILE [--env-file FILE]\n");
  process.exit(2);
}
if (!phases.includes(phase) || !target || !path.isAbsolute(target)) fail();

try {
  const config = parseMachineEnvironment(path.resolve(envFile));
  const status = await createRealHawkspanClient(config).linkStatus();
  const route = (role) => status.routes?.find((item) => item?.role === role);
  const ready = (item) => item?.enabled === true && item.network_reachable === true && item.transport_ready === true;
  const primary = route("primary"), fallback = route("fallback");
  const selected = status.selected_route === primary?.host ? "primary" :
    status.selected_route === fallback?.host ? "fallback" : "none";
  const observation = {
    phase, primary_ready: ready(primary), fallback_ready: ready(fallback), selected,
  };
  const expectedIndex = phases.indexOf(phase);
  let document = {
    schema_version: 1, kind: "hawkspan-owner-assisted-fallback",
    owner_confirmed: false, observations: [],
  };
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || ![0o400, 0o600].includes(stat.mode & 0o777) ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("invalid evidence file");
    document = JSON.parse(fs.readFileSync(target, "utf8"));
  }
  if (!Array.isArray(document.observations) || document.observations.length !== expectedIndex) {
    throw new Error("phases must be recorded once and in order");
  }
  document.observations.push(observation);
  document.owner_confirmed = phase === "restored";
  if (phase === "restored" && !validateFallbackEvidence(document)) throw new Error("observed route sequence did not prove fallback");
  const temporary = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
  process.stdout.write(`recorded owner-assisted fallback phase: ${phase}\n`);
} catch {
  process.stderr.write("fallback evidence was not recorded; details were suppressed\n");
  process.exit(1);
}
