#!/usr/bin/env python3

import argparse
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
CONTROL_DIRECTORY = "trainer-control"
START_CLAIM_FILE = "TRAINING-START-CLAIM.json"
STOP_TERM_TIMEOUT_SECONDS = 8
STOP_KILL_TIMEOUT_SECONDS = 2


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=("start", "stop", "run"), required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--expected-revision-fingerprint")
    parser.add_argument("--record-path", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def require_id(value, label):
    if not SAFE_ID.fullmatch(value):
        raise SystemExit(f"{label} must be an exact safe ID")
    return value


def configured_root(name, create=False):
    value = os.environ.get(name)
    if not value or not Path(value).is_absolute():
        raise SystemExit(f"{name} must name an absolute path")
    path = Path(value)
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.is_dir():
        raise SystemExit(f"{name} is not a directory")
    return path.resolve(strict=True)


def below(root, candidate, label, kind="any"):
    path = Path(candidate).resolve(strict=True)
    if path == root or root not in path.parents:
        raise SystemExit(f"{label} escapes its configured root")
    if kind == "file" and not path.is_file():
        raise SystemExit(f"{label} is not a file")
    if kind == "directory" and not path.is_dir():
        raise SystemExit(f"{label} is not a directory")
    return path


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"cannot read valid JSON from {path}: {error}") from error


