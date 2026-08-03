#!/usr/bin/env python3
"""Build one verified, new-only HawkSpan workload return packet."""

import argparse
import csv
import fcntl
import hashlib
import io
import json
import os
import re
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
TEMP_PACKET_PREFIX = ".return-packet."
PACKAGE_LOCK_NAME = ".hawkspan-return-packet.lock"


def fail(message):
    raise SystemExit(message)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Package one exact terminal HawkSpan trainer target."
    )
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--target", required=True)
    return parser.parse_args(argv)


def require_id(value, label):
    if not SAFE_ID.fullmatch(value):
        fail(f"{label} must be an exact safe ID")
    return value


def configured_root(name, create=False):
    value = os.environ.get(name)
    if not value or not Path(value).is_absolute():
        fail(f"{name} must name an absolute path")
    path = Path(value)
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.is_dir():
        fail(f"{name} is not a directory")
    return path.resolve(strict=True)


def confined(root, candidate, label, kind="file"):
    try:
        path = Path(candidate).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        fail(f"{label} is unavailable: {error}")
    if path == root or root not in path.parents:
        fail(f"{label} escapes its configured root")
    if kind == "file" and not path.is_file():
        fail(f"{label} is not a file")
    if kind == "directory" and not path.is_dir():
        fail(f"{label} is not a directory")
    return path


def confined_dataset_directory(root, candidate, label):
    candidate_path = Path(candidate)
    if not candidate_path.is_absolute():
        fail(f"{label} must be an absolute path")
    if ".." in candidate_path.parts:
        fail(f"{label} escapes its configured root")
    try:
        path = candidate_path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        fail(f"{label} is unavailable: {error}")
    if path != root and root not in path.parents:
        fail(f"{label} escapes its configured root")
    probe = candidate_path
    while True:
        if probe.is_symlink():
            fail(f"{label} contains a symlink")
        try:
            if probe.resolve(strict=True) == root:
                break
        except (OSError, RuntimeError) as error:
            fail(f"{label} is unavailable: {error}")
        if probe.parent == probe:
            fail(f"{label} escapes its configured root")
        probe = probe.parent
    if not path.is_dir():
        fail(f"{label} is not a directory")
    return path


def read_json(path, label):
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read valid {label} JSON: {error}")
    if not isinstance(document, dict):
        fail(f"{label} must be a JSON object")
    return document


def atomic_json(path, document):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
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


def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def visible_files(root):
    files = []
    for path in root.rglob("*"):
        if path.is_symlink():
            fail(f"packet source contains a symlink: {path.relative_to(root)}")
        if path.is_file() and not path.name.startswith("._") and path.name != ".DS_Store":
            files.append(path)
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def inventory(root, prefix):
    rows = []
    for path in visible_files(root):
        relative = path.relative_to(root).as_posix()
        rows.append({
            "packet_path": f"{prefix}/{relative}",
            "size_bytes": path.stat().st_size,
            "sha256": digest_file(path),
        })
    return rows


def inventory_csv(rows):
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(("packet_path", "size_bytes", "sha256"))
    for row in rows:
        writer.writerow((row["packet_path"], row["size_bytes"], row["sha256"]))
    return output.getvalue().encode()


def safe_lock_metadata(metadata):
    return (
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_uid == os.getuid()
        and metadata.st_nlink == 1
    )


