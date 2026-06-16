#!/usr/bin/env python3
"""
Integration tests for evidence gates — end-to-end behaviour of the CLI
group + flow engine glue.

Covers the 4 AC-listed tests:

- ``test_end_to_end_pr_flow_with_evidence`` — full flow with test_runner
  + reviewer + close
- ``test_close_blocks_when_no_test_runner_phase`` — close phase rejects
  with missing ``tested`` evidence
- ``test_evidence_mismatch_causes_diagnostic_phase`` — tampered file
  triggers the ``block`` policy and the close phase transitions to
  ``rejected`` (which the flow config maps to ``diagnostic``)
- ``test_evidence_visible_in_retrospective`` — depends on the
  Retrospective slice (deferred); we mark it as a placeholder that
  asserts the evidence is at least readable post-flow

Plus supporting integration tests for the top-level ``maestro`` CLI
group, the nested ``evidence`` group's ``check`` / ``show`` subcommands,
and the ``mark-reviewed`` / ``mark-manual-tested`` flows.

Run with: ``python3 tests/test_integration_evidence_gates.py``
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
# Tests live in ``.pi/maestro/tests/``. We add the maestro root to the
# path so we can import the top-level ``maestro`` module + the click
# runner for fast in-process tests.

MAESTRO_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(MAESTRO_DIR))
sys.path.insert(0, str(MAESTRO_DIR / "lib"))

from click.testing import CliRunner  # noqa: E402

from maestro import maestro_cli  # noqa: E402

from evidence import (  # noqa: E402
    EvidenceStore,
    EvidenceType,
    make_reviewed_marker,
    make_tested_marker,
)
from phase_runner import run_close_phase  # noqa: E402  (issue #34: moved out of flow_engine)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir() -> Path:
    """Return a fresh empty temp directory (caller cleans up)."""
    return Path(tempfile.mkdtemp(prefix="maestro_eg_integ_test_"))


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir."""
    import shutil
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


def _run_cli(*args: str) -> "subprocess.CompletedProcess":
    """Invoke the top-level ``maestro.py`` CLI as a subprocess."""
    return subprocess.run(
        [sys.executable, str(MAESTRO_DIR / "maestro.py"), *args],
        capture_output=True,
        text=True,
        cwd=str(MAESTRO_DIR),
    )


# ─── AC Tests ────────────────────────────────────────────────────────────


def test_end_to_end_pr_flow_with_evidence():
    """Full PR flow: write tested + reviewed markers, then verify the
    close phase returns success."""
    d = _make_dir()
    try:
        # Simulate test_runner writing the tested marker via the CLI
        r1 = _run_cli(
            "mark-tested", "100",
            "--evidence-dir", str(d),
            "--command", "vitest run",
            "--tests-run", "20", "--tests-passed", "20", "--exit-code", "0",
        )
        assert r1.returncode == 0, f"mark-tested failed: {r1.stderr}"

        # Simulate reviewer writing the reviewed marker
        r2 = _run_cli(
            "mark-reviewed", "100",
            "--evidence-dir", str(d),
            "--critical", "0", "--non-blocking", "1", "--reviewer", "claude-sonnet",
        )
        assert r2.returncode == 0, f"mark-reviewed failed: {r2.stderr}"

        # Close phase should now succeed with the default policy
        flow = {
            "name": "test",
            "phases": {"close": {"is_local": True}},
            "transitions": [],
            "evidence_policy": {
                "required_on_success": ["tested", "reviewed"],
                "on_missing_evidence": "warn_but_proceed",
            },
        }
        result = run_close_phase(flow, 100, evidence_dir=d)
        assert result["status"] == "success"
        assert "All evidence present" in result["details"]
    finally:
        _cleanup(d)


def test_close_blocks_when_no_test_runner_phase():
    """If the test_runner phase didn't run, the close phase rejects when
    policy is ``block`` — preventing a PR flow from succeeding without
    verified test output."""
    d = _make_dir()
    try:
        # No markers written — simulate a flow that skipped test_runner
        flow = {
            "name": "strict",
            "phases": {"close": {"is_local": True}},
            "transitions": [],
            "evidence_policy": {
                "required_on_success": ["tested", "reviewed"],
                "on_missing_evidence": "block",
            },
        }
        result = run_close_phase(flow, 42, evidence_dir=d)
        assert result["status"] == "reject"
        assert "Missing evidence" in result["details"]
        assert "tested" in result["details"]
    finally:
        _cleanup(d)


