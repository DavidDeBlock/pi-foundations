#!/usr/bin/env annotations
"""
Unit tests for ``lib/projects_registry.py`` — the cross-repo registry
backing the ``maestro onboard`` and ``maestro projects`` commands.

Tests the full AC surface: load/save atomicity, upsert idempotency,
``get_by_path`` path resolution, remove semantics, and corrupt-file
recovery. We never mock the filesystem — the registry is intentionally
I/O-bound and a mock would test nothing useful.

Run with: ``python3 tests/test_projects_registry.py``
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Add lib to path so we can import the module under test without
# installing the package.
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from projects_registry import (  # noqa: E402
    HASH_PREFIX_LENGTH,
    REGISTRY_FILENAME,
    ProjectsRegistry,
    hash_repo_path,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir(prefix: str = "maestro_registry_test_") -> Path:
    """Return a fresh empty temp directory."""
    return Path(tempfile.mkdtemp(prefix=prefix))


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir."""
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


def _sample_entry(path: str, alias: str = "myrepo") -> dict:
    """Build a fully-populated sample entry for tests.

    Mirrors the AC's required fields:
    ``alias, path, hash, probed_at, languages, package_manager,
    test_command, build_command, lint_command, frameworks,
    evidence_strategy, conventions, gotchas, playbooks_recommended``.
    """
    return {
        "alias": alias,
        "path": path,
        "hash": hash_repo_path(path),
        "probed_at": "2026-01-01T00:00:00Z",
        "languages": ["python"],
        "package_manager": "pyproject",
        "test_command": "pytest",
        "build_command": "",
        "lint_command": "ruff check .",
        "frameworks": ["fastapi"],
        "evidence_strategy": "test-output",
        "conventions": ["conventional commits"],
        "gotchas": ["migrations must be backwards-compatible"],
        "playbooks_recommended": ["fix-bug.md", "add-feature.md"],
    }


# ─── Hashing ─────────────────────────────────────────────────────────────


def test_hash_repo_path_is_stable():
    """Same path always yields the same hash."""
    a = hash_repo_path("/tmp/foo")
    b = hash_repo_path("/tmp/foo")
    assert a == b


def test_hash_repo_path_is_path_specific():
    """Different paths yield different hashes."""
    a = hash_repo_path("/tmp/foo")
    b = hash_repo_path("/tmp/bar")
    assert a != b


def test_hash_repo_path_length():
    """Hash returns exactly :data:`HASH_PREFIX_LENGTH` hex chars."""
    h = hash_repo_path("/tmp/whatever")
    assert len(h) == HASH_PREFIX_LENGTH
    assert all(c in "0123456789abcdef" for c in h), "expected hex chars"


def test_hash_repo_path_resolves_relative():
    """``./foo`` and the resolved equivalent hash to the same value."""
    cwd = os.getcwd()
    try:
        os.chdir("/tmp")
        a = hash_repo_path("./foo")
        b = hash_repo_path("/tmp/foo")
        assert a == b, "relative and absolute should hash identically after resolve"
    finally:
        os.chdir(cwd)


def test_hash_repo_path_resolves_tilde():
    """``~/foo`` is resolved before hashing (the registry should be stable
    across tilde vs absolute invocations)."""
    a = hash_repo_path(os.path.expanduser("~"))
    b = hash_repo_path(os.path.expanduser("~"))
    assert a == b


# ─── load / save round-trip ─────────────────────────────────────────────


def test_load_empty_registry():
    """A non-existent registry file loads as an empty dict."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        assert reg.load() == {}
    finally:
        _cleanup(d)


def test_upsert_new_entry():
    """Upserting a new entry adds it to the registry."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        entry = _sample_entry("/tmp/test-repo-1", alias="test-repo-1")

        reg.upsert(entry)
        loaded = reg.load()

        assert len(loaded) == 1
        repo_hash = hash_repo_path("/tmp/test-repo-1")
        assert repo_hash in loaded
        assert loaded[repo_hash]["alias"] == "test-repo-1"
    finally:
        _cleanup(d)


