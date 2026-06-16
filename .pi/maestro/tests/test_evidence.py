#!/usr/bin/env python3
"""
Unit tests for ``lib/evidence.py`` — per-issue evidence markers.

Covers the 14 AC-listed tests:

- ``test_write_creates_file_with_hash``
- ``test_write_is_atomic_uses_tmp_rename``
- ``test_read_returns_none_for_missing_file``
- ``test_read_parses_existing_marker``
- ``test_read_detects_tampered_hash``
- ``test_read_handles_corrupt_json``
- ``test_check_returns_true_when_all_present``
- ``test_check_returns_false_when_any_missing``
- ``test_check_returns_false_when_unverified``
- ``test_make_tested_marker_verified_when_all_pass``
- ``test_make_tested_marker_unverified_when_exit_nonzero``
- ``test_make_tested_marker_unverified_when_tests_failed``
- ``test_make_reviewed_marker_verified_when_zero_critical``
- ``test_make_reviewed_marker_unverified_when_critical_nonzero``

Plus a handful of supporting tests for the manual_tested factory,
store mismatch checks, and EvidenceType enum membership.

Run with: ``python3 tests/test_evidence.py``
"""

import json
import os
import sys
import tempfile
from pathlib import Path

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from evidence import (
    EVIDENCE_DIR,
    EvidenceMarker,
    EvidenceStore,
    EvidenceType,
    make_manual_tested_marker,
    make_reviewed_marker,
    make_tested_marker,
    now_iso,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir() -> Path:
    """Return a fresh empty temp directory (caller cleans up)."""
    return Path(tempfile.mkdtemp(prefix="maestro_evidence_test_"))


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir."""
    for p in d.rglob("*"):
        try:
            p.unlink()
        except OSError:
            pass
    for p in sorted(d.rglob("*"), reverse=True):
        try:
            p.rmdir()
        except OSError:
            pass
    try:
        d.rmdir()
    except OSError:
        pass


# ─── Tests ──────────────────────────────────────────────────────────────


def test_write_creates_file_with_hash():
    """write() should produce a JSON file with a non-empty content_hash."""
    d = _make_dir()
    try:
        store = EvidenceStore(42, evidence_dir=d)
        marker = make_tested_marker(42, "pnpm test", 0, 47, 47)
        assert marker.content_hash == ""  # factory doesn't pre-compute
        store.write(marker)

        path = store.path_for(EvidenceType.TESTED)
        assert path.exists()
        data = json.loads(path.read_text())
        assert data["content_hash"] != ""
        assert len(data["content_hash"]) == 64  # SHA256 hex length
        # Hash is recomputed on write, so the in-memory marker is updated
        assert marker.content_hash == data["content_hash"]
    finally:
        _cleanup(d)


def test_write_is_atomic_uses_tmp_rename():
    """write() should write to .tmp then rename — no leftover .tmp."""
    d = _make_dir()
    try:
        store = EvidenceStore(11, evidence_dir=d)
        marker = make_tested_marker(11, "test", 0, 5, 5)
        store.write(marker)

        # Final file exists with content
        target = store.path_for(EvidenceType.TESTED)
        assert target.exists()
        data = json.loads(target.read_text())
        assert data["issue"] == 11

        # No leftover .tmp file
        leftovers = list(d.rglob("*.tmp"))
        assert leftovers == [], f"Leftover .tmp files: {leftovers}"
    finally:
        _cleanup(d)


def test_read_returns_none_for_missing_file():
    """read() on a non-existent marker should return None."""
    d = _make_dir()
    try:
        store = EvidenceStore(7, evidence_dir=d)
        assert store.read(EvidenceType.TESTED) is None
        assert store.read(EvidenceType.REVIEWED) is None
        assert store.read(EvidenceType.MANUAL_TESTED) is None
    finally:
        _cleanup(d)


def test_read_parses_existing_marker():
    """read() should round-trip a previously-written marker verbatim."""
    d = _make_dir()
    try:
        store = EvidenceStore(7, evidence_dir=d)
        original = make_tested_marker(7, "pytest", 0, 10, 10)
        store.write(original)

        loaded = store.read(EvidenceType.TESTED)
        assert loaded is not None
        assert loaded.issue == 7
        assert loaded.type == EvidenceType.TESTED
        assert loaded.verified is True
        assert loaded.created_by == "test_runner_phase"
        assert loaded.data["command"] == "pytest"
        assert loaded.data["exit_code"] == 0
        assert loaded.data["tests_run"] == 10
        assert loaded.data["tests_passed"] == 10
        assert loaded.data["tests_failed"] == 0
        assert loaded.content_hash != ""
    finally:
        _cleanup(d)


def test_read_detects_tampered_hash():
    """read() should mark the marker as unverified when ``data`` was modified."""
    d = _make_dir()
    try:
        store = EvidenceStore(8, evidence_dir=d)
        marker = make_tested_marker(8, "pytest", 0, 10, 10)
        store.write(marker)

        # Tamper with the data field (but leave the hash alone, to simulate
        # a sloppy attacker / a buggy consumer that forgot to re-hash)
        path = store.path_for(EvidenceType.TESTED)
        data = json.loads(path.read_text())
        data["data"]["tests_passed"] = 99  # lie about the count
        path.write_text(json.dumps(data, indent=2))

        reloaded = store.read(EvidenceType.TESTED)
        assert reloaded is not None
        assert reloaded.verified is False, (
            "Tampered marker must be marked unverified, not silently trusted"
        )
        # But the file is still present and parseable
        assert reloaded.data["tests_passed"] == 99  # we read what was there
    finally:
        _cleanup(d)


def test_read_handles_corrupt_json():
    """read() on a corrupt JSON file should return None, not raise."""
    d = _make_dir()
    try:
        store = EvidenceStore(9, evidence_dir=d)
        path = store.path_for(EvidenceType.TESTED)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ this is not valid json")

        assert store.read(EvidenceType.TESTED) is None
    finally:
        _cleanup(d)


def test_check_returns_true_when_all_present():
    """check() should return (True, []) when all required markers are present and verified."""
    d = _make_dir()
    try:
        store = EvidenceStore(10, evidence_dir=d)
        store.write(make_tested_marker(10, "x", 0, 1, 1))
        store.write(make_reviewed_marker(10, 0, 0, "human"))

        ok, missing = store.check([EvidenceType.TESTED, EvidenceType.REVIEWED])
        assert ok is True
        assert missing == []
    finally:
        _cleanup(d)


def test_check_returns_false_when_any_missing():
    """check() should return (False, [missing]) when some required markers are absent."""
    d = _make_dir()
    try:
        store = EvidenceStore(11, evidence_dir=d)
        store.write(make_tested_marker(11, "x", 0, 1, 1))
        # No reviewed marker

        ok, missing = store.check([EvidenceType.TESTED, EvidenceType.REVIEWED])
        assert ok is False
        assert missing == [EvidenceType.REVIEWED]
    finally:
        _cleanup(d)


def test_check_returns_false_when_unverified():
    """check() should treat tampered / unverified markers as missing."""
    d = _make_dir()
    try:
        store = EvidenceStore(12, evidence_dir=d)
        # Write a tested marker that will be unverified (tests failed)
        store.write(make_tested_marker(12, "x", 1, 5, 3))

        ok, missing = store.check([EvidenceType.TESTED])
        assert ok is False
        assert EvidenceType.TESTED in missing
    finally:
        _cleanup(d)


def test_make_tested_marker_verified_when_all_pass():
    """Factory: tested is verified when exit_code==0 and tests_passed==tests_run."""
    m = make_tested_marker(1, "test", 0, 47, 47)
    assert m.verified is True
    assert m.type == EvidenceType.TESTED


def test_make_tested_marker_unverified_when_exit_nonzero():
    """Factory: tested is unverified when exit_code != 0, even if counts match."""
    m = make_tested_marker(1, "test", 1, 47, 47)
    assert m.verified is False


def test_make_tested_marker_unverified_when_tests_failed():
    """Factory: tested is unverified when tests_passed < tests_run, even on exit 0."""
    m = make_tested_marker(1, "test", 0, 47, 45)
    assert m.verified is False
    assert m.data["tests_failed"] == 2


def test_make_reviewed_marker_verified_when_zero_critical():
    """Factory: reviewed is verified iff critical_issues == 0."""
    m = make_reviewed_marker(1, 0, 3, "claude-sonnet")
    assert m.verified is True
    assert m.type == EvidenceType.REVIEWED
    assert m.data["non_blocking_issues"] == 3


def test_make_reviewed_marker_unverified_when_critical_nonzero():
    """Factory: reviewed is unverified when critical_issues > 0."""
    m = make_reviewed_marker(1, 1, 0, "claude-sonnet")
    assert m.verified is False
    assert m.data["critical_issues"] == 1


# ─── Supporting tests (factory / store contract) ─────────────────────────


def test_make_manual_tested_marker_always_verified():
    """manual_tested is always verified (screenshots are evidence enough)."""
    m = make_manual_tested_marker(1, "user can log in", "before.png", "after.png")
    assert m.verified is True
    assert m.type == EvidenceType.MANUAL_TESTED
    assert m.data["scenario"] == "user can log in"
    assert m.data["verified_by"] == "playwright"


def test_compute_hash_is_stable_across_key_order():
    """The same dict in any key order should produce the same hash."""
    d = _make_dir()
    try:
        store = EvidenceStore(1, evidence_dir=d)
        a = store.compute_hash({"a": 1, "b": 2, "c": 3})
        b = store.compute_hash({"c": 3, "a": 1, "b": 2})
        c = store.compute_hash({"b": 2, "c": 3, "a": 1})
        assert a == b == c
    finally:
        _cleanup(d)


def test_store_issue_mismatch_raises():
    """Writing a marker whose issue doesn't match the store should raise."""
    d = _make_dir()
    try:
        store = EvidenceStore(5, evidence_dir=d)
        bad = make_tested_marker(99, "x", 0, 1, 1)
        try:
            store.write(bad)
            raise AssertionError("Expected ValueError on issue mismatch")
        except ValueError as e:
            assert "doesn't match" in str(e)
    finally:
        _cleanup(d)


def test_store_creates_issue_dir_on_init():
    """EvidenceStore() should create the per-issue directory eagerly."""
    d = _make_dir()
    try:
        # No markers written yet — just initialise
        store = EvidenceStore(13, evidence_dir=d)
        assert (d / "13").is_dir()
    finally:
        _cleanup(d)


def test_read_returns_none_for_wrong_type_at_path():
    """If someone hand-renames a marker (e.g. reviewed.json → tested.json),
    read() should refuse to return it as the requested type."""
    d = _make_dir()
    try:
        store = EvidenceStore(14, evidence_dir=d)
        # Write a reviewed marker
        store.write(make_reviewed_marker(14, 0, 0, "human"))
        # Then read it back as TESTED — should return None
        result = store.read(EvidenceType.TESTED)
        assert result is None, "read(TESTED) should refuse a reviewed marker file"
        # But read(REVIEWED) still works
        result = store.read(EvidenceType.REVIEWED)
        assert result is not None
    finally:
        _cleanup(d)


def test_check_handles_string_required():
    """check() should accept strings (from JSON flow configs) and coerce them."""
    d = _make_dir()
    try:
        store = EvidenceStore(15, evidence_dir=d)
        store.write(make_tested_marker(15, "x", 0, 1, 1))
        ok, missing = store.check(["tested", "reviewed"])
        assert ok is False
        assert EvidenceType.REVIEWED in missing
    finally:
        _cleanup(d)


def test_check_with_empty_required_list():
    """check([]) should trivially succeed — no requirements, nothing missing."""
    d = _make_dir()
    try:
        store = EvidenceStore(16, evidence_dir=d)
        ok, missing = store.check([])
        assert ok is True
        assert missing == []
    finally:
        _cleanup(d)


def test_evidence_survives_across_flow_restart():
    """Evidence written in one flow run should be readable by the next.

    Property of the evidence store (not the flow engine). A fresh
    ``EvidenceStore`` opened against the same directory should see
    the previously-written markers; tampering on disk between
    "restarts" should be detected as unverified.
    """
    d = _make_dir()
    try:
        # First "flow run" writes evidence
        store1 = EvidenceStore(123, evidence_dir=d)
        store1.write(make_tested_marker(123, "x", 0, 10, 10))
        store1.write(make_reviewed_marker(123, 0, 1, "claude-sonnet"))

        # Simulate flow restart by creating a fresh EvidenceStore
        store2 = EvidenceStore(123, evidence_dir=d)
        ok, missing = store2.check([EvidenceType.TESTED, EvidenceType.REVIEWED])
        assert ok is True
        assert missing == []

        # Tamper on disk → close phase sees unverified
        path = store2.path_for(EvidenceType.TESTED)
        data = json.loads(path.read_text())
        data["data"]["tests_passed"] = 5  # lie
        path.write_text(json.dumps(data, indent=2))

        store3 = EvidenceStore(123, evidence_dir=d)
        ok, missing = store3.check([EvidenceType.TESTED, EvidenceType.REVIEWED])
        assert ok is False
        assert EvidenceType.TESTED in missing  # tampered → treated as missing
    finally:
        _cleanup(d)


def test_evidence_type_enum_values():
    """The enum values must be the strings the CLI accepts."""
    assert EvidenceType.TESTED.value == "tested"
    assert EvidenceType.MANUAL_TESTED.value == "manual_tested"
    assert EvidenceType.REVIEWED.value == "reviewed"


def test_marker_survives_save_load_cycle():
    """A marker round-trip should preserve every field."""
    d = _make_dir()
    try:
        store = EvidenceStore(17, evidence_dir=d)
        original = make_tested_marker(17, "vitest run", 0, 25, 25)
        store.write(original)

        loaded = store.read(EvidenceType.TESTED)
        assert loaded is not None
        assert loaded.issue == original.issue
        assert loaded.type == original.type
        assert loaded.verified == original.verified
        assert loaded.created_at == original.created_at
        assert loaded.created_by == original.created_by
        assert loaded.data == original.data
        assert loaded.content_hash == original.content_hash
    finally:
        _cleanup(d)


# ─── Test runner ─────────────────────────────────────────────────────────


def main() -> int:
    """Run all tests in this file and return exit code 0 iff all pass."""
    import inspect

    failures: list[tuple[str, str]] = []
    tests = sorted(
        (name, fn)
        for name, fn in inspect.getmembers(sys.modules[__name__], inspect.isfunction)
        if name.startswith("test_")
    )

    for name, fn in tests:
        try:
            fn()
        except AssertionError as e:
            failures.append((name, f"AssertionError: {e}"))
        except Exception as e:  # noqa: BLE001
            failures.append((name, f"{type(e).__name__}: {e}"))

    total = len(tests)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        print("\nFAILURES:")
        for name, msg in failures:
            print(f"  - {name}: {msg}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
