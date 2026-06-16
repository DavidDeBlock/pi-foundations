#!/usr/bin/env python3
"""
monitor_view.py — Pure rendering layer for the Maestro monitor.

The monitor (``maestro monitor``) is a read-only full-screen view of the
flow log directory. This module contains **only** the rendering logic
and the snapshot reader — no terminal I/O, no Live loop, no keyboard
handling. Keeping it pure makes it trivially testable: every function
in here can be invoked from a test without spinning up a Live context
manager or a real terminal.

Public surface:

  - :data:`EMPTY_STATE_MESSAGE` — the centred message shown when no
    flow logs are present.
  - :data:`FOOTER_HINT` — the constant footer text (refresh + quit).
  - :class:`MonitorState` — frozen dataclass describing one snapshot.
  - :func:`build_layout` — build a :class:`rich.layout.Layout` for a
    given state. Pure: same input → same output.
  - :func:`poll_snapshot` — read the log directory and produce a
    :class:`MonitorState`. In this slice the snapshot is always empty
    (``active_count == 0``) because the slice explicitly does not
    parse logs. The function is here as the seam where future
    slices will plug in real log reading.

Design notes:

  - **No I/O in the render functions.** ``build_layout`` and friends
    take a :class:`MonitorState` and return a ``Layout``. They never
    touch the filesystem. This is what makes them testable from a
    plain ``pytest`` invocation.
  - **No side effects in poll_snapshot.** The function reads
    ``logs_dir.exists()`` and ``logs_dir.is_dir()`` but never
    writes, and never raises on a missing directory (per the AC:
    "Missing ``.maestro/logs/`` directory is handled gracefully").
  - **Rich only.** All visual output goes through ``rich``. There is
    no Textual dependency.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from rich.align import Align
from rich.columns import Columns
from rich.console import Group
from rich.layout import Layout
from rich.panel import Panel
from rich.text import Text


# ─── Constants ───────────────────────────────────────────────────────────
#
# Exposed as module-level constants so tests and (later) other tools
# can reference the canonical strings without copying them. The
# footer is intentionally literal — the AC pins the exact text
# "↻ refreshing · q to quit".

EMPTY_STATE_MESSAGE: str = "No active flows. Run `maestro` to start one."
FOOTER_HINT: str = "↻ refreshing · q to quit"
HEADER_TITLE: str = "Maestro Monitor"


# ─── Snapshot dataclass ─────────────────────────────────────────────────


@dataclass(frozen=True)
class MonitorState:
    """A single read pass over the log directory.

    Fields:

      - ``logs_dir``: The directory we polled. Stored so the render
        layer can show it in tooltips / debug info without re-doing
        the path resolution.
      - ``active_count``: Number of flows currently active. Computed
        from JSONL event logs via :func:`flow_log_reader.scan_logs_dir`.
      - ``has_logs_dir``: Whether ``logs_dir`` exists and is a
        directory. ``False`` is a valid state (the monitor still
        renders the empty-state panel) — see the AC for the
        "missing directory is handled gracefully" requirement.
      - ``interval_s``: The configured poll interval. Surfaced in
        the footer in a future slice; kept on the state object so
        tests can verify the wiring.
      - ``active_flows``: Tuple of :class:`FlowSnapshot` objects for
        each active flow, sorted by start time (oldest first). Frozen
        tuple keeps :class:`MonitorState` hashable.
    """

    logs_dir: Path
    active_count: int
    has_logs_dir: bool
    interval_s: float
    active_flows: tuple = ()  # type: ignore[type-arg]


# ─── Snapshot reader ─────────────────────────────────────────────────────


def poll_snapshot(logs_dir: Path, interval_s: float = 1.0) -> MonitorState:
    """Take a single read pass over ``logs_dir`` and return a snapshot.

    Scans the log directory for active flows by reading JSONL event
    logs produced by :class:`FileLogger`. An active flow is one whose
    latest event is ``phase_start`` with no matching terminal event.

    The function:

      1. Resolves the path (so a relative ``.maestro/logs`` becomes
         an absolute path for display).
      2. Checks whether the directory exists (without raising).
      3. Scans JSONL files and identifies active flows.
      4. Returns a :class:`MonitorState` with populated fields.

    Corrupt or partially-written log lines are skipped silently —
    the function never raises on malformed data.

    Args:
        logs_dir: Directory to scan. May be relative or absolute;
            non-existent paths are fine (no exception is raised).
        interval_s: Poll interval in seconds. Stored on the
            returned state; not used by the function body.

    Returns:
        A :class:`MonitorState` with ``active_count`` reflecting
        the number of active flows and ``has_logs_dir`` indicating
        whether ``logs_dir`` exists and is a directory.
    """
    resolved = Path(logs_dir).resolve()
    has_logs_dir = resolved.exists() and resolved.is_dir()

    # Import here to avoid circular dependency at module load time.
    from flow_log_reader import scan_logs_dir  # noqa: PLC0414

    raw_flows: list = []  # type: ignore[var-annotated]
    if has_logs_dir:
        try:
            raw_flows = scan_logs_dir(resolved)
        except Exception:  # noqa: BLE001
            # If scanning fails for any reason (permissions, etc.),
            # fall back to empty state rather than crashing.
            pass

    return MonitorState(
        logs_dir=resolved,
        active_count=len(raw_flows),
        has_logs_dir=has_logs_dir,
        interval_s=interval_s,
        active_flows=tuple(raw_flows),
    )


# ─── Render helpers ──────────────────────────────────────────────────────


def render_header(state: MonitorState) -> str:
    """Render the single-line header.

    Format: ``Maestro Monitor · N active flow(s)`` with the count
    styled. When ``has_logs_dir`` is false we surface a small
    warning so the operator knows the monitor is watching a missing
    directory (the empty-state panel will still render).
    """
    count = state.active_count
    label = "flow" if count == 1 else "flows"
    base = (
        f"[bold]{HEADER_TITLE}[/bold]  "
        f"[cyan]{count}[/cyan] active {label}"
    )
    if not state.has_logs_dir:
        base += (
            f"  [yellow]· watching {state.logs_dir} (missing)[/yellow]"
        )
    else:
        base += f"  [dim]· {state.logs_dir}[/dim]"
    return base


def render_footer(state: MonitorState) -> str:
    """Render the single-line footer. Constant across states in this slice.

    The interval is held in ``state`` for future slices; the footer
    today is the same for every state to match the AC's pinned text.
    Keeping the state-driven signature means future slices can add
    info (e.g. "last refresh: 12:34:56") without changing call sites.
    """
    return FOOTER_HINT


def render_body(state: MonitorState) -> Panel:
    """Render the main body cell.

    When there are active flows, renders one :class:`Panel` per flow
    in a vertical column. Each panel shows issue # + title, flow name,
    current phase indicator (e.g. ``3/5 reviewer``), agent role,
    what the agent is reading/acting on, elapsed time, and token usage.

    When no flows are active, renders the empty-state panel — a
    centred message inside a dim-bordered :class:`Panel`.

    Flows are displayed newest-first (reversed from scan order) so
    the most recently started flow appears at the top.
    """
    if state.active_count == 0:
        return Panel(
            Align.center(EMPTY_STATE_MESSAGE, vertical="middle"),
            border_style="dim",
            title="empty",
            title_align="left",
        )

    # Render one panel per active flow, newest first.
    panels: list[Panel] = []
    for snapshot in reversed(state.active_flows):
        panels.append(_render_flow_panel(snapshot))

    body_content = Group(*panels)
    return Panel(
        Align.center(body_content, vertical="top"),
        border_style="dim",
        title=f"{state.active_count} active",  # type: ignore[arg-type]
        title_align="left",
    )


# ─── Flow panel rendering ───────────────────────────────────────────────


def _render_flow_panel(snapshot: "FlowSnapshot") -> Panel:
    """Render a single :class:`Panel` for one active flow.

    The panel shows:

      - **Title**: ``#{issue} · {flow_name}``
      - **Phase**: current phase name with index (e.g. ``3/5 reviewer``)
      - **Agent**: the role currently working
      - **Action**: what the agent is reading/acting on
      - **Elapsed**: time since last ``phase_start``
      - **Tokens**: input / output / cache-read counts

    Missing fields are rendered as ``?`` rather than crashing.

    Args:
        snapshot: A :class:`FlowSnapshot` from the log reader.

    Returns:
        A :class:`Panel` with the flow's current status.
    """
    # Import here to avoid circular dependency at module load time.
    from flow_log_reader import format_elapsed, format_tokens  # noqa: PLC0414

    # Title line: issue number + flow name.
    issue_label = f"#{snapshot.issue_num}" if snapshot.issue_num is not None else "?"
    title_text = f"{issue_label} · {snapshot.flow_name}"

    # Phase indicator: e.g. "3/5 reviewer" or just "reviewer".
    phase_display = snapshot.current_phase or "?"
    if snapshot.phase_index is not None:
        total_str = f"/{snapshot.total_phases}" if snapshot.total_phases else ""
        phase_display = f"{snapshot.phase_index}{total_str} {phase_display}"

    # Agent role.
    agent_role = snapshot.agent_role or "?"

    # Action description (truncated).
    action = snapshot.action_description or "—"

    # Elapsed time.
    elapsed = format_elapsed(snapshot.elapsed_s)

    # Token usage.
    tokens_in = format_tokens(snapshot.tokens_in, label="in: ")
    tokens_out = format_tokens(snapshot.tokens_out, label="out: ")
    cache_str = f"cache: {format_tokens(snapshot.cache_read)}"

    # Build the panel content as structured text.
    lines = [
        Text.assemble(
            (f"Phase: [bold]{phase_display}[/]", "default"),
        ),
        Text.assemble(
            f"Agent: ", "dim",
            agent_role, "cyan bold",
        ),
        Text.assemble(
            f"Action: ", "dim",
            action, "default",
        ),
        Text.assemble(
            f"Elapsed: ", "dim",
            elapsed, "yellow",
        ),
        Text.assemble(
            f"Tokens: ", "dim",
            tokens_in, "green",
            "  ", "default",
            tokens_out, "magenta",
            "  ", "default",
            cache_str, "blue",
        ),
    ]

    return Panel(
        Group(*lines),
        title=title_text,
        border_style="blue",
        padding=(0, 1),
    )


# ─── Top-level layout builder ────────────────────────────────────────────


def build_layout(state: MonitorState) -> Layout:
    """Build the full-screen monitor layout for ``state``.

    The layout is split into three rows:

      - ``header`` (3 lines): title + active-flow count.
      - ``body``   (rest):   the empty-state panel (or flow cards
                              in future slices).
      - ``footer`` (1 line): the refresh + quit hint.

    Rich's :class:`Layout` is responsive: it re-flows automatically
    on terminal resize, which satisfies the AC "Terminal resize is
    handled correctly (no broken layout)" without any custom code.
    """
    layout = Layout()
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="body", ratio=1),
        Layout(name="footer", size=1),
    )
    layout["header"].update(render_header(state))
    layout["body"].update(render_body(state))
    layout["footer"].update(render_footer(state))
    return layout
