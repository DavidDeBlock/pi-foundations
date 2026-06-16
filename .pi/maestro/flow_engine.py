#!/usr/bin/env python3
"""
flow_engine.py — Core execution engine for a single flow on a single issue.

Public API (the "deep module" surface):

  * :func:`run_flow` — runs a flow on one issue, returns a
    :class:`FlowOutcome` value object. The signature is intentionally
    narrow: ``(flow, context, state, term, gh, log)``. The caller
    (e.g. ``app_shell.py``, ``PipelineContext.run_flow``) is
    responsible for the dispatching work — loading the flow, fetching
    the issue metadata, building the :class:`FlowContext`, picking
    the first phase, etc. — so this function can stay focused on the
    phase loop.

  * :func:`load_flow` — loads a flow JSON and returns the raw dict
    (post-validation, post-defaults). Converted to the typed
    :class:`Flow` value object via :func:`_flow_from_config`.

  * The value-object dataclasses (:class:`Flow`, :class:`FlowContext`,
    :class:`PhaseState`, :class:`PhaseRun`, :class:`FlowOutcome`,
    :class:`PhaseConfig`, :class:`Transition`).

  * Close-phase helpers (:data:`DEFAULT_EVIDENCE_POLICY`,
    :func:`get_evidence_policy`, :func:`_close_phase_result`) — small,
    focused, used by the :func:`~phase_runner.run_close_phase`
    wrapper.

  * Flow helpers: :func:`_initial_phase`, :func:`_extract_parent_issue`,
    :func:`_format_repo_context`, :func:`_scout_enabled`,
    :func:`_flow_from_config`. These are used by the dispatcher
    and the run loop; they're tiny and stay here so the data flow
    is in one place.

What lives elsewhere (extracted in earlier issues):

  * :mod:`phase_runner` — ``run_phase``, ``_run_phase_inner``,
    ``_build_session_dir``, ``_extract_phase_tokens``,
    ``_populate_retrospective_context``, ``_persist_retrospective_result``,
    ``_format_evidence_summary``, ``_format_learnings_excerpt``,
    ``_read_agent_text_from_session_log``, ``run_close_phase``.
  * :mod:`prompt_assembler` — :class:`PreparedPrompt`,
    :func:`build_prompt`, ``_print_prompt_debug``, the
    ``_maybe_get_working_memory`` / ``_maybe_get_prefetched_context``
    helpers.
  * :mod:`diagnostic` — :func:`run_diagnostic`,
    :func:`_build_diagnostic_prompt`.
  * :mod:`flow_dispatcher` — :func:`build_flow_context` (the 7 setup
    steps: issue metadata, parent PRD, working memory, prefetch,
    persist, repo context, scout). Owns :func:`_run_scout_phase` and
    :func:`_build_scout_flow_context` (scout-specific setup work).

This file is the deep module — it has a small public surface and
delegates the heavy lifting to the per-phase, prompt, diagnostic, and
dispatcher modules.

Pre-issue-#34 history: ``run_flow_on_issue`` used to live here as a
6-argument shim (``term, gh, flow_name, issue_num, initial_context,
phase_callback``) that did its own dispatching and dict-shimming.
Issue #34 narrows the contract to typed inputs and a
:class:`FlowOutcome` return value; the dispatching work moves to the
callers.
"""

from __future__ import annotations

import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# Add lib to path (matches the convention used across the repo)
sys.path.insert(0, str(Path(__file__).parent / "lib"))

from context_prefetch import PrefetchedContext, prefetch_context  # noqa: E402
from evidence import EvidenceStore, EvidenceType  # noqa: E402
import flow_logger as _flow_logger  # noqa: E402
from flow_logger import FlowEvent, FlowLogger  # noqa: E402
from github_client import GithubClient  # noqa: E402
from projects_registry import (  # noqa: E402
    REGISTRY_FILENAME as PROJECTS_REGISTRY_FILENAME,
    ProjectsRegistry,
)
from session_reader import parse_session_log  # noqa: E402
from terminal import Terminal  # noqa: E402
from working_memory import MemoryStore, WorkingMemory  # noqa: E402


