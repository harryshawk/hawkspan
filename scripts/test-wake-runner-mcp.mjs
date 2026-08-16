#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-wake-runner-mcp-"));
const audit = path.join(root, "audit");
const inbox = path.join(root, "inbox");
const messageId = "message-runner-mcp";
const fakeCodex = path.join(root, "fake-codex.mjs");
fs.mkdirSync(audit, { recursive: true });
fs.mkdirSync(inbox, { recursive: true });
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  schema_version: 1,
  node_id: "runner-mcp-test",
  peer: null,
}));
fs.writeFileSync(path.join(inbox, `${messageId}.json`), `${JSON.stringify({
  schema_version: 1,
  id: messageId,
  created_at: "2026-08-16T00:00:00.000Z",
  sender: "test-peer",
  recipient: "runner-mcp-test",
  kind: "message",
  subject: "runner MCP integration",
  body: "accept this message",
  correlation_id: null,
  wake_requested: true,
  metadata: {},
}, null, 2)}\n`);
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(output, JSON.stringify({
  message_id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
  status: "accepted",
}));
`, { mode: 0o755 });

const wakeRequest = {
  schema_version: 1,
  wake_id: "wake-runner-mcp",
  message_id: messageId,
  thread_id: "thread-runner-mcp",
  prompt: "accept the imported message",
  codex_command: fakeCodex,
  node_command: process.execPath,
  call_tool_path: path.join(scripts, "call-tool.mjs"),
  audit_dir: audit,
  log_path: path.join(audit, "wake-runner-mcp.log"),
  lease_path: path.join(audit, "wake-thread-runner-mcp.lock"),
  result_path: path.join(audit, "wake-runner-mcp.result.json"),
  timeout_ms: 2000,
  termination_grace_ms: 100,
};
const launch = spawnSync(
  process.execPath,
  [
    path.join(scripts, "wake-runner.mjs"),
    "launch",
    Buffer.from(JSON.stringify(wakeRequest)).toString("base64"),
  ],
  {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      HAWKSPAN_STATE_DIR: root,
      HAWKSPAN_CONFIG: path.join(root, "config.json"),
      HAWKSPAN_TEST_MESSAGE_ID: messageId,
    },
  },
);
assert.equal(launch.status, 0, launch.stderr);
assert.equal(JSON.parse(launch.stdout).status, "started");

const deadline = Date.now() + 10000;
while (!fs.existsSync(wakeRequest.result_path) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
assert(fs.existsSync(wakeRequest.result_path), "runner result must be written");
const result = JSON.parse(fs.readFileSync(wakeRequest.result_path, "utf8"));
assert.equal(result.status, "acknowledged");
assert.equal(result.acknowledged, true);
assert.equal(result.lease_released, true);
assert.equal(fs.existsSync(wakeRequest.lease_path), false);

const db = new DatabaseSync(path.join(root, "spool.sqlite3"));
const inbound = db.prepare("SELECT state,acknowledged_at FROM messages WHERE id=?").get(messageId);
assert.equal(inbound.state, "acknowledged");
assert(inbound.acknowledged_at);
const acknowledgement = db.prepare(`
  SELECT kind,correlation_id,wake_requested FROM messages
  WHERE direction='outbound' AND correlation_id=?
`).get(messageId);
assert.equal(acknowledgement.kind, "acknowledgement");
assert.equal(acknowledgement.correlation_id, messageId);
assert.equal(acknowledgement.wake_requested, 1);
db.close();

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("wake-runner real MCP acknowledgement test passed\n");
