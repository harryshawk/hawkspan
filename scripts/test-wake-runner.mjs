#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildControllerRouterPrompt, cleanupLease } from "./wake-runner.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(scripts, "wake-runner.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hawkspan-wake-runner-"));
const audit = path.join(root, "audit");
const calls = path.join(root, "calls.jsonl");
const raceAckStarted = path.join(root, "race-ack-started.json");
const raceAckFinished = path.join(root, "race-ack-finished.json");
const ipcSocket = path.join(root, "codex-ipc.sock");
const fakeCodex = path.join(root, "fake-codex.mjs");
const fakeCallTool = path.join(root, "fake-call-tool.mjs");
const messageStatePaths = new Map();
const routerEventPaths = new Map();
const correlatedReplyStatePaths = new Map();
fs.mkdirSync(audit, { recursive: true });

fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const schemaIndex = args.indexOf("--output-schema");
const schema = schemaIndex >= 0
  ? JSON.parse(fs.readFileSync(args[schemaIndex + 1], "utf8"))
  : null;
if (schema?.properties?.message_id?.type !== "string" ||
    schema?.properties?.status?.type !== "string") {
  throw new Error("acceptance schema string properties must declare type=string");
}
const outputIndex = args.indexOf("--output-last-message");
const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
const mode = process.env.HAWKSPAN_TEST_CODEX_MODE;
if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  const messageId = mode === "mismatch" ? "wrong-message" : process.env.HAWKSPAN_TEST_MESSAGE_ID;
  fs.writeFileSync(output, JSON.stringify({ message_id: messageId, status: "accepted" }));
  if (mode === "ack-race") {
    const ownerPath = path.join(path.dirname(output), "owner.json");
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    owner.deadline_at = new Date(Date.now() + 400).toISOString();
    fs.writeFileSync(ownerPath, JSON.stringify(owner));
  }
  if (mode === "lose-lease") {
    fs.writeFileSync(path.join(path.dirname(output), "owner.json"), JSON.stringify({
      token: "successor-token-after-acceptance",
      pid: process.pid,
      deadline_at: new Date(Date.now() + 60000).toISOString(),
    }));
  }
}
`, { mode: 0o755 });

fs.writeFileSync(fakeCallTool, `#!/usr/bin/env node
import fs from "node:fs";
const [name, raw = "{}"] = process.argv.slice(2);
const args = JSON.parse(raw);
fs.appendFileSync(process.env.HAWKSPAN_TEST_CALL_LOG, JSON.stringify({ name, args }) + "\\n");
if (name === "list_messages") {
  const delayMs = Number(process.env.HAWKSPAN_TEST_LIST_DELAY_MS || 0);
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
  const state = fs.existsSync(process.env.HAWKSPAN_TEST_MESSAGE_STATE_PATH)
    ? fs.readFileSync(process.env.HAWKSPAN_TEST_MESSAGE_STATE_PATH, "utf8").trim()
    : "received";
  const rows = [{
    id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
    created_at: new Date(Date.now() - 1000).toISOString(),
    sender: "peer",
    recipient: "configured-receiver-label",
    kind: "message",
    correlation_id: null,
    direction: "inbound",
    state,
  }];
  const correlatedReplyPath = process.env.HAWKSPAN_TEST_CORRELATED_REPLY_STATE_PATH;
  if (correlatedReplyPath && fs.existsSync(correlatedReplyPath)) {
    const reply = JSON.parse(fs.readFileSync(correlatedReplyPath, "utf8"));
    rows.push(
      {
        id: "reply-wrong-correlation-" + process.env.HAWKSPAN_TEST_MESSAGE_ID,
        created_at: reply.created_at,
        sender: "local",
        recipient: "peer",
        kind: "message",
        correlation_id: "another-message",
        direction: "outbound",
        state: "acknowledged",
        acknowledged_at: reply.acknowledged_at,
        wake_requested: true,
      },
      ...["acknowledgement", "cancellation"].map((kind) => ({
        id: "reply-" + kind + "-" + process.env.HAWKSPAN_TEST_MESSAGE_ID,
        created_at: reply.created_at,
        sender: "local",
        recipient: "peer",
        kind,
        correlation_id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
        direction: "outbound",
        state: "acknowledged",
        acknowledged_at: reply.acknowledged_at,
        wake_requested: true,
      })),
      {
        id: "reply-silent-" + process.env.HAWKSPAN_TEST_MESSAGE_ID,
        created_at: reply.created_at,
        sender: "local-node",
        recipient: "peer",
        kind: "message",
        correlation_id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
        direction: "outbound",
        state: "acknowledged",
        acknowledged_at: reply.acknowledged_at,
        wake_requested: false,
      },
      {
        id: "reply-wrong-recipient-" + process.env.HAWKSPAN_TEST_MESSAGE_ID,
        created_at: reply.created_at,
        sender: "local-node",
        recipient: "another-peer",
        kind: "message",
        correlation_id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
        direction: "outbound",
        state: "acknowledged",
        acknowledged_at: reply.acknowledged_at,
        wake_requested: true,
      },
      {
        id: "reply-before-controller-" + process.env.HAWKSPAN_TEST_MESSAGE_ID,
        created_at: new Date(Date.parse(reply.created_at) - 60000).toISOString(),
        sender: "local-node",
        recipient: "peer",
        kind: "message",
        correlation_id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
        direction: "outbound",
        state: "acknowledged",
        acknowledged_at: reply.acknowledged_at,
        wake_requested: true,
      },
      {
        id: "reply-missing-ack-time-" + process.env.HAWKSPAN_TEST_MESSAGE_ID,
        created_at: reply.created_at,
        sender: "local-node",
        recipient: "peer",
        kind: "message",
        correlation_id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
        direction: "outbound",
        state: "acknowledged",
        acknowledged_at: null,
        wake_requested: true,
      },
      {
        id: "reply-early-ack-time-" + process.env.HAWKSPAN_TEST_MESSAGE_ID,
        created_at: reply.created_at,
        sender: "local-node",
        recipient: "peer",
        kind: "message",
        correlation_id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
        direction: "outbound",
        state: "acknowledged",
        acknowledged_at: new Date(Date.parse(reply.created_at) - 1).toISOString(),
        wake_requested: true,
      },
      {
        id: "reply-" + process.env.HAWKSPAN_TEST_MESSAGE_ID,
        created_at: reply.created_at,
        sender: "local-node",
        recipient: "peer",
        kind: "message",
        correlation_id: process.env.HAWKSPAN_TEST_MESSAGE_ID,
        direction: "outbound",
        state: reply.state,
        acknowledged_at: reply.acknowledged_at,
        wake_requested: true,
      },
    );
  }
  const selected = rows.filter((row) =>
    (!args.direction || row.direction === args.direction) &&
    (!args.state || row.state === args.state));
  process.stdout.write(JSON.stringify({ isError: false, structuredContent: selected }));
} else if (name === "acknowledge_message") {
  const delayMs = Number(process.env.HAWKSPAN_TEST_ACK_DELAY_MS || 0);
  if (delayMs > 0) {
    fs.writeFileSync(process.env.HAWKSPAN_TEST_ACK_STARTED, JSON.stringify({ at: Date.now() }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    fs.writeFileSync(process.env.HAWKSPAN_TEST_ACK_FINISHED, JSON.stringify({ at: Date.now() }));
  }
  fs.writeFileSync(process.env.HAWKSPAN_TEST_MESSAGE_STATE_PATH, "acknowledged\\n");
  process.stdout.write(JSON.stringify({
    isError: false,
    structuredContent: { message_id: "ack-test", acknowledged_message_id: args.message_id },
  }));
} else {
  process.stdout.write(JSON.stringify({ isError: true, content: [{ text: "unexpected tool" }] }));
}
`, { mode: 0o755 });

function request(name, messageId, overrides = {}) {
  return {
    schema_version: 1,
    wake_id: `wake-${name}`,
    message_id: messageId,
    thread_id: `thread-${name}`,
    prompt: `accept ${messageId}`,
    codex_command: fakeCodex,
    node_command: process.execPath,
    call_tool_path: fakeCallTool,
    audit_dir: audit,
    log_path: path.join(audit, `wake-${name}.log`),
    lease_path: path.join(audit, `wake-thread-${name}.lock`),
    result_path: path.join(audit, `wake-${name}.result.json`),
    timeout_ms: 2000,
    termination_grace_ms: 100,
    ...overrides,
  };
}

function launch(wakeRequest, mode = "accept") {
  const messageStatePath = wakeRequest.test_message_state_path ||
    path.join(root, `${wakeRequest.wake_id}.message-state`);
  const routerEventPath = path.join(root, `${wakeRequest.wake_id}.router-events.jsonl`);
  if (!fs.existsSync(messageStatePath)) fs.writeFileSync(messageStatePath, "received\n");
  messageStatePaths.set(wakeRequest.message_id, messageStatePath);
  routerEventPaths.set(wakeRequest.message_id, routerEventPath);
  const correlatedReplyStatePath = wakeRequest.test_correlated_reply
    ? path.join(root, `${wakeRequest.wake_id}.correlated-reply.json`)
    : "";
  if (correlatedReplyStatePath) {
    correlatedReplyStatePaths.set(wakeRequest.message_id, correlatedReplyStatePath);
  }
  const encoded = Buffer.from(JSON.stringify(wakeRequest)).toString("base64");
  const result = spawnSync(process.execPath, [runner, "launch", encoded], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      HAWKSPAN_TEST_CODEX_MODE: mode,
      HAWKSPAN_TEST_MESSAGE_ID: wakeRequest.message_id,
      HAWKSPAN_TEST_MESSAGE_STATE_PATH: messageStatePath,
      HAWKSPAN_TEST_CORRELATED_REPLY_STATE_PATH: correlatedReplyStatePath,
      HAWKSPAN_TEST_LIST_DELAY_MS: String(wakeRequest.test_list_delay_ms || 0),
      HAWKSPAN_TEST_CALL_LOG: calls,
      HAWKSPAN_TEST_ACK_DELAY_MS: mode === "ack-race" ? "900" : "0",
      HAWKSPAN_TEST_ACK_STARTED: raceAckStarted,
      HAWKSPAN_TEST_ACK_FINISHED: raceAckFinished,
    },
  });
  const marker = JSON.parse(result.stdout.trim());
  return { result, marker, messageStatePath, routerEventPath, correlatedReplyStatePath };
}

async function waitResult(wakeRequest, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(wakeRequest.result_path)) {
      return JSON.parse(fs.readFileSync(wakeRequest.result_path, "utf8"));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${wakeRequest.result_path}`);
}

