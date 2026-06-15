#!/usr/bin/env python3
"""
test_flow_engine_logging.py — Structured-logger event-sequence tests.

Per issue #30 (deepening PRD), the ``flow_engine`` module emits
``FlowEvent`` objects through a ``FlowLogger`` port instead of
scattering ``print(..., file=sys.stderr)`` calls. This file drives
``run_phase`` (and related helpers) with a ``ListLogger`` and asserts
the expected event sequence lands in ``logger.events``.

Each test exercises one branch of the new logging path. The
assertions are on the structured events (kind / phase / message),
not on stderr text — that's what the :class:`ListLogger` adapter is
for. The terminal-output snapshot lives in
``tests/test_flow_logger.py`` (added in the same slice).

Test surface (per the issue's AC):
  * Successful close phase with all evidence → no events
  * Missing evidence + warn_but_proceed policy → two ``evidence_warn``
  * ``_run_scout_phase`` on success → one ``scout_complete`` pre-run
    + (no post-run failure events)
  * ``_run_scout_phase`` on failure → one pre-run ``scout_complete``,
    one post-run ``scout_complete`` (the status line), and one
    ``scout_complete`` (the proceed-without-findings line)
  * ``_run_scout_phase`` on parse_error → one pre-run + one
    ``scout_complete`` "Output was unparseable" + one
    ``scout_complete`` "Builder will proceed with raw findings"
  * Optional phase that raises → one ``phase_end`` with
    ``phase=<name>`` and a "Failed (non-fatal)" message
  * Optional phase that returns ``status=error`` → one ``phase_end``
    with a "Returned error (non-fatal, downgraded)" message

Run with: ``python3 tests/test_flow_engine_logging.py`` (custom runner)
       or ``python3 -m pytest tests/test_flow_engine_logging.py`` (pytest)
"""

import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add lib + parent dir to path so we can import flow_engine
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

import flow_engine  # noqa: E402
from flow_engine import (  # noqa: E402
    run_close_phase,
    run_phase,
    _run_scout_phase,
)
from flow_logger import ListLogger  # noqa: E402
from working_memory import MemoryStore  # noqa: E402


# ─── Shared fixtures ────────────────────────────────────────────────────


def _make_close_flow(policy: str = "warn_but_proceed") -> dict:
    """Minimal flow config for close-phase tests."""
    return {
        "name": "test-flow",
        "phases": {
            "close": {
                "is_local": True,
                "command": "true",
                "retries": 1,
            },
        },
        "transitions": [],
        "evidence_policy": {
            "required_on_success": ["tested", "reviewed"],
            "on_missing_evidence": policy,
        },
    }


def _make_scout_flow() -> dict:
    """Minimal flow config with a scout phase."""
    return {
        "name": "test-flow",
        "scout_enabled": True,
        "scout_timeout_seconds": 60,
        "phases": {
            "scout": {
                "skill": "/skill:scout",
                "retries": 1,
                "timeout_seconds": 60,
            },
        },
        "transitions": [],
    }


def _kind(events, kind: str) -> int:
    """Return the index of the first event with the given kind, or -1."""
    for i, ev in enumerate(events):
        if ev.kind == kind:
            return i
    return -1


def _events_with_kind(events, kind: str) -> list:
    """Return all events with the given kind (in order)."""
    return [ev for ev in events if ev.kind == kind]


def _events_with_phase(events, phase: str) -> list:
    """Return all events with the given phase (in order)."""
    return [ev for ev in events if ev.phase == phase]


# ─── Tests: _close_phase_result ────────────────────────────────────────


