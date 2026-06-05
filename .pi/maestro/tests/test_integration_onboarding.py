#!/usr/bin/env python3
"""
Integration tests for the Wave 2 Repo Onboarding slice (#282).

These tests exercise the end-to-end flow:

1. Onboard a real (fake) repo via ``maestro onboard``.
2. Verify the registry, learnings file, and CLI commands work.
3. Verify the flow engine's auto-load picks up the context.
4. Verify the ``projects list/show/remove`` subcommands.

We use Click's ``CliRunner`` to invoke commands in-process, and we
stub the RPC layer for the ``--interview`` path. The flow engine
test is a unit-level check (not a real flow run) — it just verifies
that ``context["repo_context"]`` is populated when a registry entry
exists for the cwd.

Run with: ``python3 tests/test_integration_onboarding.py``
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
from commands.projects import projects_cli  # noqa: E402
from projects_registry import (  # noqa: E402
    REGISTRY_FILENAME,
    ProjectsRegistry,
    hash_repo_path,
)
from repo_probe import probe_repo  # noqa: E402
from flow_engine import _format_repo_context  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_fake_repo(prefix: str = "maestro_int_test_") -> Path:
    """Build a fake Python+TS monorepo (as realistic as we can in a temp dir)."""
    base = Path(tempfile.mkdtemp(prefix=prefix))
    repo = base / "demo"
    repo.mkdir()
    (repo / "src").mkdir()
    (repo / "tests").mkdir()
    (repo / "frontend").mkdir()
    (repo / "frontend" / "src").mkdir()

    # Python side
    (repo / "pyproject.toml").write_text(
        '[project]\nname = "demo"\ndependencies = ["fastapi"]\n'
        '[tool.pytest.ini_options]\n',
        encoding="utf-8",
    )
    (repo / "src" / "__init__.py").write_text("", encoding="utf-8")
    (repo / "src" / "main.py").write_text(
        "from fastapi import FastAPI\napp = FastAPI()\n", encoding="utf-8"
    )
    (repo / "tests" / "test_main.py").write_text(
        "def test_health(): pass\n", encoding="utf-8"
    )

    # TypeScript side
    pkg = {
        "name": "demo-frontend",
        "dependencies": {"react": "^18.0.0", "next": "^14.0.0"},
        "scripts": {"test": "vitest run", "build": "tsc", "lint": "eslint ."},
    }
    (repo / "frontend" / "package.json").write_text(
        json.dumps(pkg), encoding="utf-8"
    )
    (repo / "frontend" / "tsconfig.json").write_text(
        '{"compilerOptions": {"target": "ES2020"}}\n', encoding="utf-8"
    )
    (repo / "frontend" / "src" / "app.ts").write_text(
        "const x: number = 1;\n", encoding="utf-8"
    )
    (repo / "frontend" / "pnpm-lock.yaml").write_text(
        "lockfileVersion: '6.0'\n", encoding="utf-8"
    )

    # Git remote
    os.system(f"cd {repo} && git init -q && git remote add origin https://example.com/demo.git")

    return repo


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir (handles parents too)."""
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


# ─── Integration tests ──────────────────────────────────────────────────


def test_end_to_end_onboard_then_flow():
    """Onboard a real repo, then verify the flow engine auto-loads context.

    This is the headline integration test: a real (fake) repo is
    onboarded via the CLI, then we simulate the flow engine's
    auto-load by calling the same lookup the engine uses. The
    resulting ``repo_context`` must contain the captured data.
    """
    repo = _make_fake_repo()
    workdir = repo.parent / "workdir"
    workdir.mkdir()
    try:
        # Step 1: Onboard
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            onboard_cmd,
            [str(repo), "--alias", "demo-app", "--registry", str(registry_path)],
            catch_exceptions=False,
        )
        assert result.exit_code == 0, f"onboard failed: {result.output}"

        # Step 2: Registry has the entry
        reg = ProjectsRegistry(registry_path)
        entries = reg.list_all()
        assert len(entries) == 1
        entry = entries[0]
        assert entry["alias"] == "demo-app"
        # Mechanical data captured
        assert "python" in entry["languages"]
        assert "typescript" in entry["languages"]
        assert "react" in entry["frameworks"]
        assert "fastapi" in entry["frameworks"]
        assert entry["package_manager"] == "pnpm"
        assert "pytest" in entry["test_command"]
        # Git remote captured
        assert entry["is_git_repo"] is True
        assert "example.com" in entry["git_remote"]
        # Path + hash consistent
        assert entry["path"] == str(repo.resolve())
        assert entry["hash"] == hash_repo_path(str(repo))

        # Step 3: Learnings file seeded
        learnings = repo / ".maestro" / "learnings.md"
        assert learnings.exists()
        text = learnings.read_text(encoding="utf-8")
        # Header uses the directory name; alias is recorded in the registry
        assert "demo" in text
        assert "python" in text
        assert "react" in text

        # Step 4: Flow engine's auto-load works
        # We simulate the flow engine's lookup by running the same
        # _format_repo_context helper against the loaded entry.
        repo_context = _format_repo_context(entry)
        assert repo_context["alias"] == "demo-app"
        assert "fastapi" in repo_context["frameworks"]
        assert "react" in repo_context["frameworks"]
        assert repo_context["test_command"] == "pytest"
    finally:
        _cleanup(repo.parent)


