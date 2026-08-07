#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

BASE_CONFIG_PATH = Path(
    os.environ.get(
        "HAWKSPAN_CONFIG",
        os.environ.get(
            "HAWKSPAN_CONFIG_PATH",
            os.environ.get("HAWKSPAN_CONFIG", "~/.hawkspan/config.json"),
        ),
    )
).expanduser()
BASE_CONFIG = json.loads(BASE_CONFIG_PATH.read_text())


def active_runtime_pointer_path() -> Path:
    automation = BASE_CONFIG.get("lora_automation", {})
    return Path(
        automation.get(
            "active_runtime_pointer",
            BASE_CONFIG_PATH.parent / "active-lora-runtime.json",
        )
    ).expanduser()


def update_active_runtime_pointer(**updates) -> None:
    pointer_path = active_runtime_pointer_path()
    if not pointer_path.is_file():
        return
    pointer = json.loads(pointer_path.read_text())
    pointer.update(updates)
    temporary = pointer_path.with_name(f".{pointer_path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(pointer, indent=2) + "\n")
    temporary.replace(pointer_path)


def active_runtime_config_path() -> Path:
    pointer_path = active_runtime_pointer_path()
    if not pointer_path.is_file():
        return BASE_CONFIG_PATH
    pointer = json.loads(pointer_path.read_text())
    candidate = Path(pointer.get("config_path", "")).expanduser().resolve()
    runtime_root = Path(pointer.get("runtime_root", "")).expanduser().resolve()
    if not candidate.is_file() or not candidate.is_relative_to(runtime_root):
        raise SystemExit("active runtime configuration is missing or outside its runtime root")
    return candidate


CONFIG_PATH = active_runtime_config_path()
CONFIG = json.loads(CONFIG_PATH.read_text())
TRAINING = CONFIG.get("training", {})
# Direct-run records remain in HawkSpan's durable control root even when the
# queue, configs, outputs, caches, and packets are isolated in a staged runtime.
if CONFIG_PATH != BASE_CONFIG_PATH and BASE_CONFIG.get("training", {}).get("control_root"):
    TRAINING["control_root"] = BASE_CONFIG["training"]["control_root"]
AUTOMATION_CONFIG = CONFIG.get("lora_automation", {})
RUN_ROOT = Path(TRAINING["queue_root"])
MANIFEST = RUN_ROOT / "captioned-lora-manifest.json"
RUNNER = Path(
    TRAINING.get(
        "runner_script",
        Path(__file__).with_name("run_captioned_loras.py.managed"),
    )
)
SIMPLETUNER_ROOT = Path(
    TRAINING.get("simpletuner_root", "~/AI/SimpleTuner")
).expanduser()
PYTHON = SIMPLETUNER_ROOT / ".venv/bin/python"
CONTROL_ROOT = Path(
    TRAINING.get("control_root", "~/.hawkspan/trainer-control")
).expanduser()
SCHEDULER_ROOT = Path(
    BASE_CONFIG.get("lora_automation", {}).get(
        "scheduler_root", BASE_CONFIG_PATH.parent / "lora-scheduler"
    )
).expanduser()
JOB_CONTROL_ROOT = SCHEDULER_ROOT / "jobs"
if not TRAINING.get("node_path"):
    raise SystemExit("HawkSpan training.node_path is missing; reactivate the installed release")
NODE = Path(TRAINING["node_path"])
AUTOMATION = Path(
    TRAINING.get(
        "automation_script",
        Path(__file__).with_name("lora-automation.mjs"),
    )
)
TARGET_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
REVISION_FINGERPRINT_PATTERN = re.compile(r"^[A-Fa-f0-9]{64}$")
STOP_TERM_TIMEOUT_SECONDS = 30.0
STOP_KILL_TIMEOUT_SECONDS = 5.0
STOP_POLL_SECONDS = 0.1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=("start", "stop", "package"), required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument(
        "--expected-revision-fingerprint",
        help="Refuse restart unless current readiness matches this previously authorized revision.",
    )
    return parser.parse_args()


def load_target(target: str) -> dict:
    if not TARGET_PATTERN.fullmatch(target):
        raise SystemExit("target contains unsupported characters")
    jobs = json.loads(MANIFEST.read_text())
    matches = [job for job in jobs if job["job_id"] == target]
    if len(matches) != 1:
        raise SystemExit(f"target is not exactly one manifest job: {target}")
    return matches[0]


def validate_durable_job_id(job_id: str) -> None:
    if not TARGET_PATTERN.fullmatch(job_id):
        raise SystemExit("durable job ID contains unsupported characters")


def training_processes() -> list[str]:
    result = subprocess.run(
        ["ps", "-axo", "pid,command"],
        check=True,
        capture_output=True,
        text=True,
    )
    return [
        line.strip()
        for line in result.stdout.splitlines()
        if (
            "simpletuner train" in line
            or "/simpletuner/train.py" in line
            or "run_captioned_loras.py" in line
        )
        and "m4-trainer-control.py" not in line
    ]


def record_path(job_id: str, target: str) -> Path:
    return CONTROL_ROOT / f"{job_id}--{target}.json"


def job_control_path(target: str) -> Path:
    return JOB_CONTROL_ROOT / f"{target}.json"


def write_job_control(target: str, state: str, job_id: str, **extra) -> None:
    JOB_CONTROL_ROOT.mkdir(parents=True, exist_ok=True)
    job_control_path(target).write_text(
        json.dumps(
            {
                "schema_version": 1,
                "target": target,
                "state": state,
                "authorization_job_id": job_id,
                "updated_at": int(time.time()),
                **extra,
            },
            indent=2,
        )
        + "\n"
    )


def readiness_request(target: str) -> dict:
    return {
        "job_id": target,
        "ignore_process_group": os.getpgrp(),
    }


def start(job_id: str, target: str, expected_revision_fingerprint: str | None = None) -> None:
    if not expected_revision_fingerprint or not REVISION_FINGERPRINT_PATTERN.fullmatch(
        expected_revision_fingerprint
    ):
        raise SystemExit(
            "start requires a valid exact expected revision fingerprint"
        )
    load_target(target)
    active = training_processes()
    if active:
        raise SystemExit("start refused because training is already active:\n" + "\n".join(active))
    CONTROL_ROOT.mkdir(parents=True, exist_ok=True)
    readiness_result = subprocess.run(
        [
            str(NODE),
            str(AUTOMATION),
            "training-readiness",
            json.dumps(readiness_request(target)),
        ],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "HAWKSPAN_CONFIG": str(CONFIG_PATH)},
    )
    if readiness_result.returncode:
        raise SystemExit(
            "start refused because training readiness could not be evaluated:\n"
            + readiness_result.stderr
        )
    readiness = json.loads(readiness_result.stdout)
    if not readiness.get("ready"):
        raise SystemExit(
            "start refused because the versioned training readiness gate failed:\n"
            + json.dumps(readiness, indent=2)
        )
    if readiness.get("revision_fingerprint") != expected_revision_fingerprint:
        raise SystemExit(
            "start refused because dataset/config revision changed after authorization: "
            f"expected {expected_revision_fingerprint}, "
            f"found {readiness.get('revision_fingerprint')}"
        )
    status_path = CONTROL_ROOT / f"{job_id}--{target}.status.json"
    log_path = CONTROL_ROOT / f"{job_id}--{target}.log"
    log_handle = log_path.open("ab")
    child_env = os.environ.copy()
    child_env.update(
        {
            "HAWKSPAN_AUTHORIZED_TRAINING_JOB_ID": target,
            "HAWKSPAN_DURABLE_TRAINING_JOB_ID": job_id,
            "HAWKSPAN_AUTHORIZED_REVISION_FINGERPRINT": readiness[
                "revision_fingerprint"
            ],
            "HAWKSPAN_CONFIG": str(CONFIG_PATH),
            "HAWKSPAN_SIMPLETUNER_ROOT": str(SIMPLETUNER_ROOT),
            "HAWKSPAN_LORA_QUEUE_ROOT": str(RUN_ROOT),
            "HAWKSPAN_LORA_OUTPUT_ROOT": str(
                TRAINING.get("output_root", AUTOMATION_CONFIG.get("output_root", ""))
            ),
            "HAWKSPAN_LORA_RETURN_ROOT": str(
                TRAINING.get("return_root", RUN_ROOT / "return-packets")
            ),
            "HAWKSPAN_LORA_LEDGER_PATH": str(
                AUTOMATION_CONFIG.get(
                    "packet_ledger_path",
                    RUN_ROOT / "return-packet-log.json",
                )
            ),
            "HAWKSPAN_LORA_SOURCE_ZIP": str(TRAINING.get("source_zip", "not recorded")),
            "HAWKSPAN_RUNTIME_NODE_PATH": str(NODE),
            "HAWKSPAN_LORA_AUTOMATION": str(AUTOMATION),
            "HAWKSPAN_LORA_PACKET_BUILDER": str(
                TRAINING.get(
                    "packet_builder",
                    Path(__file__).with_name("build_return_packets.py.managed"),
                )
            ),
            "HAWKSPAN_LORA_MPS_SHIM_DIR": str(TRAINING.get("mps_shim_dir", "")),
        }
    )
    process = subprocess.Popen(
        [
            str(PYTHON),
            str(RUNNER),
            "--only-job",
            target,
            "--mode",
            "train-and-return",
            "--status-file",
            str(status_path),
        ],
        cwd=str(RUN_ROOT),
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env=child_env,
    )
    record = {
        "schema_version": 1,
        "durable_job_id": job_id,
        "target": target,
        "pid": process.pid,
        "process_group": os.getpgid(process.pid),
        "runner": str(RUNNER),
        "status_path": str(status_path),
        "log_path": str(log_path),
        "started_at": int(time.time()),
        "state": "started",
        "readiness_path": readiness["readiness_path"],
        "revision_fingerprint": readiness["revision_fingerprint"],
    }
    record_path(job_id, target).write_text(json.dumps(record, indent=2) + "\n")
    write_job_control(target, "running", job_id)
    startup_deadline = time.monotonic() + 30
    while True:
        if status_path.is_file():
            try:
                status = json.loads(status_path.read_text())
            except (OSError, json.JSONDecodeError):
                status = {}
            if status.get("current") == target:
                break
        returncode = process.poll()
        if returncode is not None:
            log_handle.close()
            record.update({
                "state": "failed",
                "exit_code": returncode,
                "failed_at": int(time.time()),
            })
            record_path(job_id, target).write_text(json.dumps(record, indent=2) + "\n")
            write_job_control(target, "failed", job_id, exit_code=returncode)
            detail = log_path.read_text(errors="replace")[-12000:]
            raise SystemExit(
                f"start refused because the managed runner exited before training began "
                f"(exit {returncode}):\n{detail}"
            )
        if time.monotonic() >= startup_deadline:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            log_handle.close()
            record.update({"state": "failed", "failed_at": int(time.time())})
            record_path(job_id, target).write_text(json.dumps(record, indent=2) + "\n")
            write_job_control(target, "failed", job_id, reason="startup_timeout")
            raise SystemExit("start refused because the managed runner did not enter training")
        time.sleep(0.1)
    update_active_runtime_pointer(
        training_authorized=True,
        training_started=True,
        authorization_job_id=job_id,
        target=target,
        revision_fingerprint=readiness["revision_fingerprint"],
        readiness_path=readiness["readiness_path"],
        started_at=int(time.time()),
    )
    print(json.dumps(record))


