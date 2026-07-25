#!/usr/bin/env python3
"""
test_label_machine.py — Label state machine + claim/finalize/pickup
(issue #50).

Two layers:

  1. **Unit tests** for the pure ``lib/label_machine.py`` — every
     allowed transition, systematic verification of every forbidden
     pair, healing of stacked (corrupt) labels, pickup eligibility
     (including the ``type:prd`` exclusion), and config overrides.

  2. **Integration tests** with a mocked ``GithubClient`` covering
     the four paths from the issue AC: pickup (filter), claim
     (dispatcher swap), park (finalize → ``status:parked``), success
     (finalize → ``awaiting-manual-check``). The park/success paths
     are exercised end-to-end through ``run_flow`` with a stubbed
     ``phase_runner.run_phase`` (the ``test_breaker.py`` pattern).

Run with: ``python3 tests/test_label_machine.py`` or pytest.
"""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

# ─── Path setup ──────────────────────────────────────────────────────────
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

import label_machine as lm  # noqa: E402
from label_machine import (  # noqa: E402
    DEFAULT_LABELS,
    LabelConfig,
    apply_swap,
    can_transition,
    current_state,
    filter_pickup,
    is_pickup_eligible,
    present_state_labels,
)
import flow_dispatcher  # noqa: E402
from flow_dispatcher import claim_issue, finalize_issue_state  # noqa: E402
from flow_engine import (  # noqa: E402
    Flow,
    FlowContext,
    PhaseRun,
    PhaseState,
    WorkingMemory,
    run_flow,
)
from flow_logger import ListLogger  # noqa: E402

C = DEFAULT_LABELS  # shorthand


# ─── Unit: transition table — every allowed transition ──────────────────


def test_all_allowed_transitions_produce_correct_swap():
    """Every allowed (from → to) pair yields add=[to], remove=[from]."""
    allowed = [
        (None, C.needs_triage),
        (None, C.ready),
        (C.needs_triage, C.ready),
        (C.needs_triage, C.blocked),
        (C.ready, C.in_progress),
        (C.ready, C.needs_triage),
        (C.ready, C.blocked),
        (C.in_progress, C.parked),
        (C.in_progress, C.awaiting_manual_check),
        (C.in_progress, C.ready),
        (C.parked, C.ready),
        (C.awaiting_manual_check, C.ready),
        (C.awaiting_manual_check, C.in_progress),
        (C.blocked, C.needs_triage),
        (C.blocked, C.ready),
    ]
    for from_state, to_state in allowed:
        labels = [from_state] if from_state else []
        swap = apply_swap(labels, to_state)
        assert swap is not None, f"{from_state} → {to_state} should be allowed"
        assert swap.add == (to_state,), f"{from_state} → {to_state}: add={swap.add}"
        expected_remove = (from_state,) if from_state else ()
        assert swap.remove == expected_remove, (
            f"{from_state} → {to_state}: remove={swap.remove}"
        )


def test_all_forbidden_transitions_return_none():
    """Systematically: every (from, to) pair NOT in the table is
    forbidden — including self-loops and skipping states."""
    allowed = {
        (None, C.needs_triage), (None, C.ready),
        (C.needs_triage, C.ready), (C.needs_triage, C.blocked),
        (C.ready, C.in_progress), (C.ready, C.needs_triage),
        (C.ready, C.blocked),
        (C.in_progress, C.parked), (C.in_progress, C.awaiting_manual_check),
        (C.in_progress, C.ready),
        (C.parked, C.ready),
        (C.awaiting_manual_check, C.ready),
        (C.awaiting_manual_check, C.in_progress),
        (C.blocked, C.needs_triage), (C.blocked, C.ready),
    }
    from_states = [None] + list(C.state_labels)
    for from_state in from_states:
        labels = [from_state] if from_state else []
        for to_state in C.state_labels:
            if (from_state, to_state) in allowed:
                continue
            if from_state == to_state:
                continue  # self is a no-op swap, tested separately
            swap = apply_swap(labels, to_state)
            assert swap is None, (
                f"{from_state} → {to_state} should be FORBIDDEN, got {swap}"
            )
            assert not can_transition(from_state, to_state)


def test_self_transition_is_noop_swap():
    """Already solely in the target state → empty add/remove."""
    for state in C.state_labels:
        swap = apply_swap([state], state)
        assert swap is not None
        assert swap.add == () and swap.remove == ()


def test_unknown_target_state_rejected():
    assert apply_swap([C.ready], "bogus-label") is None
    assert not can_transition(C.ready, "bogus-label")


