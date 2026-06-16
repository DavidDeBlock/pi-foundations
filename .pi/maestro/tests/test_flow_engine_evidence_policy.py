#!/usr/bin/env python3
"""
Unit tests for ``flow_engine.get_evidence_policy`` and the
``_close_phase_result`` edge case where ``required_on_success`` is
empty.

Covers the 4 AC-listed tests:

- ``test_get_evidence_policy_returns_defaults_when_absent``
- ``test_get_evidence_policy_merges_overrides``
- ``test_get_evidence_policy_handles_garbage_input``
- ``test_close_phase_with_empty_required_always_succeeds``

These are pure-function tests of the policy helpers in
:mod:`flow_engine`. The close-phase integration (with
:class:`EvidenceStore` and the three policies ``block``,
``warn_but_proceed``, ``ignore``) lives in ``test_run_flow.py``.

Run with: ``python3 tests/test_flow_engine_evidence_policy.py``
"""

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

from flow_engine import (  # noqa: E402
    DEFAULT_EVIDENCE_POLICY,
    get_evidence_policy,
)
from phase_runner import run_close_phase  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir() -> Path:
    """Return a fresh empty temp directory (caller cleans up)."""
    return Path(tempfile.mkdtemp(prefix="maestro_flow_engine_evidence_policy_test_"))


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir."""
    import shutil
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


# ─── Tests ──────────────────────────────────────────────────────────────


def test_get_evidence_policy_returns_defaults_when_absent():
    """A flow with no ``evidence_policy`` should get the safe defaults:
    ``on_missing_evidence == "warn_but_proceed"`` and
    ``required_on_success == ["tested", "reviewed"]``.
    """
    flow = {"name": "no-policy", "phases": {}}
    policy = get_evidence_policy(flow)
    assert policy["on_missing_evidence"] == "warn_but_proceed"
    assert "tested" in policy["required_on_success"]
    assert "reviewed" in policy["required_on_success"]
    # The defaults module constant is the source of truth — verify
    # the function mirrors it for an empty input.
    assert policy["required_on_success"] == DEFAULT_EVIDENCE_POLICY["required_on_success"]


def test_get_evidence_policy_merges_overrides():
    """Overrides in the flow's ``evidence_policy`` win over the defaults."""
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
    """Non-dict inputs / missing policy / wrong types → defaults.

    This is a real coverage gap — without it, a malformed flow
    config (e.g. a string where a dict was expected) could
    propagate through the close phase and crash with a confusing
    TypeError. The function must degrade gracefully to the safe
    defaults.
    """
    assert get_evidence_policy(None)["on_missing_evidence"] == "warn_but_proceed"
    assert get_evidence_policy({})["on_missing_evidence"] == "warn_but_proceed"
    assert get_evidence_policy({"evidence_policy": "not a dict"})["on_missing_evidence"] == "warn_but_proceed"
    assert get_evidence_policy({"evidence_policy": []})["on_missing_evidence"] == "warn_but_proceed"
    # The full policy dict should also be the defaults in each case
    assert get_evidence_policy(None) == DEFAULT_EVIDENCE_POLICY
    assert get_evidence_policy({}) == DEFAULT_EVIDENCE_POLICY


def test_close_phase_with_empty_required_always_succeeds():
    """A flow that requires no evidence should always pass the close phase,
    regardless of the ``on_missing_evidence`` policy.

    This is the edge case where the policy function's
    ``required_on_success == []`` propagates to
    :func:`_close_phase_result` and yields a trivial success.
    """
    d = _make_dir()
    try:
        flow = {
            "name": "no-required",
            "phases": {
                "close": {"is_local": True, "command": "x"},
            },
            "transitions": [],
            "evidence_policy": {
                "required_on_success": [],
                "on_missing_evidence": "block",  # strict policy, but moot here
            },
        }
        # Even with no evidence on disk and a "block" policy, an
        # empty required list should succeed.
        result = run_close_phase(flow, 42, evidence_dir=d)
        assert result["status"] == "success", (
            f"empty required + block policy: expected success, got {result}"
        )
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
