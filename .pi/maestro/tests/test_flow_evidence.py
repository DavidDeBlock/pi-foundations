#!/usr/bin/env python3
"""
Unit tests for the flow-engine integration with evidence gates.

Covers the 6 AC-listed tests:

- ``test_close_phase_succeeds_when_evidence_present``
- ``test_close_phase_rejected_when_evidence_missing_with_block_policy``
- ``test_close_phase_warns_when_missing_with_warn_policy``
- ``test_close_phase_skips_check_with_ignore_policy``
- ``test_test_runner_phase_auto_writes_evidence``
- ``test_evidence_survives_across_flow_restart``

The tests target :func:`flow_engine._close_phase_result` (the pure
function that applies the policy) and the ``EvidenceStore`` round-trip
behaviour. They do NOT spin up the full flow engine with an LLM in the
loop — that lives in ``test_integration_evidence_gates.py``.

Run with: ``python3 tests/test_flow_evidence.py``
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# ─── Path setup ──────────────────────────────────────────────────────────
#
# The flow engine lives one level up. Add both ``.pi/maestro`` and
# ``.pi/maestro/lib`` so the imports work regardless of cwd.

MAESTRO_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(MAESTRO_DIR))
sys.path.insert(0, str(MAESTRO_DIR / "lib"))

from evidence import (  # noqa: E402
    EvidenceStore,
    EvidenceType,
    make_reviewed_marker,
    make_tested_marker,
)
from flow_engine import (  # noqa: E402
    DEFAULT_EVIDENCE_POLICY,
    get_evidence_policy,
)
from phase_runner import run_close_phase  # noqa: E402  (issue #34: moved out of flow_engine)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir() -> Path:
    """Return a fresh empty temp directory (caller cleans up)."""
    return Path(tempfile.mkdtemp(prefix="maestro_flow_evidence_test_"))


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir."""
    import shutil
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


def _flow_config(evidence_policy: dict) -> dict:
    """Build a minimal flow config with the given evidence policy."""
    return {
        "name": "test-flow",
        "phases": {
            "builder": {"timeout_seconds": 60, "retries": 1},
            "close": {"is_local": True, "command": "x"},
        },
        "transitions": [],
        "evidence_policy": evidence_policy,
    }


# ─── Tests ──────────────────────────────────────────────────────────────


def test_close_phase_succeeds_when_evidence_present():
    """When all required markers are present and verified, the close
    phase returns ``success`` regardless of policy (block, warn, ignore)."""
    d = _make_dir()
    try:
        store = EvidenceStore(42, evidence_dir=d)
        store.write(make_tested_marker(42, "test", 0, 5, 5))
        store.write(make_reviewed_marker(42, 0, 0, "human"))

        for policy_name in ("block", "warn_but_proceed", "ignore"):
            flow = _flow_config({
                "required_on_success": ["tested", "reviewed"],
                "on_missing_evidence": policy_name,
            })
            result = run_close_phase(flow, 42, evidence_dir=d)
            assert result["status"] == "success", (
                f"policy={policy_name}: expected success, got {result}"
            )
            assert "All evidence present" in result["details"]
    finally:
        _cleanup(d)


def test_close_phase_rejected_when_evidence_missing_with_block_policy():
    """``block`` policy + missing evidence → ``reject`` (flow engine status)."""
    d = _make_dir()
    try:
        # No evidence written
        flow = _flow_config({
            "required_on_success": ["tested", "reviewed"],
            "on_missing_evidence": "block",
        })
        result = run_close_phase(flow, 42, evidence_dir=d)
        assert result["status"] == "reject"
        assert "Missing evidence" in result["details"]
        assert "block policy" in result["details"]
    finally:
        _cleanup(d)