def atomic_json(path, document):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def claim_stage_start(manifest_path, manifest, job_id):
    claimed_at = int(time.time())
    claim = {
        "schema_version": 1,
        "authorization_job_id": job_id,
        "target": manifest["job_id"],
        "revision_fingerprint": manifest["revision_fingerprint"],
        "claimed_at": claimed_at,
    }
    claim_path = manifest_path.parent / START_CLAIM_FILE
    try:
        descriptor = os.open(claim_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise SystemExit("staged runtime job has already been started; stage a new target for recovery") from error
    with os.fdopen(descriptor, "w") as handle:
        json.dump(claim, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    claimed_manifest = {
        **manifest,
        "training_started": True,
        "training_authorization_job_id": job_id,
        "training_started_at": claimed_at,
    }
    atomic_json(manifest_path, claimed_manifest)
    return claimed_manifest


def stage_manifest(runtime_root, target, expected_revision=None, expected_started=False):
    jobs_root = runtime_root / "jobs"
    matches = sorted(jobs_root.glob(f"{target}--*/STAGE-MANIFEST.json"))
    matches = [below(jobs_root.resolve(strict=True), item, "stage manifest", "file") for item in matches]
    if len(matches) != 1:
        raise SystemExit(f"target is not exactly one staged runtime job: {target}")
    path = matches[0]
    manifest = read_json(path)
    revision = manifest.get("revision_fingerprint")
    if manifest.get("job_id") != target:
        raise SystemExit("stage manifest job ID does not match the exact target")
    if not isinstance(revision, str) or not SHA256.fullmatch(revision):
        raise SystemExit("stage manifest revision fingerprint is invalid")
    if expected_revision is not None and revision != expected_revision:
        raise SystemExit("staged runtime revision changed after authorization")
    if manifest.get("ready") is not True:
        raise SystemExit("staged runtime job is not ready")
    if manifest.get("training_started") is not expected_started:
        if expected_started:
            raise SystemExit("staged runtime job does not contain the authorized start claim")
        raise SystemExit("staged runtime job has already been started")
    if expected_started:
        claim_path = path.parent / START_CLAIM_FILE
        if not claim_path.is_file():
            raise SystemExit("staged runtime job is missing its authorized start claim")
        claim = read_json(claim_path)
        if (claim.get("target") != target or claim.get("revision_fingerprint") != revision or
                claim.get("authorization_job_id") != manifest.get("training_authorization_job_id")):
            raise SystemExit("staged runtime job has a mismatched authorized start claim")
    runtime_job = manifest.get("runtime_job")
    if not isinstance(runtime_job, dict) or runtime_job.get("job_id") != target:
        raise SystemExit("stage manifest does not contain the exact runtime job")
    stage_root = path.parent
    below(stage_root, runtime_job.get("config_dir", ""), "runtime config directory", "directory")
    below(stage_root, runtime_job.get("data_dir", ""), "runtime dataset directory", "directory")
    output_dir = Path(runtime_job.get("output_dir", "")).resolve(strict=False)
    if output_dir == runtime_root or runtime_root not in output_dir.parents:
        raise SystemExit("runtime output directory escapes the configured runtime root")
    return path, manifest


def simpletuner_paths():
    root = configured_root("HAWKSPAN_SIMPLETUNER_ROOT")
    executable = root / ".venv" / "bin" / "simpletuner"
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise SystemExit("configured SimpleTuner executable is missing or not executable")
    return root, executable.resolve(strict=True)


def sanitized_environment(simpletuner_root, manifest):
    runtime_job = manifest["runtime_job"]
    path = os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
    environment = {
        "PATH": f"{simpletuner_root / '.venv' / 'bin'}:{path}",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "DO_NOT_TRACK": "1",
        "WANDB_MODE": "disabled",
        "HAWKSPAN_AUTHORIZED_TARGET": manifest["job_id"],
        "HAWKSPAN_AUTHORIZED_REVISION_FINGERPRINT": manifest["revision_fingerprint"],
        "HAWKSPAN_RUNTIME_CONFIG_DIR": runtime_job["config_dir"],
        "HAWKSPAN_RUNTIME_DATASET_DIR": runtime_job["data_dir"],
        "HAWKSPAN_RUNTIME_OUTPUT_DIR": runtime_job["output_dir"],
        "HAWKSPAN_WORKLOAD_RUNTIME_ROOT": os.environ["HAWKSPAN_WORKLOAD_RUNTIME_ROOT"],
        "HAWKSPAN_WORKLOAD_STATE_ROOT": os.environ["HAWKSPAN_WORKLOAD_STATE_ROOT"],
        "HAWKSPAN_SIMPLETUNER_ROOT": str(simpletuner_root),
    }
    for name in ("LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE"):
        if os.environ.get(name):
            environment[name] = os.environ[name]
    return environment


def process_command(pid):
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "command="],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def pid_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def active_trainer(control_root, simpletuner_executable):
    for candidate in sorted(control_root.glob("*.json")):
        record = read_json(candidate)
        if record.get("state") not in {"launching", "started", "running", "stop_requested"}:
            continue
        pid = record.get("pid")
        if isinstance(pid, int) and pid_exists(pid):
            return candidate, record
    result = subprocess.run(
        ["ps", "-axo", "pid=,command="], capture_output=True, text=True, check=True
    )
    simpletuner_root = simpletuner_executable.parents[2]
    markers = (
        f"{simpletuner_executable} train",
        f"{simpletuner_root / '.venv' / 'bin' / 'accelerate'} launch",
        f"{simpletuner_root / '.venv' / 'lib'}/python",
    )
    for line in result.stdout.splitlines():
        if markers[0] in line or markers[1] in line or (markers[2] in line and "/site-packages/simpletuner/train.py" in line):
            return None, {"state": "unmanaged", "process": line.strip()}
    return None


def descendant_pids(root_pid):
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, check=True
    )
    children = {}
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) != 2 or not all(field.isdigit() for field in fields):
            continue
        pid, parent = map(int, fields)
        children.setdefault(parent, []).append(pid)
    descendants = []
    pending = list(children.get(root_pid, ()))
    while pending:
        pid = pending.pop()
        descendants.append(pid)
        pending.extend(children.get(pid, ()))
    return descendants


def record_path(control_root, target):
    return control_root / f"{target}.json"


