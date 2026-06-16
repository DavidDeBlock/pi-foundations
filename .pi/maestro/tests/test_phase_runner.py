#!/usr/bin/env python3
"""
test_phase_runner.py — Unit tests for phase_runner.run_phase.

Covers the per-phase function that lives in :mod:`phase_runner` (deepening
PRD issue #31). The new contract: typed ``Flow``/``FlowContext``/``PhaseState``
inputs, a :class:`PhaseRun` value object on the way out.

Each test exercises one observable behaviour of the new shape:

  * ``test_run_phase_returns_phaserun_for_approved_verdict``
    — approved verdict → ``status="success"``, tokens populated from the
    session log's ``message.usage`` block.
  * ``test_run_phase_returns_phaserun_for_rejected_verdict``
    — rejected verdict → ``status="reject"``, details carry the issues.
  * ``test_run_phase_is_optional_exception_becomes_skipped_style_success``
    — ``is_optional`` phase that raises → ``status="success"`` (downgraded
    to non-blocking), details contain "non-blocking" and the error.
  * ``test_run_phase_is_optional_error_return_becomes_success``
    — ``is_optional`` phase that returns ``status="error"`` →
    ``status="success"`` (downgraded), details contain "downgraded".
  * ``test_run_phase_is_local_command_success``
    — ``is_local: true`` with a successful command → ``status="success"``.
  * ``test_run_phase_is_local_command_nonzero_exit``
    — ``is_local: true`` with a non-zero exit code → ``status="reject"``.
  * ``test_run_phase_close_with_block_policy_and_missing_evidence``
    — close phase + ``block`` policy + missing evidence →
    ``status="reject"``.
  * ``test_run_phase_close_with_warn_but_proceed_emits_evidence_warn``
    — close phase + ``warn_but_proceed`` policy → ``status="success"``
    and the logger receives two ``evidence_warn`` events.
  * ``test_run_phase_tokens_none_when_log_missing``
    — RPC returns no ``session_log`` path → all three token fields are
    ``None``.
  * ``test_run_phase_tokens_none_when_log_has_no_usage``
    — session log written but with no ``message.usage`` block → all
    three token fields are ``None``.
  * ``test_run_phase_is_local_phase_has_none_tokens``
    — ``is_local`` phase has no session log → all three token fields
    are ``None``.
  * ``test_run_phase_populates_tokens_from_session_log``
    — happy path: log carries usage → ``tokens_in``, ``tokens_out``,
    ``cache_read`` populated per the field-mapping.

The tests stub the RPC layer (``run_rpc_with_session_log``) and the
prompt loader (``build_prompt``) so they run without a ``pi`` binary or
network access. The session-dir builder (``_build_session_dir``) is
patched to ``None`` to skip the on-disk session-log write.

Run with: ``python3 tests/test_phase_runner.py`` (custom runner)
       or ``python3 -m pytest tests/test_phase_runner.py`` (pytest)
"""

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add lib + parent dir to path so we can import phase_runner and flow_engine
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

from terminal import Terminal  # noqa: E402
from github_client import GithubClient  # noqa: E402

import phase_runner  # noqa: E402
import flow_engine  # noqa: E402
from phase_runner import run_phase  # noqa: E402
from flow_engine import (  # noqa: E402
    Flow,
    FlowContext,
    PhaseState,
    WorkingMemory,
)
from flow_logger import ListLogger  # noqa: E402


# ─── Shared fixtures ────────────────────────────────────────────────────


def _make_term_and_gh() -> tuple:
    """Build a no-op :class:`Terminal` and a :class:`GithubClient` mock.

    The new ``run_phase`` signature takes both, but neither is used by
    the close / local-command / is_optional paths. Future diagnostic
    routing will use them; for now they just need to exist.
    """
    term = Terminal()
    gh = MagicMock(spec=GithubClient)
    return term, gh


def _make_flow(phases: dict, evidence_policy: dict | None = None, name: str = "test-flow") -> Flow:
    """Build a :class:`Flow` value object for the given phase set."""
    return Flow(
        name=name,
        description="",
        scout_enabled=False,
        evidence_policy=evidence_policy or {"on_missing_evidence": "ignore"},
        phases=phases,
        transitions=(),
    )


def _make_flow_context(flow: Flow, issue_num: int = 42) -> FlowContext:
    """Build a minimal :class:`FlowContext` for the given flow."""
    return FlowContext(
        flow=flow,
        issue_num=issue_num,
        issue_body="Test issue body",
        issue_title="Test",
        working_memory=WorkingMemory(issue=issue_num, created_at="2026-06-15T00:00:00Z"),
    )


