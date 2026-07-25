#!/usr/bin/env python3
"""
test_breaker.py — Circuit-breaker policy + the 900-loop regression
test (issue #47).

Two layers:

  1. **Unit tests** for the pure ``lib/breaker.py`` policy module —
     cap boundaries (below / at / above), config parsing (defaults,
     invalid values fail closed to defaults), counter purity, and
     park-comment content. No I/O anywhere in this layer.

  2. **Integration regression tests** reproducing the incident:
     a builder↔reviewer flow whose reviewer ALWAYS rejects must
     park after exactly N rounds and never start round N+1. These
     stub ``phase_runner.run_phase`` (no LLM, no GitHub) following
     the ``test_run_flow.py`` pattern.

Run with: ``python3 tests/test_breaker.py`` (custom runner) or
``python3 -m pytest tests/test_breaker.py`` (pytest).
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# ─── Path setup ──────────────────────────────────────────────────────────
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

import breaker  # noqa: E402
from breaker import (  # noqa: E402
    ACTION_CONTINUE,
    ACTION_PARK,
    DEFAULT_MAX_REVIEW_ROUNDS,
    BreakerLimits,
    BreakerState,
    evaluate,
    format_park_comment,
    limits_from_config,
    record_reviewer_rejection,
)
from flow_engine import (  # noqa: E402
    Flow,
    FlowContext,
    PhaseRun,
    PhaseState,
    WorkingMemory,
    run_flow,
)
from flow_logger import ListLogger  # noqa: E402


# ─── Unit: evaluate() boundaries ─────────────────────────────────────────


def test_evaluate_below_cap_continues():
    """rounds < cap → continue (both just-below and zero)."""
    limits = BreakerLimits(max_review_rounds=2)
    assert evaluate(BreakerState(review_rounds=0), limits).action == ACTION_CONTINUE
    assert evaluate(BreakerState(review_rounds=1), limits).action == ACTION_CONTINUE


def test_evaluate_at_cap_parks():
    """rounds == cap → park, with a human-readable reason."""
    limits = BreakerLimits(max_review_rounds=2)
    decision = evaluate(BreakerState(review_rounds=2), limits)
    assert decision.action == ACTION_PARK
    assert "2/2" in decision.reason


def test_evaluate_above_cap_still_parks():
    """rounds > cap → park (fail closed on overshoot)."""
    limits = BreakerLimits(max_review_rounds=2)
    decision = evaluate(BreakerState(review_rounds=7), limits)
    assert decision.action == ACTION_PARK


def test_evaluate_cap_of_one_parks_on_first_rejection():
    """max_review_rounds=1 → the very first rejection parks."""
    limits = BreakerLimits(max_review_rounds=1)
    assert evaluate(BreakerState(review_rounds=0), limits).action == ACTION_CONTINUE
    assert evaluate(BreakerState(review_rounds=1), limits).action == ACTION_PARK


# ─── Unit: record_reviewer_rejection() purity ────────────────────────────


def test_record_rejection_increments_and_is_pure():
    """The counter increments by one and never mutates its input."""
    s0 = BreakerState(review_rounds=0)
    s1 = record_reviewer_rejection(s0)
    s2 = record_reviewer_rejection(s1)
    assert s0.review_rounds == 0  # unchanged — frozen dataclass
    assert s1.review_rounds == 1
    assert s2.review_rounds == 2


# ─── Unit: limits_from_config() parsing ──────────────────────────────────


def test_limits_defaults_when_absent_or_malformed():
    """Missing / non-dict config → safe defaults."""
    assert limits_from_config(None).max_review_rounds == DEFAULT_MAX_REVIEW_ROUNDS
    assert limits_from_config({}).max_review_rounds == DEFAULT_MAX_REVIEW_ROUNDS
    assert limits_from_config("nope").max_review_rounds == DEFAULT_MAX_REVIEW_ROUNDS
    assert limits_from_config(3).max_review_rounds == DEFAULT_MAX_REVIEW_ROUNDS


def test_limits_respects_valid_value():
    assert limits_from_config({"max_review_rounds": 5}).max_review_rounds == 5
    assert limits_from_config({"max_review_rounds": 1}).max_review_rounds == 1


def test_limits_reject_invalid_values_fail_closed():
    """0, negatives, strings, bools → default (never unbounded)."""
    for bad in (0, -1, "3", 2.5, True, None):
        result = limits_from_config({"max_review_rounds": bad})
        assert result.max_review_rounds == DEFAULT_MAX_REVIEW_ROUNDS, (
            f"value {bad!r} should fall back to default, got {result}"
        )


def test_limits_ignores_unknown_keys():
    """Forward-compat: unknown keys are ignored, not errors."""
    limits = limits_from_config({"max_review_rounds": 3, "future_key": True})
    assert limits.max_review_rounds == 3


# ─── Unit: format_park_comment() content contract ────────────────────────


def test_park_comment_contains_rescue_brief():
    """The comment carries rounds, verdict, evidence, and the
    re-entry instruction — the 30-second triage brief."""
    comment = format_park_comment(
        review_rounds=2,
        max_review_rounds=2,
        last_verdict="missing input validation",
        evidence_summary="missing: tested",
    )
    assert "2/2" in comment
    assert "Rounds attempted:** 2" in comment
    assert "missing input validation" in comment
    assert "missing: tested" in comment
    assert "ready-for-agent" in comment


def test_park_comment_handles_empty_verdict():
    comment = format_park_comment(1, 1, "", "none required by policy")
    assert "(no verdict text captured)" in comment


# ─── Integration: the 900-loop regression ────────────────────────────────


def _make_builder_reviewer_flow(breaker_config: dict | None) -> Flow:
    """A minimal builder → test_runner → reviewer flow with the
    ping-pong transition (reviewer.on_reject → builder) that caused
    the incident. Optionally carries a ``breaker`` section.
    """
    phases = {
        "builder": {"skill": "/skill:tdd", "timeout_seconds": 60, "retries": 3},
        "test_runner": {"skill": "/skill:test_runner", "timeout_seconds": 60, "retries": 1},
        "reviewer": {"skill": "/skill:reviewer", "timeout_seconds": 60, "retries": 2},
    }
    transitions = (
        {"from": "builder", "on_success": "test_runner", "on_reject": "builder", "on_error": "finish"},
        {"from": "test_runner", "on_success": "reviewer", "on_reject": "builder", "on_error": "finish"},
        {"from": "reviewer", "on_success": "finish", "on_reject": "builder", "on_error": "finish"},
    )
    return Flow(
        name="breaker-test",
        description="",
        scout_enabled=False,
        evidence_policy={},
        phases=phases,
        transitions=transitions,
        breaker=dict(breaker_config or {}),
    )


def _make_context(flow: Flow, issue_num: int = 42) -> FlowContext:
    from context_prefetch import PrefetchedContext
    return FlowContext(
        flow=flow,
        issue_num=issue_num,
        issue_body="Test issue body",
        issue_title="Test issue",
        working_memory=WorkingMemory(issue=issue_num, created_at="2026-06-16T00:00:00Z"),
        prefetched=PrefetchedContext(git_sha="abc123"),
    )


def _fake_phase_run(name: str, status: str, details: str = "") -> PhaseRun:
    return PhaseRun(
        name=name,
        attempt=1,
        status=status,
        duration_s=0.1,
        tokens_in=None,
        tokens_out=None,
        cache_read=None,
        session_log=None,
        details=details,
    )


def _mock_term_and_gh() -> tuple:
    term = MagicMock()
    gh = MagicMock()
    return term, gh


def _always_rejecting_reviewer(name, *args, **kwargs) -> PhaseRun:
    """Builder and test_runner always succeed; the reviewer ALWAYS
    rejects — the exact shape of the 900-loop incident."""
    if name == "reviewer":
        return _fake_phase_run(name, "reject", "still broken: no input validation")
    return _fake_phase_run(name, "success")


def test_flow_parks_at_configured_round_cap():
    """THE regression test. Reviewer always rejects, cap=2 → the
    flow parks after exactly 2 review rounds; round 3 never starts.
    """
    flow = _make_builder_reviewer_flow({"max_review_rounds": 2})
    context = _make_context(flow)
    state = PhaseState(current_phase="builder")
    term, gh = _mock_term_and_gh()
    log = ListLogger()

    fake_run_phase = MagicMock(side_effect=_always_rejecting_reviewer)
    with patch("phase_runner.run_phase", fake_run_phase):
        outcome = run_flow(flow, context, state, term, gh, log)

    assert outcome.status == "parked", (
        f"expected 'parked', got {outcome.status!r}"
    )
    names = [p.name for p in outcome.phases]
    # Exactly 2 full rounds: builder→test_runner→reviewer, twice.
    # A third builder run would mean round 3 started — the incident.
    assert names == [
        "builder", "test_runner", "reviewer",
        "builder", "test_runner", "reviewer",
    ], f"unexpected phase sequence: {names}"
    # A park comment was posted with the structured rescue brief.
    park_calls = [
        c for c in gh.post_phase_comment.call_args_list
        if c.kwargs.get("status") == "parked"
    ]
    assert len(park_calls) == 1, f"expected 1 park comment, got {park_calls}"
    details = park_calls[0].kwargs["details"]
    assert "2/2" in details
    assert "still broken: no input validation" in details
    assert "ready-for-agent" in details
    # A breaker_park event was emitted on the structured log.
    assert any(ev.kind == "breaker_park" for ev in log.events)


def test_flow_parks_with_default_cap_when_unconfigured():
    """No ``breaker`` section → default cap (2) applies. Any sane
    configuration ends in a park, never in an unbounded loop."""
    flow = _make_builder_reviewer_flow(breaker_config=None)
    context = _make_context(flow, issue_num=43)
    term, gh = _mock_term_and_gh()

    fake_run_phase = MagicMock(side_effect=_always_rejecting_reviewer)
    with patch("phase_runner.run_phase", fake_run_phase):
        outcome = run_flow(flow, context, PhaseState(current_phase="builder"), term, gh, ListLogger())

    assert outcome.status == "parked"
    assert [p.name for p in outcome.phases].count("reviewer") == DEFAULT_MAX_REVIEW_ROUNDS


def test_flow_parks_immediately_with_cap_of_one():
    """cap=1 → first reviewer rejection parks; builder runs once."""
    flow = _make_builder_reviewer_flow({"max_review_rounds": 1})
    context = _make_context(flow, issue_num=44)
    term, gh = _mock_term_and_gh()

    fake_run_phase = MagicMock(side_effect=_always_rejecting_reviewer)
    with patch("phase_runner.run_phase", fake_run_phase):
        outcome = run_flow(flow, context, PhaseState(current_phase="builder"), term, gh, ListLogger())

    assert outcome.status == "parked"
    names = [p.name for p in outcome.phases]
    assert names == ["builder", "test_runner", "reviewer"]


def test_flow_success_before_cap_is_unaffected():
    """Reviewer rejects once (below cap), approves on the second
    round → normal success, no park comment."""
    flow = _make_builder_reviewer_flow({"max_review_rounds": 2})
    context = _make_context(flow, issue_num=45)
    term, gh = _mock_term_and_gh()

    reviewer_calls = {"n": 0}

    def reject_once_then_approve(name, *args, **kwargs) -> PhaseRun:
        if name == "reviewer":
            reviewer_calls["n"] += 1
            if reviewer_calls["n"] == 1:
                return _fake_phase_run(name, "reject", "one issue")
            return _fake_phase_run(name, "success")
        return _fake_phase_run(name, "success")

    fake_run_phase = MagicMock(side_effect=reject_once_then_approve)
    with patch("phase_runner.run_phase", fake_run_phase):
        outcome = run_flow(flow, context, PhaseState(current_phase="builder"), term, gh, ListLogger())

    assert outcome.status == "success"
    park_calls = [
        c for c in gh.post_phase_comment.call_args_list
        if c.kwargs.get("status") == "parked"
    ]
    assert park_calls == []


def test_park_comment_includes_evidence_state():
    """The park comment carries an evidence-state line (whatever it
    degrades to) — never absent, never blocking the park."""
    flow = _make_builder_reviewer_flow({"max_review_rounds": 1})
    context = _make_context(flow, issue_num=46)
    term, gh = _mock_term_and_gh()

    fake_run_phase = MagicMock(side_effect=_always_rejecting_reviewer)
    with patch("phase_runner.run_phase", fake_run_phase):
        run_flow(flow, context, PhaseState(current_phase="builder"), term, gh, ListLogger())

    park_calls = [
        c for c in gh.post_phase_comment.call_args_list
        if c.kwargs.get("status") == "parked"
    ]
    assert len(park_calls) == 1
    assert "Evidence state:" in park_calls[0].kwargs["details"]


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
