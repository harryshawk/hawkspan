#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REAL_PAIR_CHECKS } from "./real-pair-acceptance-lib.mjs";
import { createRealHawkspanClient, createRealPairAdapter, validateFallbackEvidence } from "./hawkspan-real-pair-adapter.mjs";
import { createReleaseManifest, RELEASE_MANIFEST_PATH } from "./release-tree.mjs";

const fallbackEvidence = {
  schema_version: 1,
  kind: "hawkspan-owner-assisted-fallback",
  owner_confirmed: true,
  observations: [
    { phase: "baseline", primary_ready: true, fallback_ready: true, selected: "primary" },
    { phase: "interrupted", primary_ready: false, fallback_ready: true, selected: "fallback" },
    { phase: "restored", primary_ready: true, fallback_ready: true, selected: "primary" },
  ],
};
assert.equal(validateFallbackEvidence(fallbackEvidence), true);
assert.equal(validateFallbackEvidence({ ...fallbackEvidence, owner_confirmed: false }), false);
assert.equal(validateFallbackEvidence({ ...fallbackEvidence, observations: fallbackEvidence.observations.slice(0, 2) }), false);

const pluginManifest = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "examples/plugins/application-workflows/hawkspan-plugin.json"),
  "utf8",
));
const requiredAcceptancePeerTools = [
  "link_status", "receive_messages", "acknowledge_message",
  "register_artifact", "send_artifact", "receive_artifacts",
];
const workerPreset = pluginManifest.presets.find((preset) => preset.id === "headless-simpletuner-worker");
const controllerPreset = pluginManifest.presets.find((preset) => preset.id === "simpletuner-controller");
for (const tool of requiredAcceptancePeerTools) {
  assert.ok(workerPreset.settings.features.allowed_peer_tools.inbound.includes(tool), `worker inbound omits ${tool}`);
  assert.ok(controllerPreset.settings.features.allowed_peer_tools.outbound.includes(tool), `controller outbound omits ${tool}`);
}
assert.deepEqual(workerPreset.settings.features.allowed_peer_tools.outbound, []);
assert.deepEqual(workerPreset.settings.features.enable_broad_run_command, { inbound: false, outbound: false });
assert.deepEqual(controllerPreset.settings.features.enable_broad_run_command, { inbound: false, outbound: false });
const removedRestOperationIds = [
  "simpletuner_capabilities", "training_queue_snapshot", "training_start", "training_status",
  "training_events", "training_checkpoint_request", "training_checkpoints", "training_cancel",
  "training_artifacts", "training_return_artifact",
];
for (const operation of removedRestOperationIds) {
  assert.equal(pluginManifest.operations.some(({ name }) => name === operation), false, `REST operation remains: ${operation}`);
  assert.equal(workerPreset.settings.enabled_operations.includes(operation), false, `worker preset retains REST operation: ${operation}`);
  assert.equal(controllerPreset.settings.features.allowed_peer_tools.outbound.includes(`app_application_workflows_${operation}`), false);
}

const client = {
  async linkStatus() {
    return {
      routes: [
        { role: "primary", enabled: true, host: "fixture-primary", network_reachable: true, transport_ready: true },
        { role: "fallback", enabled: true, host: "fixture-fallback", network_reachable: true, transport_ready: true },
      ],
      selected_route: "fixture-primary",
    };
  },
  async fallbackEvidence() { return structuredClone(fallbackEvidence); },
  async listAndCallMcp() { return { tools: ["mcp_status", "link_status"], status: { online: true, service: "hawkspan" } }; },
  async messageAcknowledgementRoundTrip() { return { message_received: true, correlation_matched: true, acknowledged: true }; },
  async remoteJobLifecycle() { return ["created", "authorized", "running", "completed"]; },
  async artifactRoundTrip(fixtures) {
    assert.equal(fixtures.controller_to_worker, "fixture-a");
    assert.equal(fixtures.worker_to_controller, "fixture-b");
    return { controller_to_worker_match: true, worker_to_controller_match: true };
  },
  async asymmetry() { return { forward: { ok: true }, reverse: { denied: true } }; },
  async servicesAndHtml() { return { link: { online: true }, html: { ready: true, loopback_only: true } }; },
  async namespaceIsolation() { return { hawkspan_only: true, public_interfaces_only: true }; },
  async rollbackReadiness() {
    const release_id = `tree-sha256:${"a".repeat(64)}`;
    return { recorded_release_id: release_id, repository_release_id: release_id, record_mode_safe: true, state_preserved: true, restore_instructions: true };
  },
  async localTrainerInspection() {
    return {
      root_configured: true,
      process: { active: false, active_source: "none", processes: [], process_inspection_error: null },
      read_only: true,
    };
  },
};

