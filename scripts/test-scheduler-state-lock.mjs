#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mutateSchedulerState } from "./scheduler-state.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-state-lock-"));
const statePath = path.join(root, "lora-scheduler-state.json");
const nodeWorker = path.join(root, "node-worker.mjs");
const pythonWorker = path.join(root, "python-worker.py");
const lockHolder = path.join(root, "lock-holder.mjs");
const iterations = 75;

fs.writeFileSync(nodeWorker, `
import { mutateSchedulerState } from ${JSON.stringify(pathToFileURL(path.join(scripts, "scheduler-state.mjs")).href)};
const [statePath, worker, rawIterations] = process.argv.slice(2);
for (let index = 0; index < Number(rawIterations); index += 1) {
  mutateSchedulerState(statePath, { schema_version: 1, counter: 0, writers: {} }, (state) => {
    state.counter = Number(state.counter || 0) + 1;
    state.writers[worker] = Number(state.writers[worker] || 0) + 1;
  });
}
`);
fs.writeFileSync(pythonWorker, `
import pathlib
import sys
sys.path.insert(0, ${JSON.stringify(scripts)})
from hawkspan_scheduler_state import edit_scheduler_state

state_path, worker, iterations = sys.argv[1], sys.argv[2], int(sys.argv[3])
for _ in range(iterations):
    with edit_scheduler_state(pathlib.Path(state_path), {"schema_version": 1, "counter": 0, "writers": {}}) as state:
        state["counter"] = int(state.get("counter", 0)) + 1
        writers = state.setdefault("writers", {})
        writers[worker] = int(writers.get(worker, 0)) + 1
`);
fs.writeFileSync(lockHolder, `
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2] + ".lock.sqlite3");
database.exec("CREATE TABLE IF NOT EXISTS lock_identity (id INTEGER PRIMARY KEY CHECK (id = 1))");
database.exec("BEGIN IMMEDIATE");
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        HAWKSPAN_SIMPLETUNER_STATE_LOCK_WAIT_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

await Promise.all([
  run(process.execPath, [nodeWorker, statePath, "node-a", String(iterations)]),
  run(process.execPath, [nodeWorker, statePath, "node-b", String(iterations)]),
  run("/usr/bin/python3", [pythonWorker, statePath, "python-a", String(iterations)]),
  run("/usr/bin/python3", [pythonWorker, statePath, "python-b", String(iterations)]),
]);

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert.equal(state.counter, iterations * 4);
assert.deepEqual(state.writers, {
  "node-a": iterations,
  "node-b": iterations,
  "python-a": iterations,
  "python-b": iterations,
});
assert.equal(fs.existsSync(`${statePath}.lock.sqlite3`), true);
assert.equal(
  fs.readdirSync(root).some((name) => name.includes(".tmp")),
  false,
  "no temporary state files may remain after concurrent mutation",
);

process.env.HAWKSPAN_SIMPLETUNER_STATE_LOCK_WAIT_MS = "1000";
const holder = spawn(process.execPath, [lockHolder, statePath], {
  stdio: ["ignore", "pipe", "inherit"],
});
await once(holder.stdout, "data");
holder.kill("SIGKILL");
await once(holder, "exit");
mutateSchedulerState(statePath, {}, (current) => {
  current.recovered_after_process_crash = true;
});
assert.equal(
  JSON.parse(fs.readFileSync(statePath, "utf8")).recovered_after_process_crash,
  true,
);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("cross-process scheduler state lock tests passed\n");