# Re-export ``now_iso`` at module level for callers that reach into
# ``flow_engine.now_iso()`` (e.g. ``flow_dispatcher``).
now_iso = _flow_logger.now_iso


# ─── Logging port helpers (per deepening PRD issue #30) ─────────────────


def _resolve_log(log: Optional[FlowLogger]) -> FlowLogger:
    """Return the provided logger, or a fresh :class:`StderrLogger`.

    Constructed lazily to avoid a ``sys.stderr`` reference at import
    time (matches ``StderrLogger``'s design — it dereferences
    ``sys.stderr`` at emit time, not at construction).
    """
    return log if log is not None else _flow_logger.StderrLogger()


# ─── Evidence policy (close-phase helpers) ──────────────────────────────


DEFAULT_EVIDENCE_POLICY: dict = {
    "required_on_success": ["tested", "reviewed"],
    "on_missing_evidence": "warn_but_proceed",
}


def get_evidence_policy(flow_config: dict) -> dict:
    """Return the effective evidence policy for a flow.

    Reads ``flow_config["evidence_policy"]`` and merges with
    :data:`DEFAULT_EVIDENCE_POLICY`. Unrecognized keys are preserved
    (forward-compat). Missing policy → defaults.
    """
    if not isinstance(flow_config, dict):
        return dict(DEFAULT_EVIDENCE_POLICY)
    raw = flow_config.get("evidence_policy")
    if not isinstance(raw, dict):
        return dict(DEFAULT_EVIDENCE_POLICY)
    merged = dict(DEFAULT_EVIDENCE_POLICY)
    merged.update(raw)
    return merged


def _close_phase_result(
    flow_config: dict,
    issue_num: int,
    evidence_dir=None,
    log: Optional[FlowLogger] = None,
) -> dict:
    """Compute the close-phase result based on the flow's evidence policy.

    Centralised here so the AC-specified policies (``block``,
    ``warn_but_proceed``, ``ignore``) all live in one place. Used by
    :func:`phase_runner.run_close_phase` and the phase-runner tests.

    Returns a dict with ``status`` and ``details``. ``status`` is one
    of:

        - ``"success"`` — evidence is present OR policy allowed
          proceeding
        - ``"reject"`` — evidence is missing AND policy is ``block``
    """
    policy = get_evidence_policy(flow_config)
    required = [EvidenceType(t) for t in policy.get("required_on_success", [])]
    on_missing = policy.get("on_missing_evidence", "warn_but_proceed")

    if evidence_dir is None:
        store = EvidenceStore(issue_num)
    else:
        store = EvidenceStore(issue_num, evidence_dir=Path(evidence_dir))

    ok, missing = store.check(required)
    required_values = [t.value for t in required]

    if ok:
        return {
            "status": "success",
            "details": f"All evidence present: {required_values}",
        }

    missing_values = [
        m.value if isinstance(m, EvidenceType) else str(m) for m in missing
    ]

    if on_missing == "block":
        return {
            "status": "reject",
            "details": (
                f"Missing evidence (block policy): {missing_values} "
                f"(required: {required_values})"
            ),
        }
    if on_missing == "warn_but_proceed":
        # Use the structured FlowLogger port. Each line is an
        # ``evidence_warn`` event; the StderrLogger renders
        # ``evidence_warn: <message>`` (no ``[phase]`` prefix — these
        # warnings are not phase-scoped).
        _log = _resolve_log(log)
        _log.emit(FlowEvent(
            kind="evidence_warn",
            message=f"Missing evidence for issue #{issue_num}: {missing_values}",
            timestamp=_flow_logger.now_iso(),
        ))
        _log.emit(FlowEvent(
            kind="evidence_warn",
            message="Proceeding without required evidence (warn_but_proceed policy)",
            timestamp=_flow_logger.now_iso(),
        ))
        return {
            "status": "success",
            "details": (
                f"Missing evidence (warned): {missing_values} "
                f"(required: {required_values})"
            ),
        }
    # ``on_missing == "ignore"`` or any other value → skip the check entirely
    return {
        "status": "success",
        "details": f"Evidence check skipped (policy: {on_missing})",
    }


