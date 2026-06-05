#!/usr/bin/env python3
"""
Unit tests for ``commands/onboard.py`` — the ``maestro onboard <path>`` CLI
backing the Wave 2 Repo Onboarding slice (#282).

These tests use Click's ``CliRunner`` to invoke the command in-process
and inspect the resulting ``.maestro/projects.json`` /
``.maestro/learnings.md`` artefacts. The LLM-backed ``--interview`` path
is exercised by stubbing ``run_rpc_with_session_log`` so no real agent
is launched.

Run with: ``python3 tests/test_onboard_command.py``
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

# Path setup so the imports work from any cwd
_HERE = Path(__file__).parent.resolve()
_MAESTRO = _HERE.parent
sys.path.insert(0, str(_MAESTRO / "lib"))
sys.path.insert(0, str(_MAESTRO))

from click.testing import CliRunner  # noqa: E402

from commands.onboard import onboard_cmd  # noqa: E402
from projects_registry import (  # noqa: E402
    REGISTRY_FILENAME,
    ProjectsRegistry,
    hash_repo_path,
)
from repo_probe import probe_repo  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_fake_repo(prefix: str = "maestro_onboard_test_") -> tuple[Path, Path]:
    """Create a fake Python repo + a temp cwd.

    Returns:
        (repo_path, workdir) — ``workdir`` is where ``.maestro/`` will
        be created (a separate dir from the repo so the tests don't
        accidentally pollute the repo's own ``.maestro/``).
    """
    base = Path(tempfile.mkdtemp(prefix=prefix))
    repo = base / "myrepo"
    repo.mkdir()
    (repo / "tests").mkdir()
    (repo / "pyproject.toml").write_text(
        '[project]\nname = "myrepo"\ndependencies = ["fastapi"]\n'
        '[tool.pytest.ini_options]\naddopts = "-q"\n',
        encoding="utf-8",
    )
    (repo / "main.py").write_text("from fastapi import FastAPI\n", encoding="utf-8")
    (repo / "tests" / "test_main.py").write_text(
        "def test_x(): pass\n", encoding="utf-8"
    )
    (repo / "tests" / "__init__.py").write_text("", encoding="utf-8")
    workdir = base / "workdir"
    workdir.mkdir()
    return repo, workdir


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir."""
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


def _make_interview_response(
    evidence_strategy: str = "test-output",
    conventions: list[str] | None = None,
    gotchas: list[str] | None = None,
    playbooks: list[str] | None = None,
    primary_reviewer: str = "claude-sonnet",
) -> dict:
    """Build a fake interviewer RPC result."""
    payload = {
        "evidence_strategy": evidence_strategy,
        "conventions": conventions or ["conventional commits"],
        "gotchas": gotchas or ["tests need postgres on 5432"],
        "playbooks_recommended": playbooks or ["fix-bug.md", "add-feature.md"],
        "primary_reviewer": primary_reviewer,
    }
    raw_output = (
        "I'll ask the user a few questions...\n"
        "### PHASE_OUTPUT: success\n"
        f"{json.dumps(payload, indent=2)}\n"
        "### END_PHASE_OUTPUT\n"
    )
    return {
        "status": "success",
        "details": "interview complete",
        "output": raw_output,
    }


# ─── Tests ──────────────────────────────────────────────────────────────


def test_onboard_creates_registry_entry():
    """``maestro onboard <path>`` creates an entry in projects.json."""
    repo, workdir = _make_fake_repo()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            onboard_cmd,
            [str(repo), "--registry", str(registry_path)],
            catch_exceptions=False,
        )
        assert result.exit_code == 0, f"onboard failed: {result.output}"

        assert registry_path.exists(), "projects.json was not created"
        reg = ProjectsRegistry(registry_path)
        entries = reg.list_all()
        assert len(entries) == 1, f"expected 1 entry, got {len(entries)}"
        entry = entries[0]
        assert entry["alias"] == "myrepo"
        assert entry["path"] == str(repo.resolve())
        assert "python" in entry["languages"]
        assert "fastapi" in entry["frameworks"]
        # Mechanical fields populated
        assert entry["test_command"] == "pytest"
    finally:
        _cleanup(repo.parent)


