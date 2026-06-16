#!/usr/bin/env python3
"""
flow_engine.py - Core execution engine for a single flow on a single issue.

Handles:
- Issue metadata fetching & header display
- Phase loop with per-phase retry counters
- Session log parsing & inline metadata rendering
- GitHub comment gating (first rejection + final success)
- Terminal tree layout output

Note on module split (deepening PRD issue #31):
- The per-phase function (``run_phase``) and its inner helpers
  (``_run_phase_inner``, ``_build_session_dir``,
  ``_extract_phase_tokens``, ``_populate_retrospective_context``,
  ``_persist_retrospective_result``, the close-phase
  ``run_close_phase`` / ``_close_phase_result``, the evidence
  policy helpers) now live in :mod:`phase_runner`.
- This module keeps the phase loop (:func:`run_flow_on_issue`),
  the prompt builder (:func:`build_prompt`), the diagnostic pass
  (:func:`run_diagnostic`), and the value-object dataclasses.
- ``phase_runner.run_phase`` is imported lazily inside
  :func:`run_flow_on_issue` and :func:`_run_scout_phase` to avoid
  a circular import (phase_runner imports value objects from
  here at module load time).
"""

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent / "lib"))

from terminal import Terminal
from github_client import GithubClient
from session_reader import parse_session_log
import flow_logger as _flow_logger  # noqa: E402  (StderrLogger for token events)
from prompt_loader import load_prompt, PERMISSIVE_FALLBACK
from working_memory import MemoryStore, WorkingMemory
from context_prefetch import (
    prefetch_context,
    format_prefetched_context,
    PrefetchedContext,
)
from scout_findings import (
    parse_scout_findings_from_details,
    format_scout_findings_markdown,
)
from projects_registry import (  # noqa: E402
    REGISTRY_FILENAME as PROJECTS_REGISTRY_FILENAME,
    ProjectsRegistry,
)


# ─── Logging port (per deepening PRD issue #30) ─────────────────────────
#
# The runner emits structured :class:`flow_logger.FlowEvent` objects through
# a :class:`flow_logger.FlowLogger` port. The default adapter is
# :class:`StderrLogger` — it renders each event as
# ``[<phase>] <kind>: <message>`` on ``sys.stderr`` so terminal users see
# the same per-line layout they got from the pre-refactor
# ``print(..., file=sys.stderr)`` calls.
#
# Functions in this module that need to emit a :class:`FlowEvent` take
# an optional ``log: Optional[FlowLogger]`` keyword. When omitted, the
# default :class:`StderrLogger` is used (so existing tests and call
# sites that don't care about logging still get a working terminal
# line). The entry point :func:`run_flow_on_issue` constructs an
# explicit logger and passes it through the call chain, so a future
# CLI flag can swap in a :class:`FileLogger` for operator-mode
# debugging without touching the helpers below.


def _resolve_log(log: Optional["FlowLogger"]) -> "FlowLogger":
    """Return the provided logger, or a fresh :class:`StderrLogger`.

    The default is constructed lazily on first call to avoid a
    ``sys.stderr`` reference at import time (matches the
    ``StderrLogger`` adapter's own design — it dereferences
    ``sys.stderr`` at emit time, not at construction).
    """
    return log if log is not None else _flow_logger.StderrLogger()


# NOTE: the per-phase evidence-policy code (``DEFAULT_EVIDENCE_POLICY``,
# ``get_evidence_policy``, ``_close_phase_result``, ``run_close_phase``)
# moved to :mod:`phase_runner` (deepening PRD issue #31). The close
# phase is dispatched from inside :func:`phase_runner.run_phase`, so
# keeping the evidence-policy code with the runner is the right home.


def _maybe_get_working_memory(issue_num: int, context: dict) -> dict:
    """Return a working-memory view for inclusion in the prompt.

    Prefers ``context["working_memory"]`` if already populated by
    ``run_flow_on_issue`` (which loads it once per flow and refreshes it
    after each phase). Falls back to a fresh load from disk on cache miss
    so phases don't lose context if the in-memory dict is stale.
    """
    wm = context.get("working_memory")
    if isinstance(wm, dict):
        return wm
    try:
        return MemoryStore(issue_num).load().to_dict()
    except Exception:
        return {"issue": issue_num}


def _maybe_get_prefetched_context(context: dict) -> str:
    """Return the prefetched-context markdown for inclusion in the prompt."""
    pc = context.get("prefetched_context_md")
    if isinstance(pc, str) and pc:
        return pc
    return ""


def _format_repo_context(repo_entry: dict) -> dict:
    """Build the ``context["repo_context"]`` dict from a registry entry.

    Picks the fields the builder prompt needs to render
    ``{repo_context}`` — alias, languages, commands, evidence strategy,
    conventions, gotchas, recommended playbooks. Defensive against
    missing or extra fields (a corrupt registry entry must not crash
    the flow).

    Args:
        repo_entry: A registry entry dict (the value side of the
            ``{hash: entry}`` projects.json map).

    Returns:
        A flat dict with the keys the builder prompt expects. Missing
        fields become safe defaults (empty list / empty string).
    """
    if not isinstance(repo_entry, dict):
        return {}

    def _list(key: str) -> list:
        value = repo_entry.get(key, [])
        return list(value) if isinstance(value, list) else []

    def _str(key: str) -> str:
        value = repo_entry.get(key, "")
        return str(value) if value is not None else ""

    return {
        "alias": _str("alias"),
        "path": _str("path"),
        "languages": _list("languages"),
        "package_manager": _str("package_manager"),
        "test_command": _str("test_command"),
        "build_command": _str("build_command"),
        "lint_command": _str("lint_command"),
        "frameworks": _list("frameworks"),
        "evidence_strategy": _str("evidence_strategy"),
        "conventions": _list("conventions"),
        "gotchas": _list("gotchas"),
        "playbooks_recommended": _list("playbooks_recommended"),
        "primary_reviewer": _str("primary_reviewer"),
    }


# ─── Scout phase ──────────────────────────────────────────────────────────


def _scout_enabled(flow_config: dict) -> bool:
    """Return True iff the flow has scout enabled and a ``scout`` phase defined.

    Per the scout PRD, scout is **opt-in per flow** via the ``scout_enabled``
    flag. The phase itself must also be present in ``phases`` — a flow with
    the flag set but no ``scout`` phase is treated as disabled.
    """
    if not flow_config.get("scout_enabled", False):
        return False
    if "scout" not in flow_config.get("phases", {}):
        return False
    return True