# ─── Type definitions ───────────────────────────────────────────────────


@dataclass(frozen=True)
class PhaseConfig:
    """One phase's config, post-validation, post-defaults.

    A flattened, immutable view of a single phase entry from a flow
    JSON. ``tools`` is a tuple (loaded from prompt frontmatter at
    construction time) so the dataclass remains hashable.
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

    ``on_no_gaps`` is the target when a phase returns the
    ``no_gaps`` status (a verdict outcome that isn't approval and
    isn't rejection). The other three fields are the standard
    transition targets.
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

    ``working_memory``, ``prefetched`` and ``scout_findings`` are
    typed as forward references to keep this file free of new import
    dependencies.

    ``comments_count`` and ``created_at`` are the header-display
    fields populated by :func:`flow_dispatcher.build_flow_context`
    step 1; callers reproduce the
    ``term.issue_header(issue_num, title=..., comments_count=...,
    created_at=...)`` call from them.
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
    scout_findings: "dict | None" = None


@dataclass
class PhaseState:
    """The per-iteration state, mutated by the runner.

    NOT in :class:`FlowContext` — this is the dynamic, per-iteration
    state. The runner mutates ``current_phase`` and ``phase_attempt``
    every iteration, and updates ``previous_output`` /
    ``diagnostic_insights`` / ``phase_outputs`` as phases complete.
    """
    current_phase: str
    phase_attempt: int = 1
    previous_output: str = ""
    diagnostic_insights: str = ""
    phase_outputs: dict = field(default_factory=dict)


@dataclass(frozen=True)
class PhaseRun:
    """A single phase attempt, returned in :attr:`FlowOutcome.phases`.

    A single phase can run multiple times (retries). Per-attempt is
    the source of truth; rolled-up views are derived by callers.

    ``output`` is the raw LLM output (verbatim text from the RPC
    layer, before verdict extraction). Some phase-specific helpers
    (e.g. :func:`scout_runner._run_scout_phase`) need the raw output
    to parse structured blocks like ``### PHASE_OUTPUT: success``.
    Most callers can ignore it — the structured verdict is
    available via ``result`` / ``status`` / ``details`` already.
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
    output: Optional[str] = None


@dataclass(frozen=True)
class FlowOutcome:
    """The runner's return value. Captures the whole run.

    ``events`` is the ordered tuple of every :class:`FlowEvent`
    emitted by the :class:`FlowLogger` port during the run — useful
    for the dashboard and for after-the-fact debugging.
    ``total_tokens_in`` and ``total_tokens_out`` are the sum of
    :attr:`PhaseRun.tokens_in` / :attr:`PhaseRun.tokens_out` across
    all attempts (``None`` values ignored). ``status`` is one of:

    * ``"success"`` — flow reached ``finish`` with a clean exit
    * ``"failed"`` — flow hit an unrecoverable error or the
      transition table pointed to a non-existent phase
    * ``"exhausted_iterations"`` — flow loop hit the
      ``max_iterations=50`` safety guard
    """
    flow_name: str
    issue_num: int
    status: str
    iterations: int
    phases: tuple
    events: tuple
    total_duration_s: float
    evidence_summary: str | None
    retro_learning: str | None
    total_tokens_in: int = 0
    total_tokens_out: int = 0


# ─── Flow loading ───────────────────────────────────────────────────────


