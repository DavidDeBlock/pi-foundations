#!/usr/bin/env python3
"""
diagnostic.py — Diagnostic pass for the flow engine.

Extracted from ``flow_engine.py`` (deepening PRD issue #33). Owns the
"run a diagnostic LLM call to analyze a failed phase" concern. The
phase loop in :func:`flow_engine.run_flow_on_issue` calls
:func:`run_diagnostic` directly when a transition routes through the
``diagnostic`` phase (or when a phase returns ``status="error"``).

This is a **loop-level concern**, not a **phase-level concern** — the
diagnostic phase is dispatched by the loop's transition logic, not
by :func:`phase_runner.run_phase`. The issue specifically calls this
out: the routing stays in the flow loop, not the per-phase function.
This module exists to extract the *implementation* of the diagnostic
pass (prompt building + RPC call + result shaping) into its own
small, testable unit.

What lives here:

- :func:`run_diagnostic` — the public entry. Builds the prompt, calls
  :func:`rpc_client.run_rpc_with_session_log` with ``phase_name=
  "diagnostic"``, and returns ``{"status": "success" | "failed",
  "analysis": <output snippet>}``.
- :func:`_build_diagnostic_prompt` — private helper that turns the
  :class:`Flow` / issue number / failure context into the prompt
  text. The prompt was previously inlined in ``flow_engine.py`` as a
  multi-line f-string; moving it here keeps :func:`run_diagnostic`
  scannable and lets the tests assert on the prompt shape in
  isolation.

What stays in ``flow_engine.py``:

- The phase loop itself (:func:`run_flow_on_issue`).
- The diagnostic-routing branch in the loop still calls
  :func:`run_diagnostic` — the routing is a loop concern; the
  implementation is now here.
- The value-object dataclasses (:class:`Flow`, :class:`FlowContext`,
  :class:`PhaseState`, :class:`PhaseRun`, :class:`FlowOutcome`,
  :class:`PhaseConfig`, :class:`Transition`).

Circular-import handling: this module imports :class:`Flow` from
:mod:`flow_engine` at the top. That direction is safe — ``flow_engine``
does NOT import from :mod:`diagnostic` at module load time. The loop
in :func:`flow_engine.run_flow_on_issue` uses a deferred import
(``from diagnostic import run_diagnostic``) inside the function body
to break the cycle, mirroring the pattern used for
:func:`phase_runner.run_phase`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

# Add lib to path (matches the convention used by flow_engine.py and
# phase_runner.py — keeps ``from rpc_client import …`` working
# regardless of how the module is invoked).
_LIB_DIR = Path(__file__).parent / "lib"
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import flow_logger as _flow_logger  # noqa: E402  (StderrLogger for diagnostic events)
from flow_engine import Flow  # noqa: E402  (typed value object)
from flow_logger import FlowEvent, FlowLogger  # noqa: E402
from github_client import GithubClient  # noqa: E402
from rpc_client import run_rpc_with_session_log  # noqa: E402
from terminal import Terminal  # noqa: E402


def _build_diagnostic_prompt(
    flow: Flow,
    issue_num: int,
    failure_context: dict,
) -> str:
    """Build the prompt text sent to the LLM for the diagnostic pass.

    The prompt is intentionally short — the diagnostic phase is
    meant to be a lightweight, focused LLM call that reads the
    previous phase's session log and produces actionable insights
    for the next retry. The flow name and issue number are surfaced
    so the model can ground its analysis in the right context.

    Args:
        flow: The :class:`Flow` value object. ``flow.name`` is
            included in the prompt header so the model knows which
            flow is in scope.
        issue_num: The GitHub issue number the flow is running on.
        failure_context: A ``dict`` with the keys ``failed_phase``
            and ``output_summary`` describing the failure the
            diagnostic pass is meant to analyse.

    Returns:
        The full prompt text. Multi-line f-string with the issue
        number, failure context (as a JSON block), and a short
        instruction asking for actionable insights.
    """
    return (
        f"## DIAGNOSTIC PHASE\n"
        f"Flow: {flow.name}\n"
        f"Issue: #{issue_num}\n"
        f"Failure Context: {json.dumps(failure_context, indent=2)}\n\n"
        f"Analyze the session logs and identify why the previous phase failed.\n"
        f"Provide specific actionable insights for the next retry attempt."
    )


def _resolve_log(log: Optional[FlowLogger]) -> FlowLogger:
    """Return the provided logger, or a fresh :class:`StderrLogger`.

    Mirrors the helper in :mod:`flow_engine` — when no logger is
    provided we still want a working default so terminal users see
    the ``[diagnostic] …`` line. The default is constructed lazily
    to avoid a ``sys.stderr`` reference at import time.
    """
    return log if log is not None else _flow_logger.StderrLogger()


def run_diagnostic(
    flow: Flow,
    issue_num: int,
    failure_context: dict,
    term: Terminal,
    gh: GithubClient,
    log: FlowLogger,
) -> dict:
    """Run a diagnostic pass to analyze what went wrong on a phase.

    Behaviour:

    1. Builds the diagnostic prompt from ``flow``, ``issue_num`` and
       ``failure_context`` via :func:`_build_diagnostic_prompt`.
    2. Looks up the diagnostic phase's config (``flow.phases[
       "diagnostic"]``) for ``timeout_seconds``, ``model`` and
       ``provider`` overrides.
    3. Builds a session log path (the same standard location every
       phase uses — :func:`phase_runner._build_session_dir`).
    4. Calls :func:`rpc_client.run_rpc_with_session_log` with
       ``phase_name="diagnostic"`` and the session dir. The RPC
       client handles the actual ``pi --mode rpc`` spawn and verdict
       extraction.
    5. Shapes the RPC result into a uniform
       ``{"status": "success" | "failed", "analysis": …}`` dict for
       the phase loop to consume.

    Args:
        flow: The :class:`Flow` value object for the running flow.
            ``flow.name`` is used for the session dir and prompt
            header; ``flow.phases["diagnostic"]`` is the per-phase
            config block.
        issue_num: The GitHub issue number the flow is running on.
        failure_context: A ``dict`` describing the failure — usually
            ``{"failed_phase": <str>, "output_summary": <str>}``.
        term: The :class:`Terminal` (kept on the signature for
            future label-update / comment-dispatch slices; currently
            only used to print a verbose line).
        gh: The :class:`GithubClient` (kept on the signature for
            the same future slices; currently unused inside
            :func:`run_diagnostic`).
        log: The :class:`FlowLogger` port. Receives a
            ``kind="diagnostic"`` event announcing the session dir.

    Returns:
        A ``dict`` with two keys:

        - ``status``: ``"success"`` if the RPC call completed and
          returned a verdict, ``"failed"`` if the RPC call itself
          failed.
        - ``analysis``: a short string. On success, a 1000-char
          excerpt of the RPC output. On failure, a 1000-char excerpt
          of the RPC error output. When the RPC succeeded but no
          structured verdict was found, the analysis carries a
          ``"Diagnostic completed but no structured verdict
          found: …"`` prefix.
    """
    _log = _resolve_log(log)
    term._print_verbose(f"[DIAGNOSTIC] Analyzing failure on issue #{issue_num}")

    diag_prompt = _build_diagnostic_prompt(flow, issue_num, failure_context)

    diag_config = flow.phases["diagnostic"]
    timeout = diag_config.get("timeout_seconds", 600)
    model = diag_config.get("model")
    provider = diag_config.get("provider")

    # Build the session log path via the same helper the phase
    # runner uses, so the diagnostic session lives alongside the
    # other phase sessions. Lazy import — ``phase_runner`` imports
    # value objects from ``flow_engine`` at load time, and we
    # already import from ``flow_engine`` at the top of this file,
    # so a top-level import of ``phase_runner`` would form a cycle.
    from phase_runner import _build_session_dir

    session_dir = _build_session_dir(flow.name, issue_num, "diagnostic")
    if session_dir:
        _log.emit(FlowEvent(
            kind="diagnostic",
            message=f"Diagnostic session dir: {session_dir}",
            timestamp=_flow_logger.now_iso(),
            phase="diagnostic",
        ))

    rpc_result = run_rpc_with_session_log(
        diag_prompt, "diagnostic", timeout,
        model=model, provider=provider,
        session_dir=session_dir,
        flow_name=flow.name,
        issue_num=issue_num,
    )

    # Extract verdict info from result dict (new error state format)
    status_data = rpc_result.get("result", {}) or {}
    phase_status = status_data.get("status")

    if not rpc_result["success"]:
        return {
            "status": "failed",
            "analysis": f"RPC failed: {rpc_result.get('output', '')[:1000]}",
        }

    # If verdict extraction returned an error, surface it in the analysis
    if phase_status == "error":
        details = status_data.get("details", "No verdict extracted")
        return {
            "status": "success",
            "analysis": (
                f"Diagnostic completed but no structured verdict found: {details}. "
                f"Raw output: {rpc_result.get('output', '')[:800]}"
            ),
        }

    # Standard verdict — include details in analysis when available
    return {
        "status": "success",
        "analysis": rpc_result.get("output", "")[:1000],
    }