def test_evidence_mismatch_causes_diagnostic_phase():
    """A tampered evidence file is treated as missing under the ``block``
    policy → close phase rejects → the flow config's transition routes
    ``rejected`` to ``diagnostic``."""
    d = _make_dir()
    try:
        # Write a valid marker
        store = EvidenceStore(50, evidence_dir=d)
        store.write(make_tested_marker(50, "test", 0, 10, 10))

        # Tamper with the data field (change tests_passed) but leave the
        # hash stale — simulates a buggy consumer that overwrote the file
        # without re-computing the hash.
        path = store.path_for(EvidenceType.TESTED)
        data = json.loads(path.read_text())
        data["data"]["tests_passed"] = 1
        path.write_text(json.dumps(data, indent=2))

        # With block policy, this should reject
        flow = {
            "name": "strict",
            "phases": {"close": {"is_local": True}},
            "transitions": [
                {
                    "from": "close",
                    "on_success": "finish",
                    "on_reject": "diagnostic",
                    "on_error": "diagnostic",
                }
            ],
            "evidence_policy": {
                "required_on_success": ["tested", "reviewed"],
                "on_missing_evidence": "block",
            },
        }
        result = run_close_phase(flow, 50, evidence_dir=d)
        assert result["status"] == "reject"

        # The flow's transition would route "reject" to "diagnostic"
        # (verified below by inspecting the flow config)
        from flow_engine import get_next_step
        next_step = get_next_step(flow["transitions"], "close", "reject")
        assert next_step == "diagnostic"
    finally:
        _cleanup(d)


def test_evidence_visible_in_retrospective():
    """Evidence markers are on disk and readable post-flow (deferred
    full retrospective integration is a separate slice; for now we
    assert the evidence is at least discoverable)."""
    d = _make_dir()
    try:
        store = EvidenceStore(75, evidence_dir=d)
        store.write(make_tested_marker(75, "test", 0, 5, 5))
        store.write(make_reviewed_marker(75, 0, 2, "claude-sonnet"))

        # The retrospective phase would read these via EvidenceStore
        markers = {
            t: store.read(t) for t in (EvidenceType.TESTED, EvidenceType.REVIEWED)
        }
        assert markers[EvidenceType.TESTED] is not None
        assert markers[EvidenceType.REVIEWED] is not None

        # And via the CLI's `maestro evidence show` command
        result = _run_cli("evidence", "show", "75", "--evidence-dir", str(d))
        assert result.returncode == 0
        assert "tested" in result.stdout
        assert "reviewed" in result.stdout
        assert "verified" in result.stdout or "UNVERIFIED" not in result.stdout
    finally:
        _cleanup(d)


# ─── Supporting tests: top-level CLI group + nested ``evidence`` group ───


def test_top_level_help_lists_mark_commands():
    """``maestro --help`` must list the new mark-tested / mark-reviewed /
    mark-manual-tested commands and the nested ``evidence`` group."""
    runner = CliRunner()
    result = runner.invoke(maestro_cli, ["--help"])
    assert result.exit_code == 0
    for name in ("mark-tested", "mark-reviewed", "mark-manual-tested", "evidence"):
        assert name in result.output, f"Missing '{name}' in --help output"


def test_top_level_mark_tested_in_process():
    """``maestro mark-tested`` works via the in-process Click runner."""
    d = _make_dir()
    try:
        runner = CliRunner()
        result = runner.invoke(
            maestro_cli,
            [
                "mark-tested", "5",
                "--evidence-dir", str(d),
                "--command", "pytest",
                "--tests-run", "3", "--tests-passed", "3", "--exit-code", "0",
            ],
        )
        assert result.exit_code == 0, result.output
        assert "Wrote tested evidence" in result.output
        # File should be on disk
        assert (d / "5" / "tested.json").exists()
    finally:
        _cleanup(d)


def test_top_level_mark_tested_exit_code_on_unverified():
    """``maestro mark-tested`` with failing tests should exit non-zero."""
    d = _make_dir()
    try:
        runner = CliRunner()
        result = runner.invoke(
            maestro_cli,
            [
                "mark-tested", "6",
                "--evidence-dir", str(d),
                "--command", "pytest",
                "--tests-run", "3", "--tests-passed", "1", "--exit-code", "1",
            ],
        )
        # Exit 1 because verified=False (exit_code != 0)
        assert result.exit_code == 1, result.output
        assert "verified=False" in result.output or "✗" in result.output
    finally:
        _cleanup(d)


def test_nested_evidence_check_exits_zero_when_present():
    """``maestro evidence check 7 --required tested`` exits 0 when marker present."""
    d = _make_dir()
    try:
        # Write the marker
        store = EvidenceStore(7, evidence_dir=d)
        store.write(make_tested_marker(7, "x", 0, 1, 1))

        runner = CliRunner()
        result = runner.invoke(
            maestro_cli,
            [
                "evidence", "check", "7",
                "--evidence-dir", str(d),
                "--required", "tested",
            ],
        )
        assert result.exit_code == 0, result.output
        assert "All required evidence present" in result.output
    finally:
        _cleanup(d)


