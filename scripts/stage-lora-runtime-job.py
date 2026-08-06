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
import signal
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


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
    manifest = read_json_bounded(args.source_manifest)
    matches = [entry for entry in manifest if entry.get("job_id") == args.job_id]
    if len(matches) != 1:
        raise SystemExit(f"job must match exactly one source manifest entry: {args.job_id}")
    source_job = matches[0]
    source_data = Path(source_job["data_dir"])
    source_config = Path(source_job["config_dir"])
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
    source_inventory = inventory(source_data)
    config_inventory = inventory(source_config)
    conditioning_inventory = (
        inventory(source_conditioning) if source_conditioning else []
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
                "config": config_inventory,
                "caption_overlay": source_overlay_inventory,
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
        clone_tree(source_data, data_dir)
        clone_tree(source_config, config_dir)
        if source_conditioning:
            clone_tree(source_conditioning, conditioning_dir)
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
        if policy.get("recovery_checkpoint"):
            config["resume_from_checkpoint"] = policy["recovery_checkpoint"]
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

        base_link_config = json.loads(args.base_link_config.read_text())
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
            "source_config_inventory": config_inventory,
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