def process_snapshot() -> list[dict]:
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid=,lstart=,command="],
        check=True,
        capture_output=True,
        text=True,
    )
    processes = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 8)
        if len(fields) != 9:
            continue
        processes.append(
            {
                "pid": int(fields[0]),
                "ppid": int(fields[1]),
                "pgid": int(fields[2]),
                "started_at": " ".join(fields[3:8]),
                "command": fields[8],
            }
        )
    return processes


def command_matches_record(command: str, record: dict) -> bool:
    recorded_runner = Path(str(record.get("runner", ""))).expanduser()
    status_path = str(record.get("status_path", ""))
    target = str(record.get("target", ""))
    if not recorded_runner.is_absolute() or not recorded_runner.is_file() or not status_path:
        return False

    def has_exact_argument(flag: str, value: str) -> bool:
        marker = f"{flag} {value}"
        offset = command.find(marker)
        while offset >= 0:
            end = offset + len(marker)
            if end == len(command) or command[end].isspace():
                return True
            offset = command.find(marker, offset + 1)
        return False

    return (
        str(recorded_runner) in command
        and has_exact_argument("--only-job", target)
        and has_exact_argument("--status-file", status_path)
    )


def root_process_matches(record: dict, process: dict) -> bool:
    return (
        process["pid"] == int(record["pid"])
        and process["pgid"] == int(record["process_group"])
        and command_matches_record(process["command"], record)
    )


