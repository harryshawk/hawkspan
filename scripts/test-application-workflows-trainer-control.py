#!/usr/bin/env python3

import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
CONTROL_PATH = ROOT / "examples/plugins/application-workflows/bin/hawkspan-trainer-control.py"
SPEC = importlib.util.spec_from_file_location("hawkspan_trainer_control", CONTROL_PATH)
CONTROL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROL)


class FakeProcess:
    pid = 4242


class TrainerControlTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.runtime = self.root / "runtime"
        self.state = self.root / "state"
        self.logs = self.root / "logs"
        self.simpletuner = self.root / "SimpleTuner"
        for directory in (self.runtime, self.state, self.logs, self.simpletuner / ".venv/bin"):
            directory.mkdir(parents=True)
        self.executable = self.simpletuner / ".venv/bin/simpletuner"
        self.executable.write_text("#!/bin/sh\nexit 0\n")
        self.executable.chmod(0o700)
        self.target = "sample-job"
        self.revision = "a" * 64
        self.stage = self.runtime / "jobs" / f"{self.target}--abc123"
        (self.stage / "config").mkdir(parents=True)
        (self.stage / "dataset").mkdir()
        (self.runtime / "outputs" / self.target).mkdir(parents=True)
        self.manifest = {
            "schema_version": 1,
            "job_id": self.target,
            "revision_fingerprint": self.revision,
            "ready": True,
            "training_started": False,
            "runtime_job": {
                "job_id": self.target,
                "config_dir": str(self.stage / "config"),
                "data_dir": str(self.stage / "dataset"),
                "output_dir": str(self.runtime / "outputs" / self.target),
            },
        }
        (self.stage / "STAGE-MANIFEST.json").write_text(json.dumps(self.manifest))
        self.environment = mock.patch.dict(os.environ, {
            "HAWKSPAN_WORKLOAD_RUNTIME_ROOT": str(self.runtime),
            "HAWKSPAN_WORKLOAD_STATE_ROOT": str(self.state),
            "HAWKSPAN_WORKLOAD_LOG_ROOT": str(self.logs),
            "HAWKSPAN_SIMPLETUNER_ROOT": str(self.simpletuner),
            "HAWKSPAN_PRIVATE_VALUE": "must-not-leak",
        }, clear=True)
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def claim_stage(self, authorization_job_id="authorization-1"):
        manifest_path = self.stage / "STAGE-MANIFEST.json"
        return CONTROL.claim_stage_start(
            manifest_path,
            json.loads(manifest_path.read_text()),
            authorization_job_id,
        )

    def test_start_binds_exact_job_and_sanitizes_environment(self):
        with mock.patch.object(CONTROL, "active_trainer", return_value=None), \
             mock.patch.object(CONTROL.subprocess, "Popen", return_value=FakeProcess()) as popen, \
             mock.patch.object(CONTROL.os, "getpgid", return_value=4242):
            CONTROL.start("authorization-1", self.target, self.revision)
        record = json.loads((self.state / "trainer-control" / f"{self.target}.json").read_text())
        self.assertEqual(record["pid"], 4242)
        self.assertEqual(record["process_group"], 4242)
        self.assertEqual(record["revision_fingerprint"], self.revision)
        self.assertEqual(record["log_start_offset"], 0)
        self.assertEqual(record["simpletuner_command"], [str(self.executable.resolve()), "train"])
        claimed_manifest = json.loads((self.stage / "STAGE-MANIFEST.json").read_text())
        self.assertIs(claimed_manifest["training_started"], True)
        self.assertEqual(claimed_manifest["training_authorization_job_id"], "authorization-1")
        claim = json.loads((self.stage / CONTROL.START_CLAIM_FILE).read_text())
        self.assertEqual(claim["revision_fingerprint"], self.revision)
        child_env = popen.call_args.kwargs["env"]
        self.assertNotIn("HAWKSPAN_PRIVATE_VALUE", child_env)
        self.assertEqual(child_env["HAWKSPAN_AUTHORIZED_TARGET"], self.target)
        self.assertEqual(child_env["HAWKSPAN_WORKLOAD_RUNTIME_ROOT"], str(self.runtime))
        self.assertEqual(child_env["HAWKSPAN_WORKLOAD_STATE_ROOT"], str(self.state))
        self.assertEqual(child_env["HAWKSPAN_SIMPLETUNER_ROOT"], str(self.simpletuner.resolve()))
        self.assertEqual(popen.call_args.kwargs["start_new_session"], True)

    def test_entry_points_select_only_their_fixed_action(self):
        start = (CONTROL_PATH.parent / "hawkspan-trainer-start.sh").read_text()
        stop = (CONTROL_PATH.parent / "hawkspan-trainer-stop.sh").read_text()
        self.assertIn('hawkspan-trainer-control.py" --action start "$@"', start)
        self.assertNotIn("--action stop", start)
        self.assertIn('hawkspan-trainer-control.py" --action stop "$@"', stop)
        self.assertNotIn("--action start", stop)

    def test_missing_simpletuner_root_and_path_escape_fail_closed(self):
        del os.environ["HAWKSPAN_SIMPLETUNER_ROOT"]
        with self.assertRaisesRegex(SystemExit, "HAWKSPAN_SIMPLETUNER_ROOT"):
            CONTROL.start("authorization-1", self.target, self.revision)
        os.environ["HAWKSPAN_SIMPLETUNER_ROOT"] = str(self.simpletuner)
        self.manifest["runtime_job"]["config_dir"] = str(self.root / "outside")
        (self.root / "outside").mkdir()
        (self.stage / "STAGE-MANIFEST.json").write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(SystemExit, "escapes its configured root"):
            CONTROL.start("authorization-1", self.target, self.revision)

    def test_start_refuses_revision_drift_duplicate_target_and_active_trainer(self):
        with self.assertRaisesRegex(SystemExit, "revision changed"):
            CONTROL.start("authorization-1", self.target, "b" * 64)
        duplicate = self.runtime / "jobs" / f"{self.target}--duplicate"
        duplicate.mkdir(parents=True)
        (duplicate / "STAGE-MANIFEST.json").write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(SystemExit, "not exactly one staged"):
            CONTROL.start("authorization-1", self.target, self.revision)
        (duplicate / "STAGE-MANIFEST.json").unlink()
        with mock.patch.object(CONTROL, "active_trainer", return_value=(None, {"state": "running"})):
            with self.assertRaisesRegex(SystemExit, "already active"):
                CONTROL.start("authorization-1", self.target, self.revision)

    def test_start_consumes_exact_staged_target_once(self):
        with mock.patch.object(CONTROL, "active_trainer", return_value=None), \
             mock.patch.object(CONTROL.subprocess, "Popen", return_value=FakeProcess()), \
             mock.patch.object(CONTROL.os, "getpgid", return_value=4242):
            CONTROL.start("authorization-1", self.target, self.revision)
        with self.assertRaisesRegex(SystemExit, "already been started"):
            CONTROL.start("authorization-2", self.target, self.revision)

        manifest_path = self.stage / "STAGE-MANIFEST.json"
        claimed_manifest = json.loads(manifest_path.read_text())
        claimed_manifest["training_started"] = False
        manifest_path.write_text(json.dumps(claimed_manifest))
        with mock.patch.object(CONTROL, "active_trainer", return_value=None):
            with self.assertRaisesRegex(SystemExit, "stage a new target for recovery"):
                CONTROL.start("authorization-3", self.target, self.revision)

    def test_real_start_child_crosses_claim_boundary_and_finishes(self):
        real_popen = CONTROL.subprocess.Popen
        children = []

        def retained_popen(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child

        with mock.patch.object(CONTROL, "active_trainer", return_value=None), \
             mock.patch.object(CONTROL.subprocess, "Popen", side_effect=retained_popen):
            CONTROL.start("authorization-real", self.target, self.revision)
        destination = self.state / "trainer-control" / f"{self.target}.json"
        deadline = time.monotonic() + 5
        record = json.loads(destination.read_text())
        while record.get("state") not in {"completed", "failed"} and time.monotonic() < deadline:
            time.sleep(0.05)
            record = json.loads(destination.read_text())
        self.assertEqual(record["state"], "completed")
        self.assertEqual(record["returncode"], 0)
        self.assertNotIn("already been started", (self.logs / f"{self.target}.log").read_text())
        self.assertEqual(children[0].wait(timeout=5), 0)

    def test_stop_signals_descendants_without_terminating_controller(self):
        self.claim_stage()
        control_root = self.state / "trainer-control"
        control_root.mkdir()
        record = {
            "target": self.target,
            "state": "running",
            "pid": 4242,
            "process_group": 5151,
            "revision_fingerprint": self.revision,
        }
        (control_root / f"{self.target}.json").write_text(json.dumps(record))
        command = f'python "{CONTROL_PATH}" --action run --target {self.target}'
        with mock.patch.object(CONTROL, "pid_exists", side_effect=[True, False, False]), \
             mock.patch.object(CONTROL, "process_command", return_value=command), \
             mock.patch.object(CONTROL, "descendant_pids", return_value=[6001, 6002, 6003]), \
             mock.patch.object(CONTROL.os, "getpgid", side_effect=lambda pid: {4242: 5151, 6001: 7001, 6002: 7002, 6003: 5151}[pid]), \
             mock.patch.object(CONTROL.os, "killpg") as killpg, \
             mock.patch.object(CONTROL.os, "kill") as kill_process:
            CONTROL.stop("authorization-stop", self.target)
        self.assertEqual(killpg.call_args_list, [
            mock.call(7001, CONTROL.signal.SIGTERM),
            mock.call(7002, CONTROL.signal.SIGTERM),
        ])
        kill_process.assert_called_once_with(6003, CONTROL.signal.SIGTERM)
        updated = json.loads((control_root / f"{self.target}.json").read_text())
        self.assertEqual(updated["state"], "stopped")
        self.assertEqual(updated["stop_authorization_job_id"], "authorization-stop")
        self.assertEqual(updated["signaled_process_groups"], [7001, 7002])
        self.assertEqual(updated["signaled_process_ids"], [6003])

    def test_stop_escalates_remaining_descendants(self):
        destination = self.state / "trainer-control" / f"{self.target}.json"
        destination.parent.mkdir()
        record = {
            "target": self.target, "state": "stop_requested", "pid": 4242,
            "process_group": 5151, "revision_fingerprint": self.revision,
        }
        destination.write_text(json.dumps(record))
        with mock.patch.object(CONTROL, "STOP_TERM_TIMEOUT_SECONDS", 0), \
             mock.patch.object(CONTROL, "STOP_KILL_TIMEOUT_SECONDS", 1), \
             mock.patch.object(CONTROL, "pid_exists", side_effect=[False, False]), \
             mock.patch.object(CONTROL, "descendant_pids", return_value=[6001]), \
             mock.patch.object(CONTROL.os, "getpgid", return_value=7001), \
             mock.patch.object(CONTROL.os, "killpg") as killpg:
            completed = CONTROL.terminate_trainer(destination, record)
        killpg.assert_called_once_with(7001, CONTROL.signal.SIGKILL)
        self.assertEqual(completed["state"], "stopped")
        self.assertEqual(completed["killed_process_groups"], [7001])

    def test_stop_rejects_stale_or_mismatched_process(self):
        self.claim_stage()
        control_root = self.state / "trainer-control"
        control_root.mkdir()
        destination = control_root / f"{self.target}.json"
        destination.write_text(json.dumps({
            "target": self.target, "state": "running", "pid": 4242, "process_group": 5151,
        }))
        with mock.patch.object(CONTROL, "pid_exists", return_value=False), \
             mock.patch.object(CONTROL.os, "killpg") as killpg:
            with self.assertRaisesRegex(SystemExit, "no longer active"):
                CONTROL.stop("authorization-stop", self.target)
        killpg.assert_not_called()
        with mock.patch.object(CONTROL, "pid_exists", return_value=True), \
             mock.patch.object(CONTROL, "process_command", return_value="unrelated process"), \
             mock.patch.object(CONTROL.os, "killpg") as killpg:
            with self.assertRaisesRegex(SystemExit, "no longer belongs"):
                CONTROL.stop("authorization-stop", self.target)
        killpg.assert_not_called()
        prefix_collision = f'python "{CONTROL_PATH}" --action run --target {self.target}-other'
        with mock.patch.object(CONTROL, "pid_exists", return_value=True), \
             mock.patch.object(CONTROL, "process_command", return_value=prefix_collision), \
             mock.patch.object(CONTROL.os, "killpg") as killpg:
            with self.assertRaisesRegex(SystemExit, "no longer belongs"):
                CONTROL.stop("authorization-stop", self.target)
        killpg.assert_not_called()

    def test_run_invokes_only_simpletuner_train_and_records_completion(self):
        self.claim_stage()
        control_root = self.state / "trainer-control"
        control_root.mkdir()
        destination = control_root / f"{self.target}.json"
        destination.write_text(json.dumps({
            "authorization_job_id": "authorization-1", "target": self.target,
            "revision_fingerprint": self.revision, "pid": os.getpid(), "state": "started",
        }))
        completed = mock.Mock(returncode=0)
        with mock.patch.object(CONTROL.subprocess, "run", return_value=completed) as run:
            with self.assertRaises(SystemExit) as exit_error:
                CONTROL.run(self.target, self.revision, str(destination))
        self.assertEqual(exit_error.exception.code, 0)
        self.assertEqual(run.call_args.args[0], [str(self.executable.resolve()), "train"])
        self.assertEqual(run.call_args.kwargs["cwd"], str(self.stage / "config"))
        self.assertNotIn("HAWKSPAN_PRIVATE_VALUE", run.call_args.kwargs["env"])
        self.assertEqual(json.loads(destination.read_text())["state"], "completed")

    def test_run_records_authorized_stop_as_stopped(self):
        self.claim_stage()
        control_root = self.state / "trainer-control"
        control_root.mkdir()
        destination = control_root / f"{self.target}.json"
        destination.write_text(json.dumps({
            "authorization_job_id": "authorization-1", "target": self.target,
            "revision_fingerprint": self.revision, "pid": os.getpid(), "state": "started",
        }))

        def interrupted(*_args, **_kwargs):
            record = json.loads(destination.read_text())
            record["state"] = "stop_requested"
            destination.write_text(json.dumps(record))
            return mock.Mock(returncode=-CONTROL.signal.SIGTERM)

        with mock.patch.object(CONTROL.subprocess, "run", side_effect=interrupted):
            with self.assertRaises(SystemExit) as exit_error:
                CONTROL.run(self.target, self.revision, str(destination))
        self.assertEqual(exit_error.exception.code, -CONTROL.signal.SIGTERM)
        record = json.loads(destination.read_text())
        self.assertEqual(record["state"], "stopped")
        self.assertEqual(record["returncode"], -CONTROL.signal.SIGTERM)

    def test_run_honors_stop_requested_before_trainer_launch(self):
        self.claim_stage()
        control_root = self.state / "trainer-control"
        control_root.mkdir()
        destination = control_root / f"{self.target}.json"
        destination.write_text(json.dumps({
            "authorization_job_id": "authorization-1", "target": self.target,
            "revision_fingerprint": self.revision, "pid": os.getpid(), "state": "stop_requested",
        }))
        with mock.patch.object(CONTROL.subprocess, "run") as run:
            CONTROL.run(self.target, self.revision, str(destination))
        run.assert_not_called()
        record = json.loads(destination.read_text())
        self.assertEqual(record["state"], "stopped")
        self.assertEqual(record["returncode"], 0)


if __name__ == "__main__":
    unittest.main()
