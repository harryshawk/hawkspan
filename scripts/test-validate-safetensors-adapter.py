#!/usr/bin/env python3
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

VALIDATOR = Path(__file__).with_name("validate_safetensors_adapter.py.managed")


def save_file(tensors: dict[str, tuple[int, ...]], path: Path) -> None:
    header = {}
    offset = 0
    for name, shape in tensors.items():
        byte_count = 4
        for dimension in shape:
            byte_count *= dimension
        header[name] = {
            "dtype": "F32",
            "shape": list(shape),
            "data_offsets": [offset, offset + byte_count],
        }
        offset += byte_count
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 8)
    path.write_bytes(struct.pack("<Q", len(encoded)) + encoded + bytes(offset))


def run_validator(path: Path) -> tuple[subprocess.CompletedProcess, dict]:
    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    return result, json.loads(result.stdout)


with tempfile.TemporaryDirectory(prefix="hawkspan-adapter-validator-") as temporary:
    root = Path(temporary)

    loha = root / "controlnet-loha.safetensors"
    tensors = {}
    markers = ("hada_w1_a", "hada_w1_b", "hada_w2_a", "hada_w2_b")
    for index in range(1658):
        marker = markers[index % len(markers)]
        tensors[f"lora_unet_controlnet_block_{index}.{marker}"] = (256,)
    save_file(tensors, loha)
    result, details = run_validator(loha)
    assert result.returncode == 0, result.stdout + result.stderr
    assert details["valid"] is True
    assert details["adapter_type"] == "loha"
    assert details["tensor_count"] == 1658

    ordinary_lora = root / "ordinary-lora.safetensors"
    save_file(
        {
            "unet.block.lora_A.weight": (16, 16),
            "unet.block.lora_B.weight": (16, 16),
        },
        ordinary_lora,
    )
    result, details = run_validator(ordinary_lora)
    assert result.returncode == 0
    assert details["adapter_type"] == "lora"

    unrelated = root / "unrelated.safetensors"
    save_file({"model.weight": (16, 16)}, unrelated)
    result, details = run_validator(unrelated)
    assert result.returncode != 0
    assert details["valid"] is False

    malformed = root / "malformed.safetensors"
    malformed.write_text("not safetensors")
    result, details = run_validator(malformed)
    assert result.returncode != 0
    assert details["valid"] is False

print("safetensors adapter validator tests passed")
