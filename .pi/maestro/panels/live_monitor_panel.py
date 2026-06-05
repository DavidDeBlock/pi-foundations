#!/usr/bin/env python3
"""
LiveMonitorPanel — Real-time pipeline status widget for Maestro Dashboard.

Shows:
  - Flow name and issue number
  - Elapsed timer counting up every second
  - Visual phase diagram using Unicode box-drawing characters
    with the current phase highlighted (🔄)
  - Recent tool call events from tail of session log
  - Model info extracted from session log `model_change` events

Pure UI panel — all data comes through DashboardAPI callbacks.
No direct I/O in the panel itself.
"""

from textual.widgets import Static, Label
from textual.containers import Vertical


class LiveMonitorPanel(Vertical):
    """Real-time pipeline monitor showing active Maestro run status."""

    CSS = """
    #monitor-container {
        layout: vertical;
        height: 1fr;
        padding: 1;
    }

    #header-section {
        width: 100%;
        margin-bottom: 1;
    }

    #flow-name {
        text-align: center;
        color: $text-accent;
        width: 100%;
    }

    #issue-number {
        text-align: center;
        color: $text-muted;
        width: 100%;
    }

    #timer-section {
        text-align: center;
        margin-bottom: 1;
    }

    #elapsed-timer {
        text-align: center;
        color: $accent;
        width: 100%;
        padding: 0 1;
    }

    #phase-diagram {
        text-align: center;
        margin-bottom: 1;
        padding: 1;
        border: round $secondary;
        background: $surface-darken-2;
    }

    #model-info {
        text-align: center;
        color: $text-muted;
        width: 100%;
        margin-bottom: 1;
        padding: 0 1;
    }

    #events-title {
        text-align: center;
        width: 100%;
        margin-bottom: 0.5;
    }

    #events-content {
        color: $text-muted;
        min-height: 3;
        padding: 1;
        border: round $secondary;
        background: $surface-darken-2;
        overflow-y: auto;
    }

    /* Idle state styling */
    #idle-message {
        text-align: center;
        color: $text-muted;
        width: 100%;
        padding: 3;
    }
    """

    def __init__(self):
        super().__init__()
        self._flow_name = "unknown"
        self._issue_number = None
        self._current_phase = ""
        self._all_phases: list[str] = []
        self._elapsed_seconds = 0.0
        self._model_info = None
        self._tool_calls: list[dict] = []
        self._timer_updated = False

    def compose(self):
        """Create child widgets for the live monitor panel."""
        yield Label("[bold cyan]Pipeline Monitor[/]", id="flow-name")
        yield Static("", id="issue-number")
        yield Static("", id="elapsed-timer")
        yield Static("", id="phase-diagram")
        yield Static("", id="model-info")
        yield Label("[bold blue]Recent Activity[/]", id="events-title")
        yield Static("", id="events-content")

    def _format_elapsed(self, seconds: float) -> str:
        """Format elapsed seconds into a human-readable string.

        Args:
            seconds: Elapsed time in seconds (float).

        Returns:
            Formatted string like "02:34" or "15:07".
        """
        mins = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{mins:02d}:{secs:02d}"

    def _build_phase_diagram(self, current_phase: str, all_phases: list[str]) -> str:
        """Build a Unicode phase diagram with the current phase highlighted.

        Uses box-drawing characters to connect phases and 🔄 emoji for the
        active one.

        Args:
            current_phase: The name of the currently running phase.
            all_phases: Ordered list of all phase names in the flow.

        Returns:
            Unicode string rendering the phase diagram.
        """
        if not all_phases or not current_phase:
            return "No phases defined"

        segments = []
        for i, phase in enumerate(all_phases):
            is_current = phase == current_phase
            marker = "[bold green]🔄[/]" if is_current else "○"
            label = f"[bold]{phase}[/]" if is_current else phase
            segment = f"{marker} {label}"

            # Add connector between phases (except after last)
            if i < len(all_phases) - 1:
                next_phase = all_phases[i + 1]
                if next_phase == current_phase:
                    connector = " [bold green]→[/]"
                else:
                    connector = " → "
                segment += connector

            segments.append(segment)

        return " ".join(segments)

    def _render_idle(self):
        """Render the idle state display."""
        flow_label = self.query_one("#flow-name", Label)
        issue_label = self.query_one("#issue-number", Static)
        timer_label = self.query_one("#elapsed-timer", Static)
        phase_display = self.query_one("#phase-diagram", Static)
        model_display = self.query_one("#model-info", Static)
        events_display = self.query_one("#events-content", Static)

        flow_label.update("[bold cyan]Pipeline Monitor[/]")
        issue_label.update("")
        timer_label.update("")
        phase_display.update("Idle — no active pipeline")
        model_display.update("")
        events_display.update("")

    def update_pipeline_status(
        self,
        session_data: dict | None = None,
        progress_data: dict | None = None,
        flow_phases: list[str] | None = None,
    ):
        """Update the panel with live pipeline data from DashboardAPI.

        This is the main entry point called by the dashboard on each poll cycle.

        Args:
            session_data: Dict from get_active_session() containing active/
                         state, issue, flow, phase, elapsed_seconds, etc.
            progress_data: Dict from get_session_progress() containing model,
                          recent_events, and tool_calls.
            flow_phases: Ordered list of all phase names for the current flow
                        (from flow config), used to build the full diagram.
        """
        # Check if pipeline is idle
        is_idle = not session_data or not session_data.get("active", False)

        if is_idle:
            self._render_idle()
            return

        # Extract session metadata
        issue_num = session_data.get("issue")
        flow_name = session_data.get("flow", "unknown")
        current_phase = session_data.get("phase", "")
        elapsed_seconds = session_data.get("elapsed_seconds", 0.0)

        # Store for timer updates
        self._flow_name = flow_name
        self._issue_number = issue_num
        self._current_phase = current_phase
        self._all_phases = flow_phases or []
        self._elapsed_seconds = elapsed_seconds

        # Update header
        flow_label = self.query_one("#flow-name", Label)
        if issue_num:
            flow_label.update(f"[bold cyan]{flow_name}[/] [dim]| Issue #{issue_num}[/]")
        else:
            flow_label.update(f"[bold cyan]{flow_name}[/]")

        # Update elapsed timer
        timer_label = self.query_one("#elapsed-timer", Static)
        formatted_time = self._format_elapsed(elapsed_seconds)
        state = session_data.get("state", "running")
        state_icon = "[bold green]●[/]" if state == "running" else "◐"
        timer_label.update(
            f"{state_icon} Elapsed: [bold]{formatted_time}[/]"
        )

        # Update phase diagram
        phase_display = self.query_one("#phase-diagram", Static)
        phases_to_show = flow_phases if flow_phases else current_phase.split(",")
        phase_diagram_str = self._build_phase_diagram(current_phase, phases_to_show)
        phase_display.update(phase_diagram_str)

        # Update model info from progress data
        model_display = self.query_one("#model-info", Static)
        if progress_data and progress_data.get("model"):
            model_name = progress_data["model"]
            model_display.update(f"🤖 Model: [dim]{model_name}[/]")
        else:
            model_display.update("")

        # Update recent tool call events from progress data
        events_display = self.query_one("#events-content", Static)
        if progress_data and progress_data.get("tool_calls"):
            self._tool_calls = progress_data["tool_calls"]
            event_lines = []
            for tc in self._tool_calls[-3:]:  # Show last 3 tool calls
                status_icon = "✅" if tc.get("status") == "success" else "❌"
                tool_name = tc.get("tool", "?")
                path = tc.get("path", "?")
                event_lines.append(f"{status_icon} {tool_name}: {path}")

            if not event_lines:
                # Fallback to recent_events if no filtered tool_calls
                recent = progress_data.get("recent_events", [])
                for evt in recent[-3:]:
                    if isinstance(evt, dict) and "text" in evt:
                        text_preview = evt["text"][:80]
                        event_lines.append(f"💬 {text_preview}")

            events_display.update("\n".join(event_lines))
        else:
            events_display.update("[dim]Waiting for activity...[/]")

    def update_timer(self):
        """Increment and display the elapsed timer.

        Called periodically (every second) while a pipeline is active to
        keep the timer counting up in real time without re-polling the API.
        """
        if not self._flow_name or self._flow_name == "unknown":
            return

        self._elapsed_seconds += 1.0
        formatted_time = self._format_elapsed(self._elapsed_seconds)
        last_session = getattr(self, "_last_session", {})
        state = last_session.get("state", "running") if last_session else "running"
        state_icon = "[bold green]●[/]" if state == "running" else "◐"

        timer_label = self.query_one("#elapsed-timer", Static)
        timer_label.update(
            f"{state_icon} Elapsed: [bold]{formatted_time}[/]"
        )

    def set_last_session(self, session_data: dict):
        """Store the last known session data for timer state tracking.

        Args:
            session_data: The most recent session data dict from API.
        """
        self._last_session = session_data

    def update_logs(self, message: str):
        """No-op stub. Replaced by real-time panel updates via
        ``update_pipeline_status()``."""
        pass

