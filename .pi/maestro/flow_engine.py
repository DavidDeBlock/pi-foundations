#!/usr/bin/env python3
"""
flow_engine.py - Core execution engine for a single flow on a single issue.

Handles:
- Issue metadata fetching & header display
- Phase loop with per-phase retry counters
- Session log parsing & inline metadata rendering
- GitHub comment gating (first rejection + final success)
- Terminal tree layout output
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent / "lib"))

from terminal import Terminal
from rpc_client import run_rpc_with_session_log
from github_client import GithubClient
from session_reader import parse_session_log
from prompt_loader import load_prompt, PERMISSIVE_FALLBACK
from working_memory import MemoryStore, WorkingMemory, now_iso
from context_prefetch import (
    prefetch_context,
    format_prefetched_context,
    PrefetchedContext,
)
from scout_findings import (
    parse_scout_findings_from_details,
    format_scout_findings_markdown,
)
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
from projects_registry import (  # noqa: E402
    REGISTRY_FILENAME as PROJECTS_REGISTRY_FILENAME,
    ProjectsRegistry,
)


# ─── Evidence policy defaults ─────────────────────────────────────────────
#
# Per the evidence gates PRD, every flow has a default evidence policy of
# ``warn_but_proceed`` with ``[tested, reviewed]`` required. PR flows can
# override to ``block``; audit flows can override to ``ignore`` or empty.
# The defaults are intentionally lenient to preserve backward compatibility
# with existing flows (e.g. ``gap-check``, ``prd-audit``) that don't write
# evidence.

DEFAULT_EVIDENCE_POLICY: dict = {
    "required_on_success": ["tested", "reviewed"],
    "on_missing_evidence": "warn_but_proceed",
}


def get_evidence_policy(flow_config: dict) -> dict:
    """Return the effective evidence policy for a flow.

    Reads ``flow_config["evidence_policy"]`` and merges with
    :data:`DEFAULT_EVIDENCE_POLICY`. Unrecognized keys are preserved
    (forward-compat). Missing policy → defaults (no surprise, all flows
    behave the same as before this slice shipped).
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
) -> dict:
    """Compute the close-phase result based on the flow's evidence policy.

    Centralised here so the AC-specified policies (``block``,
    ``warn_but_proceed``, ``ignore``) all live in one place. Used by
    :func:`run_close_phase` and the flow-evidence tests.

    Returns a dict with ``status`` and ``details`` (matches the contract
    used by ``run_phase``). ``status`` is one of:
        - ``"success"`` — evidence is present OR policy allowed proceeding
        - ``"rejected"`` — evidence is missing AND policy is ``block``
    """
    from pathlib import Path

    policy = get_evidence_policy(flow_config)
    required = [EvidenceType(t) for t in policy.get("required_on_success", [])]
    on_missing = policy.get("on_missing_evidence", "warn_but_proceed")

    # Allow the test/CLI path to override the default EVIDENCE_DIR for
    # isolation. The flow config doesn't carry a path — that's a session-
    # level concern.
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
        # Use the same logging style as the rest of the flow engine.
        print(
            f"[WARN] Missing evidence for issue #{issue_num}: {missing_values}",
            file=sys.stderr,
        )
        print(
            "[WARN] Proceeding without required evidence (warn_but_proceed policy)",
            file=sys.stderr,
        )
        sys.stderr.flush()
        return {
            "status": "success",
            "details": (
                f"Missing evidence (warned): {missing_values} "
                f"(required: {required_values})"
            ),
        }
    # on_missing == "ignore" or any other value → skip the check entirely
    return {
        "status": "success",
        "details": f"Evidence check skipped (policy: {on_missing})",
    }