def start(job_id, target, expected_revision):
    if not expected_revision or not SHA256.fullmatch(expected_revision):
        raise SystemExit("start requires a 64-character lowercase revision fingerprint")
    runtime_root = configured_root("HAWKSPAN_WORKLOAD_RUNTIME_ROOT")
    state_root = configured_root("HAWKSPAN_WORKLOAD_STATE_ROOT", create=True)
    log_root = configured_root("HAWKSPAN_WORKLOAD_LOG_ROOT", create=True)
    simpletuner_root, executable = simpletuner_paths()
    manifest_path, manifest = stage_manifest(runtime_root, target, expected_revision)
    control_root = state_root / CONTROL_DIRECTORY
    control_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if active_trainer(control_root, executable):
        raise SystemExit("start refused because a trainer is already active")
    manifest = claim_stage_start(manifest_path, manifest, job_id)
    destination = record_path(control_root, target)
    log_path = log_root / f"{target}.log"
    log_start_offset = log_path.stat().st_size if log_path.exists() else 0
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--action", "run",
        "--job-id", job_id,
        "--target", target,
        "--expected-revision-fingerprint", expected_revision,
        "--record-path", str(destination),
    ]
    record = {
        "schema_version": 1,
        "authorization_job_id": job_id,
        "target": target,
        "revision_fingerprint": expected_revision,
        "stage_manifest": str(manifest_path),
        "simpletuner_command": [str(executable), "train"],
        "runner_command": command,
        "log_path": str(log_path),
        "log_start_offset": log_start_offset,
        "state": "launching",
        "updated_at": int(time.time()),
    }
    atomic_json(destination, record)
    with log_path.open("ab", buffering=0) as log_handle:
        process = subprocess.Popen(
            command,
            cwd=str(manifest_path.parent),
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=sanitized_environment(simpletuner_root, manifest),
        )
    record.update({
        "pid": process.pid,
        "process_group": os.getpgid(process.pid),
        "state": "started",
        "started_at": int(time.time()),
        "updated_at": int(time.time()),
    })
    atomic_json(destination, record)
    print(json.dumps(record, sort_keys=True))


def owned_running_record(control_root, target):
    destination = record_path(control_root, target)
    if not destination.is_file():
        raise SystemExit(f"no managed trainer record exists for exact target: {target}")
    record = read_json(destination)
    if record.get("target") != target or record.get("state") not in {"started", "running"}:
        raise SystemExit(f"no managed running trainer exists for exact target: {target}")
    pid = record.get("pid")
    process_group = record.get("process_group")
    if not isinstance(pid, int) or not isinstance(process_group, int) or not pid_exists(pid):
        raise SystemExit("managed trainer PID is no longer active")
    command = process_command(pid)
    expected = str(Path(__file__).resolve())
    try:
        arguments = shlex.split(command)
    except ValueError:
        arguments = []
    pairs = list(zip(arguments, arguments[1:]))
    if expected not in arguments or ("--action", "run") not in pairs or ("--target", target) not in pairs:
        raise SystemExit("managed trainer PID no longer belongs to the exact target")
    if os.getpgid(pid) != process_group:
        raise SystemExit("managed trainer process group no longer matches its record")
    return destination, record


def signal_descendants(controller_pid, controller_group, signal_number, known_groups, known_pids):
    for pid in descendant_pids(controller_pid):
        try:
            process_group = os.getpgid(pid)
        except ProcessLookupError:
            continue
        if process_group == controller_group:
            if pid in known_pids:
                continue
            try:
                os.kill(pid, signal_number)
            except ProcessLookupError:
                pass
            known_pids.add(pid)
        else:
            if process_group in known_groups:
                continue
            try:
                os.killpg(process_group, signal_number)
            except ProcessLookupError:
                pass
            known_groups.add(process_group)


def stopped_record(destination, controller_pid):
    current = read_json(destination)
    remaining = descendant_pids(controller_pid) if pid_exists(controller_pid) else []
    if remaining:
        return None
    if current.get("state") == "stopped":
        return current
    if current.get("state") == "stop_requested" and not pid_exists(controller_pid):
        current.update({
            "state": "stopped",
            "finished_at": int(time.time()),
            "updated_at": int(time.time()),
        })
        atomic_json(destination, current)
        return current
    return None


