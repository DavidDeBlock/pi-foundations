#!/usr/bin/env python3
"""
phase_runner.py — Per-phase execution for the flow engine.

Extracted from ``flow_engine.py`` (deepening PRD issue #31). Owns the
"run one phase, return a ``PhaseRun``" concern. The new contract is
typed end-to-end: ``run_phase`` takes a :class:`~flow_engine.Flow`,
:class:`~flow_engine.FlowContext`, :class:`~flow_engine.PhaseState`,
:class:`Terminal`, :class:`GithubClient`, and :class:`FlowLogger`, and
returns a :class:`~flow_engine.PhaseRun` value object.

The phase loop in :func:`flow_engine.run_flow_on_issue` calls
``run_phase`` for each iteration; ``run_phase`` itself never
dispatches transitions or recurses. It is a pure per-phase function.

What lives here:

- :func:`run_phase` — the public entry. Wraps the inner runner in the
  ``is_optional`` try/except, packages the verdict + duration + tokens
  + session log into a :class:`PhaseRun`.
- :func:`_run_phase_inner` — the per-phase body. Handles the close-
  phase special case, the ``is_local`` subprocess dispatch, the
  retrospective pre-run context population, prompt building, RPC,
  verdict extraction, and the retrospective post-run persistence.
- :func:`_build_session_dir` — the session-log-path builder (moved
  verbatim from ``flow_engine.py``).
- :func:`_extract_phase_tokens` — session-log → ``{tokens_in,
  tokens_out, cache_read}`` reader.
- :func:`_populate_retrospective_context` — fills the retro
  prompt-vars before the LLM call.
- :func:`_persist_retrospective_result` — writes the
  ``### PHASE_OUTPUT`` block to the repo's ``.maestro/learnings.md``
  after the LLM call.
- :func:`_format_evidence_summary`, :func:`_format_learnings_excerpt`,
  :func:`_read_agent_text_from_session_log` — helpers used by the
  two retro functions above.
- The close-phase concern: :data:`DEFAULT_EVIDENCE_POLICY`,
  :func:`get_evidence_policy`, :func:`_close_phase_result`,
  :func:`run_close_phase`. The issue allows either keeping
  ``run_close_phase`` in ``flow_engine.py`` (because it depends on
  the evidence policy) or moving it here for self-containment; the
  latter is preferred — it keeps ``phase_runner.py`` testable in
  isolation and removes the only intra-flow-engine cross-module call
  the close phase used to need.

What stays in ``flow_engine.py``:

- :func:`run_diagnostic` (separate slice, issue #33)
- The phase loop itself (:func:`run_flow_on_issue`)
- The value-object dataclasses (:class:`Flow`, :class:`FlowContext`,
  :class:`PhaseState`, :class:`PhaseRun`, :class:`FlowOutcome`,
  :class:`PhaseConfig`, :class:`Transition`).

What lives in :mod:`prompt_assembler` (deepening PRD issue #32):

- :class:`PreparedPrompt` — the typed return value replacing the
  loose ``(text, tools)`` tuple.
- :func:`build_prompt` — the prompt builder. Takes typed
  ``PhaseConfig`` / ``Flow`` / ``FlowContext`` / ``PhaseState``
  objects plus an ``extra_context: dict`` for the
  retro-specific and pre-formatted-markdown variables that don't
  have a home on the typed objects.

Circular-import handling: ``phase_runner.py`` does
``from flow_engine import Flow, FlowContext, ...`` and
``from prompt_assembler import build_prompt, PreparedPrompt`` at
the top — that direction is safe (flow_engine and prompt_assembler
never import from phase_runner at module load time). ``flow_engine.py``
uses a deferred import (``from phase_runner import run_phase``)
inside :func:`run_flow_on_issue` and :func:`_run_scout_phase` to
call back into the phase runner. This breaks the cycle cleanly.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

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
    PhaseRun,
    PhaseState,
    _flow_from_config,
)
from prompt_assembler import PreparedPrompt, build_prompt  # noqa: E402
from github_client import GithubClient  # noqa: E402
from rpc_client import run_rpc_with_session_log  # noqa: E402
from terminal import Terminal  # noqa: E402
from evidence import EvidenceStore, EvidenceType  # noqa: E402
from learnings import (  # noqa: E402
    LEARNINGS_FILENAME,
    format_learning_entry,
    format_amendment_entry,
    parse_retrospective_output,
    count_recurring_patterns,
    append_to_learnings,
    append_to_amendments,
)


# ─── Logging-port helpers ───────────────────────────────────────────────


def _resolve_log(log: Optional[FlowLogger]) -> FlowLogger:
    """Return the provided logger, or a fresh :class:`StderrLogger`.

    Mirrors the helper in ``flow_engine.py`` — same default behaviour,
    copy-pasted here so ``phase_runner`` does not need to import a
    private symbol from its sibling module.
    """
    return log if log is not None else _flow_logger.StderrLogger()


# ─── Evidence policy (close phase) ──────────────────────────────────────


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
    :func:`run_close_phase` and the phase-runner tests.

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


def run_close_phase(
    flow_config: dict,
    issue_num: int,
    evidence_dir=None,
    log: Optional[FlowLogger] = None,
) -> dict:
    """Run the close phase: mechanically check evidence gates.

    This is invoked from :func:`_run_phase_inner` when the phase is
    named ``"close"`` and ``is_local: true``. It does NOT call an LLM
    — it's a pure local-command phase whose behaviour is fully
    determined by the flow's ``evidence_policy`` and the current
    state of the evidence directory on disk.

    The result dict uses the same shape as :func:`_run_phase_inner`'s
    return — a status of ``"success"`` lets the flow continue,
    ``"reject"`` routes the flow to the next transition (typically
    ``diagnostic`` per the builder-reviewer flow config). We use
    ``"reject"`` (not ``"rejected"``) to match the existing flow
    engine status vocabulary — see :func:`_run_phase_inner`'s
    ``on_reject`` / ``on_error`` transitions.
    """
    return _close_phase_result(
        flow_config, issue_num, evidence_dir=evidence_dir, log=log
    )


# ─── Session-log path builder ───────────────────────────────────────────


def _build_session_dir(flow_name: str, issue_num: int, phase_name: str) -> Optional[str]:
    """Create a session log file path for this flow/phase execution.

    Phase 1+ layout (flat files):
        <session_base>/<issue>/<flow>-<phase>-<ISO8601>.jsonl

    Old layout (subdirectories) is no longer used - kept only for
    backward compatibility with existing session directories on disk.

    Reads ``session_dir`` from ``config.json``. ``MAESTRO_SESSION_DIR``
    env var overrides: set to a path to use it, or ``"0"``/empty to
    disable.

    Returns:
        Path to the ``.jsonl`` file (not a directory).
    """
    maestro_dir = Path(__file__).parent
    project_root = maestro_dir.parent.parent  # .pi/maestro → .pi → project root

    def _build_flat_path(base_session_dir: Path) -> str:
        """Build a flat-file session path: ``<issue>/<flow>-<phase>-<ISO8601>.jsonl``"""
        safe_phase = phase_name.replace("/", "-")  # Handle skill paths like /skill:tdd
        iso_ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        issue_dir = base_session_dir / str(issue_num)
        os.makedirs(issue_dir, exist_ok=True)
        jsonl_file = issue_dir / f"{flow_name}-{safe_phase}-{iso_ts}.jsonl"
        return str(jsonl_file)

    # Env var takes absolute precedence when explicitly set
    if "MAESTRO_SESSION_DIR" in os.environ:
        env_override = os.environ["MAESTRO_SESSION_DIR"]
        if not env_override or env_override == "0":
            return None
        base_session_dir = Path(env_override)
        os.makedirs(base_session_dir, exist_ok=True)
        return _build_flat_path(base_session_dir)

    config_path = maestro_dir / "config.json"
    base_session_dir: Optional[Path] = None

    if config_path.exists():
        try:
            with open(config_path) as f:
                cfg = json.load(f)
                raw = cfg.get("session_dir", "") or ""
                if not raw.strip():
                    return None
                candidate = Path(raw)
                if candidate.is_absolute():
                    base_session_dir = candidate
                else:
                    base_session_dir = project_root / candidate
        except (json.JSONDecodeError, IOError):
            pass

    if not base_session_dir:
        return None

    os.makedirs(base_session_dir, exist_ok=True)
    return _build_flat_path(base_session_dir)


# ─── Token plumbing ─────────────────────────────────────────────────────


def _extract_phase_tokens(session_log_path: Optional[object]) -> dict:
    """Return ``{tokens_in, tokens_out, cache_read}`` from a session log.

    Wraps :func:`session_reader.extract_phase_usage` with the
    field-mapping the runner uses:

        - ``tokens_in``  = ``usage["input"] + usage["cacheWrite"]``
          (the "real" input cost, including cache writes)
        - ``tokens_out`` = ``usage["output"]``
        - ``cache_read`` = ``usage["cacheRead"]``

    All three default to ``None`` when the log is missing or has no
    usage data. The local-command and close phases have no session
    log — they return ``(None, None, None)`` here. The ``is_optional``
    exception path also returns ``None``s (no log on hard failure).
    """
    if not session_log_path:
        return {"tokens_in": None, "tokens_out": None, "cache_read": None}
    # Local import to avoid dragging session_reader into modules that
    # don't need it (the helper is a single function call from inside
    # the runner body).
    from session_reader import extract_phase_usage  # noqa: E402  (lazy)

    usage = extract_phase_usage(session_log_path)
    if not isinstance(usage, dict):
        return {"tokens_in": None, "tokens_out": None, "cache_read": None}
    try:
        tokens_in = int(usage.get("input", 0)) + int(usage.get("cacheWrite", 0))
        tokens_out = int(usage.get("output", 0))
        cache_read = int(usage.get("cacheRead", 0))
    except (TypeError, ValueError):
        return {"tokens_in": None, "tokens_out": None, "cache_read": None}
    return {"tokens_in": tokens_in, "tokens_out": tokens_out, "cache_read": cache_read}


# ─── Retrospective helpers (pre-run context + post-run persistence) ────


def _populate_retrospective_context(
    context: dict,
    flow_config: dict,
    issue_num: int,
) -> None:
    """Fill in retrospective-specific context variables.

    Populates ``flow_name``, ``final_status``, ``repo_path``,
    ``evidence_summary``, and ``learnings_excerpt`` on the context
    dict so the retrospective prompt has everything it needs.
    Idempotent — safe to call from multiple places.
    """
    # flow_name
    context.setdefault("flow_name", flow_config.get("name", "unknown"))

    # final_status — read from the most recent phase_outputs entry.
    # Close's status is the canonical "did the flow succeed" indicator
    # for PR flows. If not present, fall back to the last entry.
    phase_outputs = context.get("phase_outputs") or {}
    if "close" in phase_outputs:
        context.setdefault("final_status", phase_outputs["close"].get("status", "unknown"))
    else:
        last_status = "unknown"
        for ph_status in phase_outputs.values():
            if isinstance(ph_status, dict) and "status" in ph_status:
                last_status = ph_status["status"]
        context.setdefault("final_status", last_status)

    # repo_path
    wm = context.get("working_memory") or {}
    if isinstance(wm, dict) and wm.get("repo_path"):
        context.setdefault("repo_path", wm["repo_path"])
    else:
        context.setdefault("repo_path", str(Path.cwd()))

    # evidence_summary
    context.setdefault("evidence_summary", _format_evidence_summary(issue_num))

    # learnings_excerpt
    context.setdefault(
        "learnings_excerpt",
        _format_learnings_excerpt(Path(context["repo_path"])),
    )


def _format_evidence_summary(issue_num: int) -> str:
    """Return a one-line summary of evidence markers for the issue.

    Lists each evidence type as ``<type>=<verified|missing>``. Falls
    back to a friendly default if the evidence dir doesn't exist or
    any other I/O error occurs — retrospective must never crash on
    evidence lookup.
    """
    try:
        store = EvidenceStore(issue_num)
    except Exception:
        return "(evidence dir unavailable)"

    lines: list[str] = []
    for etype in EvidenceType:
        try:
            marker = store.read(etype)
        except Exception:
            marker = None
        if marker is None:
            lines.append(f"{etype.value}=missing")
        elif marker.verified:
            lines.append(f"{etype.value}=verified")
        else:
            lines.append(f"{etype.value}=unverified")

    return ", ".join(lines) if lines else "(no evidence types configured)"


def _format_learnings_excerpt(repo_path: Path, max_chars: int = 2000) -> str:
    """Return the tail of the repo's ``learnings.md`` (or a default).

    The retrospective prompt only needs enough history to detect
    recurring patterns — the full file is not necessary, and would
    blow up the token budget. 2000 chars gives roughly the last 5-10
    entries, which is enough for the keyword-overlap detector.
    """
    path = Path(repo_path) / LEARNINGS_FILENAME
    if not path.exists():
        return "(no previous learnings)"

    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return "(unreadable learnings file)"

    if len(text) <= max_chars:
        return text
    return "...[truncated]...\n" + text[-max_chars:]


def _read_agent_text_from_session_log(session_log_path: "Path") -> str:
    """Read a session ``.jsonl`` and concatenate the agent's text parts.

    Returns an empty string if the file is missing, unreadable, or
    contains no assistant text. Never raises.
    """
    if not session_log_path or not Path(session_log_path).exists():
        return ""
    try:
        texts: list[str] = []
        with open(session_log_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                msg = event.get("message") if isinstance(event, dict) else None
                if not isinstance(msg, dict) or msg.get("role") != "assistant":
                    continue
                content = msg.get("content", [])
                if not isinstance(content, list):
                    continue
                for part in content:
                    if (
                        isinstance(part, dict)
                        and part.get("type") == "text"
                        and isinstance(part.get("text"), str)
                    ):
                        texts.append(part["text"])
        return "\n".join(texts)
    except Exception:
        return ""


def _persist_retrospective_result(
    issue_num: int,
    flow_name: str,
    rpc_output: str,
    flow_status: str,
    repo_path: "Path",
    session_log_path: "Optional[str]" = None,
    log: Optional[FlowLogger] = None,
) -> None:
    """Parse the retrospective ``PHASE_OUTPUT`` and persist to
    ``.maestro/learnings.md``.

    Called after the LLM-driven retrospective phase completes. The
    function is best-effort: any I/O error is logged and swallowed
    (retrospective is non-blocking — see :func:`run_phase`).
    """
    _log = _resolve_log(log)
    _ts = _flow_logger.now_iso()
    source_text = rpc_output or ""
    if session_log_path:
        try:
            session_text = _read_agent_text_from_session_log(Path(session_log_path))
            if session_text:
                source_text = session_text
        except Exception as e:  # noqa: BLE001
            _log.emit(FlowEvent(
                kind="phase_end",
                message=(
                    f"Could not read session log "
                    f"({session_log_path}): {type(e).__name__}: {e}; "
                    f"falling back to rpc_output"
                ),
                timestamp=_ts,
                phase="retrospective",
            ))
    parsed = parse_retrospective_output(source_text)
    if "parse_error" in parsed:
        _log.emit(FlowEvent(
            kind="phase_end",
            message=f"No PHASE_OUTPUT block found: {parsed['parse_error']}",
            timestamp=_ts,
            phase="retrospective",
        ))
        parsed = {
            "outcome": flow_status,
            "what_worked": [],
            "what_failed": [],
            "surprising": [],
            "repo_specific_learnings": ["(retrospective LLM emitted no PHASE_OUTPUT)"],
            "proposed_amendments": [],
        }

    try:
        entry = format_learning_entry(issue_num, flow_status, parsed)
        append_to_learnings(repo_path, entry)
        _log.emit(FlowEvent(
            kind="phase_end",
            message=(
                f"Wrote learning entry for issue #{issue_num} "
                f"to {repo_path / LEARNINGS_FILENAME}"
            ),
            timestamp=_ts,
            phase="retrospective",
        ))
    except Exception as e:  # noqa: BLE001
        _log.emit(FlowEvent(
            kind="phase_end",
            message=(
                f"Failed to write learnings file: "
                f"{type(e).__name__}: {e}"
            ),
            timestamp=_ts,
            phase="retrospective",
        ))
        return

    # Check for recurring patterns and emit an amendment if ≥3 match.
    what_failed = parsed.get("what_failed") or []
    if isinstance(what_failed, list) and what_failed:
        current_failure = "; ".join(str(x) for x in what_failed)
        try:
            occurrences = count_recurring_patterns(repo_path, current_failure)
        except Exception:
            occurrences = 0
        if occurrences >= 3:
            amendments = parsed.get("proposed_amendments") or []
            if not isinstance(amendments, list) or not amendments:
                amendments = [{
                    "title": f"Recurring pattern observed in {repo_path.name or 'repo'}",
                    "root_cause": current_failure[:200],
                    "proposed_fix": "Review learnings.md and tighten the relevant prompt.",
                    "effort": "TBD",
                }]
            for amend in amendments:
                if not isinstance(amend, dict):
                    continue
                try:
                    amend_entry = format_amendment_entry(amend, occurrences)
                    append_to_amendments(repo_path, amend_entry)
                    _log.emit(FlowEvent(
                        kind="phase_end",
                        message=(
                            f"Proposed amendment: "
                            f"{amend.get('title', '?')!r} "
                            f"({repo_path / '.maestro' / 'proposed-amendments.md'})"
                        ),
                        timestamp=_ts,
                        phase="retrospective",
                    ))
                except Exception as e:  # noqa: BLE001
                    _log.emit(FlowEvent(
                        kind="phase_end",
                        message=(
                            f"Failed to write amendment: "
                            f"{type(e).__name__}: {e}"
                        ),
                        timestamp=_ts,
                        phase="retrospective",
                    ))


# ─── Inner phase runner (private) ───────────────────────────────────────


def _run_phase_inner(
    phase_name: str,
    flow_config: dict,
    issue_num: int,
    context: dict,
    log: Optional[FlowLogger] = None,
) -> Tuple[dict, Optional[str]]:
    """Inner phase runner — the original ``run_phase`` body.

    Split out so :func:`run_phase` can wrap it in a non-blocking
    try/except for ``is_optional`` phases (retrospective). All callers
    should use :func:`run_phase`, not this private helper.
    """
    phase_config = flow_config["phases"][phase_name]
    _log = _resolve_log(log)

    # Local command phases run directly via subprocess (no LLM)
    if phase_config.get("is_local"):
        # The ``close`` phase is special: it's the evidence gate. We
        # dispatch to :func:`run_close_phase` instead of the generic
        # subprocess handler so the flow's ``evidence_policy`` is
        # applied (block / warn_but_proceed / ignore). The phase's
        # ``command`` field is kept for documentation / non-evidence
        # backstops but is not invoked.
        if phase_name == "close":
            result = run_close_phase(flow_config, issue_num, log=_log)
            # Cache the close-phase result in context for downstream
            # phases (e.g. retrospective) to read.
            context.setdefault("phase_outputs", {})["close"] = result
            return result, None

        cmd = phase_config.get("command", "").replace("{issue_number}", str(issue_num))
        _log.emit(FlowEvent(
            kind="phase_start",
            message=f"Running local command: {cmd}",
            timestamp=_flow_logger.now_iso(),
            phase=phase_name,
        ))

        try:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True,
                timeout=phase_config.get("timeout_seconds", 60)
            )
            if result.returncode == 0:
                return {"status": "success", "details": f"Local command succeeded: {cmd}"}, None
            else:
                err = (result.stderr or result.stdout)[:300]
                return {"status": "reject", "details": f"Local command failed ({result.returncode}): {err}"}, None
        except subprocess.TimeoutExpired:
            return {"status": "error", "details": f"Local command timed out after {phase_config.get('timeout_seconds', 60)}s"}, None
        except Exception as e:
            return {"status": "error", "details": f"Local command error: {str(e)[:200]}"}, None

    # ── Retrospective pre-run setup ─────────────────────────────────
    # Populate context variables the retrospective prompt uses (flow
    # name, final status, repo path, evidence summary, learnings tail).
    # This is a no-op for non-retrospective phases.
    if phase_name == "retrospective":
        try:
            _populate_retrospective_context(context, flow_config, issue_num)
        except Exception as e:  # noqa: BLE001
            # Best-effort — defaults in build_prompt are safe.
            _log.emit(FlowEvent(
                kind="phase_end",
                message=(
                    f"Failed to populate context: "
                    f"{type(e).__name__}: {e}"
                ),
                timestamp=_flow_logger.now_iso(),
                phase="retrospective",
            ))

    # ── Build typed inputs for the new ``build_prompt`` (issue #32) ──
    # The prompt builder now takes ``PhaseConfig`` / ``Flow`` /
    # ``FlowContext`` / ``PhaseState`` value objects and returns a
    # :class:`PreparedPrompt`. The inner runner still holds the
    # legacy dict forms, so the conversion happens here.
    _flow_obj = _flow_from_config(flow_config)
    _phase_config_obj = _build_phase_config_from_dict(phase_config, phase_name)
    _flow_context_obj = _build_flow_context_from_dict(context, _flow_obj, issue_num)
    _state_obj = _build_phase_state_from_dict(context, phase_name)
    _extra_ctx = _extra_context_from_dict(context)

    prepared: PreparedPrompt = build_prompt(
        phase_name=phase_name,
        phase_config=_phase_config_obj,
        flow=_flow_obj,
        issue_num=issue_num,
        context=_flow_context_obj,
        state=_state_obj,
        log=_log,
        extra_context=_extra_ctx,
    )
    prompt = prepared.text
    tools = list(prepared.tools)
    # Future per-phase model / provider override wiring would read
    # from ``prepared.model_override`` / ``prepared.provider_override``
    # (currently always None — the slots are reserved for a future
    # slice). For now, fall back to the phase_config dict so the
    # behaviour is identical to the pre-#32 code.
    if prepared.model_override is not None:
        model = prepared.model_override
    else:
        model = phase_config.get("model")
    if prepared.provider_override is not None:
        provider = prepared.provider_override
    else:
        provider = phase_config.get("provider")

    _log.emit(FlowEvent(
        kind="phase_start",
        message=f"Running '{phase_name}' on issue #{issue_num}",
        timestamp=_flow_logger.now_iso(),
        phase=phase_name,
    ))

    timeout = phase_config.get("timeout_seconds", 1800)

    # Build session directory for this run (opt-in via MAESTRO_LOG_SESSIONS)
    flow_name = flow_config.get("name", "unknown")
    session_dir = _build_session_dir(flow_name, issue_num, phase_name)
    if session_dir:
        _log.emit(FlowEvent(
            kind="phase_start",
            message=f"Session dir: {session_dir}",
            timestamp=_flow_logger.now_iso(),
            phase=phase_name,
        ))

    rpc_result = run_rpc_with_session_log(
        prompt, phase_name, timeout,
        model=model, provider=provider,
        session_dir=session_dir,
        tools=tools,
    )

    session_log_path = rpc_result.get("session_log")

    if not rpc_result["success"]:
        return {
            "status": "error",
            "details": f"RPC failed: {rpc_result['output'][:200]}"
        }, session_log_path

    # Extract verdict from the result dict — single source of truth
    status_data = rpc_result.get("result", {})
    phase_status = status_data.get("status")

    # Handle error state: verdict extraction failed (no verdict block in session log)
    if phase_status == "error":
        details_text = status_data.get(
            "details",
            "No verdict extracted from session log"
        )

        # Retrospective is special: the agent emits a `### PHASE_OUTPUT` block
        # (not a ` ```verdict ` fence). The verdict_extractor fallback added
        # in lib/verdict_extractor.py handles this, but if it still fails
        # we must NOT let the flow break — retrospective is declared
        # `is_optional: true` and the transition routes every outcome to
        # `finish`.
        if phase_name == "retrospective":
            try:
                repo_path_for_retro = Path(context.get("repo_path", Path.cwd()))
                flow_status_value = str(context.get("final_status") or "error")
                _persist_retrospective_result(
                    issue_num=issue_num,
                    flow_name=str(context.get("flow_name", flow_config.get("name", "unknown"))),
                    rpc_output=rpc_result.get("output", "") or "",
                    flow_status=flow_status_value,
                    repo_path=repo_path_for_retro,
                    session_log_path=session_log_path,
                )
            except Exception as persist_err:  # noqa: BLE001
                _log.emit(FlowEvent(
                    kind="phase_end",
                    message=(
                        f"Persistence on verdict-error path failed: "
                        f"{type(persist_err).__name__}: {persist_err}"
                    ),
                    timestamp=_flow_logger.now_iso(),
                    phase="retrospective",
                ))
            return (
                {
                    "status": "success",
                    "details": (
                        f"retrospective completed (non-blocking): verdict "
                        f"extraction failed ({details_text[:120]}), but "
                        f"persistence was attempted from raw output"
                    ),
                },
                session_log_path,
            )

        return {
            "status": "error",
            "details": f"Verdict extraction failed: {details_text}"
        }, session_log_path

    # Binary verdict model: approved / rejected
    if phase_status == "approved":
        final_status = "success"
        details = f"{phase_name} approved"
    elif phase_status == "rejected":
        final_status = "reject"
        issues = status_data.get("issues", [])
        verdict = status_data.get("verdict", "")

        if issues:
            details_parts = [f"{phase_name} rejected"]
            for issue in issues[:5]:
                details_parts.append(f"• {issue}")
            details = "\n".join(details_parts)
        elif verdict:
            details = f"{phase_name} rejected: {verdict}"
        else:
            details = f"{phase_name} self-rejected (no details in result)"
    elif phase_status == "no_gaps":
        # Backward-compatible passthrough for existing flow configurations
        final_status = "no_gaps"
        details = status_data.get("message", f"No significant gaps found in {phase_name}")
    else:
        # Unknown or non-standard status — fail loudly rather than misclassify
        return {
            "status": "error",
            "details": (
                f"Unexpected verdict status '{phase_status}' from rpc_client. "
                f"Expected one of: approved, rejected, no_gaps, error"
            ),
        }, session_log_path

    # ── Retrospective post-run persistence ──────────────────────────
    if phase_name == "retrospective":
        try:
            repo_path_for_retro = Path(context.get("repo_path", Path.cwd()))
            flow_status_value = str(context.get("final_status") or final_status)
            _persist_retrospective_result(
                issue_num=issue_num,
                flow_name=str(context.get("flow_name", flow_config.get("name", "unknown"))),
                rpc_output=rpc_result.get("output", "") or "",
                flow_status=flow_status_value,
                repo_path=repo_path_for_retro,
                session_log_path=session_log_path,
                log=_log,
            )
        except Exception as e:  # noqa: BLE001
            _log.emit(FlowEvent(
                kind="phase_end",
                message=(
                    f"Persistence step failed: "
                    f"{type(e).__name__}: {e}"
                ),
                timestamp=_flow_logger.now_iso(),
                phase="retrospective",
            ))

    return {
        "status": final_status,
        "details": details,
        "output": rpc_result["output"]
    }, session_log_path


# ─── Flow ↔ dict conversion helpers ─────────────────────────────────────
#
# ``run_phase`` takes typed ``Flow`` / ``FlowContext`` / ``PhaseState``
# values, but the inner helpers (``build_prompt``, ``run_close_phase``,
# ``_run_phase_inner``) still work with the legacy dict form. These
# two helpers reconstruct the dicts from the typed values. They are
# the "seam" between the new typed contract and the not-yet-refactored
# inner body.


def _flow_to_dict(flow: Flow) -> dict:
    """Build the legacy ``flow_config`` dict from a :class:`Flow`.

    Used to feed the inner runner, which still expects the old dict
    shape. Only the keys the inner runner actually reads are
    populated (``name``, ``phases``, ``evidence_policy``).
    """
    return {
        "name": flow.name,
        "phases": dict(flow.phases),
        "evidence_policy": dict(flow.evidence_policy),
    }


def _context_to_dict(context: FlowContext) -> dict:
    """Build the legacy ``context`` dict from a :class:`FlowContext`.

    The inner runner expects a context dict with a long list of
    optional keys (prompt, prd_body, working_memory,
    prefetched_context_md, repo_context, scout_findings_md,
    phase_outputs, …). The :class:`FlowContext` value object holds
    the same data in typed form; this helper unwraps it.
    """
    body = context.issue_body or ""
    ctx: dict = {"prompt": f"## Issue #{context.issue_num}\n\n{body}"}
    if context.parent_prd:
        ctx["prd_body"] = context.parent_prd
    if context.working_memory is not None:
        try:
            ctx["working_memory"] = context.working_memory.to_dict()
        except Exception:
            pass
    if context.prefetched is not None:
        try:
            from context_prefetch import format_prefetched_context
            ctx["prefetched_context_md"] = format_prefetched_context(context.prefetched)
            ctx["prefetched_context"] = context.prefetched
        except Exception:
            pass
    if context.repo_context:
        ctx["repo_context"] = dict(context.repo_context)
    if context.scout_findings is not None:
        try:
            from scout_findings import format_scout_findings_markdown
            ctx["scout_findings_md"] = format_scout_findings_markdown(
                context.scout_findings
            )
        except Exception:
            pass
    return ctx


# ─── dict → typed-object conversion helpers ──────────────────────────
#
# Per deepening PRD issue #32, :func:`prompt_assembler.build_prompt`
# takes typed ``PhaseConfig`` / ``Flow`` / ``FlowContext`` /
# ``PhaseState`` inputs. The inner runner still receives the legacy
# ``flow_config: dict`` / ``context: dict`` shapes from
# :func:`run_phase`'s legacy shim, so the conversion happens here in
# :func:`_run_phase_inner` (right before the ``build_prompt`` call).
# These helpers do that conversion. They're the inverse of
# :func:`_flow_to_dict` / :func:`_context_to_dict` above.

#: Keys that the typed :class:`FlowContext` already covers. They're
#: consumed by :func:`prompt_assembler.build_prompt` via attribute
#: access on ``context``, NOT via ``extra_context`` — the dict is the
#: source of truth, but :func:`build_prompt` reads the typed form.
_EXTRA_CONTEXT_KEYS = (
    # Retrospective-specific
    "flow_name",
    "final_status",
    "repo_path",
    "evidence_summary",
    "learnings_excerpt",
    # Pre-formatted markdown caches (match the pre-#32 dict behaviour
    # where the dispatcher populated ``prefetched_context_md`` and
    # ``scout_findings_md`` to avoid re-formatting in build_prompt).
    "prefetched_context_md",
    "scout_findings_md",
)


def _build_phase_config_from_dict(phase_config: dict, phase_name: str) -> PhaseConfig:
    """Build a :class:`PhaseConfig` value object from a phase dict.

    The inner runner reads ``phase_config: dict`` (a parsed JSON
    section of the flow config). :func:`build_prompt` wants the
    typed form. The :class:`PhaseConfig` is ``frozen=True`` so the
    conversion is a one-shot snapshot.
    """
    raw_tools = phase_config.get("tools") or []
    return PhaseConfig(
        name=phase_name,
        skill=str(phase_config.get("skill", "") or ""),
        timeout_seconds=int(phase_config.get("timeout_seconds", 1800) or 1800),
        retries=int(phase_config.get("retries", 1) or 1),
        is_local=bool(phase_config.get("is_local", False)),
        is_optional=bool(phase_config.get("is_optional", False)),
        model=phase_config.get("model"),
        provider=phase_config.get("provider"),
        command=phase_config.get("command"),
        tools=tuple(raw_tools),
    )


def _build_flow_context_from_dict(
    context: dict, flow: Flow, issue_num: int,
) -> FlowContext:
    """Build a :class:`FlowContext` from the legacy context dict.

    The dispatcher populated the dict with keys
    (``prompt``, ``prd_body``, ``working_memory``,
    ``prefetched_context``, ``repo_context``, ``scout_findings_md``).
    The typed :class:`FlowContext` holds the same data — this
    helper re-packs it. ``WorkingMemory`` and ``PrefetchedContext``
    are reconstructed from their dict / object forms when present.
    """
    body = context.get("prompt") or f"## Issue #{issue_num}\n\nPlease execute this phase."

    # parent_prd: prefer the explicit ``prd_body`` key (the dict
    # shape). Strip the ``## Issue #N\n\n`` prefix the dispatcher
    # prepends — the typed FlowContext stores the raw body.
    prd = context.get("prd_body")
    issue_body = body
    prefix = f"## Issue #{issue_num}\n\n"
    if body.startswith(prefix):
        issue_body = body[len(prefix):]

    # working_memory
    wm = None
    wm_dict = context.get("working_memory")
    if isinstance(wm_dict, dict) and wm_dict:
        try:
            from working_memory import WorkingMemory
            wm_dict = dict(wm_dict)
            wm_dict.setdefault("issue", issue_num)
            wm = WorkingMemory.from_dict(wm_dict)
        except Exception:
            wm = None

    # prefetched
    prefetched = context.get("prefetched_context")
    if prefetched is None and "prefetched" in context:
        prefetched = context.get("prefetched")

    # repo_context
    repo_ctx = context.get("repo_context")
    repo_ctx = dict(repo_ctx) if isinstance(repo_ctx, dict) else None

    return FlowContext(
        flow=flow,
        issue_num=issue_num,
        issue_body=issue_body,
        issue_title="",
        parent_prd=prd,
        working_memory=wm,
        prefetched=prefetched,
        repo_context=repo_ctx,
        scout_findings=None,  # formatted scout_findings_md stays in extra_context
    )


def _build_phase_state_from_dict(context: dict, phase_name: str) -> PhaseState:
    """Build a :class:`PhaseState` from the per-iteration context keys.

    The flow loop mutates ``context["previous_output"]``,
    ``context["diagnostic_insights"]`` and ``context["phase_outputs"]``
    between iterations. The typed :class:`PhaseState` is the
    canonical form; this helper re-packs it.
    """
    return PhaseState(
        current_phase=phase_name,
        phase_attempt=int(context.get("phase_attempt", 1) or 1),
        previous_output=str(context.get("previous_output", "") or ""),
        diagnostic_insights=str(context.get("diagnostic_insights", "") or ""),
        phase_outputs=dict(context.get("phase_outputs") or {}),
    )


def _extra_context_from_dict(context: dict) -> dict:
    """Pick the keys :func:`build_prompt` reads from ``extra_context``.

    Retro-specific (``flow_name``, ``final_status``, ``repo_path``,
    ``evidence_summary``, ``learnings_excerpt``) and pre-formatted
    markdown caches (``prefetched_context_md``, ``scout_findings_md``)
    don't have a home on the typed objects, so :func:`build_prompt`
    reads them from this dict.
    """
    return {k: context[k] for k in _EXTRA_CONTEXT_KEYS if k in context}


# ─── Public entry point ─────────────────────────────────────────────────


def run_phase(
    phase_name: str,
    flow: Flow,
    context: FlowContext,
    state: PhaseState,
    term: Terminal,
    gh: GithubClient,
    log: FlowLogger,
) -> PhaseRun:
    """Execute a single phase and return a :class:`PhaseRun`.

    The new contract (deepening PRD issue #31): typed inputs on the
    way in, a :class:`PhaseRun` value object on the way out. The
    verdict, the duration, the token counts, and the session log path
    are bundled into a single immutable record. The caller (the phase
    loop in ``flow_engine.run_flow_on_issue``) appends the
    :class:`PhaseRun` to its outcome and moves to the next phase.

    Args:
        phase_name: The phase key (e.g. ``"builder"``, ``"reviewer"``,
            ``"close"``).
        flow: The :class:`Flow` value object. ``flow.phases[phase_name]``
            is the per-phase config; ``flow.evidence_policy`` is the
            close-phase policy.
        context: The :class:`FlowContext` value object — everything
            the flow knows about the issue.
        state: The :class:`PhaseState` value object. Mutated fields
            (current_phase, phase_attempt, phase_outputs) propagate
            back to the loop.
        term: The :class:`Terminal` (kept on the signature for the
            future diagnostic-dispatch slice; currently unused inside
            ``run_phase``).
        gh: The :class:`GithubClient` (kept on the signature for the
            future label-update / post-comment slices; currently
            unused inside ``run_phase``).
        log: The :class:`FlowLogger` port. All structured events
            emitted by the runner are routed through it.

    Returns:
        A :class:`PhaseRun` recording the attempt's name, status,
        duration, tokens, session log path, and a short details
        string.
    """
    _log = _resolve_log(log)
    flow_config = _flow_to_dict(flow)
    ctx = _context_to_dict(context)

    # Carry the per-iteration phase_outputs dict through to the inner
    # helpers (e.g. retrospective reads the close phase's verdict from
    # it). The runner mutates ``ctx["phase_outputs"]``; we read it
    # back off the context dict after the inner call and update the
    # typed :class:`PhaseState` to match.
    if state.phase_outputs:
        ctx["phase_outputs"] = dict(state.phase_outputs)

    phase_config = flow_config["phases"][phase_name]
    is_optional = bool(phase_config.get("is_optional"))
    started = datetime.now()

    def _build_phase_run(
        status: str,
        details: str,
        session_log_path: Optional[str],
        tokens: Optional[dict] = None,
    ) -> PhaseRun:
        duration_s = (datetime.now() - started).total_seconds()
        if tokens is None:
            tokens = _extract_phase_tokens(session_log_path)
        return PhaseRun(
            name=phase_name,
            attempt=state.phase_attempt,
            status=status,
            duration_s=duration_s,
            tokens_in=tokens.get("tokens_in"),
            tokens_out=tokens.get("tokens_out"),
            cache_read=tokens.get("cache_read"),
            session_log=Path(session_log_path) if session_log_path else None,
            details=(details or "")[:1000],
        )

    if is_optional:
        try:
            result, session_log = _run_phase_inner(
                phase_name, flow_config, context.issue_num, ctx, log=_log,
            )
        except Exception as e:  # noqa: BLE001
            # Non-fatal: log and convert to a synthetic success result.
            err_msg = f"{type(e).__name__}: {e}"
            _log.emit(FlowEvent(
                kind="phase_end",
                message=f"Failed (non-fatal): {err_msg}",
                timestamp=_flow_logger.now_iso(),
                phase=phase_name,
            ))
            phase_run = _build_phase_run(
                status="success",
                details=f"{phase_name} failed (non-blocking, logged): {err_msg}",
                session_log_path=None,
            )
            # Propagate the (possibly mutated) ctx back to the state.
            _sync_state(state, ctx)
            return phase_run

        # Belt and braces: the inner runner now also downgrades
        # verdict-extraction errors for the retrospective phase to a
        # success, but other ``is_optional`` phases (added in the
        # future) could still return ``{"status": "error", ...}`` from
        # the extractor. Treat any error return from an optional phase
        # as non-fatal too — log it loudly, but never break the flow.
        if isinstance(result, dict) and result.get("status") == "error":
            err_details = result.get("details", "unknown error")
            _log.emit(FlowEvent(
                kind="phase_end",
                message=f"Returned error (non-fatal, downgraded): {err_details}",
                timestamp=_flow_logger.now_iso(),
                phase=phase_name,
            ))
            phase_run = _build_phase_run(
                status="success",
                details=(
                    f"{phase_name} error downgraded to non-blocking success: "
                    f"{err_details}"
                ),
                session_log_path=session_log,
            )
            _sync_state(state, ctx)
            return phase_run

        # Happy-path: package the result + tokens into a PhaseRun.
        details = (result.get("details", "") if isinstance(result, dict) else "")
        phase_run = _build_phase_run(
            status=result.get("status", "error") if isinstance(result, dict) else "error",
            details=details,
            session_log_path=session_log,
        )
        _sync_state(state, ctx)
        return phase_run

    result, session_log = _run_phase_inner(
        phase_name, flow_config, context.issue_num, ctx, log=_log,
    )
    details = (result.get("details", "") if isinstance(result, dict) else "")
    phase_run = _build_phase_run(
        status=result.get("status", "error") if isinstance(result, dict) else "error",
        details=details,
        session_log_path=session_log,
    )
    _sync_state(state, ctx)
    return phase_run


def _sync_state(state: PhaseState, ctx: dict) -> None:
    """Copy per-iteration mutations from the dict back into the
    typed :class:`PhaseState`.

    The inner runner mutates the context dict in place (e.g. writing
    ``ctx["phase_outputs"]["close"] = ...`` for downstream consumers,
    or ``ctx["diagnostic_insights"] = ...`` after a diagnostic run).
    The typed :class:`PhaseState` is the new contract; we copy the
    relevant keys back so callers reading the state after
    :func:`run_phase` returns see the same data they would have seen
    in the pre-refactor code path.
    """
    if not isinstance(ctx, dict):
        return
    if "phase_outputs" in ctx and isinstance(ctx["phase_outputs"], dict):
        state.phase_outputs = dict(ctx["phase_outputs"])
    if "diagnostic_insights" in ctx and isinstance(ctx["diagnostic_insights"], str):
        state.diagnostic_insights = ctx["diagnostic_insights"]
    if "previous_output" in ctx and isinstance(ctx["previous_output"], str):
        state.previous_output = ctx["previous_output"]
