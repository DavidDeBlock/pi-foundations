#!/usr/bin/env python3
"""
flow_dispatcher.py — Build the static setup for a single flow run.

Owns the 7 setup steps that used to live at the top of
``flow_engine.run_flow_on_issue``:

  1. Fetch issue metadata (title, body, comments count, created at)
  2. Fetch parent PRD body if ``## Parent\\n\\n#NNN`` is referenced
  3. Load working memory view via ``MemoryStore(issue_num).load()``
  4. Prefetch context via ``prefetch_context(Path.cwd())`` (keyed on git SHA)
  5. Persist ``git_sha`` and ``repo_path`` into the working memory store
  6. Load repo context from the projects registry (if the repo is onboarded)
  7. Run scout synchronously if ``flow.scout_enabled`` is true, persist
     findings to memory, refresh the in-memory view

The single public function is :func:`build_flow_context`, which returns
a :class:`~flow_engine.FlowContext` value object. Each setup step is
wrapped in a ``try/except`` and logs to ``sys.stderr`` on failure.
**Failures are non-fatal**: the corresponding field is left as ``None``
(or a fresh empty value) in the returned :class:`FlowContext` and the
flow can still proceed. This matches the "best-effort" behaviour of the
original code that lived inline in ``run_flow_on_issue``.

The dispatcher is the seam between "the flow engine" and "everything a
flow needs to know about an issue". The future runner narrowing (a
later slice) consumes the :class:`FlowContext` directly; the current
:func:`~flow_engine.run_flow_on_issue` shim unpacks the
:class:`FlowContext` back into a ``dict`` for the still-unrefactored
phase loop. That conversion happens in the shim, not here — this
module's contract is "load the data, return the typed value".

Public API:
    - ``build_flow_context(flow, issue_num, gh) -> FlowContext``
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

# Add lib to path so the ``from x import y`` imports below resolve to
# ``flow_engine/lib/*`` (the convention used elsewhere in the repo).
sys.path.insert(0, str(Path(__file__).parent / "lib"))

import flow_engine as _flow_engine  # noqa: E402  (intentional intra-package import)
from flow_engine import (  # noqa: E402  (intentional intra-package import)
    Flow,
    FlowContext,
    WorkingMemory,
    PrefetchedContext,
    _extract_parent_issue,
    _format_repo_context,
    _scout_enabled,
)
from scout_runner import (  # noqa: E402  (intentional intra-package import)
    _run_scout_phase,
)
from github_client import GithubClient  # noqa: E402

# NOTE on patch-friendliness: existing tests patch attributes on the
# ``flow_engine`` module (``flow_engine.MemoryStore``,
# ``flow_engine.prefetch_context``, ``flow_engine.load_flow``, etc.)
# to redirect them to temp dirs / canned responses. The dispatcher
# therefore looks these up via ``_flow_engine.ATTR`` rather than
# binding them via ``from flow_engine import ATTR`` — the latter
# would create a private binding in this module that is unaffected by
# patches on the ``flow_engine`` module.


# Tag for stderr lines emitted from this module. Used so operators can
# grep the log for dispatcher-specific messages vs the rest of the
# runner's output.
_LOG_TAG = "[flow_dispatcher]"


def _log_warn(message: str) -> None:
    """Best-effort stderr log — never raises (matches the existing
    pattern used by ``MemoryStore`` and ``ProjectsRegistry``)."""
    try:
        print(f"{_LOG_TAG} {message}", file=sys.stderr)
        sys.stderr.flush()
    except Exception:
        pass


# ─── build_flow_context ─────────────────────────────────────────────────


def build_flow_context(
    flow: Flow,
    issue_num: int,
    gh: GithubClient,
) -> FlowContext:
    """Build the :class:`FlowContext` for a single flow run on one issue.

    Performs the 7 setup steps (issue metadata, parent PRD, working
    memory, prefetch, persist, repo context, scout) and returns a fully
    populated :class:`FlowContext`. Any single step that fails leaves
    the corresponding field as ``None`` (or, for ``working_memory``, a
    fresh empty :class:`WorkingMemory`) and logs a line to stderr; the
    flow can still proceed.

    Args:
        flow: The flow's :class:`Flow` value object. ``flow.scout_enabled``
            drives step 7; ``flow.name`` is used to look up the flow
            config (the scout helpers need the raw dict form).
        issue_num: The GitHub issue number to run on.
        gh: The :class:`GithubClient` used for step 1 and step 2.

    Returns:
        A :class:`FlowContext` with every field populated to the
        extent each setup step succeeded.
    """
    # The scout helpers (``_scout_enabled``, ``_run_scout_phase``) take
    # the raw flow config dict. We load it again here — the cost is
    # negligible (one JSON parse + validation) and keeps the
    # dispatcher self-contained: callers don't need to pass both the
    # typed ``Flow`` and the dict.
    flow_config = _flow_engine.load_flow(flow.name)

    # ── Step 1: Fetch issue metadata ──
    issue_title = "No title"
    issue_body = ""
    comments_count = 0
    created_at: Optional[str] = None
    try:
        issue_info = gh.fetch_issue(issue_num)
        if issue_info:
            issue_title = issue_info.title or "No title"
            issue_body = issue_info.body or ""
            comments_count = len(issue_info.comments) if issue_info.comments else 0
            created_at = issue_info.created_at[:10] if issue_info.created_at else None
        else:
            _log_warn(f"Could not fetch issue #{issue_num} metadata")
    except Exception as e:
        _log_warn(f"Failed to fetch issue metadata for #{issue_num}: {e}")

    # ── Step 2: Fetch parent PRD if referenced ──
    parent_prd: Optional[str] = None
    parent_num = _extract_parent_issue(issue_body)
    if parent_num:
        try:
            prd_info = gh.fetch_issue(parent_num)
            if prd_info and prd_info.body:
                parent_prd = f"## Parent PRD (#{parent_num})\n\n{prd_info.body}"
            else:
                _log_warn(f"Could not fetch parent PRD body for #{parent_num}")
        except Exception as e:
            _log_warn(f"Failed to load parent PRD #{parent_num}: {e}")

    # ── Step 3: Load working memory ──
    # ``MemoryStore.load()`` already handles a missing or corrupt file
    # (returns a fresh empty ``WorkingMemory``, optionally backing the
    # corrupt file up first). The try/except here is for catastrophic
    # failures (e.g. ``MemoryStore.__init__`` itself raising) so the
    # flow still has a usable in-memory view.
    memory_store = None
    memory: WorkingMemory
    try:
        memory_store = _flow_engine.MemoryStore(issue_num)
        memory = memory_store.load()
    except Exception as e:
        _log_warn(f"Failed to load working memory for #{issue_num}: {e}")
        memory = WorkingMemory(issue=issue_num, created_at=_flow_engine.now_iso())
        # ``memory_store`` may be ``None`` — every later step that
        # needs it checks for ``None`` first.

    # ── Step 4: Prefetch context ──
    prefetched: PrefetchedContext
    try:
        prefetched = _flow_engine.prefetch_context(Path.cwd())
    except Exception as e:
        _log_warn(f"Failed to prefetch context: {e}")
        prefetched = PrefetchedContext(git_sha="unknown")

    # ── Step 5: Persist git_sha and repo_path into working memory ──
    memory.git_sha = prefetched.git_sha
    memory.repo_path = str(Path.cwd().resolve())
    if memory_store is not None:
        try:
            memory_store.save(memory)
        except Exception as e:
            _log_warn(f"Failed to persist git_sha/repo_path: {e}")

    # ── Step 6: Load repo context (if the repo is onboarded) ──
    repo_context: Optional[dict] = None
    try:
        projects_registry = _flow_engine.ProjectsRegistry(
            Path(_flow_engine.PROJECTS_REGISTRY_FILENAME)
        )
        repo_entry = projects_registry.get_by_path(str(Path.cwd().resolve()))
        if repo_entry:
            repo_context = _format_repo_context(repo_entry)
    except Exception as e:
        # Match the original code's verbose log format so operators
        # can grep for either prefix.
        _log_warn(
            f"Failed to load repo context: {type(e).__name__}: {e}"
        )

    # ── Step 7: Run scout synchronously (opt-in per flow) ──
    # The scout helper is itself non-fatal: it always returns
    # ``None`` on failure. We refresh the in-memory ``memory``
    # reference afterwards so the ``FlowContext.working_memory``
    # snapshot reflects the scout section.
    scout_findings: Optional[dict] = None
    if memory_store is not None and _scout_enabled(flow_config):
        # The scout helper expects a context dict; build the minimal
        # one it needs (the phase loop will rebuild the full dict
        # from the returned ``FlowContext``).
        scout_context = {
            "prompt": f"## Issue #{issue_num}\n\n{issue_body}",
            "working_memory": memory.to_dict(),
        }
        if parent_prd:
            scout_context["prd_body"] = parent_prd
        scout_findings = _run_scout_phase(
            flow_config, issue_num, scout_context, memory_store
        )
        # Refresh the in-memory view so the returned FlowContext
        # reflects the scout section.
        try:
            memory = memory_store.load()
        except Exception:
            pass

    return FlowContext(
        flow=flow,
        issue_num=issue_num,
        issue_title=issue_title,
        issue_body=issue_body,
        comments_count=comments_count,
        created_at=created_at,
        parent_prd=parent_prd,
        working_memory=memory,
        prefetched=prefetched,
        repo_context=repo_context,
        scout_findings=scout_findings,
    )


# Note: ``format_prefetched_context`` and ``format_scout_findings_markdown``
# are imported lazily by the shim (``run_flow_on_issue``) when it
# rebuilds the dict-based runner context. They're not used inside this
# module because the typed ``FlowContext`` carries the raw objects
# (``PrefetchedContext`` and the parsed ``scout_findings`` dict) — the
# formatted strings are a presentation concern that belongs to the
# runner / prompt builder, not the setup layer.
__all__ = ["build_flow_context"]