def test_onboard_seeds_learnings_file():
    """First onboard seeds the repo's ``.maestro/learnings.md``."""
    repo, workdir = _make_fake_repo()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            onboard_cmd,
            [str(repo), "--registry", str(registry_path)],
            catch_exceptions=False,
        )
        assert result.exit_code == 0, result.output

        learnings_path = repo / ".maestro" / "learnings.md"
        assert learnings_path.exists(), "learnings.md was not seeded"
        text = learnings_path.read_text(encoding="utf-8")
        assert "python" in text
        assert "pytest" in text
        assert "fastapi" in text
    finally:
        _cleanup(repo.parent)


def test_onboard_idempotent_does_not_duplicate():
    """Re-running ``maestro onboard`` on the same repo overwrites (no duplicate)."""
    repo, workdir = _make_fake_repo()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME

        # First run
        r1 = runner.invoke(
            onboard_cmd,
            [str(repo), "--alias", "v1", "--registry", str(registry_path)],
        )
        assert r1.exit_code == 0

        # Second run with a different alias
        r2 = runner.invoke(
            onboard_cmd,
            [str(repo), "--alias", "v2", "--registry", str(registry_path)],
        )
        assert r2.exit_code == 0

        reg = ProjectsRegistry(registry_path)
        entries = reg.list_all()
        assert len(entries) == 1, f"upsert should be idempotent; got {len(entries)}"
        assert entries[0]["alias"] == "v2", "second onboard should have replaced first"
    finally:
        _cleanup(repo.parent)


def test_onboard_with_interview_captures_evidence_strategy():
    """``--interview`` runs the interviewer agent and stores the result."""
    repo, workdir = _make_fake_repo()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        interview_result = _make_interview_response(
            evidence_strategy="ui-screenshot",
            conventions=["no default exports", "snake_case for DB columns"],
            gotchas=["migrations must be backwards-compatible"],
            playbooks=["fix-bug.md"],
        )
        with patch(
            "commands.onboard.run_rpc_with_session_log",
            return_value=interview_result,
        ) as mock_rpc:
            result = runner.invoke(
                onboard_cmd,
                [str(repo), "--interview", "--registry", str(registry_path)],
                catch_exceptions=False,
            )
        assert result.exit_code == 0, f"onboard failed: {result.output}"
        # The RPC was actually called
        assert mock_rpc.called, "interview agent should have been called"

        reg = ProjectsRegistry(registry_path)
        entry = reg.list_all()[0]
        assert entry["evidence_strategy"] == "ui-screenshot"
        assert "no default exports" in entry["conventions"]
        assert "migrations must be backwards-compatible" in entry["gotchas"]
        assert entry["playbooks_recommended"] == ["fix-bug.md"]
    finally:
        _cleanup(repo.parent)


def test_re_interview_updates_existing_entry():
    """``--re-interview`` updates subjective fields on an existing entry."""
    repo, workdir = _make_fake_repo()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME

        # First onboard (mechanical only)
        r1 = runner.invoke(
            onboard_cmd,
            [str(repo), "--registry", str(registry_path)],
        )
        assert r1.exit_code == 0

        reg = ProjectsRegistry(registry_path)
        first_entry = reg.list_all()[0]
        assert first_entry["evidence_strategy"] == ""
        assert first_entry["conventions"] == []

        # Re-interview with new data
        new_data = _make_interview_response(
            evidence_strategy="scenario-script",
            conventions=["convention A", "convention B"],
        )
        with patch(
            "commands.onboard.run_rpc_with_session_log",
            return_value=new_data,
        ):
            r2 = runner.invoke(
                onboard_cmd,
                [str(repo), "--re-interview", "--registry", str(registry_path)],
                catch_exceptions=False,
            )
        assert r2.exit_code == 0, r2.output

        # Still one entry (no duplicate)
        entries = reg.list_all()
        assert len(entries) == 1
        # Subjective fields updated
        assert entries[0]["evidence_strategy"] == "scenario-script"
        assert "convention A" in entries[0]["conventions"]
    finally:
        _cleanup(repo.parent)


