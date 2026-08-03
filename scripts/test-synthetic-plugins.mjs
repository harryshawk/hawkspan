#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repository, "scripts", "mcp-server.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-synthetic-test-"));

function startServer(name, roles, origin) {
  const stateRoot = path.join(root, name);
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "config.json"), `${JSON.stringify({
    schema_version: 1,
    node_id: name,
    application_plugins: {
      enabled: true,
      roles,
      roots: [path.join(repository, "examples", "plugins")],
      feature_flags: {},
      core_tool_allowlist: ["register_artifact"],
      entries: {
        "synthetic-draw": { core_tool_allowlist: ["register_artifact"] },
        "synthetic-render": { core_tool_allowlist: ["register_artifact"] },
      },
    },
    local_control: { enabled: false },
    peer: null,
  }, null, 2)}\n`);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      HAWKSPAN_STATE_DIR: stateRoot,
      HAWKSPAN_CALL_ORIGIN: origin,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  });
  const request = (method, params = {}) => new Promise((resolve) => {
    const id = ++sequence;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return {
    stateRoot,
    request,
    async initialize() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "synthetic-test", version: "1" },
      });
    },
    async tools() {
      return (await request("tools/list")).result.tools.map((tool) => tool.name);
    },
    async call(name, args) {
      return (await request("tools/call", {
        name,
        arguments: args,
      })).result;
    },
    async close() {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

let peerWorker;
let localWorker;
let peerController;
try {
  peerWorker = startServer("peer-worker", ["worker"], "peer");
  await peerWorker.initialize();
  const peerTools = await peerWorker.tools();
  assert.ok(peerTools.includes("app_synthetic_render_render"));
  assert.ok(peerTools.includes("app_synthetic_draw_draw"));

  const rendered = await peerWorker.call("app_synthetic_render_render", {
    title: "HawkSpan Synthetic Test",
    subtitle: "M2 controller to M4 worker",
    background: "#12345b",
  });
  assert.equal(rendered.isError, false, JSON.stringify(rendered));
  assert.equal(rendered.structuredContent.result.rendered, true);
  assert.equal(fs.existsSync(rendered.structuredContent.result.output), true);
  assert.match(
    fs.readFileSync(rendered.structuredContent.result.output, "utf8"),
    /HawkSpan Synthetic Test/,
  );
  assert.match(
    rendered.structuredContent.result.artifact.artifact_id,
    /^artifact-/,
  );

  const drawn = await peerWorker.call("app_synthetic_draw_draw", {
    shape: "circle",
    color: "#397eea",
    label: "SyntheticDraw via HawkSpan",
  });
  assert.equal(drawn.isError, false, JSON.stringify(drawn));
  assert.equal(drawn.structuredContent.result.drawn, true);
  assert.equal(fs.existsSync(drawn.structuredContent.result.output), true);
  assert.match(drawn.structuredContent.result.artifact.artifact_id, /^artifact-/);
  await peerWorker.close();
  peerWorker = null;

  localWorker = startServer("local-worker", ["worker"], "local");
  await localWorker.initialize();
  assert.equal(
    (await localWorker.call("app_synthetic_render_render", {
      title: "must be denied",
    })).isError,
    true,
  );
  await localWorker.close();
  localWorker = null;

  peerController = startServer("peer-controller", ["controller"], "peer");
  await peerController.initialize();
  const controllerTools = await peerController.tools();
  assert.equal(controllerTools.includes("app_synthetic_render_render"), true);
  assert.equal(
    (await peerController.call("app_synthetic_render_render", {
      title: "must be denied",
    })).isError,
    true,
  );
  assert.equal(
    (await peerController.call("app_synthetic_draw_draw", {
      shape: "square",
      color: "#397eea",
    })).isError,
    true,
  );
  await peerController.close();
  peerController = null;

  process.stdout.write("hawkspan SyntheticRender/SyntheticDraw plugin test passed\n");
} finally {
  if (peerWorker) await peerWorker.close();
  if (localWorker) await localWorker.close();
  if (peerController) await peerController.close();
  fs.rmSync(root, { recursive: true, force: true });
}
