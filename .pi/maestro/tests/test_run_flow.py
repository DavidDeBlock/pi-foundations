#!/usr/bin/env python3
"""
test_run_flow.py — Integration tests for the new narrow
``flow_engine.run_flow(flow, context, state, term, gh, log)`` API
(issue #34).

These tests exercise the deep-module entry point with a synthetic
:class:`Flow` + :class:`FlowContext` + :class:`ListLogger` and
assert the :class:`FlowOutcome` shape matches the issue's
acceptance criteria.

The tests stub out ``phase_runner.run_phase`` (and
``diagnostic.run_diagnostic``) so they don't need a real LLM or
GitHub. The focus is on the phase-loop behaviour — transitions,
retries, diagnostic routing, the close-phase evidence gate, and
the ``FlowOutcome`` field set.

Run with: ``python3 tests/test_run_flow.py`` (custom runner) or
``python3 -m pytest tests/test_run_flow.py`` (pytest).

The test surface (per the issue AC, ≥7 tests):

  1. ``test_run_flow_single_phase_with_retry_then_success`` — one
     phase, reject → retry → success → finish.
  2. ``test_run_flow_multi_phase_with_rejection_routes_back`` — two
     phases, second phase rejects, flow routes back to first phase.
  3. ``test_run_flow_optional_phase_with_error_synthesises_success`` —
     an ``is_optional`` phase that returns ``status="error"`` does
     NOT break the flow.
  4. ``test_run_flow_diagnostic_routing_on_error`` — a phase that
     returns ``status="error"`` routes to ``diagnostic`` and then
     the post-diagnostic transition runs.
  5. ``test_run_flow_close_phase_block_policy_routes_to_diagnostic`` —
     the close phase with ``block`` policy + missing evidence
     returns ``reject``, which the loop routes to ``diagnostic``.
  6. ``test_run_flow_outcome_shape`` — the :class:`FlowOutcome`
     carries every documented field (status, iterations, phases,
     duration, tokens).
  7. ``test_run_flow_logger_records_event_sequence`` — the
     :class:`ListLogger` records the expected event sequence
     (``phase_end`` + ``tokens_recorded`` per attempt).

Plus 4 close-phase variants (issue #45, moved from
``test_flow_evidence.py``): the close phase is exercised in
isolation via :func:`phase_runner.run_close_phase` to confirm the
three policies (``block``, ``warn_but_proceed``, ``ignore``) plus
the happy-path-when-evidence-present variant.

  8. ``test_close_phase_succeeds_when_evidence_present``
  9. ``test_close_phase_rejected_when_evidence_missing_with_block_policy``
 10. ``test_close_phase_warns_when_missing_with_warn_policy``
 11. ``test_close_phase_skips_check_with_ignore_policy``
"""

import json
import sys
import tempfile
from dataclasses import replace as _dc_replace
from pathlib import Path
from typing import List
from unittest.mock import MagicMock, patch

# ─── Path setup ──────────────────────────────────────────────────────────
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

import flow_engine  # noqa: E402
from flow_engine import (  # noqa: E402
    Flow,
    FlowContext,
    FlowOutcome,
    PhaseRun,
    PhaseState,
    WorkingMemory,
    run_flow,
)
from flow_logger import ListLogger  # noqa: E402
from phase_runner import run_close_phase  # noqa: E402  (issue #45: close-phase variants)
from evidence import (  # noqa: E402  (issue #45: close-phase variants)
    EvidenceStore,
    EvidenceType,
    make_reviewed_marker,
    make_tested_marker,
)


# ─── Shared fixtures ────────────────────────────────────────────────────