def _write_synthetic_session_log(path: Path, usage: dict | None) -> None:
    """Write a JSONL session log with one assistant message carrying ``usage``."""
    with path.open("w", encoding="utf-8") as f:
        f.write(json.dumps({
            "type": "session",
            "id": "test-session",
            "timestamp": "2026-06-15T12:00:00.000Z",
        }) + "\n")
        if usage is not None:
            f.write(json.dumps({
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "approved"}],
                    "usage": usage,
                },
            }) + "\n")


def _close_flow(policy: str = "ignore") -> Flow:
    return _make_flow(
        phases={
            "close": {
                "is_local": True,
                "command": "true",
                "retries": 1,
                "timeout_seconds": 30,
            },
        },
        evidence_policy={"on_missing_evidence": policy},
    )


def _builder_flow() -> Flow:
    return _make_flow(
        phases={
            "builder": {
                "skill": "/skill:tdd",
                "retries": 1,
                "timeout_seconds": 60,
            },
        },
    )


# ─── 1. Approved verdict ───────────────────────────────────────────────


def test_run_phase_returns_phaserun_for_approved_verdict():
    """An approved verdict → ``PhaseRun`` with status="success" and tokens."""
    flow = _builder_flow()
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="builder", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    with tempfile.TemporaryDirectory() as td:
        session_log = Path(td) / "session.jsonl"
        _write_synthetic_session_log(session_log, {
            "input": 100,
            "output": 50,
            "cacheRead": 200,
            "cacheWrite": 30,
            "totalTokens": 380,
        })

        fake_rpc = {
            "success": True,
            "output": "fake output",
            "session_log": str(session_log),
            "result": {"status": "approved"},
        }
        with patch.object(phase_runner, "run_rpc_with_session_log", return_value=fake_rpc), \
             patch.object(phase_runner, "build_prompt", return_value=("prompt", [])), \
             patch.object(phase_runner, "_build_session_dir", return_value=None):
            phase_run = run_phase("builder", flow, ctx, state, term, gh, log=log)

    assert phase_run.name == "builder"
    assert phase_run.attempt == 1
    assert phase_run.status == "success"
    assert phase_run.tokens_in == 100 + 30  # input + cacheWrite
    assert phase_run.tokens_out == 50
    assert phase_run.cache_read == 200
    assert phase_run.session_log == Path(str(session_log))
    assert phase_run.duration_s is not None
    assert phase_run.duration_s >= 0


# ─── 2. Rejected verdict ───────────────────────────────────────────────


def test_run_phase_returns_phaserun_for_rejected_verdict():
    """A rejected verdict → ``PhaseRun`` with status="reject" and the issues in details."""
    flow = _builder_flow()
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="builder", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    fake_rpc = {
        "success": True,
        "output": "fake output",
        "session_log": None,
        "result": {
            "status": "rejected",
            "issues": ["Missing type hints", "No docstring"],
            "verdict": "",
        },
    }
    with patch.object(phase_runner, "run_rpc_with_session_log", return_value=fake_rpc), \
         patch.object(phase_runner, "build_prompt", return_value=("prompt", [])), \
         patch.object(phase_runner, "_build_session_dir", return_value=None):
        phase_run = run_phase("builder", flow, ctx, state, term, gh, log=log)

    assert phase_run.status == "reject"
    assert "Missing type hints" in phase_run.details
    assert "No docstring" in phase_run.details
    assert phase_run.tokens_in is None  # no session log


# ─── 3. is_optional exception path ─────────────────────────────────────


def test_run_phase_is_optional_exception_becomes_skipped_style_success():
    """``is_optional`` phase that raises → status="success" with "non-blocking" in details."""
    flow = _make_flow(
        phases={
            "retrospective": {
                "skill": "/skill:retro",
                "is_optional": True,
                "retries": 1,
                "timeout_seconds": 60,
            },
        },
    )
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="retrospective", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    with patch.object(phase_runner, "_run_phase_inner", side_effect=RuntimeError("LLM exploded")), \
         patch.object(phase_runner, "build_prompt", return_value=("prompt", [])):
        phase_run = run_phase("retrospective", flow, ctx, state, term, gh, log=log)

    # Non-fatal downgrade: exception → synthetic success
    assert phase_run.status == "success"
    assert "non-blocking" in phase_run.details
    assert "LLM exploded" in phase_run.details
    # The phase_end event lands in the logger (downgraded path)
    phase_end_events = [ev for ev in log.events if ev.kind == "phase_end"]
    assert len(phase_end_events) == 1
    assert phase_end_events[0].phase == "retrospective"
    assert "Failed (non-fatal)" in phase_end_events[0].message