def load_flow(name: str) -> dict:
    """Load a flow configuration from JSON file with defaults applied.

    Returns the raw dict (post-validation, post-defaults). The dict
    is the canonical in-process form of the flow; helpers like
    :func:`_flow_from_config` convert it to the typed
    :class:`Flow` value object.

    Kept as a dict for backward compatibility with the rest of the
    code base — the phase runner and prompt builder still consume
    the dict form, and converting everything to the typed
    :class:`Flow` is a follow-up slice.
    """
    flows_dir = Path(__file__).parent / "flows"
    flow_file = flows_dir / f"{name}.json"

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
            print(
                f"[ERROR] Phase '{transition['from']}' referenced in "
                f"transitions but not defined",
                file=sys.stderr,
            )
            sys.exit(1)

    default_retries = 3
    default_timeout = 1800
    flow_provider = config.get("default_provider")

    for phase_name, phase_config in config["phases"].items():
        # Local-only phases (e.g. the ``close`` evidence-gate phase)
        # don't call an LLM, so ``retries`` and ``model`` are
        # meaningless for them. We skip the warnings and still inject
        # a safe default so other code paths that read these fields
        # don't crash.
        is_local = bool(phase_config.get("is_local"))

        if "retries" not in phase_config:
            if not is_local:
                print(
                    f"[WARN] Phase '{phase_name}' missing 'retries' field - "
                    f"applying default: {default_retries}",
                    file=sys.stderr,
                )
                sys.stderr.flush()
            config["phases"][phase_name]["retries"] = 1
        elif phase_config["retries"] < 1:
            print(
                f"[ERROR] Phase '{phase_name}' has invalid retries: "
                f"{phase_config['retries']} (must be >= 1)",
                file=sys.stderr,
            )
            sys.exit(1)

        if "timeout_seconds" not in phase_config:
            config["phases"][phase_name]["timeout_seconds"] = default_timeout

        # Apply model/provider defaults from flow-level or hardcoded
        # fallbacks.
        if "model" not in phase_config and not is_local:
            print(
                f"[WARN] Phase '{phase_name}' missing 'model' field",
                file=sys.stderr,
            )
            sys.stderr.flush()

        if "provider" not in phase_config and flow_provider:
            config["phases"][phase_name]["provider"] = flow_provider

    return config


def _flow_from_config(flow_config: dict) -> "Flow":
    """Build a :class:`Flow` value object from the dict returned by
    :func:`load_flow`.

    Used by :func:`flow_dispatcher.build_flow_context` and the
    :func:`run_flow` runner to convert the raw config into the
    typed value object. ``phases`` and ``transitions`` are kept in
    their dict / list form here (the dispatcher only reads
    ``flow.scout_enabled`` and ``flow.name``; deeper extraction of
    :class:`PhaseConfig` / :class:`Transition` happens in the
    per-phase runner).
    """
    return Flow(
        name=flow_config.get("name", ""),
        description=flow_config.get("description", ""),
        scout_enabled=bool(flow_config.get("scout_enabled", False)),
        evidence_policy=dict(flow_config.get("evidence_policy") or {}),
        phases=dict(flow_config.get("phases") or {}),
        transitions=tuple(flow_config.get("transitions") or ()),
    )


def _initial_phase(flow_config: dict, skip_scout: bool = False) -> Optional[str]:
    """Return the first phase to execute, optionally skipping ``scout``.

    Used to keep scout out of the main phase loop when it has
    already been attempted synchronously by :func:`_run_scout_phase`
    in :mod:`flow_dispatcher`. Falls back to ``None`` if the flow
    has no phases.
    """
    phases = list(flow_config.get("phases", {}).keys())
    if not phases:
        return None
    if skip_scout and phases[0] == "scout":
        phases = phases[1:]
    return phases[0] if phases else None


def _extract_parent_issue(body: str) -> Optional[int]:
    """Extract parent issue number from body if formatted as
    '## Parent\\n\\n#NNN'."""
    match = re.search(r"^##\s*Parent\s*\n\s*#(\d+)", body, re.MULTILINE)
    return int(match.group(1)) if match else None