function callNames() {
  if (!fs.existsSync(calls)) return [];
  return fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line).name);
}

function toolCalls(name) {
  if (!fs.existsSync(calls)) return [];
  return fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.name === name);
}

const acceptedRequest = request("accepted", "message-accepted");
const acceptedLaunch = launch(acceptedRequest);
assert.equal(acceptedLaunch.result.status, 0, acceptedLaunch.result.stderr);
assert.equal(acceptedLaunch.marker.status, "started");
const acceptedResult = await waitResult(acceptedRequest);
assert.equal(acceptedResult.status, "acknowledged");
assert.equal(acceptedResult.acknowledged, true);
assert.equal(acceptedResult.lease_released, true);
assert.equal(fs.existsSync(acceptedRequest.lease_path), false);
assert.equal(callNames().filter((name) => name === "acknowledge_message").length, 1);

const mismatchRequest = request("mismatch", "message-mismatch");
const mismatchLaunch = launch(mismatchRequest, "mismatch");
assert.equal(mismatchLaunch.result.status, 0, mismatchLaunch.result.stderr);
const mismatchResult = await waitResult(mismatchRequest);
assert.equal(mismatchResult.status, "invalid_acceptance");
assert.equal(mismatchResult.acknowledged, false);
assert.equal(mismatchResult.lease_released, true);
assert.equal(fs.existsSync(mismatchRequest.lease_path), false);
assert.equal(callNames().filter((name) => name === "acknowledge_message").length, 1);

