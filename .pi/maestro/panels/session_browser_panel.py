#!/usr/bin/env python3
"""
SessionBrowserPanel — Interactive session history browser.

Pure UI panel that receives data from DashboardAPI and renders it.
No direct I/O — all data comes through the API layer.

Features:
- DataTable with columns: Issue #, Flow name, Phase, Model, Duration, Verdict icon
- Client-side dropdown filters for flow name, phase, and model
- Empty state handled gracefully when no sessions match or directory is empty
- Detail drawer that opens on row click, showing parsed summary with:
    - File operations timeline (chronological read/write/edit events)
    - Errors section listing tool failures or assistant-detected issues

Usage:
    from panels.session_browser_panel import SessionBrowserPanel
    panel = SessionBrowserPanel()
"""

from textual.events import Event
from textual.widgets import DataTable, Label, Select, Static
from textual.containers import Vertical, ScrollableContainer


class SessionSelected(Event):
    """Emitted when a session row is selected.

    Attributes:
        session_data: The full session summary dict for the selected row.
    """
    def __init__(self, session_data: dict) -> None:
        super().__init__()
        self.session_data = session_data


class SessionBrowserPanel(Vertical):
    """Right-bottom panel for browsing orchestrator session history."""

    CSS = """
    SessionBrowserPanel {
        width: 100%;
        height: 100%;
        border: solid $accent;
        background: $surface;
        padding: 1;
        layout: vertical;
    }

    #session-title {
        text-align: center;
        width: 100%;
        margin-bottom: 0.5;
    }

    /* Filter bar */
    #filter-bar {
        height: auto;
        margin-bottom: 0.5;
        padding: 0 1;
        layout: horizontal;
        align-horizontal: center;
    }

    .filter-group {
        width: auto;
        margin-right: 2;
    }

    Select.filter-select {
        width: 36;
    }

    /* Data table */
    DataTable#sessions-table {
        height: 1fr;
    }

    /* Empty state */
    #empty-state {
        content-align: center middle;
        color: $text-muted;
        width: 100%;
        height: 100%;
        display: none;
    }

    #empty-state.visible {
        display: block;
    }
    """



    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.sessions_table = None
        self._selected_session_idx: int | None = None
        self._all_sessions: list[dict] = []  # Full session data for filtering
        self._available_flows: list[str] = []
        self._available_phases: list[str] = []
        self._available_models: list[str] = []
        self._current_flow_filter: str = "all"
        self._current_phase_filter: str = "all"
        self._current_model_filter: str = "all"

    def compose(self):
        """Create child widgets for the session browser panel."""
        yield Label("[bold yellow]Session History[/]", id="session-title")

        # Filter bar with flow/phase/model dropdowns.
        # Select options are (display_text, value) tuples.
        with Vertical(id="filter-bar"):
            with ScrollableContainer():
                yield Select(
                    options=[("All flows", "all")],
                    prompt="Flow: All",
                    value="all",
                    id="flow-filter",
                    classes="filter-select",
                )
                yield Select(
                    options=[("All phases", "all")],
                    prompt="Phase: All",
                    value="all",
                    id="phase-filter",
                    classes="filter-select",
                )
                yield Select(
                    options=[("All models", "all")],
                    prompt="Model: All",
                    value="all",
                    id="model-filter",
                    classes="filter-select",
                )

        # Session data table
        table = DataTable(id="sessions-table", zebra_stripes=True)
        table.add_columns("#", "Flow", "Phase", "Model", "Duration", "Status")
        table.columns_width = [6, 20, 14, 30, 8, 8]
        table.cursor_type = "row"
        self.sessions_table = table
        yield table

        # Empty state (hidden via CSS display:none, toggled in _apply_filters)
        yield Static("[dim]No sessions found.[/]", id="empty-state")

    def on_mount(self) -> None:
        """Register event handlers."""
        if self.sessions_table:
            self.sessions_table.can_focus = True

    # ── Data Loading ─────────────────────────────────────────────────────

    def update_sessions(self, sessions: list[dict]) -> None:
        """Update the panel with session data from DashboardAPI.

        Populates dropdown options (flow, phase, model) and applies filters.

        Args:
            sessions: List of session summary dicts from get_all_sessions().
                     Each dict should contain at least: issue, flow, phase,
                     model, duration_seconds, verdict_status, file_ops_count,
                     error_count, timestamp_str, raw_path.
        """
        self._all_sessions = sessions or []

        # Extract unique values for dropdowns (sorted)
        if self._all_sessions:
            self._available_flows = sorted(set(s.get("flow", "") for s in self._all_sessions))
            self._available_phases = sorted(set(s.get("phase", "") for s in self._all_sessions))
            self._available_models = sorted(
                set(str(s.get("model", "")) for s in self._all_sessions if s.get("model"))
            )
        else:
            self._available_flows = []
            self._available_phases = []
            self._available_models = []

        # Populate dropdown options
        self._populate_dropdown("flow-filter", self._available_flows, "All flows")
        self._populate_dropdown("phase-filter", self._available_phases, "All phases")
        self._populate_dropdown("model-filter", self._available_models, "All models")

        # Reset filters to "all" when new data arrives
        self._current_flow_filter = "all"
        self._current_phase_filter = "all"
        self._current_model_filter = "all"

        self._apply_filters()

    def _apply_filters(self) -> None:
        """Apply current flow/phase/model filters (client-side), then render the table."""
        if not self.sessions_table:
            return

        filtered = self._all_sessions

        # Apply flow filter
        if self._current_flow_filter != "all":
            filtered = [s for s in filtered if s.get("flow") == self._current_flow_filter]

        # Apply phase filter
        if self._current_phase_filter != "all":
            filtered = [s for s in filtered if s.get("phase") == self._current_phase_filter]

        # Apply model filter
        if self._current_model_filter != "all":
            filtered = [
                s for s in filtered
                if str(s.get("model", "")) == self._current_model_filter
            ]

        # Render table
        self.sessions_table.clear()

        # Toggle empty state visibility via CSS class
        empty_state = self.query_one("#empty-state", Static)
        if not filtered:
            empty_state.add_class("visible")
            return

        empty_state.remove_class("visible")

        for session in filtered:
            issue_num = str(session.get("issue", "?"))
            flow = session.get("flow", "unknown")[:20]
            phase = session.get("phase", "unknown")[:14]
            model = (session.get("model") or "?")[:30]
            duration = self._format_duration(session.get("duration_seconds", 0))

            # Determine verdict icon
            verdict_status = session.get("verdict_status")
            if verdict_status == "approved":
                status_icon = "✅"
            elif verdict_status == "rejected":
                status_icon = "❌"
            elif session.get("error_count", 0) > 0:
                status_icon = "⚠️"
            else:
                status_icon = "➖"

            self.sessions_table.add_row(
                issue_num, flow, phase, model, duration, status_icon,
                key=str(session.get("raw_path", "")),
            )



    def _format_duration(self, duration_seconds: float) -> str:
        """Format duration in seconds to a human-readable string.

        Args:
            duration_seconds: Duration in seconds.

        Returns:
            Formatted string like "2m 30s" or "1h 5m".
        """
        if not duration_seconds:
            return "?"
        mins = int(duration_seconds) // 60
        secs = int(duration_seconds) % 60
        if mins >= 60:
            hours = mins // 60
            remaining_mins = mins % 60
            return f"{hours}h {remaining_mins}m"
        elif mins > 0:
            return f"{mins}m {secs}s"
        else:
            return f"{secs}s"

    # ── Event Handlers ───────────────────────────────────────────────────

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle row selection in the sessions table.

        Emits a SessionSelected event with the session data for the dashboard
        to handle (render in SharedDetailView).
        """
        if not self.sessions_table:
            return

        try:
            # event.row_key is a RowKey object — use .value to get the actual string key
            row_value = event.row_key.value
            for session in self._all_sessions:
                if str(session.get("raw_path", "")) == row_value:
                    self.post_message(SessionSelected(session_data=session))
                    break
        except Exception:
            pass

    def _populate_dropdown(
        self,
        widget_id: str,
        values: list[str],
        prompt: str,
    ) -> None:
        """Populate a Select dropdown with the given values.

        Uses set_options() which properly rebuilds internal state after mount.

        Args:
            widget_id: The id of the Select widget to populate.
            values: List of string values to add as options.
            prompt: Prompt text shown when no selection is made.
        """
        try:
            dropdown = self.query_one(f"#{widget_id}", Select)
            # set_options expects (display_text, value) tuples
            options = [(v, v) for v in values]
            dropdown.set_options([(prompt, "all")] + options)
            # After set_options(), value resets to NULL/blank — re-select "all"
            dropdown.value = "all"
        except Exception:
            pass  # Dropdown may not exist yet (compose order)

    def on_select_changed(self, event: Select.Changed) -> None:
        """Handle flow/phase/model dropdown changes."""
        widget_id = event.select.id
        if widget_id == "flow-filter":
            self._current_flow_filter = event.value
        elif widget_id == "phase-filter":
            self._current_phase_filter = event.value
        elif widget_id == "model-filter":
            self._current_model_filter = event.value
        else:
            return

        self._apply_filters()
