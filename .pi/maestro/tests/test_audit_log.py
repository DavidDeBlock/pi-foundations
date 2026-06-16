#!/usr/bin/env python3
"""
Unit tests for ``lib/audit_log.py`` — the Maestro action-menu
audit log.

Covers the contract of :func:`record_start` and :func:`read_entries`
plus the format conventions pinned by the issue's ACs:

  - One line per event (``\\n`` terminated).
  - Pipe-separated fields: ``<iso-ts> | start | issue=<int> | flow=<name>``.
  - Atomic, append-only writes (no truncation of prior lines).
  - Missing log file → empty list (not an error).
  - Corrupt lines → silently skipped (forward-compat for schema
    changes and manual edits).
  - Custom log path is honoured (the function does not always
    write to ``.maestro/logs/maestro-actions.log``).
  - Missing parent directories are created on first write.

Run with: ``python3 tests/test_audit_log.py`` (custom runner)
       or ``python3 -m pytest tests/test_audit_log.py`` (pytest)
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Path setup: tests live at ``.pi/maestro/tests``. We need
# ``.pi/maestro/lib`` on ``sys.path`` so ``import audit_log``
# works without a package install.
MAESTRO_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(MAESTRO_DIR / "lib"))

from audit_log import (  # noqa: E402
    DEFAULT_LOG_PATH,
    SCHEMA_VERSION,
    _format_entry,
    read_entries,
    record_start,
)


# ─── Format tests ───────────────────────────────────────────────────────


def test_format_entry_includes_all_fields():
    """A formatted line has ``ts | start | issue=N | flow=NAME``."""
    line = _format_entry(42, "builder-reviewer", timestamp="2026-06-16T12:00:00+00:00")
    assert line == "2026-06-16T12:00:00+00:00 | start | issue=42 | flow=builder-reviewer"


def test_format_entry_uses_iso_timestamp():
    """No explicit timestamp → the function fills one in
    (current UTC, ISO-8601)."""
    line = _format_entry(1, "gap-check")
    # The timestamp segment is everything before the first " | ".
    ts = line.split(" | ", 1)[0]
    # ISO-8601 UTC: "YYYY-MM-DDTHH:MM:SS+00:00"
    assert ts.endswith("+00:00"), f"expected UTC offset in {ts!r}"
    # Year-month-day prefix is 10 chars.
    assert len(ts) >= 19, f"timestamp too short: {ts!r}"


def test_format_entry_does_not_include_trailing_newline():
    """The formatter returns the line without ``\\n``; the writer
    adds the newline. This matters because :func:`record_start`
    opens in append mode and writes the newline explicitly — if
    the formatter included a newline, the file would have a
    double newline between entries."""
    line = _format_entry(1, "x")
    assert not line.endswith("\n")


# ─── Write tests ────────────────────────────────────────────────────────


def test_record_start_writes_one_line():
    """A single :func:`record_start` call produces one parseable line."""
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "audit.log"
        record_start(42, "builder-reviewer", log_path=p, timestamp="2026-06-16T12:00:00+00:00")
        text = p.read_text(encoding="utf-8")
        lines = text.splitlines()
        assert len(lines) == 1
        assert "issue=42" in lines[0]
        assert "flow=builder-reviewer" in lines[0]


def test_record_start_appends_across_calls():
    """Multiple calls append — earlier lines are preserved.

    This is the contract the AC "The local audit log records
    each started flow" relies on: every spawn writes a line,
    and the line count equals the spawn count.
    """
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "audit.log"
        record_start(42, "builder-reviewer", log_path=p, timestamp="2026-06-16T12:00:00+00:00")
        record_start(43, "gap-check", log_path=p, timestamp="2026-06-16T12:01:00+00:00")
        record_start(44, "prd-audit", log_path=p, timestamp="2026-06-16T12:02:00+00:00")
        text = p.read_text(encoding="utf-8")
        lines = text.splitlines()
        assert len(lines) == 3, f"expected 3 lines, got {len(lines)}"
        assert "issue=42" in lines[0]
        assert "issue=43" in lines[1]
        assert "issue=44" in lines[2]


def test_record_start_creates_parent_directory():
    """A custom path under a non-existent directory is created on first write.

    The action menu calls :func:`record_start` from a clean cwd
    (a fresh clone, a fresh CI checkout), so the log directory
    must not be assumed to exist.
    """
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "deeply" / "nested" / "audit.log"
        record_start(1, "builder-reviewer", log_path=p, timestamp="2026-06-16T12:00:00+00:00")
        assert p.exists()


def test_record_start_returns_resolved_path():
    """The returned path is absolute (resolved). The action menu
    uses this to print a "logged to <path>" message without
    re-doing the resolution."""
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "audit.log"
        result = record_start(1, "x", log_path=p, timestamp="2026-06-16T12:00:00+00:00")
        assert result.is_absolute()


# ─── Read tests ─────────────────────────────────────────────────────────


def test_read_entries_missing_file_returns_empty_list():
    """A non-existent log file is not an error — the action menu
    must not crash on a fresh checkout. The first call returns
    an empty list; subsequent writes are still readable."""
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "no-such.log"
        entries = read_entries(p)
        assert entries == []


def test_read_entries_round_trip():
    """What :func:`record_start` writes, :func:`read_entries` reads back."""
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "audit.log"
        record_start(42, "builder-reviewer", log_path=p, timestamp="2026-06-16T12:00:00+00:00")
        record_start(43, "gap-check", log_path=p, timestamp="2026-06-16T12:01:00+00:00")
        entries = read_entries(p)
        assert len(entries) == 2
        assert entries[0] == {
            "timestamp": "2026-06-16T12:00:00+00:00",
            "action": "start",
            "issue": 42,
            "flow": "builder-reviewer",
        }
        assert entries[1] == {
            "timestamp": "2026-06-16T12:01:00+00:00",
            "action": "start",
            "issue": 43,
            "flow": "gap-check",
        }


def test_read_entries_skips_corrupt_lines():
    """A corrupt line (wrong format) is silently skipped.

    Forward-compat: a manual edit, an old schema version, or an
    interrupted migration should not break ``read_entries``.
    The function returns the parseable entries; the corrupt
    line is dropped.
    """
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "audit.log"
        p.write_text(
            "2026-06-16T12:00:00+00:00 | start | issue=42 | flow=builder-reviewer\n"
            "garbage that does not match\n"
            "2026-06-16T12:01:00+00:00 | start | issue=43 | flow=gap-check\n"
            "another bad line\n",
            encoding="utf-8",
        )
        entries = read_entries(p)
        assert len(entries) == 2
        assert entries[0]["issue"] == 42
        assert entries[1]["issue"] == 43


def test_read_entries_skips_empty_lines():
    """Blank lines (e.g. trailing newline) are ignored."""
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "audit.log"
        p.write_text(
            "2026-06-16T12:00:00+00:00 | start | issue=42 | flow=builder-reviewer\n"
            "\n"
            "2026-06-16T12:01:00+00:00 | start | issue=43 | flow=gap-check\n"
            "\n",
            encoding="utf-8",
        )
        entries = read_entries(p)
        assert len(entries) == 2


# ─── Concurrency / atomicity tests ──────────────────────────────────────


def test_no_temp_file_left_after_write():
    """A successful write does not leave a ``.tmp`` sibling.

    Earlier versions of the function used a ``.tmp`` file +
    ``os.replace`` pattern; the current implementation uses
    append mode with ``O_APPEND`` atomicity, so no temp file
    should exist after a write.

    This is a regression guard: if a future slice reintroduces
    the temp-file pattern, it must be conscious of the
    side effect (and add a cleanup step).
    """
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "audit.log"
        record_start(42, "builder-reviewer", log_path=p, timestamp="2026-06-16T12:00:00+00:00")
        siblings = [s.name for s in p.parent.iterdir()]
        assert siblings == ["audit.log"], f"unexpected siblings: {siblings}"


# ─── Default path tests ─────────────────────────────────────────────────


def test_default_log_path_is_in_maestro_logs_dir():
    """The default log path lives under ``.maestro/logs/``.

    The action menu's contract: if the operator does not pass
    a custom path, the log is at the canonical location. This
    test pins the location so a refactor does not silently
    move the log.
    """
    # DEFAULT_LOG_PATH may be a relative ``Path`` (it is resolved
    # against cwd at write time). We assert the relative shape
    # so the test is independent of cwd.
    parts = DEFAULT_LOG_PATH.parts
    assert ".maestro" in parts
    assert "logs" in parts
    assert DEFAULT_LOG_PATH.name == "maestro-actions.log"


def test_schema_version_is_pinned():
    """``SCHEMA_VERSION`` is the schema version of the log format.

    Operators and ops scripts can use this to branch on format
    changes. The test pins the current version so a bump is
    intentional (and a future migration script can switch on it).
    """
    assert SCHEMA_VERSION == "1"


# ─── Runner ─────────────────────────────────────────────────────────────


tests = [
    test_format_entry_includes_all_fields,
    test_format_entry_uses_iso_timestamp,
    test_format_entry_does_not_include_trailing_newline,
    test_record_start_writes_one_line,
    test_record_start_appends_across_calls,
    test_record_start_creates_parent_directory,
    test_record_start_returns_resolved_path,
    test_read_entries_missing_file_returns_empty_list,
    test_read_entries_round_trip,
    test_read_entries_skips_corrupt_lines,
    test_read_entries_skips_empty_lines,
    test_no_temp_file_left_after_write,
    test_default_log_path_is_in_maestro_logs_dir,
    test_schema_version_is_pinned,
]


if __name__ == "__main__":
    passed = 0
    failed = 0
    for test_fn in tests:
        try:
            test_fn()
            print(f"  ✓ {test_fn.__name__}")
            passed += 1
        except Exception as e:
            import traceback
            print(f"  ✗ {test_fn.__name__}: {e}")
            traceback.print_exc()
            failed += 1
    print(f"\n{passed}/{passed + failed} tests passed")
    if failed > 0:
        sys.exit(1)