def terminate_trainer(destination, record):
    term_groups = set()
    term_pids = set()
    term_deadline = time.monotonic() + STOP_TERM_TIMEOUT_SECONDS
    while time.monotonic() < term_deadline:
        signal_descendants(record["pid"], record["process_group"], signal.SIGTERM, term_groups, term_pids)
        completed = stopped_record(destination, record["pid"])
        if completed:
            completed.update({
                "signaled_process_groups": sorted(term_groups),
                "signaled_process_ids": sorted(term_pids),
            })
            atomic_json(destination, completed)
            return completed
        time.sleep(0.1)

    kill_groups = set()
    kill_pids = set()
    signal_descendants(record["pid"], record["process_group"], signal.SIGKILL, kill_groups, kill_pids)
    kill_deadline = time.monotonic() + STOP_KILL_TIMEOUT_SECONDS
    while time.monotonic() < kill_deadline:
        signal_descendants(record["pid"], record["process_group"], signal.SIGKILL, kill_groups, kill_pids)
        completed = stopped_record(destination, record["pid"])
        if completed:
            completed.update({
                "signaled_process_groups": sorted(term_groups),
                "signaled_process_ids": sorted(term_pids),
                "killed_process_groups": sorted(kill_groups),
                "killed_process_ids": sorted(kill_pids),
            })
            atomic_json(destination, completed)
            return completed
        time.sleep(0.1)
    raise SystemExit("trainer processes remained active after stop escalation")


def stop(job_id, target):
    runtime_root = configured_root("HAWKSPAN_WORKLOAD_RUNTIME_ROOT")
    state_root = configured_root("HAWKSPAN_WORKLOAD_STATE_ROOT", create=True)
    stage_manifest(runtime_root, target, expected_started=True)
    control_root = state_root / CONTROL_DIRECTORY
    destination, record = owned_running_record(control_root, target)
    record.update({
        "signaled_process_groups": [],
        "signaled_process_ids": [],
        "stop_authorization_job_id": job_id,
        "stop_requested_at": int(time.time()),
        "state": "stop_requested",
        "updated_at": int(time.time()),
    })
    atomic_json(destination, record)
    final_record = terminate_trainer(destination, record)
    print(json.dumps(final_record, sort_keys=True))


def run(target, expected_revision, destination):
    runtime_root = configured_root("HAWKSPAN_WORKLOAD_RUNTIME_ROOT")
    simpletuner_root, executable = simpletuner_paths()
    manifest_path, manifest = stage_manifest(runtime_root, target, expected_revision, expected_started=True)
    control_root = configured_root("HAWKSPAN_WORKLOAD_STATE_ROOT", create=True) / CONTROL_DIRECTORY
    expected_destination = record_path(control_root, target).resolve(strict=False)
    if Path(destination).resolve(strict=False) != expected_destination:
        raise SystemExit("managed record path does not match the exact target")
    deadline = time.monotonic() + 5
    record = read_json(expected_destination)
    while record.get("pid") != os.getpid() and time.monotonic() < deadline:
        time.sleep(0.05)
        record = read_json(expected_destination)
    if (record.get("pid") != os.getpid() or record.get("target") != target or
            record.get("revision_fingerprint") != expected_revision or
            record.get("authorization_job_id") != manifest.get("training_authorization_job_id")):
        raise SystemExit("runner is not bound to its managed launch record")
    if record.get("state") == "stop_requested":
        record.update({
            "returncode": 0,
            "state": "stopped",
            "finished_at": int(time.time()),
            "updated_at": int(time.time()),
        })
        atomic_json(expected_destination, record)
        return
    record.update({"state": "running", "updated_at": int(time.time())})
    atomic_json(expected_destination, record)
    result = subprocess.run(
        [str(executable), "train"],
        cwd=manifest["runtime_job"]["config_dir"],
        env=sanitized_environment(simpletuner_root, manifest),
        check=False,
    )
    record = read_json(expected_destination)
    stop_requested = record.get("state") == "stop_requested"
    record.update({
        "returncode": result.returncode,
        "state": "stopped" if stop_requested else "completed" if result.returncode == 0 else "failed",
        "finished_at": int(time.time()),
        "updated_at": int(time.time()),
    })
    atomic_json(expected_destination, record)
    raise SystemExit(result.returncode)


def main(argv=None):
    args = parse_args(argv)
    job_id = require_id(args.job_id, "job ID")
    target = require_id(args.target, "target")
    if args.action == "start":
        start(job_id, target, args.expected_revision_fingerprint)
    elif args.action == "stop":
        stop(job_id, target)
    else:
        if not args.record_path or not args.expected_revision_fingerprint:
            raise SystemExit("run requires its managed record and exact revision")
        run(target, args.expected_revision_fingerprint, args.record_path)


if __name__ == "__main__":
    main()
