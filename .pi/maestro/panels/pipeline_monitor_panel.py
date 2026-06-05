#!/usr/bin/env python3
"""
PipelineMonitorPanel — Visual pipeline monitor with phase map and queue stats.

Renders:
  - Queue statistics bar (pending count, completed today)
  - Phase map showing flow config as a status diagram
    e.g. builder ● → reviewer ✓ → diagnostic ○
  - Active session metadata (issue #, elapsed time, model)
  - Idle state message when no pipeline is running

Data sources:
  - DashboardAPI.get_active_session() → current phase / idle detection
  - DashboardAPI.get_flow_config(flow_name) → ordered phases list
  - DashboardAPI.get_all_sessions(days_limit=1) → completed today count

Auto-refreshes every 2 seconds using Textual's set_interval (non-blocking).
"""

from __future__ import annotations

import os
import sys
import traceback
from datetime import datetime as _dt
from pathlib import Path
from typing import Any

# ── Debug logging (writes to /tmp/maestro_dashboard.log) ─────────────
_LOG_DIR = Path(__file__).parent / ".." / "temp"
_LOG_DIR.mkdir(exist_ok=True, parents=True)
_DEBUG_LOG = _LOG_DIR / "panel.log"

def _sync(msg: str) -> None:
    """Write synchronously to log file using os.write — guaranteed to hit disk even on crash."""
    try:
        ts = _dt.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] PANEL  {msg}\n"
        fd = os.open(str(_DEBUG_LOG), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.write(fd, line.encode())
        os.close(fd)
    except Exception:
        pass

def _sync_err(exc: BaseException) -> None:
    """Write exception + traceback synchronously."""
    try:
        ts = _dt.now().strftime("%H:%M:%S.%f")[:-3]
        fd = os.open(str(_DEBUG_LOG), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.write(fd, f"[{ts}] PANEL  ERROR: {exc}\n".encode())
        for line in traceback.format_tb(exc.__traceback__):
            os.write(fd, line.encode())
        os.close(fd)
    except Exception:
        pass

from textual.containers import Container, Vertical
from textual.widgets import Label, Static


class PipelineMonitorPanel(Container):
    """Visual pipeline monitor with phase map and queue statistics.

    The panel polls DashboardAPI every 2 seconds via set_interval() to keep
    the display up-to-date without blocking UI events.
    """

    CSS = """
    /* ── Queue stats bar ─────────────────────────────────────────── */
    #queue-stats-bar {
        height: auto;
        margin-bottom: 1;
        border-bottom: solid $secondary;
        padding: 0 1;
    }

    /* ── Phase map ───────────────────────────────────────────────── */
    #phase-map-container {
        border: round $secondary;
        background: $surface-darken-2;
        padding: 1 2;
        margin-bottom: 1;
    }

    #phase-map-title {
        text-style: bold;
        color: $text-accent;
        margin-bottom: 0.5;
    }

    #phase-map-display {
        min-height: 3;
    }

    /* ── Session info ────────────────────────────────────────────── */
    #session-info {
        margin-top: 1;
        padding: 0 1;
    }

    .info-row {
        color: $text-muted;
        width: auto;
    }

    /* ── Idle state ──────────────────────────────────────────────── */
    #idle-message {
        content-align: center middle;
        min-height: 8;
        color: $text-muted;
    }

    .idle-icon {
        font-size: 3;
    }
    """

    def __init__(self, api_override=None, **kwargs):
        """Initialize the pipeline monitor panel.

        Args:
            api_override: Optional DashboardAPI instance for testing.
            **kwargs: Additional keyword arguments passed to Textual parent class
                      (e.g., id, classes). Supports standard Textual widget init.
        """
        import sys as _sys
        print(f"[PANEL __init__] Creating PipelineMonitorPanel with kwargs={list(kwargs.keys())}", file=_sys.stderr, flush=True)
        try:
            super().__init__(**kwargs)
        except Exception as e:
            print(f"[PANEL __init__] super().__init__ FAILED: {type(e).__name__}: {e}", file=_sys.stderr, flush=True)
            traceback.print_exc(file=_sys.stderr)
            raise
        self._api = api_override

        # Plain instance variables — no reactive machinery
        self.active_session = None
        self.flow_phases: list[str] = []
        self.completed_today = 0
        self.pending_count = 0
        self._has_rendered_once = False
        self._is_loading = True

    @property
    def dashboard_api(self):
        """Lazy-initialized DashboardAPI."""
        if self._api is not None:
            return self._api
        from lib.dashboard_api import DashboardAPI

        self._api = DashboardAPI()
        return self._api

    # Override render to avoid Textual 8.x Container + TabPane lifecycle crash
    # where inherited render() can return None during initial compose cycle
    def render(self) -> "RenderResult":
        from textual.renderables.blank import Blank
        return Blank(self.background_colors[1])

    # ── Compose ───────────────────────────────────────────────────────
    def compose(self):
        """Build the panel layout."""
        import sys as _sys
        print(f"[PANEL compose] called", file=_sys.stderr, flush=True)
        try:
            # Wrap everything in a Vertical to avoid Textual TabPane layout crashes
            with Vertical():
                yield Static("", id="queue-stats-bar")
                
                with Container(id="phase-map-container"):
                    yield Label("Phase Map", id="phase-map-title")
                    yield Static("", id="phase-map-display")
                
                yield Static("", id="session-info")
                
                yield Static(
                    "[dim]Loading pipeline status...[/]",
                    id="loading-message",
                )
                yield Static(
                    "[dim]Idle — no active pipeline[/]\n\n"
                    "  [bold]● running    ✓ done      ✗ failed      ○ pending[/]\n"
                    "  Start a flow from the Issues tab to see live status here.",
                    id="idle-message",
                )
        except Exception as e:
            print(f"[PANEL compose] ERROR: {type(e).__name__}: {e}", file=_sys.stderr, flush=True)
            traceback.print_exc(file=_sys.stderr)
            raise
        
        print("[PANEL compose] calling call_after_refresh", file=_sys.stderr, flush=True)
        # Defer first refresh until after mount completes
        self.call_after_refresh(self._first_refresh)
        print("[PANEL compose] done", file=_sys.stderr, flush=True)

    def on_mount(self):
        """Called when widget is attached to DOM.
        
        Immediately poll for active session so the panel shows real data
        as soon as it's visible (no 2-3s delay from timer tick).
        Also starts a periodic refresh interval.
        """
        import sys as _sys
        print(f"[PANEL on_mount] mounted={self.is_mounted}", file=_sys.stderr, flush=True)
        self._refresh_data()
        # Start auto-refresh every 2 seconds (only active while panel is mounted)
        self.set_interval(2.0, self._refresh_data, name="pipeline_auto_refresh")
    
    def _first_refresh(self):
        """Called once after the panel is fully mounted and laid out."""
        import sys as _sys
        print(f"[PANEL _first_refresh] called, has_rendered_once={self._has_rendered_once}", file=_sys.stderr, flush=True)
        self._has_rendered_once = True
        # Don't call _refresh_data here — on_mount already triggers it immediately

    # ── Data refresh (called every 2 seconds) ────────────────────────
    def _refresh_data(self):
        """Poll DashboardAPI for active session and flow config.

        Runs on the Textual timer loop — non-blocking, won't freeze UI.
        Updates plain attributes and re-renders only when data changes.

        Note: polling itself is safe even when not mounted (just stores data).
        The _refresh_panel_visuals() method has its own pre-flight check that prevents
        crashes when child widgets aren't yet composed in the DOM.
        """
        try:
            _sync(f"_refresh_data START (is_mounted={self.is_mounted})")
            api = self.dashboard_api
            _sync("  -> got dashboard_api")

            # 1. Get active session (or idle state)
            session_result = api.get_active_session()
            _sync(f"  -> get_active_session: success={session_result.success}, data={session_result.data is not None}")
            if not session_result.success or session_result.data is None:
                _sync("  -> returning early (no active session)")
                return

            new_session = session_result.data
            _sync(f"  -> got session: {new_session.get('flow', '?')}/{new_session.get('phase', '?')}")

            # 2. If active, also fetch flow config to get phase ordering
            new_phases: list[str] = []
            if new_session.get("active"):
                _sync("  -> session is active, fetching flow config")
                flow_name = new_session.get("flow", "")
                if flow_name:
                    # Try exact match first
                    flow_result = api.get_flow_config(flow_name)
                    _sync(f"  -> get_flow_config (exact): success={flow_result.success}")
                    
                    # Fallback: scan all flow files for a substring/contains match
                    if not flow_result.success or not flow_result.data:
                        try:
                            from pathlib import Path as _Path
                            flows_dir = api.flows_dir  # same dir used by get_flow_config
                            for f in sorted(flows_dir.glob("*.json")):
                                candidate_name = f.stem  # filename without .json
                                if flow_name in candidate_name or candidate_name in flow_name:
                                    _sync(f"  -> fallback match: {candidate_name}")
                                    flow_result = api.get_flow_config(candidate_name)
                                    if flow_result.success and flow_result.data:
                                        break
                        except Exception as e:
                            _sync(f"  -> fallback scan failed: {e}")
                    
                    if flow_result.success and flow_result.data:
                        phases_dict = flow_result.data.get("phases", {})
                        # Preserve insertion order (Python 3.7+)
                        new_phases = list(phases_dict.keys())
                        _sync(f"  -> got {len(new_phases)} phases: {new_phases}")

            # 3. Queue stats — completed today + pending
            _sync("  -> computing queue stats")
            completed_today, pending_count = self._compute_queue_stats(api)
            _sync(f"  -> queue stats: completed={completed_today}, pending={pending_count}")

            # Only re-render if something actually changed
            data_changed = (
                new_session is not self.active_session or
                new_phases != self.flow_phases or
                completed_today != self.completed_today or
                pending_count != self.pending_count
            )
            _sync(f"  -> data_changed={data_changed}")

            if data_changed:
                _sync(f"data_changed=True, rendering (active_session={self.active_session is not None})")
                self.active_session = new_session
                self.flow_phases = new_phases
                self.completed_today = completed_today
                self.pending_count = pending_count
                # Hide loading indicator on first successful refresh
                if self._is_loading:
                    try:
                        loading_msg = self.query_one("#loading-message", Static)
                        loading_msg.visible = False
                    except Exception:
                        pass
                    self._is_loading = False
                # Render directly — plain attributes, no watchers
                try:
                    _sync("  -> calling _refresh_panel_visuals()")
                    self._refresh_panel_visuals()
                    _sync("  -> _refresh_panel_visuals() OK")
                except Exception as e:
                    _sync_err(e)
                    _sync(f"_refresh_data: render failed but continuing (is_mounted={self.is_mounted})")

            _sync("_refresh_data END")

        except Exception as e:
            # Log the error but don't crash the app
            _sync_err(e)
            _sync(f"_refresh_data crashed with: {e}")

    def _compute_queue_stats(
        self, api: Any
    ) -> tuple[int, int]:
        """Compute queue statistics from session data.

        Args:
            api: DashboardAPI instance (already initialized).

        Returns:
            Tuple of (completed_today, pending_count).
        """
        # Completed today: sessions with approved verdict in the last 24h
        completed_today = 0
        try:
            result = api.get_all_sessions(days_limit=1)
            if result.success and result.data:
                for session in result.data:
                    if isinstance(session, dict):
                        verdict = session.get("verdict_status", "")
                        if verdict == "approved":
                            completed_today += 1
        except Exception:
            pass

        # Pending count: sessions that are not yet approved/rejected
        pending_count = 0
        try:
            result = api.get_all_sessions(days_limit=1)
            if result.success and result.data:
                for session in result.data:
                    if isinstance(session, dict):
                        verdict = session.get("verdict_status", "")
                        # Not yet approved or rejected → still pending
                        if verdict not in ("approved", "rejected"):
                            pending_count += 1
        except Exception:
            pass

        return completed_today, pending_count

    # ── Render methods ────────────────────────────────────────────────
    def _refresh_panel_visuals(self):
        """Render the panel based on current state.

        Guarded: if any child widget is None (not yet composed in DOM),
        bail out silently. This happens during tab switches when Textual
        tears down and rebuilds inactive TabPane content.
        """
        _sync(f"_refresh_panel_visuals() called, is_mounted={self.is_mounted}, has_rendered_once={self._has_rendered_once}")
        
        # Quick pre-flight check: can we find all our child widgets?
        try:
            self.query_one("#queue-stats-bar", Static)
            self.query_one("#phase-map-display", Static)
            self.query_one("#session-info", Static)
            self.query_one("#idle-message", Static)
            # Loading message is optional (may not exist in older code versions)
            try:
                self.query_one("#loading-message", Static)
            except Exception:
                pass
        except Exception as e:
            _sync(f"_refresh_panel_visuals: pre-flight failed (widgets not yet composed), bailing out")
            return

        is_idle = not self.active_session or not self.active_session.get("active", False)
        _sync(f"_refresh_panel_visuals: idle={is_idle}")

        try:
            if is_idle:
                self._render_idle()
            else:
                self._render_active()
        except Exception as e:
            _sync_err(e)
            raise  # Re-raise so caller knows something went wrong

    def _render_idle(self):
        """Render the idle state."""
        try:
            loading_msg = self.query_one("#loading-message", Static)
            loading_msg.visible = False
        except Exception:
            pass
        
        queue_bar = self.query_one("#queue-stats-bar", Static)
        phase_map_display = self.query_one("#phase-map-display", Static)
        session_info = self.query_one("#session-info", Static)
        idle_msg = self.query_one("#idle-message", Static)

        queue_bar.update("")
        phase_map_display.update("")
        session_info.update("")

    def _render_active(self):
        """Render the active pipeline state."""
        session = self.active_session or {}
        phases = self.flow_phases
        current_phase = session.get("phase", "")

        # 1. Queue stats bar
        queue_bar = self.query_one("#queue-stats-bar", Static)
        completed_str = str(self.completed_today)
        pending_str = str(self.pending_count)
        flow_name = session.get("flow", "unknown")
        issue_num = session.get("issue")

        stat_parts = [
            f"[dim]Flow:[/dim] [bold]{flow_name}[/]",
        ]
        if issue_num:
            stat_parts.append(f"  [dim]| Issue #[/dim][bold]{issue_num}[/]")
        stat_parts.extend([
            "  [dim]● Running:[/dim] [bold]1[/]",
            f"  [dim]✓ Completed Today:[/dim] {completed_str}",
            f"  [dim]○ Pending:[/dim] {pending_str}",
        ])

        queue_bar.update(" ".join(stat_parts))

        # 2. Phase map
        phase_display = self.query_one("#phase-map-display", Static)
        phase_map_text = self._build_phase_map(phases, current_phase)
        phase_display.update(phase_map_text)

        # 3. Session info (elapsed time + model)
        session_info = self.query_one("#session-info", Static)
        elapsed = session.get("elapsed_seconds", 0.0)
        formatted_time = self._format_elapsed(elapsed)

        # Try to get model from progress data if available
        model_text = ""
        try:
            jsonl_path = session.get("jsonl_path")
            if jsonl_path:
                progress_result = self.dashboard_api.get_session_progress(jsonl_path)
                if (progress_result.success and progress_result.data
                        and progress_result.data.get("model")):
                    model_text = f"  [dim]Model:[/dim] {progress_result.data['model']}"
        except Exception:
            pass

        session_info.update(
            f"[dim]Elapsed:[/dim] [bold]{formatted_time}[/]"
            + (f"\n{model_text}" if model_text else "")
        )

    def _build_phase_map(self, phases: list[str], current_phase: str) -> str:
        """Build the phase map text with status indicators.

        Status mapping:
          ● running  — current active phase
          ✓ done     — phases before the current one (completed)
          ✗ failed   — if we detect a failure in session data
          ○ pending  — phases after the current one

        Args:
            phases: Ordered list of all phase names from flow config.
            current_phase: Name of the currently running phase.

        Returns:
            Rich markup string for the phase map display.
        """
        if not phases or not current_phase:
            return "[dim]No phase information available[/]"

        # Determine which phases are done vs pending based on order
        try:
            current_index = phases.index(current_phase)
        except ValueError:
            # Current phase not in the list — treat all as pending
            current_index = len(phases)

        segments = []
        for i, phase in enumerate(phases):
            if i < current_index:
                icon = "[bold green]✓[/]"
                label = f"[dim]{phase}[/]"
            elif i == current_index:
                icon = "[bold green]●[/]"
                label = f"[bold green]{phase}[/]"
            else:
                icon = "○"
                label = phase

            segments.append(f"{icon} {label}")

        return "  ".join(segments)

    def _format_elapsed(self, seconds: float) -> str:
        """Format elapsed seconds into HH:MM:SS.

        Args:
            seconds: Elapsed time in seconds (float).

        Returns:
            Formatted string like "00:15:42".
        """
        total_secs = int(seconds)
        hours, remainder = divmod(total_secs, 3600)
        mins, secs = divmod(remainder, 60)
        return f"{hours:02d}:{mins:02d}:{secs:02d}"

    # ── Public API (for tests and dashboard wiring) ───────────────────
    def set_active_session(self, session_data: dict | None):
        """Directly set the active session data (bypasses auto-refresh)."""
        self.active_session = session_data
        if self._has_rendered_once:
            try:
                self._refresh_panel_visuals()
            except Exception:
                pass

    def set_flow_phases(self, phases: list[str]):
        """Directly set flow phase ordering (bypasses auto-refresh)."""
        self.flow_phases = phases
        if self._has_rendered_once:
            try:
                self._refresh_panel_visuals()
            except Exception:
                pass

    def set_queue_stats(self, completed_today: int, pending_count: int):
        """Directly set queue statistics (bypasses auto-refresh)."""
        self.completed_today = completed_today
        self.pending_count = pending_count
        if self._has_rendered_once:
            try:
                self._refresh_panel_visuals()
            except Exception:
                pass


# ── Constants for status indicators (used in tests) ───────────────────
PHASE_STATUS_RUNNING = "●"
PHASE_STATUS_DONE = "✓"
PHASE_STATUS_FAILED = "✗"
PHASE_STATUS_PENDING = "○"
