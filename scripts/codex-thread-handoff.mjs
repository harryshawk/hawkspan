#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function boundedTimeout(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(numeric, 1000), 120000);
}

function frame(value) {
  const json = JSON.stringify(value);
  const length = Buffer.byteLength(json, "utf8");
  if (length <= 0 || length > MAX_FRAME_BYTES) {
    throw new Error(`Codex IPC frame is outside the supported size: ${length}`);
  }
  const output = Buffer.allocUnsafe(4 + length);
  output.writeUInt32LE(length, 0);
  output.write(json, 4, "utf8");
  return output;
}

function validateRequest(raw) {
  if (!raw || raw.schema_version !== 1) {
    throw new Error("Codex handoff request schema_version must be 1");
  }
  for (const key of ["thread_id", "message_id", "prompt"]) {
    if (typeof raw[key] !== "string" || !raw[key].trim()) {
      throw new Error(`Codex handoff request requires ${key}`);
    }
  }
  const socketPath = raw.socket_path;
  if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) {
    throw new Error("Codex handoff requires an explicit absolute socket_path");
  }
  let socketStat;
  try {
    socketStat = fs.lstatSync(socketPath);
  } catch (error) {
    throw new Error(`Codex handoff socket_path is unavailable: ${String(error?.message || error)}`);
  }
  if (!socketStat.isSocket()) {
    throw new Error("Codex handoff socket_path is not a Unix socket");
  }
  if (typeof process.getuid === "function" && socketStat.uid !== process.getuid()) {
    throw new Error("Codex handoff socket_path is not owned by the current user");
  }
  return {
    ...raw,
    thread_id: raw.thread_id.trim(),
    message_id: raw.message_id.trim(),
    prompt: raw.prompt,
    host_id: typeof raw.host_id === "string" && raw.host_id.trim()
      ? raw.host_id.trim()
      : "local",
    socket_path: socketPath,
    timeout_ms: boundedTimeout(raw.timeout_ms),
  };
}

class CodexIpcClient {
  constructor(socketPath, timeoutMs) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.clientId = "initializing-client";
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Codex IPC connection timed out"));
      }, Math.min(this.timeoutMs, 5000));
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on("data", (chunk) => this.onData(chunk));
      socket.on("close", () => this.rejectPending(new Error("Codex IPC connection closed")));
    });
    const initialized = await this.request("initialize", {
      clientType: "hawkspan-receiver",
    }, { version: 0, timeoutMs: Math.min(this.timeoutMs, 5000) });
    if (initialized.resultType !== "success" ||
        typeof initialized.result?.clientId !== "string" || !initialized.result.clientId) {
      throw new Error(initialized.error || "Codex IPC initialization was rejected");
    }
    this.clientId = initialized.result.clientId;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length <= 0 || length > MAX_FRAME_BYTES) {
        this.socket?.destroy(new Error(`Invalid Codex IPC frame length: ${length}`));
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const payload = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(payload);
      } catch (error) {
        this.socket?.destroy(new Error(`Invalid Codex IPC JSON: ${error.message}`));
        return;
      }
      if (message?.type !== "response" || typeof message.requestId !== "string") continue;
      const pending = this.pending.get(message.requestId);
      if (!pending) continue;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  rejectPending(error) {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  request(method, params, { targetClientId = null, timeoutMs = this.timeoutMs, version = 0 } = {}) {
    if (!this.socket?.writable) return Promise.reject(new Error("Codex IPC is not connected"));
    const requestId = crypto.randomUUID();
    const request = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params,
      ...(targetClientId ? { targetClientId } : {}),
      timeoutMs,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timed out`));
      }, timeoutMs + 250);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(frame(request), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  close() {
    this.rejectPending(new Error("Codex IPC client closed"));
    this.socket?.end();
    this.socket = null;
  }
}

export async function handoffToCodexThread(rawRequest) {
  const request = validateRequest(rawRequest);
  const client = new CodexIpcClient(request.socket_path, request.timeout_ms);
  try {
    await client.connect();
    const owner = await client.request("thread-owner-discovery", {
      hostId: request.host_id,
      conversationId: request.thread_id,
    }, { version: 1, timeoutMs: Math.min(request.timeout_ms, 5000) });
    if (owner.resultType !== "success" || typeof owner.handledByClientId !== "string" ||
        !owner.handledByClientId) {
      throw new Error(owner.error || `No Codex app owner found for task ${request.thread_id}`);
    }

    const handoff = await client.request("thread-follower-start-turn", {
      conversationId: request.thread_id,
      turnStartParams: {
        clientUserMessageId: request.message_id,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        inheritThreadSettings: true,
      },
      mcpAppModelContextAttachments: [],
    }, {
      targetClientId: owner.handledByClientId,
      version: 1,
      timeoutMs: request.timeout_ms,
    });
    if (handoff.resultType !== "success") {
      throw new Error(handoff.error || `Codex app rejected handoff to task ${request.thread_id}`);
    }
    return {
      schema_version: 1,
      status: "accepted",
      message_id: request.message_id,
      thread_id: request.thread_id,
      handled_by_client_id: handoff.handledByClientId || owner.handledByClientId,
    };
  } finally {
    client.close();
  }
}

async function main() {
  const encoded = process.argv[2] || "";
  try {
    const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const result = await handoffToCodexThread(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
