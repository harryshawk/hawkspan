#!/usr/bin/env python3

import importlib.machinery
import importlib.util
import hashlib
import json
import tempfile
from pathlib import Path


script = Path(__file__).with_name("build_return_packets.py.managed")
loader = importlib.machinery.SourceFileLoader("return_packets", str(script))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    dataset = root / "dataset"
    targets = dataset / "targets"
    conditioning = dataset / "conditioning"
    packet_dataset = root / "packet" / "DATASET"
    targets.mkdir(parents=True)
    conditioning.mkdir(parents=True)
    (targets / "robot.png").write_bytes(b"target-image")
    (conditioning / "robot.png").write_bytes(b"control-image")
    library = root / "validation-prompt-library.json"
    library.write_text(
        json.dumps(
            {
                "controls_are_relative_to": "dataset",
                "prompts": [
                    {
                        "id": "robot",
                        "prompt": "test robot",
                        "control_image": "conditioning/robot.png",
                        "source_target": "targets/robot.png",
                    }
                ],
            }
        )
    )

    copied = module.copy_validation_inputs(library, targets, packet_dataset)
    assert len(copied) == 2
    assert (packet_dataset / "conditioning" / "robot.png").read_bytes() == b"control-image"
    assert (packet_dataset / "targets" / "robot.png").read_bytes() == b"target-image"

    output = root / "output"
    samples = root / "packet" / "VALIDATION_SAMPLES"
    output.mkdir()
    (output / "render.png").write_bytes(b"render")
    fixed_settings = {
        "seeds": [20260801],
        "base_model": "test-model",
        "width": 1024,
        "height": 1024,
        "steps": 25,
        "sampler": "DPM++ 2M Karras",
        "guidance_scale": 5.0,
        "lora_weight": 0.7,
        "controlnet": {
            "model": "synthetic-controlnet",
            "weight": 1.0,
            "start": 0.0,
            "end": 1.0,
            "mode": "balanced",
        },
    }
    library.write_text(
        json.dumps(
            {
                "controls_are_relative_to": "dataset",
                "seed_policy": "Use seed 20260801 for every mapped prompt.",
                "fixed_settings": fixed_settings,
                "prompts": [
                    {
                        "id": "robot",
                        "prompt": "test robot",
                        "control_image": "conditioning/robot.png",
                        "source_target": "targets/robot.png",
                    }
                ],
            }
        )
    )
    lora = output / "pytorch_lora_weights.safetensors"
    lora.write_bytes(b"synthetic-lora")
    lora_sha256 = module.sha256(lora)
    validation_plan = root / "validation-plan.json"
    validation_plan.write_text(
        json.dumps(
            {
                "job_id": "output",
                "lora_path": str(lora),
                "lora_sha256": lora_sha256,
                "fixed_settings": fixed_settings,
                "prompts": [
                    {
                        "id": "robot",
                        "prompt": "test robot",
                        "control_image_path": str(conditioning / "robot.png"),
                        "control_image_sha256": module.sha256(
                            conditioning / "robot.png"
                        ),
                    }
                ],
            }
        )
    )
    draw_plan = root / "draw-things-plan.json"
    draw_plan.write_text(
        json.dumps(
            {
                "job_id": "output",
                "selected_checkpoint": "final",
                "lora_path": str(lora),
                "lora_sha256": lora_sha256,
                "validation_plan_path": str(validation_plan),
                "validation_plan_sha256": module.sha256(validation_plan),
                "import": {
                    "imported_name": "output final",
                    "expected_base_model": "test-model",
                },
            }
        )
    )
    validation_result = {
        "checkpoint": "final",
        "score": 8.5,
        "draw_things_plan_path": str(draw_plan),
        "draw_things_plan_sha256": module.sha256(draw_plan),
        "validation_plan_path": str(validation_plan),
        "validation_plan_sha256": module.sha256(validation_plan),
        "lora_path": str(lora),
        "lora_sha256": lora_sha256,
        "imported_name": "output final",
        "base_model": "test-model",
        "settings": fixed_settings,
        "renders": [
            {
                "prompt_id": "robot",
                "seed": 20260801,
                "image_path": "render.png",
                "live_metadata": {
                    "imported_name": "output final",
                    "lora_weight": 0.7,
                    "base_model": "test-model",
                    "settings": fixed_settings,
                    "control": {
                        "input_sha256": module.sha256(conditioning / "robot.png"),
                        "model": "synthetic-controlnet",
                        "weight": 1.0,
                        "start": 0.0,
                        "end": 1.0,
                        "mode": "balanced",
                    },
                },
                "image_sha256": module.sha256(output / "render.png"),
                "score": 8.5,
            }
        ],
    }
    validation_result["render_matrix_sha256"] = hashlib.sha256(
        json.dumps(
            [{
                "prompt_id": "robot",
                "seed": 20260801,
                "image_sha256": validation_result["renders"][0]["image_sha256"],
            }],
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    result_path = output / "validation-result.json"
    result_path.write_text(json.dumps(validation_result))
    rendered = module.controlled_validation_samples(
        output, samples, library, lora_sha256
    )
    assert len(rendered) == 1
    portable = json.loads((samples / "validation-result.json").read_text())
    assert portable["renders"][0]["image_path"] == (
        "VALIDATION_SAMPLES/robot--seed-20260801.png"
    )

    complete_library = json.loads(library.read_text())
    module.validate_controlled_fixed_settings(
        complete_library, "Validation prompt library"
    )
    complete_plan = json.loads(validation_plan.read_text())
    module.validate_controlled_fixed_settings(complete_plan, "Validation plan")

    invalid_settings = [
        ("seeds", [], "seeds"),
        ("seeds", [True], "seeds"),
        ("base_model", " ", "base_model"),
        ("width", 0, "width"),
        ("height", True, "height"),
        ("steps", 0, "steps"),
        ("sampler", "", "sampler"),
        ("guidance_scale", float("inf"), "guidance_scale"),
        ("lora_weight", float("nan"), "lora_weight"),
    ]
    for key, value, expected_error in invalid_settings:
        invalid = json.loads(json.dumps(complete_library))
        invalid["fixed_settings"][key] = value
        try:
            module.validate_controlled_fixed_settings(
                invalid, "Validation prompt library"
            )
        except RuntimeError as error:
            assert expected_error in str(error)
        else:
            raise AssertionError(f"invalid fixed setting {key} was accepted")

    invalid_control_settings = [
        ("model", "", "controlnet.model"),
        ("weight", float("inf"), "controlnet.weight"),
        ("start", True, "controlnet.start"),
        ("end", float("nan"), "controlnet.end"),
        ("mode", " ", "controlnet.mode"),
    ]
    for key, value, expected_error in invalid_control_settings:
        invalid = json.loads(json.dumps(complete_plan))
        invalid["fixed_settings"]["controlnet"][key] = value
        try:
            module.validate_controlled_fixed_settings(invalid, "Validation plan")
        except RuntimeError as error:
            assert expected_error in str(error)
        else:
            raise AssertionError(f"invalid fixed ControlNet setting {key} was accepted")

    missing_controlnet = json.loads(json.dumps(complete_library))
    del missing_controlnet["fixed_settings"]["controlnet"]
    try:
        module.validate_controlled_fixed_settings(
            missing_controlnet, "Validation prompt library"
        )
    except RuntimeError as error:
        assert "fixed_settings.controlnet" in str(error)
    else:
        raise AssertionError("missing fixed ControlNet settings were accepted")

    wrong_control = json.loads(result_path.read_text())
    wrong_control["renders"][0]["live_metadata"]["control"]["input_sha256"] = (
        "f" * 64
    )
    result_path.write_text(json.dumps(wrong_control))
    try:
        module.controlled_validation_samples(output, samples, library, lora_sha256)
    except RuntimeError as error:
        assert "wrong control input" in str(error)
    else:
        raise AssertionError("wrong ControlNet input was accepted")
    wrong_live_settings = json.loads(json.dumps(validation_result))
    wrong_live_settings["renders"][0]["live_metadata"]["settings"] = {
        "seeds": [9999]
    }
    result_path.write_text(json.dumps(wrong_live_settings))
    try:
        module.controlled_validation_samples(output, samples, library, lora_sha256)
    except RuntimeError as error:
        assert "live settings differ" in str(error)
    else:
        raise AssertionError("mismatched live settings were accepted")
    result_path.write_text(json.dumps(validation_result))
    evidence_before = module.validation_evidence_sha256(output, lora_sha256)
    (output / "render.png").write_bytes(b"changed render")
    try:
        module.controlled_validation_samples(output, samples, library, lora_sha256)
    except RuntimeError as error:
        assert "image SHA-256 mismatch" in str(error)
    else:
        raise AssertionError("mutated render image was accepted")
    evidence_after = module.validation_evidence_sha256(output, lora_sha256)
    assert evidence_before != evidence_after
    try:
        module.validation_evidence_sha256(output, "b" * 64)
    except RuntimeError as error:
        assert "does not match" in str(error)
    else:
        raise AssertionError("mismatched validation LoRA hash was accepted")

print("return packet validation-input test passed")
