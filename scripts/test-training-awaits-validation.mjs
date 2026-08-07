#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "training-awaits-validation-"));
const install = path.join(root, "simpletuner");
const queue = path.join(root, "queue");
const configDir = path.join(queue, "configs", "r-awaiting");
const dataDir = path.join(queue, "datasets", "r-awaiting");
const outputDir = path.join(queue, "outputs", "r-awaiting");
const returnRoot = path.join(queue, "return-packets");
const schedulerRoot = path.join(root, "state", "lora-scheduler");
const schedulerState = path.join(schedulerRoot, "lora-scheduler-state.json");
const configPath = path.join(root, "state", "config.json");
for (const directory of [
  path.join(install, ".venv", "bin"), configDir, dataDir, outputDir,
  returnRoot, schedulerRoot, path.dirname(configPath),
]) fs.mkdirSync(directory, { recursive: true });

const target = "r-awaiting";
const fingerprint = "a".repeat(64);
const final = path.join(outputDir, "pytorch_lora_weights.safetensors");
const fakeSimpleTuner = path.join(install, ".venv", "bin", "simpletuner");
fs.writeFileSync(fakeSimpleTuner, `#!/bin/sh
printf 'Step 1/1 loss=0.1\\n'
/bin/dd if=/dev/zero of=${JSON.stringify(final)} bs=1048576 count=2 2>/dev/null
`, { mode: 0o755 });

const fakePython = path.join(install, ".venv", "bin", "python");
fs.writeFileSync(fakePython, `#!/bin/sh
case "$1" in
  *validate_safetensors_adapter.py.managed) exit 0 ;;
esac
exec /usr/bin/python3 "$@"
`, { mode: 0o755 });

const fakeBuilder = path.join(root, "fake-builder.py");
fs.writeFileSync(fakeBuilder, `#!/usr/bin/env python3
import argparse, hashlib, json
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--spec', type=Path, required=True)
p.add_argument('--output-root', type=Path, required=True)
p.add_argument('--ledger', type=Path, required=True)
p.add_argument('--python-bin')
a = p.parse_args()
spec = json.loads(a.spec.read_text())[0]
variant = spec['packet_variant']
a.output_root.mkdir(parents=True, exist_ok=True)
packet = a.output_root / f"{spec['run_name']}__test__2026-08-06__{variant}__M4-return-packet.zip"
packet.write_bytes(b'training packet')
digest = hashlib.sha256(packet.read_bytes()).hexdigest()
record = {'packet_path': str(packet), 'packet_sha256': digest, 'packet_variant': variant}
a.ledger.write_text(json.dumps({'packets': [record]}) + '\\n')
Path(spec['packet_result_path']).write_text(json.dumps(record) + '\\n')
print(f"PACKAGED {spec['run_name']} {packet}")
`, { mode: 0o755 });

const fakeNode = path.join(root, "fake-node.mjs");
fs.writeFileSync(fakeNode, `#!${process.execPath}
import crypto from "node:crypto";
import fs from "node:fs";
const args = process.argv.slice(2);
const invoked = args[0] || "";
if (invoked.endsWith("lora-automation.mjs")) {
  process.stdout.write(JSON.stringify({ ready: true, revision_fingerprint: process.env.TEST_FINGERPRINT }) + "\\n");
} else if (invoked.endsWith("automatic-package-return.mjs")) {
  const packet = args[args.indexOf("--packet") + 1];
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(packet)).digest("hex");
  process.stdout.write(JSON.stringify({ checked: 1, results: [{
    ok: true, state: "receipt-confirmed", sha256, artifact_id: "artifact-training-test",
  }] }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ isError: false, structuredContent: {} }) + "\\n");
}
`, { mode: 0o755 });

const manifest = path.join(queue, "captioned-lora-manifest.json");
fs.writeFileSync(manifest, `${JSON.stringify([{
  job_id: target,
  index: 1,
  source: "robot-source",
  config_dir: configDir,
  data_dir: dataDir,
  output_dir: outputDir,
  trigger: "hawkspan robots",
  image_count: 1,
}], null, 2)}\n`);
fs.writeFileSync(schedulerState, `${JSON.stringify({
  schema_version: 1,
  current: target,
  jobs: { "queue-r-awaiting": { state: "running", phase: "training", target } },
}, null, 2)}\n`);
fs.writeFileSync(configPath, `${JSON.stringify({
  lora_automation: {
    scheduler_root: schedulerRoot,
    scheduler_state_path: schedulerState,
  },
}, null, 2)}\n`);

const result = spawnSync("/usr/bin/python3", [
  path.join(scripts, "run_captioned_loras.py.managed"),
  "--only-job", target,
  "--mode", "train-and-return",
], {
  cwd: queue,
  encoding: "utf8",
  env: {
    ...process.env,
    HAWKSPAN_SIMPLETUNER_ROOT: install,
    HAWKSPAN_LORA_QUEUE_ROOT: queue,
    HAWKSPAN_LORA_MANIFEST: manifest,
    HAWKSPAN_LORA_RETURN_ROOT: returnRoot,
    HAWKSPAN_LORA_LEDGER_PATH: path.join(queue, "return-packet-log.json"),
    HAWKSPAN_LORA_PACKET_BUILDER: fakeBuilder,
    HAWKSPAN_RUNTIME_NODE_PATH: fakeNode,
    HAWKSPAN_LORA_AUTOMATION: path.join(scripts, "lora-automation.mjs"),
    HAWKSPAN_AUTHORIZED_TRAINING_JOB_ID: target,
    HAWKSPAN_AUTHORIZED_REVISION_FINGERPRINT: fingerprint,
    HAWKSPAN_DURABLE_TRAINING_JOB_ID: "durable-r-awaiting",
    HAWKSPAN_SIMPLETUNER_QUEUE_ITEM_ID: "queue-r-awaiting",
    HAWKSPAN_MAX_TRAIN_ATTEMPTS: "1",
    HAWKSPAN_CONFIG: configPath,
    TEST_FINGERPRINT: fingerprint,
    PYTHONDONTWRITEBYTECODE: "1",
  },
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /AWAITING VALIDATION r-awaiting/);
assert.doesNotMatch(result.stdout, /COMPLETE r-awaiting/);
const spec = JSON.parse(fs.readFileSync(path.join(queue, `${target}-return-spec.json`)))[0];
assert.equal(spec.require_validation_samples, false);
assert.equal(spec.packet_variant, "training");
const status = JSON.parse(fs.readFileSync(path.join(queue, "captioned-lora-status.json")));
assert.equal(status.completed.length, 0);
assert.equal(status.returning.length, 1);
assert.equal(status.returning[0].packet_variant, "training");
const scheduler = JSON.parse(fs.readFileSync(schedulerState));
assert.equal(scheduler.jobs["queue-r-awaiting"].state, "returning");
assert.equal(scheduler.jobs["queue-r-awaiting"].phase, "awaiting-validation");
assert.equal(scheduler.jobs["queue-r-awaiting"].terminal, false);
assert.equal(scheduler.current, null);
const packets = fs.readdirSync(returnRoot);
assert.equal(packets.length, 1);
assert.match(packets[0], /__training__M4-return-packet\.zip$/);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("training awaits validation test passed\n");
