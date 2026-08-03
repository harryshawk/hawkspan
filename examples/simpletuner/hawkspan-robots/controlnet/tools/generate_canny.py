#!/usr/bin/env python3
"""Regenerate the public demo's deterministic three-channel Canny controls."""

from pathlib import Path

import cv2


LOW_THRESHOLD = 100
HIGH_THRESHOLD = 200
PNG_COMPRESSION = 9


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    sources = sorted((root / "dataset" / "targets").glob("hawkspan-robot-*.jpg"))
    output = root / "dataset" / "conditioning"
    if len(sources) != 20:
        raise SystemExit(f"expected 20 target JPGs; found {len(sources)}")
    for source in sources:
        image = cv2.imread(str(source), cv2.IMREAD_COLOR)
        if image is None:
            raise SystemExit(f"could not decode {source.name}")
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, LOW_THRESHOLD, HIGH_THRESHOLD)
        control = cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR)
        target = output / f"{source.stem}.png"
        if not cv2.imwrite(str(target), control, [cv2.IMWRITE_PNG_COMPRESSION, PNG_COMPRESSION]):
            raise SystemExit(f"could not write {target.name}")


if __name__ == "__main__":
    main()
