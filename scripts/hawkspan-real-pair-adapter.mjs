#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyReleaseTree } from "./release-tree.mjs";

const FIXED_ENV = Object.freeze({
  LANG: "C", LC_ALL: "C",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
});

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bool(value) { return value === true; }
function structured(output) {
  if (!object(output) || output.isError === true || !object(output.structuredContent)) {
    throw new Error("HawkSpan tool failed");
  }
  return output.structuredContent;
}
function route(status, role) {
  return status.routes?.find((item) => item?.role === role) || null;
}
function routePassed(item) {
  return item?.enabled === false ||
    (item?.enabled === true && item.network_reachable === true && item.transport_ready === true);
}
function selectedRole(status, role) {
  const item = route(status, role);
  return Boolean(item?.enabled && item.transport_ready && status.selected_route === item.host);
}
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function validateFallbackEvidence(value) {
  if (!exactKeys(value, ["schema_version", "kind", "owner_confirmed", "observations"]) ||
      value.schema_version !== 1 || value.kind !== "hawkspan-owner-assisted-fallback" ||
      value.owner_confirmed !== true || !Array.isArray(value.observations) ||
      value.observations.length !== 3) return false;
  const expected = [
    ["baseline", true, true, "primary"],
    ["interrupted", false, true, "fallback"],
    ["restored", true, true, "primary"],
  ];
  return value.observations.every((item, index) => {
    const [phase, primary, fallback, selected] = expected[index];
    return exactKeys(item, ["phase", "primary_ready", "fallback_ready", "selected"]) &&
      item.phase === phase && item.primary_ready === primary &&
      item.fallback_ready === fallback && item.selected === selected;
  });
}

export function createRealPairAdapter(client) {
  if (!client || typeof client.linkStatus !== "function") throw new TypeError("client is required");
  return Object.freeze({
    async preflight() {
      const status = await client.linkStatus();
      return { ready: object(status) && Array.isArray(status.routes) };
    },
    async runCheck(checkId, context = {}) {
      switch (checkId) {
        case "routes-independent": {
          const status = await client.linkStatus();
          return {
            primary_route_passed: routePassed(route(status, "primary")),
            fallback_route_passed: routePassed(route(status, "fallback")),
          };
        }
        case "primary-preference": {
          const status = await client.linkStatus();
          return { primary_selected: selectedRole(status, "primary") };
        }
        case "owner-assisted-fallback": {
          const evidence = await client.fallbackEvidence();
          const valid = validateFallbackEvidence(evidence);
          return { owner_confirmed: valid, fallback_selected: valid, primary_restored: valid };
        }
        case "mcp-list-call": {
          const observed = await client.listAndCallMcp();
          return {
            tools_listed: Array.isArray(observed.tools) && observed.tools.includes("mcp_status"),
            harmless_call_passed: observed.status?.online === true && observed.status?.service === "hawkspan",
          };
        }
        case "message-receive-ack": {
          const observed = await client.messageAcknowledgementRoundTrip();
          return {
            message_received: bool(observed.message_received),
            correlation_matched: bool(observed.correlation_matched),
            acknowledged: bool(observed.acknowledged),
          };
        }
        case "remote-job-lifecycle": {
          const states = await client.remoteJobLifecycle();
          return Object.fromEntries(["created", "authorized", "running", "completed"]
            .map((state) => [state, states.includes(state)]));
        }
        case "artifacts-bidirectional": {
          const observed = await client.artifactRoundTrip(context.fixtures || {});
          return {
            controller_to_worker_match: bool(observed.controller_to_worker_match),
            worker_to_controller_match: bool(observed.worker_to_controller_match),
          };
        }
        case "asymmetric-controller-worker": {
          const observed = await client.asymmetry();
          return {
            controller_to_worker_allowed: observed.forward?.ok === true,
            worker_to_controller_denied: observed.reverse?.denied === true,
          };
        }
        case "installed-services-html": {
          const observed = await client.servicesAndHtml();
          return {
            link_service_ready: observed.link?.online === true,
            html_service_ready: observed.html?.ready === true,
            html_loopback_only: observed.html?.loopback_only === true,
          };
        }
        case "coexistence-namespace": {
          const observed = await client.namespaceIsolation();
          return {
            hawkspan_namespace_only: observed.hawkspan_only === true,
            other_products_untouched: observed.public_interfaces_only === true,
          };
        }
        case "rollback-readiness": {
          const observed = await client.rollbackReadiness();
          return {
            revision_recorded: observed.recorded_release_id === observed.repository_release_id &&
              observed.record_mode_safe === true &&
              /^tree-sha256:[a-f0-9]{64}$/.test(observed.recorded_release_id || ""),
            state_preserved: observed.state_preserved === true,
            restore_instructions_ready: observed.restore_instructions === true,
          };
        }
        case "simpletuner-live-preflight": {
          const observed = await client.localTrainerInspection();
          const localInspectionReady = object(observed.process) &&
            typeof observed.process.active === "boolean" &&
            ["process-list", "fresh-log-heartbeat", "none"].includes(observed.process.active_source) &&
            Array.isArray(observed.process.processes) &&
            (observed.process.process_inspection_error === null ||
              typeof observed.process.process_inspection_error === "string");
          return {
            local_trainer_root_configured: observed.root_configured === true,
            local_process_inspection_ready: localInspectionReady,
            training_state_unchanged: observed.read_only === true,
          };
        }
        default: throw new Error("unknown acceptance check");
      }
    },
  });
}