const adapter = createRealPairAdapter(client);
assert.deepEqual(await adapter.preflight(), { ready: true });
for (const check of REAL_PAIR_CHECKS) {
  const context = check.id === "artifacts-bidirectional"
    ? { fixtures: { controller_to_worker: "fixture-a", worker_to_controller: "fixture-b" } }
    : {};
  const result = await adapter.runCheck(check.id, context);
  assert.deepEqual(Object.keys(result).sort(), [...check.assertions].sort(), check.id);
  assert.ok(Object.values(result).every((value) => value === true), `${check.id} did not pass`);
}

const invalidFallbackClient = { ...client, fallbackEvidence: async () => ({ owner_confirmed: true }) };
assert.deepEqual(await createRealPairAdapter(invalidFallbackClient).runCheck("owner-assisted-fallback"), {
  owner_confirmed: false, fallback_selected: false, primary_restored: false,
});
assert.deepEqual(await adapter.runCheck("simpletuner-live-preflight"), {
  local_trainer_root_configured: true,
  local_process_inspection_ready: true,
  training_state_unchanged: true,
});
const malformedLocalClient = {
  ...client,
  localTrainerInspection: async () => ({
    root_configured: true,
    process: { active: "false", active_source: "none", processes: [] },
    read_only: true,
  }),
};
assert.equal((await createRealPairAdapter(malformedLocalClient).runCheck("simpletuner-live-preflight")).local_process_inspection_ready, false);

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-archive-rollback-"));
  const repository = path.join(root, "archive");
  const state = path.join(root, "state");
  fs.mkdirSync(path.join(repository, "scripts"), { recursive: true });
  fs.mkdirSync(state);
  for (const name of ["call-tool.mjs", "mcp-server.mjs"]) {
    fs.writeFileSync(path.join(repository, "scripts", name), "// public fixture\n");
  }
  fs.writeFileSync(path.join(repository, "scripts", "uninstall-hawkspan.sh"), "# RESTORE\n");
  const manifest = createReleaseManifest(repository);
  fs.mkdirSync(path.join(repository, "release"));
  fs.writeFileSync(path.join(repository, RELEASE_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  const configuration = path.join(state, "config.json");
  fs.writeFileSync(configuration, "{}\n", { mode: 0o600 });
  const installed = path.join(state, "installed-revision.json");
  fs.writeFileSync(installed, `${JSON.stringify({ schema_version: 1, release_id: manifest.release_id })}\n`, { mode: 0o600 });
  try {
    const archiveClient = createRealHawkspanClient({
      HAWKSPAN_STATE_DIR: state,
      HAWKSPAN_REPOSITORY_DIR: repository,
      HAWKSPAN_CONFIG_PATH: configuration,
    });
    assert.deepEqual(await createRealPairAdapter(archiveClient).runCheck("rollback-readiness"), {
      revision_recorded: true,
      state_preserved: true,
      restore_instructions_ready: true,
    });
    fs.chmodSync(installed, 0o644);
    assert.equal((await createRealPairAdapter(archiveClient).runCheck("rollback-readiness")).revision_recorded, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

process.stdout.write("hawkspan public real-pair adapter tests passed\n");
