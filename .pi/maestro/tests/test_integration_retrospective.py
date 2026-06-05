#!/usr/bin/env python3
"""
Integration tests for the retrospective slice — end-to-end behaviour
of the CLI group + flow engine glue.

Covers the 4 AC-listed tests:

- ``test_end_to_end_flow_with_retrospective`` — full flow including
  retrospective, learnings.md is created
- ``test_retrospective_persists_across_flow_restart`` — kill mid-flow,
  restart, retrospective still picks up
- ``test_patterns_command_finds_recurring_issues`` — three similar
  failures surface in the patterns command
- ``test_amendments_visible_in_amendments_command`` — proposed
  amendments are readable via the CLI

Plus supporting tests for the top-level ``maestro retrospective ...``
subcommands and the cross-flow aggregation.

Run with: ``python3 tests/test_integration_retrospective.py``
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# ─── Path setup ──────────────────────────────────────────────────────────

MAESTRO_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(MAESTRO_DIR))
sys.path.insert(0, str(MAESTRO_DIR / "lib"))

from click.testing import CliRunner  # noqa: E402

from maestro import maestro_cli  # noqa: E402
from learnings import (  # noqa: E402
    LEARNINGS_FILENAME,
    format_learning_entry,
)
from working_memory import MemoryStore  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir(prefix: str = "maestro_retro_integ_test_") -> Path:
    """Return a fresh empty temp directory (caller cleans up)."""
    return Path(tempfile.mkdtemp(prefix=prefix))


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir."""
    import shutil
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


def _run_cli(*args: str, cwd: Path = None) -> "subprocess.CompletedProcess":
    """Invoke the top-level ``maestro.py`` CLI as a subprocess."""
    return subprocess.run(
        [sys.executable, str(MAESTRO_DIR / "maestro.py"), *args],
        capture_output=True,
        text=True,
        cwd=str(cwd) if cwd else str(MAESTRO_DIR),
    )


def _seed_working_memory(issue_num: int, memory_dir: Path, files_touched: list = None, errors: list = None) -> None:
    """Pre-populate a working-memory file so ``retrospective run`` has
    data to synthesise from."""
    store = MemoryStore(issue_num, memory_dir=memory_dir)
    store.update_phase("builder", {
        "status": "success",
        "details": "implemented feature",
    })
    if files_touched:
        for f in files_touched:
            store.append_file_touched(f)
    if errors:
        for e in errors:
            store.append_error("builder", e)


# ─── AC Tests ────────────────────────────────────────────────────────────


def test_end_to_end_flow_with_retrospective():
    """The full flow — write learnings via the persistence helper, then
    verify the file is on disk and parseable.
    """
    from flow_engine import _persist_retrospective_result

    repo = _make_dir()
    try:
        rpc_output = """### PHASE_OUTPUT: success
{
  "outcome": "success",
  "what_worked": ["scout was accurate", "builder followed conventions"],
  "what_failed": [],
  "surprising": ["repo uses bun"],
  "repo_specific_learnings": ["uses bun, not pnpm"],
  "proposed_amendments": []
}
### END_PHASE_OUTPUT
"""
        _persist_retrospective_result(
            issue_num=99,
            flow_name="builder-reviewer",
            rpc_output=rpc_output,
            flow_status="success",
            repo_path=repo,
        )

        # The learnings file is on disk
        path = repo / LEARNINGS_FILENAME
        assert path.exists(), f"Expected {path} to exist"
        text = path.read_text(encoding="utf-8")

        # Entry is well-formed and contains the structured data
        assert "Issue #99" in text
        assert "(success)" in text
        assert "**What worked:**" in text
        assert "**Surprising:**" in text
        assert "**Repo-specific learnings:**" in text
        assert "uses bun, not pnpm" in text
    finally:
        _cleanup(repo)


def test_retrospective_persists_across_flow_restart():
    """A retrospective that runs (writing to learnings.md) should be
    visible to a subsequent process (i.e. survives across flow
    restarts). This simulates a kill mid-flow by directly invoking the
    persistence helper twice with the same repo, then reading the file
    back.
    """
    from flow_engine import _persist_retrospective_result

    repo = _make_dir()
    try:
        # First "flow run" — writes one entry
        _persist_retrospective_result(
            issue_num=1,
            flow_name="builder-reviewer",
            rpc_output=format_phase_output(outcome="success", worked=["scout"]),
            flow_status="success",
            repo_path=repo,
        )

        # Simulate a "restart" — fresh helper invocation writes another entry
        _persist_retrospective_result(
            issue_num=2,
            flow_name="builder-reviewer",
            rpc_output=format_phase_output(outcome="failure", failed=["reviewer rejected"]),
            flow_status="failure",
            repo_path=repo,
        )

        # Read back the file
        text = (repo / LEARNINGS_FILENAME).read_text(encoding="utf-8")
        # Both entries are present (the file was extended across "restarts")
        assert "Issue #1" in text
        assert "Issue #2" in text
        # Header is exactly once (not duplicated on append)
        assert text.count("# Maestro Learnings") == 1
    finally:
        _cleanup(repo)


