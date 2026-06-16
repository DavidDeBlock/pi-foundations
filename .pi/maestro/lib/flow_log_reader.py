#!/usr/bin/env python3
"""
flow_log_reader.py — Pure JSONL parsing and active-flow detection.

Reads ``.maestro/logs/<flow>/<issue>.jsonl`` files produced by the
:class:`FileLogger` adapter (from :mod:`flow_logger`) and determines
which flows are currently *active* — i.e. their latest event is a
``phase_start`` with no matching terminal event.

This module has **zero side effects**: it only reads files and returns
data structures. It never writes, never imports ``rich``, and never
touches the terminal. This keeps it trivially testable from plain
``pytest`` invocations.

Public API:

  - :class:`FlowSnapshot` — frozen dataclass describing one active flow.
  - :func:`parse_jsonl_file` — parse a single JSONL file, skipping corrupt lines.
  - :func:`is_active_flow` — determine if an event list represents an active flow.
  - :func:`get_current_phase_info` — extract current phase details from events.
  - :func:`scan_logs_dir` — scan the log directory and return all active flows.

Design notes:

  - **Corrupt lines are silently skipped.** A partially-written last
    line (incomplete JSON) must not crash the monitor.
  - **Missing fields use ``?`` placeholders.** Older logs or logs from
    before PRD #25 may lack ``phase``, ``tokens``, etc. The reader
    fills gaps with ``None`` / empty strings so rendering never crashes.
  - **No GitHub API calls.** Issue titles are not fetched here — the
    monitor is a read-only local view. If issue title data is needed,
    it would come from a separate enrichment pass (future slice).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ─── Terminal event kinds ──────────────────────────────────────────────
#
# Events that signal a flow has reached a terminal state (no longer
# active). ``phase_end`` is included because it means the current
# phase completed — if there's no subsequent ``phase_start``, the
# flow has finished.

_TERMINAL_KINDS: frozenset[str] = frozenset({
    "phase_end",
    "phase_rejected",
    "phase_approved",
})


@dataclass(frozen=True)
class FlowSnapshot:
    """A snapshot of one active flow, derived from its JSONL event log.

    All fields are ``None``-safe — rendering code should use ``?`` or
    similar placeholders when a field is missing rather than crashing.

    Fields:

      - ``flow_name``: Name of the flow (e.g. ``"builder-reviewer"``).
        Derived from the directory name under ``logs_dir``.
      - ``issue_num``: Issue number. Derived from the JSONL filename.
      - ``log_path``: Full path to the JSONL file. Used for display / debugging.
      - ``current_phase``: Name of the phase currently running (e.g. ``"reviewer"``).
        ``None`` if not determinable.
      - ``phase_index``: 1-based index of current phase within the flow's phase list.
        e.g. ``3`` for "third phase". ``None`` if unknown.
      - ``total_phases``: Total number of phases in this flow. ``None`` if unknown.
      - ``agent_role``: The agent role currently working (typically same as current_phase).
        ``None`` if not determinable.
      - ``action_description``: What the agent is reading/acting on, from the event message.
        Truncated to a reasonable length for display. ``""`` if not available.
      - ``elapsed_s``: Seconds elapsed since the last ``phase_start`` event.
        ``None`` if timestamp unavailable or parseable.
      - ``tokens_in``: Input tokens consumed in current phase attempt. ``0`` if unknown.
      - ``tokens_out``: Output tokens produced in current phase attempt. ``0`` if unknown.
      - ``cache_read``: Cache-read tokens for current phase attempt. ``None`` if not tracked.
      - ``start_time``: ISO timestamp of the last ``phase_start`` event. Used for sorting.
    """

    flow_name: str
    issue_num: int | None
    log_path: Path
    current_phase: str | None
    phase_index: int | None
    total_phases: int | None
    agent_role: str | None
    action_description: str
    elapsed_s: float | None
    tokens_in: int | None
    tokens_out: int | None
    cache_read: int | None
    start_time: str


def parse_jsonl_file(path: Path) -> list[dict[str, Any]]:
    """Parse a JSONL file into a list of event dicts.

    Each line is parsed independently with :func:`json.loads`. Lines
    that fail to parse (corrupt, truncated, empty) are silently skipped.
    This handles the common case where the last line is being written
    when the monitor reads it.

    Args:
        path: Path to a JSONL file. Must exist and be readable.

    Returns:
        List of parsed event dicts in file order. Empty list if the
        file is empty or all lines are corrupt.

    Raises:
        FileNotFoundError: If ``path`` does not exist (caller's
            responsibility — this function assumes the path was
            validated before calling).
    """
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                event = json.loads(stripped)
                events.append(event)
            except (json.JSONDecodeError, ValueError):
                # Corrupt or partially-written line — skip silently.
                continue
    return events


def is_active_flow(events: list[dict[str, Any]]) -> bool:
    """Determine if an event log represents a currently active flow.

    A flow is "active" if its latest event is ``phase_start`` with no
    subsequent terminal event (``phase_end``, ``phase_rejected``, or
    ``phase_approved``). An empty event list is not active.

    Args:
        events: Parsed events in chronological order.

    Returns:
        ``True`` if the flow appears to still be running.
    """
    if not events:
        return False

    # Walk backwards from the end; find the first non-terminal event.
    for event in reversed(events):
        kind = event.get("kind", "")
        if kind == "phase_start":
            return True
        if kind in _TERMINAL_KINDS:
            return False
        # Other kinds (diagnostic, scout_complete, etc.) don't change
        # active status — keep looking backwards.

    # If we reach here without finding a phase_start or terminal event,
    # the flow has events but no clear state — treat as inactive.
    return False


def _find_last_phase_start(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Find the last ``phase_start`` event in an event list.

    Walks backwards from the end to find the most recent ``phase_start``
    that hasn't been followed by a terminal event. Returns ``None`` if
    no such event exists.

    Args:
        events: Parsed events in chronological order.

    Returns:
        The last unmatched ``phase_start`` event dict, or ``None``.
    """
    for event in reversed(events):
        kind = event.get("kind", "")
        if kind == "phase_start":
            return event
        if kind in _TERMINAL_KINDS:
            # Terminal event blocks any earlier phase_start from being active.
            break
    return None


