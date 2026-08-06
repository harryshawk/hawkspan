#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path


IGNORED_NAMES = {".git", "__pycache__"}


def inventory(root: Path, excluded: set[str]) -> dict[str, str]:
    result = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or any(part in IGNORED_NAMES for part in path.parts):
            continue
        relative = path.relative_to(root).as_posix()
        if relative in excluded or path.suffix == ".pyc":
            continue
        result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def manifest_hash(files: dict[str, str]) -> str:
    content = "".join(f"{digest}  {name}\n" for name, digest in sorted(files.items()))
    return hashlib.sha256(content.encode()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the Mac Link to HawkSpan D fork inventory.")
    parser.add_argument("--mac-link-root", type=Path, required=True)
    parser.add_argument("--hawkspan-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()

    ledger_path = args.hawkspan_root / "config/hard-fork-parity.json"
    ledger = json.loads(ledger_path.read_text())
    excluded = set(ledger["baseline"]["excluded_private_files"])
    mac_files = inventory(args.mac_link_root.resolve(), excluded)
    hawkspan_files = inventory(args.hawkspan_root.resolve(), set())

    problems = []
    observed_manifest = manifest_hash(mac_files)
    expected_manifest = ledger["baseline"]["manifest_sha256"]
    if observed_manifest != expected_manifest:
        problems.append(
            f"Mac Link baseline hash changed: expected {expected_manifest}, got {observed_manifest}"
        )

    common = set(mac_files) & set(hawkspan_files)
    differing = {name for name in common if mac_files[name] != hawkspan_files[name]}
    approved = set(ledger["approved_differences"])
    if differing != approved:
        problems.append(f"unclassified common differences: {sorted(differing - approved)}")
        problems.append(f"approved differences no longer observed: {sorted(approved - differing)}")

    mac_only = set(mac_files) - set(hawkspan_files)
    expected_mac_only = set(ledger["expected_mac_link_only"])
    if mac_only != expected_mac_only:
        problems.append(f"unexpected Mac Link-only files: {sorted(mac_only - expected_mac_only)}")
        problems.append(f"missing Mac Link-only files: {sorted(expected_mac_only - mac_only)}")

    hawkspan_only = set(hawkspan_files) - set(mac_files)
    expected_hawkspan_only = set(ledger["expected_hawkspan_d_only"])
    if hawkspan_only != expected_hawkspan_only:
        problems.append(
            f"unexpected HawkSpan D-only files: {sorted(hawkspan_only - expected_hawkspan_only)}"
        )
        problems.append(
            f"missing HawkSpan D-only files: {sorted(expected_hawkspan_only - hawkspan_only)}"
        )

    if problems:
        print(json.dumps({"valid": False, "problems": problems}, indent=2))
        return 1
    print(json.dumps({
        "valid": True,
        "baseline": ledger["baseline"]["name"],
        "baseline_manifest_sha256": observed_manifest,
        "identical_common_files": len(common - differing),
        "classified_common_differences": len(differing),
        "mac_link_only": len(mac_only),
        "hawkspan_d_only": len(hawkspan_only),
        "unexplained_differences": 0,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