def _initial_phase(flow_config: dict, skip_scout: bool = False) -> Optional[str]:
    """Return the first phase to execute, optionally skipping ``scout``.

    Used to keep scout out of the main phase loop when it has already been
    attempted synchronously by :func:`_run_scout_phase`. Falls back to
    ``None`` if the flow has no phases.
    """
    phases = list(flow_config.get("phases", {}).keys())
    if not phases:
        return None
    if skip_scout and phases[0] == "scout":
        phases = phases[1:]
    return phases[0] if phases else None


def _run_scout_phase(
    flow_config: dict,
    issue_num: int,
    context: dict,
    memory_store: MemoryStore,
    log: Optional["FlowLogger"] = None,
) -> Optional[dict]:
    """Run the scout phase synchronously and return parsed findings (or ``None``).

    Behaviour:
        - **Success**: parses the ``PHASE_OUTPUT`` block, persists the
          findings to working memory, returns the parsed dict.
        - **Failure (reject / error / non-parseable output)**: logs a
          ``[scout] {status}: {details}`` line + a fallback message, persists
          the failure to working memory for the retrospective phase, and
          returns ``None``. The builder proceeds with the placeholder
          markdown (no findings).

    This function is intentionally non-raising: a failing scout must never
    block the pipeline.
    """
    # Deferred import: ``phase_runner`` imports the value objects from
    # this module at load time, so we have to import it lazily here to
    # avoid a circular import.
    from phase_runner import run_phase as _phase_runner_run_phase

    scout_timeout = flow_config.get("scout_timeout_seconds", 240)

    _log = _resolve_log(log)
    _log.emit(_flow_logger.FlowEvent(
        kind="scout_complete",
        message=f"Running scout phase on issue #{issue_num} (timeout={scout_timeout}s)",
        timestamp=_flow_logger.now_iso(),
        phase="scout",
    ))

    # Build the typed inputs ``phase_runner.run_phase`` expects, then
    # re-shape the returned ``PhaseRun`` back into the legacy
    # ``(result_dict, session_log_path)`` tuple this helper historically
    # returned. The re-shape is the only place the legacy
    # ``result["output"]`` key is constructed (it carried the raw LLM
    # text so the scout findings parser could read the
    # ``### PHASE_OUTPUT`` block).
    flow = _flow_from_config(flow_config)
    flow_context = _build_scout_flow_context(flow, issue_num, context, memory_store)
    state = PhaseState(current_phase="scout", phase_attempt=1)
    term = Terminal(verbosity=0)
    gh = GithubClient()

    phase_run = _phase_runner_run_phase(
        "scout", flow, flow_context, state, term, gh, log=_log,
    )
    status = phase_run.status
    details = phase_run.details or ""
    raw_output = phase_run.details or ""
    session_log_path = str(phase_run.session_log) if phase_run.session_log else None

    if status != "success":
        # Non-fatal: log and proceed without findings
        short = details[:300].replace("\n", " ")
        # ``scout_complete`` covers every post-run scout outcome that
        # isn't a clean skip. ``scout_skipped`` is reserved for the
        # case where the flow disabled scout up front (handled in the
        # dispatcher) — by the time we reach this code path, scout
        # actually ran and produced a non-success verdict.
        _log.emit(_flow_logger.FlowEvent(
            kind="scout_complete",
            message=f"{status}: {short}",
            timestamp=_flow_logger.now_iso(),
            phase="scout",
        ))
        _log.emit(_flow_logger.FlowEvent(
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
            # flow. Emits a ``memory_warn`` event with the ``[scout]``
            # phase prefix preserved so the existing operator log
            # format stays scannable.
            _log.emit(_flow_logger.FlowEvent(
                kind="memory_warn",
                message=f"Failed to persist failure to working memory: {mem_err}",
                timestamp=_flow_logger.now_iso(),
                phase="scout",
            ))
        return None

    # Success — parse the PHASE_OUTPUT block from the raw LLM output
    findings = parse_scout_findings_from_details(raw_output)

    if "parse_error" in findings:
        # The scout succeeded but its output wasn't structured — still log it
        err = findings.get("parse_error", "unknown")
        _log.emit(_flow_logger.FlowEvent(
            kind="scout_complete",
            message=f"Output was unparseable ({err[:200]})",
            timestamp=_flow_logger.now_iso(),
            phase="scout",
        ))
        _log.emit(_flow_logger.FlowEvent(
            kind="scout_complete",
            message="Builder will proceed with raw findings",
            timestamp=_flow_logger.now_iso(),
            phase="scout",
        ))

    # Persist (raw findings dict, possibly with parse_error envelope) to memory
    try:
        memory_store.update_phase("scout", {
            "status": "success",
            "details": details[:1000],
            "raw_output": raw_output[:2000],  # cap to keep memory file bounded
            "findings": findings,
            "session_log": str(session_log_path) if session_log_path else "",
        })
    except Exception as mem_err:
        _log.emit(_flow_logger.FlowEvent(
            kind="memory_warn",
            message=f"Failed to persist findings to working memory: {mem_err}",
            timestamp=_flow_logger.now_iso(),
            phase="scout",
        ))

    return findings


def _build_scout_flow_context(
    flow: "Flow",
    issue_num: int,
    context: dict,
    memory_store: MemoryStore,
) -> "FlowContext":
    """Build a minimal :class:`FlowContext` for the scout phase.

    The dispatcher already has the full :class:`FlowContext`; this
    helper exists for ``_run_scout_phase`` (which only has the legacy
    ``context`` dict + ``MemoryStore``) so the typed
    :func:`phase_runner.run_phase` can be called. Every optional field
    defaults to ``None``; ``issue_body`` is read from
    ``context["prompt"]`` (the dispatcher sets that to
    ``"## Issue #N\n\n<body>"``).
    """
    prompt_md = context.get("prompt", "") or ""
    body = ""
    if prompt_md.startswith(f"## Issue #{issue_num}"):
        body = prompt_md.split("\n\n", 1)[-1] if "\n\n" in prompt_md else ""
    parent_prd = context.get("prd_body")
    try:
        working_memory = memory_store.load()
    except Exception:
        working_memory = WorkingMemory(issue=issue_num, created_at=_flow_logger.now_iso())
    return FlowContext(
        flow=flow,
        issue_num=issue_num,
        issue_body=body,
        issue_title="",
        parent_prd=parent_prd,
        working_memory=working_memory,
    )


def get_next_step(transitions: list, current_phase: str, status: str) -> Optional[str]:
    """Determine the next step based on transitions and phase status."""
    for t in transitions:
        if t.get("from") == current_phase:
            key = f"on_{status}"
            if key in t:
                return t[key]
    return None


def _print_prompt_debug(
    phase_name: str,
    issue_num: int,
    template_exists: bool,
    variables: dict,
    prompt: str,
    extra_context: str,
    log: Optional["FlowLogger"] = None,
):
    """Print debug info about the built prompt via the FlowLogger port.

    Each [DEBUG] line from the pre-refactor implementation maps to a
    single ``phase_start`` event with ``phase=phase_name``. The
    StderrLogger renders the same first-line prefix and emits the
    full message verbatim, so terminal output stays stable. The
    separator lines (``=========``) get their own events so the
    framing is preserved line-for-line.
    """
    _log = _resolve_log(log)
    _ts = _flow_logger.now_iso()

    def _emit(line: str) -> None:
        _log.emit(_flow_logger.FlowEvent(
            kind="phase_start",
            message=line,
            timestamp=_ts,
            phase=phase_name,
        ))

    _emit("")
    _emit("=" * 60)
    _emit(f"[DEBUG] Phase: {phase_name} | Issue: #{issue_num}")
    _emit(f"[DEBUG] Template loaded: {'YES' if template_exists else 'NO (fallback)'}")

    # Show variable values (truncated for readability)
    for key, value in variables.items():
        display = value[:200] + "..." if len(value) > 200 else value
        _emit(f"[DEBUG]   {key} = '{display}'")

    # Show extra context (diagnostic or previous_output)
    if extra_context:
        display = extra_context[:300] + "..." if len(extra_context) > 300 else extra_context
        _emit(f"[DEBUG]   Context preview: '{display}'")

    # Prompt stats
    lines = prompt.split('\n')
    _emit(f"[DEBUG] Prompt: {len(prompt)} chars, {lines.__len__()} lines")
    if len(lines) > 0:
        _emit(f"[DEBUG] First line: '{lines[0].strip()[:100]}'")
    _emit("=" * 60)


def build_prompt(phase_name: str, phase_config: dict, flow_config: dict, issue_num: int, context: dict, log: Optional["FlowLogger"] = None) -> Tuple[str, list[str]]:
    """Build a prompt for the given phase and return its tool allowlist.

    Loads the prompt from ``prompts/<phase_name>.md`` (preferred) or
    ``prompts/<phase_name>.tmpl`` (legacy, with deprecation warning) via
    :func:`prompt_loader.load_prompt`. Variable substitution (``{issue_number}``,
    ``{issue_body}``, etc.) is applied to the loaded body. The resolved tool
    list is returned alongside the prompt text so callers can forward it to
    the RPC layer.

    Returns:
        Tuple of ``(prompt_text, tools_list)``.
    """
    skill = phase_config.get("skill", "")

    _log = _resolve_log(log)
    _ts = _flow_logger.now_iso()

    # Determine prompt source
    if not skill:
        # No phase prefix — this is a config-time warning, not a
        # per-attempt phase event. ``phase_start`` is still the
        # closest matching kind in the closed enum.
        _log.emit(_flow_logger.FlowEvent(
            kind="phase_start",
            message=f"[WARN] Phase '{phase_name}' has no 'skill' configured in flow config.",
            timestamp=_ts,
            phase=phase_name,
        ))

    prompt_dir = Path(__file__).parent / "prompts"
    explicit_tools = phase_config.get("tools")

    try:
        loaded = load_prompt(prompt_dir, phase_name, explicit_tools)
    except ValueError as exc:
        # Malformed frontmatter — surface the error but keep the flow alive
        # by falling back to a minimal default prompt + permissive tools.
        _log.emit(_flow_logger.FlowEvent(
            kind="phase_start",
            message=f"[ERROR] {exc}",
            timestamp=_ts,
            phase=phase_name,
        ))
        prompt = f"## Phase: {phase_name}\n## Issue: #{issue_num}\n\n[prompt loader error — see stderr]\n"
        return prompt, list(PERMISSIVE_FALLBACK)

    if loaded.deprecation_warning:
        _log.emit(_flow_logger.FlowEvent(
            kind="phase_start",
            message=f"[DEPRECATION] {loaded.deprecation_warning}",
            timestamp=_ts,
            phase=phase_name,
        ))

    prompt = loaded.body

    # Inject variables from context
    issue_body = context.get("prompt", f"## Issue #{issue_num}\n\nPlease execute this phase.")
    working_memory = _maybe_get_working_memory(issue_num, context)
    prefetched_md = _maybe_get_prefetched_context(context)
    scout_findings_value = context.get("scout_findings_md")
    if scout_findings_value is None:
        # Backward-compatible default when scout is not enabled for this flow
        scout_findings_value = "(Scout disabled for this flow.)"
    variables = {
        "{issue_number}": str(issue_num),
        "{diagnostic_insights}": context.get("diagnostic_insights", ""),
        "{previous_output}": context.get("previous_output", ""),
        "{prd_body}": context.get("prd_body", ""),
        "{issue_body}": issue_body,
        "{prefetched_context}": prefetched_md,
        "{working_memory_json}": json.dumps(working_memory, indent=2, ensure_ascii=False),
        "{scout_findings}": scout_findings_value,
        # Retrospective-specific variables. Defaults are safe — the
        # prompt can substitute them in any phase without crashing.
        "{flow_name}": context.get("flow_name", flow_config.get("name", "unknown")),
        "{final_status}": context.get("final_status", "unknown"),
        "{repo_path}": context.get("repo_path", str(Path.cwd())),
        "{evidence_summary}": context.get("evidence_summary", "(no evidence summary)"),
        "{learnings_excerpt}": context.get("learnings_excerpt", "(no previous learnings)"),
        # Wave 2 — Repo Onboarding. Renders the ``## Repo Context``
        # section of the builder prompt. Empty dict when the repo
        # hasn't been onboarded (or the registry is unavailable).
        "{repo_context}": json.dumps(
            context.get("repo_context", {}),
            indent=2,
            ensure_ascii=False,
        ),
    }
    for key, value in variables.items():
        prompt = prompt.replace(key, value)

    # Inject local command or skill directive
    if phase_config.get("is_local"):
        cmd = phase_config.get("command", "")
        prompt += f"\n\n**LOCAL COMMAND TO RUN:** `{cmd}`"
        _log.emit(_flow_logger.FlowEvent(
            kind="phase_start",
            message=f"Running local command: {cmd}",
            timestamp=_flow_logger.now_iso(),
            phase=phase_name,
        ))
    elif skill:
        prompt += f"\n\n**SKILL TO USE:** `{skill}`"
        _log.emit(_flow_logger.FlowEvent(
            kind="phase_start",
            message=f"Invoking skill: {skill}",
            timestamp=_flow_logger.now_iso(),
            phase=phase_name,
        ))

    # DEBUG: Show what was built
    extra = context.get("diagnostic_insights", "") or context.get("previous_output", "")
    if context.get("prd_body"):
        extra = f"PRD ({len(context['prd_body'])} chars) | {extra[:200]}"
    _print_prompt_debug(
        phase_name, issue_num, loaded.source_format != "default", variables, prompt, extra, log=_log
    )

    return prompt, loaded.tools


def run_diagnostic(term: Terminal, flow_config: dict, issue_num: int, failure_context: dict, log: Optional["FlowLogger"] = None) -> dict:
    """Run a diagnostic pass to analyze what went wrong."""
    term._print_verbose(f"[DIAGNOSTIC] Analyzing failure on issue #{issue_num}")

    diag_prompt = f"""## DIAGNOSTIC PHASE
Issue: #{issue_num}
Failure Context: {json.dumps(failure_context, indent=2)}

Analyze the session logs and identify why the previous phase failed.
Provide specific actionable insights for the next retry attempt."""

    diag_config = flow_config["phases"]["diagnostic"]
    timeout = diag_config.get("timeout_seconds", 600)
    model = diag_config.get("model")
    provider = diag_config.get("provider")

    # Build session directory for diagnostic runs too
    flow_name = flow_config.get("name", "unknown")
    session_dir = _build_session_dir(flow_name, issue_num, "diagnostic")
    _log = _resolve_log(log)
    if session_dir:
        _log.emit(_flow_logger.FlowEvent(
            kind="diagnostic",
            message=f"Diagnostic session dir: {session_dir}",
            timestamp=_flow_logger.now_iso(),
            phase="diagnostic",
        ))

    rpc_result = run_rpc_with_session_log(
        diag_prompt, "diagnostic", timeout,
        model=model, provider=provider,
        session_dir=session_dir
    )

    # Extract verdict info from result dict (new error state format)
    status_data = rpc_result.get("result", {})
    phase_status = status_data.get("status")

    if not rpc_result["success"]:
        return {
            "status": "failed",
            "analysis": f"RPC failed: {rpc_result.get('output', '')[:1000]}"
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
    verdict_details = status_data.get("verdict", "") or status_data.get("issues", [])
    return {
        "status": "success",
        "analysis": rpc_result.get("output", "")[:1000],
    }


def load_flow(name: str) -> dict:
    """Load a flow configuration from JSON file with defaults applied."""
    FLOWS_DIR = Path(__file__).parent / "flows"
    flow_file = FLOWS_DIR / f"{name}.json"

    if not flow_file.exists():
        print(f"[ERROR] Flow '{name}' not found at {flow_file}", file=sys.stderr)
        sys.exit(1)

    with open(flow_file) as f:
        config = json.load(f)

    if "phases" not in config or "transitions" not in config:
        print(f"[ERROR] Invalid flow configuration in {flow_file}", file=sys.stderr)
        sys.exit(1)

    for transition in config["transitions"]:
        if transition.get("from") and transition["from"] not in config["phases"]:
            print(f"[ERROR] Phase '{transition['from']}' referenced in transitions but not defined", file=sys.stderr)
            sys.exit(1)

    default_retries = 3
    default_timeout = 1800
    flow_provider = config.get("default_provider")

    for phase_name, phase_config in config["phases"].items():
        # Local-only phases (e.g. the ``close`` evidence-gate phase) don't
        # call an LLM, so ``retries`` and ``model`` are meaningless for them.
        # We skip the warnings and still inject a safe default so other
        # code paths that read these fields don't crash.
        is_local = bool(phase_config.get("is_local"))

        if "retries" not in phase_config:
            if not is_local:
                print(f"[WARN] Phase '{phase_name}' missing 'retries' field - applying default: {default_retries}", file=sys.stderr)
                sys.stderr.flush()
            config["phases"][phase_name]["retries"] = 1
        elif phase_config["retries"] < 1:
            print(f"[ERROR] Phase '{phase_name}' has invalid retries: {phase_config['retries']} (must be >= 1)", file=sys.stderr)
            sys.exit(1)

        if "timeout_seconds" not in phase_config:
            config["phases"][phase_name]["timeout_seconds"] = default_timeout

        # Apply model/provider defaults from flow-level or hardcoded fallbacks
        if "model" not in phase_config and not is_local:
            print(f"[WARN] Phase '{phase_name}' missing 'model' field", file=sys.stderr)
            sys.stderr.flush()

        if "provider" not in phase_config and flow_provider:
            config["phases"][phase_name]["provider"] = flow_provider

    return config


def _flow_from_config(flow_config: dict) -> "Flow":
    """Build a :class:`Flow` value object from the dict returned by
    :func:`load_flow`.

    Used by the :func:`~flow_dispatcher.build_flow_context` shim to
    convert the raw config into the typed value object. ``phases`` and
    ``transitions`` are kept in their dict / list form here (the
    dispatcher only reads ``flow.scout_enabled`` and ``flow.name``;
    deeper extraction of ``PhaseConfig`` / ``Transition`` happens in a
    later slice when the runner narrows to typed inputs).

    Args:
        flow_config: The dict returned by :func:`load_flow` (post-
            validation, post-defaults).

    Returns:
        A :class:`Flow` instance. The ``phases`` and ``transitions``
        fields mirror the dict's structure; ``evidence_policy`` is
        passed through.
    """
    return Flow(
        name=flow_config.get("name", ""),
        description=flow_config.get("description", ""),
        scout_enabled=bool(flow_config.get("scout_enabled", False)),
        evidence_policy=dict(flow_config.get("evidence_policy") or {}),
        phases=dict(flow_config.get("phases") or {}),
        transitions=tuple(flow_config.get("transitions") or ()),
    )


def _extract_parent_issue(body: str) -> Optional[int]:
    """Extract parent issue number from body if formatted as '## Parent\n\n#NNN'."""
    import re
    match = re.search(r'^##\s*Parent\s*\n\s*#(\d+)', body, re.MULTILINE)
    return int(match.group(1)) if match else None


def run_flow_on_issue(
    term: Terminal,
    gh_client: GithubClient,
    flow_name: str,
    issue_num: int,
    initial_context: Optional[dict] = None,
    phase_callback=None,
) -> bool:
    """
    Run a specific flow on a single GitHub issue.
    Returns True if completed successfully, False otherwise.

    This is a thin shim. The setup work (issue metadata, parent PRD,
    working memory, prefetch, repo context, scout) lives in
    :func:`flow_dispatcher.build_flow_context`; the still-unrefactored
    phase loop below consumes the dict context the shim rebuilds from
    the :class:`~flow_engine.FlowContext` value object.

    Behaviour is identical to the pre-extraction code path; the slice
    is a pure refactor.
    """
    from flow_dispatcher import build_flow_context

    flow_config = load_flow(flow_name)
    flow = _flow_from_config(flow_config)
    flow_context = build_flow_context(flow, issue_num, gh_client)

    # Display the issue header (preserves the pre-extraction terminal
    # output). On a fully-successful issue fetch, all three kwargs are
    # populated; on partial / failed fetches the dispatcher leaves
    # ``comments_count`` at 0 and ``created_at`` at None, which mirrors
    # the original fallback path (``term.issue_header(issue_num)`` with
    # no kwargs).
    term.issue_header(
        issue_num,
        title=flow_context.issue_title,
        comments_count=flow_context.comments_count,
        created_at=flow_context.created_at,
    )

    # ── Rebuild the dict context the still-unrefactored phase loop
    #    expects. The keys here must match the pre-extraction code path
    #    exactly so the phase loop, prompt builder, and scout refresh
    #    continue to work. The :class:`FlowContext` value object is the
    #    new typed contract; this dict is the legacy shim.
    body = flow_context.issue_body
    context = {"prompt": f"## Issue #{issue_num}\n\n{body}"}
    if flow_context.parent_prd:
        context["prd_body"] = flow_context.parent_prd
    if initial_context:
        context.update(initial_context)

    context["working_memory"] = flow_context.working_memory.to_dict()
    context["prefetched_context_md"] = format_prefetched_context(flow_context.prefetched)
    context["prefetched_context"] = flow_context.prefetched
    if flow_context.repo_context:
        context["repo_context"] = flow_context.repo_context
    # Match the pre-extraction behaviour: set ``scout_findings_md`` IFF
    # scout was attempted for this flow (i.e. ``_scout_enabled`` is
    # True). When scout is disabled the key is left unset, and the
    # prompt builder falls back to ``"(Scout disabled for this flow.)"``.
    # When scout ran and failed, ``flow_context.scout_findings`` is
    # ``None`` but the key IS set, so the prompt gets the
    # ``"## Scout Findings" + no-findings`` message — that is the
    # signal the integration tests rely on.
    if _scout_enabled(flow_config):
        context["scout_findings_md"] = format_scout_findings_markdown(flow_context.scout_findings)

    # The dispatcher persisted git_sha/repo_path on the WorkingMemory
    # reference it returned; the dict snapshot above was taken before
    # the post-scout refresh in :func:`build_flow_context`. Reload
    # here so the phase loop sees the post-scout memory if scout ran.
    if _scout_enabled(flow_config):
        try:
            context["working_memory"] = MemoryStore(issue_num).load().to_dict()
        except Exception:
            pass

    # The phase loop needs a :class:`MemoryStore` to persist per-phase
    # results to working memory. The dispatcher created one internally;
    # we recreate one here so the loop's ``update_phase`` calls
    # (post-#31, the loop owns the persistence step rather than the
    # phase runner) have a handle.
    memory_store = MemoryStore(issue_num)

    # Main execution loop for this specific issue
    max_iterations = 50
    iteration_count = 0
    current_phase = _initial_phase(flow_config, skip_scout=True)
    if current_phase is None:
        # Edge case: scout was the only phase in the flow
        term._print_verbose("[ERROR] Flow has no phases to run after scout")
        return False
    phase_attempt_count = 1
    first_rejection_posted = False
    completed_successfully = False
    test_fail_count = 0  # tracks consecutive test_runner rejections for escalation

    # ── Token observability (per deepening PRD issue #29) ──
    # Track per-phase ``PhaseRun`` records and aggregate totals. The
    # ``FlowOutcome`` is built at the end of the run. We use a
    # ``StderrLogger`` for the per-phase ``tokens_recorded`` event so
    # operators see ``[builder] tokens: in=N out=M cache=K`` in the
    # terminal. The outcome is not returned yet — that change is part
    # of a later interface-narrowing slice.
    #
    # Per the deepening PRD issue #30, this same ``StderrLogger`` is
    # the default ``FlowLogger`` for the entire run. Every helper
    # below (``run_phase``, ``run_diagnostic``, ``_persist_retrospective_result``)
    # receives it via the ``log=`` keyword. The variable name kept
    # here for the per-phase ``tokens_recorded`` event matches the
    # pre-#30 code, but it's now the run-wide FlowLogger.
    phase_runs: list = []
    total_tokens_in: int = 0
    total_tokens_out: int = 0
    run_start = time.monotonic()
    _log = _flow_logger.StderrLogger()

    # Deferred import: ``phase_runner`` imports value objects from
    # this module at load time, so a top-level import here would
    # circular-import. The function is bound to a local name for
    # readability.
    from phase_runner import run_phase as _phase_runner_run_phase

    while iteration_count < max_iterations:
        iteration_count += 1
        next_step = None  # reset each iteration; escalation may set it before transition lookup

        # ── Build the typed ``PhaseState`` for this iteration ──
        # Carry forward any ``phase_outputs`` the previous iteration
        # wrote (e.g. the close phase's verdict, read by retrospective).
        # The :class:`PhaseState` is the ONE mutable value object —
        # the phase runner mutates ``phase_outputs`` etc. in place and
        # the loop reads them back.
        _state = PhaseState(
            current_phase=current_phase,
            phase_attempt=phase_attempt_count,
            previous_output=context.get("previous_output", ""),
            diagnostic_insights=context.get("diagnostic_insights", ""),
            phase_outputs=context.get("phase_outputs") or {},
        )

        phase_run = _phase_runner_run_phase(
            current_phase, flow, flow_context, _state, term, gh_client, log=_log,
        )

        # Re-shape the typed ``PhaseRun`` back into the legacy
        # ``(result_dict, session_log_path)`` tuple the rest of the
        # loop consumes. This keeps the rest of the loop unchanged
        # and lets the new ``PhaseRun`` be the canonical record
        # appended to ``phase_runs`` below.
        result = {
            "status": phase_run.status,
            "details": phase_run.details,
            "output": phase_run.details,
            "tokens_in": phase_run.tokens_in,
            "tokens_out": phase_run.tokens_out,
            "cache_read": phase_run.cache_read,
        }
        session_log_path = str(phase_run.session_log) if phase_run.session_log else None

        # Propagate the per-iteration mutations back to the legacy
        # context dict so the (still-dict-based) prompt builder reads
        # the same state it would have in the pre-refactor code path.
        # This is the "shim back" half of the typed ↔ dict bridge.
        if _state.phase_outputs:
            context["phase_outputs"] = dict(_state.phase_outputs)
        if _state.diagnostic_insights:
            context["diagnostic_insights"] = _state.diagnostic_insights
        if _state.previous_output:
            context["previous_output"] = _state.previous_output

        term._print_verbose(f"[PHASE] {current_phase} -> {result['status']}")
        # Mirror the verbose line as a structured ``phase_end`` event
        # (issue #30). The kind is ``phase_end`` per the issue's
        # mapping table; the message carries the same "{phase} ->
        # {status}" text the terminal verbose print uses, so the
        # ``FlowLogger`` JSONL has the same information.
        _log.emit(_flow_logger.FlowEvent(
            kind="phase_end",
            message=f"{current_phase} -> {result['status']}",
            timestamp=_flow_logger.now_iso(),
            phase=current_phase,
        ))

        max_retries = flow_config["phases"][current_phase].get("retries", 3)
        is_retry = phase_attempt_count > 1

        term.attempt_start(current_phase, phase_attempt_count, max_retries)

        # Parse session log for inline metadata
        if session_log_path:
            try:
                summary = parse_session_log(session_log_path)
                model = summary.get("model")
                duration = summary.get("duration_seconds", 0)
                file_ops = summary.get("file_operations", [])
                written = len([op for op in file_ops if op["status"] == "success"])
                failed = len([op for op in file_ops if op["status"] == "failed"])
                term.attempt_metadata(
                    model=model,
                    duration_seconds=duration,
                    file_ops_written=written,
                    file_ops_failed=failed
                )
            except Exception as e:
                term._print_verbose(f"[WARNING] Failed to parse session log: {e}")

        # Handle phase result
        if result["status"] == "success":
            term.phase_approved(current_phase, is_retry=is_retry)
        elif result["status"] == "no_gaps":
            term._print_verbose(f"[NO_GAPS] {current_phase}: No significant gaps found - finishing.")
        elif result["status"] == "reject":
            if not first_rejection_posted:
                gh_client.post_phase_comment(
                    issue_num=issue_num,
                    phase=current_phase,
                    status="rejected",
                    details=result.get("details", "")[:300]
                )
                first_rejection_posted = True
            term.feedback(result.get("details", ""))
        elif result["status"] == "error":
            term._print_verbose(f"[ERROR] Phase error: {result.get('details', 'Unknown')}")
            term.failure(f"{current_phase} failed with error")
            gh_client.post_phase_comment(
                issue_num=issue_num,
                phase=current_phase,
                status="error",
                details=result.get("details", "Error executing phase")[:300]
            )

        # ── Persist phase result to working memory ──
        # Update the named phase's section with a structured summary so
        # the next phase (or a future retry) can read what happened. Errors
        # get a separate append so the retrospective phase can scan them
        # without re-parsing the phase output.
        try:
            phase_data = {
                "status": result["status"],
                "attempt": phase_attempt_count,
                "details": (result.get("details", "") or "")[:1000],
                "session_log": str(session_log_path) if session_log_path else "",
            }
            memory = memory_store.update_phase(current_phase, phase_data)
            if result["status"] in ("error",):
                memory_store.append_error(
                    current_phase,
                    result.get("details", "Unknown error"),
                )
            # Refresh the in-memory copy so the next phase sees the latest
            # state without needing to hit disk again. The legacy
            # ``context`` dict (used by the dict-based prompt builder)
            # and the typed :class:`FlowContext` (used by
            # :func:`phase_runner.run_phase`) both need the same
            # refresh.
            context["working_memory"] = memory.to_dict()
            flow_context = replace(flow_context, working_memory=memory)
        except Exception as mem_err:
            # Memory persistence is best-effort — never crash the flow.
            term._print_verbose(f"[memory] Failed to update working memory: {mem_err}")

        # ── Token observability (per deepening PRD issue #29) ──
        # Build a ``PhaseRun`` value object for this attempt, update the
        # running totals, and emit two ``FlowEvent``s through the
        # ``FlowLogger`` port:
        #   - ``phase_end`` carries the raw token dict so the file-based
        #     ``FileLogger`` JSONL (when wired in by a later slice) has
        #     the data; ``StderrLogger`` shows the standard message and
        #     ignores the dict.
        #   - ``tokens_recorded`` is the operator-friendly summary that
        #     ``StderrLogger`` renders as ``[phase] tokens: in=N out=M
        #     cache=K`` (per the PRD). Only emitted when we have a usage
        #     block — phases without a session log (close, local cmds)
        #     have no tokens to report.
        _event_ts = _flow_logger.now_iso()
        # Use the typed ``PhaseRun`` returned by
        # :func:`phase_runner.run_phase` directly — it already carries
        # the canonical token / session_log / duration / details data.
        _phase_run = phase_run
        phase_runs.append(_phase_run)
        if _phase_run.tokens_in is not None:
            total_tokens_in += _phase_run.tokens_in
        if _phase_run.tokens_out is not None:
            total_tokens_out += _phase_run.tokens_out

        _token_dict = {
            "in": _phase_run.tokens_in,
            "out": _phase_run.tokens_out,
            "cache": _phase_run.cache_read,
        }
        # phase_end — always emitted (for the structured JSONL log)
        _log.emit(_flow_logger.FlowEvent(
            kind="phase_end",
            message=f"{current_phase} {result['status']}",
            timestamp=_event_ts,
            phase=current_phase,
            attempt=phase_attempt_count,
            duration_s=None,
            tokens=_token_dict if _phase_run.tokens_in is not None else None,
        ))
        # tokens_recorded — only when we have usage data, and only via
        # the StderrLogger (file JSONL already carries the dict on the
        # phase_end event). This is the operator's terminal-visible
        # per-phase totals line.
        if _phase_run.tokens_in is not None:
            _log.emit(_flow_logger.FlowEvent(
                kind="tokens_recorded",
                message="",
                timestamp=_event_ts,
                phase=current_phase,
                attempt=phase_attempt_count,
                duration_s=None,
                tokens=_token_dict,
            ))

        # ── Fire phase callback (for deterministic label management) ──
        if phase_callback:
            try:
                phase_callback(
                    phase_name=current_phase,
                    status=result["status"],
                    attempt_count=phase_attempt_count,
                    details=result.get("details", ""),
                )
            except Exception as cb_err:
                term._print_verbose(f"[WARNING] Phase callback error: {cb_err}")

        # ── Test failure escalation tracking ──
        if current_phase == "test_runner" and result["status"] == "reject":
            test_fail_count += 1
            max_rejects = flow_config["phases"].get("test_runner", {}).get(
                "max_rejects_before_diagnostic", 2
            )
            if test_fail_count >= max_rejects:
                term._print_verbose(
                    f"[TEST_ESCALATION] test_runner failed {test_fail_count} times — "
                    f"routing to diagnostic (threshold: {max_rejects})"
                )
                # Override transition: force diagnostic instead of builder
                next_step = "diagnostic"
            else:
                term._print_verbose(
                    f"[TEST_RETRY] test_runner failed ({test_fail_count}/{max_rejects}) — "
                    f"sending output to builder for fix"
                )
        elif current_phase != "test_runner":
            # Reset counter when we leave test_runner phase
            if test_fail_count > 0:
                test_fail_count = 0

        # Determine next step from transitions (only if escalation didn't already set it)
        if next_step is None:
            next_step = get_next_step(flow_config["transitions"], current_phase, result["status"])

        if not next_step:
            term._print_verbose(f"[ERROR] No transition defined for {current_phase} -> {result['status']}")
            # Structured log mirror (issue #30) — ``phase_end`` with
            # the failing phase and the unresolved status.
            _log.emit(_flow_logger.FlowEvent(
                kind="phase_end",
                message=f"No transition defined for {current_phase} -> {result['status']}",
                timestamp=_flow_logger.now_iso(),
                phase=current_phase,
            ))
            break

        if next_step == "finish":
            completed_successfully = True
            break
        elif next_step == "diagnostic" or result["status"] == "error":
            term._print_verbose(f"[DIAGNOSTIC] Running diagnostic for {current_phase}")
            diag_result = run_diagnostic(term, flow_config, issue_num, {
                "failed_phase": current_phase,
                "output_summary": result.get("details", "")[:500]
            }, log=_log)

            # Store diagnostic insights regardless of outcome
            if diag_result["status"] == "success":
                term._print_verbose(f"Diagnostic analysis: {diag_result['analysis'][:150]}")
                context["diagnostic_insights"] = diag_result.get("analysis", "")
                diag_verdict = "success"
            else:
                term._print_verbose(f"[DIAGNOSTIC] Diagnostic itself failed: {diag_result.get('analysis', 'Unknown')}")
                context["diagnostic_insights"] = diag_result.get("analysis", "Diagnostic failed")
                diag_verdict = "reject"

            # After diagnostic, resolve where to go next from the diagnostic phase's transitions
            post_diag_step = get_next_step(flow_config["transitions"], "diagnostic", diag_verdict)
            if not post_diag_step:
                term._print_verbose(f"[ERROR] No transition defined for diagnostic -> {diag_verdict}")
                # Structured log mirror (issue #30) — ``phase_end`` with
                # ``phase=diagnostic`` and the error in the message.
                _log.emit(_flow_logger.FlowEvent(
                    kind="phase_end",
                    message=f"No transition defined for diagnostic -> {diag_verdict}",
                    timestamp=_flow_logger.now_iso(),
                    phase="diagnostic",
                ))
                break
            elif post_diag_step == "finish":
                completed_successfully = True
                break
            else:
                context["previous_output"] = f"## DIAGNOSTIC COMPLETED\n{context.get('diagnostic_insights', '')[:300]}"
                current_phase = post_diag_step
                phase_attempt_count = 1
                continue  # skip the retry-check below; we already advanced cleanly
        else:
            # Preserve issue/PRD context across phase transitions - only update previous_output
            context["previous_output"] = f"## {current_phase.upper()} COMPLETED\n{result.get('details', '')[:300]}"
            current_phase = next_step
            phase_attempt_count = 1

        if next_step == current_phase:
            phase_attempt_count += 1

    if iteration_count >= max_iterations:
        term.failure(f"Reached maximum iterations ({max_iterations}) - possible infinite loop")
    else:
        # Post final success comment only on first pass (no rejection)
        if completed_successfully and not first_rejection_posted:
             gh_client.post_phase_comment(
                issue_num=issue_num,
                phase=current_phase,
                status="approved",
                details=f"{current_phase} approved after {phase_attempt_count} attempt(s)"
            )

    # ── Build the FlowOutcome (per deepening PRD issue #29) ──
    # The outcome captures every per-attempt ``PhaseRun`` plus the
    # aggregated totals. The return value of this function is still
    # ``bool`` for backward compatibility (the pipeline layer reads
    # the bool) — the ``FlowOutcome`` is constructed here for the
    # future interface-narrowing slice that will surface it to callers.
    # For now it lives only on the in-loop ``phase_runs`` list and
    # the running ``total_tokens_in/out`` counters. Using ``_`` to
    # silence the linter for the deliberately-unused value.
    _ = FlowOutcome(
        flow_name=flow_config.get("name", "unknown"),
        issue_num=issue_num,
        status=("success" if completed_successfully
                else ("exhausted_iterations" if iteration_count >= max_iterations
                      else "failed")),
        iterations=iteration_count,
        phases=tuple(phase_runs),
        events=(),
        total_duration_s=time.monotonic() - run_start,
        evidence_summary=None,
        retro_learning=None,
        total_tokens_in=total_tokens_in,
        total_tokens_out=total_tokens_out,
    )

    return completed_successfully


# ─── New value-object types ─────────────────────────────────────────────
#
# These types are added in a no-behavior-change commit so that subsequent
# issues (logger migration, dispatcher extraction, runner narrowing) can
# build on typed values instead of loose ``flow_config: dict`` and
# ``context: dict`` parameters. The existing ``run_flow_on_issue`` and its
# callers are intentionally unchanged in this slice.
#
# Per the deepening PRD:
#   - ``Flow``, ``FlowContext``, ``PhaseRun``, ``FlowOutcome`` and the
#     helpers ``PhaseConfig`` / ``Transition`` are frozen — they describe
#     static or completed values that should not mutate.
#   - ``PhaseState`` is the ONE mutable type. It is the loop's local
#     state and mutates every iteration. "Frozen" would be a lie.
#
# Forward references to ``WorkingMemory``, ``PrefetchedContext``,
# ``ScoutFindings`` and ``FlowEvent`` are kept as strings so this file
# does not gain a new import dependency in the no-behavior-change slice.

from dataclasses import dataclass, field, replace  # noqa: E402  (kept grouped with types)


@dataclass(frozen=True)
class PhaseConfig:
    """One phase's config, post-validation, post-defaults.

    A flattened, immutable view of a single phase entry from a flow JSON.
    ``tools`` is a tuple (loaded from prompt frontmatter at construction
    time) so the dataclass remains hashable.
    """
    name: str
    skill: str
    timeout_seconds: int
    retries: int
    is_local: bool
    is_optional: bool
    model: str | None
    provider: str | None
    command: str | None
    tools: tuple = ()


@dataclass(frozen=True)
class Transition:
    """One transition rule from a flow config.

    ``on_no_gaps`` is the target when a phase returns the ``no_gaps``
    status (a verdict outcome that isn't approval and isn't rejection).
    The other three fields are the standard transition targets.
    """
    from_phase: str
    on_success: str | None
    on_reject: str | None
    on_error: str | None
    on_no_gaps: str | None


@dataclass(frozen=True)
class Flow:
    """A flow config, validated and defaults applied. Immutable."""
    name: str
    description: str
    scout_enabled: bool
    evidence_policy: dict
    phases: dict
    transitions: tuple


@dataclass(frozen=True)
class FlowContext:
    """Everything a flow needs to know about an issue at the START of
    execution. Static — loaded once per flow run.

    ``working_memory``, ``prefetched`` and ``scout_findings`` are typed
    as forward references to keep this file free of new import
    dependencies in the no-behavior-change slice.

    ``comments_count`` and ``created_at`` are the header-display
    fields populated by :func:`flow_dispatcher.build_flow_context`
    step 1. The shim uses them to reproduce the pre-refactor
    ``term.issue_header(issue_num, title=..., comments_count=...,
    created_at=...)`` call — the dispatcher does not have access to
    the ``Terminal``, so the values are carried on the ``FlowContext``
    instead.
    """
    flow: "Flow"
    issue_num: int
    issue_body: str
    issue_title: str
    comments_count: int = 0
    created_at: str | None = None
    parent_prd: str | None = None
    working_memory: "WorkingMemory" = None  # type: ignore[assignment]
    prefetched: "PrefetchedContext" = None  # type: ignore[assignment]
    repo_context: dict | None = None
    scout_findings: "ScoutFindings | None" = None


@dataclass
class PhaseState:
    """The per-iteration state, mutated by the runner.

    NOT in ``FlowContext`` — this is the dynamic, per-iteration state.
    The runner mutates ``current_phase`` and ``phase_attempt`` every
    iteration, and updates ``previous_output`` / ``diagnostic_insights``
    / ``phase_outputs`` as phases complete.
    """
    current_phase: str
    phase_attempt: int = 1
    previous_output: str = ""
    diagnostic_insights: str = ""
    phase_outputs: dict = field(default_factory=dict)


@dataclass(frozen=True)
class PhaseRun:
    """A single phase attempt, returned in ``FlowOutcome.phases``.

    A single phase can run multiple times (retries). Per-attempt is the
    source of truth; rolled-up views are derived by callers.
    """
    name: str
    attempt: int
    status: str  # "approved" | "rejected" | "no_gaps" | "error" | "skipped"
    duration_s: float | None
    tokens_in: int | None
    tokens_out: int | None
    cache_read: int | None
    session_log: "Path | None"
    details: str


@dataclass(frozen=True)
class FlowOutcome:
    """The runner's return value. Captures the whole run.

    ``events`` is the ordered tuple of every ``FlowEvent`` emitted by the
    ``FlowLogger`` port during the run — useful for the dashboard and for
    after-the-fact debugging. ``total_tokens_in`` and
    ``total_tokens_out`` are the sum of ``PhaseRun.tokens_in`` /
    ``tokens_out`` across all attempts (None values ignored), populated
    by the token-plumbing slice (issue #29).
    """
    flow_name: str
    issue_num: int
    status: str  # "success" | "failed" | "exhausted_iterations" | "no_gaps"
    iterations: int
    phases: tuple
    events: tuple
    total_duration_s: float
    evidence_summary: str | None
    retro_learning: str | None
    total_tokens_in: int = 0
    total_tokens_out: int = 0


# ─── Re-exports for backward compatibility ──────────────────────────
#
# Deepening PRD issue #31 moved the per-phase functions (and their
# helpers) to :mod:`phase_runner`. To keep existing test files and
# external callers working without changes, the symbols that USED to
# live in this module are re-exported from ``phase_runner`` here.
#
# The re-export is implemented via a PEP 562 module-level
# ``__getattr__`` (Python 3.7+). The first access to any moved
# symbol triggers a deferred import of ``phase_runner`` — at which
# point both modules are fully loaded, so there is no circular
# import at module-load time. The resolved symbol is cached on
# ``sys.modules['flow_engine'].__dict__`` so subsequent accesses
# are O(1) and the ``from flow_engine import X`` idiom works.
_MOVED_TO_PHASE_RUNNER = frozenset({
    "DEFAULT_EVIDENCE_POLICY",
    "get_evidence_policy",
    "run_close_phase",
    "run_phase",
    "_build_session_dir",
    "_extract_phase_tokens",
    "_run_phase_inner",
    "_populate_retrospective_context",
    "_persist_retrospective_result",
    "_format_evidence_summary",
    "_format_learnings_excerpt",
    "_read_agent_text_from_session_log",
})


def __getattr__(name: str):  # PEP 562 — module-level lazy attribute access
    """Re-export symbols that moved to :mod:`phase_runner` (issue #31).

    The first access to a moved symbol triggers a deferred import of
    :mod:`phase_runner`. Both modules are fully loaded by then, so
    there is no circular import. The symbol is cached in the module
    globals so subsequent lookups are direct.
    """
    if name in _MOVED_TO_PHASE_RUNNER:
        from phase_runner import (  # noqa: WPS433  (intentional deferred import)
            DEFAULT_EVIDENCE_POLICY,
            get_evidence_policy,
            run_close_phase,
            run_phase,
            _build_session_dir,
            _extract_phase_tokens,
            _run_phase_inner,
            _populate_retrospective_context,
            _persist_retrospective_result,
            _format_evidence_summary,
            _format_learnings_excerpt,
            _read_agent_text_from_session_log,
        )
        value = locals()[name]
        globals()[name] = value  # cache for subsequent direct access
        return value
    raise AttributeError(f"module 'flow_engine' has no attribute {name!r}")
