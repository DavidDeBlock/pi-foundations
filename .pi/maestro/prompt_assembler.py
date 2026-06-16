#!/usr/bin/env python3
"""
prompt_assembler.py — Build the prompt for a single phase.

Extracted from ``flow_engine.py`` (deepening PRD issue #32). Owns
the "given a phase config, return a :class:`PreparedPrompt`"
concern. The previous :func:`flow_engine.build_prompt` returned a
loose ``(text, tools)`` tuple; the new function returns a
:class:`PreparedPrompt` value object that bundles the prompt text,
the resolved tool allowlist, the per-phase model / provider
override slots, and a ``template_loaded`` flag.

Public surface:

- :class:`PreparedPrompt` — frozen dataclass, the return type.
- :func:`build_prompt` — load template, substitute variables,
  append the LOCAL / SKILL directive, return a :class:`PreparedPrompt`.

Signature::

    build_prompt(
        phase_name: str,
        phase_config: PhaseConfig,
        flow: Flow,
        issue_num: int,
        context: FlowContext,
        state: PhaseState,
        log: Optional[FlowLogger] = None,
        extra_context: Optional[dict] = None,
    ) -> PreparedPrompt

The four typed parameters (``PhaseConfig``, ``Flow``,
``FlowContext``, ``PhaseState``) live in :mod:`flow_engine`. The
``extra_context`` dict carries the variables that don't have a
home on the typed objects — retrospective-specific keys
(``flow_name``, ``final_status``, ``repo_path``, ``evidence_summary``,
``learnings_excerpt``) and pre-formatted markdown caches
(``prefetched_context_md``, ``scout_findings_md``) that mirror the
pre-#32 dict behaviour. When ``extra_context`` is None, the
function falls back to safe defaults for each key (matches the
pre-refactor behaviour).

The conversion from the legacy ``flow_config: dict`` /
``context: dict`` shapes used by the phase loop into these typed
objects is the caller's job (see :func:`phase_runner._run_phase_inner`).
The dispatcher in :mod:`flow_engine` already builds a
:class:`FlowContext` and a :class:`PhaseState` per iteration, so
the call site can pass them through directly.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# Add lib to path (matches the convention used by flow_engine.py)
_LIB_DIR = Path(__file__).parent / "lib"
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import flow_logger as _flow_logger  # noqa: E402
from flow_logger import FlowEvent, FlowLogger  # noqa: E402
from flow_engine import (  # noqa: E402
    Flow,
    FlowContext,
    PhaseConfig,
    PhaseState,
)
from context_prefetch import format_prefetched_context  # noqa: E402
from prompt_loader import load_prompt, PERMISSIVE_FALLBACK  # noqa: E402
from scout_findings import format_scout_findings_markdown  # noqa: E402


# ─── Value Object ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class PreparedPrompt:
    """A phase prompt, ready to send to the LLM.

    Attributes:
        text: The rendered prompt body (variables substituted,
            LOCAL / SKILL directive appended).
        tools: The resolved tool allowlist — a tuple so the frozen
            dataclass stays hashable.
        model_override: Per-phase model override (``None`` for now;
            the slot is reserved for a future per-phase override
            slice). Mirrors ``PhaseConfig.model``.
        provider_override: Per-phase provider override (``None`` for
            now). Mirrors ``PhaseConfig.provider``.
        template_loaded: True if the body came from
            ``prompts/<phase>.md`` or ``prompts/<phase>.tmpl``; False
            if the function fell back to the in-memory default.
            Useful for the dashboard's "did this prompt come from
            disk?" indicator and for tests asserting the fallback
            path.
    """

    text: str
    tools: tuple
    model_override: Optional[str]
    provider_override: Optional[str]
    template_loaded: bool


# ─── Logging-port helpers (moved from flow_engine.py) ──────────────────


def _resolve_log(log: Optional[FlowLogger]) -> FlowLogger:
    """Return the provided logger, or a fresh :class:`StderrLogger`.

    Mirrors the helper in ``flow_engine.py`` and ``phase_runner.py`` —
    copy-pasted here so ``prompt_assembler`` does not need to import
    a private symbol from a sibling module.
    """
    return log if log is not None else _flow_logger.StderrLogger()


def _emit(line: str, phase_name: str, log: FlowLogger, ts: str) -> None:
    """Emit a single ``phase_start`` event with the given message.

    Internal helper used by :func:`_print_prompt_debug` to map each
    pre-refactor ``print(..., file=sys.stderr)`` line to a single
    :class:`FlowEvent`. The :class:`StderrLogger` adapter renders
    the same first-line prefix and emits the full message verbatim,
    so terminal output stays stable.
    """
    log.emit(_flow_logger.FlowEvent(
        kind="phase_start",
        message=line,
        timestamp=ts,
        phase=phase_name,
    ))


# ─── Working-memory + prefetched accessors (moved from flow_engine) ────


def _maybe_get_working_memory(issue_num: int, context: FlowContext) -> dict:
    """Return a working-memory view for inclusion in the prompt.

    Prefers the typed ``context.working_memory`` if present. Falls
    back to a fresh load from disk on cache miss so phases don't
    lose context if the typed reference is None (e.g. early in the
    flow before the dispatcher has populated it).
    """
    wm = context.working_memory
    if wm is not None:
        try:
            return wm.to_dict()
        except Exception:  # noqa: BLE001  (tolerate any to_dict failure)
            pass
    try:
        from working_memory import MemoryStore
        return MemoryStore(issue_num).load().to_dict()
    except Exception:  # noqa: BLE001
        return {"issue": issue_num}


def _maybe_get_prefetched_context(context: FlowContext, extra_context: dict) -> str:
    """Return the prefetched-context markdown for inclusion in the prompt.

    Prefers a pre-formatted ``prefetched_context_md`` from
    ``extra_context`` (the pre-#32 dict behaviour, which the
    dispatcher populated to avoid re-formatting). Falls back to
    formatting ``context.prefetched`` on demand.
    """
    md = extra_context.get("prefetched_context_md")
    if isinstance(md, str) and md:
        return md
    if context.prefetched is None:
        return ""
    try:
        return format_prefetched_context(context.prefetched)
    except Exception:  # noqa: BLE001
        return ""


def _maybe_get_scout_findings(context: FlowContext, extra_context: dict) -> str:
    """Return the scout-findings markdown, or a friendly fallback.

    Prefers a pre-formatted ``scout_findings_md`` from
    ``extra_context`` (the pre-#32 dict behaviour). Falls back to
    formatting ``context.scout_findings``, then to a
    "(Scout disabled for this flow.)" string when both are absent —
    matches the pre-refactor default.
    """
    md = extra_context.get("scout_findings_md")
    if isinstance(md, str) and md:
        return md
    if context.scout_findings is None:
        return "(Scout disabled for this flow.)"
    try:
        return format_scout_findings_markdown(context.scout_findings)
    except Exception:  # noqa: BLE001
        return "(Scout findings unavailable.)"


# ─── Debug helper (moved from flow_engine.py) ──────────────────────────


def _print_prompt_debug(
    phase_name: str,
    issue_num: int,
    template_exists: bool,
    variables: dict,
    prompt: str,
    extra_context: str,
    log: Optional[FlowLogger] = None,
):
    """Print debug info about the built prompt via the FlowLogger port.

    Each ``[DEBUG]`` line from the pre-refactor implementation maps
    to a single ``phase_start`` event with ``phase=phase_name``. The
    :class:`StderrLogger` renders the same first-line prefix and
    emits the full message verbatim, so terminal output stays
    stable. The separator lines (``=========``) get their own
    events so the framing is preserved line-for-line.
    """
    _log = _resolve_log(log)
    _ts = _flow_logger.now_iso()

    _emit("", phase_name, _log, _ts)
    _emit("=" * 60, phase_name, _log, _ts)
    _emit(f"[DEBUG] Phase: {phase_name} | Issue: #{issue_num}", phase_name, _log, _ts)
    _emit(
        f"[DEBUG] Template loaded: {'YES' if template_exists else 'NO (fallback)'}",
        phase_name,
        _log,
        _ts,
    )

    # Show variable values (truncated for readability)
    for key, value in variables.items():
        display = value[:200] + "..." if len(value) > 200 else value
        _emit(f"[DEBUG]   {key} = '{display}'", phase_name, _log, _ts)

    # Show extra context (diagnostic or previous_output)
    if extra_context:
        display = extra_context[:300] + "..." if len(extra_context) > 300 else extra_context
        _emit(f"[DEBUG]   Context preview: '{display}'", phase_name, _log, _ts)

    # Prompt stats
    lines = prompt.split('\n')
    _emit(
        f"[DEBUG] Prompt: {len(prompt)} chars, {len(lines)} lines",
        phase_name,
        _log,
        _ts,
    )
    if lines:
        _emit(
            f"[DEBUG] First line: '{lines[0].strip()[:100]}'",
            phase_name,
            _log,
            _ts,
        )
    _emit("=" * 60, phase_name, _log, _ts)


# ─── Public API: build_prompt ──────────────────────────────────────────


def build_prompt(
    phase_name: str,
    phase_config: PhaseConfig,
    flow: Flow,
    issue_num: int,
    context: FlowContext,
    state: PhaseState,
    log: Optional[FlowLogger] = None,
    extra_context: Optional[dict] = None,
) -> PreparedPrompt:
    """Build a :class:`PreparedPrompt` for the given phase.

    Loads the prompt template from ``prompts/<phase_name>.md``
    (preferred) or ``prompts/<phase_name>.tmpl`` (legacy) via
    :func:`load_prompt`. Substitutes the standard variable set
    with values pulled from the typed ``phase_config`` / ``flow`` /
    ``context`` / ``state`` inputs, plus any retro-specific keys
    present in ``extra_context``. Appends the appropriate
    ``LOCAL COMMAND TO RUN:`` or ``SKILL TO USE:`` directive.

    Args:
        phase_name: The phase key (e.g. ``"builder"``).
        phase_config: Typed per-phase config. ``.skill``,
            ``.is_local``, ``.command``, ``.tools``, ``.model``,
            and ``.provider`` are read.
        flow: Typed flow value object. ``.name`` is read for
            ``{flow_name}`` fallback.
        issue_num: The GitHub issue number being processed.
        context: Typed flow context (``FlowContext``). Carries
            ``issue_body``, ``parent_prd``, ``working_memory``,
            ``prefetched``, ``repo_context``, ``scout_findings``.
        state: Typed per-iteration state (``PhaseState``). Carries
            ``previous_output`` and ``diagnostic_insights``.
        log: Optional :class:`FlowLogger` port. Defaults to a
            :class:`StderrLogger` so existing call sites that don't
            care about logging still get a working terminal line.
        extra_context: Optional dict carrying keys that don't have
            a home on the typed objects — retro-specific
            (``flow_name``, ``final_status``, ``repo_path``,
            ``evidence_summary``, ``learnings_excerpt``) and
            pre-formatted markdown caches (``prefetched_context_md``,
            ``scout_findings_md``). Defaults to an empty dict.

    Returns:
        A :class:`PreparedPrompt` with the rendered text, resolved
        tools, model / provider overrides, and a ``template_loaded``
        flag.
    """
    _extra = extra_context or {}
    _log = _resolve_log(log)
    _ts = _flow_logger.now_iso()
    skill = phase_config.skill or ""

    # Config-time warning: a phase with no skill is suspicious.
    # This is a config-time observation, not a per-attempt phase
    # event — ``phase_start`` is still the closest matching kind
    # in the closed enum.
    if not skill:
        _log.emit(FlowEvent(
            kind="phase_start",
            message=f"[WARN] Phase '{phase_name}' has no 'skill' configured in flow config.",
            timestamp=_ts,
            phase=phase_name,
        ))

    prompt_dir = Path(__file__).parent / "prompts"

    # PhaseConfig.tools is a tuple; pass a list (or None) to the
    # loader so it can apply the precedence rules consistently.
    explicit_tools = list(phase_config.tools) if phase_config.tools else None

    try:
        loaded = load_prompt(prompt_dir, phase_name, explicit_tools)
    except ValueError as exc:
        # Malformed frontmatter — surface the error but keep the
        # flow alive by falling back to a minimal default + permissive
        # tools. The caller still gets a usable ``PreparedPrompt``.
        _log.emit(FlowEvent(
            kind="phase_start",
            message=f"[ERROR] {exc}",
            timestamp=_ts,
            phase=phase_name,
        ))
        text = (
            f"## Phase: {phase_name}\n"
            f"## Issue: #{issue_num}\n\n"
            "[prompt loader error — see stderr]\n"
        )
        return PreparedPrompt(
            text=text,
            tools=tuple(PERMISSIVE_FALLBACK),
            model_override=phase_config.model,
            provider_override=phase_config.provider,
            template_loaded=False,
        )

    if loaded.deprecation_warning:
        _log.emit(FlowEvent(
            kind="phase_start",
            message=f"[DEPRECATION] {loaded.deprecation_warning}",
            timestamp=_ts,
            phase=phase_name,
        ))

    prompt = loaded.body
    template_loaded = loaded.source_format != "default"

    # Inject variables from typed context + extra_context
    issue_body = (
        context.issue_body
        or f"## Issue #{issue_num}\n\nPlease execute this phase."
    )
    working_memory = _maybe_get_working_memory(issue_num, context)
    prefetched_md = _maybe_get_prefetched_context(context, _extra)
    scout_findings_value = _maybe_get_scout_findings(context, _extra)
    prd_body = context.parent_prd or _extra.get("prd_body", "")
    repo_context = (
        context.repo_context
        if context.repo_context is not None
        else _extra.get("repo_context", {})
    )

    variables = {
        "{issue_number}": str(issue_num),
        "{diagnostic_insights}": state.diagnostic_insights or "",
        "{previous_output}": state.previous_output or "",
        "{prd_body}": prd_body,
        "{issue_body}": issue_body,
        "{prefetched_context}": prefetched_md,
        "{working_memory_json}": json.dumps(
            working_memory, indent=2, ensure_ascii=False
        ),
        "{scout_findings}": scout_findings_value,
        # Retrospective-specific variables. ``extra_context`` is the
        # source of truth (the loop populates them before calling
        # ``build_prompt``); safe fallbacks match the pre-#32
        # behaviour.
        "{flow_name}": _extra.get("flow_name", flow.name or "unknown"),
        "{final_status}": _extra.get("final_status", "unknown"),
        "{repo_path}": _extra.get("repo_path", str(Path.cwd())),
        "{evidence_summary}": _extra.get("evidence_summary", "(no evidence summary)"),
        "{learnings_excerpt}": _extra.get("learnings_excerpt", "(no previous learnings)"),
        # Wave 2 — Repo Onboarding. Renders the ``## Repo Context``
        # section of the builder prompt. Empty dict when the repo
        # hasn't been onboarded.
        "{repo_context}": json.dumps(repo_context, indent=2, ensure_ascii=False),
    }
    for key, value in variables.items():
        prompt = prompt.replace(key, value)

    # Inject local command or skill directive
    if phase_config.is_local:
        cmd = phase_config.command or ""
        prompt += f"\n\n**LOCAL COMMAND TO RUN:** `{cmd}`"
        _log.emit(FlowEvent(
            kind="phase_start",
            message=f"Running local command: {cmd}",
            timestamp=_flow_logger.now_iso(),
            phase=phase_name,
        ))
    elif skill:
        prompt += f"\n\n**SKILL TO USE:** `{skill}`"
        _log.emit(FlowEvent(
            kind="phase_start",
            message=f"Invoking skill: {skill}",
            timestamp=_flow_logger.now_iso(),
            phase=phase_name,
        ))

    # DEBUG: Show what was built
    extra = state.diagnostic_insights or state.previous_output or ""
    if prd_body:
        extra = f"PRD ({len(prd_body)} chars) | {extra[:200]}"
    _print_prompt_debug(
        phase_name,
        issue_num,
        template_loaded,
        variables,
        prompt,
        extra,
        log=_log,
    )

    return PreparedPrompt(
        text=prompt,
        tools=tuple(loaded.tools),
        model_override=phase_config.model,
        provider_override=phase_config.provider,
        template_loaded=template_loaded,
    )