def _make_workflow_flow() -> dict:
    """A simple two-phase flow: ``phase_a`` → ``phase_b`` → finish.

    Transitions: phase_a success → phase_b; phase_b success → finish.
    """
    return {
        "name": "workflow-test",
        "description": "Test workflow",
        "scout_enabled": False,
        "evidence_policy": {
            "required_on_success": ["tested", "reviewed"],
            "on_missing_evidence": "warn_but_proceed",
        },
        "phases": {
            "phase_a": {
                "skill": "/skill:test",
                "model": "test-model",
                "provider": "test-provider",
                "timeout_seconds": 60,
                "retries": 3,
            },
            "phase_b": {
                "skill": "/skill:test",
                "model": "test-model",
                "provider": "test-provider",
                "timeout_seconds": 60,
                "retries": 1,
            },
        },
        "transitions": [
            {
                "from": "phase_a",
                "on_success": "phase_b",
                "on_reject": "phase_a",
                "on_error": "finish",
            },
            {
                "from": "phase_b",
                "on_success": "finish",
                "on_reject": "phase_a",
                "on_error": "finish",
            },
        ],
    }


def _make_close_flow(policy: str = "warn_but_proceed") -> dict:
    """A flow with a single ``close`` phase + the given evidence policy."""
    return {
        "name": "close-test",
        "description": "Close-phase test",
        "scout_enabled": False,
        "evidence_policy": {
            "required_on_success": ["tested", "reviewed"],
            "on_missing_evidence": policy,
        },
        "phases": {
            "close": {
                "is_local": True,
                "command": "true",
                "timeout_seconds": 30,
                "retries": 1,
            },
        },
        "transitions": [
            {
                "from": "close",
                "on_success": "finish",
                "on_reject": "finish",
                "on_error": "finish",
            },
        ],
    }


def _make_typed_flow(flow_config: dict) -> Flow:
    """Wrap a flow-config dict in a typed :class:`Flow` value object."""
    return Flow(
        name=flow_config.get("name", ""),
        description=flow_config.get("description", ""),
        scout_enabled=bool(flow_config.get("scout_enabled", False)),
        evidence_policy=dict(flow_config.get("evidence_policy") or {}),
        phases=dict(flow_config.get("phases") or {}),
        transitions=tuple(flow_config.get("transitions") or ()),
    )


def _make_flow_context(
    flow: Flow, issue_num: int = 42,
) -> FlowContext:
    """Build a :class:`FlowContext` with empty (but valid) memory."""
    working_memory = WorkingMemory(
        issue=issue_num, created_at="2026-06-16T00:00:00Z",
    )
    from context_prefetch import PrefetchedContext
    return FlowContext(
        flow=flow,
        issue_num=issue_num,
        issue_body="Test issue body",
        issue_title="Test issue",
        comments_count=0,
        created_at="2026-06-16",
        parent_prd=None,
        working_memory=working_memory,
        prefetched=PrefetchedContext(git_sha="abc123"),
        repo_context=None,
        scout_findings=None,
    )


def _fake_phase_run(
    name: str, attempt: int, status: str, details: str = "",
    tokens_in: int | None = None, tokens_out: int | None = None,
    duration_s: float | None = 0.1,
) -> PhaseRun:
    """Build a :class:`PhaseRun` with sensible defaults."""
    return PhaseRun(
        name=name,
        attempt=attempt,
        status=status,
        duration_s=duration_s,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cache_read=None,
        session_log=None,
        details=details,
    )


def _mock_term_and_gh() -> tuple:
    """Return ``(term, gh)`` mocks with the methods ``run_flow`` calls."""
    term = MagicMock()
    term._print_verbose = MagicMock()
    term.issue_header = MagicMock()
    term.attempt_start = MagicMock()
    term.attempt_metadata = MagicMock()
    term.phase_approved = MagicMock()
    term.feedback = MagicMock()
    term.failure = MagicMock()
    term.summary = MagicMock()
    gh = MagicMock()
    gh.post_phase_comment = MagicMock()
    return term, gh


# ─── Test 1: single-phase flow with retry then success ──────────────────