def test_onboard_handles_non_git_directory():
    """A non-git directory onboards successfully (no git_remote)."""
    repo, workdir = _make_fake_repo()
    try:
        # No ``git init`` — just leave the dir as plain files
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            onboard_cmd,
            [str(repo), "--registry", str(registry_path)],
        )
        assert result.exit_code == 0, result.output
        entry = ProjectsRegistry(registry_path).list_all()[0]
        assert entry["is_git_repo"] is False
        assert entry["git_remote"] == ""
    finally:
        _cleanup(repo.parent)


def test_onboard_with_interview_failure_still_writes_mechanical():
    """An interview parse error doesn't block the mechanical entry."""
    repo, workdir = _make_fake_repo()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        bad_result = {
            "status": "success",
            "details": "interview timed out",
            "output": "no PHASE_OUTPUT block in here, sorry",
        }
        with patch(
            "commands.onboard.run_rpc_with_session_log",
            return_value=bad_result,
        ):
            result = runner.invoke(
                onboard_cmd,
                [str(repo), "--interview", "--registry", str(registry_path)],
                catch_exceptions=False,
            )
        # Exit code 0 (interview failure is a warning, not an error)
        assert result.exit_code == 0, result.output

        # Entry was still written with mechanical data only
        reg = ProjectsRegistry(registry_path)
        entries = reg.list_all()
        assert len(entries) == 1
        assert "python" in entries[0]["languages"]
        # Subjective fields are empty
        assert entries[0]["evidence_strategy"] == ""
    finally:
        _cleanup(repo.parent)


def test_onboard_re_running_preserves_existing_learnings():
    """Re-onboarding does NOT clobber the repo's learnings.md."""
    repo, workdir = _make_fake_repo()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME

        # First onboard creates the learnings file
        r1 = runner.invoke(
            onboard_cmd, [str(repo), "--registry", str(registry_path)]
        )
        assert r1.exit_code == 0
        learnings = repo / ".maestro" / "learnings.md"
        first_text = learnings.read_text(encoding="utf-8")
        # Append a custom entry to simulate a prior retrospective run
        custom_marker = "\n\n## 2026-01-15 — Issue #1 (success)\n- **What worked:** test"
        with learnings.open("a", encoding="utf-8") as f:
            f.write(custom_marker)

        # Re-onboard
        r2 = runner.invoke(
            onboard_cmd, [str(repo), "--registry", str(registry_path)]
        )
        assert r2.exit_code == 0

        # Custom marker must still be there
        second_text = learnings.read_text(encoding="utf-8")
        assert custom_marker.strip() in second_text, (
            "re-onboard must not delete the learnings file"
        )
    finally:
        _cleanup(repo.parent)


def test_onboard_alias_defaults_to_dirname():
    """No ``--alias`` means the alias defaults to the repo's directory name."""
    repo, workdir = _make_fake_repo()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            onboard_cmd,
            [str(repo), "--registry", str(registry_path)],
        )
        assert result.exit_code == 0
        entry = ProjectsRegistry(registry_path).list_all()[0]
        assert entry["alias"] == "myrepo"
    finally:
        _cleanup(repo.parent)


def test_onboard_uses_explicit_alias():
    """``--alias`` overrides the default directory-name alias."""
    repo, workdir = _make_fake_repo()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            onboard_cmd,
            [str(repo), "--alias", "fancy-name", "--registry", str(registry_path)],
        )
        assert result.exit_code == 0
        entry = ProjectsRegistry(registry_path).list_all()[0]
        assert entry["alias"] == "fancy-name"
    finally:
        _cleanup(repo.parent)


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