def run_close_phase(
    flow_config: dict,
    issue_num: int,
    evidence_dir=None,
) -> dict:
    """Run the close phase: mechanically check evidence gates.

    This is invoked from :func:`run_phase` when the phase is named
    ``"close"`` and ``is_local: true``. It does NOT call an LLM — it's a
    pure local-command phase whose behaviour is fully determined by the
    flow's ``evidence_policy`` and the current state of the evidence
    directory on disk.

    The result dict uses the same shape as :func:`run_phase`'s return —
    a status of ``"success"`` lets the flow continue, ``"reject"``
    routes the flow to the next transition (typically ``diagnostic`` per
    the builder-reviewer flow config). We use ``"reject"`` (not
    ``"rejected"``) to match the existing flow engine status vocabulary
    — see :func:`run_phase`'s ``on_reject`` / ``on_error`` transitions.
    """
    return _close_phase_result(flow_config, issue_num, evidence_dir=evidence_dir)


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
    scout_timeout = flow_config.get("scout_timeout_seconds", 240)

    print(f"[scout] Running scout phase on issue #{issue_num} (timeout={scout_timeout}s)", file=sys.stderr)
    sys.stderr.flush()

    result, session_log_path = run_phase("scout", flow_config, issue_num, context)

    status = result.get("status", "error")
    details = result.get("details", "") or ""
    # The raw LLM output (which contains the PHASE_OUTPUT block) lives in
    # ``result["output"]``. ``result["details"]`` is a summarized verdict,
    # not the raw scout text.
    raw_output = result.get("output", "") or ""

    if status != "success":
        # Non-fatal: log and proceed without findings
        short = details[:300].replace("\n", " ")
        print(f"[scout] {status}: {short}", file=sys.stderr)
        print("[scout] Builder will proceed without scout findings", file=sys.stderr)
        sys.stderr.flush()
        try:
            memory_store.update_phase("scout", {
                "status": status,
                "details": details[:1000],
                "session_log": str(session_log_path) if session_log_path else "",
            })
        except Exception as mem_err:
            print(f"[scout] Failed to persist failure to working memory: {mem_err}", file=sys.stderr)
            sys.stderr.flush()
        return None

    # Success — parse the PHASE_OUTPUT block from the raw LLM output
    findings = parse_scout_findings_from_details(raw_output)

    if "parse_error" in findings:
        # The scout succeeded but its output wasn't structured — still log it
        err = findings.get("parse_error", "unknown")
        print(f"[scout] Output was unparseable ({err[:200]})", file=sys.stderr)
        print("[scout] Builder will proceed with raw findings", file=sys.stderr)
        sys.stderr.flush()

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
        print(f"[scout] Failed to persist findings to working memory: {mem_err}", file=sys.stderr)
        sys.stderr.flush()

    return findings


def get_next_step(transitions: list, current_phase: str, status: str) -> Optional[str]:
    """Determine the next step based on transitions and phase status."""
    for t in transitions:
        if t.get("from") == current_phase:
            key = f"on_{status}"
            if key in t:
                return t[key]
    return None


def _print_prompt_debug(phase_name: str, issue_num: int, template_exists: bool, variables: dict, prompt: str, extra_context: str):
    """Print debug info about the built prompt to stderr."""
    print("\n" + "="*60, file=sys.stderr)
    print(f"[DEBUG] Phase: {phase_name} | Issue: #{issue_num}", file=sys.stderr)
    print(f"[DEBUG] Template loaded: {'YES' if template_exists else 'NO (fallback)'}", file=sys.stderr)

    # Show variable values (truncated for readability)
    for key, value in variables.items():
        display = value[:200] + "..." if len(value) > 200 else value
        print(f"[DEBUG]   {key} = '{display}'", file=sys.stderr)

    # Show extra context (diagnostic or previous_output)
    if extra_context:
        display = extra_context[:300] + "..." if len(extra_context) > 300 else extra_context
        print(f"[DEBUG]   Context preview: '{display}'", file=sys.stderr)

    # Prompt stats
    lines = prompt.split('\n')
    print(f"[DEBUG] Prompt: {len(prompt)} chars, {lines.__len__()} lines", file=sys.stderr)
    if len(lines) > 0:
        print(f"[DEBUG] First line: '{lines[0].strip()[:100]}'", file=sys.stderr)
    print("="*60 + "\n", file=sys.stderr)


