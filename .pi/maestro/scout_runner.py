#!/usr/bin/env python3
"""
scout_runner.py — Scout phase setup work, extracted from
``flow_engine.py`` (issue #34).

The scout phase runs **synchronously** before the main phase loop, as
the 7th step of :func:`flow_dispatcher.build_flow_context`. It's an
opt-in per-flow concern (``scout_enabled: true`` in the flow JSON)
that:

  1. Builds a minimal :class:`~flow_engine.FlowContext` from the
     dispatcher's working state
  2. Calls :func:`phase_runner.run_phase` with ``phase_name="scout"``
  3. Parses the ``### PHASE_OUTPUT`` block from the raw LLM output
  4. Persists the findings (or failure) to working memory
  5. Returns the parsed findings dict (or ``None`` on any failure)

Failure is non-fatal: a failing scout must never block the pipeline.
The builder proceeds with placeholder markdown when scout fails.

Why this lives in its own module (not :mod:`flow_engine`):

  * The deep-module contract of :mod:`flow_engine` is
    :func:`run_flow` + the value objects + a handful of small
    helpers. Adding 150 lines of scout-specific code (RPC call,
    findings parser, memory persistence) would dilute that.
  * The dispatcher already imports several private symbols from
    :mod:`flow_engine` (``_scout_enabled``, ``_format_repo_context``,
    ``_extract_parent_issue``); routing the scout helper through
    here keeps the import graph tidy.
  * The tests (``test_flow_engine_logging.py`` and
    ``test_flow_dispatcher.py``) already patch
    ``flow_engine._run_scout_phase``; this module keeps the same
    function name (re-exported below) so the existing patches
    continue to work.

Public API:
    - ``_run_scout_phase(flow_config, issue_num, context, memory_store, log)``
    - ``_build_scout_flow_context(flow, issue_num, context, memory_store)``
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

# Add lib to path (matches the convention used by flow_engine.py and
# phase_runner.py)
_LIB_DIR = Path(__file__).parent / "lib"
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import flow_logger as _flow_logger  # noqa: E402
from flow_engine import (  # noqa: E402
    Flow,
    FlowContext,
    PhaseState,
    WorkingMemory,
)
from flow_logger import FlowEvent, FlowLogger  # noqa: E402
from github_client import GithubClient  # noqa: E402
from scout_findings import parse_scout_findings_from_details  # noqa: E402
from terminal import Terminal  # noqa: E402
from working_memory import MemoryStore  # noqa: E402


def _resolve_log(log: Optional[FlowLogger]) -> FlowLogger:
    """Return the provided logger, or a fresh :class:`StderrLogger`."""
    return log if log is not None else _flow_logger.StderrLogger()


def _build_scout_flow_context(
    flow: "Flow",
    issue_num: int,
    context: dict,
    memory_store: MemoryStore,
) -> "FlowContext":
    """Build a minimal :class:`FlowContext` for the scout phase.

    The dispatcher already has the full :class:`FlowContext`; this
    helper exists for :func:`_run_scout_phase` (which only has the
    legacy ``context`` dict + :class:`MemoryStore`) so the typed
    :func:`phase_runner.run_phase` can be called. Every optional
    field defaults to ``None``; ``issue_body`` is read from
    ``context["prompt"]`` (the dispatcher sets that to
    ``"## Issue #N\\n\\n<body>"``).
    """
    prompt_md = context.get("prompt", "") or ""
    body = ""
    if prompt_md.startswith(f"## Issue #{issue_num}"):
        body = prompt_md.split("\n\n", 1)[-1] if "\n\n" in prompt_md else ""
    parent_prd = context.get("prd_body")
    try:
        working_memory = memory_store.load()
    except Exception:
        working_memory = WorkingMemory(
            issue=issue_num, created_at=_flow_logger.now_iso()
        )
    return FlowContext(
        flow=flow,
        issue_num=issue_num,
        issue_body=body,
        issue_title="",
        parent_prd=parent_prd,
        working_memory=working_memory,
    )


def _run_scout_phase(
    flow_config: dict,
    issue_num: int,
    context: dict,
    memory_store: MemoryStore,
    log: Optional[FlowLogger] = None,
) -> Optional[dict]:
    """Run the scout phase synchronously and return parsed findings
    (or ``None``).

    Behaviour:
        * **Success**: parses the ``PHASE_OUTPUT`` block, persists
          the findings to working memory, returns the parsed dict.
        * **Failure** (reject / error / non-parseable output): logs
          a ``[scout] {status}: {details}`` line + a fallback
          message, persists the failure to working memory for the
          retrospective phase, and returns ``None``. The builder
          proceeds with the placeholder markdown (no findings).

    This function is intentionally non-raising: a failing scout
    must never block the pipeline.
    """
    # Deferred import: ``phase_runner`` imports the value objects
    # from :mod:`flow_engine` at load time, so we have to import it
    # lazily here to avoid a circular import.
    from phase_runner import run_phase as _phase_runner_run_phase

    scout_timeout = flow_config.get("scout_timeout_seconds", 240)

    _log = _resolve_log(log)
    _log.emit(FlowEvent(
        kind="scout_complete",
        message=(
            f"Running scout phase on issue #{issue_num} "
            f"(timeout={scout_timeout}s)"
        ),
        timestamp=_flow_logger.now_iso(),
        phase="scout",
    ))

    # Build the typed inputs :func:`phase_runner.run_phase` expects,
    # then re-shape the returned :class:`PhaseRun` back into the
    # ``(status, details, raw_output, session_log)`` tuple this
    # helper historically returned.
    from flow_engine import _flow_from_config  # late: avoid cycle
    flow = _flow_from_config(flow_config)
    flow_context = _build_scout_flow_context(flow, issue_num, context, memory_store)
    state = PhaseState(current_phase="scout", phase_attempt=1)
    term = Terminal(verbose=False)
    gh = GithubClient()

    phase_run = _phase_runner_run_phase(
        "scout", flow, flow_context, state, term, gh, log=_log,
    )
    status = phase_run.status
    details = phase_run.details or ""
    # ``phase_run.output`` is the raw LLM output (preserved by issue
    # #45's ``PhaseRun.output`` field). We need the verbatim text to
    # parse the ``### PHASE_OUTPUT: success`` block — ``details`` is
    # the synthesised "scout approved" / "scout rejected: ..." string
    # produced by the verdict extractor, which does not contain the
    # JSON payload the scout emitted.
    raw_output = phase_run.output or phase_run.details or ""
    session_log_path = str(phase_run.session_log) if phase_run.session_log else None

    if status != "success":
        # Non-fatal: log and proceed without findings
        short = details[:300].replace("\n", " ")
        # ``scout_complete`` covers every post-run scout outcome
        # that isn't a clean skip. ``scout_skipped`` is reserved
        # for the case where the flow disabled scout up front
        # (handled in the dispatcher) — by the time we reach this
        # code path, scout actually ran and produced a non-success
        # verdict.
        _log.emit(FlowEvent(
            kind="scout_complete",
            message=f"{status}: {short}",
            timestamp=_flow_logger.now_iso(),
            phase="scout",
        ))
        _log.emit(FlowEvent(
            kind="scout_complete",
            message="Builder will proceed without scout findings",
            timestamp=_flow_logger.now_iso(),
            phase="scout",
        ))
        try:
            memory_store.update_phase("scout", {
                "status": status,
                "details": details[:1000],
                "session_log": str(session_log_path) if session_log_path else "",
            })
        except Exception as mem_err:
            # Memory persistence is best-effort — never crash the
            # flow.
            _log.emit(FlowEvent(
                kind="memory_warn",
                message=f"Failed to persist failure to working memory: {mem_err}",
                timestamp=_flow_logger.now_iso(),
                phase="scout",
            ))
        return None

    # Success — parse the PHASE_OUTPUT block from the raw LLM output
    findings = parse_scout_findings_from_details(raw_output)

    if "parse_error" in findings:
        # The scout succeeded but its output wasn't structured —
        # still log it.
        err = findings.get("parse_error", "unknown")
        _log.emit(FlowEvent(
            kind="scout_complete",
            message=f"Output was unparseable ({err[:200]})",
            timestamp=_flow_logger.now_iso(),
            phase="scout",
        ))
        _log.emit(FlowEvent(
            kind="scout_complete",
            message="Builder will proceed with raw findings",
            timestamp=_flow_logger.now_iso(),
            phase="scout",
        ))

    # Persist (raw findings dict, possibly with parse_error envelope)
    # to memory.
    try:
        memory_store.update_phase("scout", {
            "status": "success",
            "details": details[:1000],
            "raw_output": raw_output[:2000],
            "findings": findings,
            "session_log": str(session_log_path) if session_log_path else "",
        })
    except Exception as mem_err:
        _log.emit(FlowEvent(
            kind="memory_warn",
            message=f"Failed to persist findings to working memory: {mem_err}",
            timestamp=_flow_logger.now_iso(),
            phase="scout",
        ))

    return findings


__all__ = [
    "_build_scout_flow_context",
    "_run_scout_phase",
]