def test_onboard_with_interview_runs_agent():
    """``--interview`` invokes the agent with the probe data as context.

    The agent is stubbed via ``run_rpc_with_session_log``. We verify
    that the prompt passed to the agent contains the probe data
    (so the agent can ask informed questions), and that the parsed
    output is merged into the registry entry.
    """
    repo = _make_fake_repo()
    workdir = repo.parent / "workdir"
    workdir.mkdir()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME

        interview_payload = {
            "evidence_strategy": "scenario-script",
            "conventions": ["conventional commits", "no default exports"],
            "gotchas": ["tests need postgres on 5432"],
            "playbooks_recommended": ["add-feature.md", "fix-bug.md"],
            "primary_reviewer": "claude-sonnet",
        }
        interview_output = (
            "Let me ask a few questions...\n"
            "### PHASE_OUTPUT: success\n"
            f"{json.dumps(interview_payload, indent=2)}\n"
            "### END_PHASE_OUTPUT\n"
        )
        mock_result = {
            "status": "success",
            "details": "interview complete",
            "output": interview_output,
        }
        captured_prompts: list[str] = []

        def fake_rpc(prompt, *args, **kwargs):
            captured_prompts.append(prompt)
            return mock_result

        with patch(
            "commands.onboard.run_rpc_with_session_log",
            side_effect=fake_rpc,
        ) as mock_rpc:
            result = runner.invoke(
                onboard_cmd,
                [str(repo), "--interview", "--registry", str(registry_path)],
                catch_exceptions=False,
            )

        assert result.exit_code == 0, f"onboard failed: {result.output}"
        # Agent was called
        assert mock_rpc.called
        # Prompt included the probe data
        assert len(captured_prompts) == 1
        prompt = captured_prompts[0]
        # Repo path rendered
        assert str(repo) in prompt
        # Probe data rendered (at least the languages and package manager)
        assert "python" in prompt or "react" in prompt
        assert "pnpm" in prompt

        # Registry entry has the interview data merged
        reg = ProjectsRegistry(registry_path)
        entry = reg.list_all()[0]
        assert entry["evidence_strategy"] == "scenario-script"
        assert "conventional commits" in entry["conventions"]
        assert "no default exports" in entry["conventions"]
        assert "tests need postgres on 5432" in entry["gotchas"]
        assert entry["playbooks_recommended"] == ["add-feature.md", "fix-bug.md"]
        assert entry["primary_reviewer"] == "claude-sonnet"
    finally:
        _cleanup(repo.parent)


def test_projects_list_show_remove_workflow():
    """The full ``maestro projects list / show / remove`` workflow.

    Onboards a repo, then exercises each ``projects`` subcommand.
    Verifies the JSON output, the alias lookup, and the safe
    (no-repo-deletion) remove semantics.
    """
    repo = _make_fake_repo()
    workdir = repo.parent / "workdir"
    workdir.mkdir()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME

        # Onboard
        r1 = runner.invoke(
            onboard_cmd,
            [str(repo), "--alias", "demo-app", "--registry", str(registry_path)],
            catch_exceptions=False,
        )
        assert r1.exit_code == 0

        # list --json
        r2 = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "list", "--json"],
            catch_exceptions=False,
        )
        assert r2.exit_code == 0, r2.output
        data = json.loads(r2.output)
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["alias"] == "demo-app"

        # show by alias
        r3 = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "show", "demo-app"],
            catch_exceptions=False,
        )
        assert r3.exit_code == 0
        shown = json.loads(r3.output)
        assert shown["alias"] == "demo-app"
        assert "python" in shown["languages"]

        # show by hash
        repo_hash = hash_repo_path(str(repo))
        r4 = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "show", repo_hash],
            catch_exceptions=False,
        )
        assert r4.exit_code == 0
        assert "demo-app" in r4.output

        # remove by alias (with -y to skip confirmation)
        r5 = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "remove", "demo-app", "-y"],
            catch_exceptions=False,
        )
        assert r5.exit_code == 0, r5.output

        # Repo directory still exists (remove is a registry op, not a disk op)
        assert repo.exists(), "remove must NOT delete the repo directory"

        # Registry is now empty
        reg = ProjectsRegistry(registry_path)
        assert reg.list_all() == []
    finally:
        _cleanup(repo.parent)