def test_stacked_labels_are_healed_by_any_swap():
    """Corrupt board (two state labels) → swap allowed, both removed."""
    swap = apply_swap([C.ready, C.in_progress], C.parked)
    assert swap is not None
    assert swap.add == (C.parked,)
    assert set(swap.remove) == {C.ready, C.in_progress}


# ─── Unit: state queries ─────────────────────────────────────────────────


def test_current_state_single_none_and_corrupt():
    assert current_state([C.ready]) == C.ready
    assert current_state([]) is None
    assert current_state(["bug", "documentation"]) is None
    assert current_state([C.ready, C.in_progress]) is None  # corrupt


def test_present_state_labels_ignores_non_state_labels():
    labels = ["bug", C.ready, "priority:p1"]
    assert present_state_labels(labels) == [C.ready]


# ─── Unit: pickup eligibility ────────────────────────────────────────────


def test_pickup_eligible_only_when_solely_ready():
    assert is_pickup_eligible([C.ready])
    assert is_pickup_eligible([C.ready, "priority:p0", "bug"])  # non-state ok


def test_pickup_excludes_type_prd_always():
    assert not is_pickup_eligible([C.ready, C.type_prd])
    assert not is_pickup_eligible([C.type_prd])


def test_pickup_excludes_every_other_state():
    for state in C.state_labels:
        if state == C.ready:
            continue
        assert not is_pickup_eligible([state]), f"{state} must not be eligible"


def test_pickup_excludes_unlabeled_and_stacked():
    assert not is_pickup_eligible([])
    assert not is_pickup_eligible(["bug"])
    assert not is_pickup_eligible([C.ready, C.in_progress])  # stacked


def test_filter_pickup_on_issue_like_objects():
    issues = [
        SimpleNamespace(number=1, labels=[C.ready]),
        SimpleNamespace(number=2, labels=[C.ready, C.type_prd]),
        SimpleNamespace(number=3, labels=[C.needs_triage]),
        SimpleNamespace(number=4, labels=[C.ready, "priority:p1"]),
    ]
    picked = filter_pickup(issues)
    assert [i.number for i in picked] == [1, 4]


# ─── Unit: config overrides ──────────────────────────────────────────────


def test_custom_label_config_is_respected():
    cfg = LabelConfig(ready="custom:ready", in_progress="custom:wip")
    assert is_pickup_eligible(["custom:ready"], cfg)
    assert not is_pickup_eligible(["custom:ready", C.type_prd], cfg)
    swap = apply_swap(["custom:ready"], "custom:wip", cfg)
    assert swap is not None and swap.add == ("custom:wip",)
    # Defaults are untouched by the custom config
    assert is_pickup_eligible([C.ready])


# ─── Integration: claim ──────────────────────────────────────────────────


def _gh_with_labels(labels):
    gh = MagicMock()
    gh.fetch_issue.return_value = SimpleNamespace(labels=labels)
    return gh


def test_claim_swaps_ready_to_in_progress():
    gh = _gh_with_labels([C.ready])
    assert claim_issue(42, gh) is True
    gh.update_issue_labels.assert_called_once_with(
        42, add_labels=[C.in_progress], remove_labels=[C.ready],
    )


def test_claim_refuses_non_eligible_issues():
    for labels in ([C.needs_triage], [C.ready, C.type_prd], [], [C.in_progress]):
        gh = _gh_with_labels(labels)
        assert claim_issue(42, gh) is False, f"labels={labels}"
        gh.update_issue_labels.assert_not_called()


def test_claim_failure_degrades_to_unclaimed():
    gh = MagicMock()
    gh.fetch_issue.side_effect = RuntimeError("network down")
    assert claim_issue(42, gh) is False


# ─── Integration: finalize ───────────────────────────────────────────────


def test_finalize_success_swaps_to_awaiting_manual_check():
    gh = MagicMock()
    assert finalize_issue_state(42, "success", claimed=True, gh=gh) is True
    gh.update_issue_labels.assert_called_once_with(
        42, add_labels=[C.awaiting_manual_check], remove_labels=[C.in_progress],
    )


def test_finalize_parked_swaps_to_status_parked():
    gh = MagicMock()
    assert finalize_issue_state(42, "parked", claimed=True, gh=gh) is True
    gh.update_issue_labels.assert_called_once_with(
        42, add_labels=[C.parked], remove_labels=[C.in_progress],
    )


def test_finalize_failed_swaps_nothing_fail_closed():
    """failed / exhausted_iterations leave status:in-progress in
    place — silent re-pickup must be impossible."""
    gh = MagicMock()
    for status in ("failed", "exhausted_iterations"):
        assert finalize_issue_state(42, status, claimed=True, gh=gh) is False
    gh.update_issue_labels.assert_not_called()


