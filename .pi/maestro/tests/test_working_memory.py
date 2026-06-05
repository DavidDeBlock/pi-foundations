#!/usr/bin/env python3
"""
Unit tests for working_memory.py — Per-issue structured working memory.

Covers:
- Empty memory creation when file missing
- Round-trip load/save preserves all fields
- Corrupt file detection and backup
- Atomic write via .tmp + rename
- update_phase merges with existing data
- update_phase for unknown phase routes to notes
- append_file_touched deduplicates
- append_test_result stamps timestamp
- append_error records phase, message, and timestamp
- from_dict tolerates unknown fields
- from_dict tolerates missing optional fields
- WorkingMemory survives save/load cycle

Run with: python3 tests/test_working_memory.py
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from working_memory import (
    WorkingMemory,
    MemoryStore,
    format_memory_markdown,
    now_iso,
    MEMORY_DIR,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir() -> Path:
    """Create and return a fresh temp directory."""
    return Path(tempfile.mkdtemp(prefix="maestro_memory_test_"))


# ─── Tests ──────────────────────────────────────────────────────────────


def test_load_creates_empty_memory_if_file_missing():
    """load() on a missing file should return a fresh WorkingMemory with created_at set."""
    d = _make_dir()
    try:
        store = MemoryStore(42, memory_dir=d)
        mem = store.load()
        assert mem.issue == 42
        assert mem.created_at != ""
        assert mem.updated_at == ""
        assert mem.files_touched == []
        assert mem.errors == []
        assert mem.test_results == []
        assert mem.builder == {}
        assert mem.git_sha == ""
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


def test_load_returns_existing_memory():
    """load() should round-trip a previously-saved memory verbatim."""
    d = _make_dir()
    try:
        store = MemoryStore(7, memory_dir=d)
        mem = WorkingMemory(
            issue=7,
            created_at="2026-01-01T00:00:00+00:00",
            git_sha="abc123",
            builder={"summary": "built it", "files": ["a.py"]},
            files_touched=["a.py", "b.py"],
        )
        store.save(mem)

        loaded = store.load()
        assert loaded.issue == 7
        assert loaded.created_at == "2026-01-01T00:00:00+00:00"
        assert loaded.git_sha == "abc123"
        assert loaded.builder == {"summary": "built it", "files": ["a.py"]}
        assert loaded.files_touched == ["a.py", "b.py"]
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


def test_load_handles_corrupt_file_with_backup():
    """load() on a corrupt file should back it up and return empty memory."""
    d = _make_dir()
    try:
        # Write a garbage file
        target = d / "5.memory.json"
        target.write_text("{ this is not valid json")

        store = MemoryStore(5, memory_dir=d)
        mem = store.load()

        # Should return a fresh empty memory
        assert mem.issue == 5
        assert mem.created_at != ""

        # Should have created a backup
        backups = list(d.glob("5.corrupt.*.json"))
        assert len(backups) == 1, f"Expected 1 backup, found {backups}"
        assert not target.exists(), "Original corrupt file should be renamed away"
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


def test_save_is_atomic_uses_tmp_rename():
    """save() should write to .tmp and rename — no leftover .tmp file."""
    d = _make_dir()
    try:
        store = MemoryStore(11, memory_dir=d)
        mem = WorkingMemory(issue=11, created_at=now_iso(), builder={"x": 1})
        store.save(mem)

        # Final file exists with valid content
        target = d / "11.memory.json"
        assert target.exists()
        data = json.loads(target.read_text())
        assert data["issue"] == 11
        assert data["builder"] == {"x": 1}

        # No leftover .tmp file
        leftovers = list(d.glob("*.tmp"))
        assert leftovers == [], f"Leftover .tmp files: {leftovers}"
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


def test_update_phase_merges_with_existing_data():
    """update_phase should merge new keys into the existing phase dict, not replace."""
    d = _make_dir()
    try:
        store = MemoryStore(3, memory_dir=d)
        store.update_phase("builder", {"summary": "first pass", "files": ["a.py"]})
        store.update_phase("builder", {"summary": "second pass", "tests_passed": True})

        mem = store.load()
        # 'summary' was overwritten; 'files' preserved; 'tests_passed' added
        assert mem.builder["summary"] == "second pass"
        assert mem.builder["files"] == ["a.py"]
        assert mem.builder["tests_passed"] is True
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


def test_update_phase_for_unknown_phase_goes_to_notes():
    """update_phase with an unknown phase name should route the data to notes."""
    d = _make_dir()
    try:
        store = MemoryStore(4, memory_dir=d)
        store.update_phase("made_up_phase", {"x": 1, "y": 2})

        mem = store.load()
        assert mem.notes, "notes should not be empty"
        assert mem.notes[0]["type"] == "unknown_phase"
        assert mem.notes[0]["phase"] == "made_up_phase"
        assert mem.notes[0]["data"] == {"x": 1, "y": 2}
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


def test_append_file_touched_deduplicates():
    """append_file_touched should not add the same path twice."""
    d = _make_dir()
    try:
        store = MemoryStore(6, memory_dir=d)
        store.append_file_touched("a.py")
        store.append_file_touched("b.py")
        store.append_file_touched("a.py")  # duplicate
        store.append_file_touched("a.py")  # duplicate

        mem = store.load()
        assert mem.files_touched == ["a.py", "b.py"]
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


def test_append_test_result_includes_timestamp():
    """append_test_result should add a timestamp key to each entry."""
    d = _make_dir()
    try:
        store = MemoryStore(8, memory_dir=d)
        before = now_iso()
        store.append_test_result({"name": "test_foo", "status": "passed"})
        after = now_iso()

        mem = store.load()
        assert len(mem.test_results) == 1
        assert mem.test_results[0]["name"] == "test_foo"
        assert mem.test_results[0]["status"] == "passed"
        # timestamp should be a parseable ISO string within the test window
        ts = mem.test_results[0]["timestamp"]
        assert ts != ""
        # The timestamp should be between before and after (we may lose
        # sub-millisecond precision, so use a small fudge factor)
        assert before <= ts or ts >= before
        assert ts <= after or ts <= after
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


def test_append_error_records_phase_and_message():
    """append_error should record phase name, error message, and timestamp."""
    d = _make_dir()
    try:
        store = MemoryStore(9, memory_dir=d)
        store.append_error("reviewer", "Test failed on line 47")
        store.append_error("test_runner", "Process exited with code 1")

        mem = store.load()
        assert len(mem.errors) == 2
        assert mem.errors[0]["phase"] == "reviewer"
        assert mem.errors[0]["error"] == "Test failed on line 47"
        assert mem.errors[0]["timestamp"] != ""
        assert mem.errors[1]["phase"] == "test_runner"
        assert mem.errors[1]["error"] == "Process exited with code 1"
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


def test_from_dict_tolerates_unknown_fields():
    """from_dict should drop unknown fields without raising."""
    # No issue_num required in the dict? Actually 'issue' IS required.
    # But unknown extras (e.g. 'experimental_feature') should be silently dropped.
    d = {"issue": 12, "created_at": "X", "experimental_feature": "future_use"}
    mem = WorkingMemory.from_dict(d)
    assert mem.issue == 12
    assert mem.created_at == "X"
    # The unknown field is dropped (not stored on the dataclass)
    assert not hasattr(mem, "experimental_feature")


def test_from_dict_tolerates_missing_optional_fields():
    """from_dict should fill in defaults for any missing optional field."""
    d = {"issue": 13}
    mem = WorkingMemory.from_dict(d)
    assert mem.issue == 13
    assert mem.created_at == ""
    assert mem.updated_at == ""
    assert mem.git_sha == ""
    assert mem.builder == {}
    assert mem.files_touched == []
    assert mem.errors == []


def test_working_memory_survives_across_save_load_cycle():
    """A complex memory with all fields populated should round-trip cleanly."""
    d = _make_dir()
    try:
        store = MemoryStore(20, memory_dir=d)

        # Build up state across multiple operations
        store.update_phase("scout", {"findings": ["file a.py is hot", "tests live in tests/"]})
        store.update_phase("builder", {"summary": "implemented", "commit": "abc123"})
        store.append_file_touched("src/foo.py")
        store.append_file_touched("src/bar.py")
        store.append_test_result({"name": "test_x", "status": "passed"})
        store.append_error("reviewer", "missing type hints")

        # Now simulate a "restart" — new MemoryStore, same path
        store2 = MemoryStore(20, memory_dir=d)
        mem = store2.load()

        # Every field should survive
        assert mem.issue == 20
        assert mem.scout["findings"] == ["file a.py is hot", "tests live in tests/"]
        assert mem.builder["summary"] == "implemented"
        assert mem.builder["commit"] == "abc123"
        assert mem.files_touched == ["src/foo.py", "src/bar.py"]
        assert len(mem.test_results) == 1
        assert mem.test_results[0]["name"] == "test_x"
        assert mem.test_results[0]["timestamp"] != ""
        assert len(mem.errors) == 1
        assert mem.errors[0]["phase"] == "reviewer"
    finally:
        for p in d.iterdir():
            p.unlink()
        d.rmdir()


# ─── Test runner ─────────────────────────────────────────────────────────


if __name__ == "__main__":
    print("Running working_memory unit tests...\n")

    tests = [
        test_load_creates_empty_memory_if_file_missing,
        test_load_returns_existing_memory,
        test_load_handles_corrupt_file_with_backup,
        test_save_is_atomic_uses_tmp_rename,
        test_update_phase_merges_with_existing_data,
        test_update_phase_for_unknown_phase_goes_to_notes,
        test_append_file_touched_deduplicates,
        test_append_test_result_includes_timestamp,
        test_append_error_records_phase_and_message,
        test_from_dict_tolerates_unknown_fields,
        test_from_dict_tolerates_missing_optional_fields,
        test_working_memory_survives_across_save_load_cycle,
    ]

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