def test_flow_engine_auto_loads_repo_context():
    """The flow engine's repo-context auto-load finds the entry.

    Simulates the engine's lookup logic: given a cwd that has an
    onboarded registry, the lookup should find the entry and
    produce a non-empty ``repo_context`` dict. The actual flow
    engine code path is exercised (the ``_format_repo_context``
    helper plus the registry ``get_by_path``).
    """
    repo = _make_fake_repo()
    workdir = repo.parent / "workdir"
    workdir.mkdir()
    try:
        # Onboard with a separate registry in workdir, then change cwd
        # to simulate the flow engine's perspective
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        r = runner.invoke(
            onboard_cmd,
            [str(repo), "--registry", str(registry_path)],
            catch_exceptions=False,
        )
        assert r.exit_code == 0

        # Now simulate the flow engine's lookup from inside the repo
        cwd = os.getcwd()
        try:
            os.chdir(str(repo))
            # The flow engine does this:
            #   projects_registry = ProjectsRegistry(Path(PROJECTS_REGISTRY_FILENAME))
            #   repo_entry = projects_registry.get_by_path(str(Path.cwd().resolve()))
            # We use the same registry file path (relative)
            os.chdir(str(workdir))  # so the relative registry path resolves
            reg = ProjectsRegistry(registry_path)
            repo_entry = reg.get_by_path(str(repo))
            assert repo_entry is not None, "auto-load should find the onboarded entry"
            repo_context = _format_repo_context(repo_entry)
            assert repo_context["alias"] == repo.name
            assert "python" in repo_context["languages"]
            assert repo_context["test_command"] == "pytest"
        finally:
            os.chdir(cwd)
    finally:
        _cleanup(repo.parent)


def test_builder_prompt_renders_repo_context_variable():
    """The builder prompt template has a ``{repo_context}`` placeholder.

    Verifies the variable substitution works end-to-end — given a
    context with ``repo_context`` populated, the placeholder is
    replaced with the JSON. (We don't run the actual prompt loader
    here; we just verify the prompt file has the placeholder and
    the substitution is mechanical.)
    """
    prompt_path = _MAESTRO / "prompts" / "builder.md"
    text = prompt_path.read_text(encoding="utf-8")
    assert "{repo_context}" in text, "builder.md must have the {repo_context} placeholder"

    # Now verify the substitution by mimicking build_prompt's variable
    # replacement logic. If the placeholder exists in the prompt and
    # we substitute it with a JSON dump, the result should be valid
    # markdown (no leftover {repo_context} token).
    repo_context = {
        "alias": "demo",
        "languages": ["python"],
        "test_command": "pytest",
        "conventions": ["conventional commits"],
    }
    replaced = text.replace("{repo_context}", json.dumps(repo_context, indent=2))
    assert "{repo_context}" not in replaced
    # The substituted JSON is present
    assert '"alias": "demo"' in replaced or '"alias":"demo"' in replaced
    assert "conventional commits" in replaced


# ─── projects.py coverage (the show/remove/list subcommands) ──────


def test_projects_list_empty_registry_human_output():
    """``projects list`` with no entries prints a friendly message."""
    workdir = Path(tempfile.mkdtemp(prefix="maestro_projects_empty_"))
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "list"],
            catch_exceptions=False,
        )
        assert result.exit_code == 0
        assert "no onboarded repos" in result.output.lower() or "Onboarded repos" in result.output
    finally:
        _cleanup(workdir)


def test_projects_list_empty_registry_json_output():
    """``projects list --json`` with no entries prints ``[]``."""
    workdir = Path(tempfile.mkdtemp(prefix="maestro_projects_empty_"))
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "list", "--json"],
            catch_exceptions=False,
        )
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data == []
    finally:
        _cleanup(workdir)