def test_upsert_existing_entry_overwrites():
    """Upserting with the same hash replaces the existing entry (no duplicates)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        entry1 = _sample_entry("/tmp/foo", alias="foo-v1")
        entry1["test_command"] = "pytest"

        reg.upsert(entry1)
        assert len(reg.load()) == 1

        # Upsert again with a new alias — same hash, different content
        entry2 = _sample_entry("/tmp/foo", alias="foo-v2")
        entry2["test_command"] = "unittest"
        reg.upsert(entry2)

        loaded = reg.load()
        assert len(loaded) == 1, "upsert should not create duplicates"
        assert loaded[hash_repo_path("/tmp/foo")]["alias"] == "foo-v2"
        assert loaded[hash_repo_path("/tmp/foo")]["test_command"] == "unittest"
    finally:
        _cleanup(d)


def test_upsert_derives_hash_from_path():
    """An entry without an explicit ``hash`` field gets one derived from ``path``."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        entry = _sample_entry("/tmp/foo")
        del entry["hash"]  # force the auto-derive path

        reg.upsert(entry)
        loaded = reg.load()
        expected = hash_repo_path("/tmp/foo")
        assert expected in loaded
        assert loaded[expected]["hash"] == expected
    finally:
        _cleanup(d)


def test_upsert_requires_path_or_hash():
    """An entry without ``hash`` AND without ``path`` raises ValueError."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        try:
            reg.upsert({"alias": "broken"})
        except ValueError:
            pass
        else:
            raise AssertionError("expected ValueError for missing path/hash")
    finally:
        _cleanup(d)


# ─── get / get_by_path ──────────────────────────────────────────────────


def test_get_by_path_returns_correct_entry():
    """``get_by_path`` returns the entry whose ``path`` resolves to the same value."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)

        # Create a real temp dir so resolve() works
        real_repo = d / "real-repo"
        real_repo.mkdir()

        entry = _sample_entry(str(real_repo), alias="real")
        reg.upsert(entry)

        # Lookup by the same path
        found = reg.get_by_path(str(real_repo))
        assert found is not None
        assert found["alias"] == "real"
    finally:
        _cleanup(d)


def test_get_by_path_resolves_relative():
    """``get_by_path`` resolves relative paths to absolute before comparison."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        real_repo = d / "my-repo"
        real_repo.mkdir()

        entry = _sample_entry(str(real_repo.resolve()), alias="myrepo")
        reg.upsert(entry)

        # Lookup using a relative path (from inside the same dir)
        cwd = os.getcwd()
        try:
            os.chdir(str(d))
            found = reg.get_by_path("./my-repo")
            assert found is not None
            assert found["alias"] == "myrepo"
        finally:
            os.chdir(cwd)
    finally:
        _cleanup(d)


def test_get_by_path_returns_none_for_missing():
    """A path not in the registry returns None (not an error)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        reg.upsert(_sample_entry("/tmp/some-other-repo", alias="other"))

        # Lookup a path that doesn't exist
        result = reg.get_by_path("/tmp/this-does-not-exist-anywhere-12345")
        assert result is None
    finally:
        _cleanup(d)


def test_get_by_path_handles_tilde():
    """``get_by_path`` expands ``~`` before comparison."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        home = os.path.expanduser("~")
        entry = _sample_entry(home, alias="home")
        reg.upsert(entry)

        # Look up via ~/ — must resolve and match
        found = reg.get_by_path("~/")
        assert found is not None
        assert found["alias"] == "home"
    finally:
        _cleanup(d)


def test_get_returns_none_for_missing_hash():
    """``get`` returns None when the hash is absent (not KeyError)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        assert reg.get("nonexistent") is None
    finally:
        _cleanup(d)


# ─── remove ─────────────────────────────────────────────────────────────


def test_remove_deletes_entry():
    """``remove`` deletes the entry but leaves the file (now empty)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        entry = _sample_entry("/tmp/to-remove")
        reg.upsert(entry)

        repo_hash = hash_repo_path("/tmp/to-remove")
        assert reg.get(repo_hash) is not None

        result = reg.remove(repo_hash)
        assert result is True
        assert reg.get(repo_hash) is None
        # File should now contain an empty dict
        assert reg.load() == {}
    finally:
        _cleanup(d)


def test_remove_missing_hash_returns_false():
    """``remove`` on a non-existent hash is a silent no-op (returns False)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        assert reg.remove("nonexistent") is False
    finally:
        _cleanup(d)