# ─── 4. is_optional error-return path ──────────────────────────────────


def test_run_phase_is_optional_error_return_becomes_success():
    """``is_optional`` phase that returns ``status="error"`` → status="success" with "downgraded"."""
    flow = _make_flow(
        phases={
            "retrospective": {
                "skill": "/skill:retro",
                "is_optional": True,
                "retries": 1,
                "timeout_seconds": 60,
            },
        },
    )
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="retrospective", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    fake_inner = MagicMock(return_value=(
        {"status": "error", "details": "verdict extractor failed"},
        "/tmp/session.jsonl",
    ))
    with patch.object(phase_runner, "_run_phase_inner", fake_inner), \
         patch.object(phase_runner, "build_prompt", return_value=("prompt", [])):
        phase_run = run_phase("retrospective", flow, ctx, state, term, gh, log=log)

    assert phase_run.status == "success"
    assert "downgraded" in phase_run.details
    assert "verdict extractor failed" in phase_run.details
    phase_end_events = [ev for ev in log.events if ev.kind == "phase_end"]
    assert len(phase_end_events) == 1
    assert "Returned error (non-fatal, downgraded)" in phase_end_events[0].message


# ─── 5. is_local command success ───────────────────────────────────────


def test_run_phase_is_local_command_success():
    """``is_local: true`` with a successful command → ``PhaseRun`` with status="success"."""
    flow = _make_flow(
        phases={
            "smoke": {
                "is_local": True,
                "command": "echo done",
                "retries": 1,
                "timeout_seconds": 30,
            },
        },
    )
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="smoke", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    phase_run = run_phase("smoke", flow, ctx, state, term, gh, log=log)

    assert phase_run.status == "success"
    assert "Local command succeeded" in phase_run.details
    # is_local phases have no session log → tokens all None
    assert phase_run.tokens_in is None
    assert phase_run.tokens_out is None
    assert phase_run.cache_read is None
    assert phase_run.session_log is None


# ─── 6. is_local command non-zero exit ─────────────────────────────────


def test_run_phase_is_local_command_nonzero_exit():
    """``is_local: true`` with a non-zero exit code → ``PhaseRun`` with status="reject"."""
    flow = _make_flow(
        phases={
            "smoke": {
                "is_local": True,
                "command": "false",  # always exits with code 1
                "retries": 1,
                "timeout_seconds": 30,
            },
        },
    )
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="smoke", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    phase_run = run_phase("smoke", flow, ctx, state, term, gh, log=log)

    assert phase_run.status == "reject"
    assert "Local command failed" in phase_run.details
    assert "1" in phase_run.details  # the non-zero exit code


# ─── 7. Close phase with block policy and missing evidence ─────────────


def test_run_phase_close_with_block_policy_and_missing_evidence():
    """Close phase + ``block`` policy + no evidence → ``PhaseRun`` with status="reject"."""
    flow = _close_flow(policy="block")
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="close", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    # Use a temp evidence dir to isolate from any on-disk state
    with tempfile.TemporaryDirectory() as td:
        evidence_dir = Path(td) / "evidence"
        with patch.object(phase_runner, "EvidenceStore") as mock_store:
            # Default evidence check returns (False, [...missing types...])
            mock_store.return_value.check.return_value = (False, ["tested", "reviewed"])
            # Construct a flow with evidence_dir override for isolation
            phase_run = run_phase("close", flow, ctx, state, term, gh, log=log)

    assert phase_run.status == "reject"
    assert "Missing evidence (block policy)" in phase_run.details
    # block policy does NOT emit any log events
    assert log.events == []


# ─── 8. Close phase with warn_but_proceed ──────────────────────────────


def test_run_phase_close_with_warn_but_proceed_emits_evidence_warn():
    """Close phase + ``warn_but_proceed`` + no evidence → success + 2 evidence_warn events."""
    flow = _close_flow(policy="warn_but_proceed")
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="close", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    with patch.object(phase_runner, "EvidenceStore") as mock_store:
        mock_store.return_value.check.return_value = (False, ["tested", "reviewed"])
        phase_run = run_phase("close", flow, ctx, state, term, gh, log=log)

    assert phase_run.status == "success"
    assert "Missing evidence (warned)" in phase_run.details
    warns = [ev for ev in log.events if ev.kind == "evidence_warn"]
    assert len(warns) == 2
    assert "Missing evidence" in warns[0].message
    assert "warn_but_proceed" in warns[1].message


# ─── 9. Tokens: log missing ────────────────────────────────────────────