def build_prompt(phase_name: str, phase_config: dict, flow_config: dict, issue_num: int, context: dict) -> Tuple[str, list[str]]:
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

    # Determine prompt source
    if not skill:
        print(f"[WARN] Phase '{phase_name}' has no 'skill' configured in flow config.", file=sys.stderr)
        sys.stderr.flush()

    prompt_dir = Path(__file__).parent / "prompts"
    explicit_tools = phase_config.get("tools")

    try:
        loaded = load_prompt(prompt_dir, phase_name, explicit_tools)
    except ValueError as exc:
        # Malformed frontmatter — surface the error but keep the flow alive
        # by falling back to a minimal default prompt + permissive tools.
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.stderr.flush()
        prompt = f"## Phase: {phase_name}\n## Issue: #{issue_num}\n\n[prompt loader error — see stderr]\n"
        return prompt, list(PERMISSIVE_FALLBACK)

    if loaded.deprecation_warning:
        print(f"[DEPRECATION] {loaded.deprecation_warning}", file=sys.stderr)
        sys.stderr.flush()

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
        print(f"[PHASE] Running local command: {cmd}", file=sys.stderr)
    elif skill:
        prompt += f"\n\n**SKILL TO USE:** `{skill}`"
        print(f"[PHASE] Invoking skill: {skill}", file=sys.stderr)
        sys.stderr.flush()

    # DEBUG: Show what was built
    extra = context.get("diagnostic_insights", "") or context.get("previous_output", "")
    if context.get("prd_body"):
        extra = f"PRD ({len(context['prd_body'])} chars) | {extra[:200]}"
    _print_prompt_debug(
        phase_name, issue_num, loaded.source_format != "default", variables, prompt, extra
    )

    return prompt, loaded.tools


def _build_session_dir(flow_name: str, issue_num: int, phase_name: str) -> Optional[str]:
    """Create a session log file path for this flow/phase execution.

    Phase 1+ layout (flat files):
        <session_base>/<issue>/<flow>-<phase>-<ISO8601>.jsonl

    Old layout (subdirectories) is no longer used - kept only for backward
    compatibility with existing session directories on disk.

    Reads session_dir from config.json. MAESTRO_SESSION_DIR env var overrides:
    set to a path to use it, or "0"/empty to disable.

    Config paths resolve relative to the project root (parent of maestro_dir).
    Env var paths are used as-is (absolute or relative to cwd).

    Returns:
        Path to the .jsonl file (not a directory), e.g.:
        ".pi/maestro/sessions/179/builder-reviewer-builder-2026-05-26T10:30:00.jsonl"
    """
    maestro_dir = Path(__file__).parent
    project_root = maestro_dir.parent.parent  # .pi/maestro → .pi → project root

    def _build_flat_path(base_session_dir: Path) -> str:
        """Build a flat-file session path: <issue>/<flow>-<phase>-<ISO8601>.jsonl"""
        safe_phase = phase_name.replace("/", "-")  # Handle skill paths like /skill:tdd
        iso_ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        issue_dir = base_session_dir / str(issue_num)
        os.makedirs(issue_dir, exist_ok=True)
        jsonl_file = issue_dir / f"{flow_name}-{safe_phase}-{iso_ts}.jsonl"
        return str(jsonl_file)

    # Env var takes absolute precedence when explicitly set
    if "MAESTRO_SESSION_DIR" in os.environ:
        env_override = os.environ["MAESTRO_SESSION_DIR"]
        if not env_override or env_override == "0":  # Disabled if empty or "0"
            return None
        base_session_dir = Path(env_override)
        os.makedirs(base_session_dir, exist_ok=True)
        return _build_flat_path(base_session_dir)

    # Read session_dir from config.json
    config_path = maestro_dir / "config.json"
    base_session_dir: Optional[Path] = None

    if config_path.exists():
        try:
            with open(config_path) as f:
                cfg = json.load(f)
                raw = cfg.get("session_dir", "") or ""
                if not raw.strip():  # Empty means disabled
                    return None

                # Resolve relative to project root (parent of maestro_dir)
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


