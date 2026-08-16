#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_TERMINATION_GRACE_MS = 5000;

function waitMilliseconds(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function leaseDeadlineExpired(owner, currentTime = Date.now()) {
  const deadline = Date.parse(String(owner?.deadline_at || ""));
  return !Number.isFinite(deadline) || currentTime >= deadline;
}

function leaseOwner(leasePath) {
  return readJson(path.join(leasePath, "owner.json"));
}

export function leaseIsCurrent(leasePath, token, currentTime = Date.now()) {
  const owner = leaseOwner(leasePath);
  return owner?.token === token && !leaseDeadlineExpired(owner, currentTime);
}

function acquireGuard(guardPath, token, waitMs = 2000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(guardPath, { mode: 0o700 });
      writeJsonAtomic(path.join(guardPath, "owner.json"), {
        token,
        pid: process.pid,
        created_at: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readJson(path.join(guardPath, "owner.json"));
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(guardPath).mtimeMs;
      } catch {
        // A concurrent owner may have just released the guard.
      }
      if (ageMs >= 1000 && (!owner || !isProcessAlive(owner.pid))) {
        fs.rmSync(guardPath, { recursive: true, force: true });
        continue;
      }
      waitMilliseconds(20);
    }
  }
  return false;
}

function releaseGuard(guardPath, token) {
  const owner = readJson(path.join(guardPath, "owner.json"));
  if (owner?.token !== token) return false;
  fs.rmSync(guardPath, { recursive: true, force: true });
  return true;
}

export function cleanupLease(leasePath, token) {
  const guardPath = `${leasePath}.guard`;
  const guardToken = crypto.randomBytes(16).toString("hex");
  if (!acquireGuard(guardPath, guardToken)) return false;
  try {
    const owner = leaseOwner(leasePath);
    if (owner?.token !== token) return false;
    fs.rmSync(leasePath, { recursive: true, force: true });
    return true;
  } finally {
    releaseGuard(guardPath, guardToken);
  }
}

function safeInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return fallback;
  return Math.min(Math.max(numeric, minimum), maximum);
}

function validateRequest(raw) {
  if (!raw || raw.schema_version !== 1) throw new Error("wake request schema_version must be 1");
  for (const key of [
    "wake_id", "message_id", "thread_id", "prompt", "codex_command", "node_command",
    "call_tool_path", "audit_dir", "log_path", "lease_path", "result_path",
  ]) {
    if (typeof raw[key] !== "string" || !raw[key]) {
      throw new Error(`wake request requires ${key}`);
    }
  }
  for (const key of [
    "call_tool_path", "audit_dir", "log_path", "lease_path", "result_path",
  ]) {
    if (!path.isAbsolute(raw[key])) throw new Error(`wake request ${key} must be absolute`);
  }
  const auditDir = path.resolve(raw.audit_dir);
  for (const key of ["log_path", "lease_path", "result_path"]) {
    if (path.dirname(path.resolve(raw[key])) !== auditDir) {
      throw new Error(`wake request ${key} must be directly inside audit_dir`);
    }
  }
  return {
    ...raw,
    timeout_ms: safeInteger(raw.timeout_ms, DEFAULT_TIMEOUT_MS, 100, 30 * 60 * 1000),
    termination_grace_ms: safeInteger(
      raw.termination_grace_ms,
      DEFAULT_TERMINATION_GRACE_MS,
      50,
      60000,
    ),
  };
}

function responseMarker(status, fields = {}) {
  return { schema_version: 1, status, ...fields };
}