const lostLeaseRequest = request("lost-lease", "message-lost-lease");
const lostLeaseLaunch = launch(lostLeaseRequest, "lose-lease");
assert.equal(lostLeaseLaunch.result.status, 0, lostLeaseLaunch.result.stderr);
const lostLeaseResult = await waitResult(lostLeaseRequest);
assert.equal(lostLeaseResult.status, "lease_lost");
assert.equal(lostLeaseResult.acknowledged, false);
assert.equal(lostLeaseResult.lease_released, false);
assert.equal(callNames().filter((name) => name === "acknowledge_message").length, 1);
assert.equal(cleanupLease(lostLeaseRequest.lease_path, "successor-token-after-acceptance"), true);

const hungRequest = request("hung", "message-hung", {
  timeout_ms: 200,
  termination_grace_ms: 100,
});
const hungLaunch = launch(hungRequest, "hang");
assert.equal(hungLaunch.result.status, 0, hungLaunch.result.stderr);
const hungResult = await waitResult(hungRequest);
assert.equal(hungResult.status, "timed_out");
assert.equal(hungResult.acknowledged, false);
assert.equal(hungResult.lease_released, true);
assert.equal(fs.existsSync(hungRequest.lease_path), false);
assert.equal(callNames().filter((name) => name === "acknowledge_message").length, 1);

