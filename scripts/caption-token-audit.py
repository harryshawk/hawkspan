#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

from transformers import CLIPTokenizer


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--tokenizer-root", required=True)
    parser.add_argument("--maximum-tokens", type=int, default=77)
    return parser.parse_args()


def main():
    args = parse_args()
    dataset = Path(args.dataset).resolve()
    tokenizer_root = Path(args.tokenizer_root).resolve()
    tokenizers = [
        CLIPTokenizer.from_pretrained(
            tokenizer_root / name,
            local_files_only=True,
        )
        for name in ("tokenizer", "tokenizer_2")
    ]
    records = []
    for caption_path in sorted(dataset.rglob("*.txt")):
        if caption_path.name.startswith("._"):
            continue
        variants = [
            line.strip()
            for line in caption_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        for index, caption in enumerate(variants, 1):
            counts = [
                len(tokenizer(caption, add_special_tokens=True, truncation=False)["input_ids"])
                for tokenizer in tokenizers
            ]
            records.append(
                {
                    "caption": str(caption_path.relative_to(dataset)),
                    "variant": index,
                    "token_counts": counts,
                    "maximum_count": max(counts),
                    "over_limit": max(counts) > args.maximum_tokens,
                }
            )
    over_limit = [record for record in records if record["over_limit"]]
    result = {
        "dataset": str(dataset),
        "tokenizer_root": str(tokenizer_root),
        "maximum_tokens": args.maximum_tokens,
        "variant_count": len(records),
        "maximum_observed_tokens": max(
            (record["maximum_count"] for record in records),
            default=0,
        ),
        "over_limit_count": len(over_limit),
        "over_limit": over_limit,
        "valid": bool(records) and not over_limit,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