export function launchWake(rawRequest) {
  const request = validateRequest(rawRequest);
  fs.mkdirSync(request.audit_dir, { recursive: true, mode: 0o700 });
  const guardPath = `${request.lease_path}.guard`;
  const guardToken = crypto.randomBytes(16).toString("hex");
  if (!acquireGuard(guardPath, guardToken)) {
    return responseMarker("failed", {
      wake_id: request.wake_id,
      message_id: request.message_id,
      error: "wake lease guard is unavailable",
    });
  }

  const token = crypto.randomBytes(24).toString("hex");
  let createdLease = false;
  let recoveredLease = null;
  try {
    if (fs.existsSync(request.lease_path)) {
      const existing = leaseOwner(request.lease_path);
      const existingAlive = existing && isProcessAlive(existing.pid);
      const existingExpired = leaseDeadlineExpired(existing);
      if (existingAlive && !existingExpired) {
        return responseMarker("busy", {
          wake_id: request.wake_id,
          message_id: request.message_id,
          active_wake_id: existing.wake_id || null,
          active_message_id: existing.message_id || null,
          active_deadline_at: existing.deadline_at || null,
        });
      }
      if (!existing) {
        const ageMs = Date.now() - fs.statSync(request.lease_path).mtimeMs;
        if (ageMs < DEFAULT_TIMEOUT_MS + DEFAULT_TERMINATION_GRACE_MS) {
          return responseMarker("busy", {
            wake_id: request.wake_id,
            message_id: request.message_id,
            active_wake_id: null,
            active_message_id: null,
          });
        }
      }
      const observedToken = existing?.token || null;
      const current = leaseOwner(request.lease_path);
      if ((current?.token || null) !== observedToken) {
        throw new Error("wake lease owner changed during stale recovery");
      }
      recoveredLease = {
        wake_id: existing?.wake_id || null,
        message_id: existing?.message_id || null,
        token_matched: true,
        owner_alive: Boolean(existingAlive),
        deadline_expired: Boolean(existingExpired),
      };
      fs.rmSync(request.lease_path, { recursive: true, force: true });
    }

    fs.mkdirSync(request.lease_path, { mode: 0o700 });
    createdLease = true;
    const requestPath = path.join(request.lease_path, "request.json");
    const schemaPath = path.join(request.lease_path, "acceptance.schema.json");
    writeJsonAtomic(requestPath, request);
    writeJsonAtomic(schemaPath, {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["message_id", "status"],
      properties: {
        message_id: { type: "string", const: request.message_id },
        status: { type: "string", const: "accepted" },
      },
      additionalProperties: false,
    });
    const leaseDurationMs = request.timeout_ms + request.termination_grace_ms + 35000;
    writeJsonAtomic(path.join(request.lease_path, "owner.json"), {
      schema_version: 1,
      token,
      wake_id: request.wake_id,
      message_id: request.message_id,
      thread_id: request.thread_id,
      pid: process.pid,
      state: "starting",
      started_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + leaseDurationMs).toISOString(),
    });

    const logFd = fs.openSync(request.log_path, "a", 0o600);
    let worker;
    try {
      worker = spawn(process.execPath, [SCRIPT_PATH, "run", request.lease_path, token], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } finally {
      fs.closeSync(logFd);
    }
    if (!worker.pid) throw new Error("wake worker did not start");
    writeJsonAtomic(path.join(request.lease_path, "owner.json"), {
      schema_version: 1,
      token,
      wake_id: request.wake_id,
      message_id: request.message_id,
      thread_id: request.thread_id,
      pid: worker.pid,
      state: "running",
      started_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + leaseDurationMs).toISOString(),
    });
    worker.unref();
    return responseMarker("started", {
      wake_id: request.wake_id,
      message_id: request.message_id,
      pid: worker.pid,
      log_path: request.log_path,
      result_path: request.result_path,
      recovered_lease: recoveredLease,
    });
  } catch (error) {
    if (createdLease) {
      const owner = readJson(path.join(request.lease_path, "owner.json"));
      if (!owner || owner.token === token) {
        fs.rmSync(request.lease_path, { recursive: true, force: true });
      }
    }
    return responseMarker("failed", {
      wake_id: request.wake_id,
      message_id: request.message_id,
      error: String(error?.message || error),
    });
  } finally {
    releaseGuard(guardPath, guardToken);
  }
}

function terminateProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

function waitForChild(child, timeoutMs, terminationGraceMs) {
  return new Promise((resolve) => {
    let timedOut = false;
    let spawnError = null;
    let killTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), terminationGraceMs);
    }, timeoutMs);
    child.once("error", (error) => {
      spawnError = String(error?.message || error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, signal, timed_out: timedOut, error: spawnError });
    });
  });
}

function callLocalTool(request, toolName, args) {
  const result = spawnSync(
    request.node_command,
    [request.call_tool_path, toolName, JSON.stringify(args)],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error) {
    return { ok: false, error: String(result.error.message || result.error) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr?.trim() || `${toolName} exited ${result.status}`,
    };
  }
  try {
    const response = JSON.parse(result.stdout);
    if (response.isError) {
      return { ok: false, error: response.content?.[0]?.text || `${toolName} failed` };
    }
    return { ok: true, result: response.structuredContent ?? response };
  } catch (error) {
    return { ok: false, error: `invalid ${toolName} response: ${error.message}` };
  }
}

function acknowledgeUnderLeaseGuard(request, leasePath, token) {
  const guardPath = `${leasePath}.guard`;
  const guardToken = crypto.randomBytes(16).toString("hex");
  if (!acquireGuard(guardPath, guardToken)) {
    return { ok: false, status: "lease_guard_unavailable" };
  }
  try {
    if (!leaseIsCurrent(leasePath, token)) {
      return { ok: false, status: "lease_lost" };
    }
    const acknowledgement = callLocalTool(request, "acknowledge_message", {
      message_id: request.message_id,
      deliver: true,
      note: "Accepted by the addressed Codex task.",
    });
    if (!acknowledgement.ok) {
      return {
        ok: false,
        status: "acknowledgement_failed",
        error: acknowledgement.error,
      };
    }
    return { ok: true, acknowledgement };
  } finally {
    releaseGuard(guardPath, guardToken);
  }
}