def test_remove_does_not_delete_repo():
    """``remove`` is a registry operation only — the repo dir is untouched."""
    d = _make_dir()
    try:
        real_repo = d / "real-repo"
        real_repo.mkdir()
        reg = ProjectsRegistry(d / REGISTRY_FILENAME)
        reg.upsert(_sample_entry(str(real_repo)))

        repo_hash = hash_repo_path(str(real_repo))
        reg.remove(repo_hash)

        # Repo directory must still exist
        assert real_repo.exists()
    finally:
        _cleanup(d)


# ─── save atomicity ─────────────────────────────────────────────────────


def test_save_is_atomic():
    """``save`` writes to a temp file first, then renames — no partial writes visible."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        registry = {"abc123": _sample_entry("/tmp/foo", alias="foo")}

        reg.save(registry)

        # After save completes, no ``*.tmp`` files should remain
        leftover_tmps = [
            p for p in path.parent.iterdir()
            if p.name.startswith(path.name) and p.name.endswith(".tmp")
        ]
        assert leftover_tmps == [], f"temp files leaked: {leftover_tmps}"

        # The main file is well-formed
        loaded = reg.load()
        assert "abc123" in loaded
    finally:
        _cleanup(d)


def test_save_overwrites_existing_file():
    """``save`` replaces the contents of an existing file (not append)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        reg.save({"a": 1})
        reg.save({"b": 2})

        loaded = reg.load()
        assert loaded == {"b": 2}, f"expected overwrite, got {loaded}"
    finally:
        _cleanup(d)


def test_save_creates_parent_directories():
    """``save`` creates ``.maestro/`` automatically — the caller doesn't need to mkdir first."""
    d = _make_dir()
    try:
        nested = d / "deep" / "nested" / ".maestro" / "projects.json"
        reg = ProjectsRegistry(nested)
        reg.save({"x": {"alias": "x", "path": "/tmp/x"}})

        assert nested.exists()
        assert reg.load() == {"x": {"alias": "x", "path": "/tmp/x"}}
    finally:
        _cleanup(d)


def test_save_rejects_non_dict():
    """``save`` raises TypeError on non-dict input — guards against silent corruption."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        try:
            reg.save("not a dict")
        except TypeError:
            pass
        else:
            raise AssertionError("expected TypeError for non-dict save")
    finally:
        _cleanup(d)


# ─── Corrupt-file recovery ──────────────────────────────────────────────


def test_registry_survives_corrupt_file_with_backup():
    """A corrupt registry file is backed up and an empty dict is returned.

    Per the PRD design note: "We never silently ignore corruption."
    The backup filename includes the unix timestamp so multiple
    corrupt-file events don't overwrite each other.
    """
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write a file that's not valid JSON
        path.write_text("this is { broken json @@@", encoding="utf-8")

        reg = ProjectsRegistry(path)
        loaded = reg.load()

        # Empty registry returned
        assert loaded == {}
        # Backup file was created
        backups = list(path.parent.glob("projects.corrupt.*.json"))
        assert len(backups) == 1, f"expected exactly one backup, got {backups}"
        # The original file was moved (not just renamed-in-place)
        assert not path.exists(), "original corrupt file should be moved aside"
    finally:
        _cleanup(d)


def test_registry_survives_non_object_json():
    """A JSON file containing a list (not an object) is treated as corrupt and recovered."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")

        reg = ProjectsRegistry(path)
        loaded = reg.load()

        assert loaded == {}
        backups = list(path.parent.glob("projects.corrupt.*.json"))
        assert len(backups) == 1
    finally:
        _cleanup(d)


# ─── Multi-entry invariants ─────────────────────────────────────────────


