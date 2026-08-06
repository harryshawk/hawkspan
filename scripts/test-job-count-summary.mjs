#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-job-counts-"));
const configPath = path.join(testRoot, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ node_id: "test-hawkspan", peer: null, local_control: { enabled: false } }));

function call(tool, args = {}) {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "call-tool.mjs"),
    tool,
    JSON.stringify(args),
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HAWKSPAN_STATE_DIR: testRoot,
      HAWKSPAN_CONFIG: configPath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).structuredContent;
}

call("link_status");
const db = new DatabaseSync(path.join(testRoot, "spool.sqlite3"));
const now = new Date().toISOString();
const insert = db.prepare(`
  INSERT INTO jobs
    (id,created_at,updated_at,creator,assignee,kind,title,description,state,
     authorization_state,authorization_evidence,metadata_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`);
for (const [id, state] of [
  ["running", "running"],
  ["started", "started"],
  ["queued", "queued"],
  ["authorized", "authorized"],
  ["paused", "paused"],
  ["completed", "completed"],
  ["failed", "failed"],
]) {
  insert.run(id, now, now, "test", "test", "training", id, "", state, "recorded", "test", "{}");
}

const status = call("link_status");
assert.equal(status.counts.active_jobs, 2);
assert.equal(status.counts.pending_jobs, 2);
assert.equal(status.counts.paused_jobs, 1);
assert.equal(status.counts.completed_jobs, 2);
process.stdout.write("job count summary tests passed\n");