const busyRequest = request("busy", "message-busy");
fs.mkdirSync(busyRequest.lease_path);
fs.writeFileSync(path.join(busyRequest.lease_path, "owner.json"), JSON.stringify({
  token: "active-token",
  pid: process.pid,
  wake_id: "wake-active",
  message_id: "message-active",
  deadline_at: new Date(Date.now() + 60000).toISOString(),
}));
const busyLaunch = launch(busyRequest);
assert.equal(busyLaunch.result.status, 73);
assert.equal(busyLaunch.marker.status, "busy");
assert.equal(busyLaunch.marker.active_message_id, "message-active");
fs.rmSync(busyRequest.lease_path, { recursive: true, force: true });

const expiredLiveRequest = request("expired-live", "message-expired-live");
fs.mkdirSync(expiredLiveRequest.lease_path);
fs.writeFileSync(path.join(expiredLiveRequest.lease_path, "owner.json"), JSON.stringify({
  token: "expired-live-token",
  pid: process.pid,
  wake_id: "wake-expired-live-old",
  message_id: "message-expired-live-old",
  deadline_at: new Date(Date.now() - 1000).toISOString(),
}));
const expiredLiveLaunch = launch(expiredLiveRequest);
assert.equal(expiredLiveLaunch.result.status, 0, expiredLiveLaunch.result.stderr);
assert.equal(expiredLiveLaunch.marker.status, "started");
assert.equal(expiredLiveLaunch.marker.recovered_lease.owner_alive, true);
assert.equal(expiredLiveLaunch.marker.recovered_lease.deadline_expired, true);
assert.equal(expiredLiveLaunch.marker.recovered_lease.token_matched, true);
const expiredLiveResult = await waitResult(expiredLiveRequest);
assert.equal(expiredLiveResult.status, "acknowledged");
assert.equal(expiredLiveResult.lease_released, true);
assert.equal(fs.existsSync(expiredLiveRequest.lease_path), false);

