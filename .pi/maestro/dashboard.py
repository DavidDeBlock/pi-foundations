#!/usr/bin/env python3
"""
Maestro Dashboard — Interactive Terminal UI for Orchestrator Monitoring.

A 6-tab TUI system with LazyGit/k9s styling:
- Issues (GitHub open issues)
- Sessions (local session browser)
- Pipelines (pipeline monitoring)
- Chat (LLM chat modal overlay)
- Logs (JSONL log tailing)
- Agents (flow phase status)

Usage:
    cd .pi/maestro && python3 dashboard.py
"""

import os
import sys
import traceback
from pathlib import Path

_LOG_DIR = Path(__file__).parent / "temp"
_LOG_DIR.mkdir(exist_ok=True, parents=True)
_DEBUG_LOG = _LOG_DIR / "dashboard.log"

def _sync(msg: str) -> None:
    """Write synchronously to log file using os.write — guaranteed to hit disk even on crash."""
    try:
        from datetime import datetime
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] APP     {msg}\n"
        fd = os.open(str(_DEBUG_LOG), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.write(fd, line.encode())
        os.close(fd)
    except Exception:
        pass

def _sync_err(exc: BaseException) -> None:
    """Write exception + traceback synchronously."""
    try:
        from datetime import datetime
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        fd = os.open(str(_DEBUG_LOG), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.write(fd, f"[{ts}] APP     ERROR: {exc}\n".encode())
        for line in traceback.format_tb(exc.__traceback__):
            os.write(fd, line.encode())
        os.close(fd)
    except Exception:
        pass

def _eprint(msg: str) -> None:
    """Print to stderr + write sync log."""
    _sync(msg)

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, Horizontal, Vertical
from textual.widgets import (
    DataTable,
    Footer,
    Header,
    Label,
    Select,
    Static,
    TabbedContent,
    TabPane,
)
from textual.reactive import reactive
from panels.session_browser_panel import SessionBrowserPanel, SessionSelected
from panels.replay_modal import ReplayModal
from panels.session_files_modal import SessionFilesModal
from panels.raw_logs_modal import RawLogsModal
from panels.pipeline_monitor_panel import PipelineMonitorPanel


class MaestroApp(App):
    """Maestro Dashboard — 6-tab TUI with horizontal split layout."""

    TITLE = "Maestro Dashboard"
    SUBTITLE = "GitHub Issues • Sessions • Pipelines • Chat • Logs • Agents"

    CSS = """
    /* ── Screen ─────────────────────────────────────────────────────── */
    Screen {
        background: $boost;
    }

    /* ── Tab styling (LazyGit/k9s inspired) ─────────────────────────── */
    TabbedContent {
        height: auto;
    }

    TabbedContent > .tab-bar {
        background: $primary-darken-2;
        color: $text-muted;
    }

    TabbedContent > .tab-bar > .tab--label {
        text-style: bold;
    }

    /* ── Filters bar ────────────────────────────────────────────────── */
    #filters-bar {
        dock: top;
        height: 3;
        margin-top: 0;
        padding: 0 2;
        background: $surface-darken-1;
        border-bottom: solid $secondary;
    }

    /* ── Main horizontal split ──────────────────────────────────────── */
    #main-split {
        layout: horizontal;
        height: 1fr;
        margin-top: 1;
    }

    #list-view {
        width: 65%;
        height: auto;
        border: solid $primary;
        background: $surface;
    }

    #detail-panel {
        width: 35%;
        border-left: solid $secondary;
        background: $surface-darken-2;
        padding: 1 2;
    }

    /* ── DataTable styling ──────────────────────────────────────────── */
    DataTable {
        height: 1fr;
    }

    DataTable > .data-table--header {
        background: $primary-darken-1;
        color: white;
        text-style: bold;
    }

    DataTable > .data-table--fixed-header {
        background: $primary-darken-2;
    }

    /* ── Placeholder / empty states ─────────────────────────────────── */
    .placeholder {
        width: 1fr;
        height: 1fr;
        content-align: center middle;
        color: $text-muted;
    }

    /* ── Detail section headers ─────────────────────────────────────── */
    .detail-header {
        text-style: bold;
        color: $accent;
        margin-bottom: 1;
    }

    .detail-label {
        color: $text-muted;
        width: auto;
    }

    /* ── Loading indicator ──────────────────────────────────────────── */
    #loading-indicator {
        content-align: center middle;
        color: $warning;
    }

    /* ── Error banner (overlay) ─────────────────────────────────────── */
    #error-banner {
        layer: overlay;
        dock: bottom;
        display: none;
        width: 1fr;
        height: auto;
        background: $error-darken-2;
        border: round $error;
        padding: 0 2;
    }

    #error-banner.visible {
        display: block;
    }

    /* ── Footer ─────────────────────────────────────────────────────── */
    Footer {
        background: $primary-darken-1;
        color: white;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("r", "refresh_issues_or_replay", "Refresh/Replay"),
        Binding("g", "open_github", "Open GitHub"),
        Binding("s", "start_flow", "Start Flow"),
        Binding("/", "focus_search", "Search"),
    ]



    # Session tracking for context-aware keybindings
    _selected_session_path: str | None = None

    # ── Reactive state ────────────────────────────────────────────────
    active_tab: str = "issues"
    selected_issue_number: int | None = None
    _loading_issues: bool = False
    _selected_labels: list[str] = ["needs-triage", "parent-prd"]
    # Sessions state
    _sessions_loaded: bool = False

    def __init__(self, api_override=None):
        super().__init__()
        self._api_override = api_override  # For testing
        self._dashboard_api = None  # Lazy-initialized DashboardAPI

    @property
    def dashboard_api(self):
        """Lazy-initialized DashboardAPI."""
        if self._api_override is not None:
            return self._api_override
        if self._dashboard_api is None:
            from lib.dashboard_api import DashboardAPI

            self._dashboard_api = DashboardAPI()
        return self._dashboard_api

    # ── Compose ───────────────────────────────────────────────────────
    def compose(self) -> ComposeResult:
        """Build the 6-tab layout with horizontal split."""
        _eprint("[COMPOSE] Starting...")
        yield Header()

        # Filters bar — label filter dropdown
        with Container(id="filters-bar"):
            with Horizontal():
                yield Label("Labels: ")
                yield Select(
                    options=[("needs-triage", "needs-triage"), ("parent-prd", "parent-prd")],
                    prompt="Select labels…",
                    id="label-filter",
                )

        with Horizontal(id="main-split"):
            # ── Left Panel (~65%): Tab content + List View ──────────────
            with Container(id="list-view"):
                with TabbedContent(initial="issues", id="tabs"):
                    # TAB 1: Issues
                    with TabPane("Issues", id="issues"):
                        yield DataTable(id="issue-table")

                    # TAB 2: Sessions
                    with TabPane("Sessions", id="sessions"):
                        yield SessionBrowserPanel(id="session-browser")

                    # TAB 3: Pipelines
                    _sync("[COMPOSE] About to compose PipelineMonitorPanel...")
                    try:
                        with TabPane("Pipelines", id="pipelines"):
                            yield PipelineMonitorPanel(id="pipeline-monitor-panel")
                        _sync("[COMPOSE] PipelineMonitorPanel yielded OK")
                    except Exception as e:
                        _sync(f"[COMPOSE] ERROR in Pipelines tab: {type(e).__name__}: {e}")
                        traceback.print_exc(file=sys.stderr)
                        raise

                    # TAB 4: Chat (stub)
                    with TabPane("Chat", id="chat"):
                        yield Static(
                            "[dim]LLM chat modal overlay — coming in Phase 2[/]",
                            classes="placeholder",
                        )

                    # TAB 5: Logs (stub)
                    with TabPane("Logs", id="logs"):
                        yield Static(
                            "[dim]JSONL log tailing — coming in Phase 2[/]",
                            classes="placeholder",
                        )

                    # TAB 6: Agents (stub)
                    with TabPane("Agents", id="agents"):
                        yield Static(
                            "[dim]Agent roster — coming in Phase 2[/]",
                            classes="placeholder",
                        )

            # ── Right Panel (~35%): Detail View ────────────────────────
            with Vertical(id="detail-panel"):
                yield Label("[bold cyan]Issue Details[/]", id="detail-title")
                yield Static(
                    "[dim]Select an issue from the list to view details.[/]",
                    id="detail-body",
                )

        # Error banner overlay (hidden by default)
        with Container(id="error-banner"):
            yield Label("[bold red]Error loading issues[/]")

        yield Footer()

    # ── Lifecycle ─────────────────────────────────────────────────────
    def on_mount(self) -> None:
        """Fetch initial issue data on mount."""
        _sync("App mounted, fetching issues")
        try:
            self._fetch_issues()
        except Exception as e:
            _sync_err(e)
            raise

    # ── Label filter change ───────────────────────────────────────────
    def on_select_changed(self, message: Select.Changed) -> None:
        """Handle label filter selection — re-fetch issues with new labels."""
        if hasattr(message, "value") and message.value is not None:
            self._selected_labels = [message.value]
            self._fetch_issues()

    # ── Tab switching ─────────────────────────────────────────────────
    def on_tabbed_content_tab_activated(self, message: TabbedContent.TabActivated) -> None:
        """Handle tab activation — update reactive state and detail panel."""
        _sync(f"Tab activated: {message.tab.id}")
        try:
            # Textual prefixes tab IDs with '--content-tab-', strip to get clean ID
            raw_id = message.tab.id
            self.active_tab = raw_id[len("--content-tab-"):] if raw_id.startswith("--content-tab-") else raw_id
            _sync(f"Active tab set to: {self.active_tab}")
            # Clear detail when switching away from issues tab
            if self.active_tab != "issues":
                self.selected_issue_number = None
                self._clear_detail()

            # Issues tab — auto-refresh every 2 seconds while active
            if self.active_tab == "issues":
                if not getattr(self, "_issues_refresh_timer", None):
                    self._issues_refresh_timer = self.set_interval(
                        2.0,
                        self._refresh_issues_periodically,
                        name="issues_auto_refresh"
                    )
            else:
                # Stop timer when switching away from issues tab
                if getattr(self, "_issues_refresh_timer", None):
                    self._issues_refresh_timer.stop()
                    self._issues_refresh_timer = None

            # Load sessions data when switching to Sessions tab
            if self.active_tab == "sessions":
                self._load_sessions()
                # Start auto-refresh every 2 seconds (only while this tab is active)
                if not getattr(self, "_session_refresh_timer", None):
                    self._session_refresh_timer = self.set_interval(
                        2.0,
                        self._refresh_sessions_periodically,
                        name="sessions_auto_refresh"
                    )
            else:
                # Stop timer when switching away from sessions tab
                if getattr(self, "_session_refresh_timer", None):
                    self._session_refresh_timer.stop()
                    self._session_refresh_timer = None
        except Exception as e:
            _sync_err(e)
            raise

    def _format_session_duration(self, duration_seconds: float) -> str:
        """Format duration in seconds to a human-readable string."""
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

    def on_session_selected(self, message: SessionSelected) -> None:
        """Handle session selection — render session details in the right panel.

        Populates the detail panel with flow, phase, verdict, duration,
        file ops timeline, and tracks the session path for modal actions.
        """
        session = message.session_data
        title_widget = self.query_one("#detail-title", Label)
        body_widget = self.query_one("#detail-body", Static)

        # Track session path for modal keybindings
        raw_path = session.get("raw_path", "")
        self._selected_session_path = raw_path if raw_path else None

        issue_num = session.get("issue", "?")
        flow = session.get("flow", "unknown")
        phase = session.get("phase", "unknown")
        model = session.get("model") or "N/A"
        duration = self._format_session_duration(session.get("duration_seconds", 0))
        verdict = session.get("verdict_status") or "pending"
        file_ops_count = session.get("file_ops_count", 0)
        error_count = session.get("error_count", 0)

        # Verdict icon
        if verdict == "approved":
            verdict_icon = "✅ Approved"
        elif verdict == "rejected":
            verdict_icon = "❌ Rejected"
        elif verdict == "no_gaps":
            verdict_icon = "🔍 No Gaps"
        else:
            verdict_icon = f"⏳ {verdict}"

        title_widget.update(f"[bold yellow]Session #{issue_num}[/]")

        # Build file ops timeline from raw_path if available
        file_ops_timeline = self._build_file_ops_timeline(raw_path)

        # Build the complete body text before updating (Static doesn't have .renderable)
        body_parts = [
            f"[dim]Flow:[/dim] {flow}\n",
            f"[dim]Phase:[/dim] {phase}\n",
            f"[dim]Model:[/dim] {model}\n",
            f"[dim]Duration:[/dim] {duration}\n",
            f"[dim]Verdict:[/dim] {verdict_icon}\n\n",
            f"[bold cyan]Linked Issue:[/bold cyan] #{issue_num}\n",
            f"[dim]File ops:[/dim] {file_ops_count}  [dim]Errors:[/dim] {error_count}\n",
            f"[dim]Log file:[/dim] {Path(raw_path).name if raw_path else 'N/A'}\n",
            "\n",
            f"[bold cyan]Actions:[/bold cyan]\n",
            f"  [r] Replay    [f] Files     [l] Raw Logs\n",
        ]

        # Append file ops timeline if we have it
        if file_ops_timeline:
            body_parts.append("\n[bold cyan]File Ops Timeline:[/bold cyan]\n")
            body_parts.append(file_ops_timeline)

        body_widget.update("".join(body_parts))

    def on_data_table_cell_highlighted(self, message: DataTable.CellHighlighted) -> None:
        """Handle cell highlight (click or cursor move) — set selection for [g] keybinding.
        
        Per Textual docs: clicking a cell fires CellHighlighted + CellSelected,
        NOT RowSelected. RowSelected only fires via keyboard navigation (arrow keys → Enter).
        """
        # Only process cells from the issue table
        if getattr(message.data_table, "id", None) != "issue-table":
            return
        
        # cell_key.row_key is a RowKey object — use .value to get the actual string key
        row_value = message.cell_key.row_key.value
        if not row_value:
            return
        
        try:
            self.selected_issue_number = int(row_value)
            with open("/tmp/dashboard_debug.log", "a") as f:
                f.write(f"CellHighlighted: selected #{self.selected_issue_number}\n")
            self._render_issue_detail(self.selected_issue_number)
        except (ValueError, TypeError):
            pass
    
    def on_data_table_cell_selected(self, message: DataTable.CellSelected) -> None:
        """Handle cell selection — same logic as highlighted for click-to-select."""
        if getattr(message.data_table, "id", None) != "issue-table":
            return
        
        # cell_key.row_key is a RowKey object — use .value to get the actual string key
        row_value = message.cell_key.row_key.value
        if not row_value:
            return
        
        try:
            self.selected_issue_number = int(row_value)
            with open("/tmp/dashboard_debug.log", "a") as f:
                f.write(f"CellSelected: selected #{self.selected_issue_number}\n")
            self._render_issue_detail(self.selected_issue_number)
        except (ValueError, TypeError):
            pass
    
    def on_data_table_row_selected(self, message: DataTable.RowSelected) -> None:
        """Handle issue row selection via keyboard — fetch and render details."""
        # Only process rows from the issue table
        if getattr(message.data_table, "id", None) != "issue-table":
            return

        # cell_key.row_key is a RowKey object — use .value to get the actual string key
        row_value = message.row_key.value
        if not row_value:
            return

        try:
            self.selected_issue_number = int(row_value)
            with open("/tmp/dashboard_debug.log", "a") as f:
                f.write(f"RowSelected: selected #{self.selected_issue_number}\n")
            self._render_issue_detail(int(row_value))
        except (ValueError, TypeError):
            pass

    # ── Data fetching ─────────────────────────────────────────────────
    def _fetch_issues(self) -> None:
        """Fetch open issues from GitHub API and populate the DataTable."""
        self._loading_issues = True
        table = self.query_one("#issue-table", DataTable)

        try:
            result = self.dashboard_api.fetch_issues(labels=self._selected_labels)

            if result.success and result.data:
                issues = result.data
                # Add columns (idempotent — safe to call repeatedly)
                table.add_columns("Title", "Labels", "Created")
                table.clear()

                for issue in issues:
                    title = getattr(issue, 'title', str(getattr(issue, 'number', '?')))
                    labels = ", ".join(
                        getattr(issue, 'labels', []) or []
                    ) if hasattr(issue, 'labels') else ""
                    created = getattr(issue, 'created_at', '')[:10] if hasattr(issue, 'created_at') and issue.created_at else ''

                    table.add_row(title, labels, created, key=str(getattr(issue, 'number', '')))

                self._hide_error()
            else:
                # No issues found — clear rows, keep columns
                pass
        except Exception as e:
            _sync(f"ERROR fetching issues: {e}")
            self._show_error(str(e))
        finally:
            self._loading_issues = False

    def _render_issue_detail(self, issue_number: int) -> None:
        """Fetch and render a single issue's details in the right panel."""
        title_widget = self.query_one("#detail-title", Label)
        body_widget = self.query_one("#detail-body", Static)

        try:
            result = self.dashboard_api.fetch_issue(issue_number)

            if result.success and result.data:
                issue = result.data
                title = getattr(issue, 'title', f'#{issue_number}')
                labels = ", ".join(getattr(issue, 'labels', []) or [])
                created = getattr(issue, 'created_at', '')[:10] if hasattr(issue, 'created_at') else ''
                state = getattr(issue, 'state', 'open')

                title_widget.update(f"[bold cyan]#{issue_number}: {title}[/]")
                
                # Fetch linked sessions for this issue
                sessions_text = self._get_linked_sessions_text(issue_number)
                
                body_widget.update(
                    f"[dim]State:[/dim] {state}  |  [dim]Created:[/dim] {created}\n"
                    f"\n[dim]Labels:[/dim]\n{labels or 'None'}\n\n"
                    f"[bold]Body:[/bold]\n"
                    f"{getattr(issue, 'body', '') or '[No body content]'}\n\n"
                    f"[bold cyan]Linked Sessions:[/bold cyan]\n"
                    f"{sessions_text}"
                )
            else:
                title_widget.update(f"[bold red]#{issue_number}: Not Found[/]")
                body_widget.update(f"[dim]Could not load issue details.[/]")
        except Exception as e:
            _sync(f"ERROR fetching issue #{issue_number}: {e}")
            title_widget.update(f"[bold red]#{issue_number}: Error[/]")
            body_widget.update(f"[dim]{str(e)}[/]")

    def _get_linked_sessions_text(self, issue_number: int) -> str:
        """Get formatted text for sessions linked to a specific issue.
        
        Args:
            issue_number: GitHub issue number to find linked sessions for.
            
        Returns:
            Formatted string with session information, or 'No linked sessions' message.
        """
        try:
            result = self.dashboard_api.get_all_sessions()
            if result.success and result.data is not None:
                # Filter sessions by issue number
                linked = [
                    s for s in result.data 
                    if isinstance(s, dict) and s.get("issue") == issue_number
                ]
                
                if not linked:
                    return "[dim]No linked sessions found.[/]"
                
                # Format session list (show up to 5 most recent)
                lines = []
                for session in linked[:5]:
                    flow = session.get("flow", "unknown")
                    phase = session.get("phase", "unknown")
                    model = session.get("model", "N/A") or "N/A"
                    status = session.get("verdict_status", "") or "pending"
                    timestamp = session.get("timestamp_str", "")[:19] if isinstance(session.get("timestamp_str"), str) else "unknown"
                    
                    lines.append(f"  • {flow}/{phase} | {model} | {status} | {timestamp}")
                
                if len(linked) > 5:
                    lines.append(f"  ... and {len(linked) - 5} more")
                
                return "\n".join(lines)
            else:
                return "[dim]Failed to load sessions.[/]"
        except Exception as e:
            _sync(f"WARNING: Error loading linked sessions for #{issue_number}: {e}")
            return "[dim]Error loading sessions.[/]"

    def _build_file_ops_timeline(self, session_path: str) -> str:
        """Build a file operations timeline string from a session log.

        Parses the JSONL file and extracts file operations (tool calls with paths),
        then formats them as a chronological timeline.

        Args:
            session_path: Path to the JSONL session file.

        Returns:
            Formatted timeline string, or empty string if no ops found.
        """
        from lib.session_reader import parse_session_log

        if not session_path or not Path(session_path).exists():
            return ""

        try:
            summary = parse_session_log(session_path)
            file_ops = summary.get("file_operations", [])

            if not file_ops:
                return ""

            lines = []
            for op in file_ops[:10]:  # Show up to 10 ops
                tool = op.get("tool", "?")
                path = op.get("path", "?")
                status = op.get("status", "unknown")
                icon = "✅" if status == "success" else "❌"
                lines.append(f"  {icon} [{tool}] {path}")

            if len(file_ops) > 10:
                lines.append(f"  ... and {len(file_ops) - 10} more")

            return "\n".join(lines)
        except Exception as e:
            _sync(f"WARNING: Error parsing file ops timeline: {e}")
            return ""

    def _clear_detail(self) -> None:
        """Reset the detail panel to empty state."""
        title_widget = self.query_one("#detail-title", Label)
        body_widget = self.query_one("#detail-body", Static)
        title_widget.update("[bold cyan]Issue Details[/]")
        body_widget.update(
            "[dim]Select an issue from the list to view details.[/]"
        )
        # Reset session tracking
        self._selected_session_path = None

    # ── Session data loading ───────────────────────────────────────────
    def _load_sessions(self) -> None:
        """Load session data from DashboardAPI and populate the Sessions tab."""
        try:
            result = self.dashboard_api.get_all_sessions()
            if result.success and result.data is not None:
                # Find the SessionBrowserPanel and update it
                panel = self.query_one("#session-browser", SessionBrowserPanel)
                panel.update_sessions(result.data)
                self._sessions_loaded = True
        except Exception as e:
            _sync(f"ERROR loading sessions: {e}")

    def _refresh_issues_periodically(self) -> None:
        """Periodic refresh for Issues tab (called every 2s while tab is active)."""
        try:
            raw_id = self.active_tab
            if not raw_id.startswith("--content-tab-"):
                return
            current_tab = raw_id[len("--content-tab-"):]
            if current_tab != "issues":
                return
            # Safe to refresh — tab is active, just re-fetch issues
            self._fetch_issues()
        except Exception:
            pass  # Swallow errors during periodic refresh to avoid timer crashes

    def _refresh_sessions_periodically(self) -> None:
        """Periodic refresh for Sessions tab (called every 2s while tab is active)."""
        try:
            raw_id = self.active_tab
            if not raw_id.startswith("--content-tab-"):
                return
            current_tab = raw_id[len("--content-tab-"):]
            if current_tab != "sessions":
                return
            # Safe to refresh — tab is active, just update data without re-triggering full load
            result = self.dashboard_api.get_all_sessions()
            if result.success and result.data is not None:
                panel = self.query_one("#session-browser", SessionBrowserPanel)
                panel.update_sessions(result.data)
        except Exception:
            pass  # Swallow errors during periodic refresh to avoid timer crashes

    # ── Error handling ────────────────────────────────────────────────
    def _show_error(self, message: str) -> None:
        """Show error banner."""
        try:
            banner = self.query_one("#error-banner", Container)
            banner.add_class("visible")
            label = banner.query_one(Label)
            label.update(f"[bold red]Error:[/bold red] {message}")
        except Exception:
            pass

    def _hide_error(self) -> None:
        """Hide error banner."""
        try:
            banner = self.query_one("#error-banner", Container)
            banner.remove_class("visible")
        except Exception:
            pass

    # ── Actions (keybindings) ────────────────────────────────────────
    def action_refresh_issues(self) -> None:
        """Manually refresh issue data."""
        self._fetch_issues()

    def action_refresh_issues_or_replay(self) -> None:
        """Context-aware [r] keybinding.
        
        On issues tab → refresh issues
        On sessions tab with selected session → open replay modal  
        On pipelines tab → trigger manual pipeline panel refresh
        """
        if self.active_tab == "issues":
            self.action_refresh_issues()
        elif self.active_tab == "sessions" and self._selected_session_path:
            self.action_replay_session()
        elif self.active_tab == "pipelines":
            # Trigger a manual refresh on the pipeline panel
            try:
                panel = self.query_one("#pipeline-monitor-panel", PipelineMonitorPanel)
                panel._refresh_data()
            except Exception as e:
                _sync(f"[ACTION] Failed to refresh pipelines: {e}")

    def action_open_github(self) -> None:
        """Open the selected issue in GitHub via `gh issue view <N> --web`."""
        if self.selected_issue_number is not None:
            try:
                import subprocess
                result = subprocess.run(
                    ["gh", "issue", "view", str(self.selected_issue_number), "--web"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode != 0:
                    self.notify(f"Failed to open GitHub: {result.stderr.strip()}", severity="error")
                else:
                    self.notify(f"Opened issue #{self.selected_issue_number} in browser", severity="information")
            except FileNotFoundError:
                self.notify("gh CLI not found — install from https://cli.github.com", severity="warning")
            except subprocess.TimeoutExpired:
                self.notify("GitHub open timed out after 10s", severity="error")
        else:
            self.notify("No issue selected — click a row to select an issue", severity="information")

    # ── Session Modal Keybindings ───────────────────────────────────────

    def action_replay_session(self) -> None:
        """Open the replay modal for the selected session."""
        if not self._selected_session_path:
            self.notify("No session selected — click a session row first", severity="information")
            return

        # Parse the JSONL file to get events for step-through playback
        try:
            from lib.session_reader import parse_session_log
            summary = parse_session_log(self._selected_session_path)
            
            # We need raw events — read them directly from the file
            with open(self._selected_session_path, "r") as f:
                events = []
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass  # Skip malformed lines
        except Exception as e:
            self.notify(f"Failed to load session log: {e}", severity="error")
            return

        if not events:
            self.notify("Session log is empty or could not be parsed", severity="warning")
            return

        # Push the replay modal
        self.push_screen(ReplayModal(self._selected_session_path, events))

    def action_show_session_files(self) -> None:
        """Open the files modal for the selected session."""
        if not self._selected_session_path:
            self.notify("No session selected — click a session row first", severity="information")
            return

        # Extract file operations from the session log
        try:
            from lib.session_reader import parse_session_log
            summary = parse_session_log(self._selected_session_path)
            file_ops = summary.get("file_operations", [])
        except Exception as e:
            self.notify(f"Failed to load session data: {e}", severity="error")
            return

        self.push_screen(SessionFilesModal(self._selected_session_path, file_ops))

    def action_show_raw_logs(self) -> None:
        """Open the raw logs modal for the selected session."""
        if not self._selected_session_path:
            self.notify("No session selected — click a session row first", severity="information")
            return

        self.push_screen(RawLogsModal(self._selected_session_path))

    def action_focus_search(self) -> None:
        """Focus the search input (placeholder — no search yet)."""
        self.notify("Search coming in a future slice", severity="information")

    # ── Dynamic Keybinding Resolution ───────────────────────────────────

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        """Resolve whether a keybinding is available in the current context.

        Returns:
            True  — binding active and clickable
            False — binding hidden entirely
            None  — binding dimmed (available but not actionable)
        """
        # Issue bindings: only active on issues tab with selected issue
        if action == "open_github":
            return self.active_tab == "issues" and self.selected_issue_number is not None
        if action == "start_flow":
            return self.active_tab == "issues" and self.selected_issue_number is not None

        # Always active
        return True

    def on_key(self, event) -> None:
        """Handle raw key presses for context-sensitive session actions.

        When on the Sessions tab with a selected session:
          [f] → Files modal  
          [l] → Raw Logs modal
        (Note: [r] is handled by static binding → refresh_issues_or_replay)
        """
        # Session modals: only when on sessions tab with selected session
        if self.active_tab == "sessions" and self._selected_session_path:
            if event.key in ("f", "F"):
                self.action_show_session_files()
                event.stop()  # Prevent further propagation
                return
            elif event.key in ("l", "L"):
                self.action_show_raw_logs()
                event.stop()
                return

    def action_start_flow(self) -> None:
        """Start a pipeline flow on the selected issue.
        
        Validates that we're on the Issues tab with a selected issue,
        then launches the default flow (builder-reviewer) in a background worker.
        Shows confirmation or error feedback via notify().
        """
        # Guard: must be on issues tab with a selected issue
        if self.active_tab != "issues":
            self.notify("Start Flow is only available on the Issues tab", severity="warning")
            return
        
        if self.selected_issue_number is None:
            self.notify("No issue selected — click or arrow-navigate to select an issue first", severity="information")
            return
        
        # Launch flow in background worker (non-blocking)
        self._launch_flow(self.selected_issue_number)
    
    def _launch_flow(self, issue_number: int) -> None:
        """Launch a pipeline flow on the given issue number.
        
        Runs in a background worker to avoid blocking the UI.
        Uses the default flow from config or falls back to 'builder-reviewer'.
        
        Args:
            issue_number: GitHub issue number to process.
        """
        import subprocess
        from textual import work
        
        @work(exclusive=True, thread=False)
        async def _run_flow() -> None:
            """Background worker that runs the flow and reports result."""
            # Determine default flow — check config first, then fallback
            default_flow = "builder-reviewer"
            try:
                import json as json_mod
                from pathlib import Path
                config_path = Path(__file__).parent / "config.json"
                if config_path.exists():
                    with open(config_path) as f:
                        cfg = json_mod.load(f)
                    # No default_flow in config — use fallback
            except Exception:
                pass
            
            flow_name = default_flow
            
            try:
                # Run the orchestrator in background (non-interactive mode)
                # Use subprocess to avoid blocking the TUI
                result = subprocess.run(
                    [
                        sys.executable, str(Path(__file__).parent / "orchestrate.py"),
                        "--flow", flow_name,
                        "--issue", str(issue_number),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=3600,  # 1 hour max — flows can take a while
                )
                
                if result.returncode == 0:
                    self.post_message(
                        MaestroApp.FlowLaunched(issue_number, flow_name)
                    )
                else:
                    error_msg = (result.stderr or result.stdout)[:200].strip()
                    self.post_message(
                        MaestroApp.FlowFailed(issue_number, flow_name, error_msg)
                    )
            except subprocess.TimeoutExpired:
                self.post_message(
                    MaestroApp.FlowFailed(issue_number, flow_name, "Flow timed out after 1 hour")
                )
            except FileNotFoundError:
                self.post_message(
                    MaestroApp.FlowFailed(
                        issue_number, flow_name,
                        f"orchestrate.py not found at {Path(__file__).parent / 'orchestrate.py'}"
                    )
                )
            except Exception as e:
                self.post_message(
                    MaestroApp.FlowFailed(issue_number, flow_name, str(e)[:200])
                )
        
        # Start the background worker
        _run_flow()
    
    def on_flow_launched(self, message: "MaestroApp.FlowLaunched") -> None:
        """Handle successful flow launch — show confirmation."""
        self.notify(
            f"🚀 Flow '{message.flow}' started for issue #{message.issue_number}",
            severity="information",
            timeout=5,
        )
    
    def on_flow_failed(self, message: "MaestroApp.FlowFailed") -> None:
        """Handle flow launch failure — show error."""
        self.notify(
            f"❌ Flow '{message.flow}' failed for issue #{message.issue_number}: {message.error}",
            severity="error",
            timeout=8,
        )

    class FlowLaunched:
        """Message posted when a flow launch succeeds."""
        def __init__(self, issue_number: int, flow_name: str):
            self.issue_number = issue_number
            self.flow = flow_name

    class FlowFailed:
        """Message posted when a flow launch fails."""
        def __init__(self, issue_number: int, flow_name: str, error: str):
            self.issue_number = issue_number
            self.flow = flow_name
            self.error = error


if __name__ == "__main__":
    # Clear log file on fresh start
    try:
        fd = os.open(str(_DEBUG_LOG), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        from datetime import datetime as _dt
        ts = _dt.now().strftime("%H:%M:%S.%f")[:-3]
        os.write(fd, f"[{ts}] === NEW SESSION ===\n".encode())
        os.close(fd)
    except Exception:
        pass
    
    _sync("Starting MaestroApp...")
    app = MaestroApp()
    try:
        app.run()
    except KeyboardInterrupt:
        _sync("Interrupted by user (Ctrl+C)")
    except SystemExit:
        _sync("System exit")
    except Exception as e:
        _sync_err(e)
        print(f"\n❌ Unhandled exception — see {_DEBUG_LOG} for details", file=sys.stderr)
        raise