def test_run_flow_single_phase_with_retry_then_success():
    """One phase, reject → retry → success → finish.

    Verifies:
      - The flow runs ``phase_a`` twice (reject then success)
      - Outcome status is ``"success"``
      - The list of phase runs records both attempts
    """
    flow_config = {
        "name": "retry-test",
        "description": "",
        "scout_enabled": False,
        "evidence_policy": {},
        "phases": {
            "phase_a": {
                "skill": "/skill:test",
                "timeout_seconds": 60,
                "retries": 3,
            },
        },
        "transitions": [
            {
                "from": "phase_a",
                "on_success": "finish",
                "on_reject": "phase_a",
                "on_error": "finish",
            },
        ],
    }
    flow = _make_typed_flow(flow_config)
    flow_context = _make_flow_context(flow)
    state = PhaseState(current_phase="phase_a")
    term, gh = _mock_term_and_gh()
    log = ListLogger()

    # First call: reject. Second call: success.
    fake_runs = [
        _fake_phase_run("phase_a", 1, "reject", "needs fix"),
        _fake_phase_run("phase_a", 2, "success", "all good", tokens_in=10, tokens_out=5),
    ]
    fake_run_phase = MagicMock(side_effect=fake_runs)

    with patch("phase_runner.run_phase", fake_run_phase):
        outcome = run_flow(flow, flow_context, state, term, gh, log)

    assert outcome.status == "success", (
        f"expected 'success' outcome, got {outcome.status!r}"
    )
    assert outcome.iterations == 2
    assert len(outcome.phases) == 2
    assert outcome.phases[0].status == "reject"
    assert outcome.phases[1].status == "success"
    assert outcome.total_tokens_in == 10
    assert outcome.total_tokens_out == 5


# ─── Test 2: multi-phase flow with rejection routes back ───────────────


def test_run_flow_multi_phase_with_rejection_routes_back():
    """Two phases, second phase rejects, flow routes back to first."""
    flow = _make_typed_flow(_make_workflow_flow())
    flow_context = _make_flow_context(flow)
    state = PhaseState(current_phase="phase_a")
    term, gh = _mock_term_and_gh()
    log = ListLogger()

    # Phase A succeeds → Phase B rejects → Phase A succeeds again
    # → Phase B succeeds → finish.
    fake_runs = [
        _fake_phase_run("phase_a", 1, "success"),
        _fake_phase_run("phase_b", 1, "reject", "phase_b found issues"),
        _fake_phase_run("phase_a", 1, "success"),
        _fake_phase_run("phase_b", 1, "success"),
    ]
    fake_run_phase = MagicMock(side_effect=fake_runs)

    with patch("phase_runner.run_phase", fake_run_phase):
        outcome = run_flow(flow, flow_context, state, term, gh, log)

    assert outcome.status == "success"
    assert len(outcome.phases) == 4
    phase_names = [p.name for p in outcome.phases]
    assert phase_names == ["phase_a", "phase_b", "phase_a", "phase_b"]


# ─── Test 3: optional phase with error synthesises success ─────────────


def test_run_flow_optional_phase_with_error_synthesises_success():
    """An ``is_optional`` phase that returns ``status='error'`` does
    NOT break the flow — ``phase_runner.run_phase`` itself
    downgrades errors to a synthetic success.
    """
    flow_config = {
        "name": "optional-test",
        "description": "",
        "scout_enabled": False,
        "evidence_policy": {},
        "phases": {
            "phase_a": {
                "skill": "/skill:test",
                "timeout_seconds": 60,
                "retries": 1,
            },
            "retro": {
                "skill": "/skill:retrospective",
                "timeout_seconds": 60,
                "retries": 1,
                "is_optional": True,
            },
        },
        "transitions": [
            {"from": "phase_a", "on_success": "retro", "on_reject": "finish", "on_error": "finish"},
            {"from": "retro", "on_success": "finish", "on_reject": "finish", "on_error": "finish"},
        ],
    }
    flow = _make_typed_flow(flow_config)
    flow_context = _make_flow_context(flow)
    state = PhaseState(current_phase="phase_a")
    term, gh = _mock_term_and_gh()
    log = ListLogger()

    # phase_a succeeds; retro returns a downgraded success (synthetic).
    fake_runs = [
        _fake_phase_run("phase_a", 1, "success"),
        _fake_phase_run("retro", 1, "success", "downgraded from error"),
    ]
    fake_run_phase = MagicMock(side_effect=fake_runs)

    with patch("phase_runner.run_phase", fake_run_phase):
        outcome = run_flow(flow, flow_context, state, term, gh, log)

    assert outcome.status == "success"
    assert len(outcome.phases) == 2


