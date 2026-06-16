#!/usr/bin/env python3
"""
test_diagnostic.py — Unit tests for diagnostic.run_diagnostic.

Covers the diagnostic pass function that lives in :mod:`diagnostic`
(deepening PRD issue #33). The new contract: typed ``Flow`` /
``Terminal`` / ``GithubClient`` / ``FlowLogger`` inputs, a
``{"status": "success" | "failed", "analysis": …}`` dict on the way
out. The RPC layer and the session-dir builder are stubbed so the
tests run without a ``pi`` binary or on-disk session logs.

Each test exercises one observable behaviour of the new shape:

  * ``test_build_diagnostic_prompt_contains_issue_and_failure_context``
    — the prompt string carries the right issue number and a JSON
    dump of the failure context.
  * ``test_run_diagnostic_returns_success_when_rpc_succeeds``
    — RPC returns ``success=True`` and a verdict → ``status="success"``
    and ``analysis`` carries the output excerpt.
  * ``test_run_diagnostic_returns_failed_when_rpc_fails``
    — RPC returns ``success=False`` → ``status="failed"`` and
    ``analysis`` carries the error output excerpt.
  * ``test_run_diagnostic_session_dir_is_standard_location``
    — the session dir passed to the RPC is the standard location
    (built by ``_build_session_dir`` with ``phase_name="diagnostic"``).

The tests stub the RPC layer (``run_rpc_with_session_log``) and the
session-dir builder (``_build_session_dir``) so they run without a
``pi`` binary or network access. The ``Terminal`` and
``GithubClient`` are constructed as no-op / MagicMock instances
matching the pattern in :mod:`test_phase_runner`.

Run with: ``python3 tests/test_diagnostic.py`` (custom runner)
       or ``python3 -m pytest tests/test_diagnostic.py`` (pytest)
"""

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add lib + parent dir to path so we can import diagnostic,
# phase_runner and flow_engine.
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

from terminal import Terminal  # noqa: E402
from github_client import GithubClient  # noqa: E402

import diagnostic  # noqa: E402
import flow_engine  # noqa: E402
import phase_runner  # noqa: E402  (the session-dir builder lives here)
from diagnostic import _build_diagnostic_prompt, run_diagnostic  # noqa: E402
from flow_engine import Flow  # noqa: E402
from flow_logger import ListLogger  # noqa: E402


# ─── Shared fixtures ────────────────────────────────────────────────────


def _make_flow(name: str = "test-flow") -> Flow:
    """Build a :class:`Flow` value object with a ``diagnostic`` phase.

    The diagnostic phase config block carries the fields
    :func:`run_diagnostic` reads (``timeout_seconds``, ``model``,
    ``provider``) so the tests can assert on the call into the RPC
    layer.
    """
    return Flow(
        name=name,
        description="",
        scout_enabled=False,
        evidence_policy={"on_missing_evidence": "ignore"},
        phases={
            "builder": {"skill": "/skill:tdd", "retries": 1, "timeout_seconds": 60},
            "diagnostic": {
                "timeout_seconds": 120,
                "model": "sonnet",
                "provider": "anthropic",
            },
        },
        transitions=(),
    )


def _make_term_and_gh() -> tuple:
    """Build a no-op :class:`Terminal` and a :class:`GithubClient` mock.

    :func:`run_diagnostic` does not currently use either — both are
    kept on the signature for the future label-update / comment-
    dispatch slices, mirroring :func:`phase_runner.run_phase`'s
    approach. The tests construct them so the signature is fully
    populated.
    """
    term = Terminal()
    gh = MagicMock(spec=GithubClient)
    return term, gh


def _make_failure_context(failed_phase: str = "builder") -> dict:
    """Build a representative failure context for the diagnostic prompt."""
    return {
        "failed_phase": failed_phase,
        "output_summary": "Build failed: missing type hints on Foo.bar",
    }


# ─── 1. Prompt shape ────────────────────────────────────────────────────


def test_build_diagnostic_prompt_contains_issue_and_failure_context():
    """The prompt carries the right issue number and a JSON dump of
    the failure context.

    The diagnostic pass is a focused LLM call — if the prompt drops
    the issue number or the failure context, the model's analysis
    is grounded in nothing. This test pins the prompt shape.
    """
    flow = _make_flow(name="my-flow")
    issue_num = 42
    failure_context = _make_failure_context(failed_phase="reviewer")

    prompt = _build_diagnostic_prompt(flow, issue_num, failure_context)

    # Issue number is surfaced.
    assert "#42" in prompt, f"Expected '#42' in prompt, got: {prompt!r}"
    # Flow name is surfaced so the model knows which flow is in scope.
    assert "my-flow" in prompt, f"Expected 'my-flow' in prompt, got: {prompt!r}"
    # Failure context is dumped as JSON with the failed_phase key.
    assert "reviewer" in prompt, (
        f"Expected 'reviewer' (the failed phase) in prompt, got: {prompt!r}"
    )
    # The serialized context key 'failed_phase' is present (proves
    # the JSON dump is in there, not just the value).
    assert "failed_phase" in prompt, (
        f"Expected the 'failed_phase' key in the JSON dump, got: {prompt!r}"
    )
    # The output summary is also surfaced.
    assert "missing type hints" in prompt, (
        f"Expected the output_summary in prompt, got: {prompt!r}"
    )
    # And the prompt is non-empty / has the expected header.
    assert "## DIAGNOSTIC PHASE" in prompt, (
        f"Expected '## DIAGNOSTIC PHASE' header in prompt, got: {prompt!r}"
    )


# ─── 2. RPC success → success result ───────────────────────────────────


