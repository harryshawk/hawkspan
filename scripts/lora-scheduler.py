#!/usr/bin/env python3
"""Durable, exact-revision SimpleTuner queue scheduler for the M4.

The scheduler cannot run arbitrary commands. Each queued entry identifies one
manifest target, one recorded authorization job, and one immutable readiness
fingerprint. The fixed trainer adapter rechecks the fingerprint before launch.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import sys

from hawkspan_scheduler_state import edit_scheduler_state


CONFIG = pathlib.Path(
    os.environ.get(
        "HAWKSPAN_CONFIG",
        os.environ.get("HAWKSPAN_CONFIG_PATH", os.environ.get("HAWKSPAN_CONFIG", "~/.hawkspan/config.json")),
    )
).expanduser()


def load(path: pathlib.Path, fallback):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def training_active(process_match: str) -> bool:
    result = subprocess.run(
        ["/bin/ps", "-axo", "command="],
        text=True,
        capture_output=True,
        check=False,
    )
    matcher = re.compile(process_match)
    return any(
        matcher.search(line)
        and "codex exec resume" not in line
        and "/Applications/ChatGPT.app/Contents/Resources/codex" not in line
        for line in result.stdout.splitlines()
    )


def main() -> int:
    selected_config_path = CONFIG
    base_config = load(selected_config_path, {})
    config = base_config
    pointer_path = pathlib.Path(
        config.get("lora_automation", {}).get(
            "active_runtime_pointer",
            selected_config_path.parent / "active-lora-runtime.json",
        )
    ).expanduser()
    pointer = load(pointer_path, {})
    if pointer.get("config_path"):
        candidate = pathlib.Path(pointer["config_path"]).expanduser()
        runtime_config = load(candidate, None)
        if runtime_config:
            config = runtime_config
            selected_config_path = candidate
    automation = config.get("lora_automation", {})
    base_automation = base_config.get("lora_automation", {})
    queue_root = pathlib.Path(automation["queue_root"])
    scheduler_root = pathlib.Path(
        base_automation.get("scheduler_root", CONFIG.parent / "lora-scheduler")
    ).expanduser()
    jobs_path = pathlib.Path(
        base_automation.get("scheduler_jobs_path", scheduler_root / "lora-jobs.json")
    )
    state_path = pathlib.Path(
        base_automation.get("scheduler_state_path", scheduler_root / "lora-scheduler-state.json")
    )
    policy_path = pathlib.Path(
        base_automation.get("scheduler_policy_path", scheduler_root / "lora-queue-policy.json")
    )
    queue_control_path = pathlib.Path(
        base_automation.get("scheduler_queue_control_path", scheduler_root / "queue-control.json")
    )
    job_control_root = pathlib.Path(
        base_automation.get("scheduler_job_control_root", scheduler_root / "jobs")
    )
    jobs_doc = load(jobs_path, {"schema_version": 1, "jobs": []})
    policy = load(
        policy_path,
        {
            "schema_version": 1,
            "maximum_attempts": 3,
        },
    )
    if training_active(config.get("training", {}).get(
        "process_match", "simpletuner|train.py|accelerate launch"
    )):
        with edit_scheduler_state(state_path, {
            "schema_version": 1, "created_at": now(), "jobs": {}, "current": None,
        }) as state:
            state["last_checked_at"] = now()
            state["decision"] = "training already active"
        return 0

    selected = None
    with edit_scheduler_state(state_path, {
        "schema_version": 1, "created_at": now(), "jobs": {}, "current": None,
    }) as state:
        state["last_checked_at"] = now()
        queue_control = load(
            queue_control_path,
            {"schema_version": 1, "state": "running"},
        )
        if queue_control.get("state") == "paused":
            state["decision"] = "queue explicitly paused"
        else:
            candidates = []
            for candidate_job in jobs_doc.get("jobs", []):
                candidate_id = candidate_job.get("job_id")
                record = state["jobs"].get(candidate_id, {})
                if record.get("state") in {"running", "returning", "completed"}:
                    continue
                target = candidate_job.get("target")
                job_control = load(job_control_root / f"{target}.json", {"state": "ready"})
                if job_control.get("state") in {
                    "paused", "stopped", "skipped", "cancelled", "completed", "failed",
                    "interrupted_no_checkpoint", "interrupted_recoverable",
                }:
                    continue
                if not candidate_job.get("authorized", False):
                    continue
                attempts = int(record.get("attempts", 0))
                if attempts >= int(candidate_job.get(
                    "maximum_attempts", policy.get("maximum_attempts", 3)
                )):
                    continue
                authorization_job_id = candidate_job.get("authorization_job_id")
                revision_fingerprint = candidate_job.get("revision_fingerprint")
                safe = re.compile(r"^[A-Za-z0-9._-]+$")
                if not all(
                    isinstance(value, str) and safe.fullmatch(value)
                    for value in (target, authorization_job_id, revision_fingerprint)
                ):
                    continue
                candidates.append((
                    int(candidate_job.get("priority", 1000)), candidate_id, candidate_job,
                ))
            if candidates:
                _, job_id, job = sorted(candidates, key=lambda row: (row[0], row[1]))[0]
                record = state["jobs"].setdefault(job_id, {})
                record["attempts"] = int(record.get("attempts", 0)) + 1
                record["state"] = "running"
                record["started_at"] = now()
                state["current"] = job_id
                state["decision"] = "started authorized job"
                selected = (job_id, job)
            else:
                state["decision"] = "no authorized pending jobs"
                state["current"] = None

    if selected is None:
        return 0
    job_id, job = selected

    log_path = pathlib.Path(job.get("log_path", queue_root / "logs" / f"{job_id}.log"))
    log_path.parent.mkdir(parents=True, exist_ok=True)
    start_script = pathlib.Path(config["training"]["start_script"])
    command = [
        str(start_script),
        "--job-id",
        job["authorization_job_id"],
        "--target",
        job["target"],
        "--expected-revision-fingerprint",
        job["revision_fingerprint"],
    ]
    child_env = os.environ.copy()
    child_env["HAWKSPAN_CONFIG"] = str(selected_config_path)
    child_env["HAWKSPAN_SIMPLETUNER_QUEUE_ITEM_ID"] = job_id
    with log_path.open("a") as log:
        result = subprocess.run(
            command,
            cwd=str(queue_root),
            env=child_env,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )

    with edit_scheduler_state(state_path, {
        "schema_version": 1, "created_at": now(), "jobs": {}, "current": None,
    }) as state:
        record = state["jobs"].setdefault(job_id, {})
        record["finished_at"] = now()
        record["exit_code"] = result.returncode
        record["state"] = "running" if result.returncode == 0 else "failed"
        record["phase"] = "training" if result.returncode == 0 else "start-failed"
        record["target"] = job["target"]
        record["revision_fingerprint"] = job["revision_fingerprint"]
        state["current"] = job["target"] if result.returncode == 0 else None
        state["decision"] = record["state"]
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
