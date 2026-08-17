#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const receiver = path.join(scripts, "hawkgrokspan-message-receiver.mjs");
const gateway = path.join(scripts, "hawkgrokspan-ssh-gateway.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkgrokspan-receiver-"));
const state = path.join(root, "state");
const audit = path.join(state, "audit");
const inbox = path.join(state, "inbox");
const codexWorkdir = path.join(root, "work", "codex-primary");
const grokWorkdir = path.join(root, "work", "grok-review");
const artifacts = path.join(state, "artifacts");
const identity = path.join(root, "hawkgrokspan_ed25519");
const knownHosts = path.join(root, "known_hosts");
const bin = path.join(root, "bin");
for (const directory of [state, audit, inbox, artifacts, bin, codexWorkdir, grokWorkdir]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
fs.writeFileSync(identity, "test identity\n", { mode: 0o600 });
fs.writeFileSync(knownHosts, "peer ssh-ed25519 AAAATEST\n", { mode: 0o600 });
fs.writeFileSync(path.join(bin, "rsync"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
fs.writeFileSync(path.join(bin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const mockAgent = path.join(root, "mock-agent.mjs");
fs.writeFileSync(mockAgent, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const state = process.env.HAWKGROKSPAN_RECEIVER_STATE_ROOT;
const target = process.env.HAWKGROKSPAN_TARGET_BOT_ID;
fs.appendFileSync(path.join(state, "audit", "mock-agent-argv.jsonl"), JSON.stringify({
  target,
  argv: process.argv.slice(2),
  started_at_ms: Date.now(),
}) + "\\n");
const delayPath = path.join(state, "audit", "mock-delay-" + target);
if (fs.existsSync(delayPath)) {
  const delay = Number(fs.readFileSync(delayPath, "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}
const holdPath = path.join(state, "audit", "mock-hold-" + target);
const holdDeadline = Date.now() + 5000;
while (fs.existsSync(holdPath) && Date.now() < holdDeadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
if (fs.existsSync(path.join(state, "audit", "mock-fail-" + target))) process.exit(7);
const config = JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8"));
const db = new DatabaseSync(path.join(state, "spool.sqlite3"));
const rows = db.prepare("SELECT id,metadata_json FROM messages WHERE direction='inbound' AND state='received'").all();
for (const row of rows) {
  const metadata = JSON.parse(row.metadata_json || "{}");
  const routed = metadata.target_bot_id || config.message_receiver.default_target;
  if (routed === target) {
    db.prepare("UPDATE messages SET state='acknowledged' WHERE id=?").run(row.id);
  }
}
db.close();
`, { mode: 0o700 });

const config = {
  schema_version: 1,
  node_id: "receiver-test",
  surface_profile: "message-files",
  application_plugins: { enabled: false },
  local_control: { enabled: false },
  message_receiver: {
    enabled: true,
    start_on_mcp_server: false,
    reconcile_interval_seconds: 5,
    retry_backoff_seconds: [5, 10, 15, 30, 60],
    default_target: "codex-primary",
    targets: {
      "codex-primary": {
        adapter: "codex",
        command: mockAgent,
        workdir: codexWorkdir,
        session_id: "10000000-0000-0000-0000-000000000001",
        sandbox: "workspace-write",
        maximum_runtime_seconds: 30,
      },
      "grok-review": {
        adapter: "grok",
        command: mockAgent,
        workdir: grokWorkdir,
        session_id: "20000000-0000-0000-0000-000000000002",
        sandbox: "workspace",
        maximum_runtime_seconds: 30,
        maximum_turns: 8,
      },
    },
  },
  queue_supervisor: { enabled: false },
  transfer: { allowed_artifact_roots: [artifacts] },
  peer: {
    node_id: "peer",
    user: "peer",
    allow_remote_wake: false,
    primary_enabled: true,
    primary_host: "192.0.2.40",
    fallback_enabled: false,
    ssh_identity: identity,
    known_hosts: knownHosts,
    remote_state_dir: "/home/peer/.hawkgrokspan",
    remote_inbox: "/home/peer/.hawkgrokspan/inbox",
    remote_artifacts: "/home/peer/.hawkgrokspan/artifacts",
    remote_audit: "/home/peer/.hawkgrokspan/audit",
  },
  features: {
    allowed_peer_tools: { inbound: [], outbound: [] },
    allow_peer_commands: false,
    enable_broad_run_command: false,
  },
  training: { allow_start: false, allow_stop: false, allow_package: false },
};
fs.writeFileSync(path.join(state, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(state, "installed-revision.json"), `${JSON.stringify({
  schema_version: 2,
  revision: "a".repeat(40),
  active_release_root: path.resolve(scripts, ".."),
  stable_release_root: path.resolve(scripts, ".."),
}, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(state, "hawkspan.env"), [
  `HAWKSPAN_ACTIVE_RELEASE_ROOT=${path.resolve(scripts, "..")}`,
  `HAWKSPAN_REPOSITORY_DIR=${path.resolve(scripts, "..")}`,
  "",
].join("\n"), { mode: 0o600 });

const db = new DatabaseSync(path.join(state, "spool.sqlite3"));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    correlation_id TEXT,
    direction TEXT NOT NULL,
    state TEXT NOT NULL,
    envelope_path TEXT NOT NULL,
    delivered_via TEXT,
    acknowledged_at TEXT,
    metadata_json TEXT NOT NULL
  );
  CREATE TABLE audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    node_id TEXT NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT,
    result TEXT NOT NULL,
    details_json TEXT NOT NULL
  );
`);

function seed(messageId, { target = null, kind = "message", notify = true } = {}) {
  const metadata = {};
  if (target) metadata.target_bot_id = target;
  metadata.notify_receiver = notify;
  const envelope = {
    schema_version: 1,
    id: messageId,
    created_at: new Date().toISOString(),
    sender: "peer",
    recipient: "receiver-test",
    kind,
    subject: messageId,
    body: "receiver test",
    metadata,
  };
  if (target) envelope.target_bot_id = target;
  envelope.notify_receiver = notify;
  const envelopePath = path.join(inbox, `${messageId}.json`);
  fs.writeFileSync(envelopePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  db.prepare(`
    INSERT INTO messages
      (id,created_at,sender,recipient,kind,subject,body,correlation_id,
       direction,state,envelope_path,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    messageId,
    envelope.created_at,
    envelope.sender,
    envelope.recipient,
    envelope.kind,
    envelope.subject,
    envelope.body,
    null,
    "inbound",
    kind === "acknowledgement" ? "acknowledged" : "received",
    envelopePath,
    JSON.stringify(metadata),
  );
}

function envelopeOnly(messageId, { target = null, kind = "message", notify = true, correlationId = null } = {}) {
  const metadata = { notify_receiver: notify };
  if (target) metadata.target_bot_id = target;
  const envelope = {
    schema_version: 1,
    id: messageId,
    created_at: new Date().toISOString(),
    sender: "peer",
    recipient: "receiver-test",
    kind,
    subject: messageId,
    body: "receiver test",
    correlation_id: correlationId,
    target_bot_id: target,
    notify_receiver: notify,
    metadata,
  };
  fs.writeFileSync(path.join(inbox, `${messageId}.json`), `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
}

function request() {
  const result = spawnSync(process.execPath, [receiver, "--state-root", state], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function stateOf(messageId) {
  return db.prepare("SELECT state FROM messages WHERE id=?").get(messageId)?.state;
}

function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.fail(`timeout waiting for ${label}`);
}

function argvLines() {
  const argvLog = path.join(audit, "mock-agent-argv.jsonl");
  if (!fs.existsSync(argvLog)) return [];
  return fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function targetLeaseRoot(targetId) {
  const target = config.message_receiver.targets[targetId];
  return path.join(
    audit,
    `message-receiver-session-${target.adapter}-${target.session_id.toLowerCase()}.lock`,
  );
}

// Two target-specific adapters start independently. A slow Grok target cannot block Codex.
fs.writeFileSync(path.join(audit, "mock-delay-grok-review"), "1200\n");
seed("msg-codex-1", { target: "codex-primary" });
seed("msg-grok-1", { target: "grok-review" });
const first = request();
assert.deepEqual(first.targets.map(({ target_bot_id }) => target_bot_id).sort(), ["codex-primary", "grok-review"]);
waitFor(() => stateOf("msg-codex-1") === "acknowledged", "Codex acknowledgement");
assert.equal(stateOf("msg-grok-1"), "received", "slow Grok target must remain independent");
waitFor(() => stateOf("msg-grok-1") === "acknowledged", "Grok acknowledgement");
waitFor(() => !fs.existsSync(targetLeaseRoot("codex-primary")), "initial Codex lease cleanup");
fs.rmSync(path.join(audit, "mock-delay-grok-review"));

let lines = argvLines();
const codexInvocation = lines.find(({ target }) => target === "codex-primary");
const grokInvocation = lines.find(({ target }) => target === "grok-review");
assert.ok(codexInvocation);
assert.ok(grokInvocation);
assert.deepEqual(codexInvocation.argv.slice(0, 7), [
  "exec", "-c", "sandbox_workspace_write.writable_roots=[]", "-s", "workspace-write", "-C", codexWorkdir,
]);
assert.ok(codexInvocation.argv.includes("10000000-0000-0000-0000-000000000001"));
assert.ok(grokInvocation.argv.includes("--resume"));
assert.ok(grokInvocation.argv.includes("MCPTool(hawkgrokspan__receive_messages)"));
assert.ok(grokInvocation.argv.includes("20000000-0000-0000-0000-000000000002"));
const grokTools = grokInvocation.argv[grokInvocation.argv.indexOf("--tools") + 1];
assert.match(grokTools, /hawkgrokspan__receive_messages/);
assert.match(grokTools, /hawkgrokspan__send_artifact/);
assert.doesNotMatch(grokTools, /run_command|peer_call_tool|wake/);
for (const invocation of [codexInvocation, grokInvocation]) {
  const prompt = invocation.argv.join(" ");
  assert.match(prompt, /acknowledge_message/);
  assert.match(prompt, /Harry is the human owner/);
  assert.match(prompt, /target_bot_id must be the peer target named by the envelope/);
  assert.match(prompt, /never this local target/);
}
assert.match(codexInvocation.argv.join(" "), /Never blindly create a goal/);
assert.match(codexInvocation.argv.join(" "), /leave the original message pending/);
assert.match(grokInvocation.argv.join(" "), /no HawkGrokSpan goal-state control/);
assert.match(grokInvocation.argv.join(" "), /first action must be a direct call to the MCP tool hawkgrokspan__receive_messages/);
assert.match(grokInvocation.argv.join(" "), /Do not search for the tool and do not use a terminal or call-tool fallback/);
assert.match(grokInvocation.argv.join(" "), /Receiving the envelope is not completion/);
assert.match(grokInvocation.argv.join(" "), /hawkgrokspan__acknowledge_message/);
assert.match(grokInvocation.argv.join(" "), /until no unread routed envelope remains/);

// Messages arriving during an active run coalesce behind one per-target lease.
// Hold the mock explicitly instead of relying on a machine-speed delay.
const codexHold = path.join(audit, "mock-hold-codex-primary");
fs.writeFileSync(codexHold, "hold\n");
seed("msg-codex-2", { target: "codex-primary" });
request();
waitFor(() => fs.existsSync(path.join(targetLeaseRoot("codex-primary"), "lease.json")), "active Codex lease");
seed("msg-codex-3", { target: "codex-primary" });
const coalesced = request();
assert.equal(coalesced.targets[0].started, false);
assert.equal(coalesced.targets[0].queued, true);
fs.rmSync(codexHold);
waitFor(() => stateOf("msg-codex-2") === "acknowledged" && stateOf("msg-codex-3") === "acknowledged", "coalesced acknowledgements");
waitFor(() => !fs.existsSync(targetLeaseRoot("codex-primary")), "Codex lease cleanup");
lines = argvLines();
assert.equal(lines.filter(({ target }) => target === "codex-primary").length, 2, "one active worker must coalesce the second delivery");

// Acknowledgements never launch a bot. Old notify_receiver=false envelopes still wake.
const outboundPath = path.join(root, "outbound-for-ack.json");
db.prepare(`
  INSERT INTO messages
    (id,created_at,sender,recipient,kind,subject,body,correlation_id,
     direction,state,envelope_path,metadata_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  "outbound-for-ack", new Date().toISOString(), "receiver-test", "peer", "message",
  "outbound", "outbound", null, "outbound", "delivered", outboundPath, "{}",
);
envelopeOnly("ack-1", { kind: "acknowledgement", notify: false, correlationId: "outbound-for-ack" });
seed("msg-quiet-1", { target: "grok-review", notify: false });
const mixed = request();
assert.deepEqual(mixed.targets.map(({ target_bot_id }) => target_bot_id), ["grok-review"]);
waitFor(() => stateOf("msg-quiet-1") === "acknowledged", "old quiet envelope still wakes");
assert.equal(stateOf("ack-1"), "acknowledged");
assert.equal(stateOf("outbound-for-ack"), "acknowledged");
waitFor(() => !fs.existsSync(targetLeaseRoot("grok-review")), "quiet-message Grok lease cleanup");

// Untargeted legacy envelopes use the configured default bot.
seed("msg-default-1");
request();
waitFor(() => stateOf("msg-default-1") === "acknowledged", "default-target acknowledgement");

// A hung adapter is terminated at the configured total deadline and remains pending for retry.
fs.writeFileSync(path.join(audit, "mock-delay-grok-review"), "60000\n");
seed("msg-grok-timeout", { target: "grok-review" });
request();
const grokStatusPath = path.join(audit, "message-receiver-grok-review.status.json");
waitFor(() => {
  if (!fs.existsSync(grokStatusPath)) return false;
  const status = JSON.parse(fs.readFileSync(grokStatusPath, "utf8"));
  return status.message_ids.includes("msg-grok-timeout") && status.process.timed_out === true;
}, "Grok adapter deadline", 38000);
assert.equal(stateOf("msg-grok-timeout"), "received");
waitFor(() => !fs.existsSync(targetLeaseRoot("grok-review")), "timed-out Grok lease cleanup");
fs.rmSync(path.join(audit, "mock-delay-grok-review"));
const deferredRetry = request();
assert.equal(deferredRetry.targets[0].started, false);
assert.match(deferredRetry.targets[0].retry_deferred_until, /^20/);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5200);
request();
waitFor(() => stateOf("msg-grok-timeout") === "acknowledged", "timed-out Grok retry");
waitFor(() => !fs.existsSync(targetLeaseRoot("grok-review")), "retried Grok lease cleanup");

// A dead stale lease is reclaimed. A lease containing a live but unrelated/reused
// PID is quarantined without signalling that process and cannot wedge delivery.
const staleRoot = targetLeaseRoot("grok-review");
fs.mkdirSync(staleRoot, { mode: 0o700 });
fs.writeFileSync(path.join(staleRoot, "lease.json"), JSON.stringify({
  pid: 99999999,
  nonce: "dead",
  target_bot_id: "grok-review",
  started_at_ms: 1,
}));
seed("msg-grok-stale", { target: "grok-review" });
assert.equal(request().targets[0].started, true);
waitFor(() => stateOf("msg-grok-stale") === "acknowledged", "stale-lease recovery");
waitFor(() => !fs.existsSync(staleRoot), "Grok stale-recovery lease cleanup");

fs.mkdirSync(staleRoot, { mode: 0o700 });
fs.writeFileSync(path.join(staleRoot, "lease.json"), JSON.stringify({
  pid: process.pid,
  nonce: "live-unrelated-process",
  target_bot_id: "grok-review",
  started_at_ms: 1,
  script_path: receiver,
}));
seed("msg-grok-fenced", { target: "grok-review" });
const fenced = request();
assert.equal(fenced.targets[0].started, true);
waitFor(() => stateOf("msg-grok-fenced") === "acknowledged", "PID-reuse lease recovery");
waitFor(() => !fs.existsSync(staleRoot), "PID-reuse recovery lease cleanup");

// After import, the durable DB row—not a replaceable file—is authoritative for
// routing. Mutating the on-disk duplicate is rejected and cannot reroute.
// Old notify_receiver=false still wakes the original target.
seed("msg-immutable-quiet", { target: "grok-review", notify: false });
const immutablePath = path.join(inbox, "msg-immutable-quiet.json");
const mutated = JSON.parse(fs.readFileSync(immutablePath, "utf8"));
mutated.target_bot_id = "codex-primary";
mutated.notify_receiver = true;
mutated.metadata.target_bot_id = "codex-primary";
mutated.metadata.notify_receiver = true;
fs.writeFileSync(immutablePath, `${JSON.stringify(mutated)}\n`, { mode: 0o600 });
const beforeImmutableCodex = argvLines().filter(({ target }) => target === "codex-primary").length;
const immutable = request();
assert.deepEqual(immutable.targets.map(({ target_bot_id }) => target_bot_id), ["grok-review"]);
waitFor(() => stateOf("msg-immutable-quiet") === "acknowledged", "old quiet envelope still wakes original target");
assert.equal(
  argvLines().filter(({ target }) => target === "codex-primary").length,
  beforeImmutableCodex,
  "mutated on-disk target must not reroute the durable row",
);
assert.match(
  fs.readFileSync(path.join(audit, "message-receiver-ingest.jsonl"), "utf8"),
  /duplicate message ID disagrees with the durable canonical envelope/,
);
waitFor(() => !fs.existsSync(targetLeaseRoot("grok-review")), "immutable-quiet Grok lease cleanup");

// Unknown targets are recorded as routing failures without falling through to a default bot.
seed("msg-unknown", { target: "unconfigured-bot" });
const unknown = request();
assert.equal(unknown.targets.length, 0);
assert.equal(stateOf("msg-unknown"), "routing_failed");
const routingFailure = JSON.parse(fs.readFileSync(path.join(audit, "message-receiver-msg-unknown.status.json"), "utf8"));
assert.equal(routingFailure.state, "routing_failed");
assert.equal(routingFailure.sender_report_queued, true);
waitFor(() => Boolean(db.prepare(`
    SELECT 1 FROM messages
    WHERE direction='outbound' AND kind='routing_failure' AND correlation_id='msg-unknown'
  `).get()), "durable sender-visible routing failure");

// A routing-failure report is a terminal status notice. Record it once without
// launching a bot or replying to the report, which would create a loop.
const beforeRoutingNotice = argvLines().length;
seed("msg-routing-failure-notice", { target: "grok-review", kind: "routing_failure" });
const routingNotice = request();
assert.equal(routingNotice.targets.length, 0);
assert.equal(stateOf("msg-routing-failure-notice"), "acknowledged");
assert.equal(argvLines().length, beforeRoutingNotice);
const routingNoticeStatus = JSON.parse(fs.readFileSync(
  path.join(audit, "message-receiver-msg-routing-failure-notice.status.json"), "utf8",
));
assert.equal(routingNoticeStatus.terminal_notice, "routing_failure");
assert.equal(routingNoticeStatus.replied, false);

const beforeConflict = argvLines().length;
envelopeOnly("msg-conflicting-route", { target: "codex-primary" });
const conflictingPath = path.join(inbox, "msg-conflicting-route.json");
const conflictingEnvelope = JSON.parse(fs.readFileSync(conflictingPath, "utf8"));
conflictingEnvelope.metadata.target_bot_id = "grok-review";
fs.writeFileSync(conflictingPath, JSON.stringify(conflictingEnvelope));
assert.equal(request().targets.length, 0);
assert.equal(stateOf("msg-conflicting-route"), undefined);
assert.equal(argvLines().length, beforeConflict, "rejected routing authority must not launch a bot");
assert.match(fs.readFileSync(path.join(audit, "message-receiver-ingest.jsonl"), "utf8"), /target_bot_id disagree/);

// The forced receive-only SSH gateway triggers the local receiver after inbox delivery.
fs.writeFileSync(path.join(bin, "rsync"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
const gatewayAttemptBaseline = argvLines().filter(({ target }) => target === "codex-primary").length;
fs.writeFileSync(path.join(audit, "mock-fail-codex-primary"), "fail once\n");
envelopeOnly("msg-gateway-trigger", { target: "codex-primary" });
const gatewayResult = spawnSync(process.execPath, [gateway, "--state-root", state], {
  encoding: "utf8",
  timeout: 5000,
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    SSH_ORIGINAL_COMMAND: `rsync --server -logDtpre.iLsfxCIvu --dirs . ${inbox}/`,
  },
});
assert.equal(gatewayResult.status, 0, gatewayResult.stderr);
waitFor(
  () => argvLines().filter(({ target }) => target === "codex-primary").length > gatewayAttemptBaseline,
  "gateway-triggered failed adapter attempt",
);
assert.equal(stateOf("msg-gateway-trigger"), "received");
fs.rmSync(path.join(audit, "mock-fail-codex-primary"));
waitFor(
  () => stateOf("msg-gateway-trigger") === "acknowledged",
  "supervisor retry without another delivery",
  15000,
);

const supervisorLeasePath = path.join(audit, "message-receiver-supervisor.lock", "lease.json");
const supervisorLease = JSON.parse(fs.readFileSync(supervisorLeasePath, "utf8"));
process.kill(Number(supervisorLease.pid), "SIGTERM");
waitFor(() => !fs.existsSync(path.dirname(supervisorLeasePath)), "supervisor cleanup");

// A managed foreground service acquires the same canonical supervisor lease,
// survives independently of MCP, and cleans up on service-manager termination.
const managed = spawn(process.execPath, [receiver, "--state-root", state, "--service"], {
  detached: true,
  stdio: "ignore",
});
waitFor(() => {
  if (!fs.existsSync(supervisorLeasePath)) return false;
  const lease = JSON.parse(fs.readFileSync(supervisorLeasePath, "utf8"));
  return lease.managed_service === true && Number(lease.pid) === managed.pid;
}, "managed receiver service lease");
process.kill(Number(managed.pid), "SIGTERM");
waitFor(() => !fs.existsSync(path.dirname(supervisorLeasePath)), "managed receiver service cleanup");

db.close();
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("HawkGrokSpan multi-bot local receiver tests passed\n");
