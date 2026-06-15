#!/usr/bin/env python3
"""
Unit tests for the new value-object types added to ``flow_engine.py``.

Covers construction and immutability (frozen-ness) for each new type:

  - ``PhaseConfig`` — frozen, with the expected default for ``tools``
  - ``Transition`` — frozen
  - ``Flow`` — frozen
  - ``FlowContext`` — frozen (with ``None`` for optional fields)
  - ``PhaseState`` — INTENTIONALLY MUTABLE (the loop's local state)
  - ``PhaseRun`` — frozen
  - ``FlowOutcome`` — frozen

Per the deepening PRD: every type except ``PhaseState`` is a frozen
dataclass. ``PhaseState`` is the ONE mutable type — it is the loop's
local state and mutates every iteration.

Run with: ``python3 tests/test_flow_types.py`` (custom runner)
       or ``python3 -m pytest tests/test_flow_types.py`` (pytest)
"""

import sys
from dataclasses import FrozenInstanceError, fields, is_dataclass
from pathlib import Path

# Add parent to path so ``import flow_engine`` works without a package install.
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_engine import (  # noqa: E402
    Flow,
    FlowContext,
    FlowOutcome,
    PhaseConfig,
    PhaseRun,
    PhaseState,
    Transition,
)


# ─── PhaseConfig ─────────────────────────────────────────────────────────


def test_phase_config_is_frozen():
    """PhaseConfig attribute assignment raises FrozenInstanceError."""
    cfg = PhaseConfig(
        name="builder",
        skill="/skill:tdd",
        timeout_seconds=1800,
        retries=3,
        is_local=False,
        is_optional=False,
        model="MiniMax-M3",
        provider="minimax",
        command=None,
        tools=("read_file", "edit_file"),
    )
    try:
        cfg.name = "reviewer"  # type: ignore[misc]
    except FrozenInstanceError:
        return
    raise AssertionError("PhaseConfig is not frozen — assignment should have raised FrozenInstanceError")


def test_phase_config_tools_default_is_empty_tuple():
    """When tools is omitted, it defaults to an empty tuple (not list)."""
    cfg = PhaseConfig(
        name="close",
        skill="/skill:close",
        timeout_seconds=30,
        retries=1,
        is_local=True,
        is_optional=False,
        model=None,
        provider=None,
        command="python3 -m maestro.commands.evidence check {issue_number}",
    )
    assert cfg.tools == ()
    assert isinstance(cfg.tools, tuple)


# ─── Transition ──────────────────────────────────────────────────────────


def test_transition_is_frozen():
    """Transition is a frozen dataclass."""
    t = Transition(
        from_phase="builder",
        on_success="test_runner",
        on_reject="builder",
        on_error="diagnostic",
        on_no_gaps=None,
    )
    try:
        t.from_phase = "reviewer"  # type: ignore[misc]
    except FrozenInstanceError:
        return
    raise AssertionError("Transition is not frozen")


# ─── Flow ────────────────────────────────────────────────────────────────


def test_flow_is_frozen():
    """Flow is a frozen dataclass — assignment raises."""
    f = Flow(
        name="builder-reviewer",
        description="test",
        scout_enabled=True,
        evidence_policy={"on_missing_evidence": "warn_but_proceed"},
        phases={},
        transitions=(),
    )
    try:
        f.name = "other"  # type: ignore[misc]
    except FrozenInstanceError:
        return
    raise AssertionError("Flow is not frozen")


# ─── FlowContext ─────────────────────────────────────────────────────────


def test_flow_context_is_frozen_with_none_optional_fields():
    """FlowContext is frozen and accepts None for parent_prd, repo_context,
    scout_findings (these are the *forward-reference* fields; the test
    passes any object as the value since the type annotations are strings)."""
    flow = Flow(
        name="x",
        description="",
        scout_enabled=False,
        evidence_policy={},
        phases={},
        transitions=(),
    )
    ctx = FlowContext(
        flow=flow,
        issue_num=27,
        issue_body="body",
        issue_title="title",
        parent_prd=None,
        working_memory=None,    # forward ref — any value works at construction
        prefetched=None,
        repo_context=None,
        scout_findings=None,
    )
    try:
        ctx.issue_num = 99  # type: ignore[misc]
    except FrozenInstanceError:
        return
    raise AssertionError("FlowContext is not frozen")


