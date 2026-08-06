#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readHawkspanEnv } from "./hawkspan-env.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const stateRoot = path.resolve(process.env.HAWKSPAN_STATE_DIR || path.join(os.homedir(), ".hawkspan"));
const configPath = path.resolve(
  process.env.HAWKSPAN_CONFIG || process.env.HAWKSPAN_CONFIG_PATH || path.join(stateRoot, "config.json"),
);
const values = readHawkspanEnv(path.join(stateRoot, "hawkspan.env"));
const enabled = values.HAWKSPAN_QUEUE_SUPERVISOR_ENABLED !== "false";
const pollIntervalMs = Number(values.HAWKSPAN_QUEUE_SUPERVISOR_POLL_INTERVAL_MS || 120000);
const maxItems = Number(values.HAWKSPAN_QUEUE_MAX_ITEMS_PER_WORKER || 10);
const restartDelays = String(values.HAWKSPAN_QUEUE_WORKER_RESTART_DELAYS_MS || "2000,5000,10000,20000")
  .split(",").map((entry) => Number(entry.trim()));
const logPath = path.join(stateRoot, "audit", "queue-supervisor.log");

function writeLog(event) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function callTool(name, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(scriptRoot, "call-tool.mjs"), name, JSON.stringify(args),
    ], {
      env: {
        ...process.env,
        HAWKSPAN_STATE_DIR: stateRoot,
        HAWKSPAN_CONFIG: configPath,
        HAWKSPAN_CALL_TIMEOUT_MS: String(Math.max(pollIntervalMs, 300000)),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        resolve({ ok: false, code, signal, error: stderr.trim() || stdout.trim() });
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        resolve({ ok: true, result: envelope.structuredContent || envelope });
      } catch (error) {
        resolve({ ok: false, code, signal, error: `invalid worker response: ${error.message}` });
      }
    });
  });
}

async function runWorker(queue, slot) {
  const workerId = `${os.hostname().replace(/[^A-Za-z0-9._-]/g, "-")}-${queue.queue_id}-${slot}`;
  const delays = [0, ...restartDelays];
  let last;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    await wait(delays[attempt]);
    last = await callTool("supervise_queue", {
      queue_id: queue.queue_id,
      worker_id: workerId,
      max_items: maxItems,
    });
    writeLog({ event: "worker", queue_id: queue.queue_id, slot, restart_attempt: attempt, ...last });
    if (last.ok) return last;
  }
  return last;
}

async function cycle() {
  const listed = await callTool("list_queues", { state: "running" });
  if (!listed.ok) {
    writeLog({ event: "list_queues_failed", ...listed });
    return { nextDelay: restartDelays[0] || pollIntervalMs };
  }
  const queues = listed.result.queues || [];
  const workers = [];
  for (const queue of queues) {
    if (!Number(queue.counts?.queued || 0) && !Number(queue.counts?.running || 0)) continue;
    for (let slot = 1; slot <= Number(queue.concurrency || 1); slot += 1) {
      workers.push(runWorker(queue, slot));
    }
  }
  await Promise.all(workers);
  const nextTimes = queues
    .map((queue) => Date.parse(queue.next_attempt_at || ""))
    .filter(Number.isFinite)
    .map((value) => Math.max(100, value - Date.now()));
  return { nextDelay: Math.min(pollIntervalMs, ...(nextTimes.length ? nextTimes : [pollIntervalMs])) };
}

if (!enabled) {
  writeLog({ event: "disabled" });
  while (true) await wait(pollIntervalMs);
}

writeLog({ event: "started", poll_interval_ms: pollIntervalMs, restart_delays_ms: restartDelays });
while (true) {
  const { nextDelay } = await cycle();
  await wait(nextDelay);
}