def test_close_phase_no_events_when_evidence_present():
    """Happy path (all evidence verified) → no log events."""
    d = tempfile.mkdtemp()
    try:
        from evidence import EvidenceStore, make_reviewed_marker, make_tested_marker
        store = EvidenceStore(42, evidence_dir=Path(d))
        store.write(make_tested_marker(42, "pytest", 0, 5, 5))
        store.write(make_reviewed_marker(42, 0, 0, "human"))

        log = ListLogger()
        result = run_close_phase(
            _make_close_flow("warn_but_proceed"),
            42,
            evidence_dir=d,
            log=log,
        )

        assert result["status"] == "success"
        assert log.events == [], (
            f"Happy path should not emit log events; got {log.events}"
        )
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_close_phase_emits_two_evidence_warn_on_warn_policy():
    """Missing evidence + warn_but_proceed → exactly two ``evidence_warn`` events."""
    d = tempfile.mkdtemp()
    try:
        log = ListLogger()
        result = run_close_phase(
            _make_close_flow("warn_but_proceed"),
            42,
            evidence_dir=d,
            log=log,
        )

        assert result["status"] == "success"
        warns = _events_with_kind(log.events, "evidence_warn")
        assert len(warns) == 2, (
            f"Expected 2 evidence_warn events; got {len(warns)}: {warns}"
        )
        # First warns about the missing evidence; second warns about
        # the policy downgrade. Both have no phase prefix (memory_warn
        # is config-time, not phase-time).
        assert "Missing evidence" in warns[0].message
        assert "warn_but_proceed" in warns[1].message
        for w in warns:
            assert w.phase is None, (
                f"evidence_warn should not be phase-scoped; got phase={w.phase!r}"
            )
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_close_phase_no_events_on_block_policy():
    """Missing evidence + block policy → no log events (no warning, just rejection)."""
    d = tempfile.mkdtemp()
    try:
        log = ListLogger()
        result = run_close_phase(
            _make_close_flow("block"),
            42,
            evidence_dir=d,
            log=log,
        )

        assert result["status"] == "reject"
        # block policy returns the reject; no warn events fire.
        assert log.events == [], (
            f"block policy should not emit log events; got {log.events}"
        )
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


def test_close_phase_no_events_on_ignore_policy():
    """Missing evidence + ignore policy → no log events."""
    d = tempfile.mkdtemp()
    try:
        log = ListLogger()
        result = run_close_phase(
            _make_close_flow("ignore"),
            42,
            evidence_dir=d,
            log=log,
        )

        assert result["status"] == "success"
        assert log.events == []
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


# ─── Tests: _run_scout_phase ──────────────────────────────────────────


def test_scout_phase_emits_pre_run_announcement():
    """The pre-run "Running scout phase on issue #N" emits one ``scout_complete``."""
    log = ListLogger()
    fake_run_phase = MagicMock(return_value=(
        {
            "status": "success",
            "details": "scout ran",
            "output": "### PHASE_OUTPUT: success\n{}\n### END_PHASE_OUTPUT",
        },
        "/tmp/scout.jsonl",
    ))

    with patch("flow_engine.run_phase", fake_run_phase):
        findings = _run_scout_phase(
            _make_scout_flow(),
            99,
            {"prompt": "test"},
            MemoryStore(99),
            log=log,
        )

    assert findings is not None
    pre_run = [ev for ev in log.events
               if ev.phase == "scout" and "Running scout phase" in ev.message]
    assert len(pre_run) == 1, (
        f"Expected exactly one pre-run scout_complete; got {pre_run}"
    )
    assert pre_run[0].kind == "scout_complete"
    assert "issue #99" in pre_run[0].message
    assert "(timeout=60s)" in pre_run[0].message


def test_scout_phase_emits_failure_events_on_non_success():
    """A scout that returns ``status != 'success'`` emits post-run events."""
    log = ListLogger()
    fake_run_phase = MagicMock(return_value=(
        {
            "status": "error",
            "details": "RPC failed: timeout",
            "output": "",
        },
        "/tmp/scout.jsonl",
    ))

    with patch("flow_engine.run_phase", fake_run_phase):
        findings = _run_scout_phase(
            _make_scout_flow(),
            99,
            {"prompt": "test"},
            MemoryStore(99),
            log=log,
        )

    assert findings is None  # Non-fatal: builder proceeds with no findings

    scout_events = _events_with_phase(log.events, "scout")
    assert len(scout_events) >= 2, (
        f"Expected at least 2 scout events (status + proceed-without); "
        f"got {scout_events}"
    )
    # First post-run event carries the status message
    status_event = next(
        (ev for ev in scout_events if "error:" in ev.message),
        None,
    )
    assert status_event is not None, f"No 'error:' event in {scout_events}"
    assert "RPC failed" in status_event.message
    # Second post-run event is the proceed-without-findings note
    proceed_event = next(
        (ev for ev in scout_events if "Builder will proceed" in ev.message),
        None,
    )
    assert proceed_event is not None, f"No proceed-without event in {scout_events}"


def test_scout_phase_emits_parse_error_events():
    """A scout that succeeds but produces unparseable output logs the parse error."""
    log = ListLogger()
    # A scout that ran (status=success) but whose PHASE_OUTPUT couldn't
    # be parsed. ``parse_scout_findings_from_details`` would return a
    # dict with a ``parse_error`` key in that case.
    fake_run_phase = MagicMock(return_value=(
        {
            "status": "success",
            "details": "scout ran",
            "output": "no markers here, just text",
        },
        "/tmp/scout.jsonl",
    ))

    with patch("flow_engine.run_phase", fake_run_phase):
        findings = _run_scout_phase(
            _make_scout_flow(),
            99,
            {"prompt": "test"},
            MemoryStore(99),
            log=log,
        )

    # The function may return a dict with parse_error or None; both are
    # acceptable for this test. We just check the events.
    scout_events = _events_with_phase(log.events, "scout")
    parse_err_event = next(
        (ev for ev in scout_events if "Output was unparseable" in ev.message),
        None,
    )
    assert parse_err_event is not None, (
        f"Expected an 'Output was unparseable' event; got {scout_events}"
    )
    proceed_event = next(
        (ev for ev in scout_events if "Builder will proceed with raw findings" in ev.message),
        None,
    )
    assert proceed_event is not None, (
        f"Expected a 'proceed with raw findings' event; got {scout_events}"
    )