def run_phase(phase_name: str, flow_config: dict, issue_num: int, context: dict) -> Tuple[dict, Optional[str]]:
    """Execute a single phase and return its result.

    Phases declared with ``is_optional: true`` (currently used by the
    ``retrospective`` phase) are wrapped in try/except — a raised
    exception is logged and converted to a synthetic success result so
    the flow can never be broken by a failing retrospective. This is
    intentional divergence from the rest of the engine (which lets
    errors propagate to ``diagnostic``) because retrospective is the
    LAST phase and a missed learning is recoverable on the next run.

    See ``docs/35-prds/maestro-retrospective.md`` §"Why is retrospective
    non-blocking?".
    """
    phase_config = flow_config["phases"][phase_name]
    is_optional = bool(phase_config.get("is_optional"))

    if is_optional:
        try:
            result, session_log = _run_phase_inner(phase_name, flow_config, issue_num, context)
        except Exception as e:  # noqa: BLE001
            # Non-fatal: log and convert to a synthetic success result.
            # We never raise out of an optional phase.
            err_msg = f"{type(e).__name__}: {e}"
            print(
                f"[{phase_name}] Failed (non-fatal): {err_msg}",
                file=sys.stderr,
            )
            sys.stderr.flush()
            return (
                {
                    "status": "success",
                    "details": f"{phase_name} failed (non-blocking, logged): {err_msg}",
                },
                None,
            )

        # Belt and braces: the inner runner now also downgrades
        # verdict-extraction errors for the retrospective phase to a
        # success, but other `is_optional` phases (added in the future)
        # could still return `{"status": "error", ...}` from the
        # extractor. Treat any error return from an optional phase as
        # non-fatal too — log it loudly, but never break the flow.
        if isinstance(result, dict) and result.get("status") == "error":
            err_details = result.get("details", "unknown error")
            print(
                f"[{phase_name}] Returned error (non-fatal, downgraded): {err_details}",
                file=sys.stderr,
            )
            sys.stderr.flush()
            return (
                {
                    "status": "success",
                    "details": (
                        f"{phase_name} error downgraded to non-blocking success: "
                        f"{err_details}"
                    ),
                },
                session_log,
            )

        return result, session_log

    return _run_phase_inner(phase_name, flow_config, issue_num, context)


