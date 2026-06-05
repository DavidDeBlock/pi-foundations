#!/usr/bin/env python3
"""
Unit tests for the top-level ``maestro`` CLI entry point.

The top-level entry point is ``.pi/maestro/maestro.py`` and exposes a Click
group with three subcommand groups:

  - ``maestro memory ...`` (mounted from ``commands/memory.py``)
  - ``maestro scout  ...`` (mounted from ``commands/scout.py``)
  - ``maestro prompt ...`` (mounted from ``commands/prompt.py`` — new)

Covers:
  - ``maestro --help`` lists all three subcommand groups
  - ``maestro memory list`` / ``maestro memory show`` work via top-level bin
  - ``maestro scout  list`` / ``maestro scout  show`` work via top-level bin
  - ``maestro prompt validate`` works on a known-good flow
  - ``maestro prompt validate`` reports errors (non-zero exit) on a bad flow
  - ``--memory-dir`` option propagates through nested groups
  - Backward compat: ``python3 -m commands.memory`` and ``python3 -m commands.scout``
    still work (the existing programmatic entry points)

Run with: ``python3 tests/test_maestro_cli.py``
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# ─── Path setup ──────────────────────────────────────────────────────────
#
# The top-level entry point lives at ``.pi/maestro/maestro.py``. To import
# it, we add its parent directory to sys.path. The same path manipulation
# is performed by the script itself, so this mirrors the runtime layout.
MAESTRO_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(MAESTRO_DIR))           # so `import maestro` works
sys.path.insert(0, str(MAESTRO_DIR / "lib"))   # so `from working_memory import ...` works

import click  # noqa: E402
from click.testing import CliRunner  # noqa: E402

from maestro import maestro_cli  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir() -> Path:
    """Return a fresh empty temp directory (caller cleans up)."""
    return Path(tempfile.mkdtemp(prefix="maestro_cli_test_"))


def _write_flow(tmp: Path, name: str, phases: dict) -> Path:
    """Write a flow JSON file to ``tmp/<name>.json`` and return the path."""
    flow_path = tmp / f"{name}.json"
    flow_path.write_text(json.dumps({"phases": phases}), encoding="utf-8")
    return flow_path


# ─── Tests ───────────────────────────────────────────────────────────────


def test_maestro_help_lists_subcommand_groups():
    """``maestro --help`` must list memory, scout, and prompt groups."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["--help"])
    assert result.exit_code == 0, result.output
    assert "memory" in result.output
    assert "scout" in result.output
    assert "prompt" in result.output


def test_maestro_memory_help_lists_subcommands():
    """``maestro memory --help`` must list show / list / clear subcommands."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["memory", "--help"])
    assert result.exit_code == 0, result.output
    assert "show" in result.output
    assert "list" in result.output
    assert "clear" in result.output


def test_maestro_scout_help_lists_subcommands():
    """``maestro scout --help`` must list show / list subcommands."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["scout", "--help"])
    assert result.exit_code == 0, result.output
    assert "show" in result.output
    assert "list" in result.output