def acquire_package_build_lock(output_root):
    directory_descriptor = None
    lock_descriptor = None
    try:
        directory_descriptor = os.open(output_root, os.O_RDONLY)
        flags = os.O_RDWR | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        try:
            lock_descriptor = os.open(
                PACKAGE_LOCK_NAME,
                flags | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=directory_descriptor,
            )
        except FileExistsError:
            existing = os.stat(PACKAGE_LOCK_NAME, dir_fd=directory_descriptor, follow_symlinks=False)
            if not safe_lock_metadata(existing):
                raise RuntimeError("existing packet build lock is not a safe owned regular file")
            lock_descriptor = os.open(PACKAGE_LOCK_NAME, flags, dir_fd=directory_descriptor)
        opened = os.fstat(lock_descriptor)
        current = os.stat(PACKAGE_LOCK_NAME, dir_fd=directory_descriptor, follow_symlinks=False)
        if not safe_lock_metadata(opened) or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError("packet build lock changed while it was opened")
        try:
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise
        current = os.stat(PACKAGE_LOCK_NAME, dir_fd=directory_descriptor, follow_symlinks=False)
        if not safe_lock_metadata(current) or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError("packet build lock changed while it was acquired")
        return lock_descriptor
    except BlockingIOError:
        if lock_descriptor is not None:
            os.close(lock_descriptor)
        fail("another packet build is already in progress")
    except (OSError, RuntimeError) as error:
        if lock_descriptor is not None:
            os.close(lock_descriptor)
        fail(f"cannot acquire safe packet build lock: {error}")
    finally:
        if directory_descriptor is not None:
            os.close(directory_descriptor)


def release_package_build_lock(lock_descriptor):
    try:
        fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
    finally:
        os.close(lock_descriptor)


def cleanup_stale_packet_temporaries(output_root, lock_descriptor):
    try:
        lock_metadata = os.fstat(lock_descriptor)
    except OSError as error:
        fail(f"cannot verify packet build lock for stale temporary cleanup: {error}")
    if not safe_lock_metadata(lock_metadata):
        fail("cannot clean stale packet temporaries without a safe packet build lock")
    try:
        output_descriptor = os.open(output_root, os.O_RDONLY)
    except OSError as error:
        fail(f"cannot open packet output root for stale temporary cleanup: {error}")
    try:
        try:
            entries = list(os.scandir(output_root))
        except OSError as error:
            fail(f"cannot inspect packet output root for stale temporary files: {error}")
        for entry in entries:
            if not entry.name.startswith(TEMP_PACKET_PREFIX):
                continue
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError as error:
                fail(f"cannot inspect stale packet temporary {entry.name}: {error}")
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
                continue
            try:
                os.unlink(entry.name, dir_fd=output_descriptor)
            except OSError as error:
                fail(f"cannot remove stale packet temporary {entry.name}: {error}")
    finally:
        os.close(output_descriptor)


def simpletuner_environment_evidence(workflow_type):
    root = configured_root("HAWKSPAN_SIMPLETUNER_ROOT")
    metadata = sorted((root / ".venv" / "lib").glob("python*/site-packages/simpletuner-*.dist-info/METADATA"))
    if len(metadata) != 1:
        fail("cannot identify exactly one installed SimpleTuner distribution")
    version = None
    for line in metadata[0].read_text(encoding="utf-8").splitlines():
        if line.startswith("Version: "):
            version = line.removeprefix("Version: ").strip()
            break
    if not version or not re.fullmatch(r"4\.5\.\d+", version):
        fail("installed SimpleTuner version is not supported 4.5.x")
    evidence = {
        "schema_version": 1,
        "workflow_type": workflow_type,
        "simpletuner_version": version,
        "simpletuner_root_basename": root.name,
        "distribution_metadata_sha256": digest_file(metadata[0]),
        "controlnet_compatibility_required": workflow_type == "controlnet_loha",
    }
    if workflow_type == "standard_lora":
        return {
            "ENVIRONMENT/SIMPLETUNER.json": (
                json.dumps(evidence, indent=2, sort_keys=True) + "\n"
            ).encode(),
        }
    if workflow_type != "controlnet_loha":
        fail("cannot collect environment evidence for an unsupported workflow type")
    site_packages = metadata[0].parent.parent
    collate = confined(site_packages, site_packages / "simpletuner/helpers/training/collate.py", "installed collator")
    collate_bytes = collate.read_bytes()
    correction = b"needs_reference_pixels or StateTracker.get_args().controlnet"
    if correction not in collate_bytes:
        fail("installed SimpleTuner lacks the required ControlNet pixel correction")
    pipeline = confined(
        site_packages,
        site_packages / "simpletuner/helpers/models/sdxl/pipeline.py",
        "installed SDXL pipeline",
    )
    pipeline_bytes = pipeline.read_bytes()
    validation_correction = b'getattr(self.unet.config, "time_cond_proj_dim", None)'
    if pipeline_bytes.count(validation_correction) < 2 or b"embedding_dim=time_cond_proj_dim" not in pipeline_bytes:
        fail("installed SimpleTuner lacks the required SDXL ControlNet validation correction")
    validation = confined(
        site_packages,
        site_packages / "simpletuner/helpers/training/validation.py",
        "installed validation setup",
    )
    validation_bytes = validation.read_bytes()
    model_binding_correction = b"self.model.unwrap_model(model=self.model.model)"
    if model_binding_correction not in validation_bytes:
        fail("installed SimpleTuner lacks the required ControlNet validation model binding correction")
    compatibility_root = Path(__file__).resolve().parent
    patches = {
        name: confined(compatibility_root, compatibility_root / f"compat/{name}", "ControlNet compatibility patch")
        for name in (
            "simpletuner-4.5-controlnet-pixels.patch",
            "simpletuner-4.5-sdxl-controlnet-validation.patch",
        )
    }
    evidence.update({
        "collate_sha256": digest_bytes(collate_bytes),
        "sdxl_pipeline_sha256": digest_bytes(pipeline_bytes),
        "validation_setup_sha256": digest_bytes(validation_bytes),
        "controlnet_pixel_correction_present": True,
        "sdxl_controlnet_validation_correction_present": True,
        "controlnet_validation_model_binding_correction_present": True,
        "compatibility_patch_sha256": {name: digest_file(patch) for name, patch in patches.items()},
    })
    return {
        "ENVIRONMENT/SIMPLETUNER.json": (json.dumps(evidence, indent=2, sort_keys=True) + "\n").encode(),
        **{f"ENVIRONMENT/{name}": patch.read_bytes() for name, patch in patches.items()},
    }


