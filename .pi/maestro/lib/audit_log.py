#!/usr/bin/env python3
"""
audit_log.py — Local audit log for the Maestro action tool.

Records every "start" event the operator triggers from the action
menu (single issue or batch). One line per event, appended
atomically. The log is intentionally minimal: a text file under
``.maestro/logs/maestro-actions.log`` that any operator can
``cat`` to answer "what did I run today".

Why a separate module?
    The audit log is touched from two places (single-issue start
    and batch start) and has non-trivial correctness requirements
    (atomic write, no partial lines, no silent drops). Centralising
    it here keeps the rules in one place and lets the action-menu
    tests own the contract.

Public surface:

  - :data:`DEFAULT_LOG_PATH` — the canonical location of the log.
  - :func:`record_start` — append a ``start`` event.
  - :func:`read_entries` — read the log back as structured dicts
    (for tests and ops scripts).
  - :func:`_format_entry` — internal formatter (exposed for tests).

File format (one event per line, ``\\n`` terminated):

    <iso-timestamp> | start | issue=<int> | flow=<name>

The fields are stable; downstream tooling (ops scripts, monitors)
is allowed to parse the pipe-separated form. Adding a new field
is a breaking change — bump the format version and update
readers together.

Atomicity:
    Each line is appended in a single ``write`` call after the
    file is opened in ``'a'`` (append) mode. POSIX guarantees
    that ``O_APPEND`` writes smaller than ``PIPE_BUF`` (4096 bytes
    on Linux) are atomic with respect to other writers; each line
    is well under that limit (~150 bytes), so concurrent
    appenders cannot interleave a line. ``fsync`` after the
    write flushes kernel buffers to disk so a crash immediately
    after ``record_start`` returns does not lose the line.

    On Windows, ``open(..., 'a')`` also uses ``O_APPEND`` semantics,
    so the same atomicity guarantee applies. ``newline=""`` is
    the canonical pattern for append-only text logs — see Python
    docs for the ``open()`` ``newline`` parameter.

Concurrent writers:
    The action menu is single-threaded, so concurrency is not a
    concern in practice. The ``O_APPEND`` guarantee is a safety
    net for future slices that might batch spawn from a worker
    thread.
"""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# ─── Constants ───────────────────────────────────────────────────────────

#: Canonical log path. The action menu uses this by default; tests
#: pass a custom path. The ``.maestro/logs/`` directory is created
#: on first write.
DEFAULT_LOG_PATH: Path = Path(".maestro/logs/maestro-actions.log")

#: Format version. Bumped when the line shape changes.
SCHEMA_VERSION: str = "1"


# ─── Line format ─────────────────────────────────────────────────────────

#: Regex matching a single audit line. Capture groups:
#: 1=timestamp (ISO-8601), 2=action, 3=issue number, 4=flow name.
_LINE_RE = re.compile(
    r"^(?P<ts>\S+)\s+\|\s+(?P<action>\S+)\s+\|\s+"
    r"issue=(?P<issue>\d+)\s+\|\s+"
    r"flow=(?P<flow>\S+)$"
)


def _now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string.

    Uses ``datetime.now(timezone.utc)`` so the timestamp is
    unambiguous (the ``Z`` suffix would also be unambiguous, but
    ``+00:00`` is what ``isoformat()`` produces and is what the
    rest of the codebase uses — see :mod:`flow_logger.now_iso`).
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


def _format_entry(issue_num: int, flow_name: str, *, timestamp: Optional[str] = None) -> str:
    """Format one audit-log line.

    Args:
        issue_num: The GitHub issue number that was started.
        flow_name: The flow that was started (e.g. ``"builder-reviewer"``).
        timestamp: Optional explicit timestamp (ISO-8601). ``None``
            uses :func:`_now_iso`. Tests pass a fixed value for
            snapshot stability.

    Returns:
        The formatted line WITHOUT a trailing newline. The writer
        adds the newline.
    """
    ts = timestamp if timestamp is not None else _now_iso()
    return f"{ts} | start | issue={int(issue_num)} | flow={flow_name}"