def test_run_diagnostic_returns_success_when_rpc_succeeds():
    """RPC returns success=True with a verdict → ``{"status": "success",
    "analysis": <output excerpt>}``.
    """
    flow = _make_flow()
    term, gh = _make_term_and_gh()
    log = ListLogger()
    failure_context = _make_failure_context()

    fake_rpc = {
        "success": True,
        "output": "DIAGNOSTIC: The reviewer rejected because type hints are missing.",
        "session_log": None,
        "result": {"status": "completed"},
    }
    with patch.object(diagnostic, "run_rpc_with_session_log", return_value=fake_rpc) as mock_rpc, \
         patch("phase_runner._build_session_dir", return_value=None):
        result = run_diagnostic(
            flow, 42, failure_context, term, gh, log=log,
        )

    # Shape: success status with the RPC output as the analysis excerpt.
    assert result["status"] == "success"
    assert "type hints are missing" in result["analysis"]
    # The RPC was called once with the right phase name.
    assert mock_rpc.call_count == 1
    call_args = mock_rpc.call_args
    # First positional arg is the prompt, second is the phase name.
    assert call_args.args[0].startswith("## DIAGNOSTIC PHASE"), (
        f"Expected diagnostic prompt as first arg, got: {call_args.args[0]!r}"
    )
    assert call_args.args[1] == "diagnostic", (
        f"Expected phase_name='diagnostic', got: {call_args.args[1]!r}"
    )
    # The diagnostic phase config drives the timeout/model/provider.
    # ``timeout`` is passed positionally as the 3rd arg (the
    # ``timeout_seconds`` parameter on ``run_rpc_with_session_log``),
    # so we read it from ``args`` not ``kwargs``.
    assert call_args.args[2] == 120, (
        f"Expected timeout=120 from diagnostic phase config, got: {call_args.args[2]!r}"
    )
    assert call_args.kwargs.get("model") == "sonnet"
    assert call_args.kwargs.get("provider") == "anthropic"


# ─── 3. RPC failure → failed result ────────────────────────────────────


def test_run_diagnostic_returns_failed_when_rpc_fails():
    """RPC returns ``success=False`` → ``{"status": "failed",
    "analysis": <error excerpt>}``.
    """
    flow = _make_flow()
    term, gh = _make_term_and_gh()
    log = ListLogger()
    failure_context = _make_failure_context()

    fake_rpc = {
        "success": False,
        "output": "RPC error: pi binary not found in PATH",
        "session_log": None,
        "result": {},
    }
    with patch.object(diagnostic, "run_rpc_with_session_log", return_value=fake_rpc), \
         patch("phase_runner._build_session_dir", return_value=None):
        result = run_diagnostic(
            flow, 42, failure_context, term, gh, log=log,
        )

    # Shape: failed status with the error output as the analysis excerpt.
    assert result["status"] == "failed"
    assert "pi binary not found" in result["analysis"]


# ─── 4. Session log path is the standard location ──────────────────────


def test_run_diagnostic_session_dir_is_standard_location():
    """The session dir passed to the RPC is the standard location
    built by :func:`phase_runner._build_session_dir` with
    ``phase_name="diagnostic"``.

    The diagnostic session log must live alongside the other phase
    session logs (same directory layout) so operators can find it
    in the same place they look for builder / reviewer / close
    session logs. This test pins the path-builder contract: the
    diagnostic module must route the session-dir construction
    through the shared helper (not build its own ad-hoc path) and
    must forward the result to the RPC layer.
    """
    flow = _make_flow(name="builder-reviewer")
    term, gh = _make_term_and_gh()
    log = ListLogger()
    failure_context = _make_failure_context()

    # Stub ``_build_session_dir`` on the ``phase_runner`` module —
    # the diagnostic module does ``from phase_runner import
    # _build_session_dir`` lazily inside the function body, so a
    # patch on ``phase_runner`` is the right level. The stub returns
    # a deterministic path so we can assert on the call chain
    # without touching the real filesystem.
    standard_path = "/sessions/42/builder-reviewer-diagnostic-2026-06-15T12:00:00.jsonl"
    fake_rpc = {
        "success": True,
        "output": "Diagnostic analysis text",
        "session_log": standard_path,
        "result": {"status": "completed"},
    }
    with patch.object(diagnostic, "run_rpc_with_session_log", return_value=fake_rpc) as mock_rpc, \
         patch("phase_runner._build_session_dir", return_value=standard_path) as mock_session_dir:
        result = run_diagnostic(
            flow, 42, failure_context, term, gh, log=log,
        )

    # The session-dir builder was called with the diagnostic phase
    # name and the right flow / issue number.
    assert mock_session_dir.call_count == 1
    call_args = mock_session_dir.call_args
    assert call_args.args[0] == "builder-reviewer", (
        f"Expected flow name as first arg, got: {call_args.args[0]!r}"
    )
    assert call_args.args[1] == 42, (
        f"Expected issue num as second arg, got: {call_args.args[1]!r}"
    )
    assert call_args.args[2] == "diagnostic", (
        f"Expected phase name 'diagnostic' as third arg, got: {call_args.args[2]!r}"
    )

    # And the RPC call received the standard path as its session_dir
    # kwarg, proving the diagnostic module forwards the location
    # rather than building its own.
    assert result["status"] == "success"
    assert mock_rpc.call_count == 1
    session_dir_kw = mock_rpc.call_args.kwargs.get("session_dir")
    assert session_dir_kw == standard_path, (
        f"Expected session_dir={standard_path!r}, got: {session_dir_kw!r}"
    )