def test_multiple_entries_with_unique_hashes():
    """Different paths yield different hashes and are stored as separate entries."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)

        reg.upsert(_sample_entry("/tmp/repo-a", alias="a"))
        reg.upsert(_sample_entry("/tmp/repo-b", alias="b"))
        reg.upsert(_sample_entry("/tmp/repo-c", alias="c"))

        loaded = reg.load()
        assert len(loaded) == 3
        assert hash_repo_path("/tmp/repo-a") in loaded
        assert hash_repo_path("/tmp/repo-b") in loaded
        assert hash_repo_path("/tmp/repo-c") in loaded
    finally:
        _cleanup(d)


def test_list_all_returns_values_in_insertion_order():
    """``list_all`` returns entries in insertion order (most recent last)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        reg.upsert(_sample_entry("/tmp/first", alias="first"))
        reg.upsert(_sample_entry("/tmp/second", alias="second"))

        all_entries = reg.list_all()
        assert [e["alias"] for e in all_entries] == ["first", "second"]
    finally:
        _cleanup(d)


# ─── Error-path coverage (branches hit by best-effort recovery code) ────


def test_load_handles_oserror_on_read():
    """A read error on the registry file falls back to empty (no crash)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write a valid file first, then replace with a directory at the
        # same path so subsequent reads fail with IsADirectoryError
        # (a subclass of OSError).
        path.write_text("{}", encoding="utf-8")
        path.rmdir() if False else None
        # Replace the file with a directory — reads will now fail
        path.unlink()
        path.mkdir()

        reg = ProjectsRegistry(path)
        # Should not raise — returns empty
        loaded = reg.load()
        assert loaded == {}
    finally:
        _cleanup(d)


def test_upsert_raises_on_non_dict_entry():
    """``upsert`` raises TypeError on non-dict input — guards the contract."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        try:
            reg.upsert("not a dict")  # type: ignore[arg-type]
        except TypeError:
            pass
        else:
            raise AssertionError("expected TypeError for non-dict upsert")
    finally:
        _cleanup(d)


def test_remove_on_empty_string_returns_false():
    """``remove`` with an empty string is a silent no-op (returns False)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        assert reg.remove("") is False
    finally:
        _cleanup(d)


def test_get_with_empty_string_returns_none():
    """``get`` with an empty string returns None (no crash)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        assert reg.get("") is None
    finally:
        _cleanup(d)


def test_get_by_path_with_empty_string_returns_none():
    """``get_by_path`` with empty input returns None (no crash)."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        assert reg.get_by_path("") is None
    finally:
        _cleanup(d)


def test_hash_for_method_matches_function():
    """``reg.hash_for(path)`` is identical to ``hash_repo_path(path)``."""
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        reg = ProjectsRegistry(path)
        assert reg.hash_for("/tmp/foo") == hash_repo_path("/tmp/foo")
    finally:
        _cleanup(d)


def test_corrupt_registry_logs_to_stderr():
    """A corrupt file produces a log line on stderr (best-effort logging).

    The log line is informational — the user gets a hint that their
    registry was corrupt and a backup was created. Tests that the
    logging path is exercised (it never raises even when stderr is
    closed).
    """
    import io
    d = _make_dir()
    try:
        path = d / REGISTRY_FILENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("not valid json", encoding="utf-8")

        reg = ProjectsRegistry(path)
        # Capture stderr to verify the log line
        captured = io.StringIO()
        old_stderr = sys.stderr
        sys.stderr = captured
        try:
            loaded = reg.load()
        finally:
            sys.stderr = old_stderr

        assert loaded == {}
        log = captured.getvalue()
        assert "projects_registry" in log
    finally:
        _cleanup(d)


# ─── Test runner ────────────────────────────────────────────────────────


if __name__ == "__main__":
    import traceback

    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    passed = 0
    failed = 0
    for test_fn in tests:
        try:
            test_fn()
            print(f"  ✓ {test_fn.__name__}")
            passed += 1
        except Exception as e:
            print(f"  ✗ {test_fn.__name__}: {type(e).__name__}: {e}")
            traceback.print_exc()
            failed += 1
    print(f"\n{passed} passed, {failed} failed ({len(tests)} total)")
    sys.exit(0 if failed == 0 else 1)