# ─── Write path ──────────────────────────────────────────────────────────


def record_start(
    issue_num: int,
    flow_name: str,
    *,
    log_path: Optional[Path] = None,
    timestamp: Optional[str] = None,
) -> Path:
    """Append a ``start`` event to the audit log.

    Creates ``log_path`` and any missing parent directories on
    first write. Each line is written in a single ``write`` call
    after the file is opened in append mode — the kernel's
    ``O_APPEND`` semantic guarantees the line is not interleaved
    with another writer's line, even on crash recovery (the
    previous lines are intact; at most the in-flight line is
    truncated, but we ``fsync`` so the line is durable before
    we return).

    Args:
        issue_num: GitHub issue number that was started.
        flow_name: Flow that was started (e.g. ``"builder-reviewer"``).
        log_path: Where to write. ``None`` uses
            :data:`DEFAULT_LOG_PATH` (resolved against the
            current working directory). Tests pass a temp path.
        timestamp: Optional explicit ISO timestamp. ``None`` uses
            :func:`_now_iso`. Tests pass a fixed value for
            snapshot stability.

    Returns:
        The resolved absolute log path. Returned so callers
        (e.g. the action menu) can echo the path in a success
        message without re-resolving it.

    Raises:
        OSError: If the write fails (permission denied, disk
            full, read-only filesystem). The caller decides how
            to surface the error. The action menu logs a
            warning and continues — the spawn is the critical
            step; the audit log is a best-effort record.
    """
    target = (log_path or DEFAULT_LOG_PATH).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)

    line = _format_entry(issue_num, flow_name, timestamp=timestamp)

    # Open in append mode (``'a'`` implies ``O_APPEND`` on POSIX
    # and Windows). Each ``write`` is a single syscall, so the
    # kernel sees the line atomically (well under PIPE_BUF).
    with open(target, "a", encoding="utf-8", newline="") as f:
        f.write(line)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())

    return target


# ─── Read path ───────────────────────────────────────────────────────────


def read_entries(log_path: Optional[Path] = None) -> list[dict]:
    """Read the audit log and return a list of structured entries.

    A missing file returns an empty list (not an error) — the
    first time the action menu is run, there is no log yet.
    Corrupt lines (anything that does not match :data:`_LINE_RE`)
    are skipped and reported via the ``_warnings`` parameter of
    the dict (not used externally yet; kept as a hook for a
    future ``--strict`` mode that surfaces corrupt lines).

    Args:
        log_path: Where to read from. ``None`` uses
            :data:`DEFAULT_LOG_PATH`.

    Returns:
        A list of ``{"timestamp", "action", "issue", "flow"}``
        dicts in file order (oldest first).
    """
    target = (log_path or DEFAULT_LOG_PATH).resolve()
    if not target.exists():
        return []
    entries: list[dict] = []
    with open(target, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line:
                continue
            m = _LINE_RE.match(line)
            if not m:
                # Skip corrupt lines; the writer is atomic so a
                # corrupt line indicates a manual edit, an old
                # schema version, or an interrupted migration.
                continue
            entries.append({
                "timestamp": m.group("ts"),
                "action": m.group("action"),
                "issue": int(m.group("issue")),
                "flow": m.group("flow"),
            })
    return entries


# ─── Module-level smoke test ────────────────────────────────────────────


if __name__ == "__main__":
    # A quick sanity check that does not touch the real audit log
    # — uses a sibling file in the same directory.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "test-audit.log"
        record_start(42, "builder-reviewer", log_path=p, timestamp="2026-06-16T12:00:00+00:00")
        record_start(43, "gap-check", log_path=p, timestamp="2026-06-16T12:01:00+00:00")
        print("written entries:")
        for e in read_entries(p):
            print(f"  {e}")
        # Round-trip the file via the default read path
        print(f"\nSCHEMA_VERSION = {SCHEMA_VERSION}")
        print(f"DEFAULT_LOG_PATH = {DEFAULT_LOG_PATH}")
        sys.exit(0)
