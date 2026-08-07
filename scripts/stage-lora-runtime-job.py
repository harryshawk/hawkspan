#!/usr/bin/env python3
"""Stage one immutable LoRA revision outside macOS-protected Documents.

This is preparation only. It never starts training and never removes a source,
checkpoint, cache, or prior staged revision.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
REQUIRED_CHECKPOINT_FILES = (
    "pytorch_lora_weights.safetensors",
    "optimizer.bin",
    "scheduler.bin",
    "training_state.json",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--base-link-config", type=Path, required=True)
    parser.add_argument("--caption-overlay-root", type=Path)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and not path.name.startswith("._") and path.name != ".DS_Store"
    )


def inventory(root: Path) -> list[dict]:
    return [
        {
            "relative_path": str(path.relative_to(root)),
            "size_bytes": path.stat().st_size,
            "sha256": sha256(path),
        }
        for path in files(root)
    ]


def directory_revision_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in files(root):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(str(path.stat().st_size).encode())
        digest.update(b"\0")
        digest.update(sha256(path).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def checkpoint_evidence(checkpoint: Path) -> dict:
    match = re.fullmatch(r"checkpoint-(\d+)", checkpoint.name)
    problems: list[str] = []
    required_files: dict[str, dict] = {}
    if not checkpoint.is_dir() or checkpoint.is_symlink():
        problems.append("checkpoint_directory_missing_or_not_regular")
    if not match:
        problems.append("checkpoint_basename_must_be_checkpoint_N")
    if checkpoint.is_dir() and not checkpoint.is_symlink():
        for name in REQUIRED_CHECKPOINT_FILES:
            candidate = checkpoint / name
            if not candidate.exists():
                problems.append(f"missing_required_file:{name}")
            elif not candidate.is_file() or candidate.is_symlink():
                problems.append(f"required_path_not_regular_file:{name}")
            elif candidate.stat().st_size <= 0:
                problems.append(f"required_file_empty:{name}")
            else:
                required_files[name] = {
                    "path": str(candidate),
                    "size_bytes": candidate.stat().st_size,
                    "sha256": sha256(candidate),
                }
    training_state = None
    state_entry = required_files.get("training_state.json")
    if state_entry:
        try:
            training_state = json.loads(Path(state_entry["path"]).read_text())
            if not isinstance(training_state, dict):
                problems.append("training_state_json_must_be_an_object")
        except (OSError, json.JSONDecodeError):
            problems.append("training_state_json_invalid")
    expected_step = int(match.group(1)) if match else None
    global_step = training_state.get("global_step") if isinstance(training_state, dict) else None
    if isinstance(training_state, dict):
        if isinstance(global_step, bool) or not isinstance(global_step, int) or global_step < 1:
            problems.append("training_state_global_step_invalid")
        elif expected_step is not None and global_step != expected_step:
            problems.append("checkpoint_basename_global_step_mismatch")
    complete = not problems
    return {
        "path": str(checkpoint.resolve()),
        "checkpoint_name": checkpoint.name,
        "step": expected_step,
        "global_step": global_step if isinstance(global_step, int) and not isinstance(global_step, bool) else None,
        "complete": complete,
        "problems": problems,
        "required_files": required_files,
        "bytes": sum(path.stat().st_size for path in files(checkpoint)) if checkpoint.is_dir() else 0,
        "revision_sha256": directory_revision_sha256(checkpoint) if complete else None,
    }


def copy_verified_checkpoint(source: Path, destination: Path, expected_sha256: str) -> dict:
    source_evidence = checkpoint_evidence(source)
    if not source_evidence["complete"]:
        raise SystemExit(
            "recovery checkpoint is incomplete: " + json.dumps(source_evidence, sort_keys=True)
        )
    if not expected_sha256 or source_evidence["revision_sha256"] != expected_sha256:
        raise SystemExit("recovery checkpoint differs from its prepared SHA-256 evidence")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination_evidence = checkpoint_evidence(destination)
        if (
            not destination_evidence["complete"]
            or destination_evidence["revision_sha256"] != expected_sha256
        ):
            raise SystemExit(f"refusing differing runtime recovery checkpoint: {destination}")
        return destination_evidence
    temporary_root = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}-stage-", dir=destination.parent)
    )
    temporary = temporary_root / destination.name
    try:
        clone_tree(source, temporary)
        destination_evidence = checkpoint_evidence(temporary)
        if (
            not destination_evidence["complete"]
            or destination_evidence["revision_sha256"] != expected_sha256
        ):
            raise SystemExit("runtime recovery checkpoint failed content verification")
        temporary.replace(destination)
        return checkpoint_evidence(destination)
    finally:
        if temporary_root.exists():
            shutil.rmtree(temporary_root)


def training_input_files(root: Path, include_captions: bool) -> list[Path]:
    allowed = IMAGE_SUFFIXES | ({".txt"} if include_captions else set())
    return [path for path in files(root) if path.suffix.lower() in allowed]


def training_input_inventory(root: Path, include_captions: bool) -> list[dict]:
    return [
        {
            "relative_path": str(path.relative_to(root)),
            "size_bytes": path.stat().st_size,
            "sha256": sha256(path),
        }
        for path in training_input_files(root, include_captions)
    ]


def clone_tree(source: Path, destination: Path) -> None:
    if not source.is_dir():
        raise SystemExit(f"source directory is unavailable: {source}")
    result = subprocess.run(
        ["/bin/cp", "-cR", str(source), str(destination)],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return
    shutil.copytree(source, destination, copy_function=shutil.copy2)


def clone_training_inputs(source: Path, destination: Path, include_captions: bool) -> None:
    if not source.is_dir():
        raise SystemExit(f"source directory is unavailable: {source}")
    destination.mkdir(parents=True)
    for source_path in training_input_files(source, include_captions):
        target = destination / source_path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target)


def validation_input_inventory(
    source_config: Path,
    source_data: Path,
    source_conditioning: Path | None,
) -> tuple[dict, list[dict]]:
    policy = json.loads((source_config / "TRAINING_READINESS_POLICY.json").read_text())
    library_path = Path(policy["validation_prompt_library"])
    library = json.loads(library_path.read_text())
    references = [
        (prompt["id"], key, prompt.get(key))
        for prompt in library.get("prompts", [])
        for key in ("control_image", "source_target")
        if prompt.get(key)
    ]
    if references and library.get("controls_are_relative_to") != "dataset":
        raise SystemExit(
            "validation inputs require controls_are_relative_to=dataset"
        )

    resolved: list[dict] = []
    for prompt_id, key, value in references:
        relative = Path(str(value))
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit(
                f"validation prompt {prompt_id} has invalid {key}: {relative}"
            )
        candidates = [source_data.parent / relative]
        if key == "source_target":
            candidates.append(source_data / relative.name)
        elif source_conditioning:
            candidates.append(source_conditioning / relative.name)
        matches = [candidate for candidate in candidates if candidate.is_file()]
        if not matches:
            raise SystemExit(
                f"validation prompt {prompt_id} is missing {key}: {relative}"
            )
        digests = {sha256(candidate) for candidate in matches}
        if len(digests) != 1:
            raise SystemExit(
                f"validation prompt {prompt_id} has ambiguous {key}: {relative}"
            )
        resolved.append({
            "prompt_id": prompt_id,
            "kind": key,
            "relative_path": str(relative),
            "source_path": str(matches[0]),
            "size_bytes": matches[0].stat().st_size,
            "sha256": next(iter(digests)),
        })
    return ({
        "path": str(library_path),
        "size_bytes": library_path.stat().st_size,
        "sha256": sha256(library_path),
    }, resolved)


def clone_validation_inputs(entries: list[dict], destination_root: Path) -> None:
    for entry in entries:
        source = Path(entry["source_path"])
        target = destination_root / entry["relative_path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if sha256(target) != entry["sha256"]:
                raise SystemExit(
                    f"staged validation input conflicts with training input: {target}"
                )
            continue
        shutil.copy2(source, target)


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", dir=path.parent, delete=False, prefix=f".{path.name}.", suffix=".tmp"
    ) as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


class SourceReadTimeout(RuntimeError):
    pass


def read_json_bounded(path: Path, seconds: int = 5):
    def alarm_handler(_signum, _frame):
        raise SourceReadTimeout(f"timed out reading protected source: {path}")

    prior = signal.signal(signal.SIGALRM, alarm_handler)
    signal.alarm(seconds)
    try:
        return json.loads(path.read_text())
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, prior)


def main() -> None:
    args = parse_args()
    base_link_config = json.loads(args.base_link_config.read_text())
    manifest = read_json_bounded(args.source_manifest)
    matches = [entry for entry in manifest if entry.get("job_id") == args.job_id]
    if len(matches) != 1:
        raise SystemExit(f"job must match exactly one source manifest entry: {args.job_id}")
    source_job = matches[0]
    source_data = Path(source_job["data_dir"])
    source_config = Path(source_job["config_dir"])
    source_policy = json.loads(
        (source_config / "TRAINING_READINESS_POLICY.json").read_text()
    )
    source_backends = json.loads(
        (source_config / "multidatabackend.json").read_text()
    )
    configured_conditioning = {
        str(backend.get("conditioning", {}).get("instance_data_dir", "")).strip()
        for backend in source_backends
        if backend.get("conditioning")
    }
    configured_conditioning.discard("")
    if len(configured_conditioning) > 1:
        raise SystemExit("staging requires one shared conditioning directory per job")
    source_conditioning_value = source_job.get("conditioning_dir") or next(
        iter(configured_conditioning), None
    )
    source_conditioning = (
        Path(source_conditioning_value) if source_conditioning_value else None
    )
    if source_conditioning and not source_conditioning.is_dir():
        raise SystemExit(f"conditioning directory is unavailable: {source_conditioning}")
    source_inventory = training_input_inventory(source_data, include_captions=True)
    config_inventory = inventory(source_config)
    conditioning_inventory = (
        training_input_inventory(source_conditioning, include_captions=False)
        if source_conditioning else []
    )
    source_validation_library, source_validation_inputs = validation_input_inventory(
        source_config, source_data, source_conditioning
    )
    source_recovery_checkpoint = None
    source_recovery_evidence = None
    if source_policy.get("recovery_checkpoint"):
        source_recovery_checkpoint = Path(source_policy["recovery_checkpoint"]).resolve()
        source_recovery_evidence = checkpoint_evidence(source_recovery_checkpoint)
        expected_recovery_sha = source_policy.get("recovery_checkpoint_revision_sha256")
        provenance = source_policy.get("recovery_checkpoint_provenance")
        if not source_recovery_evidence["complete"]:
            raise SystemExit(
                "source recovery checkpoint is incomplete: "
                + json.dumps(source_recovery_evidence, sort_keys=True)
            )
        if (
            not expected_recovery_sha
            or source_recovery_evidence["revision_sha256"] != expected_recovery_sha
        ):
            raise SystemExit("source recovery checkpoint does not match prepared hash evidence")
        if not isinstance(provenance, dict) or not provenance.get("source_job_id"):
            raise SystemExit("source recovery checkpoint lacks prepared provenance")
        expected_parent = source_job.get("revision_of") or source_job.get("job_id")
        if provenance["source_job_id"] != expected_parent:
            raise SystemExit("source recovery checkpoint provenance names the wrong source job")
        source_output_root = Path(source_job["output_dir"]).resolve()
        prepared_checkpoint = Path(
            source_policy.get("staged_recovery_checkpoint", "")
        ).resolve()
        if source_recovery_checkpoint != prepared_checkpoint:
            raise SystemExit("source recovery checkpoint differs from its prepared path")
        if not source_recovery_checkpoint.is_relative_to(source_output_root):
            raise SystemExit(
                "prepared recovery checkpoint is outside the target job output"
            )
    overlay_job_root = None
    source_overlay_inventory = []
    if args.caption_overlay_root:
        overlay_job_root = args.caption_overlay_root / "jobs" / args.job_id
        if not overlay_job_root.is_dir():
            raise SystemExit(f"caption overlay job is unavailable: {overlay_job_root}")
        source_overlay_inventory = inventory(overlay_job_root)
    source_revision = hashlib.sha256(
        json.dumps(
            {
                "job": source_job,
                "dataset": source_inventory,
                "conditioning": conditioning_inventory,
                "validation_library": source_validation_library,
                "validation_inputs": source_validation_inputs,
                "config": config_inventory,
                "caption_overlay": source_overlay_inventory,
                "recovery_checkpoint": source_recovery_evidence,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()

    jobs_root = args.runtime_root / "jobs"
    final_root = jobs_root / f"{args.job_id}--{source_revision[:12]}"
    stage_manifest_path = final_root / "STAGE-MANIFEST.json"
    if final_root.exists():
        if stage_manifest_path.is_file():
            existing = json.loads(stage_manifest_path.read_text())
            if existing.get("source_revision_sha256") != source_revision:
                raise SystemExit("existing staged path has a different source revision")
            print(json.dumps({
                "staged": True,
                "already_present": True,
                "runtime_job_root": str(final_root),
                "runtime_manifest": existing["runtime_manifest"],
                "revision_fingerprint": existing.get("revision_fingerprint"),
                "recovery_checkpoint": existing.get("recovery_checkpoint"),
                "training_started": False,
            }, indent=2))
            return
        # A prior attempt can fail after the atomic directory rename but before
        # its completion manifest is written. The deterministic staged copy is
        # disposable; source data and output/checkpoint roots are separate.
        shutil.rmtree(final_root)

    jobs_root.mkdir(parents=True, exist_ok=True)
    temporary_root = Path(
        tempfile.mkdtemp(prefix=f".{args.job_id}-stage-", dir=jobs_root)
    )
    try:
        data_dir = temporary_root / "dataset"
        config_dir = temporary_root / "config"
        conditioning_dir = temporary_root / "conditioning"
        clone_training_inputs(source_data, data_dir, include_captions=True)
        clone_tree(source_config, config_dir)
        if source_conditioning:
            clone_training_inputs(
                source_conditioning, conditioning_dir, include_captions=False
            )
        clone_validation_inputs(source_validation_inputs, temporary_root)
        preserved_captions = temporary_root / "preserved-source-captions"
        preserved_captions.mkdir()
        for caption in sorted(data_dir.rglob("*.txt")):
            relative = caption.relative_to(data_dir)
            target = preserved_captions / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(caption, target)

        overlay_count = 0
        overlay_inventory = []
        if overlay_job_root:
            for caption in sorted(overlay_job_root.rglob("*.txt")):
                relative = caption.relative_to(overlay_job_root)
                direct_target = data_dir / relative
                if direct_target.exists():
                    targets = [direct_target]
                else:
                    targets = list(data_dir.rglob(caption.name))
                if len(targets) != 1:
                    raise SystemExit(
                        f"overlay caption must resolve to exactly one staged sidecar: "
                        f"{relative}; matches={len(targets)}"
                    )
                target = targets[0]
                image_matches = [
                    candidate
                    for suffix in (".jpg", ".jpeg", ".png", ".webp", ".JPG", ".JPEG", ".PNG")
                    if (candidate := target.with_suffix(suffix)).is_file()
                ]
                if not image_matches:
                    raise SystemExit(f"overlay caption has no paired staged image: {relative}")
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(caption, target)
                overlay_count += 1
                overlay_inventory.append({
                    "relative_path": str(relative),
                    "sha256": sha256(caption),
                })

        config_path = config_dir / "config.json"
        backend_path = config_dir / "multidatabackend.json"
        policy_path = config_dir / "TRAINING_READINESS_POLICY.json"
        config = json.loads(config_path.read_text())
        backends = json.loads(backend_path.read_text())
        policy = json.loads(policy_path.read_text())
        output_dir = args.runtime_root / "outputs" / args.job_id
        cache_root = args.runtime_root / "cache" / args.job_id
        config["data_backend_config"] = str(backend_path)
        config["output_dir"] = str(output_dir)
        runtime_recovery_checkpoint = None
        runtime_recovery_evidence = None
        if source_recovery_checkpoint:
            runtime_recovery_checkpoint = output_dir / source_recovery_checkpoint.name
            runtime_recovery_evidence = copy_verified_checkpoint(
                source_recovery_checkpoint,
                runtime_recovery_checkpoint,
                source_recovery_evidence["revision_sha256"],
            )
            config["resume_from_checkpoint"] = str(runtime_recovery_checkpoint)
            policy.setdefault(
                "source_recovery_checkpoint",
                policy["recovery_checkpoint_provenance"]["source_checkpoint_path"],
            )
            policy["prepared_recovery_checkpoint"] = str(source_recovery_checkpoint)
            policy["recovery_checkpoint"] = str(runtime_recovery_checkpoint)
            policy["staged_recovery_checkpoint"] = str(runtime_recovery_checkpoint)
            policy["runtime_recovery_checkpoint"] = str(runtime_recovery_checkpoint)
            policy["recovery_checkpoint_revision_sha256"] = runtime_recovery_evidence[
                "revision_sha256"
            ]
            policy["recovery_checkpoint_provenance"] = {
                **policy["recovery_checkpoint_provenance"],
                "prepared_checkpoint_path": str(source_recovery_checkpoint),
                "runtime_checkpoint_path": str(runtime_recovery_checkpoint),
                "runtime_revision_sha256": runtime_recovery_evidence["revision_sha256"],
            }
        else:
            config.pop("resume_from_checkpoint", None)
        for backend in backends:
            if backend.get("dataset_type") == "text_embeds":
                backend["cache_dir"] = str(cache_root / "text")
            elif backend.get("type") == "local":
                backend["instance_data_dir"] = str(data_dir)
                backend["cache_dir_vae"] = str(cache_root / "vae")
                if backend.get("conditioning") and source_conditioning:
                    backend["conditioning"]["instance_data_dir"] = str(
                        conditioning_dir
                    )
                backend["disable_multiline_split"] = bool(
                    policy.get("disable_multiline_split", False)
                )
        validation_source = Path(policy["validation_prompt_library"])
        validation_target = config_dir / "validation-prompt-library.json"
        if validation_source.resolve() != validation_target.resolve():
            shutil.copy2(validation_source, validation_target)
        policy["validation_prompt_library"] = str(validation_target)
        if overlay_count:
            policy["expected_caption_variants"] = int(
                policy.get("expected_caption_variants", 1)
            )
        atomic_json(config_path, config)
        atomic_json(backend_path, backends)
        atomic_json(policy_path, policy)

        runtime_manifest_path = args.runtime_root / "captioned-lora-manifest.json"
        runtime_job = {
            **source_job,
            "data_dir": str(data_dir),
            "config_dir": str(config_dir),
            "output_dir": str(output_dir),
            "runtime_staged": True,
            "source_manifest": str(args.source_manifest),
            "source_revision_sha256": source_revision,
        }
        if source_conditioning:
            runtime_job["conditioning_dir"] = str(conditioning_dir)
        existing_runtime_manifest = (
            json.loads(runtime_manifest_path.read_text())
            if runtime_manifest_path.exists()
            else []
        )
        existing_runtime_manifest = [
            entry for entry in existing_runtime_manifest
            if entry.get("job_id") != args.job_id
        ]
        existing_runtime_manifest.append(runtime_job)
        existing_runtime_manifest.sort(
            key=lambda entry: (int(entry.get("index", 0)), entry["job_id"])
        )

        runtime_link_config = json.loads(json.dumps(base_link_config))
        runtime_link_config["training"]["queue_root"] = str(args.runtime_root)
        runtime_link_config["training"]["output_root"] = str(args.runtime_root / "outputs")
        runtime_link_config["training"]["log_root"] = str(args.runtime_root / "logs")
        runtime_link_config["training"]["return_root"] = str(
            args.runtime_root / "return-packets"
        )
        automation = runtime_link_config["lora_automation"]
        automation["queue_root"] = str(args.runtime_root)
        automation["output_root"] = str(args.runtime_root / "outputs")
        automation["preservation_root"] = str(args.runtime_root / "outputs")
        automation["manifest_root"] = str(args.runtime_root / "automation-manifests")
        automation["registry_path"] = str(args.runtime_root / "lora-registry.json")
        automation["revision_root"] = str(args.runtime_root / "revisions")
        automation["packet_ledger_path"] = str(args.runtime_root / "return-packet-log.json")
        automation["validation_queue_root"] = str(args.runtime_root / "validation")
        automation["queue_policy_path"] = str(args.runtime_root / "lora-queue-policy.json")
        base_automation = base_link_config.get("lora_automation", {})
        scheduler_root = Path(
            base_automation.get(
                "scheduler_root",
                args.base_link_config.parent / "lora-scheduler",
            )
        ).expanduser()
        automation["scheduler_root"] = str(scheduler_root)
        automation["scheduler_jobs_path"] = str(
            Path(base_automation.get("scheduler_jobs_path", scheduler_root / "lora-jobs.json")).expanduser()
        )
        automation["scheduler_state_path"] = str(
            Path(base_automation.get("scheduler_state_path", scheduler_root / "lora-scheduler-state.json")).expanduser()
        )
        automation["scheduler_policy_path"] = str(
            Path(base_automation.get("scheduler_policy_path", scheduler_root / "lora-queue-policy.json")).expanduser()
        )
        automation["scheduler_queue_control_path"] = str(
            Path(base_automation.get("scheduler_queue_control_path", scheduler_root / "queue-control.json")).expanduser()
        )
        automation["scheduler_job_control_root"] = str(
            Path(base_automation.get("scheduler_job_control_root", scheduler_root / "jobs")).expanduser()
        )
        runtime_config_path = args.runtime_root / "hawkspan-runtime-config.json"

        # Paths written above still reference the temporary directory. Rename
        # first, then replace that exact prefix in the small JSON control files.
        temporary_root.rename(final_root)
        old_prefix = str(temporary_root)
        new_prefix = str(final_root)
        stage_manifest_path = final_root / "STAGE-MANIFEST.json"
        for json_path in [
            final_root / "config/config.json",
            final_root / "config/multidatabackend.json",
            final_root / "config/TRAINING_READINESS_POLICY.json",
        ]:
            json_path.write_text(json_path.read_text().replace(old_prefix, new_prefix))
        runtime_job = json.loads(
            json.dumps(runtime_job).replace(old_prefix, new_prefix)
        )
        for index, entry in enumerate(existing_runtime_manifest):
            if entry.get("job_id") == args.job_id:
                existing_runtime_manifest[index] = runtime_job
        atomic_json(runtime_manifest_path, existing_runtime_manifest)
        atomic_json(runtime_config_path, runtime_link_config)
        for runtime_directory in [
            output_dir,
            args.runtime_root / "logs",
            args.runtime_root / "automation-manifests",
            args.runtime_root / "revisions",
            args.runtime_root / "validation",
            args.runtime_root / "control",
            args.runtime_root / "return-packets",
            cache_root / "vae",
            cache_root / "text",
        ]:
            runtime_directory.mkdir(parents=True, exist_ok=True)

        node = runtime_link_config["training"].get("node_path") or shutil.which("node")
        if not node:
            raise SystemExit("node is required for staged runtime readiness")
        automation_script = runtime_link_config["training"].get(
            "automation_script",
            str(Path(__file__).with_name("lora-automation.mjs")),
        )
        readiness = subprocess.run(
            [
                node,
                automation_script,
                "training-readiness",
                json.dumps({"job_id": args.job_id}),
            ],
            env={
                **os.environ,
                "HAWKSPAN_CONFIG": str(runtime_config_path),
                "HAWKSPAN_STATE_DIR": str(args.base_link_config.parent),
            },
            capture_output=True,
            text=True,
        )
        if readiness.returncode:
            raise SystemExit(
                "runtime readiness could not be evaluated:\n" + readiness.stderr
            )
        readiness_result = json.loads(readiness.stdout)
        stage_manifest = {
            "schema_version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "job_id": args.job_id,
            "source_manifest": str(args.source_manifest),
            "source_revision_sha256": source_revision,
            "source_dataset_inventory": source_inventory,
            "source_conditioning_inventory": conditioning_inventory,
            "source_validation_library": source_validation_library,
            "source_validation_input_inventory": source_validation_inputs,
            "source_config_inventory": config_inventory,
            "source_recovery_checkpoint": source_recovery_evidence,
            "runtime_recovery_checkpoint": runtime_recovery_evidence,
            "caption_overlay_root": (
                str(args.caption_overlay_root) if args.caption_overlay_root else None
            ),
            "caption_overlay_count": overlay_count,
            "caption_overlay_inventory": overlay_inventory,
            "runtime_manifest": str(runtime_manifest_path),
            "runtime_config": str(runtime_config_path),
            "runtime_job": runtime_job,
            "runtime_readiness_path": readiness_result.get("readiness_path"),
            "revision_fingerprint": readiness_result.get("revision_fingerprint"),
            "recovery_checkpoint": readiness_result.get("recovery_checkpoint"),
            "ready": readiness_result.get("ready", False),
            "problems": readiness_result.get("problems", []),
            "training_authorized": False,
            "training_started": False,
        }
        atomic_json(stage_manifest_path, stage_manifest)
        if stage_manifest["ready"]:
            active_pointer = Path(
                base_link_config.get("lora_automation", {}).get(
                    "active_runtime_pointer",
                    args.base_link_config.parent / "active-lora-runtime.json",
                )
            ).expanduser()
            atomic_json(active_pointer, {
                "schema_version": 1,
                "activated_at": datetime.now(timezone.utc).isoformat(),
                "config_path": str(runtime_config_path),
                "runtime_root": str(args.runtime_root),
                "latest_staged_job": args.job_id,
                "revision_fingerprint": stage_manifest["revision_fingerprint"],
                "training_authorized": False,
                "training_started": False,
            })
        print(json.dumps({
            "staged": True,
            "already_present": False,
            "runtime_job_root": str(final_root),
            "runtime_manifest": str(runtime_manifest_path),
            "runtime_config": str(runtime_config_path),
            "ready": stage_manifest["ready"],
            "problems": stage_manifest["problems"],
            "revision_fingerprint": stage_manifest["revision_fingerprint"],
            "recovery_checkpoint": stage_manifest["recovery_checkpoint"],
            "training_started": False,
        }, indent=2))
    except BaseException:
        if temporary_root.exists():
            shutil.rmtree(temporary_root)
        raise


if __name__ == "__main__":
    main()