# ─── Tests: run_phase (optional-phase failure path) ────────────────────


def test_optional_phase_exception_emits_phase_end_event():
    """An is_optional phase that raises → one ``phase_end`` event, not a crash."""
    log = ListLogger()
    fake_inner = MagicMock(side_effect=RuntimeError("LLM exploded"))

    flow_config = {
        "name": "test-flow",
        "phases": {
            "retrospective": {
                "skill": "/skill:retro",
                "is_optional": True,
                "retries": 1,
                "timeout_seconds": 60,
            },
        },
        "transitions": [],
    }

    with patch("flow_engine._run_phase_inner", fake_inner):
        result, session_log = run_phase(
            "retrospective", flow_config, 42, {}, log=log,
        )

    # Non-fatal: the runner converts the exception to a synthetic success
    assert result["status"] == "success"
    assert "non-blocking" in result["details"]

    # Exactly one phase_end event with the failure message
    phase_end_events = _events_with_kind(log.events, "phase_end")
    assert len(phase_end_events) == 1, (
        f"Expected exactly 1 phase_end event; got {phase_end_events}"
    )
    assert phase_end_events[0].phase == "retrospective"
    assert "Failed (non-fatal)" in phase_end_events[0].message
    assert "LLM exploded" in phase_end_events[0].message


def test_optional_phase_error_return_emits_phase_end_event():
    """An is_optional phase that returns ``status=error`` → one ``phase_end`` event."""
    log = ListLogger()
    fake_inner = MagicMock(return_value=(
        {
            "status": "error",
            "details": "verdict extractor failed",
        },
        "/tmp/session.jsonl",
    ))

    flow_config = {
        "name": "test-flow",
        "phases": {
            "retrospective": {
                "skill": "/skill:retro",
                "is_optional": True,
                "retries": 1,
                "timeout_seconds": 60,
            },
        },
        "transitions": [],
    }

    with patch("flow_engine._run_phase_inner", fake_inner):
        result, session_log = run_phase(
            "retrospective", flow_config, 42, {}, log=log,
        )

    # Non-fatal downgrade: error → success
    assert result["status"] == "success"
    assert "downgraded" in result["details"]

    phase_end_events = _events_with_kind(log.events, "phase_end")
    assert len(phase_end_events) == 1, (
        f"Expected exactly 1 phase_end event; got {phase_end_events}"
    )
    assert phase_end_events[0].phase == "retrospective"
    assert "Returned error (non-fatal, downgraded)" in phase_end_events[0].message
    assert "verdict extractor failed" in phase_end_events[0].message


# ─── Tests: log=None defaults to StderrLogger ──────────────────────────


def test_log_none_does_not_crash():
    """Passing ``log=None`` falls back to a StderrLogger and runs normally."""
    # We can't actually drive the RPC layer in this smoke test (no
    # `pi` binary guarantee), so we just exercise the resolution
    # helper directly.
    from flow_engine import _resolve_log
    from flow_logger import StderrLogger
    resolved = _resolve_log(None)
    assert isinstance(resolved, StderrLogger)


def test_log_explicit_is_returned_unchanged():
    """A non-None logger is returned as-is by ``_resolve_log``."""
    from flow_engine import _resolve_log
    log = ListLogger()
    resolved = _resolve_log(log)
    assert resolved is log


# ─── Custom test runner ────────────────────────────────────────────────


tests = [
    test_close_phase_no_events_when_evidence_present,
    test_close_phase_emits_two_evidence_warn_on_warn_policy,
    test_close_phase_no_events_on_block_policy,
    test_close_phase_no_events_on_ignore_policy,
    test_scout_phase_emits_pre_run_announcement,
    test_scout_phase_emits_failure_events_on_non_success,
    test_scout_phase_emits_parse_error_events,
    test_optional_phase_exception_emits_phase_end_event,
    test_optional_phase_error_return_emits_phase_end_event,
    test_log_none_does_not_crash,
    test_log_explicit_is_returned_unchanged,
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
