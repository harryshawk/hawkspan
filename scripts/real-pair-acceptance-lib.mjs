import fs from "node:fs";
import { readHawkspanEnv } from "./hawkspan-env.mjs";

export const RECEIPT_SCHEMA_VERSION = 1;

export const MACHINE_ENV_KEYS = Object.freeze([
  "HAWKSPAN_CONFIG_PATH",
  "HAWKSPAN_LOCAL_CONTROL_URL",
  "HAWKSPAN_PEER_FALLBACK_HOST",
  "HAWKSPAN_PEER_PRIMARY_HOST",
  "HAWKSPAN_PEER_USER",
  "HAWKSPAN_REMOTE_CONFIG_PATH",
  "HAWKSPAN_REMOTE_REPOSITORY_DIR",
  "HAWKSPAN_REMOTE_STATE_DIR",
  "HAWKSPAN_REPOSITORY_DIR",
  "HAWKSPAN_REAL_PAIR_FALLBACK_EVIDENCE",
  "HAWKSPAN_SIMPLETUNER_ROOT",
  "HAWKSPAN_SSH_IDENTITY",
  "HAWKSPAN_STATE_DIR",
]);

export function parseMachineEnvironment(target) {
  const parsed = readHawkspanEnv(target);
  return Object.freeze(Object.fromEntries(MACHINE_ENV_KEYS
    .filter((key) => Object.hasOwn(parsed, key))
    .map((key) => [key, parsed[key]])));
}

export const REAL_PAIR_CHECKS = Object.freeze([
  {
    id: "routes-independent",
    title: "Validate each enabled route independently",
    assertions: ["primary_route_passed", "fallback_route_passed"],
  },
  {
    id: "primary-preference",
    title: "Prefer the configured primary route",
    assertions: ["primary_selected"],
  },
  {
    id: "owner-assisted-fallback",
    title: "Use fallback after an owner-assisted primary interruption",
    assertions: ["owner_confirmed", "fallback_selected", "primary_restored"],
    owner_assisted: true,
  },
  {
    id: "mcp-list-call",
    title: "List and call a harmless tool through real MCP",
    assertions: ["tools_listed", "harmless_call_passed"],
  },
  {
    id: "message-receive-ack",
    title: "Receive and acknowledge a durable test message",
    assertions: ["message_received", "correlation_matched", "acknowledged"],
  },
  {
    id: "remote-job-lifecycle",
    title: "Complete a remote test job lifecycle",
    assertions: ["created", "authorized", "running", "completed"],
  },
  {
    id: "artifacts-bidirectional",
    title: "Transfer small SHA-256 fixtures in both directions",
    assertions: ["controller_to_worker_match", "worker_to_controller_match"],
  },
  {
    id: "asymmetric-controller-worker",
    title: "Enforce controller-to-worker asymmetry",
    assertions: ["controller_to_worker_allowed", "worker_to_controller_denied"],
  },
  {
    id: "installed-services-html",
    title: "Verify installed HawkSpan services and loopback HTML",
    assertions: ["link_service_ready", "html_service_ready", "html_loopback_only"],
  },
  {
    id: "coexistence-namespace",
    title: "Verify the HawkSpan namespace remains isolated",
    assertions: ["hawkspan_namespace_only", "other_products_untouched"],
  },
  {
    id: "rollback-readiness",
    title: "Verify rollback evidence and instructions",
    assertions: ["revision_recorded", "state_preserved", "restore_instructions_ready"],
  },
  {
    id: "simpletuner-live-preflight",
    title: "Inspect the configured local SimpleTuner trainer path without changing training state",
    assertions: ["local_trainer_root_configured", "local_process_inspection_ready", "training_state_unchanged"],
  },
]);

const checkById = new Map(REAL_PAIR_CHECKS.map((check) => [check.id, check]));

export function acceptancePlan() {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    mode: "preflight",
    safety: {
      runtime_accessed: false,
      network_accessed: false,
      authorization_required: true,
    },
    checks: REAL_PAIR_CHECKS.map(({ id, title, owner_assisted = false }) => ({
      id,
      title,
      owner_assisted,
    })),
  };
}

function normalizedCheck(check, raw) {
  const assertions = {};
  for (const name of check.assertions) assertions[name] = raw?.[name] === true;
  const passed = Object.values(assertions).every(Boolean);
  return {
    id: check.id,
    status: passed ? "passed" : "failed",
    assertions,
  };
}

function failedCheck(check, code = "adapter-error") {
  return {
    id: check.id,
    status: "failed",
    assertions: Object.fromEntries(check.assertions.map((name) => [name, false])),
    failure_code: code,
  };
}

export async function executeAcceptance(adapter) {
  if (!adapter || typeof adapter.preflight !== "function" || typeof adapter.runCheck !== "function") {
    throw new TypeError("adapter must provide preflight() and runCheck()");
  }

  let preflight;
  try {
    preflight = await adapter.preflight();
  } catch {
    preflight = null;
  }
  if (preflight?.ready !== true) {
    return {
      schema_version: RECEIPT_SCHEMA_VERSION,
      mode: "real-pair",
      overall: "failed",
      checks: REAL_PAIR_CHECKS.map((check) => failedCheck(check, "preflight-failed")),
    };
  }

  const checks = [];
  for (const check of REAL_PAIR_CHECKS) {
    try {
      const raw = await adapter.runCheck(check.id, {
        owner_assisted: check.owner_assisted === true,
        fixtures: check.id === "artifacts-bidirectional" ? {
          controller_to_worker: "hawkspan-public-acceptance-fixture-a\n",
          worker_to_controller: "hawkspan-public-acceptance-fixture-b\n",
        } : undefined,
      });
      checks.push(normalizedCheck(check, raw));
    } catch {
      checks.push(failedCheck(check));
    }
  }

  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    mode: "real-pair",
    overall: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    checks,
  };
}

export function validateReceipt(receipt) {
  if (!receipt || receipt.schema_version !== RECEIPT_SCHEMA_VERSION) return false;
  if (receipt.mode !== "real-pair" || !["passed", "failed"].includes(receipt.overall)) return false;
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== REAL_PAIR_CHECKS.length) return false;
  const seen = new Set();
  for (const entry of receipt.checks) {
    const definition = checkById.get(entry?.id);
    if (!definition || seen.has(entry.id) || !["passed", "failed"].includes(entry.status)) return false;
    seen.add(entry.id);
    if (!entry.assertions || Object.keys(entry.assertions).sort().join("\0") !== [...definition.assertions].sort().join("\0")) return false;
    if (!Object.values(entry.assertions).every((value) => typeof value === "boolean")) return false;
    if ((Object.values(entry.assertions).every(Boolean) ? "passed" : "failed") !== entry.status) return false;
    if (entry.failure_code !== undefined && !["adapter-error", "preflight-failed"].includes(entry.failure_code)) return false;
    const allowed = new Set(["id", "status", "assertions", "failure_code"]);
    if (Object.keys(entry).some((key) => !allowed.has(key))) return false;
  }
  return seen.size === REAL_PAIR_CHECKS.length &&
    (receipt.checks.every((check) => check.status === "passed") ? "passed" : "failed") === receipt.overall;
}

export function writeReceipt(target, receipt) {
  if (!validateReceipt(receipt)) throw new Error("refusing to write an invalid acceptance receipt");
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
