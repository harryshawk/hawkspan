#!/usr/bin/env python3
"""Durable queue and per-job controls for the M4 LoRA scheduler."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import tempfile
import time

from hawkspan_scheduler_state import edit_scheduler_state


CONFIG = pathlib.Path(
    os.environ.get("HAWKSPAN_CONFIG", "~/.hawkspan/config.json")
).expanduser()
SAFE = re.compile(r"^[A-Za-z0-9._-]+$")
TARGET_IN_COMMAND = re.compile(r"--only-job\s+([A-Za-z0-9._-]+)")


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def load(path: pathlib.Path, fallback):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def atomic(path: pathlib.Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", dir=path.parent, delete=False, prefix=f".{path.name}.", suffix=".tmp"
    ) as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
        temporary = pathlib.Path(handle.name)
    temporary.replace(path)


def active_trainer_targets() -> dict[str, dict]:
    result = subprocess.run(
        [os.environ.get("HAWKSPAN_PS", "/bin/ps"), "-axo", "pid=,ppid=,pgid=,command="],
        text=True,
        capture_output=True,
        check=False,
    )
    active = {}
    for raw in result.stdout.splitlines():
        line = raw.strip()
        match = TARGET_IN_COMMAND.search(line)
        if not match:
            continue
        fields = line.split(None, 3)
        if len(fields) < 4:
            continue
        target = match.group(1)
        active[target] = {
            "pid": int(fields[0]),
            "ppid": int(fields[1]),
            "pgid": int(fields[2]),
            "command": fields[3],
        }
    return active


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=(
            "pause-job",
            "resume-job",
            "skip-job",
            "retry-job",
            "pause-queue",
            "resume-queue",
            "status",
        ),
    )
    parser.add_argument("--target")
    parser.add_argument("--reason", default="")
    parser.add_argument("--repair-stale", action="store_true")
    args = parser.parse_args()

    config = load(CONFIG, {})
    automation = config.get("lora_automation", {})
    root = pathlib.Path(
        automation.get("scheduler_root", "~/.hawkspan/lora-scheduler")
    ).expanduser()
    queue_path = pathlib.Path(
        automation.get("scheduler_queue_control_path", root / "queue-control.json")
    )
    jobs_root = pathlib.Path(
        automation.get("scheduler_job_control_root", root / "jobs")
    )
    scheduler_jobs_path = pathlib.Path(
        automation.get("scheduler_jobs_path", root / "lora-jobs.json")
    )
    scheduler_state_path = pathlib.Path(
        automation.get("scheduler_state_path", root / "lora-scheduler-state.json")
    )

    if args.action == "status":
        active_targets = active_trainer_targets()
        controls = {}
        repaired = []
        jobs_doc = load(scheduler_jobs_path, {"schema_version": 2, "jobs": []})
        items = []
        with edit_scheduler_state(
            scheduler_state_path,
            {"schema_version": 1, "jobs": {}, "current": None},
        ) as scheduler_state:
            if jobs_root.exists():
                for path in sorted(jobs_root.glob("*.json")):
                    job = load(path, {})
                    target = job.get("target", path.stem)
                    if job.get("state") == "running":
                        if target in active_targets:
                            job["active_process"] = active_targets[target]
                        else:
                            job["reported_state"] = "stale_running"
                            job["stale_reason"] = "job-control record says running but no matching active trainer process exists"
                            if args.repair_stale:
                                repaired_job = {
                                    **job, "state": "stale", "previous_state": "running",
                                    "stale_reason": job["stale_reason"], "updated_at": int(time.time()),
                                }
                                atomic(path, repaired_job)
                                job = repaired_job
                                repaired.append(target)
                    controls[path.stem] = job
            scheduler_changed = False
            for queued in jobs_doc.get("jobs", []):
                queue_item_id = queued.get("job_id")
                target = queued.get("target")
                record = scheduler_state.get("jobs", {}).get(queue_item_id, {})
                control = controls.get(target, {"state": "ready"})
                item = {
                    "queue_item_id": queue_item_id, "target": target,
                    "priority": int(queued.get("priority", 1000)),
                    "authorized": bool(queued.get("authorized", False)),
                    "revision_fingerprint": queued.get("revision_fingerprint"),
                    "state": record.get("state", control.get("state", "queued")),
                    "phase": record.get("phase"), "attempts": int(record.get("attempts", 0)),
                    "control_state": control.get("state", "ready"),
                    "active_process": active_targets.get(target), "record": record,
                }
                if record.get("state") == "running" and target not in active_targets:
                    item["reported_state"] = "stale_running"
                    item["stale_reason"] = "scheduler record says running but no matching active trainer process exists"
                    if args.repair_stale:
                        record.update({
                            "state": "stale", "previous_state": "running",
                            "stale_reason": item["stale_reason"], "updated_at": now(),
                        })
                        item["state"] = "stale"
                        scheduler_changed = True
                        if target not in repaired:
                            repaired.append(target)
                        if scheduler_state.get("current") in {target, queue_item_id}:
                            scheduler_state["current"] = None
                items.append(item)
            if scheduler_changed:
                scheduler_state["decision"] = "repaired stale running scheduler state"
                scheduler_state["last_checked_at"] = now()
            current = scheduler_state.get("current")
        print(
            json.dumps(
                {
                    "queue": load(queue_path, {"state": "running"}),
                    "queue_id": "simpletuner",
                    "current": current,
                    "items": items,
                    "active_trainer_targets": active_targets,
                    "controls": controls,
                    "repaired_stale_targets": repaired,
                },
                indent=2,
            )
        )
        return 0

    stamp = int(time.time())
    if args.action in {"pause-queue", "resume-queue"}:
        state = "paused" if args.action == "pause-queue" else "running"
        with edit_scheduler_state(
            scheduler_state_path,
            {"schema_version": 1, "jobs": {}, "current": None},
        ):
            atomic(queue_path, {
                "schema_version": 1, "state": state, "reason": args.reason, "updated_at": stamp,
            })
            active_targets = active_trainer_targets() if args.action == "pause-queue" else {}
            jobs_doc = load(scheduler_jobs_path, {"jobs": []})
            active_jobs = [
                {
                    "queue_item_id": job.get("job_id"), "target": job.get("target"),
                    "authorization_job_id": job.get("authorization_job_id"),
                }
                for job in jobs_doc.get("jobs", [])
                if job.get("target") in active_targets
            ]
        print(json.dumps({
            "scope": "queue",
            "state": state,
            "active_jobs": active_jobs,
        }))
        return 0

    if not args.target or not SAFE.fullmatch(args.target):
        raise SystemExit("--target with a safe exact job ID is required")
    if args.action == "resume-job" and not args.reason.strip():
        raise SystemExit("resume-job requires a reason recording the explicit resume instruction")
    active_targets = active_trainer_targets()
    if args.target in active_targets:
        raise SystemExit(
            f"{args.action} refuses active target {args.target}; use the exact-job stop control"
        )
    queued_jobs = load(scheduler_jobs_path, {"jobs": []}).get("jobs", [])
    matching_jobs = [job for job in queued_jobs if job.get("target") == args.target]
    matching_ids = [job.get("job_id") for job in matching_jobs]
    state = {
        "pause-job": "paused",
        "resume-job": "ready",
        "skip-job": "skipped",
        "retry-job": "ready",
    }[args.action]
    with edit_scheduler_state(
        scheduler_state_path,
        {"schema_version": 1, "jobs": {}, "current": None},
    ) as scheduler:
        matching_states = {
            scheduler.get("jobs", {}).get(queue_item_id, {}).get("state")
            for queue_item_id in matching_ids
        }
        if "running" in matching_states and args.action != "pause-job":
            raise SystemExit(
                f"{args.action} refuses stale running state for {args.target}; run status --repair-stale first"
            )
        if "completed" in matching_states:
            raise SystemExit(f"{args.action} refuses completed target {args.target}")
        updated_at = now()
        for queue_item_id in matching_ids:
            record = scheduler.setdefault("jobs", {}).setdefault(queue_item_id, {})
            if args.action == "retry-job":
                record.update({"state": "queued", "phase": "queued", "attempts": 0})
            elif args.action == "resume-job":
                record.update({"state": "queued", "phase": "queued"})
            elif args.action == "pause-job":
                record.update({"state": "paused", "phase": "paused"})
            elif args.action == "skip-job":
                record.update({"state": "skipped", "phase": "skipped"})
            record["updated_at"] = updated_at
        if matching_ids:
            if scheduler.get("current") in matching_ids and args.action in {"skip-job"}:
                scheduler["current"] = None
            scheduler["decision"] = f"{args.action}: {args.target}"
            scheduler["last_checked_at"] = updated_at
    atomic(jobs_root / f"{args.target}.json", {
        "schema_version": 1, "target": args.target, "state": state,
        "reason": args.reason, "updated_at": stamp,
        "reset_attempts": args.action == "retry-job",
    })
    result = {"scope": "job", "target": args.target, "state": state}
    if args.action == "resume-job":
        result["resume_authorization"] = {
            "source": "explicit_control_call",
            "reason": args.reason,
            "recorded_at": now(),
        }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