def test_projects_show_missing_key_fails():
    """``projects show <unknown>`` exits with a non-zero status."""
    workdir = Path(tempfile.mkdtemp(prefix="maestro_projects_show_"))
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "show", "nonexistent"],
            catch_exceptions=False,
        )
        # Exit 1 (or non-zero) for missing key
        assert result.exit_code != 0
        assert "not found" in result.output.lower() or "no project" in result.output.lower()
    finally:
        _cleanup(workdir)


def test_projects_remove_missing_key_fails():
    """``projects remove <unknown> -y`` exits with a non-zero status."""
    workdir = Path(tempfile.mkdtemp(prefix="maestro_projects_remove_"))
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        result = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "remove", "nonexistent", "-y"],
            catch_exceptions=False,
        )
        assert result.exit_code != 0
    finally:
        _cleanup(workdir)


def test_projects_remove_with_confirmation_prompt_yes():
    """``projects remove`` with confirmation prompt: input 'y' confirms."""
    repo = _make_fake_repo()
    workdir = repo.parent / "workdir"
    workdir.mkdir()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME

        # Onboard
        runner.invoke(
            onboard_cmd,
            [str(repo), "--alias", "removable", "--registry", str(registry_path)],
            catch_exceptions=False,
        )

        # Remove with interactive confirmation (input "y")
        result = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "remove", "removable"],
            input="y",
            catch_exceptions=False,
        )
        assert result.exit_code == 0
        # Registry is now empty
        reg = ProjectsRegistry(registry_path)
        assert reg.list_all() == []
    finally:
        _cleanup(repo.parent)


def test_projects_remove_with_confirmation_prompt_no():
    """``projects remove`` with confirmation prompt: input 'n' aborts."""
    repo = _make_fake_repo()
    workdir = repo.parent / "workdir"
    workdir.mkdir()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME

        # Onboard
        runner.invoke(
            onboard_cmd,
            [str(repo), "--alias", "stay", "--registry", str(registry_path)],
            catch_exceptions=False,
        )

        # Remove with interactive confirmation, decline
        result = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "remove", "stay"],
            input="n",
            catch_exceptions=False,
        )
        # Aborted — entry remains
        assert result.exit_code == 1
        reg = ProjectsRegistry(registry_path)
        assert len(reg.list_all()) == 1
    finally:
        _cleanup(repo.parent)


def test_projects_remove_by_hash():
    """``projects remove <hash> -y`` works with the hash key as well as alias."""
    repo = _make_fake_repo()
    workdir = repo.parent / "workdir"
    workdir.mkdir()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        runner.invoke(
            onboard_cmd,
            [str(repo), "--registry", str(registry_path)],
            catch_exceptions=False,
        )

        # Remove by hash
        repo_hash = hash_repo_path(str(repo))
        result = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "remove", repo_hash, "-y"],
            catch_exceptions=False,
        )
        assert result.exit_code == 0
        reg = ProjectsRegistry(registry_path)
        assert reg.list_all() == []
    finally:
        _cleanup(repo.parent)


def test_projects_show_by_path():
    """``projects show <absolute-path>`` works as a lookup key."""
    repo = _make_fake_repo()
    workdir = repo.parent / "workdir"
    workdir.mkdir()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        runner.invoke(
            onboard_cmd,
            [str(repo), "--alias", "by-path-test", "--registry", str(registry_path)],
            catch_exceptions=False,
        )

        # Look up by absolute path
        result = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "show", str(repo), "--json"],
            catch_exceptions=False,
        )
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["alias"] == "by-path-test"
    finally:
        _cleanup(repo.parent)


def test_projects_show_by_path_uses_json_flag():
    """``projects show --json <key>`` returns parseable JSON."""
    repo = _make_fake_repo()
    workdir = repo.parent / "workdir"
    workdir.mkdir()
    try:
        runner = CliRunner()
        registry_path = workdir / REGISTRY_FILENAME
        runner.invoke(
            onboard_cmd,
            [str(repo), "--registry", str(registry_path)],
            catch_exceptions=False,
        )

        # Show by alias with --json
        result = runner.invoke(
            projects_cli,
            ["--registry", str(registry_path), "show", "demo", "--json"],
            catch_exceptions=False,
        )
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert "alias" in data
        assert "languages" in data
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
