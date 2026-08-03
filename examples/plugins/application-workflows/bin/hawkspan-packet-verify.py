#!/usr/bin/env python3
"""Verify every member of one HawkSpan return packet against its JSON inventory."""

import hashlib
import json
import re
import sys
import zipfile
from pathlib import PurePosixPath


SHA256 = re.compile(r"^[a-f0-9]{64}$")
SPECIAL = {"SHA256-INVENTORY.csv", "SHA256-INVENTORY.json", "PACKET-SUMMARY.json"}


def fail(message):
    raise SystemExit(message)


def read_member(archive, name, maximum):
    info = archive.getinfo(name)
    if info.file_size > maximum:
        fail(f"packet member exceeds limit: {name}")
    return archive.read(info)


def main():
    if len(sys.argv) != 2:
        fail("usage: hawkspan-packet-verify.py PACKET.zip")
    try:
        with zipfile.ZipFile(sys.argv[1]) as archive:
            infos = archive.infolist()
            all_names = [info.filename for info in infos]
            if len(all_names) != len(set(all_names)):
                fail("packet contains duplicate member names")
            for info in infos:
                pure = PurePosixPath(info.filename)
                if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
                    fail(f"packet member path is unsafe: {info.filename}")
            names = [info.filename for info in infos if not info.is_dir()]
            for required in SPECIAL:
                if required not in names:
                    fail(f"packet is missing {required}")
            inventory_bytes = read_member(archive, "SHA256-INVENTORY.json", 16 * 1024 * 1024)
            summary_bytes = read_member(archive, "PACKET-SUMMARY.json", 1024 * 1024)
            csv_bytes = read_member(archive, "SHA256-INVENTORY.csv", 16 * 1024 * 1024)
            inventory = json.loads(inventory_bytes)
            summary = json.loads(summary_bytes)
            if inventory.get("schema_version") != 1 or not isinstance(inventory.get("files"), list):
                fail("JSON inventory has an unsupported format")
            if summary.get("inventory_sha256") != hashlib.sha256(csv_bytes).hexdigest():
                fail("CSV inventory hash does not match packet summary")
            if summary.get("inventory_json_sha256") != hashlib.sha256(inventory_bytes).hexdigest():
                fail("JSON inventory hash does not match packet summary")
            expected_names = set(names) - SPECIAL
            inventoried_names = set()
            for row in inventory["files"]:
                if not isinstance(row, dict) or set(row) != {"packet_path", "size_bytes", "sha256"}:
                    fail("JSON inventory row has an unsupported format")
                name = row["packet_path"]
                if not isinstance(name, str) or name in inventoried_names or name not in expected_names:
                    fail("JSON inventory names do not match packet members")
                if not isinstance(row["size_bytes"], int) or row["size_bytes"] < 0 or not SHA256.fullmatch(row["sha256"]):
                    fail("JSON inventory row has invalid size or hash")
                info = archive.getinfo(name)
                if info.file_size != row["size_bytes"]:
                    fail(f"packet member size mismatch: {name}")
                digest = hashlib.sha256()
                with archive.open(info) as handle:
                    for block in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(block)
                if digest.hexdigest() != row["sha256"]:
                    fail(f"packet member hash mismatch: {name}")
                inventoried_names.add(name)
            if inventoried_names != expected_names:
                fail("JSON inventory does not cover every packet member")
            print(json.dumps({
                "archive_integrity": True,
                "inventory_sha256": summary["inventory_sha256"],
                "inventory_json_sha256": summary["inventory_json_sha256"],
                "member_count": len(expected_names),
                "summary": summary,
            }, sort_keys=True))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        fail(f"packet verification failed: {error}")


if __name__ == "__main__":
    main()
