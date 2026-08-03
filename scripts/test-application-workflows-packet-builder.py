#!/usr/bin/env python3

import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
BUILDER_PATH = ROOT / "examples/plugins/application-workflows/bin/hawkspan-packet-builder.py"
SPEC = importlib.util.spec_from_file_location("hawkspan_packet_builder", BUILDER_PATH)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class PacketBuilderTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.runtime = self.root / "runtime"
        self.state = self.root / "state"
        self.output = self.root / "packets"
        self.logs = self.root / "logs"
        self.simpletuner = self.root / "SimpleTuner"
        for directory in (self.runtime / "jobs", self.state / "trainer-control", self.output, self.logs):
            directory.mkdir(parents=True)
        site_packages = self.simpletuner / ".venv/lib/python3.12/site-packages"
        (site_packages / "simpletuner/helpers/training").mkdir(parents=True)
        (site_packages / "simpletuner/helpers/models/sdxl").mkdir(parents=True)
        (site_packages / "simpletuner-4.5.0.dist-info").mkdir()
        (site_packages / "simpletuner-4.5.0.dist-info/METADATA").write_text("Name: simpletuner\nVersion: 4.5.0\n")
        (site_packages / "simpletuner/helpers/training/collate.py").write_text(
            "if latent_source_backends and (needs_reference_pixels or StateTracker.get_args().controlnet):\n    pass\n"
        )
        (site_packages / "simpletuner/helpers/models/sdxl/pipeline.py").write_text(
            'return self._guidance_scale > 1 and getattr(self.unet.config, "time_cond_proj_dim", None) is None\n'
            'time_cond_proj_dim = getattr(self.unet.config, "time_cond_proj_dim", None)\n'
            'embedding_dim=time_cond_proj_dim\n'
        )
        (site_packages / "simpletuner/helpers/training/validation.py").write_text(
            "validation_model = self.model.unwrap_model(model=self.model.model)\n"
        )
        self.target = "sample-job"
        self.revision = "a" * 64
        self.stage = self.runtime / "jobs" / f"{self.target}--abc123"
        config = self.stage / "config"
        dataset = self.stage / "dataset"
        run_output = self.runtime / "outputs" / self.target
        self.config = config
        self.dataset = dataset
        self.run_output = run_output
        for directory in (config, dataset, run_output):
            directory.mkdir(parents=True)
        targets = dataset / "targets"
        conditioning = dataset / "conditioning"
        targets.mkdir()
        conditioning.mkdir()
        trainer_config = {"model_type": "lora", "lora_type": "loha", "controlnet": True}
        (config / "config.json").write_text(json.dumps(trainer_config))
        (config / "hawkspan-recipe.json").write_text(json.dumps({
            "schema_version": 1,
            "config_name": "controlnet-fixture",
            "config": trainer_config,
        }))
        (config / "TRAINING_READINESS_POLICY.json").write_text('{"schema_version": 1}\n')
        (config / "validation-prompts.json").write_text('{"schema_version": 1, "prompts": []}\n')
        backend = [
            {"id": "targets", "type": "local", "dataset_type": "image", "conditioning_data": "controls", "instance_data_dir": str(targets)},
            {"id": "controls", "type": "local", "dataset_type": "conditioning", "conditioning_type": "controlnet", "instance_data_dir": str(conditioning)},
        ]
        (config / "multidatabackend.json").write_text(json.dumps(backend))
        (targets / "robot.jpg").write_bytes(b"target-image")
        (targets / "robot.txt").write_text("public robot caption\n")
        (conditioning / "robot.png").write_bytes(b"conditioning-image")
        (conditioning / "robot.txt").write_text("public robot caption\n")
        (run_output / "pytorch_lora_weights.safetensors").write_bytes(b"real-output-fixture")
        (run_output / "validation_images").mkdir()
        (run_output / "validation_images/step_0_robot.png").write_bytes(b"validation-render-fixture")
        self.log = self.logs / f"{self.target}.log"
        self.log.write_text("training complete\n")
        manifest = {
            "schema_version": 1, "job_id": self.target,
            "revision_fingerprint": self.revision, "ready": True,
            "runtime_job": {
                "job_id": self.target, "config_dir": str(config),
                "data_dir": str(dataset), "output_dir": str(run_output),
            },
        }
        (self.stage / "STAGE-MANIFEST.json").write_text(json.dumps(manifest, sort_keys=True))
        record = {
            "schema_version": 1, "target": self.target,
            "revision_fingerprint": self.revision, "state": "completed",
            "returncode": 0, "log_path": str(self.log),
        }
        self.record = self.state / "trainer-control" / f"{self.target}.json"
        self.record.write_text(json.dumps(record, sort_keys=True))
        self.environment = mock.patch.dict(os.environ, {
            "HAWKSPAN_WORKLOAD_RUNTIME_ROOT": str(self.runtime),
            "HAWKSPAN_WORKLOAD_STATE_ROOT": str(self.state),
            "HAWKSPAN_WORKLOAD_OUTPUT_ROOT": str(self.output),
            "HAWKSPAN_WORKLOAD_LOG_ROOT": str(self.logs),
            "HAWKSPAN_SIMPLETUNER_ROOT": str(self.simpletuner),
        }, clear=True)
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def configure_standard_lora(self):
        targets = self.dataset / "targets"
        if targets.is_dir():
            (self.dataset / "robot.jpg").write_bytes((targets / "robot.jpg").read_bytes())
            (self.dataset / "robot.txt").write_text((targets / "robot.txt").read_text())
        for directory in (self.dataset / "targets", self.dataset / "conditioning"):
            if directory.is_dir():
                for path in directory.iterdir():
                    path.unlink()
                directory.rmdir()
        trainer_config = {"model_type": "lora", "lora_type": "standard"}
        (self.config / "config.json").write_text(json.dumps(trainer_config))
        (self.config / "hawkspan-recipe.json").write_text(json.dumps({
            "schema_version": 1,
            "config_name": "standard-lora-fixture",
            "config": trainer_config,
        }))
        (self.config / "multidatabackend.json").write_text(json.dumps([{
            "id": "images",
            "type": "local",
            "dataset_type": "image",
            "instance_data_dir": str(self.dataset),
            "caption_strategy": "textfile",
        }]))

    def test_builds_deterministic_verified_new_only_packet(self):
        first = BUILDER.build("authorization-1", self.target)
        packet = Path(first["packet_path"])
        first_bytes = packet.read_bytes()
        self.assertEqual(hashlib.sha256(first_bytes).hexdigest(), first["packet_sha256"])
        with zipfile.ZipFile(packet) as archive:
            self.assertIsNone(archive.testzip())
            names = archive.namelist()
            self.assertIn("CONFIG/config.json", names)
            self.assertIn("DATASET/targets/robot.jpg", names)
            self.assertIn("DATASET/targets/robot.txt", names)
            self.assertIn("DATASET/conditioning/robot.png", names)
            self.assertIn("CONFIG/multidatabackend.json", names)
            self.assertIn("OUTPUTS/pytorch_lora_weights.safetensors", names)
            self.assertIn("OUTPUTS/validation_images/step_0_robot.png", names)
            self.assertIn("SHA256-INVENTORY.csv", names)
            self.assertIn("SHA256-INVENTORY.json", names)
            self.assertIn("ENVIRONMENT/SIMPLETUNER.json", names)
            self.assertIn("ENVIRONMENT/simpletuner-4.5-controlnet-pixels.patch", names)
            self.assertIn("ENVIRONMENT/simpletuner-4.5-sdxl-controlnet-validation.patch", names)
            environment = json.loads(archive.read("ENVIRONMENT/SIMPLETUNER.json"))
            self.assertTrue(environment["controlnet_validation_model_binding_correction_present"])
            self.assertEqual(environment["workflow_type"], "controlnet_loha")
            self.assertTrue(environment["controlnet_compatibility_required"])
            self.assertIn("validation_setup_sha256", environment)
            self.assertEqual({item.date_time for item in archive.infolist()}, {(1980, 1, 1, 0, 0, 0)})
        second = BUILDER.build("authorization-2", self.target)
        self.assertEqual(first["identity"], second["identity"])
        self.assertEqual(first_bytes, packet.read_bytes())
        ledger = json.loads((self.output / "return-packet-ledger.json").read_text())
        self.assertEqual(len(ledger["packets"]), 1)

    def test_builds_standard_lora_packet_without_controlnet_environment_requirements(self):
        self.configure_standard_lora()
        checkpoint = self.run_output / "checkpoint-300"
        checkpoint.mkdir()
        (checkpoint / "pytorch_lora_weights.safetensors").write_bytes(b"standard-lora-checkpoint")
        site_packages = self.simpletuner / ".venv/lib/python3.12/site-packages"
        (site_packages / "simpletuner/helpers/training/collate.py").unlink()
        (site_packages / "simpletuner/helpers/models/sdxl/pipeline.py").unlink()
        (site_packages / "simpletuner/helpers/training/validation.py").unlink()

        result = BUILDER.build("authorization-standard-lora", self.target)

        with zipfile.ZipFile(result["packet_path"]) as archive:
            names = archive.namelist()
            summary = json.loads(archive.read("PACKET-SUMMARY.json"))
            environment = json.loads(archive.read("ENVIRONMENT/SIMPLETUNER.json"))
            self.assertEqual(summary["training_evidence"]["workflow_type"], "standard_lora")
            self.assertEqual(summary["training_evidence"]["target_image_count"], 1)
            self.assertEqual(summary["training_evidence"]["conditioning_image_count"], 0)
            self.assertEqual(summary["training_evidence"]["caption_sidecar_count"], 1)
            self.assertEqual(summary["training_evidence"]["checkpoints"], ["checkpoint-300"])
            self.assertEqual(environment["workflow_type"], "standard_lora")
            self.assertFalse(environment["controlnet_compatibility_required"])
            self.assertNotIn("controlnet_pixel_correction_present", environment)
            self.assertFalse(any(name.endswith(".patch") for name in names))
            self.assertIn("DATASET/robot.jpg", names)
            self.assertIn("DATASET/robot.txt", names)
            self.assertIn("OUTPUTS/checkpoint-300/pytorch_lora_weights.safetensors", names)

    def test_standard_lora_data_root_rejects_escape_and_symlink(self):
        self.configure_standard_lora()
        evidence = BUILDER.validate_training_evidence(
            self.config.resolve(), self.dataset.resolve(), self.run_output.resolve()
        )
        self.assertEqual(evidence["target_image_count"], 1)

        backend_path = self.config / "multidatabackend.json"
        backend = json.loads(backend_path.read_text())
        outside = self.root / "outside-dataset"
        outside.mkdir()
        (outside / "robot.jpg").write_bytes(b"outside-image")
        (outside / "robot.txt").write_text("outside caption\n")
        backend[0]["instance_data_dir"] = str(outside)
        backend_path.write_text(json.dumps(backend))
        with self.assertRaisesRegex(SystemExit, "escapes its configured root"):
            BUILDER.validate_training_evidence(self.config.resolve(), self.dataset.resolve(), self.run_output.resolve())

        nested = self.dataset / "nested"
        nested.mkdir()
        (nested / "robot.jpg").write_bytes(b"nested-image")
        (nested / "robot.txt").write_text("nested caption\n")
        linked = self.dataset / "linked"
        linked.symlink_to(nested, target_is_directory=True)
        backend[0]["instance_data_dir"] = str(linked)
        backend_path.write_text(json.dumps(backend))
        with self.assertRaisesRegex(SystemExit, "contains a symlink"):
            BUILDER.validate_training_evidence(self.config.resolve(), self.dataset.resolve(), self.run_output.resolve())

    def test_standard_lora_classification_fails_closed_on_mutations(self):
        self.configure_standard_lora()
        config_path = self.config / "config.json"
        recipe_path = self.config / "hawkspan-recipe.json"
        backend_path = self.config / "multidatabackend.json"

        config = json.loads(config_path.read_text())
        config["controlnet"] = True
        config_path.write_text(json.dumps(config))
        recipe = json.loads(recipe_path.read_text())
        recipe["config"] = config
        recipe_path.write_text(json.dumps(recipe))
        with self.assertRaisesRegex(SystemExit, "not an approved standard LoRA or ControlNet/LoHa"):
            BUILDER.validate_training_evidence(self.config.resolve(), self.dataset.resolve(), self.run_output.resolve())

        self.configure_standard_lora()
        backend = json.loads(backend_path.read_text())
        backend[0]["conditioning_data"] = "controls"
        backend.append({
            "id": "controls", "type": "local", "dataset_type": "conditioning",
            "instance_data_dir": str(self.dataset / "conditioning"),
        })
        backend_path.write_text(json.dumps(backend))
        with self.assertRaisesRegex(SystemExit, "must not contain ControlNet conditioning"):
            BUILDER.validate_training_evidence(self.config.resolve(), self.dataset.resolve(), self.run_output.resolve())

        self.configure_standard_lora()
        recipe = json.loads(recipe_path.read_text())
        recipe["config"]["lora_type"] = "loha"
        recipe_path.write_text(json.dumps(recipe))
        with self.assertRaisesRegex(SystemExit, "does not exactly match"):
            BUILDER.validate_training_evidence(self.config.resolve(), self.dataset.resolve(), self.run_output.resolve())

    def test_standard_lora_requires_non_empty_caption_for_each_image(self):
        self.configure_standard_lora()
        (self.dataset / "robot.txt").write_text("\n")
        with self.assertRaisesRegex(SystemExit, "caption sidecar"):
            BUILDER.validate_training_evidence(self.config.resolve(), self.dataset.resolve(), self.run_output.resolve())

    def test_inventory_is_derived_from_exact_bytes_archived_after_source_mutation(self):
        source = (self.dataset / "targets" / "robot.jpg").resolve()
        original = source.read_bytes()
        mutated = b"target-image-mutated-during-build"
        real_zip_file_entry = BUILDER.zip_file_entry
        mutation_done = False

        def mutate_then_archive(archive, name, path, mode=0o600):
            nonlocal mutation_done
            if not mutation_done and path == source:
                source.write_bytes(mutated)
                mutation_done = True
            return real_zip_file_entry(archive, name, path, mode)

        with mock.patch.object(BUILDER, "zip_file_entry", side_effect=mutate_then_archive):
            result = BUILDER.build("authorization-race", self.target)

        self.assertTrue(mutation_done)
        with zipfile.ZipFile(result["packet_path"]) as archive:
            archived = archive.read("DATASET/targets/robot.jpg")
            inventory = json.loads(archive.read("SHA256-INVENTORY.json"))
        row = next(item for item in inventory["files"] if item["packet_path"] == "DATASET/targets/robot.jpg")
        self.assertEqual(archived, mutated)
        self.assertNotEqual(archived, original)
        self.assertEqual(row["size_bytes"], len(archived))
        self.assertEqual(row["sha256"], hashlib.sha256(archived).hexdigest())

    def test_startup_cleanup_removes_only_safe_exact_prefix_regular_files(self):
        stale = self.output / ".return-packet.interrupted"
        stale.write_bytes(b"partial-packet")
        unrelated = self.output / "return-packet.unrelated"
        unrelated.write_bytes(b"unrelated")
        near_prefix = self.output / ".return-packet"
        near_prefix.write_bytes(b"near-prefix")
        unsafe_directory = self.output / ".return-packet.directory"
        unsafe_directory.mkdir()
        symlink_target = self.output / "symlink-target"
        symlink_target.write_bytes(b"must-survive")
        unsafe_symlink = self.output / ".return-packet.symlink"
        unsafe_symlink.symlink_to(symlink_target)

        BUILDER.build("authorization-cleanup", self.target)

        self.assertFalse(stale.exists())
        self.assertEqual(unrelated.read_bytes(), b"unrelated")
        self.assertEqual(near_prefix.read_bytes(), b"near-prefix")
        self.assertTrue(unsafe_directory.is_dir())
        self.assertTrue(unsafe_symlink.is_symlink())
        self.assertEqual(symlink_target.read_bytes(), b"must-survive")

    def test_startup_cleanup_fails_closed_when_safe_partial_cannot_be_removed(self):
        stale = self.output / ".return-packet.interrupted"
        stale.write_bytes(b"partial-packet")
        lock_descriptor = BUILDER.acquire_package_build_lock(self.output.resolve())
        try:
            with mock.patch.object(BUILDER.os, "unlink", side_effect=PermissionError("denied")):
                with self.assertRaisesRegex(SystemExit, "cannot remove stale packet temporary"):
                    BUILDER.cleanup_stale_packet_temporaries(self.output.resolve(), lock_descriptor)
        finally:
            BUILDER.release_package_build_lock(lock_descriptor)
        self.assertEqual(stale.read_bytes(), b"partial-packet")

    def test_held_package_lock_refuses_without_cleaning_live_partial(self):
        live_partial = self.output / ".return-packet.live-build"
        live_partial.write_bytes(b"live-partial")
        lock_descriptor = BUILDER.acquire_package_build_lock(self.output.resolve())
        try:
            with self.assertRaisesRegex(SystemExit, "already in progress"):
                BUILDER.build("authorization-concurrent", self.target)
            self.assertEqual(live_partial.read_bytes(), b"live-partial")
        finally:
            BUILDER.release_package_build_lock(lock_descriptor)

    def test_unsafe_existing_package_lock_is_never_replaced(self):
        stale = self.output / ".return-packet.interrupted"
        stale.write_bytes(b"partial-packet")
        lock_path = self.output / BUILDER.PACKAGE_LOCK_NAME
        lock_target = self.output / "unsafe-lock-target"
        lock_target.write_bytes(b"target")
        lock_path.symlink_to(lock_target)
        with self.assertRaisesRegex(SystemExit, "not a safe owned regular file"):
            BUILDER.build("authorization-unsafe-lock", self.target)
        self.assertTrue(lock_path.is_symlink())
        self.assertEqual(lock_target.read_bytes(), b"target")
        self.assertEqual(stale.read_bytes(), b"partial-packet")

        lock_path.unlink()
        lock_path.mkdir()
        with self.assertRaisesRegex(SystemExit, "not a safe owned regular file"):
            BUILDER.build("authorization-unsafe-lock", self.target)
        self.assertTrue(lock_path.is_dir())
        self.assertEqual(stale.read_bytes(), b"partial-packet")

    def test_refuses_incomplete_revision_drift_and_path_escape(self):
        caption = self.stage / "dataset" / "conditioning" / "robot.txt"
        caption.unlink()
        with self.assertRaisesRegex(SystemExit, "caption sidecar"):
            BUILDER.build("authorization-1", self.target)
        caption.write_text("public robot caption\n")
        backend_path = self.stage / "config" / "multidatabackend.json"
        backend = json.loads(backend_path.read_text())
        backend[0]["conditioning_data"] = "missing-controls"
        backend_path.write_text(json.dumps(backend))
        with self.assertRaisesRegex(SystemExit, "missing conditioning dataset"):
            BUILDER.build("authorization-1", self.target)
        backend[0]["conditioning_data"] = "controls"
        backend_path.write_text(json.dumps(backend))
        record = json.loads(self.record.read_text())
        record["state"] = "running"
        self.record.write_text(json.dumps(record))
        with self.assertRaisesRegex(SystemExit, "not terminal"):
            BUILDER.build("authorization-1", self.target)
        record["state"] = "completed"
        record["revision_fingerprint"] = "b" * 64
        self.record.write_text(json.dumps(record))
        with self.assertRaisesRegex(SystemExit, "does not match"):
            BUILDER.build("authorization-1", self.target)
        record["revision_fingerprint"] = self.revision
        outside = self.root / "outside.log"
        outside.write_text("outside")
        record["log_path"] = str(outside)
        self.record.write_text(json.dumps(record))
        with self.assertRaisesRegex(SystemExit, "escapes"):
            BUILDER.build("authorization-1", self.target)

    def test_refuses_uncorrected_controlnet_validation_model_binding(self):
        validation = self.simpletuner / ".venv/lib/python3.12/site-packages/simpletuner/helpers/training/validation.py"
        validation.write_text("validation_model = self.model.unwrap_model()\n")
        with self.assertRaisesRegex(SystemExit, "validation model binding correction"):
            BUILDER.build("authorization-1", self.target)

    def test_refuses_missing_validation_sample_render(self):
        (self.run_output / "validation_images/step_0_robot.png").unlink()
        with self.assertRaisesRegex(SystemExit, "validation sample render"):
            BUILDER.build("authorization-1", self.target)

    def test_builds_stopped_recovery_packet_from_real_checkpoint_evidence(self):
        (self.run_output / "pytorch_lora_weights.safetensors").unlink()
        (self.run_output / "validation_images/step_0_robot.png").unlink()
        checkpoint = self.run_output / "checkpoint-300"
        checkpoint.mkdir()
        (checkpoint / "pytorch_lora_weights.safetensors").write_bytes(b"real-checkpoint-output")
        record = json.loads(self.record.read_text())
        record.update({"state": "stopped", "returncode": -15})
        self.record.write_text(json.dumps(record))
        result = BUILDER.build("authorization-stop-package", self.target)
        with zipfile.ZipFile(result["packet_path"]) as archive:
            summary = json.loads(archive.read("PACKET-SUMMARY.json"))
            self.assertEqual(summary["trainer_state"], "stopped")
            evidence = summary["training_evidence"]
            self.assertIsNone(evidence["final_lora"])
            self.assertEqual(evidence["checkpoints"], ["checkpoint-300"])
            self.assertIn("OUTPUTS/checkpoint-300/pytorch_lora_weights.safetensors", archive.namelist())

    def test_refuses_interrupted_packet_without_checkpoint_evidence(self):
        record = json.loads(self.record.read_text())
        record.update({"state": "stopped", "returncode": -15})
        self.record.write_text(json.dumps(record))
        with self.assertRaisesRegex(SystemExit, "at least one non-empty model checkpoint"):
            BUILDER.build("authorization-stop-package", self.target)

    def test_refuses_checkpoint_directory_without_model_weights(self):
        (self.run_output / "pytorch_lora_weights.safetensors").unlink()
        (self.run_output / "validation_images/step_0_robot.png").unlink()
        checkpoint = self.run_output / "checkpoint-300"
        checkpoint.mkdir()
        (checkpoint / "marker.txt").write_text("not model weights", encoding="utf-8")
        record = json.loads(self.record.read_text())
        record.update({"state": "stopped", "returncode": -15})
        self.record.write_text(json.dumps(record))
        with self.assertRaisesRegex(SystemExit, "at least one non-empty model checkpoint"):
            BUILDER.build("authorization-stop-package", self.target)

    def test_accepts_canonical_nested_controlnet_backend(self):
        backend = [{
            "id": "targets",
            "type": "local",
            "dataset_type": "image",
            "instance_data_dir": str(self.dataset / "targets"),
            "conditioning": {
                "type": "canny",
                "conditioning_type": "controlnet",
                "instance_data_dir": str(self.dataset / "conditioning"),
            },
        }]
        (self.config / "multidatabackend.json").write_text(json.dumps(backend))
        evidence = BUILDER.validate_training_evidence(
            self.config.resolve(), self.dataset.resolve(), self.run_output.resolve()
        )
        self.assertEqual(evidence["target_image_count"], 1)
        self.assertEqual(evidence["conditioning_image_count"], 1)

    def test_command_contract_and_fixed_package_action(self):
        with self.assertRaisesRegex(SystemExit, "exact safe ID"):
            BUILDER.main(["--job-id", "unsafe/id", "--target", self.target])
        launcher = (BUILDER_PATH.parent / "hawkspan-trainer-package.sh").read_text()
        self.assertIn('hawkspan-packet-builder.py" "$@"', launcher)
        self.assertNotIn("train", launcher)


if __name__ == "__main__":
    unittest.main()