def process_identity(process: dict) -> tuple[int, str, str]:
    return process["pgid"], process["started_at"], process["command"]


def find_running_record(
    job_id: str,
    target: str,
    snapshot: list[dict] | None = None,
) -> tuple[Path, dict]:
    snapshot = process_snapshot() if snapshot is None else snapshot
    by_pid = {process["pid"]: process for process in snapshot}
    candidates = sorted(
        CONTROL_ROOT.glob(f"*--{target}.json"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        record = json.loads(candidate.read_text())
        if record.get("state") not in {"started", "stop_requested"}:
            continue
        if record.get("durable_job_id") != job_id or record.get("target") != target:
            continue
        process = by_pid.get(int(record["pid"]))
        if process and root_process_matches(record, process):
            return candidate, record
    raise SystemExit(f"no adapter-managed running process found for {target}")


def process_tree(root_pid: int, processes: list[dict] | None = None) -> list[dict]:
    processes = process_snapshot() if processes is None else processes
    descendants = []
    parents = {root_pid}
    while parents:
        children = [item for item in processes if item["ppid"] in parents]
        if not children:
            break
        descendants.extend(children)
        parents = {item["pid"] for item in children}
    root = next((item for item in processes if item["pid"] == root_pid), None)
    return ([root] if root else []) + descendants


def refresh_managed_processes(
    record: dict,
    known_identities: dict[int, tuple[int, str, str]],
) -> list[dict]:
    snapshot = process_snapshot()
    by_pid = {process["pid"]: process for process in snapshot}
    managed = {}

    root = by_pid.get(int(record["pid"]))
    if root and root_process_matches(record, root):
        managed[root["pid"]] = root

    for pid, identity in known_identities.items():
        process = by_pid.get(pid)
        if process and process_identity(process) == identity:
            managed[pid] = process

    while managed:
        managed_pids = set(managed)
        managed_groups = {process["pgid"] for process in managed.values()}
        additions = [
            process
            for process in snapshot
            if process["pid"] not in managed
            and (
                process["ppid"] in managed_pids
                or process["pgid"] in managed_groups
            )
        ]
        if not additions:
            break
        for process in additions:
            managed[process["pid"]] = process

    for process in managed.values():
        known_identities[process["pid"]] = process_identity(process)
    return list(managed.values())


def signal_managed_processes(processes: list[dict], requested_signal: int) -> None:
    own_group = os.getpgrp()
    groups = {
        process["pgid"]
        for process in processes
        if process["pgid"] > 0 and process["pgid"] != own_group
    }
    for process_group in sorted(groups, reverse=True):
        try:
            os.killpg(process_group, requested_signal)
        except ProcessLookupError:
            pass
    for process in processes:
        if process["pgid"] in groups:
            continue
        try:
            os.kill(process["pid"], requested_signal)
        except ProcessLookupError:
            pass


def wait_for_managed_exit(
    record: dict,
    known_identities: dict[int, tuple[int, str, str]],
    timeout_seconds: float,
) -> list[dict]:
    deadline = time.monotonic() + timeout_seconds
    while True:
        survivors = refresh_managed_processes(record, known_identities)
        if not survivors or time.monotonic() >= deadline:
            return survivors
        time.sleep(STOP_POLL_SECONDS)


def stop(job_id: str, target: str) -> None:
    load_target(target)
    CONTROL_ROOT.mkdir(parents=True, exist_ok=True)
    snapshot = process_snapshot()
    candidate, record = find_running_record(job_id, target, snapshot)
    root = next(
        (
            process
            for process in snapshot
            if process["pid"] == int(record["pid"])
            and root_process_matches(record, process)
        ),
        None,
    )
    if not root:
        raise SystemExit("adapter-managed root process identity changed before stop")
    tracked_processes = process_tree(root["pid"], snapshot)
    known_identities = {
        process["pid"]: process_identity(process) for process in tracked_processes
    }
    record.update(
        {
            "stop_authorization_job_id": job_id,
            "stop_requested_at": int(time.time()),
            "stop_processes": tracked_processes,
            "state": "stop_requested",
        }
    )
    candidate.write_text(json.dumps(record, indent=2) + "\n")
    signal_managed_processes(tracked_processes, signal.SIGTERM)
    survivors = wait_for_managed_exit(
        record, known_identities, STOP_TERM_TIMEOUT_SECONDS
    )
    if survivors:
        signal_managed_processes(survivors, signal.SIGKILL)
        survivors = wait_for_managed_exit(
            record, known_identities, STOP_KILL_TIMEOUT_SECONDS
        )
    if survivors:
        survivor_pids = sorted(process["pid"] for process in survivors)
        record.update(
            {
                "state": "stop_failed",
                "stop_failed_at": int(time.time()),
                "stop_survivors": survivor_pids,
            }
        )
        candidate.write_text(json.dumps(record, indent=2) + "\n")
        raise SystemExit(
            "adapter-managed processes remain after SIGKILL: "
            + ", ".join(str(pid) for pid in survivor_pids)
        )
    record.update({"stopped_at": int(time.time()), "state": "stopped"})
    candidate.write_text(json.dumps(record, indent=2) + "\n")
    write_job_control(
        target,
        "stopped",
        job_id,
        reason="authorized stop of this job only; queue may advance",
    )
    update_active_runtime_pointer(
        training_authorized=False,
        training_started=False,
        authorization_job_id=job_id,
        target=target,
        stopped_at=int(time.time()),
    )
    print(json.dumps(record))


def package(
    job_id: str,
    target: str,
    expected_revision_fingerprint: str | None = None,
) -> None:
    load_target(target)
    if training_processes():
        raise SystemExit("package refused while a training process is active")
    readiness_result = subprocess.run(
        [
            str(NODE),
            str(AUTOMATION),
            "training-readiness",
            json.dumps(readiness_request(target)),
        ],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "HAWKSPAN_CONFIG": str(CONFIG_PATH)},
    )
    if readiness_result.returncode:
        raise SystemExit(
            "package refused because training readiness could not be evaluated:\n"
            + readiness_result.stderr
        )
    readiness = json.loads(readiness_result.stdout)
    if not expected_revision_fingerprint:
        raise SystemExit("package requires expected revision fingerprint")
    if readiness.get("revision_fingerprint") != expected_revision_fingerprint:
        raise SystemExit(
            "package refused because dataset/config revision changed after authorization: "
            f"expected {expected_revision_fingerprint}, "
            f"found {readiness.get('revision_fingerprint')}"
        )
    CONTROL_ROOT.mkdir(parents=True, exist_ok=True)
    status_path = CONTROL_ROOT / f"{job_id}--{target}.package-status.json"
    package_env = os.environ.copy()
    package_env.update(
        {
            "HAWKSPAN_CONFIG": str(CONFIG_PATH),
            "HAWKSPAN_SIMPLETUNER_ROOT": str(SIMPLETUNER_ROOT),
            "HAWKSPAN_LORA_QUEUE_ROOT": str(RUN_ROOT),
            "HAWKSPAN_LORA_OUTPUT_ROOT": str(
                TRAINING.get("output_root", AUTOMATION_CONFIG.get("output_root", ""))
            ),
            "HAWKSPAN_LORA_RETURN_ROOT": str(
                TRAINING.get("return_root", RUN_ROOT / "return-packets")
            ),
            "HAWKSPAN_LORA_LEDGER_PATH": str(
                AUTOMATION_CONFIG.get(
                    "packet_ledger_path", RUN_ROOT / "return-packet-log.json"
                )
            ),
            "HAWKSPAN_RUNTIME_NODE_PATH": str(NODE),
            "HAWKSPAN_LORA_AUTOMATION": str(AUTOMATION),
            "HAWKSPAN_LORA_PACKET_BUILDER": str(
                TRAINING.get(
                    "packet_builder",
                    Path(__file__).with_name("build_return_packets.py.managed"),
                )
            ),
            "HAWKSPAN_LORA_SOURCE_ZIP": str(TRAINING.get("source_zip", "not recorded")),
            "HAWKSPAN_LORA_MPS_SHIM_DIR": str(TRAINING.get("mps_shim_dir", "")),
            "HAWKSPAN_DURABLE_TRAINING_JOB_ID": job_id,
        }
    )
    scheduler_jobs_path = Path(
        BASE_CONFIG.get("lora_automation", {}).get(
            "scheduler_jobs_path", SCHEDULER_ROOT / "lora-jobs.json"
        )
    ).expanduser()
    if scheduler_jobs_path.exists():
        scheduler_jobs = json.loads(scheduler_jobs_path.read_text()).get("jobs", [])
        matches = [
            item
            for item in scheduler_jobs
            if item.get("target") == target
            and item.get("authorization_job_id") == job_id
        ]
        if len(matches) != 1:
            raise SystemExit(
                "package refused because target is not bound to exactly one "
                "scheduler item for this durable training job"
            )
        package_env["HAWKSPAN_SIMPLETUNER_QUEUE_ITEM_ID"] = matches[0]["job_id"]
    else:
        raise SystemExit("package refused because scheduler job authority is missing")
    result = subprocess.run(
        [
            str(PYTHON),
            str(RUNNER),
            "--only-job",
            target,
            "--mode",
            "package-only",
            "--status-file",
            str(status_path),
        ],
        cwd=str(RUN_ROOT),
        text=True,
        capture_output=True,
        env=package_env,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode:
        raise SystemExit(result.returncode)


def main() -> None:
    args = parse_args()
    validate_durable_job_id(args.job_id)
    if args.action == "start":
        start(args.job_id, args.target, args.expected_revision_fingerprint)
    elif args.action == "stop":
        stop(args.job_id, args.target)
    else:
        package(args.job_id, args.target, args.expected_revision_fingerprint)


if __name__ == "__main__":
    main()