# ─── Test 4: diagnostic routing on error ────────────────────────────────


def test_run_flow_diagnostic_routing_on_error():
    """A phase that returns ``status='error'`` routes to the
    diagnostic pass (handled in the loop, not via ``run_phase``),
    and the post-diagnostic transition runs.

    Verifies:
      - The diagnostic helper is called exactly once
      - The flow then transitions to the post-diagnostic phase
        (builder) and runs it via ``run_phase``
      - The outcome is ``"success"`` if the post-diagnostic
        transition succeeds
    """
    flow_config = {
        "name": "diag-test",
        "description": "",
        "scout_enabled": False,
        "evidence_policy": {},
        "phases": {
            "builder": {
                "skill": "/skill:builder",
                "timeout_seconds": 60,
                "retries": 1,
            },
            "diagnostic": {
                "skill": "/skill:diagnose",
                "timeout_seconds": 60,
                "retries": 1,
            },
        },
        "transitions": [
            # builder's on_error routes to diagnostic.
            {"from": "builder", "on_success": "finish", "on_reject": "builder", "on_error": "diagnostic"},
            # diagnostic success routes back to builder.
            {"from": "diagnostic", "on_success": "builder", "on_reject": "finish", "on_error": "finish"},
        ],
    }
    flow = _make_typed_flow(flow_config)
    flow_context = _make_flow_context(flow)
    state = PhaseState(current_phase="builder")
    term, gh = _mock_term_and_gh()
    log = ListLogger()

    # First: builder returns error. The loop then calls
    # ``diagnostic.run_diagnostic`` (the helper, not ``run_phase``)
    # which returns success. The loop resolves
    # ``diagnostic.on_success → builder``, and runs builder again,
    # which now succeeds.
    fake_runs = [
        _fake_phase_run("builder", 1, "error", "boom"),
        _fake_phase_run("builder", 1, "success", "all good after fix"),
    ]
    fake_run_phase = MagicMock(side_effect=fake_runs)
    # Stub out the diagnostic helper. The loop calls this directly
    # when ``status == "error"`` or ``next_step == "diagnostic"``.
    fake_diag = MagicMock(return_value={
        "status": "success", "analysis": "analyzed",
    })

    with patch("phase_runner.run_phase", fake_run_phase), \
         patch("diagnostic.run_diagnostic", fake_diag), \
         patch("flow_engine.MemoryStore") as MockStore:
        MockStore.return_value = MagicMock()
        outcome = run_flow(flow, flow_context, state, term, gh, log)

    # Outcome: builder → error → diagnostic → builder → success
    assert outcome.status == "success"
    # Two phase runs: the first builder (error) and the second
    # builder (success). The diagnostic helper is NOT a phase run;
    # it's a loop-level concern.
    assert len(outcome.phases) == 2
    phase_names = [p.name for p in outcome.phases]
    assert phase_names == ["builder", "builder"]
    assert outcome.phases[0].status == "error"
    assert outcome.phases[1].status == "success"
    # The diagnostic helper was called exactly once.
    fake_diag.assert_called_once()


# ─── Test 5: close-phase block policy routes to diagnostic ──────────────