def test_close_phase_warns_when_missing_with_warn_policy():
    """``warn_but_proceed`` policy + missing evidence → ``success`` (with warning)."""
    d = _make_dir()
    try:
        flow = _flow_config({
            "required_on_success": ["tested", "reviewed"],
            "on_missing_evidence": "warn_but_proceed",
        })
        result = run_close_phase(flow, 42, evidence_dir=d)
        assert result["status"] == "success"
        assert "warned" in result["details"].lower() or "missing" in result["details"].lower()
    finally:
        _cleanup(d)


def test_close_phase_skips_check_with_ignore_policy():
    """``ignore`` policy + missing evidence → ``success`` (no check)."""
    d = _make_dir()
    try:
        flow = _flow_config({
            "required_on_success": ["tested", "reviewed"],
            "on_missing_evidence": "ignore",
        })
        result = run_close_phase(flow, 42, evidence_dir=d)
        assert result["status"] == "success"
        assert "skipped" in result["details"].lower() or "ignore" in result["details"].lower()
    finally:
        _cleanup(d)


def test_test_runner_phase_auto_writes_evidence():
    """Verify the test_runner can call `maestro mark-tested` via subprocess
    and produce a valid evidence file (this is the agent-facing contract)."""
    d = _make_dir()
    try:
        # Invoke the CLI as a subprocess, just like the test_runner agent would
        result = subprocess.run(
            [
                sys.executable,
                str(MAESTRO_DIR / "maestro.py"),
                "mark-tested", "99",
                "--evidence-dir", str(d),
                "--command", "pnpm test --run",
                "--tests-run", "47",
                "--tests-passed", "47",
                "--exit-code", "0",
            ],
            capture_output=True,
            text=True,
            cwd=str(MAESTRO_DIR),
        )
        # Exit 0 because tests passed (verified=True)
        assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"

        # The evidence file should now exist and be readable
        store = EvidenceStore(99, evidence_dir=d)
        marker = store.read(EvidenceType.TESTED)
        assert marker is not None
        assert marker.verified is True
        assert marker.data["tests_passed"] == 47
        assert marker.data["exit_code"] == 0
    finally:
        _cleanup(d)


def test_evidence_survives_across_flow_restart():
    """Evidence written in one flow run should be readable by the next."""
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


# ─── Supporting tests for the policy / default helpers ───────────────────


def test_get_evidence_policy_returns_defaults_when_absent():
    """A flow with no evidence_policy should get the safe defaults."""
    flow = {"name": "no-policy", "phases": {}}
    policy = get_evidence_policy(flow)
    assert policy["on_missing_evidence"] == "warn_but_proceed"
    assert "tested" in policy["required_on_success"]
    assert "reviewed" in policy["required_on_success"]


def test_get_evidence_policy_merges_overrides():
    """Overrides in the flow's evidence_policy win over the defaults."""
    flow = {
        "name": "strict",
        "phases": {},
        "evidence_policy": {
            "on_missing_evidence": "block",
            "required_on_success": ["tested"],
        },
    }
    policy = get_evidence_policy(flow)
    assert policy["on_missing_evidence"] == "block"
    assert policy["required_on_success"] == ["tested"]


def test_get_evidence_policy_handles_garbage_input():
    """Non-dict inputs / missing policy / wrong types → defaults."""
    assert get_evidence_policy(None)["on_missing_evidence"] == "warn_but_proceed"
    assert get_evidence_policy({})["on_missing_evidence"] == "warn_but_proceed"
    assert get_evidence_policy({"evidence_policy": "not a dict"})["on_missing_evidence"] == "warn_but_proceed"
    assert get_evidence_policy({"evidence_policy": []})["on_missing_evidence"] == "warn_but_proceed"


def test_close_phase_with_empty_required_always_succeeds():
    """A flow that requires no evidence should always pass the close phase."""
    d = _make_dir()
    try:
        flow = _flow_config({
            "required_on_success": [],
            "on_missing_evidence": "block",
        })
        result = run_close_phase(flow, 42, evidence_dir=d)
        assert result["status"] == "success"
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