const staleRequest = request("stale", "message-stale");
fs.mkdirSync(staleRequest.lease_path);
fs.writeFileSync(path.join(staleRequest.lease_path, "owner.json"), JSON.stringify({
  token: "stale-token",
  pid: 999999,
  wake_id: "wake-stale-old",
  message_id: "message-stale-old",
}));
const staleLaunch = launch(staleRequest);
assert.equal(staleLaunch.result.status, 0, staleLaunch.result.stderr);
assert.equal(staleLaunch.marker.status, "started");
const staleResult = await waitResult(staleRequest);
assert.equal(staleResult.status, "acknowledged");
assert.equal(staleResult.lease_released, true);
assert.equal(fs.existsSync(staleRequest.lease_path), false);

const fencedLease = path.join(audit, "wake-thread-fenced.lock");
fs.mkdirSync(fencedLease);
fs.writeFileSync(path.join(fencedLease, "owner.json"), JSON.stringify({
  token: "successor-token",
  pid: process.pid,
}));
assert.equal(cleanupLease(fencedLease, "predecessor-token"), false);
assert.equal(fs.existsSync(fencedLease), true);
assert.equal(cleanupLease(fencedLease, "successor-token"), true);
assert.equal(fs.existsSync(fencedLease), false);

const raceRequest = request("ack-race", "message-ack-race");
const raceLaunch = launch(raceRequest, "ack-race");
assert.equal(raceLaunch.result.status, 0, raceLaunch.result.stderr);
const raceStartDeadline = Date.now() + 5000;
while (!fs.existsSync(raceAckStarted) && Date.now() < raceStartDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert(fs.existsSync(raceAckStarted), "guarded acknowledgement must begin");
await new Promise((resolve) => setTimeout(resolve, 500));
const successorRequest = request("ack-race-successor", "message-ack-race-successor", {
  lease_path: raceRequest.lease_path,
});
const successorAttemptedAt = Date.now();
const successorLaunch = launch(successorRequest);
const successorReturnedAt = Date.now();
assert.equal(successorLaunch.result.status, 0, successorLaunch.result.stderr);
assert.equal(successorLaunch.marker.status, "started");
assert(fs.existsSync(raceAckFinished), "successor must wait for guarded acknowledgement");
const raceStartedAt = JSON.parse(fs.readFileSync(raceAckStarted, "utf8")).at;
const raceFinishedAt = JSON.parse(fs.readFileSync(raceAckFinished, "utf8")).at;
assert(raceStartedAt <= successorAttemptedAt);
assert(successorAttemptedAt < raceFinishedAt);
assert(raceFinishedAt <= successorReturnedAt);
const raceResult = await waitResult(raceRequest);
assert.equal(raceResult.status, "acknowledged");
assert.equal(raceResult.acknowledged, true);
const successorResult = await waitResult(successorRequest);
assert.equal(successorResult.status, "acknowledged");
assert.equal(successorResult.lease_released, true);

const ipcRequests = [];
const unavailableTargetThreadId = "00000000-0000-0000-0000-000000000004";
const boundedPollTargetThreadId = "00000000-0000-0000-0000-000000000005";
const controllerThreadId = "thread-target-router";
const ipcServer = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      ipcRequests.push(request);
      let response;
      if (request.method === "initialize") {
        response = {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: request.method,
          handledByClientId: "router-client",
          result: { clientId: "hawkspan-client" },
        };
      } else if (request.method === "thread-owner-discovery") {
        if (request.params.conversationId === unavailableTargetThreadId) {
          continue;
        }
        if (request.params.conversationId === boundedPollTargetThreadId) {
          response = {
            type: "response",
            requestId: request.requestId,
            resultType: "success",
            method: request.method,
            result: {},
          };
        } else {
        response = {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: request.method,
          handledByClientId: request.params.conversationId === controllerThreadId
            ? "controller-owner-client"
            : "owner-client",
          result: {},
        };
        }
      } else if (request.method === "thread-follower-start-turn") {
        const isControllerHandoff = request.params.conversationId === controllerThreadId;
        const handledByClientId = isControllerHandoff
          ? "controller-owner-client"
          : "owner-client";
        response = {
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: request.method,
          handledByClientId,
          result: { result: { turn: { id: "turn-test", status: "inProgress" } } },
        };
        if (isControllerHandoff) {
          const routerPrompt = request.params.turnStartParams.input[0].text;
          const payloadLine = routerPrompt.split("\n")
            .find((line) => line.startsWith("HAWKSPAN_ROUTER_PAYLOAD_JSON="));
          const payload = payloadLine
            ? JSON.parse(payloadLine.slice("HAWKSPAN_ROUTER_PAYLOAD_JSON=".length))
            : null;
          const statePath = messageStatePaths.get(payload?.message_id);
          const eventPath = routerEventPaths.get(payload?.message_id);
          const correlatedReplyPath = correlatedReplyStatePaths.get(payload?.message_id);
          if (![unavailableTargetThreadId, boundedPollTargetThreadId]
            .includes(payload?.target_thread_id) ||
              payload?.target_host_id !== "local" ||
              typeof payload?.prompt !== "string" || !statePath || !eventPath) {
            response = {
              type: "response",
              requestId: request.requestId,
              resultType: "error",
              method: request.method,
              error: "invalid deterministic controller router prompt",
            };
          } else {
            setTimeout(() => {
              fs.appendFileSync(eventPath, `${JSON.stringify({
                name: "send_message_to_thread",
                args: {
                  threadId: payload.target_thread_id,
                  hostId: payload.target_host_id,
                  prompt: payload.prompt,
                },
                result: { threadId: payload.target_thread_id },
              })}\n`);
              fs.appendFileSync(eventPath, `${JSON.stringify({
                name: "acknowledge_message",
                args: { message_id: payload.message_id, deliver: true },
                error: correlatedReplyPath ? "Transport closed" : null,
              })}\n`);
              if (correlatedReplyPath) {
                const acknowledgedAt = new Date().toISOString();
                fs.writeFileSync(correlatedReplyPath, JSON.stringify({
                  state: "acknowledged",
                  created_at: acknowledgedAt,
                  acknowledged_at: acknowledgedAt,
                }));
              } else {
                fs.writeFileSync(statePath, "acknowledged\n");
              }
            }, 50);
          }
        }
      } else {
        response = {
          type: "response",
          requestId: request.requestId,
          resultType: "error",
          error: "unexpected method",
        };
      }
      const json = JSON.stringify(response);
      const frame = Buffer.alloc(4 + Buffer.byteLength(json));
      frame.writeUInt32LE(Buffer.byteLength(json), 0);
      frame.write(json, 4);
      socket.write(frame);
    }
  });
});
await new Promise((resolve, reject) => {
  ipcServer.once("error", reject);
  ipcServer.listen(ipcSocket, resolve);
});

