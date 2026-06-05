#!/usr/bin/env python3
"""
Maestro Dashboard — Interactive Terminal UI for Orchestrator Monitoring.

A static, non-scrolling dashboard showing:
- Left pane with two tabs: GitHub Issues and Session History
  - Clickable rows in both tabs show details in a shared drawer below
- Right pane: Live pipeline monitor (orchestrator state & progress)
- Command input / key bindings (footer)

Auto-refreshes issue data every 60 seconds, sessions every 30 seconds,
and pipeline status every 2 seconds — without blocking UI events.

Usage:
    cd .pi/maestro && python3 dashboard.py
"""

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, Vertical
from textual.widgets import Header, Footer, Static, TabbedContent, TabPane

from panels.shared_detail_view import SharedDetailView


class MaestroDashboard(App):
    """Interactive dashboard for monitoring the Maestro orchestrator."""

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("r", "refresh", "Refresh Data"),
        Binding("escape", "clear_detail", "Clear Detail"),
    ]

    CSS = """
    /* ── Screen layout: dock header/footer, fill rest with main container ─ */
    Screen {
        background: $background;
    }

    #main-container {
        width: 1fr;
        height: 1fr;
        layout: horizontal;
    }

    /* Left column — tabs + shared detail drawer */
    #left-panel {
        width: 65%;
        height: 1fr;
        border: solid $primary;
        background: $surface;
        layout: vertical;
    }

    TabbedContent#main-tabs {
        height: auto;
        max-height: 70%;
    }

    /* Shared detail drawer below the tabs */
    #detail-container {
        height: 30%;
        margin-top: 1;
        border: round $accent;
        background: $surface-darken-2;
    }

    /* Right column — live pipeline monitor only */
    #right-panel {
        width: 35%;
        height: 1fr;
        border: solid $secondary;
        background: $surface;
        layout: vertical;
    }

    LiveMonitorPanel {
        height: 1fr;
    }

    .panel-placeholder {
        text-align: center;
        color: $text-muted;
        padding: 2;
    }

    /* Error banner — overlay on top of everything */
    #error-banner-container {
        layer: overlay;
        dock: bottom;
        display: none;
        width: 1fr;
        height: auto;
    }

    #error-banner-container.visible {
        display: block;
    }

    #error-content {
        color: $error;
        text-align: center;
        padding: 1;
        border: round $error;
        background: $error-darken-2;
    }

    Button#retry-btn {
        margin-top: 1;
    }
    """

    ISSUE_REFRESH_INTERVAL = 60  # seconds between issue data refresh
    SESSION_REFRESH_INTERVAL = 30  # seconds between session history refresh
    PIPELINE_POLL_INTERVAL = 2   # seconds between pipeline status polls

    def __init__(self):
        super().__init__()
        self._issues_panel = None
        self._session_panel = None
        self._live_panel = None
        self._detail_view: SharedDetailView | None = None
        self._error_visible = False

    def compose(self) -> ComposeResult:
        """Create child widgets for the app."""
        yield Header()

        # Main container — horizontal split (left + right panels)
        with Container(id="main-container"):
            # ── Left Panel: Tabs (Issues / Sessions) + Shared Detail ──
            with Vertical(id="left-panel"):
                with TabbedContent(id="main-tabs"):
                    with TabPane("Issues", id="issues-tab"):
                        from panels.issues_panel import IssuesPanel
                        self._issues_panel = IssuesPanel()
                        yield self._issues_panel

                    with TabPane("Sessions", id="sessions-tab"):
                        from panels.session_browser_panel import SessionBrowserPanel
                        self._session_panel = SessionBrowserPanel()
                        yield self._session_panel

                # Shared detail drawer — renders issue or session details
                self._detail_view = SharedDetailView(id="detail-container")
                yield self._detail_view

            # ── Right Panel: Live Pipeline Monitor ──
            with Vertical(id="right-panel"):
                from panels.live_monitor_panel import LiveMonitorPanel
                self._live_panel = LiveMonitorPanel()
                yield self._live_panel

        # Error banner overlay (hidden by default, shown on API failure)
        with Container(id="error-banner-container"):
            yield Static(
                "[bold red]GitHub unreachable[/]\n"
                "Please check your connection and try again.",
                id="error-content",
            )
            yield Static(
                "[bold underline]Retry → Press 'r' or click here[/]",
                id="retry-btn",
            )

        yield Footer()

    def on_mount(self) -> None:
        """Initialize the dashboard when it loads."""
        # Fetch initial data and start auto-refresh timers
        self._fetch_issues()
        self._poll_sessions()  # Load session history immediately
        self._poll_pipeline()  # Load pipeline status immediately
        # Start issue refresh timer
        self.set_interval(self.ISSUE_REFRESH_INTERVAL, self._auto_refresh)
        # Start session history refresh timer (slower — file scanning is cheap but we don't need it every second)
        self.set_interval(self.SESSION_REFRESH_INTERVAL, self._poll_sessions)
        # Start pipeline poll timer (faster interval for live monitoring)
        self.set_interval(self.PIPELINE_POLL_INTERVAL, self._poll_pipeline)

    # ── Data Fetching ────────────────────────────────────────────────────

    def _fetch_issues(self):
        """Fetch issues from GitHub API and update the panel."""
        try:
            from lib.dashboard_api import DashboardAPI

            api = DashboardAPI()
            result = api.fetch_issues(labels=["needs-triage", "parent-prd"])

            if result.success and result.data:
                self._hide_error()
                if self._issues_panel:
                    self._issues_panel.update_issues(result.data)
                self.update_logs(f"Loaded {len(result.data)} issues")
            else:
                # API returned success but no data — fine, just show empty table
                self._hide_error()
                if self._issues_panel:
                    self._issues_panel.clear_issues()
        except Exception as e:
            error_msg = str(e)
            print(
                f"[dashboard] ERROR fetching issues: {error_msg}",
                file=__import__("sys").stderr,
            )
            self._show_error(error_msg)

    def _poll_pipeline(self):
        """Poll active session and progress, update the live monitor panel."""
        try:
            from lib.dashboard_api import DashboardAPI
            from lib.dashboard_api import DashboardResult

            api = DashboardAPI()

            # Get active session metadata
            session_result = api.get_active_session()
            if not session_result.success or not session_result.data:
                if self._live_panel:
                    self._live_panel.update_pipeline_status(
                        session_data=None,
                        progress_data=None,
                        flow_phases=[],
                    )
                return

            session_data = session_result.data

            # If idle, render idle state and skip further processing
            if not session_data.get("active", False):
                if self._live_panel:
                    self._live_panel.update_pipeline_status(
                        session_data=session_data,
                        progress_data=None,
                        flow_phases=[],
                    )
                return

            # Get flow phases for the diagram from the flow config
            flow_name = session_data.get("flow", "")
            flow_phases: list[str] = []
            if flow_name:
                flow_config_result = api.get_flow_config(flow_name)
                if flow_config_result.success and flow_config_result.data:
                    phases = flow_config_result.data.get("phases", {})
                    if isinstance(phases, dict):
                        flow_phases = list(phases.keys())

            # Get session progress (recent tool calls + model info)
            jsonl_path = session_data.get("jsonl_path", "")
            progress_result = api.get_session_progress(jsonl_path) if jsonl_path else DashboardResult(success=False, data=None, error="No JSONL path")

            progress_data = None
            if progress_result.success and progress_result.data:
                progress_data = progress_result.data

            # Update the panel with all data
            if self._live_panel:
                self._live_panel.update_pipeline_status(
                    session_data=session_data,
                    progress_data=progress_data,
                    flow_phases=flow_phases,
                )
                # Store last session for timer state tracking
                self._live_panel.set_last_session(session_data)
        except Exception as e:
            print(f"[dashboard] ERROR polling pipeline: {e}", file=__import__("sys").stderr)

    def _poll_sessions(self):
        """Fetch session history from the sessions directory and update the panel."""
        try:
            from lib.dashboard_api import DashboardAPI

            api = DashboardAPI()
            result = api.get_all_sessions()

            if result.success and result.data:
                self._hide_error()
                if self._session_panel:
                    self._session_panel.update_sessions(result.data)
            else:
                self._hide_error()
                if self._session_panel:
                    self._session_panel.update_sessions([])
        except Exception as e:
            print(f"[dashboard] ERROR polling sessions: {e}", file=__import__("sys").stderr)

    def _auto_refresh(self):
        """Periodic auto-refresh for issue data only.

        Session history is refreshed via `_poll_sessions()` at its own interval.
        Pipeline status is polled separately at a faster interval via
        `_poll_pipeline()`.
        """
        self._fetch_issues()

    def action_refresh(self) -> None:
        """Refresh the dashboard data manually."""
        self.update_logs("Data refresh triggered.")
        self._fetch_issues()
        self._poll_sessions()

    def action_clear_detail(self) -> None:
        """Clear the shared detail view."""
        if self._detail_view:
            self._detail_view.clear()

    # ── Detail View Handlers ─────────────────────────────────────────────

    def on_issue_selected(self, event: "panels.issues_panel.IssueSelected") -> None:
        """Handle IssueSelected event from IssuesPanel.

        Fetches full issue data and renders it in the shared detail view.
        """
        if not self._detail_view:
            return

        # Show loading state
        self._detail_view.clear()

        try:
            from lib.dashboard_api import DashboardAPI

            api = DashboardAPI()
            result = api.fetch_issue(event.issue_number)

            if result.success and result.data:
                issue_data = result.data
                # Convert to dict for SharedDetailView
                detail_dict = {
                    "type": "issue",
                    "number": getattr(issue_data, 'number', event.issue_number),
                    "title": getattr(issue_data, 'title', ''),
                    "body": getattr(issue_data, 'body', '') or '',
                    "labels": getattr(issue_data, 'labels', []) or [],
                    "created_at": getattr(issue_data, 'created_at', None),
                    "state": getattr(issue_data, 'state', 'open'),
                    "assignee": getattr(issue_data, 'assignee', ''),
                }
                self._detail_view.populate(detail_dict)
            else:
                self._detail_view.clear()
        except Exception as e:
            print(f"[dashboard] ERROR fetching issue detail #{event.issue_number}: {e}",
                  file=__import__("sys").stderr)

    def on_session_selected(self, event: "panels.session_browser_panel.SessionSelected") -> None:
        """Handle SessionSelected event from SessionBrowserPanel.

        Renders the session summary in the shared detail view.
        Also fetches parsed log data for richer display.
        """
        if not self._detail_view:
            return

        session_data = event.session_data
        raw_path = session_data.get("raw_path", "")

        # Build enriched dict with parsed log data
        detail_dict = {
            "type": "session",
            **session_data,
        }

        if raw_path:
            try:
                from lib.session_reader import parse_session_log
                summary = parse_session_log(raw_path)
                detail_dict["file_operations"] = summary.get("file_operations", [])
                detail_dict["errors"] = summary.get("errors", [])
                detail_dict["model"] = summary.get("model") or session_data.get("model")
            except Exception as e:
                print(f"[dashboard] ERROR parsing session log {raw_path}: {e}",
                      file=__import__("sys").stderr)

        self._detail_view.populate(detail_dict)

    # ── Error Handling ───────────────────────────────────────────────────

    def _show_error(self, message: str):
        """Show the error banner with retry option."""
        if not self._error_visible:
            try:
                banner = self.query_one("#error-banner-container")
                content = self.query_one("#error-content")
                banner.add_class("visible")
                error_parts = [f"[bold red]GitHub unreachable[/]", f"{message}"]
                content.update("\n".join(error_parts))
                self._error_visible = True
            except Exception:
                pass

    def _hide_error(self):
        """Hide the error banner."""
        if self._error_visible:
            try:
                banner = self.query_one("#error-banner-container")
                banner.remove_class("visible")
                self._error_visible = False
            except Exception:
                pass

    # ── Log Helper ───────────────────────────────────────────────────────

    def update_logs(self, message: str):
        """Helper method to log messages to the live monitor panel."""
        if self._live_panel:
            self._live_panel.update_logs(message)


if __name__ == "__main__":
    app = MaestroDashboard()
    app.run()