def test_nested_evidence_check_exits_one_when_missing():
    """``maestro evidence check 8 --required tested`` exits 1 when marker missing."""
    d = _make_dir()
    try:
        runner = CliRunner()
        result = runner.invoke(
            maestro_cli,
            [
                "evidence", "check", "8",
                "--evidence-dir", str(d),
                "--required", "tested",
            ],
        )
        assert result.exit_code == 1, result.output
        assert "Missing evidence" in result.output
    finally:
        _cleanup(d)


def test_nested_evidence_check_default_required():
    """``maestro evidence check 9`` (no --required) defaults to tested + reviewed."""
    d = _make_dir()
    try:
        # Write only tested, not reviewed
        store = EvidenceStore(9, evidence_dir=d)
        store.write(make_tested_marker(9, "x", 0, 1, 1))

        runner = CliRunner()
        result = runner.invoke(
            maestro_cli,
            ["evidence", "check", "9", "--evidence-dir", str(d)],
        )
        # Default is tested + reviewed, only tested is present → should fail
        assert result.exit_code == 1
        assert "reviewed" in result.output
    finally:
        _cleanup(d)


def test_nested_evidence_show_pretty():
    """``maestro evidence show`` pretty-prints all marker statuses."""
    d = _make_dir()
    try:
        store = EvidenceStore(11, evidence_dir=d)
        store.write(make_tested_marker(11, "x", 0, 5, 5))
        # Don't write reviewed — should show as (missing)

        runner = CliRunner()
        result = runner.invoke(
            maestro_cli,
            ["evidence", "show", "11", "--evidence-dir", str(d)],
        )
        assert result.exit_code == 0
        assert "tested" in result.output
        assert "reviewed" in result.output
        assert "(missing)" in result.output  # reviewed not yet written
    finally:
        _cleanup(d)


def test_nested_evidence_show_json():
    """``maestro evidence show --json`` outputs a dict of marker → payload."""
    d = _make_dir()
    try:
        store = EvidenceStore(12, evidence_dir=d)
        store.write(make_tested_marker(12, "x", 0, 5, 5))

        runner = CliRunner()
        result = runner.invoke(
            maestro_cli,
            ["evidence", "show", "12", "--evidence-dir", str(d), "--json"],
        )
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["tested"] is not None
        assert data["tested"]["verified"] is True
        assert data["reviewed"] is None
        assert data["manual_tested"] is None
    finally:
        _cleanup(d)


def test_mark_reviewed_creates_marker():
    """``maestro mark-reviewed`` writes the reviewed.json marker correctly."""
    d = _make_dir()
    try:
        runner = CliRunner()
        result = runner.invoke(
            maestro_cli,
            [
                "mark-reviewed", "20",
                "--evidence-dir", str(d),
                "--critical", "0", "--non-blocking", "3", "--reviewer", "human",
            ],
        )
        assert result.exit_code == 0
        store = EvidenceStore(20, evidence_dir=d)
        marker = store.read(EvidenceType.REVIEWED)
        assert marker is not None
        assert marker.verified is True
        assert marker.data["non_blocking_issues"] == 3
        assert marker.data["reviewer"] == "human"
    finally:
        _cleanup(d)


def test_mark_manual_tested_creates_marker():
    """``maestro mark-manual-tested`` writes the manual_tested.json marker."""
    d = _make_dir()
    try:
        runner = CliRunner()
        result = runner.invoke(
            maestro_cli,
            [
                "mark-manual-tested", "21",
                "--evidence-dir", str(d),
                "--scenario", "user can log in",
                "--verified-by", "playwright",
            ],
        )
        assert result.exit_code == 0
        store = EvidenceStore(21, evidence_dir=d)
        marker = store.read(EvidenceType.MANUAL_TESTED)
        assert marker is not None
        assert marker.verified is True
        assert marker.data["scenario"] == "user can log in"
        assert marker.data["verified_by"] == "playwright"
    finally:
        _cleanup(d)


def test_prompt_validate_accepts_empty_tools_for_is_local():
    """The ``maestro prompt validate`` validator must NOT reject the
    ``close`` phase's empty tools list, because the phase is
    ``is_local: true`` (no LLM, no tools needed)."""
    runner = CliRunner()
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        flow_path = tmp / "flow-with-close.json"
        flow_path.write_text(
            json.dumps({
                "name": "test",
                "phases": {
                    "close": {
                        "is_local": True,
                        "command": "x",
                    }
                }
            })
        )
        result = runner.invoke(
            maestro_cli,
            ["prompt", "validate", str(flow_path)],
        )
        # Should NOT report "empty tool list" as an error
        assert "empty tool list" not in result.output, result.output
        assert result.exit_code == 0, result.output


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