def _scout_enabled(flow_config: dict) -> bool:
    """Return True iff the flow has scout enabled and a ``scout``
    phase defined.

    Per the scout PRD, scout is **opt-in per flow** via the
    ``scout_enabled`` flag. The phase itself must also be present
    in ``phases`` — a flow with the flag set but no ``scout`` phase
    is treated as disabled.
    """
    if not flow_config.get("scout_enabled", False):
        return False
    if "scout" not in flow_config.get("phases", {}):
        return False
    return True


def _format_repo_context(repo_entry: dict) -> dict:
    """Build the ``context["repo_context"]`` dict from a registry
    entry. Picks the fields the builder prompt needs to render
    ``{repo_context}`` — alias, languages, commands, evidence
    strategy, conventions, gotchas, recommended playbooks. Defensive
    against missing or extra fields (a corrupt registry entry must
    not crash the flow).
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


# ─── Internal: get_next_step, dict <-> typed bridge ─────────────────────


def get_next_step(transitions: list, current_phase: str, status: str) -> Optional[str]:
    """Determine the next step based on transitions and phase status."""
    for t in transitions:
        if t.get("from") == current_phase:
            key = f"on_{status}"
            if key in t:
                return t[key]
    return None


# ─── The deep module: run_flow ──────────────────────────────────────────


# Number of iterations the loop is allowed to run before bailing
# out (safety guard against infinite transition loops).
_MAX_ITERATIONS = 50


def run_flow(
    flow: Flow,
    context: FlowContext,
    state: PhaseState,
    term: Terminal,
    gh: GithubClient,
    log: FlowLogger,
) -> FlowOutcome:
    """Run a :class:`Flow` on a single GitHub issue.

    The deep-module entry point. Takes typed inputs, returns a
    :class:`FlowOutcome`. The caller is responsible for the
    dispatching work (loading the flow, building the
    :class:`FlowContext`, picking the first phase, etc.) so this
    function can stay focused on the phase loop.

    Behaviour matches the pre-issue-#34 code path:

      * The legacy dict context is rebuilt from the typed
        :class:`FlowContext` (the prompt builder and close-phase
        gate read a few fields off the dict).
      * The phase loop iterates until ``finish`` is reached, an
        error is hit, or the ``max_iterations`` safety guard
        triggers.
      * The first rejection is posted as a GitHub comment; the
        final success is posted only if no rejection happened.
      * Token counts, durations, and per-phase status are
        accumulated into a :class:`FlowOutcome`.

    Args:
        flow: The :class:`Flow` value object (typed). ``flow.name``
            is used for log / comment text; ``flow.phases`` /
            ``flow.transitions`` drive the loop.
        context: The :class:`FlowContext` value object (typed).
            Carries issue body, parent PRD, working memory,
            prefetched context, repo context, scout findings.
        state: The :class:`PhaseState` value object (typed). The
            caller sets ``state.current_phase`` to the first phase
            (typically the first non-scout phase via
            :func:`_initial_phase(flow_config, skip_scout=True)`).
        term: The :class:`Terminal` for verbose output.
        gh: The :class:`GithubClient` for comment / label updates.
        log: The :class:`FlowLogger` port for structured events.

    Returns:
        A :class:`FlowOutcome` capturing the whole run. The
        ``status`` field is one of ``"success"``,
        ``"exhausted_iterations"``, or ``"failed"``.
    """
    from phase_runner import run_phase as _phase_runner_run_phase
    from diagnostic import run_diagnostic as _diagnostic_run_diagnostic

    _log = _resolve_log(log)
    flow_config = {
        "name": flow.name,
        "description": flow.description,
        "scout_enabled": flow.scout_enabled,
        "scout_timeout_seconds": flow.phases.get("scout", {}).get(
            "timeout_seconds", 240
        ),
        "phases": dict(flow.phases),
        "transitions": list(flow.transitions),
        "evidence_policy": dict(flow.evidence_policy),
    }

    # Display the issue header (matches the pre-issue-#34 terminal
    # output). On a fully-successful issue fetch, all three kwargs
    # are populated; on partial / failed fetches the dispatcher
    # leaves ``comments_count`` at 0 and ``created_at`` at None.
    term.issue_header(
        context.issue_num,
        title=context.issue_title,
        comments_count=context.comments_count,
        created_at=context.created_at,
    )

    # The phase loop needs a :class:`MemoryStore` to persist
    # per-phase results to working memory.
    memory_store = MemoryStore(context.issue_num)

    # Main execution loop
    iteration_count = 0
    current_phase = state.current_phase
    if current_phase is None:
        # Edge case: caller didn't pick a phase
        term._print_verbose("[ERROR] No current phase set on state")
        return FlowOutcome(
            flow_name=flow.name,
            issue_num=context.issue_num,
            status="failed",
            iterations=0,
            phases=(),
            events=(),
            total_duration_s=0.0,
            evidence_summary=None,
            retro_learning=None,
        )
    phase_attempt_count = state.phase_attempt
    first_rejection_posted = False
    completed_successfully = False
    test_fail_count = 0  # tracks consecutive test_runner rejections

    phase_runs: list = []
    total_tokens_in: int = 0
    total_tokens_out: int = 0
    run_start = time.monotonic()

    while iteration_count < _MAX_ITERATIONS:
        iteration_count += 1
        next_step = None  # reset each iteration; escalation may set it

        # ── Build the typed :class:`PhaseState` for this iteration
        # Carry forward any ``phase_outputs`` the previous iteration
        # wrote (e.g. the close phase's verdict, read by
        # retrospective).
        _state = PhaseState(
            current_phase=current_phase,
            phase_attempt=phase_attempt_count,
            previous_output=state.previous_output,
            diagnostic_insights=state.diagnostic_insights,
            phase_outputs=dict(state.phase_outputs) if state.phase_outputs else {},
        )

        phase_run = _phase_runner_run_phase(
            current_phase, flow, context, _state, term, gh, log=_log,
        )
        session_log_path = (
            str(phase_run.session_log) if phase_run.session_log else None
        )

        # Propagate per-iteration mutations back to the typed state
        # so subsequent iterations see the same data the legacy dict
        # would have seen.
        if _state.phase_outputs:
            state.phase_outputs = dict(_state.phase_outputs)
        if _state.diagnostic_insights:
            state.diagnostic_insights = _state.diagnostic_insights
        if _state.previous_output:
            state.previous_output = _state.previous_output

        # Convenience local — the loop body below uses both the
        # typed ``PhaseRun`` (for events / token counters) and the
        # legacy ``(status, details)`` fields (for terminal output
        # and transition lookup).
        status = phase_run.status
        details = phase_run.details or ""

        term._print_verbose(f"[PHASE] {current_phase} -> {status}")
        _log.emit(FlowEvent(
            kind="phase_end",
            message=f"{current_phase} -> {status}",
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
                    file_ops_failed=failed,
                )
            except Exception as e:
                term._print_verbose(f"[WARNING] Failed to parse session log: {e}")

        # Handle phase result
        if status == "success":
            term.phase_approved(current_phase, is_retry=is_retry)
        elif status == "no_gaps":
            term._print_verbose(
                f"[NO_GAPS] {current_phase}: No significant gaps found - finishing."
            )
        elif status == "reject":
            if not first_rejection_posted:
                gh.post_phase_comment(
                    issue_num=context.issue_num,
                    phase=current_phase,
                    status="rejected",
                    details=details[:300],
                )
                first_rejection_posted = True
            term.feedback(details)
        elif status == "error":
            term._print_verbose(f"[ERROR] Phase error: {details}")
            term.failure(f"{current_phase} failed with error")
            gh.post_phase_comment(
                issue_num=context.issue_num,
                phase=current_phase,
                status="error",
                details=(details or "Error executing phase")[:300],
            )

        # ── Persist phase result to working memory ──
        try:
            phase_data = {
                "status": status,
                "attempt": phase_attempt_count,
                "details": (details or "")[:1000],
                "session_log": str(session_log_path) if session_log_path else "",
            }
            memory = memory_store.update_phase(current_phase, phase_data)
            if status == "error":
                memory_store.append_error(
                    current_phase, details or "Unknown error",
                )
            # Refresh the in-memory copy so the next phase sees the
            # latest state without needing to hit disk again.
            from dataclasses import replace as _dc_replace
            context = _dc_replace(context, working_memory=memory)
        except Exception as mem_err:
            # Memory persistence is best-effort — never crash the flow.
            term._print_verbose(f"[memory] Failed to update working memory: {mem_err}")

        # ── Token observability (per deepening PRD issue #29) ──
        phase_runs.append(phase_run)
        if phase_run.tokens_in is not None:
            total_tokens_in += phase_run.tokens_in
        if phase_run.tokens_out is not None:
            total_tokens_out += phase_run.tokens_out

        _event_ts = _flow_logger.now_iso()
        _token_dict = {
            "in": phase_run.tokens_in,
            "out": phase_run.tokens_out,
            "cache": phase_run.cache_read,
        }
        # phase_end — always emitted (for the structured JSONL log)
        _log.emit(FlowEvent(
            kind="phase_end",
            message=f"{current_phase} {status}",
            timestamp=_event_ts,
            phase=current_phase,
            attempt=phase_attempt_count,
            duration_s=phase_run.duration_s,
            tokens=_token_dict if phase_run.tokens_in is not None else None,
        ))
        # tokens_recorded — only when we have usage data, and only
        # via the structured port. This is the operator's
        # terminal-visible per-phase totals line.
        if phase_run.tokens_in is not None:
            _log.emit(FlowEvent(
                kind="tokens_recorded",
                message="",
                timestamp=_event_ts,
                phase=current_phase,
                attempt=phase_attempt_count,
                duration_s=phase_run.duration_s,
                tokens=_token_dict,
            ))

        # ── Test failure escalation tracking ──
        if current_phase == "test_runner" and status == "reject":
            test_fail_count += 1
            max_rejects = flow_config["phases"].get("test_runner", {}).get(
                "max_rejects_before_diagnostic", 2
            )
            if test_fail_count >= max_rejects:
                term._print_verbose(
                    f"[TEST_ESCALATION] test_runner failed {test_fail_count} "
                    f"times — routing to diagnostic (threshold: {max_rejects})"
                )
                # Override transition: force diagnostic instead of builder
                next_step = "diagnostic"
            else:
                term._print_verbose(
                    f"[TEST_RETRY] test_runner failed ({test_fail_count}/"
                    f"{max_rejects}) — sending output to builder for fix"
                )
        elif current_phase != "test_runner":
            # Reset counter when we leave test_runner phase
            if test_fail_count > 0:
                test_fail_count = 0

        # Determine next step from transitions (only if escalation
        # didn't already set it).
        if next_step is None:
            next_step = get_next_step(
                flow_config["transitions"], current_phase, status
            )

        if not next_step:
            term._print_verbose(
                f"[ERROR] No transition defined for {current_phase} -> {status}"
            )
            _log.emit(FlowEvent(
                kind="phase_end",
                message=(
                    f"No transition defined for {current_phase} -> {status}"
                ),
                timestamp=_flow_logger.now_iso(),
                phase=current_phase,
            ))
            break

        if next_step == "finish":
            completed_successfully = True
            break
        elif next_step == "diagnostic" or status == "error":
            term._print_verbose(
                f"[DIAGNOSTIC] Running diagnostic for {current_phase}"
            )
            diag_result = _diagnostic_run_diagnostic(
                flow, context.issue_num, {
                    "failed_phase": current_phase,
                    "output_summary": (details or "")[:500],
                }, term, gh, log=_log,
            )

            # Store diagnostic insights regardless of outcome
            if diag_result["status"] == "success":
                term._print_verbose(
                    f"Diagnostic analysis: {diag_result['analysis'][:150]}"
                )
                state.diagnostic_insights = diag_result.get("analysis", "")
                diag_verdict = "success"
            else:
                term._print_verbose(
                    f"[DIAGNOSTIC] Diagnostic itself failed: "
                    f"{diag_result.get('analysis', 'Unknown')}"
                )
                state.diagnostic_insights = (
                    diag_result.get("analysis", "Diagnostic failed")
                )
                diag_verdict = "reject"

            # After diagnostic, resolve where to go next from the
            # diagnostic phase's transitions.
            post_diag_step = get_next_step(
                flow_config["transitions"], "diagnostic", diag_verdict
            )
            if not post_diag_step:
                term._print_verbose(
                    f"[ERROR] No transition defined for "
                    f"diagnostic -> {diag_verdict}"
                )
                _log.emit(FlowEvent(
                    kind="phase_end",
                    message=(
                        f"No transition defined for diagnostic -> {diag_verdict}"
                    ),
                    timestamp=_flow_logger.now_iso(),
                    phase="diagnostic",
                ))
                break
            elif post_diag_step == "finish":
                completed_successfully = True
                break
            else:
                state.previous_output = (
                    f"## DIAGNOSTIC COMPLETED\n"
                    f"{state.diagnostic_insights[:300]}"
                )
                current_phase = post_diag_step
                phase_attempt_count = 1
                continue  # skip the retry-check below; we already advanced cleanly
        else:
            # Preserve issue/PRD context across phase transitions -
            # only update previous_output.
            state.previous_output = (
                f"## {current_phase.upper()} COMPLETED\n{details[:300]}"
            )
            current_phase = next_step
            phase_attempt_count = 1

        if next_step == current_phase:
            phase_attempt_count += 1

    # Post final success comment only on first pass (no rejection)
    if (
        completed_successfully
        and not first_rejection_posted
        and iteration_count < _MAX_ITERATIONS
    ):
        gh.post_phase_comment(
            issue_num=context.issue_num,
            phase=current_phase,
            status="approved",
            details=(
                f"{current_phase} approved after {phase_attempt_count} "
                f"attempt(s)"
            ),
        )

    if iteration_count >= _MAX_ITERATIONS and not completed_successfully:
        term.failure(
            f"Reached maximum iterations ({_MAX_ITERATIONS}) - "
            f"possible infinite loop"
        )

    # ── Build the :class:`FlowOutcome` ──
    if completed_successfully:
        outcome_status = "success"
    elif iteration_count >= _MAX_ITERATIONS:
        outcome_status = "exhausted_iterations"
    else:
        outcome_status = "failed"

    return FlowOutcome(
        flow_name=flow.name,
        issue_num=context.issue_num,
        status=outcome_status,
        iterations=iteration_count,
        phases=tuple(phase_runs),
        events=(),
        total_duration_s=time.monotonic() - run_start,
        evidence_summary=None,
        retro_learning=None,
        total_tokens_in=total_tokens_in,
        total_tokens_out=total_tokens_out,
    )


# ─── Public exports ─────────────────────────────────────────────────────
#
# ``run_flow`` is the new public surface; ``load_flow`` is preserved
# for backward compatibility (other modules still call it). The
# pre-issue-#34 ``run_flow_on_issue`` shim has been deleted —
# callers do their own dispatching (see ``app_shell.py:_run`` and
# ``pipelines.context.PipelineContext.run_flow``).

__all__ = [
    "DEFAULT_EVIDENCE_POLICY",
    "Flow",
    "FlowContext",
    "FlowEvent",
    "FlowLogger",
    "FlowOutcome",
    "PhaseConfig",
    "PhaseRun",
    "PhaseState",
    "Transition",
    "_extract_parent_issue",
    "_flow_from_config",
    "_format_repo_context",
    "_initial_phase",
    "_resolve_log",
    "_scout_enabled",
    "get_evidence_policy",
    "get_next_step",
    "load_flow",
    "run_flow",
]