def test_maestro_prompt_help_lists_subcommands():
    """``maestro prompt --help`` must list validate subcommand."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["prompt", "--help"])
    assert result.exit_code == 0, result.output
    assert "validate" in result.output


def test_maestro_memory_list_against_empty_dir():
    """``maestro memory list --memory-dir <empty>`` should succeed gracefully."""
    runner = CliRunner()
    with runner.isolated_filesystem():
        empty = Path("empty").resolve()
        empty.mkdir()
        result = runner.invoke(maestro_cli, ["memory", "--memory-dir", str(empty), "list"])
    assert result.exit_code == 0, result.output
    assert "No working memory files found" in result.output


def test_maestro_memory_list_json_against_empty_dir():
    """``maestro memory list --json --memory-dir <empty>`` outputs ``[]``."""
    runner = CliRunner()
    with runner.isolated_filesystem():
        empty = Path("empty").resolve()
        empty.mkdir()
        result = runner.invoke(
            maestro_cli,
            ["memory", "--memory-dir", str(empty), "list", "--json"],
        )
    assert result.exit_code == 0, result.output
    assert result.output.strip() == "[]"


def test_maestro_memory_show_against_missing_file():
    """``maestro memory show <missing>`` should succeed and print empty markdown."""
    runner = CliRunner()
    with runner.isolated_filesystem():
        empty = Path("empty").resolve()
        empty.mkdir()
        result = runner.invoke(
            maestro_cli,
            ["memory", "--memory-dir", str(empty), "show", "99"],
        )
    # Should exit 0 — the CLI shows an empty memory rather than erroring.
    assert result.exit_code == 0, result.output
    assert "99" in result.output or "Working Memory" in result.output


def test_maestro_scout_list_against_empty_dir():
    """``maestro scout list --memory-dir <empty>`` should succeed gracefully."""
    runner = CliRunner()
    with runner.isolated_filesystem():
        empty = Path("empty").resolve()
        empty.mkdir()
        result = runner.invoke(maestro_cli, ["scout", "--memory-dir", str(empty), "list"])
    assert result.exit_code == 0, result.output
    assert "No working memory directory" in result.output or "No working memory" in result.output


def test_maestro_scout_show_against_missing_file():
    """``maestro scout show <missing>`` should succeed and say 'no findings'."""
    runner = CliRunner()
    with runner.isolated_filesystem():
        empty = Path("empty").resolve()
        empty.mkdir()
        result = runner.invoke(
            maestro_cli,
            ["scout", "--memory-dir", str(empty), "show", "99"],
        )
    # Should exit 0 with a helpful message; scout never blocks.
    assert result.exit_code == 0, result.output
    assert "scout" in result.output.lower() or "99" in result.output


def test_maestro_prompt_validate_against_known_good_flow():
    """``maestro prompt validate`` should exit 0 on a well-formed flow."""
    runner = CliRunner()
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        # All phases reference real .md prompts in the project's prompts/ dir
        # (defaults are registered for these in lib/prompt_loader.py).
        flow_path = _write_flow(tmp, "good", {
            "builder": {"timeout_seconds": 60},
            "reviewer": {"timeout_seconds": 60},
        })
        result = runner.invoke(maestro_cli, ["prompt", "validate", str(flow_path)])
    assert result.exit_code == 0, result.output
    assert "all phases have valid tool sets" in result.output


def test_maestro_prompt_validate_reports_errors_on_bad_flow():
    """``maestro prompt validate`` should exit 1 on an invalid flow."""
    runner = CliRunner()
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        # No `phases` key — validation should fail.
        flow_path = tmp / "bad.json"
        flow_path.write_text(json.dumps({"name": "missing-phases"}), encoding="utf-8")
        result = runner.invoke(maestro_cli, ["prompt", "validate", str(flow_path)])
    assert result.exit_code == 1, result.output
    assert "phases" in result.output.lower() or "error" in result.output.lower()


def test_maestro_prompt_validate_handles_missing_file():
    """``maestro prompt validate <missing>`` should report a clear error."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["prompt", "validate", "/nonexistent/flow.json"])
    assert result.exit_code == 1, result.output
    assert "not found" in result.output.lower() or "error" in result.output.lower()


def test_python_m_commands_memory_still_works():
    """Backward-compat: ``python3 -m commands.memory --help`` must still work."""
    result = subprocess.run(
        [sys.executable, "-m", "commands.memory", "--help"],
        cwd=str(MAESTRO_DIR),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "show" in result.stdout
    assert "list" in result.stdout
    assert "clear" in result.stdout


def test_python_m_commands_scout_still_works():
    """Backward-compat: ``python3 -m commands.scout --help`` must still work."""
    result = subprocess.run(
        [sys.executable, "-m", "commands.scout", "--help"],
        cwd=str(MAESTRO_DIR),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "show" in result.stdout
    assert "list" in result.stdout


def test_top_level_script_works_via_subprocess():
    """The top-level entry point should be invokable as a Python script."""
    result = subprocess.run(
        [sys.executable, str(MAESTRO_DIR / "maestro.py"), "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "memory" in result.stdout
    assert "scout" in result.stdout
    assert "prompt" in result.stdout


# ─── Runner ──────────────────────────────────────────────────────────────


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