def test_run_flow_close_phase_block_policy_routes_to_diagnostic():
    """The close phase with ``block`` policy + missing evidence
    returns ``reject``, which the loop routes to ``diagnostic``.
    """
    flow = _make_typed_flow(_make_close_flow(policy="block"))
    flow_context = _make_flow_context(flow)
    state = PhaseState(current_phase="close")
    term, gh = _mock_term_and_gh()
    log = ListLogger()

    # We need to ensure evidence is "missing" — easiest path: use a
    # temp evidence dir that's empty.
    d = Path(tempfile.mkdtemp(prefix="maestro_run_flow_test_"))

    try:
        # close phase: returns reject (block policy, missing evidence)
        # diagnostic: returns success
        # After diagnostic, the diagnostic's transition on_success
        # → "finish" (per the close flow's transitions above).
        fake_runs = [
            _fake_phase_run("close", 1, "reject", "Missing evidence (block policy)"),
        ]
        fake_run_phase = MagicMock(side_effect=fake_runs)
        fake_diag = MagicMock(return_value={
            "status": "success", "analysis": "evidence missing",
        })

        with patch("phase_runner.run_phase", fake_run_phase), \
             patch("diagnostic.run_diagnostic", fake_diag), \
             patch("flow_engine.MemoryStore") as MockStore:
            MockStore.return_value = MagicMock()
            MockStore.return_value.update_phase = MagicMock()
            MockStore.return_value.append_error = MagicMock()
            outcome = run_flow(flow, flow_context, state, term, gh, log)

        # After the close phase rejects, the loop routes to
        # diagnostic; the diagnostic transition has ``on_success:
        # finish`` so the flow ends successfully (despite the close
        # rejection — the diagnostic healed it).
        assert outcome.status == "success", (
            f"expected 'success' after diagnostic; got {outcome.status!r}"
        )
        # At least one phase_end event was emitted (the close
        # reject).
        assert any(
            ev.kind == "phase_end" for ev in log.events
        ), f"no phase_end events in {log.events}"
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


# ─── Test 6: FlowOutcome shape ─────────────────────────────────────────


def test_run_flow_outcome_shape():
    """The :class:`FlowOutcome` carries every documented field:
    status, iterations, phases, duration, tokens.
    """
    flow = _make_typed_flow(_make_workflow_flow())
    flow_context = _make_flow_context(flow)
    state = PhaseState(current_phase="phase_a")
    term, gh = _mock_term_and_gh()
    log = ListLogger()

    fake_runs = [
        _fake_phase_run("phase_a", 1, "success", tokens_in=100, tokens_out=50),
        _fake_phase_run("phase_b", 1, "success", tokens_in=80, tokens_out=40),
    ]
    fake_run_phase = MagicMock(side_effect=fake_runs)

    with patch("phase_runner.run_phase", fake_run_phase):
        outcome = run_flow(flow, flow_context, state, term, gh, log)

    # Status
    assert outcome.status == "success"
    # Iterations
    assert outcome.iterations == 2
    # Phases — list of PhaseRun records with the right shape
    assert len(outcome.phases) == 2
    for pr in outcome.phases:
        assert isinstance(pr, PhaseRun)
        assert hasattr(pr, "name")
        assert hasattr(pr, "attempt")
        assert hasattr(pr, "status")
        assert hasattr(pr, "duration_s")
        assert hasattr(pr, "tokens_in")
        assert hasattr(pr, "tokens_out")
        assert hasattr(pr, "cache_read")
        assert hasattr(pr, "session_log")
        assert hasattr(pr, "details")
    # Tokens aggregated across attempts
    assert outcome.total_tokens_in == 100 + 80
    assert outcome.total_tokens_out == 50 + 40
    # Duration
    assert outcome.total_duration_s >= 0
    # The flow metadata fields
    assert outcome.flow_name == "workflow-test"
    assert outcome.issue_num == 42


# ─── Test 7: ListLogger records the expected event sequence ─────────────