def _run_phase_inner(phase_name: str, flow_config: dict, issue_num: int, context: dict) -> Tuple[dict, Optional[str]]:
    """Inner phase runner — the original ``run_phase`` body.

    Split out so :func:`run_phase` can wrap it in a non-blocking
    try/except for ``is_optional`` phases (retrospective). All callers
    should use :func:`run_phase`, not this private helper.
    """
    phase_config = flow_config["phases"][phase_name]

    # Local command phases run directly via subprocess (no LLM)
    if phase_config.get("is_local"):
        # The ``close`` phase is special: it's the evidence gate. We
        # dispatch to :func:`run_close_phase` instead of the generic
        # subprocess handler so the flow's ``evidence_policy`` is applied
        # (block / warn_but_proceed / ignore). The phase's ``command``
        # field is kept for documentation / non-evidence backstops but is
        # not invoked.
        if phase_name == "close":
            result = run_close_phase(flow_config, issue_num)
            # Cache the close-phase result in context for downstream
            # phases (e.g. retrospective) to read.
            context.setdefault("phase_outputs", {})["close"] = result
            return result, None

        cmd = phase_config.get("command", "").replace("{issue_number}", str(issue_num))
        print(f"[PHASE] Running local command: {cmd}", file=sys.stderr)
        sys.stderr.flush()

        import subprocess
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
            print(
                f"[retrospective] Failed to populate context: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )
            sys.stderr.flush()

    prompt, tools = build_prompt(phase_name, phase_config, flow_config, issue_num, context)

    print(f"[PHASE] Running '{phase_name}' on issue #{issue_num}", file=sys.stderr)
    sys.stderr.flush()

    timeout = phase_config.get("timeout_seconds", 1800)
    model = phase_config.get("model")
    provider = phase_config.get("provider")

    # Build session directory for this run (opt-in via MAESTRO_LOG_SESSIONS)
    flow_name = flow_config.get("name", "unknown")
    session_dir = _build_session_dir(flow_name, issue_num, phase_name)
    if session_dir:
        print(f"[rpc] Session dir: {session_dir}", file=sys.stderr)
        sys.stderr.flush()

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
        # (e.g. the block was truncated in rpc_output, or the agent forgot
        # the markers) we must NOT let the flow break — retrospective is
        # declared `is_optional: true` and the transition routes every
        # outcome to `finish`.
        #
        # Instead, we attempt the persistence step from the raw rpc_output
        # (which contains the agent's full text including the PHASE_OUTPUT
        # block when it exists) and return a synthetic success. The
        # persistence helper itself is best-effort — it falls back to a
        # minimal entry when the block can't be parsed, so the file
        # `.maestro/learnings.md` still gets written with at least the
        # issue number and outcome.
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
                print(
                    f"[retrospective] Persistence on verdict-error path failed: "
                    f"{type(persist_err).__name__}: {persist_err}",
                    file=sys.stderr,
                )
                sys.stderr.flush()
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
    # If this is the retrospective phase, parse the LLM's PHASE_OUTPUT
    # and append a structured entry to the repo's learnings.md. The
    # ``_persist_retrospective_result`` helper is best-effort — any
    # error is logged but does not affect the return value below.
    if phase_name == "retrospective":
        try:
            repo_path_for_retro = Path(context.get("repo_path", Path.cwd()))
            # The flow-level outcome: prefer the close phase's status,
            # fall back to the retrospective's own status.
            flow_status_value = str(context.get("final_status") or final_status)
            _persist_retrospective_result(
                issue_num=issue_num,
                flow_name=str(context.get("flow_name", flow_config.get("name", "unknown"))),
                rpc_output=rpc_result.get("output", "") or "",
                flow_status=flow_status_value,
                repo_path=repo_path_for_retro,
                session_log_path=session_log_path,
            )
        except Exception as e:  # noqa: BLE001
            print(
                f"[retrospective] Persistence step failed: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )
            sys.stderr.flush()

    return {
        "status": final_status,
        "details": details,
        "output": rpc_result["output"]
    }, session_log_path


# ─── Retrospective result handling ───────────────────────────────────────


def _populate_retrospective_context(
    context: dict,
    flow_config: dict,
    issue_num: int,
) -> None:
    """Fill in retrospective-specific context variables.

    Populates ``flow_name``, ``final_status``, ``repo_path``,
    ``evidence_summary``, and ``learnings_excerpt`` on the context dict
    so the retrospective prompt has everything it needs. Idempotent —
    safe to call from multiple places.

    Sources:
        - ``flow_name`` → ``flow_config["name"]``
        - ``final_status`` → status of the last non-retrospective phase
          (or "unknown" if not yet recorded)
        - ``repo_path`` → ``context["working_memory"].repo_path`` if set,
          else ``Path.cwd()``
        - ``evidence_summary`` → scanned from the evidence dir, listing
          verified markers by type
        - ``learnings_excerpt`` → last 2000 chars of the repo's
          ``.maestro/learnings.md`` (if present)
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

    # evidence_summary — scan the evidence dir for the issue
    context.setdefault("evidence_summary", _format_evidence_summary(issue_num))

    # learnings_excerpt — tail of the repo's learnings.md
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
    """Return the tail of the repo's learnings.md (or a default).

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
    """Read a session .jsonl and concatenate the agent's text parts.

    The session log records every JSON event the LLM runtime emitted.
    For the persistence step we only care about the assistant's text
    parts (the prose the LLM wrote back to the user). This helper
    mirrors the same extraction that ``verdict_extractor`` uses —
    walking the JSONL line by line, picking out the
    ``message.content[].text`` parts from assistant-role events, and
    joining them with newlines so the ``PHASE_OUTPUT`` block survives
    if the agent emitted one.

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
) -> None:
    """Parse the retrospective PHASE_OUTPUT and persist to .maestro/learnings.md.

    Called after the LLM-driven retrospective phase completes. The
    function is best-effort: any I/O error is logged and swallowed
    (retrospective is non-blocking — see :func:`run_phase`).

    Steps:
        1. Resolve the source text. ``rpc_output`` is the truncated
           JSON-event stream from the RPC client (first 2000 chars) —
           the ``### PHASE_OUTPUT: ...`` block lives in the agent's
           prose, not in the event stream, so a bare ``rpc_output``
           usually can't find it. When ``session_log_path`` is given,
           we read the full session log and concatenate the agent's
           text parts; that always contains the block when the agent
           emitted one.
        2. Parse the concatenated text for the ``PHASE_OUTPUT`` block
           via :func:`learnings.parse_retrospective_output`.
        3. Format and append a markdown entry to
           ``<repo>/.maestro/learnings.md``.
        4. If the entry contains a similar pattern ≥3 times across the
           file, append an amendment proposal to
           ``<repo>/.maestro/proposed-amendments.md``.

    The function never raises. Retrospective failures are logged at
    WARN level but the flow continues to ``finish``.
    """
    # Resolve the source text. ``rpc_output`` alone is rarely enough
    # (it's the truncated event stream, not the agent's prose). When
    # we have a session log path, read it and concatenate the agent
    # text parts. Otherwise fall back to ``rpc_output``.
    source_text = rpc_output or ""
    if session_log_path:
        try:
            session_text = _read_agent_text_from_session_log(Path(session_log_path))
            if session_text:
                # Prefer the session-log-derived text; the event
                # stream from rpc_output is noisy and not the agent's
                # prose. If the session log is empty, keep rpc_output.
                source_text = session_text
        except Exception as e:  # noqa: BLE001
            print(
                f"[retrospective] Could not read session log "
                f"({session_log_path}): {type(e).__name__}: {e}; "
                f"falling back to rpc_output",
                file=sys.stderr,
            )
            sys.stderr.flush()
    parsed = parse_retrospective_output(source_text)
    if "parse_error" in parsed:
        # No PHASE_OUTPUT — emit a minimal entry so the file still gets
        # the metadata (issue + outcome). The retrospective LLM is
        # supposed to always emit a block; if it didn't, that's
        # worth recording.
        print(
            f"[retrospective] No PHASE_OUTPUT block found: {parsed['parse_error']}",
            file=sys.stderr,
        )
        sys.stderr.flush()
        # Use an empty-but-valid payload so the entry still gets written
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
        print(
            f"[retrospective] Wrote learning entry for issue #{issue_num} "
            f"to {repo_path / LEARNINGS_FILENAME}",
            file=sys.stderr,
        )
        sys.stderr.flush()
    except Exception as e:  # noqa: BLE001
        print(
            f"[retrospective] Failed to write learnings file: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        sys.stderr.flush()
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
                # Synthesise a default amendment so the proposal is actionable
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
                    print(
                        f"[retrospective] Proposed amendment: "
                        f"{amend.get('title', '?')!r} "
                        f"({repo_path / '.maestro' / 'proposed-amendments.md'})",
                        file=sys.stderr,
                    )
                    sys.stderr.flush()
                except Exception as e:  # noqa: BLE001
                    print(
                        f"[retrospective] Failed to write amendment: "
                        f"{type(e).__name__}: {e}",
                        file=sys.stderr,
                    )
                    sys.stderr.flush()



def run_diagnostic(term: Terminal, flow_config: dict, issue_num: int, failure_context: dict) -> dict:
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
    if session_dir:
        print(f"[rpc] Diagnostic session dir: {session_dir}", file=sys.stderr)
        sys.stderr.flush()

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

    while iteration_count < max_iterations:
        iteration_count += 1
        next_step = None  # reset each iteration; escalation may set it before transition lookup

        result, session_log_path = run_phase(current_phase, flow_config, issue_num, context)
        sys.stderr.flush()

        term._print_verbose(f"[PHASE] {current_phase} -> {result['status']}")

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
            # state without needing to hit disk again.
            context["working_memory"] = memory.to_dict()
        except Exception as mem_err:
            # Memory persistence is best-effort — never crash the flow.
            term._print_verbose(f"[memory] Failed to update working memory: {mem_err}")

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
            break

        if next_step == "finish":
            completed_successfully = True
            break
        elif next_step == "diagnostic" or result["status"] == "error":
            term._print_verbose(f"[DIAGNOSTIC] Running diagnostic for {current_phase}")
            diag_result = run_diagnostic(term, flow_config, issue_num, {
                "failed_phase": current_phase,
                "output_summary": result.get("details", "")[:500]
            })

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

from dataclasses import dataclass, field  # noqa: E402  (kept grouped with types)


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
    after-the-fact debugging.
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