const targetRequest = request("target", "message-target", {
  target_thread_id: "00000000-0000-0000-0000-000000000003",
  handoff_prompt: "HawkSpan durable message message-target. Treat it idempotently.",
  codex_ipc_socket: ipcSocket,
});
const targetLaunch = launch(targetRequest, "hang");
assert.equal(targetLaunch.result.status, 0, targetLaunch.result.stderr);
assert.equal(targetLaunch.marker.status, "started");
const targetResult = await waitResult(targetRequest);
assert.equal(targetResult.status, "acknowledged");
assert.equal(targetResult.acknowledged, true);
assert.equal(targetResult.handoff.status, "accepted");
assert.equal(targetResult.handoff.thread_id, targetRequest.target_thread_id);
assert.equal(targetResult.lease_released, true);
const discovery = ipcRequests.find((entry) => entry.method === "thread-owner-discovery");
assert.equal(discovery.version, 1);
assert.equal(discovery.params.hostId, "local");
assert.equal(discovery.params.conversationId, targetRequest.target_thread_id);
const handoff = ipcRequests.find((entry) => entry.method === "thread-follower-start-turn");
assert.equal(handoff.version, 1);
assert.equal(handoff.targetClientId, "owner-client");
assert.equal(handoff.params.conversationId, targetRequest.target_thread_id);
assert.equal(handoff.params.turnStartParams.clientUserMessageId, targetRequest.message_id);
assert.equal(handoff.params.turnStartParams.input[0].text, targetRequest.handoff_prompt);