def _count_phases_before(events: list[dict[str, Any]], target_phase: str) -> int:
    """Count how many distinct phases have started before ``target_phase``.

    Walks through events and counts unique ``phase`` values seen in
    ``phase_start`` events up to (and including) the first occurrence
    of ``target_phase``. This gives us the 1-based index for display.

    Args:
        events: Parsed events in chronological order.
        target_phase: The phase name to find the index for.

    Returns:
        1-based index (e.g. ``3`` means "third phase").
    """
    seen_phases: set[str] = set()
    found_target = False
    for event in events:
        kind = event.get("kind", "")
        phase = event.get("phase")
        if not phase or kind != "phase_start":
            continue
        if phase == target_phase and not found_target:
            seen_phases.add(phase)
            found_target = True
            break
        seen_phases.add(phase)
    return len(seen_phases)


def get_current_phase_info(
    events: list[dict[str, Any]],
    flow_name: str,
) -> FlowSnapshot | None:
    """Extract current phase information from an active flow's event log.

    Finds the last unmatched ``phase_start`` event and derives all
    displayable fields from it. If no active phase is found, returns
    ``None`` (caller should not render a panel for this flow).

    Args:
        events: Parsed events in chronological order.
        flow_name: Name of the flow (from directory name). Used as
            agent_role fallback and for display.

    Returns:
        A :class:`FlowSnapshot` with all fields populated from event
        data, or ``None`` if no active phase is found.
    """
    last_start = _find_last_phase_start(events)
    if last_start is None:
        return None

    phase_name = last_start.get("phase", "?") or "?"
    timestamp_str = last_start.get("timestamp", "")
    message = last_start.get("message", "") or ""
    tokens_data = last_start.get("tokens") or {}

    # Elapsed time since phase_start.
    elapsed_s: float | None = None
    if timestamp_str:
        try:
            start_dt = datetime.fromisoformat(timestamp_str)
            now = datetime.now(timezone.utc)
            # Ensure both are timezone-aware for subtraction.
            if start_dt.tzinfo is None:
                start_dt = start_dt.replace(tzinfo=timezone.utc)
            elapsed_s = max(0, (now - start_dt).total_seconds())
        except (ValueError, TypeError):
            elapsed_s = None

    # Token usage from the event.
    tokens_in: int | None = tokens_data.get("input") if isinstance(tokens_data, dict) else None
    tokens_out: int | None = tokens_data.get("output") if isinstance(tokens_data, dict) else None
    cache_read: int | None = tokens_data.get("cacheRead") if isinstance(tokens_data, dict) else None

    # Phase index — count distinct phases started before this one.
    phase_index = _count_phases_before(events, phase_name) if phase_name != "?" else None

    # Action description — truncate the message for display.
    action_description = message[:120] if message else ""

    return FlowSnapshot(
        flow_name=flow_name,
        issue_num=None,  # Will be set by caller from filename.
        log_path=Path(""),  # Will be set by caller.
        current_phase=phase_name,
        phase_index=phase_index,
        total_phases=None,  # Not derivable from events alone; would need flow config.
        agent_role=phase_name if phase_name != "?" else None,
        action_description=action_description,
        elapsed_s=elapsed_s,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cache_read=cache_read,
        start_time=timestamp_str or "",
    )


