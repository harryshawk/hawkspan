#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "failed-training-no-return-"));
const install = path.join(root, "simpletuner");
const queue = path.join(root, "queue");
const output = path.join(root, "output");
const configDir = path.join(root, "config");
fs.mkdirSync(path.join(install, ".venv", "bin"), { recursive: true });
fs.mkdirSync(queue, { recursive: true });
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
const trainer = path.join(install, ".venv", "bin", "simpletuner");
fs.writeFileSync(trainer, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
const fakeNode = path.join(root, "node");
const durableCallLog = path.join(root, "durable-calls.log");
fs.writeFileSync(fakeNode, `#!/bin/sh
printf '%s\\n' "$*" >> "$DURABLE_CALL_LOG"
case "$1" in
  *call-tool.mjs) exit 0 ;;
esac
printf '{"ready":true,"revision_fingerprint":"revision-test"}\\n'
`, { mode: 0o755 });
const target = "failed-test";
fs.writeFileSync(path.join(queue, "captioned-lora-manifest.json"), `${JSON.stringify([{
  job_id: target,
  index: 1,
  source: "test/source",
  config_dir: configDir,
  data_dir: path.join(root, "data"),
  output_dir: output,
  trigger: "test trigger",
  image_count: 1,
}])}\n`);

const statusPath = path.join(root, "status.json");
const result = spawnSync("python3", [
  path.join(scripts, "run_captioned_loras.py.managed"),
  "--only-job", target,
  "--mode", "train-and-return",
  "--status-file", statusPath,
], {
  encoding: "utf8",
  env: {
    ...process.env,
    HAWKSPAN_AUTHORIZED_TRAINING_JOB_ID: target,
    HAWKSPAN_DURABLE_TRAINING_JOB_ID: "durable-failed-test",
    HAWKSPAN_AUTHORIZED_REVISION_FINGERPRINT: "revision-test",
    HAWKSPAN_MAX_TRAIN_ATTEMPTS: "1",
    HAWKSPAN_SIMPLETUNER_ROOT: install,
    HAWKSPAN_LORA_QUEUE_ROOT: queue,
    HAWKSPAN_LORA_OUTPUT_ROOT: output,
    HAWKSPAN_LORA_RETURN_ROOT: path.join(root, "returns"),
    HAWKSPAN_LORA_LEDGER_PATH: path.join(root, "ledger.json"),
    HAWKSPAN_RUNTIME_NODE_PATH: fakeNode,
    HAWKSPAN_LORA_AUTOMATION: path.join(root, "unused-automation.mjs"),
    DURABLE_CALL_LOG: durableCallLog,
    HAWKSPAN_STATE_DIR: path.join(root, "state"),
  },
});
assert.notEqual(result.status, 0);
assert.match(result.stderr, /FAILED failed-test returncode=7/);
const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
assert.equal(status.failed[0].job_id, target);
const durableCalls = fs.readFileSync(durableCallLog, "utf8");
assert.match(durableCalls, /call-tool\.mjs update_job_status/);
assert.match(durableCalls, /"job_id":\s*"durable-failed-test"/);
assert.match(durableCalls, /"state":\s*"failed"/);
assert.equal(fs.existsSync(path.join(root, "ledger.json")), false);
assert.equal(fs.existsSync(path.join(root, "state", "automatic-package-returns")), false);

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("failed training produces no package return\n");
