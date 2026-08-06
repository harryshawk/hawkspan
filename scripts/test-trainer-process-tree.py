#!/usr/bin/env python3
import importlib.machinery
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


with tempfile.TemporaryDirectory(prefix="trainer-process-tree-") as temporary:
    root = Path(temporary)
    queue = root / "queue"
    queue.mkdir()
    runtime_root = root / "runtime"
    runtime_queue = runtime_root / "queue"
    runtime_queue.mkdir(parents=True)
    config = root / "config.json"
    config.write_text(json.dumps({
        "schema_version": 1,
        "training": {
            "queue_root": str(queue),
            "control_root": str(root / "control"),
            "simpletuner_root": str(root / "simpletuner"),
        },
        "lora_automation": {"scheduler_root": str(root / "scheduler")},
    }))
    runtime_config = runtime_root / "config.json"
    runtime_config.write_text(json.dumps({
        "schema_version": 1,
        "training": {
            "queue_root": str(runtime_queue),
            "control_root": str(runtime_root / "ephemeral-control"),
            "simpletuner_root": str(root / "simpletuner"),
        },
        "lora_automation": {"scheduler_root": str(runtime_root / "scheduler")},
    }))
    (root / "active-lora-runtime.json").write_text(json.dumps({
        "schema_version": 1,
        "config_path": str(runtime_config),
        "runtime_root": str(runtime_root),
    }))
    os.environ["HAWKSPAN_CONFIG"] = str(config)
    os.environ["HAWKSPAN_CONFIG"] = str(config)

    controller_path = Path(__file__).with_name("m4-trainer-control.py")
    loader = importlib.machinery.SourceFileLoader("trainer_controller_test", str(controller_path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    controller = importlib.util.module_from_spec(spec)
    loader.exec_module(controller)
    assert controller.CONFIG_PATH == runtime_config.resolve()
    assert controller.RUN_ROOT.resolve() == runtime_queue.resolve()
    assert controller.CONTROL_ROOT.resolve() == (root / "control").resolve()
    readiness_request = controller.readiness_request("test-target")
    assert readiness_request["job_id"] == "test-target"
    assert readiness_request["ignore_process_group"] == os.getpgrp()
    controller.update_active_runtime_pointer(
        training_authorized=True,
        training_started=True,
        authorization_job_id="test-job",
        target="test-target",
    )
    pointer = json.loads((root / "active-lora-runtime.json").read_text())
    assert pointer["config_path"] == str(runtime_config)
    assert pointer["training_authorized"] is True
    assert pointer["training_started"] is True
    assert pointer["authorization_job_id"] == "test-job"
    assert pointer["target"] == "test-target"

    child_pid_path = root / "child.pid"
    helper = root / "runner-helper.py"
    helper.write_text(
        "import pathlib,subprocess,sys,time\n"
        "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(300)'],start_new_session=True)\n"
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid))\n"
        "time.sleep(300)\n"
    )
    runner = subprocess.Popen(
        [sys.executable, str(helper), str(child_pid_path), "upgrade-test-target"],
        start_new_session=True,
    )
    try:
        for _ in range(100):
            if child_pid_path.exists():
                break
            time.sleep(0.05)
        assert child_pid_path.exists(), "separate-group child did not start"
        child_pid = int(child_pid_path.read_text())
        tree = controller.process_tree(runner.pid)
        by_pid = {entry["pid"]: entry for entry in tree}
        assert runner.pid in by_pid
        assert child_pid in by_pid
        assert by_pid[runner.pid]["pgid"] != by_pid[child_pid]["pgid"]

        control = root / "control"
        control.mkdir()
        old_release_runner = root / "old-release" / "run_captioned_loras.py.managed"
        old_release_runner.parent.mkdir()
        old_release_runner.symlink_to(helper)
        old_runner = subprocess.Popen(
            [
                sys.executable,
                str(old_release_runner),
                str(root / "old-child.pid"),
                "upgrade-test-target",
            ],
            start_new_session=True,
        )
        old_record_path = control / "upgrade-job--upgrade-test-target.json"
        old_record = {
            "schema_version": 1,
            "durable_job_id": "upgrade-job",
            "target": "upgrade-test-target",
            "pid": old_runner.pid,
            "process_group": os.getpgid(old_runner.pid),
            "runner": str(old_release_runner),
            "state": "started",
        }
        old_record_path.write_text(json.dumps(old_record))
        found_path, found_record = controller.find_running_record(
            "upgrade-job", "upgrade-test-target"
        )
        assert found_path == old_record_path
        assert found_record["runner"] == str(old_release_runner)
    finally:
        for process_group in {entry["pgid"] for entry in locals().get("tree", [])}:
            try:
                os.killpg(process_group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            runner.wait(timeout=5)
        except subprocess.TimeoutExpired:
            runner.kill()
        if "old_runner" in locals():
            try:
                os.killpg(os.getpgid(old_runner.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            old_runner.wait(timeout=5)

print("trainer process tree tests passed")