def _parse_issue_num_from_path(path: Path) -> int | None:
    """Extract issue number from a JSONL filename like ``<issue>.jsonl``.

    Args:
        path: Path to the JSONL file.

    Returns:
        The parsed integer, or ``None`` if unparseable.
    """
    stem = path.stem  # e.g. "42" from "42.jsonl"
    try:
        return int(stem)
    except (ValueError, TypeError):
        return None


def scan_logs_dir(logs_dir: Path) -> list[FlowSnapshot]:
    """Scan a log directory and return snapshots of all active flows.

    Walks ``logs_dir/<flow>/<issue>.jsonl`` files, parses each one,
    checks if it's active, and collects the results sorted by start
    time (oldest first = most recently started at top).

    The directory structure is:

      .maestro/logs/
        builder-reviewer/
          42.jsonl       ← flow=builder-reviewer, issue=42
          43.jsonl       ← flow=builder-reviewer, issue=43
        full-lifecycle/
          10.jsonl       ← flow=full-lifecycle, issue=10

    Args:
        logs_dir: The root log directory (e.g. ``.maestro/logs``).

    Returns:
        List of :class:`FlowSnapshot` for active flows, sorted by
        ``start_time`` ascending (most recent first in display order;
        the list is returned oldest-first so callers can reverse if
        they want newest-on-top). Empty list if directory doesn't
        exist or has no active flows.

    Raises:
        Never — missing directories and corrupt files are handled
        gracefully, returning an empty list instead.
    """
    if not logs_dir.exists() or not logs_dir.is_dir():
        return []

    snapshots: list[FlowSnapshot] = []

    # Walk <flow>/<issue>.jsonl structure.
    for flow_dir in sorted(logs_dir.iterdir()):
        if not flow_dir.is_dir():
            continue

        flow_name = flow_dir.name

        for jsonl_file in sorted(flow_dir.iterdir()):
            if not jsonl_file.suffix == ".jsonl":
                continue

            try:
                events = parse_jsonl_file(jsonl_file)
            except (OSError, PermissionError):
                # Can't read the file — skip silently.
                continue

            if not is_active_flow(events):
                continue

            snapshot = get_current_phase_info(events, flow_name)
            if snapshot is None:
                continue

            issue_num = _parse_issue_num_from_path(jsonl_file)

            # Patch in caller-set fields.
            snapshots.append(FlowSnapshot(
                flow_name=flow_name,
                issue_num=issue_num,
                log_path=jsonl_file,
                current_phase=snapshot.current_phase,
                phase_index=snapshot.phase_index,
                total_phases=snapshot.total_phases,
                agent_role=snapshot.agent_role,
                action_description=snapshot.action_description,
                elapsed_s=snapshot.elapsed_s,
                tokens_in=snapshot.tokens_in,
                tokens_out=snapshot.tokens_out,
                cache_read=snapshot.cache_read,
                start_time=snapshot.start_time,
            ))

    # Sort by start_time ascending (oldest first). Callers typically
    # display newest-on-top so they'll reverse. We sort here to give
    # a stable, deterministic order regardless of filesystem ordering.
    snapshots.sort(key=lambda s: s.start_time or "")
    return snapshots


def format_elapsed(seconds: float | None) -> str:
    """Format elapsed seconds into a human-readable string.

    Args:
        seconds: Elapsed time in seconds, or ``None``.

    Returns:
        Formatted string like ``"2m 34s"``, ``"1h 5m"``, or ``"?"``.
    """
    if seconds is None:
        return "?"

    total = int(seconds)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)

    parts: list[str] = []
    if hours > 0:
        parts.append(f"{hours}h")
    if minutes > 0 or (hours == 0 and not parts):
        parts.append(f"{minutes}m")
    parts.append(f"{secs}s")

    return " ".join(parts)


def format_tokens(value: int | None, label: str = "") -> str:
    """Format a token count for display.

    Args:
        value: Token count or ``None``.
        label: Optional prefix label (e.g. ``"in:"``).

    Returns:
        Formatted string like ``"12,345"``, ``"in: 0"`` or ``"?""``.
    """
    if value is None:
        return "?"
    formatted = f"{value:,}"
    return f"{label}{formatted}" if label else formatted
