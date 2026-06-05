#!/usr/bin/env python3
"""
Unit tests for context_prefetch.py — Static repo context prefetch.

Covers:
- get_git_sha returns HEAD SHA in a git repo
- get_git_sha returns 'unknown' for non-git / missing binary
- cache_key is deterministic for the same repo + SHA
- prefetch_context uses cache when available
- prefetch_context detects npm package manager
- prefetch_context detects python package manager
- prefetch_context extracts test/build/lint commands from package.json
- format_prefetched_context includes all sections

Run with: python3 tests/test_context_prefetch.py
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from context_prefetch import (
    PrefetchedContext,
    prefetch_context,
    format_prefetched_context,
    get_git_sha,
    cache_key,
    clear_cache,
    CACHE_DIR,
    MAX_TEST_FILES,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="maestro_prefetch_test_"))


def _write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj))


# ─── Tests ──────────────────────────────────────────────────────────────


def test_get_git_sha_returns_head_sha():
    """In a git repo, get_git_sha should return the actual HEAD SHA."""
    d = _make_tmpdir()
    try:
        # Initialise a git repo
        subprocess.run(["git", "init", "-q"], cwd=str(d), check=True)
        subprocess.run(
            ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
            cwd=str(d), check=True, capture_output=True,
        )

        sha = get_git_sha(d)
        assert sha != "unknown", f"Expected real SHA, got {sha!r}"
        assert len(sha) == 40, f"Expected 40-char SHA, got {sha!r}"
    finally:
        # Best-effort cleanup
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_get_git_sha_returns_unknown_for_non_git_repo():
    """In a non-git directory, get_git_sha should return 'unknown'."""
    d = _make_tmpdir()
    try:
        sha = get_git_sha(d)
        assert sha == "unknown", f"Expected 'unknown', got {sha!r}"
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_get_git_sha_returns_unknown_for_missing_git_binary(monkeypatch=None):
    """If git is not on PATH, get_git_sha should return 'unknown' instead of raising."""
    d = _make_tmpdir()
    try:
        # Simulate missing git binary by patching subprocess.run to raise
        import context_prefetch
        original_run = context_prefetch.subprocess.run

        def fake_run(*args, **kwargs):
            raise FileNotFoundError("git not found")

        context_prefetch.subprocess.run = fake_run
        try:
            sha = get_git_sha(d)
            assert sha == "unknown"
        finally:
            context_prefetch.subprocess.run = original_run
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_cache_key_is_deterministic_for_same_repo_and_sha():
    """cache_key should return the same path for identical inputs."""
    d = _make_tmpdir()
    try:
        k1 = cache_key(d, "abc123")
        k2 = cache_key(d, "abc123")
        assert k1 == k2

        # Different SHA → different key
        k3 = cache_key(d, "def456")
        assert k1 != k3

        # Different repo → different key
        d2 = _make_tmpdir()
        try:
            k4 = cache_key(d2, "abc123")
            assert k1 != k4
        finally:
            import shutil
            try:
                shutil.rmtree(d2)
            except OSError:
                pass
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_prefetch_context_uses_cache_when_available():
    """If a cache file exists, prefetch_context should return its contents without re-detecting."""
    d = _make_tmpdir()
    cache_d = d / "cache"
    cache_d.mkdir()
    try:
        repo = d / "repo"
        repo.mkdir()
        # Write a package.json
        (repo / "package.json").write_text(json.dumps({
            "scripts": {"test": "vitest"},
            "dependencies": {"react": "^18"},
        }))

        # Pre-populate the cache with hand-crafted data that DIFFERS from what
        # detection would produce — this proves the cache wins.
        # We use the actual cache_key() so we hit the right path.
        repo_path = repo
        sha = get_git_sha(repo_path)
        cache_path = cache_key(repo_path, sha, cache_dir=cache_d)
        _write_json(cache_path, {
            "git_sha": sha,
            "test_command": "FROM-CACHE",
            "package_manager": "FROM-CACHE",
            "dependencies": {"from": "cache"},
            "scripts": {},
            "test_files": [],
            "convention_hints": ["cached hint"],
        })

        ctx = prefetch_context(repo_path, cache_dir=cache_d)
        assert ctx.test_command == "FROM-CACHE"
        assert ctx.package_manager == "FROM-CACHE"
        assert ctx.dependencies == {"from": "cache"}
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_prefetch_context_detects_npm_package_manager():
    """A package.json file should trigger npm/pnpm/bun detection."""
    d = _make_tmpdir()
    cache_d = d / "cache"
    try:
        repo = d / "repo"
        repo.mkdir()
        (repo / "package.json").write_text(json.dumps({
            "name": "x",
            "scripts": {"test": "vitest", "build": "tsc", "lint": "eslint ."},
        }))

        ctx = prefetch_context(repo, cache_dir=cache_d)
        assert ctx.package_manager == "npm/pnpm/bun"
        assert ctx.test_command == "vitest"
        assert ctx.build_command == "tsc"
        assert ctx.lint_command == "eslint ."
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_prefetch_context_detects_python_package_manager():
    """A pyproject.toml should trigger Python detection with pytest as default."""
    d = _make_tmpdir()
    cache_d = d / "cache"
    try:
        repo = d / "repo"
        repo.mkdir()
        (repo / "pyproject.toml").write_text("[project]\nname = 'x'\n")

        ctx = prefetch_context(repo, cache_dir=cache_d)
        assert ctx.package_manager == "python"
        assert ctx.test_command == "pytest"
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_prefetch_context_extracts_dependencies_from_package_json():
    """JS dependencies + devDependencies should both be extracted."""
    d = _make_tmpdir()
    cache_d = d / "cache"
    try:
        repo = d / "repo"
        repo.mkdir()
        (repo / "package.json").write_text(json.dumps({
            "name": "x",
            "dependencies": {"react": "^18.0.0", "lodash": "^4.17.0"},
            "devDependencies": {"vitest": "^1.0.0", "typescript": "^5.0.0"},
        }))

        ctx = prefetch_context(repo, cache_dir=cache_d)
        # All four should be present
        assert "react" in ctx.dependencies
        assert "lodash" in ctx.dependencies
        assert "vitest" in ctx.dependencies
        assert "typescript" in ctx.dependencies
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_prefetch_context_discovers_test_files_capped():
    """Test file discovery should be capped at MAX_TEST_FILES."""
    d = _make_tmpdir()
    cache_d = d / "cache"
    try:
        repo = d / "repo"
        repo.mkdir()
        (repo / "package.json").write_text("{}")

        # Create MORE than MAX_TEST_FILES test files
        for i in range(MAX_TEST_FILES + 5):
            (repo / f"test_{i}.py").write_text("# test")

        ctx = prefetch_context(repo, cache_dir=cache_d)
        assert len(ctx.test_files) == MAX_TEST_FILES, (
            f"Expected {MAX_TEST_FILES} test files, got {len(ctx.test_files)}"
        )
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_prefetch_context_detects_convention_hints():
    """Config files (eslint, tsconfig, Dockerfile) should appear as hints."""
    d = _make_tmpdir()
    cache_d = d / "cache"
    try:
        repo = d / "repo"
        repo.mkdir()
        (repo / "package.json").write_text("{}")
        (repo / ".eslintrc.json").write_text("{}")
        (repo / "tsconfig.json").write_text("{}")
        (repo / "Dockerfile").write_text("FROM node:18")

        ctx = prefetch_context(repo, cache_dir=cache_d)
        assert "uses ESLint" in ctx.convention_hints
        assert "TypeScript project" in ctx.convention_hints
        assert "has Dockerfile" in ctx.convention_hints
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


def test_format_prefetched_context_includes_all_sections():
    """format_prefetched_context should produce a markdown block with all populated sections."""
    ctx = PrefetchedContext(
        git_sha="abc123",
        test_command="vitest",
        build_command="tsc",
        lint_command="eslint .",
        package_manager="npm/pnpm/bun",
        dependencies={"react": "^18.0.0", "lodash": "^4.17.0"},
        scripts={"test": "vitest"},
        test_files=["tests/foo.test.ts", "tests/bar.test.ts"],
        convention_hints=["uses ESLint", "TypeScript project"],
    )

    md = format_prefetched_context(ctx)
    assert md.startswith("## Prefetched Repo Context")
    assert "npm/pnpm/bun" in md
    assert "`vitest`" in md
    assert "`tsc`" in md
    assert "`eslint .`" in md
    assert "uses ESLint" in md
    assert "TypeScript project" in md
    assert "tests/foo.test.ts" in md
    # Dependencies section
    assert "Dependencies" in md
    # Should mention we have 2 deps
    assert "2" in md


def test_format_prefetched_context_handles_empty():
    """An empty context should still produce a heading + a 'no info' note."""
    ctx = PrefetchedContext(git_sha="unknown")
    md = format_prefetched_context(ctx)
    assert "## Prefetched Repo Context" in md
    assert "No static repo context detected" in md


# ─── Test runner ─────────────────────────────────────────────────────────


if __name__ == "__main__":
    print("Running context_prefetch unit tests...\n")

    tests = [
        test_get_git_sha_returns_head_sha,
        test_get_git_sha_returns_unknown_for_non_git_repo,
        test_get_git_sha_returns_unknown_for_missing_git_binary,
        test_cache_key_is_deterministic_for_same_repo_and_sha,
        test_prefetch_context_uses_cache_when_available,
        test_prefetch_context_detects_npm_package_manager,
        test_prefetch_context_detects_python_package_manager,
        test_prefetch_context_extracts_dependencies_from_package_json,
        test_prefetch_context_discovers_test_files_capped,
        test_prefetch_context_detects_convention_hints,
        test_format_prefetched_context_includes_all_sections,
        test_format_prefetched_context_handles_empty,
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