def test_run_phase_tokens_none_when_log_missing():
    """If the RPC returns no ``session_log`` path, all three token fields are ``None``."""
    flow = _builder_flow()
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="builder", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    fake_rpc = {
        "success": True,
        "output": "fake output",
        "session_log": None,
        "result": {"status": "approved"},
    }
    with patch.object(phase_runner, "run_rpc_with_session_log", return_value=fake_rpc), \
         patch.object(phase_runner, "build_prompt", return_value=("prompt", [])), \
         patch.object(phase_runner, "_build_session_dir", return_value=None):
        phase_run = run_phase("builder", flow, ctx, state, term, gh, log=log)

    assert phase_run.tokens_in is None
    assert phase_run.tokens_out is None
    assert phase_run.cache_read is None
    assert phase_run.session_log is None


# ─── 10. Tokens: log has no usage ──────────────────────────────────────


def test_run_phase_tokens_none_when_log_has_no_usage():
    """If the session log has no ``message.usage`` block, all three token fields are ``None``."""
    flow = _builder_flow()
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="builder", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    with tempfile.TemporaryDirectory() as td:
        session_log = Path(td) / "no-usage.jsonl"
        _write_synthetic_session_log(session_log, None)  # no usage block

        fake_rpc = {
            "success": True,
            "output": "fake output",
            "session_log": str(session_log),
            "result": {"status": "approved"},
        }
        with patch.object(phase_runner, "run_rpc_with_session_log", return_value=fake_rpc), \
             patch.object(phase_runner, "build_prompt", return_value=("prompt", [])), \
             patch.object(phase_runner, "_build_session_dir", return_value=None):
            phase_run = run_phase("builder", flow, ctx, state, term, gh, log=log)

    assert phase_run.tokens_in is None
    assert phase_run.tokens_out is None
    assert phase_run.cache_read is None


# ─── 11. Tokens: is_local phase ────────────────────────────────────────


def test_run_phase_is_local_phase_has_none_tokens():
    """``is_local`` phases (e.g. close) have no session log → all three token fields are ``None``."""
    flow = _close_flow(policy="ignore")
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="close", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    with patch.object(phase_runner, "EvidenceStore") as mock_store:
        mock_store.return_value.check.return_value = (True, [])
        phase_run = run_phase("close", flow, ctx, state, term, gh, log=log)

    assert phase_run.status == "success"
    assert phase_run.tokens_in is None
    assert phase_run.tokens_out is None
    assert phase_run.cache_read is None
    assert phase_run.session_log is None


# ─── 12. Tokens: populated from session log (the happy path) ──────────


def test_run_phase_populates_tokens_from_session_log():
    """``tokens_in`` / ``tokens_out`` / ``cache_read`` populated from the log's usage block."""
    flow = _builder_flow()
    ctx = _make_flow_context(flow)
    state = PhaseState(current_phase="builder", phase_attempt=1)
    term, gh = _make_term_and_gh()
    log = ListLogger()

    with tempfile.TemporaryDirectory() as td:
        session_log = Path(td) / "session.jsonl"
        _write_synthetic_session_log(session_log, {
            "input": 100,
            "output": 50,
            "cacheRead": 200,
            "cacheWrite": 30,
            "totalTokens": 380,
        })

        fake_rpc = {
            "success": True,
            "output": "fake output",
            "session_log": str(session_log),
            "result": {"status": "approved"},
        }
        with patch.object(phase_runner, "run_rpc_with_session_log", return_value=fake_rpc), \
             patch.object(phase_runner, "build_prompt", return_value=("prompt", [])), \
             patch.object(phase_runner, "_build_session_dir", return_value=None):
            phase_run = run_phase("builder", flow, ctx, state, term, gh, log=log)

    # The field mapping: tokens_in = input + cacheWrite
    assert phase_run.tokens_in == 130
    assert phase_run.tokens_out == 50
    assert phase_run.cache_read == 200


# ─── Custom test runner ────────────────────────────────────────────────


tests = [
    test_run_phase_returns_phaserun_for_approved_verdict,
    test_run_phase_returns_phaserun_for_rejected_verdict,
    test_run_phase_is_optional_exception_becomes_skipped_style_success,
    test_run_phase_is_optional_error_return_becomes_success,
    test_run_phase_is_local_command_success,
    test_run_phase_is_local_command_nonzero_exit,
    test_run_phase_close_with_block_policy_and_missing_evidence,
    test_run_phase_close_with_warn_but_proceed_emits_evidence_warn,
    test_run_phase_tokens_none_when_log_missing,
    test_run_phase_tokens_none_when_log_has_no_usage,
    test_run_phase_is_local_phase_has_none_tokens,
    test_run_phase_populates_tokens_from_session_log,
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
