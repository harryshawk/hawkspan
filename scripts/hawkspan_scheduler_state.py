#!/usr/bin/env python3
"""SQLite-serialized read-modify-write access to scheduler JSON state."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import tempfile


def _wait_seconds() -> float:
    return max(
        1.0,
        int(os.environ.get("HAWKSPAN_SIMPLETUNER_STATE_LOCK_WAIT_MS", "30000")) / 1000,
    )


@contextmanager
def edit_scheduler_state(path: Path, fallback: dict):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    database = sqlite3.connect(
        f"{path}.lock.sqlite3",
        timeout=_wait_seconds(),
        isolation_level=None,
    )
    database.execute(
        "CREATE TABLE IF NOT EXISTS lock_identity (id INTEGER PRIMARY KEY CHECK (id = 1))"
    )
    database.execute("BEGIN IMMEDIATE")
    try:
        try:
            state = json.loads(path.read_text())
        except FileNotFoundError:
            state = json.loads(json.dumps(fallback))
        yield state
        with tempfile.NamedTemporaryFile(
            "w", dir=path.parent, delete=False, prefix=f".{path.name}.", suffix=".tmp"
        ) as handle:
            json.dump(state, handle, indent=2)
            handle.write("\n")
            temporary = Path(handle.name)
        temporary.replace(path)
        database.execute("COMMIT")
    except BaseException:
        database.execute("ROLLBACK")
        raise
    finally:
        database.close()


def read_scheduler_state(path: Path, fallback: dict) -> dict:
    with edit_scheduler_state(path, fallback) as state:
        return json.loads(json.dumps(state))