def test_finalize_unclaimed_never_mutates():
    gh = MagicMock()
    for status in ("success", "parked", "failed"):
        assert finalize_issue_state(42, status, claimed=False, gh=gh) is False
    gh.update_issue_labels.assert_not_called()


# ─── Integration: end-to-end park/success through run_flow ───────────────


def _make_flow() -> Flow:
    return Flow(
        name="label-e2e",
        description="",
        scout_enabled=False,
        evidence_policy={},
        phases={
            "builder": {"skill": "/skill:tdd", "timeout_seconds": 60, "retries": 3},
            "reviewer": {"skill": "/skill:reviewer", "timeout_seconds": 60, "retries": 2},
        },
        transitions=(
            {"from": "builder", "on_success": "reviewer", "on_reject": "builder", "on_error": "finish"},
            {"from": "reviewer", "on_success": "finish", "on_reject": "builder", "on_error": "finish"},
        ),
        breaker={"max_review_rounds": 1},
    )


def _make_context(flow: Flow, issue_num: int) -> FlowContext:
    from context_prefetch import PrefetchedContext
    return FlowContext(
        flow=flow,
        issue_num=issue_num,
        issue_body="body",
        issue_title="title",
        working_memory=WorkingMemory(issue=issue_num, created_at="2026-06-16T00:00:00Z"),
        prefetched=PrefetchedContext(git_sha="abc123"),
        claimed=True,  # as the dispatcher would have set it
    )


def _fake_phase_run(name: str, status: str) -> PhaseRun:
    return PhaseRun(
        name=name, attempt=1, status=status, duration_s=0.1,
        tokens_in=None, tokens_out=None, cache_read=None,
        session_log=None, details="",
    )


def test_end_to_end_park_path_claim_run_finalize():
    """The full machine: claim → run (reviewer rejects, cap=1) →
    parked outcome → finalize swaps to status:parked."""
    gh = _gh_with_labels([C.ready])
    flow = _make_flow()
    context = _make_context(flow, issue_num=42)
    term = MagicMock()

    # 1. Claim (as build_flow_context does)
    assert claim_issue(42, gh) is True

    # 2. Run — reviewer always rejects, cap=1 → parked
    def always_reject(name, *a, **kw):
        return _fake_phase_run(name, "reject" if name == "reviewer" else "success")

    with patch("phase_runner.run_phase", MagicMock(side_effect=always_reject)):
        outcome = run_flow(flow, context, PhaseState(current_phase="builder"),
                           term, gh, ListLogger())
    assert outcome.status == "parked"

    # 3. Finalize (as app_shell._run / PipelineContext.run_flow do)
    assert finalize_issue_state(42, outcome.status, context.claimed, gh) is True

    # Verify the complete label journey: ready → in_progress → parked
    calls = gh.update_issue_labels.call_args_list
    assert calls[0].kwargs == {
        "add_labels": [C.in_progress], "remove_labels": [C.ready],
    }
    assert calls[1].kwargs == {
        "add_labels": [C.parked], "remove_labels": [C.in_progress],
    }


def test_end_to_end_success_path_lands_on_awaiting_manual_check():
    """Claim → clean run → success → finalize swaps to
    awaiting-manual-check (distinct from parked)."""
    gh = _gh_with_labels([C.ready])
    flow = _make_flow()
    context = _make_context(flow, issue_num=43)
    term = MagicMock()

    assert claim_issue(43, gh) is True

    with patch("phase_runner.run_phase",
               MagicMock(side_effect=lambda name, *a, **kw: _fake_phase_run(name, "success"))):
        outcome = run_flow(flow, context, PhaseState(current_phase="builder"),
                           term, gh, ListLogger())
    assert outcome.status == "success"

    assert finalize_issue_state(43, outcome.status, context.claimed, gh) is True
    calls = gh.update_issue_labels.call_args_list
    assert calls[1].kwargs == {
        "add_labels": [C.awaiting_manual_check], "remove_labels": [C.in_progress],
    }


def test_reentry_requires_human_ready_label():
    """A parked issue is never re-picked: status:parked is not
    pickup-eligible, and the only way out is the human-applied
    ready-for-agent transition."""
    assert not is_pickup_eligible([C.parked])
    assert apply_swap([C.parked], C.in_progress) is None  # machine can't revive
    swap = apply_swap([C.parked], C.ready)  # human re-entry
    assert swap is not None and swap.add == (C.ready,)


# ─── Test runner ─────────────────────────────────────────────────────────


def main() -> int:
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