const runnerAcknowledgementsBeforeRouter = callNames()
  .filter((name) => name === "acknowledge_message").length;
const routedRequest = request("target-router", "message-target-router", {
  target_thread_id: unavailableTargetThreadId,
  handoff_prompt: "HawkSpan durable message message-target-router. Route this exact prompt once.",
  codex_ipc_socket: ipcSocket,
  timeout_ms: 7000,
  test_correlated_reply: true,
});
assert.equal(routedRequest.thread_id, controllerThreadId);
const routedLaunch = launch(routedRequest, "hang");
assert.equal(routedLaunch.result.status, 0, routedLaunch.result.stderr);
assert.equal(routedLaunch.marker.status, "started");
const routedResult = await waitResult(routedRequest, 10000);
assert.equal(routedResult.status, "acknowledged");
assert.equal(routedResult.acknowledged, true);
assert.equal(routedResult.handoff.status, "accepted");
assert.equal(routedResult.handoff.via, "controller_app");
assert.equal(routedResult.handoff.thread_id, routedRequest.target_thread_id);
assert.equal(routedResult.handoff.controller_thread_id, routedRequest.thread_id);
assert.equal(routedResult.reconciliation.evidence, "acknowledged_correlated_reply");
assert.equal(routedResult.reconciliation.message_id,
  `reply-${routedRequest.message_id}`);
assert.equal(routedResult.acknowledgement_id, "ack-test");
assert.equal(routedResult.lease_released, true);
assert.equal(fs.readFileSync(routedLaunch.messageStatePath, "utf8").trim(), "acknowledged");
assert.equal(callNames().filter((name) => name === "acknowledge_message").length,
  runnerAcknowledgementsBeforeRouter + 1);
const routedRunnerAcknowledgement = toolCalls("acknowledge_message").at(-1);
assert.deepEqual(routedRunnerAcknowledgement.args, {
  message_id: routedRequest.message_id,
  deliver: true,
  note: `Accepted after handoff to Codex task ${routedRequest.target_thread_id}.`,
});
const routedEvidenceQueries = toolCalls("list_messages")
  .filter((entry) => entry.args.direction === "outbound");
assert(routedEvidenceQueries.length >= 1);
assert(routedEvidenceQueries.every((entry) =>
  entry.args.state === "acknowledged" &&
  entry.args.include_pruned === true &&
  entry.args.limit === 1000));

const routedDiscoveries = ipcRequests.filter((entry) =>
  entry.method === "thread-owner-discovery" &&
  [routedRequest.target_thread_id, routedRequest.thread_id].includes(entry.params.conversationId));
assert.deepEqual(routedDiscoveries.map((entry) => entry.params.conversationId), [
  routedRequest.target_thread_id,
  routedRequest.thread_id,
]);
assert.equal(ipcRequests.some((entry) =>
  entry.method === "thread-follower-start-turn" &&
  entry.params.conversationId === routedRequest.target_thread_id), false);
const controllerHandoff = ipcRequests.find((entry) =>
  entry.method === "thread-follower-start-turn" &&
  entry.params.conversationId === routedRequest.thread_id);