function writeWakeResult(request, result) {
  writeJsonAtomic(request.result_path, {
    schema_version: 1,
    wake_id: request.wake_id,
    message_id: request.message_id,
    thread_id: request.thread_id,
    completed_at: new Date().toISOString(),
    ...result,
  });
}

export async function runWake(leasePath, token) {
  let request = null;
  let result = { status: "failed", error: "wake request did not initialize" };
  try {
    const ownerPath = path.join(leasePath, "owner.json");
    const ownerDeadline = Date.now() + 2000;
    let owner = readJson(ownerPath);
    while (Date.now() < ownerDeadline &&
      (owner?.token !== token || Number(owner?.pid) !== process.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      owner = readJson(ownerPath);
    }
    if (owner?.token !== token || Number(owner?.pid) !== process.pid) {
      throw new Error("wake lease ownership was not established");
    }
    request = validateRequest(readJson(path.join(leasePath, "request.json")));
    const schemaPath = path.join(leasePath, "acceptance.schema.json");
    const outputPath = path.join(leasePath, "last-message.json");

    const inbox = callLocalTool(request, "list_messages", {
      direction: "inbound",
      limit: 1000,
    });
    if (!inbox.ok) {
      result = { status: "message_import_failed", error: inbox.error };
      return;
    }
    const imported = Array.isArray(inbox.result)
      ? inbox.result.find((entry) => entry.id === request.message_id)
      : null;
    if (!imported) {
      result = { status: "message_not_found", acknowledged: false };
      return;
    }
    if (imported.state === "acknowledged") {
      result = { status: "already_acknowledged", acknowledged: true };
      return;
    }

    const child = spawn(request.codex_command, [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      request.thread_id,
      request.prompt,
    ], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const processResult = await waitForChild(
      child,
      request.timeout_ms,
      request.termination_grace_ms,
    );
    if (processResult.timed_out) {
      result = { status: "timed_out", acknowledged: false, process: processResult };
      return;
    }
    if (processResult.error || processResult.code !== 0) {
      result = { status: "process_failed", acknowledged: false, process: processResult };
      return;
    }

    let acceptance;
    try {
      acceptance = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    } catch (error) {
      result = {
        status: "invalid_acceptance",
        acknowledged: false,
        error: String(error?.message || error),
      };
      return;
    }
    if (acceptance?.message_id !== request.message_id || acceptance?.status !== "accepted" ||
        Object.keys(acceptance).some((key) => key !== "message_id" && key !== "status")) {
      result = { status: "invalid_acceptance", acknowledged: false };
      return;
    }
    const guardedAcknowledgement = acknowledgeUnderLeaseGuard(request, leasePath, token);
    if (!guardedAcknowledgement.ok) {
      result = {
        status: guardedAcknowledgement.status,
        acknowledged: false,
        ...(guardedAcknowledgement.error ? { error: guardedAcknowledgement.error } : {}),
      };
      return;
    }
    result = {
      status: "acknowledged",
      acknowledged: true,
      acknowledgement_id: guardedAcknowledgement.acknowledgement.result?.message_id || null,
    };
  } catch (error) {
    result = { status: "failed", acknowledged: false, error: String(error?.message || error) };
  } finally {
    const leaseReleased = cleanupLease(leasePath, token);
    if (request) {
      try {
        writeWakeResult(request, { ...result, lease_released: leaseReleased });
      } catch (error) {
        process.stderr.write(`failed to write wake result: ${error.message}\n`);
      }
    }
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "launch") {
    let request;
    try {
      request = JSON.parse(Buffer.from(args[0] || "", "base64").toString("utf8"));
    } catch (error) {
      const marker = responseMarker("failed", { error: `invalid wake request: ${error.message}` });
      process.stdout.write(`${JSON.stringify(marker)}\n`);
      process.exitCode = 2;
      return;
    }
    const marker = launchWake(request);
    process.stdout.write(`${JSON.stringify(marker)}\n`);
    if (marker.status === "busy") process.exitCode = 73;
    if (marker.status === "failed") process.exitCode = 1;
    return;
  }
  if (command === "run") {
    const [leasePath, token] = args;
    if (!leasePath || !token) throw new Error("run requires lease path and token");
    await runWake(leasePath, token);
    return;
  }
  process.stderr.write("usage: wake-runner.mjs launch BASE64_REQUEST\n");
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