def staged_workflow_type(config_dir, backend):
    config = read_json(config_dir / "config.json", "staged trainer config")
    recipe = read_json(config_dir / "hawkspan-recipe.json", "staged HawkSpan recipe")
    recipe_config = recipe.get("config")
    if not isinstance(recipe_config, dict) or recipe_config != config:
        fail("staged trainer config does not exactly match the staged HawkSpan recipe")
    if config.get("model_type") != "lora":
        fail("staged workflow is not an explicit LoRA workflow")

    has_conditioning = any(
        isinstance(item, dict)
        and (
            item.get("dataset_type") == "conditioning"
            or "conditioning" in item
            or "conditioning_data" in item
        )
        for item in backend
    )
    controlnet = config.get("controlnet")
    if config.get("lora_type") == "standard" and (controlnet is None or controlnet is False):
        if has_conditioning:
            fail("standard LoRA workflow must not contain ControlNet conditioning")
        return "standard_lora"
    if config.get("lora_type") == "loha" and config.get("controlnet") is True:
        if not has_conditioning:
            fail("ControlNet/LoHa workflow has no conditioning mapping")
        return "controlnet_loha"
    fail("staged workflow is not an approved standard LoRA or ControlNet/LoHa configuration")


def validate_training_evidence(config_dir, data_dir, run_output, trainer_state="completed"):
    required_config = (
        "config.json",
        "hawkspan-recipe.json",
        "multidatabackend.json",
        "TRAINING_READINESS_POLICY.json",
        "validation-prompts.json",
    )
    for name in required_config:
        confined(config_dir, config_dir / name, f"staged {name}")
    try:
        backend = json.loads((config_dir / "multidatabackend.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read staged backend mapping: {error}")
    if not isinstance(backend, list):
        fail("staged backend mapping must be an array")
    entries = {}
    for item in backend:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            fail("staged backend contains an invalid entry")
        if item["id"] in entries:
            fail("staged backend contains a duplicate dataset ID")
        entries[item["id"]] = item
    workflow_type = staged_workflow_type(config_dir, backend)
    image_entries = [item for item in entries.values() if item.get("dataset_type") == "image"]
    if len(image_entries) != 1:
        fail("staged workflow must contain exactly one image dataset")
    target_images = []
    conditioning_images = []
    if workflow_type == "standard_lora":
        target_entry = image_entries[0]
        if target_entry.get("type") != "local" or target_entry.get("caption_strategy") != "textfile":
            fail("standard LoRA image dataset must be local with textfile captions")
        target_dir = confined_dataset_directory(
            data_dir,
            target_entry.get("instance_data_dir", ""),
            "target image directory",
        )
        target_images.extend(
            path for path in visible_files(target_dir)
            if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        )
        if not target_images:
            fail("staged standard LoRA dataset must contain images")
    else:
        target_entry = image_entries[0]
        if not (target_entry.get("conditioning_data") or isinstance(target_entry.get("conditioning"), dict)):
            fail("staged backend has no ControlNet target-to-conditioning mapping")
        target_dir = confined(data_dir, target_entry.get("instance_data_dir", ""), "target image directory", "directory")
        nested = target_entry.get("conditioning")
        if isinstance(nested, dict):
            if nested.get("type") != "canny" or nested.get("conditioning_type") != "controlnet":
                fail("staged nested conditioning is not Canny ControlNet data")
            conditioning_dir = confined(
                data_dir, nested.get("instance_data_dir", ""),
                "conditioning image directory", "directory",
            )
        else:
            links = target_entry.get("conditioning_data")
            links = links if isinstance(links, list) else [links]
            if len(links) != 1 or not isinstance(links[0], str):
                fail("staged backend must reference exactly one conditioning dataset")
            conditioning_entry = entries.get(links[0])
            if not conditioning_entry or conditioning_entry.get("dataset_type") != "conditioning":
                fail("staged backend references a missing conditioning dataset")
            conditioning_dir = confined(
                data_dir, conditioning_entry.get("instance_data_dir", ""),
                "conditioning image directory", "directory",
            )
        target_images.extend(path for path in visible_files(target_dir) if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
        conditioning_images.extend(path for path in visible_files(conditioning_dir) if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
        if not target_images or not conditioning_images:
            fail("staged ControlNet dataset must contain target and conditioning images")
    for image in target_images + conditioning_images:
        caption = image.with_suffix(".txt")
        if not caption.is_file() or not caption.read_text(encoding="utf-8").strip():
            fail(f"staged image lacks a non-empty caption sidecar: {image.relative_to(data_dir)}")
    output_files = visible_files(run_output)
    loras = [path for path in output_files if path.suffix.lower() == ".safetensors" and "checkpoint-" not in path.as_posix()]
    if len(loras) > 1 or any(path.stat().st_size == 0 for path in loras):
        fail("trainer output may contain at most one non-empty final LoRA")
    validation_root = run_output / "validation_images"
    validation_renders = []
    if validation_root.is_dir() and not validation_root.is_symlink():
        validation_renders = [
            path for path in visible_files(validation_root)
            if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"} and path.stat().st_size > 0
        ]
    def has_model_checkpoint(path):
        return any(
            item.suffix.lower() == ".safetensors" and item.stat().st_size > 0
            for item in visible_files(path)
        )

    checkpoint_roots = [
        path for path in run_output.iterdir()
        if path.is_dir() and not path.is_symlink() and path.name.startswith("checkpoint-") and has_model_checkpoint(path)
    ]
    preserved_root = run_output / "PRESERVED_CHECKPOINTS"
    if preserved_root.is_dir() and not preserved_root.is_symlink():
        checkpoint_roots.extend(
            path for path in preserved_root.iterdir()
            if path.is_dir() and not path.is_symlink() and path.name.startswith("checkpoint-") and has_model_checkpoint(path)
        )
    if trainer_state == "completed" and len(loras) != 1:
        fail("successfully completed trainer output must contain exactly one non-empty final LoRA")
    if trainer_state == "completed" and not validation_renders:
        fail("trainer output must contain at least one non-empty validation sample render")
    if trainer_state in {"stopped", "failed"} and not checkpoint_roots:
        fail("stopped or failed trainer output must contain at least one non-empty model checkpoint")
    return {
        "workflow_type": workflow_type,
        "trainer_state": trainer_state,
        "target_image_count": len(target_images),
        "conditioning_image_count": len(conditioning_images),
        "caption_sidecar_count": len(target_images) + len(conditioning_images),
        "final_lora": loras[0].relative_to(run_output).as_posix() if loras else None,
        "checkpoint_count": len(checkpoint_roots),
        "checkpoints": [path.relative_to(run_output).as_posix() for path in sorted(checkpoint_roots)],
        "validation_render_count": len(validation_renders),
        "validation_renders": [path.relative_to(run_output).as_posix() for path in validation_renders],
    }


def zip_entry(archive, name, data, mode=0o600):
    info = zipfile.ZipInfo(str(PurePosixPath(name)), FIXED_ZIP_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = mode << 16
    archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)


def zip_file_entry(archive, name, path, mode=0o600):
    info = zipfile.ZipInfo(str(PurePosixPath(name)), FIXED_ZIP_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = mode << 16
    info._compresslevel = 6
    hasher = hashlib.sha256()
    size = 0
    with path.open("rb") as source, archive.open(info, "w", force_zip64=True) as destination:
        while chunk := source.read(1024 * 1024):
            destination.write(chunk)
            hasher.update(chunk)
            size += len(chunk)
    return {"packet_path": info.filename, "size_bytes": size, "sha256": hasher.hexdigest()}


def exact_manifest(runtime_root, target):
    jobs_root = runtime_root / "jobs"
    matches = sorted(jobs_root.glob(f"{target}--*/STAGE-MANIFEST.json"))
    if len(matches) != 1:
        fail(f"target is not exactly one staged runtime job: {target}")
    path = confined(jobs_root.resolve(strict=True), matches[0], "stage manifest")
    manifest = read_json(path, "stage manifest")
    revision = manifest.get("revision_fingerprint")
    if manifest.get("job_id") != target or not isinstance(revision, str) or not SHA256.fullmatch(revision):
        fail("stage manifest does not bind the exact target and revision")
    runtime_job = manifest.get("runtime_job")
    if not isinstance(runtime_job, dict) or runtime_job.get("job_id") != target:
        fail("stage manifest runtime job does not match the exact target")
    return path, manifest


def terminal_record(state_root, target, revision):
    path = confined(state_root, state_root / "trainer-control" / f"{target}.json", "trainer record")
    record = read_json(path, "trainer record")
    if record.get("target") != target or record.get("revision_fingerprint") != revision:
        fail("trainer record does not match the exact target revision")
    state = record.get("state")
    if state not in {"completed", "stopped", "failed"}:
        fail("trainer record is not terminal")
    if state == "completed" and record.get("returncode") != 0:
        fail("completed trainer record does not have return code 0")
    if state == "failed" and (not isinstance(record.get("returncode"), int) or record["returncode"] == 0):
        fail("failed trainer record does not have a non-zero integer return code")
    return path, record


def build(job_id, target):
    output_root = configured_root("HAWKSPAN_WORKLOAD_OUTPUT_ROOT", create=True)
    lock_descriptor = acquire_package_build_lock(output_root)
    try:
        return build_locked(job_id, target, output_root, lock_descriptor)
    finally:
        release_package_build_lock(lock_descriptor)


def build_locked(job_id, target, output_root, lock_descriptor):
    runtime_root = configured_root("HAWKSPAN_WORKLOAD_RUNTIME_ROOT")
    state_root = configured_root("HAWKSPAN_WORKLOAD_STATE_ROOT")
    log_root = configured_root("HAWKSPAN_WORKLOAD_LOG_ROOT")
    manifest_path, manifest = exact_manifest(runtime_root, target)
    revision = manifest["revision_fingerprint"]
    record_path, record = terminal_record(state_root, target, revision)
    runtime_job = manifest["runtime_job"]
    stage_root = manifest_path.parent.resolve(strict=True)
    config_dir = confined(stage_root, runtime_job.get("config_dir", ""), "staged config", "directory")
    data_dir = confined(stage_root, runtime_job.get("data_dir", ""), "staged dataset", "directory")
    run_output = confined(runtime_root, runtime_job.get("output_dir", ""), "trainer output", "directory")
    log_path = confined(log_root, record.get("log_path", ""), "trainer log")

    evidence = validate_training_evidence(config_dir, data_dir, run_output, record["state"])
    environment_files = simpletuner_environment_evidence(evidence["workflow_type"])

    ledger_path = output_root / "return-packet-ledger.json"
    ledger = read_json(ledger_path, "packet ledger") if ledger_path.exists() else {"schema_version": 1, "packets": []}
    packets = ledger.get("packets")
    if not isinstance(packets, list):
        fail("packet ledger packets must be an array")
    cleanup_stale_packet_temporaries(output_root, lock_descriptor)
    descriptor, temporary = tempfile.mkstemp(prefix=TEMP_PACKET_PREFIX, dir=output_root)
    os.close(descriptor)
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            rows = []
            for prefix, root in (("CONFIG", config_dir), ("DATASET", data_dir), ("OUTPUTS", run_output)):
                for path in visible_files(root):
                    rows.append(zip_file_entry(archive, f"{prefix}/{path.relative_to(root).as_posix()}", path))
            rows.append(zip_file_entry(archive, "LOGS/trainer.log", log_path))
            rows.append(zip_file_entry(archive, "METADATA/STAGE-MANIFEST.json", manifest_path))
            rows.append(zip_file_entry(archive, "METADATA/TRAINER-RECORD.json", record_path))
            for name, data in sorted(environment_files.items()):
                zip_entry(archive, name, data)
                rows.append({"packet_path": name, "size_bytes": len(data), "sha256": digest_bytes(data)})
            rows.sort(key=lambda row: row["packet_path"])
            inventory_data = inventory_csv(rows)
            inventory_sha = digest_bytes(inventory_data)
            inventory_json_data = (json.dumps({"schema_version": 1, "files": rows}, indent=2, sort_keys=True) + "\n").encode()
            inventory_json_sha = digest_bytes(inventory_json_data)
            identity = f"{target}:{revision}:{inventory_sha}"
            packet_name = f"{target}--{revision[:12]}--{inventory_sha[:12]}--return-packet.zip"
            packet_path = output_root / packet_name
            prior = next((item for item in packets if isinstance(item, dict) and item.get("identity") == identity), None)
            if prior:
                prior_path = confined(output_root, prior.get("packet_path", ""), "prior packet")
                if digest_file(prior_path) != prior.get("packet_sha256"):
                    fail("existing ledger packet no longer matches its SHA-256")
                print(json.dumps({"built": False, **prior}, sort_keys=True))
                return prior
            if packet_path.exists():
                fail(f"refusing to overwrite untracked packet: {packet_path}")
            summary = {
                "schema_version": 1,
                "authorization_job_id": job_id,
                "target": target,
                "revision_fingerprint": revision,
                "trainer_state": record["state"],
                "trainer_returncode": record["returncode"],
                "inventory_sha256": inventory_sha,
                "inventory_json_sha256": inventory_json_sha,
                "training_evidence": evidence,
            }
            zip_entry(archive, "SHA256-INVENTORY.csv", inventory_data)
            zip_entry(archive, "SHA256-INVENTORY.json", inventory_json_data)
            zip_entry(archive, "PACKET-SUMMARY.json", (json.dumps(summary, indent=2, sort_keys=True) + "\n").encode())
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                fail("packet archive verification failed")
        os.chmod(temporary, 0o600)
        os.replace(temporary, packet_path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass

    packet_sha = digest_file(packet_path)
    entry = {
        "identity": identity,
        "target": target,
        "revision_fingerprint": revision,
        "inventory_sha256": inventory_sha,
        "packet_path": str(packet_path),
        "packet_sha256": packet_sha,
        "status": "packaged",
    }
    ledger["packets"] = packets + [entry]
    atomic_json(ledger_path, ledger)
    print(json.dumps({"built": True, **entry}, sort_keys=True))
    return entry


def main(argv=None):
    args = parse_args(argv)
    build(require_id(args.job_id, "job ID"), require_id(args.target, "target"))


if __name__ == "__main__":
    main()