export function createRealHawkspanClient(config) {
  const state = config.HAWKSPAN_STATE_DIR;
  const repository = config.HAWKSPAN_REPOSITORY_DIR;
  const configuration = config.HAWKSPAN_CONFIG_PATH;
  if (![state, repository, configuration].every((value) => typeof value === "string" && path.isAbsolute(value))) {
    throw new Error("required HawkSpan paths are missing");
  }
  const toolScript = path.join(repository, "scripts", "call-tool.mjs");
  const serverScript = path.join(repository, "scripts", "mcp-server.mjs");
  for (const file of [toolScript, serverScript]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid HawkSpan interface");
  }
  const environment = {
    ...FIXED_ENV, HAWKSPAN_STATE_DIR: state, HAWKSPAN_CONFIG: configuration,
    HAWKSPAN_LOCAL_CONTROL_DISABLED: "1",
  };
  const invoke = (name, args = {}, extra = {}) => {
    const result = spawnSync(process.execPath, [toolScript, name, JSON.stringify(args)], {
      encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024,
      env: { ...environment, ...extra },
    });
    if (result.status !== 0 || result.error) throw new Error("HawkSpan interface failed");
    return structured(JSON.parse(result.stdout));
  };
  const peer = (name, args = {}) => {
    const wrapper = invoke("peer_call_tool", {
      tool_name: name, arguments: args, timeout_ms: 300000,
    });
    if (!object(wrapper.result)) throw new Error("HawkSpan peer call failed");
    return structured(wrapper.result);
  };
  const readEvidence = () => {
    const target = config.HAWKSPAN_REAL_PAIR_FALLBACK_EVIDENCE;
    if (!target || !path.isAbsolute(target)) return null;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || ![0o400, 0o600].includes(stat.mode & 0o777) ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size > 8192) return null;
    return JSON.parse(fs.readFileSync(target, "utf8"));
  };
  return {
    linkStatus: () => invoke("link_status"),
    fallbackEvidence: readEvidence,
    listAndCallMcp() {
      const input = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hawkspan-acceptance", version: "1" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_status", arguments: {} } },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n";
      const result = spawnSync(process.execPath, [serverScript], { input, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, env: environment });
      if (result.status !== 0 || result.error) throw new Error("HawkSpan MCP failed");
      const responses = result.stdout.trim().split(/\n+/).map(JSON.parse);
      const listed = responses.find((item) => item.id === 2)?.result?.tools || [];
      const called = responses.find((item) => item.id === 3)?.result;
      return { tools: listed.map((item) => item.name), status: structured(called) };
    },
    messageAcknowledgementRoundTrip() {
      const sent = invoke("send_message", { subject: "HawkSpan public acceptance", body: "Public acceptance fixture.", wake: false });
      const received = peer("receive_messages", { limit: 100, include_acknowledged: true });
      const inbound = received.messages?.find((item) => item.id === sent.message_id);
      if (!inbound) return {};
      peer("acknowledge_message", { message_id: sent.message_id, deliver: true });
      const local = invoke("receive_messages", { limit: 100, include_acknowledged: true });
      const acknowledgement = local.messages?.find((item) => item.kind === "acknowledgement" && item.correlation_id === sent.message_id);
      return { message_received: true, correlation_matched: Boolean(acknowledgement), acknowledged: Boolean(acknowledgement) };
    },
    remoteJobLifecycle() {
      const created = peer("create_job", { kind: "public-acceptance", title: "HawkSpan public acceptance", requires_authorization: true });
      const states = [created.state === "awaiting_authorization" ? "created" : ""];
      for (const next of ["authorized", "queued", "running", "completed"]) {
        const changed = peer("update_job_status", { job_id: created.job_id, state: next, ...(next === "authorized" ? { authorization_evidence: "owner-authorized real-pair acceptance" } : {}) });
        if (changed.state === next) states.push(next);
      }
      return states;
    },
    artifactRoundTrip(fixtures) {
      const a = fixtures.controller_to_worker, b = fixtures.worker_to_controller;
      if (typeof a !== "string" || typeof b !== "string") return {};
      const root = fs.mkdtempSync(path.join(state, "acceptance-artifacts-"));
      const paths = [path.join(root, "controller.txt"), path.join(root, "worker.txt")];
      fs.writeFileSync(paths[0], a, { mode: 0o600 }); fs.writeFileSync(paths[1], b, { mode: 0o600 });
      const first = invoke("register_artifact", { path: paths[0], name: "public-acceptance-controller.txt" });
      const second = invoke("register_artifact", { path: paths[1], name: "public-acceptance-worker.txt" });
      const firstSend = invoke("send_artifact", { artifact_id: first.artifact_id });
      const secondSend = invoke("send_artifact", { artifact_id: second.artifact_id });
      const remoteReceive = peer("receive_artifacts");
      const remoteSecond = remoteReceive.artifacts?.find((item) => item.artifact_id === second.artifact_id && item.verified === true);
      let reverse = false;
      if (remoteSecond) {
        const registered = peer("register_artifact", { path: remoteSecond.path, name: "public-acceptance-return.txt" });
        const sentBack = peer("send_artifact", { artifact_id: registered.artifact_id });
        const localReceive = invoke("receive_artifacts");
        reverse = sentBack.delivery?.verified === true && localReceive.artifacts?.some((item) => item.artifact_id === registered.artifact_id && item.verified === true);
      }
      return {
        controller_to_worker_match: firstSend.delivery?.verified === true && remoteReceive.artifacts?.some((item) => item.artifact_id === first.artifact_id && item.verified === true),
        worker_to_controller_match: reverse,
      };
    },
    asymmetry() {
      const local = invoke("get_configuration");
      const forward = invoke("peer_call_tool", { tool_name: "link_status", arguments: {} });
      let denied = false;
      try { invoke("link_status", {}, { HAWKSPAN_CALL_ORIGIN: "peer" }); } catch { denied = true; }
      const configured = local.role_profile === "controller-worker" && local.node_role === "controller";
      return { forward: { ok: configured && object(forward.result) }, reverse: { denied } };
    },
    async servicesAndHtml() {
      const link = invoke("mcp_status");
      const url = new URL(config.HAWKSPAN_LOCAL_CONTROL_URL);
      const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
      let ready = false;
      if (loopback) {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
        ready = response.ok;
      }
      return { link, html: { ready, loopback_only: loopback } };
    },
    namespaceIsolation() {
      const stateBase = path.basename(state);
      const repositoryFiles = ["AGENTS.md", "scripts/mcp-server.mjs"].every((name) => fs.existsSync(path.join(repository, name)));
      const inside = (root, candidate) => {
        const relative = path.relative(root, candidate);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      };
      const evidence = config.HAWKSPAN_REAL_PAIR_FALLBACK_EVIDENCE;
      const pathsConfined = inside(state, configuration) &&
        (!evidence || inside(state, evidence)) && inside(repository, toolScript) && inside(repository, serverScript);
      return {
        hawkspan_only: stateBase === ".hawkspan" && repositoryFiles && pathsConfined,
        public_interfaces_only: pathsConfined,
      };
    },
    rollbackReadiness() {
      const installed = path.join(state, "installed-revision.json");
      let recorded_release_id = null;
      let record_mode_safe = false;
      if (fs.existsSync(installed)) {
        const stat = fs.lstatSync(installed);
        record_mode_safe = stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
          (typeof process.getuid !== "function" || stat.uid === process.getuid()) && stat.size <= 8192;
        if (record_mode_safe) {
          const record = JSON.parse(fs.readFileSync(installed, "utf8"));
          if (exactKeys(record, ["schema_version", "release_id"]) && record.schema_version === 1 &&
              /^tree-sha256:[a-f0-9]{64}$/.test(record.release_id || "")) {
            recorded_release_id = record.release_id;
          }
        }
      }
      let repository_release_id = null;
      try { repository_release_id = verifyReleaseTree(repository).release_id; } catch {}
      const uninstall = path.join(repository, "scripts", "uninstall-hawkspan.sh");
      return {
        recorded_release_id,
        repository_release_id,
        record_mode_safe,
        state_preserved: fs.existsSync(state) && fs.existsSync(configuration),
        restore_instructions: fs.existsSync(uninstall) && fs.readFileSync(uninstall, "utf8").includes("RESTORE"),
      };
    },
    localTrainerInspection() {
      const rootConfigured = typeof config.HAWKSPAN_SIMPLETUNER_ROOT === "string" &&
        path.isAbsolute(config.HAWKSPAN_SIMPLETUNER_ROOT);
      const local = peer("app_application_workflows_training_local_process_status");
      if (!object(local.result)) throw new Error("SimpleTuner local process inspection result is missing");
      return { root_configured: rootConfigured, process: local.result, read_only: true };
    },
  };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    const request = JSON.parse(input);
    const adapter = createRealPairAdapter(createRealHawkspanClient(request.config || {}));
    const output = request.operation === "preflight"
      ? await adapter.preflight()
      : request.operation === "run-check"
        ? await adapter.runCheck(request.check_id, request.context || {})
        : (() => { throw new Error("unknown operation"); })();
    process.stdout.write(JSON.stringify(output));
  } catch {
    process.stdout.write(JSON.stringify({ ready: false }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