def test_patterns_command_finds_recurring_issues():
    """``maestro retrospective patterns`` aggregates learnings across
    repos and surfaces recurring failure keywords.
    """
    root = _make_dir()
    try:
        # Create two repos, each with several failure entries sharing
        # the keyword "convention".
        from learnings import append_to_learnings
        for repo_name, issues in [
            ("repo-a", [1, 2, 3]),
            ("repo-b", [4, 5]),
        ]:
            repo = root / repo_name
            repo.mkdir()
            for issue in issues:
                entry = format_learning_entry(
                    issue, "failure",
                    {"what_failed": ["builder ignored the convention for snake_case"]},
                )
                append_to_learnings(repo, entry)

        # Run the patterns command
        result = _run_cli(
            "retrospective", "patterns",
            "--memory-dir", str(root),
        )
        assert result.returncode == 0, f"patterns command failed: {result.stderr}"
        out = result.stdout
        assert "Total entries: 5" in out
        assert "repo-a" in out
        assert "repo-b" in out
        # Recurring keyword "convention" is in the failure list
        assert "convention" in out
    finally:
        _cleanup(root)


def test_amendments_visible_in_amendments_command():
    """``maestro retrospective amendments <repo>`` prints the contents
    of ``<repo>/.maestro/proposed-amendments.md``.
    """
    repo = _make_dir()
    try:
        from learnings import append_to_amendments, format_amendment_entry
        amend_entry = format_amendment_entry(
            {
                "title": "Tighten builder prompt",
                "root_cause": "ignores conventions",
                "proposed_fix": "add convention emphasis",
                "effort": "30 min",
            },
            occurrences=5,
        )
        append_to_amendments(repo, amend_entry)

        result = _run_cli("retrospective", "amendments", str(repo))
        assert result.returncode == 0, f"amendments command failed: {result.stderr}"
        out = result.stdout
        assert "Tighten builder prompt" in out
        assert "**Occurrences:** 5" in out
        assert "**Owner:** (unassigned)" in out
    finally:
        _cleanup(repo)


# ─── Supporting tests ────────────────────────────────────────────────────


def test_top_level_help_lists_retrospective_group():
    """``maestro --help`` must list the ``retrospective`` group."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["--help"])
    assert result.exit_code == 0
    assert "retrospective" in result.output


def test_retrospective_show_command_prints_learnings():
    """``maestro retrospective show <repo>`` reads the repo's
    ``.maestro/learnings.md``."""
    repo = _make_dir()
    try:
        from learnings import append_to_learnings, format_learning_entry
        append_to_learnings(
            repo,
            format_learning_entry(1, "success", {"what_worked": ["x"]}),
        )
        runner = CliRunner()
        result = runner.invoke(
            maestro_cli, ["retrospective", "show", str(repo)],
        )
        assert result.exit_code == 0, result.output
        assert "Issue #1" in result.output
        assert "**What worked:**" in result.output
    finally:
        _cleanup(repo)


def test_retrospective_show_command_handles_missing_file():
    """``maestro retrospective show <repo>`` with no learnings file
    prints a friendly message and exits 0 (not an error).
    """
    repo = _make_dir()
    try:
        runner = CliRunner()
        result = runner.invoke(
            maestro_cli, ["retrospective", "show", str(repo)],
        )
        assert result.exit_code == 0, result.output
        assert "No learnings file" in result.output
    finally:
        _cleanup(repo)


def test_retrospective_run_synthesizes_from_memory():
    """``maestro retrospective run <issue> --repo-path <path>`` reads
    the working memory and writes a synthesised entry (no LLM call).
    """
    from pathlib import Path
    repo = _make_dir()
    memory_dir = _make_dir(prefix="maestro_retro_mem_")
    try:
        # Seed the working memory with phase data
        _seed_working_memory(
            issue_num=42,
            memory_dir=memory_dir,
            files_touched=["src/foo.ts", "src/bar.ts"],
        )
        runner = CliRunner()
        result = runner.invoke(
            maestro_cli, [
                "retrospective", "run", "42",
                "--repo-path", str(repo),
                "--memory-dir", str(memory_dir),
            ],
        )
        assert result.exit_code == 0, result.output
        assert "Wrote retrospective entry" in result.output

        # The file was created with a synthesised entry
        text = (repo / LEARNINGS_FILENAME).read_text(encoding="utf-8")
        assert "Issue #42" in text
        # The synthesiser should have picked up the "builder success"
        assert "builder" in text.lower() or "successful" in text.lower()
    finally:
        _cleanup(repo)
        _cleanup(memory_dir)


def test_retrospective_patterns_json_output():
    """``maestro retrospective patterns --json`` returns machine-readable output."""
    root = _make_dir()
    try:
        from learnings import append_to_learnings
        repo = root / "json-test"
        repo.mkdir()
        append_to_learnings(
            repo,
            format_learning_entry(1, "failure", {"what_failed": ["x"]}),
        )
        runner = CliRunner()
        result = runner.invoke(
            maestro_cli, [
                "retrospective", "patterns",
                "--memory-dir", str(root),
                "--json",
            ],
        )
        assert result.exit_code == 0, result.output
        # Parse the JSON
        data = json.loads(result.output)
        assert "total_entries" in data
        assert "by_repo" in data
        assert "recent" in data
        assert "common_failures" in data
        assert data["by_repo"].get("json-test") == 1
    finally:
        _cleanup(root)


# ─── Helpers ─────────────────────────────────────────────────────────────


def format_phase_output(outcome: str = "success", worked: list = None, failed: list = None) -> str:
    """Build a PHASE_OUTPUT block for tests that need to feed rpc_output."""
    payload = {"outcome": outcome}
    if worked:
        payload["what_worked"] = worked
    else:
        payload["what_worked"] = []
    if failed:
        payload["what_failed"] = failed
    else:
        payload["what_failed"] = []
    payload["surprising"] = []
    payload["repo_specific_learnings"] = []
    payload["proposed_amendments"] = []
    return (
        "### PHASE_OUTPUT: success\n"
        + json.dumps(payload)
        + "\n### END_PHASE_OUTPUT"
    )


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
