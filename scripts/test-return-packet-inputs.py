#!/usr/bin/env python3

import importlib.machinery
import importlib.util
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
    library.write_text(
        json.dumps(
            {
                "controls_are_relative_to": "dataset",
                "seed_policy": "Use seed 20260801 for every mapped prompt.",
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
    (output / "validation-result.json").write_text(
        json.dumps(
            {
                "checkpoint": "final",
                "score": 8.5,
                "renders": [
                    {
                        "prompt_id": "robot",
                        "seed": 20260801,
                        "image_path": "render.png",
                        "live_metadata": {"lora_weight": 0.7},
                        "score": 8.5,
                    }
                ],
            }
        )
    )
    rendered = module.controlled_validation_samples(output, samples, library)
    assert len(rendered) == 1
    portable = json.loads((samples / "validation-result.json").read_text())
    assert portable["renders"][0]["image_path"] == (
        "VALIDATION_SAMPLES/robot--seed-20260801.png"
    )

print("return packet validation-input test passed")