assert(controllerHandoff);
assert.equal(controllerHandoff.targetClientId, "controller-owner-client");
assert.equal(controllerHandoff.params.turnStartParams.clientUserMessageId,
  routedRequest.message_id);
const expectedPayload = {
  schema_version: 1,
  message_id: routedRequest.message_id,
  target_thread_id: routedRequest.target_thread_id,
  target_host_id: "local",
  prompt: routedRequest.handoff_prompt,
};
assert.equal(controllerHandoff.params.turnStartParams.input[0].text,
  buildControllerRouterPrompt(routedRequest));
assert(controllerHandoff.params.turnStartParams.input[0].text.includes(
  `HAWKSPAN_ROUTER_PAYLOAD_JSON=${JSON.stringify(expectedPayload)}`));
assert.equal(controllerHandoff.params.turnStartParams.input[0].text
  .match(/send_message_to_thread/g)?.length, 2);
assert.equal(controllerHandoff.params.turnStartParams.input[0].text
  .match(/acknowledge_message/g)?.length, 1);
const routerEvents = fs.readFileSync(routedLaunch.routerEventPath, "utf8").trim().split("\n")
  .map((line) => JSON.parse(line));
assert.deepEqual(routerEvents, [
  {
    name: "send_message_to_thread",
    args: {
      threadId: routedRequest.target_thread_id,
      hostId: "local",
      prompt: routedRequest.handoff_prompt,
    },
    result: { threadId: routedRequest.target_thread_id },
  },
  {
    name: "acknowledge_message",
    args: { message_id: routedRequest.message_id, deliver: true },
    error: "Transport closed",
  },
]);

const ipcCountBeforeReplay = ipcRequests.length;
const acknowledgementCountBeforeReplay = toolCalls("acknowledge_message").length;
const replayRequest = request("target-router-replay", routedRequest.message_id, {
  target_thread_id: routedRequest.target_thread_id,
  handoff_prompt: routedRequest.handoff_prompt,
  codex_ipc_socket: ipcSocket,
  test_message_state_path: routedLaunch.messageStatePath,
});
const replayLaunch = launch(replayRequest, "hang");
assert.equal(replayLaunch.result.status, 0, replayLaunch.result.stderr);
assert.equal(replayLaunch.marker.status, "started");
const replayResult = await waitResult(replayRequest);
assert.equal(replayResult.status, "already_acknowledged");
assert.equal(replayResult.acknowledged, true);
assert.equal(replayResult.lease_released, true);
assert.equal(ipcRequests.length, ipcCountBeforeReplay);
assert.equal(toolCalls("acknowledge_message").length, acknowledgementCountBeforeReplay);

const runnerAcknowledgementsBeforeBoundedPoll = callNames()
  .filter((name) => name === "acknowledge_message").length;
const boundedPollRequest = request("target-router-bounded", "message-target-router-bounded", {
  target_thread_id: boundedPollTargetThreadId,
  handoff_prompt: "HawkSpan durable message message-target-router-bounded. Route once.",
  codex_ipc_socket: ipcSocket,
  timeout_ms: 1000,
  test_list_delay_ms: 1500,
});
const boundedPollStartedAt = Date.now();
const boundedPollLaunch = launch(boundedPollRequest, "hang");
assert.equal(boundedPollLaunch.result.status, 0, boundedPollLaunch.result.stderr);
assert.equal(boundedPollLaunch.marker.status, "started");
const boundedPollResult = await waitResult(boundedPollRequest, 4000);
assert.equal(boundedPollResult.status, "router_timed_out");
assert.equal(boundedPollResult.acknowledged, false);
assert.equal(boundedPollResult.lease_released, true);
assert(Date.now() - boundedPollStartedAt < 2500);
assert.equal(callNames().filter((name) => name === "acknowledge_message").length,
  runnerAcknowledgementsBeforeBoundedPoll);
await new Promise((resolve) => ipcServer.close(resolve));

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write("bounded and fenced wake-runner tests passed\n");