# ─── PhaseState (the one MUTABLE type) ───────────────────────────────────


def test_phase_state_is_mutable_by_design():
    """PhaseState is intentionally NOT frozen — it is the runner's local
    state, mutated every iteration. Assignment must succeed."""
    state = PhaseState(current_phase="scout")
    # Mutate each field — this is the whole point of PhaseState
    state.current_phase = "builder"
    state.phase_attempt = 2
    state.previous_output = "previous text"
    state.diagnostic_insights = "insight"
    state.phase_outputs = {"scout": {"status": "success"}}

    assert state.current_phase == "builder"
    assert state.phase_attempt == 2
    assert state.previous_output == "previous text"
    assert state.diagnostic_insights == "insight"
    assert state.phase_outputs == {"scout": {"status": "success"}}


def test_phase_state_phase_outputs_defaults_to_empty_dict():
    """The phase_outputs field default-factory yields a fresh dict per
    instance (no mutable-default aliasing bug)."""
    s1 = PhaseState(current_phase="scout")
    s2 = PhaseState(current_phase="scout")
    s1.phase_outputs["x"] = 1
    assert s2.phase_outputs == {}


# ─── PhaseRun ────────────────────────────────────────────────────────────


def test_phase_run_is_frozen():
    """PhaseRun is frozen."""
    pr = PhaseRun(
        name="builder",
        attempt=1,
        status="approved",
        duration_s=42.5,
        tokens_in=100,
        tokens_out=50,
        cache_read=10,
        session_log=Path("/tmp/log.jsonl"),
        details="approved after 1 attempt",
    )
    try:
        pr.status = "rejected"  # type: ignore[misc]
    except FrozenInstanceError:
        return
    raise AssertionError("PhaseRun is not frozen")


# ─── FlowOutcome ─────────────────────────────────────────────────────────


def test_flow_outcome_is_frozen():
    """FlowOutcome is frozen."""
    o = FlowOutcome(
        flow_name="builder-reviewer",
        issue_num=27,
        status="success",
        iterations=3,
        phases=(),
        events=(),
        total_duration_s=120.0,
        evidence_summary=None,
        retro_learning=None,
    )
    try:
        o.status = "failed"  # type: ignore[misc]
    except FrozenInstanceError:
        return
    raise AssertionError("FlowOutcome is not frozen")


# ─── Generic: every type is a dataclass ──────────────────────────────────


def test_all_new_types_are_dataclasses():
    """Spot-check: each type is a dataclass (the contract the deepening PRD
    depends on for the structural pattern match)."""
    for cls in (PhaseConfig, Transition, Flow, FlowContext, PhaseState, PhaseRun, FlowOutcome):
        assert is_dataclass(cls), f"{cls.__name__} is not a dataclass"


# ─── Custom test runner (matches the project convention) ────────────────


tests = [
    test_phase_config_is_frozen,
    test_phase_config_tools_default_is_empty_tuple,
    test_transition_is_frozen,
    test_flow_is_frozen,
    test_flow_context_is_frozen_with_none_optional_fields,
    test_phase_state_is_mutable_by_design,
    test_phase_state_phase_outputs_defaults_to_empty_dict,
    test_phase_run_is_frozen,
    test_flow_outcome_is_frozen,
    test_all_new_types_are_dataclasses,
]


if __name__ == "__main__":
    passed = 0
    failed = 0
    for test_fn in tests:
        try:
            test_fn()
            print(f"  ✓ {test_fn.__name__}")
            passed += 1
        except Exception as e:
            import traceback
            print(f"  ✗ {test_fn.__name__}: {e}")
            traceback.print_exc()
            failed += 1

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed > 0:
        sys.exit(1)