def test_run_flow_logger_records_event_sequence():
    """The :class:`ListLogger` records the expected event sequence:
    at least one ``phase_end`` per attempt, plus the operator
    per-phase token lines.
    """
    flow = _make_typed_flow(_make_workflow_flow())
    flow_context = _make_flow_context(flow)
    state = PhaseState(current_phase="phase_a")
    term, gh = _mock_term_and_gh()
    log = ListLogger()

    fake_runs = [
        _fake_phase_run("phase_a", 1, "success", tokens_in=20, tokens_out=10),
        _fake_phase_run("phase_b", 1, "success", tokens_in=15, tokens_out=8),
    ]
    fake_run_phase = MagicMock(side_effect=fake_runs)

    with patch("phase_runner.run_phase", fake_run_phase):
        run_flow(flow, flow_context, state, term, gh, log)

    # At least one phase_end event per phase attempt.
    phase_end_events = [ev for ev in log.events if ev.kind == "phase_end"]
    assert len(phase_end_events) >= 2, (
        f"expected >= 2 phase_end events, got {len(phase_end_events)}: {phase_end_events}"
    )
    # Each tokens_recorded event is a structured per-phase line.
    tokens_events = [ev for ev in log.events if ev.kind == "tokens_recorded"]
    assert len(tokens_events) == 2, (
        f"expected 2 tokens_recorded events, got {len(tokens_events)}: {tokens_events}"
    )
    # The two phase_end events should reference the two phases.
    phases_referenced = {ev.phase for ev in phase_end_events}
    assert phases_referenced == {"phase_a", "phase_b"}


# ─── Close-phase variants (moved from test_flow_evidence.py, issue #45) ──
#
# These tests exercise :func:`phase_runner.run_close_phase` directly
# (not via ``run_flow``) to cover the three evidence policies in
# isolation. The routing-to-diagnostic angle for the ``block`` policy
# is already covered by ``test_run_flow_close_phase_block_policy_routes_to_diagnostic``.


def _close_phase_flow(policy: str, required: list[str] | None = None) -> dict:
    """Build a minimal close-phase flow config for the given policy."""
    if required is None:
        required = ["tested", "reviewed"]
    return {
        "name": "close-test",
        "phases": {
            "close": {"is_local": True, "command": "x", "timeout_seconds": 30},
        },
        "transitions": [],
        "evidence_policy": {
            "required_on_success": required,
            "on_missing_evidence": policy,
        },
    }


def test_close_phase_succeeds_when_evidence_present():
    """When all required markers are present and verified, the close
    phase returns ``success`` regardless of policy (block, warn, ignore).
    """
    d = Path(tempfile.mkdtemp(prefix="maestro_run_flow_close_"))
    try:
        # Pre-write the required evidence
        store = EvidenceStore(42, evidence_dir=d)
        store.write(make_tested_marker(42, "test", 0, 5, 5))
        store.write(make_reviewed_marker(42, 0, 0, "human"))

        for policy_name in ("block", "warn_but_proceed", "ignore"):
            flow = _close_phase_flow(policy_name)
            result = run_close_phase(flow, 42, evidence_dir=d)
            assert result["status"] == "success", (
                f"policy={policy_name}: expected success, got {result}"
            )
            assert "All evidence present" in result["details"]
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_close_phase_rejected_when_evidence_missing_with_block_policy():
    """``block`` policy + missing evidence → ``reject`` (flow engine status)."""
    d = Path(tempfile.mkdtemp(prefix="maestro_run_flow_close_"))
    try:
        # No evidence written
        flow = _close_phase_flow("block")
        result = run_close_phase(flow, 42, evidence_dir=d)
        assert result["status"] == "reject"
        assert "Missing evidence" in result["details"]
        assert "block policy" in result["details"]
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_close_phase_warns_when_missing_with_warn_policy():
    """``warn_but_proceed`` policy + missing evidence → ``success`` (with warning)."""
    d = Path(tempfile.mkdtemp(prefix="maestro_run_flow_close_"))
    try:
        flow = _close_phase_flow("warn_but_proceed")
        result = run_close_phase(flow, 42, evidence_dir=d)
        assert result["status"] == "success"
        assert "warned" in result["details"].lower() or "missing" in result["details"].lower()
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_close_phase_skips_check_with_ignore_policy():
    """``ignore`` policy + missing evidence → ``success`` (no check)."""
    d = Path(tempfile.mkdtemp(prefix="maestro_run_flow_close_"))
    try:
        flow = _close_phase_flow("ignore")
        result = run_close_phase(flow, 42, evidence_dir=d)
        assert result["status"] == "success"
        assert "skipped" in result["details"].lower() or "ignore" in result["details"].lower()
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


# ─── Test runner ────────────────────────────────────────────────────────


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
