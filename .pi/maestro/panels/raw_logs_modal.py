#!/usr/bin/env python3
"""
RawLogsModal — Display unstructured log output from a session JSONL file.

Opens when user presses `[l]` on a selected session row in the Sessions tab.
Shows raw, unformatted JSONL content with syntax highlighting for keys/values.
Supports searching/filtering within the modal.

Usage:
    from panels.raw_logs_modal import RawLogsModal
    screen = app.push_screen(RawLogsModal(session_path))
"""

import json
from pathlib import Path
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import (
    Input,
    Label,
    Static,
)


class RawLogsModal(ModalScreen):
    """Modal overlay displaying raw JSONL session log output.

    Attributes:
        session_path: Path to the JSONL session file.
        max_lines: Maximum number of lines to display (defaults to 500 for performance).
    """

    BINDINGS = [
        Binding("escape", "dismiss_modal", "Close"),
        Binding("q", "dismiss_modal", "Quit"),
    ]

    CSS = """
    RawLogsModal {
        align: center middle;
        background: $background 70%;
    }

    #logs-container {
        width: 85;
        height: 75%;
        border: round $accent;
        background: $surface-darken-2;
        padding: 1 2;
        layout: vertical;
    }

    #logs-title {
        text-align: center;
        text-style: bold;
        color: $accent;
        margin-bottom: 0.5;
    }

    /* Search bar */
    #search-bar {
        height: 3;
        margin-bottom: 0.5;
        layout: horizontal;
        align-horizontal: center;
    }

    #search-input {
        width: 60%;
    }

    #search-info {
        color: $text-muted;
        align: center middle;
        padding-left: 2;
    }

    /* Raw log display */
    #raw-logs-display {
        width: 100%;
        height: 1fr;
        border: solid $secondary;
        background: $surface-darken-3;
        padding: 1 2;
        overflow-y: auto;
        font-family: monospace;
    }

    /* Syntax highlighting classes */
    .json-key {
        color: $primary;
    }

    .json-string {
        color: $success;
    }

    .json-number {
        color: $warning;
    }

    .json-boolean {
        color: $info;
    }

    .json-null {
        color: $text-muted;
        font-style: italic;
    }

    /* Line number */
    #line-counter {
        height: 2;
        dock: bottom;
        text-align: center;
        color: $text-muted;
    }

    .no-logs {
        content-align: center middle;
        width: 100%;
        height: 1fr;
        color: $text-muted;
    }
    """

    def __init__(self, session_path: str, max_lines: int = 500, **kwargs):
        super().__init__(**kwargs)
        self.session_path = Path(session_path)
        self.max_lines = max_lines
        self._raw_lines: list[str] = []
        self._filtered_lines: list[tuple[int, str]] = []  # (original_index, line)
        self._search_term: str = ""

    def compose(self) -> ComposeResult:
        """Build the raw logs modal layout."""
        with Horizontal():
            with Vertical(id="logs-container"):
                yield Label(
                    f"[bold cyan]Raw Logs[/bold cyan] — "
                    f"{self.session_path.name}",
                    id="logs-title",
                )

                # Search bar
                with Horizontal(id="search-bar"):
                    yield Input(placeholder="Search logs... [/]", id="search-input")
                    yield Label("", id="search-info")

                # Raw log display area
                yield Static("[dim]Loading session log...[/]", id="raw-logs-display")

                # Line counter
                yield Label("", id="line-counter")

    def on_mount(self) -> None:
        """Load and render the raw JSONL file."""
        self._load_raw_logs()

    # ── Loading ─────────────────────────────────────────────────────────

    def _load_raw_logs(self) -> None:
        """Read the JSONL file and store raw lines for display."""
        if not self.session_path.exists():
            display = self.query_one("#raw-logs-display", Static)
            display.update(f"[bold red]File not found:[/bold red] {self.session_path}")
            return

        try:
            with open(self.session_path, "r") as f:
                # Read up to max_lines to avoid memory issues with large files
                self._raw_lines = []
                for i, line in enumerate(f):
                    if i >= self.max_lines:
                        break
                    stripped = line.rstrip("\n\r")
                    if stripped:  # Skip empty lines
                        self._raw_lines.append(stripped)

            self._apply_search()

        except Exception as e:
            display = self.query_one("#raw-logs-display", Static)
            display.update(f"[bold red]Error reading file:[/bold red] {e}")

    # ── Search ──────────────────────────────────────────────────────────

    def on_input_submitted(self, message: Input.Submitted) -> None:
        """Handle search input submission."""
        self._search_term = message.value.strip().lower()
        self._apply_search()

    def _apply_search(self) -> None:
        """Filter raw lines based on the current search term."""
        if not self._raw_lines:
            return

        if not self._search_term:
            # No filter — show all lines with original indices
            self._filtered_lines = list(enumerate(self._raw_lines))
        else:
            # Filter lines that contain the search term (case-insensitive)
            self._filtered_lines = [
                (i, line) for i, line in enumerate(self._raw_lines)
                if self._search_term in line.lower()
            ]

        self._render_filtered_logs()

    def _render_filtered_logs(self) -> None:
        """Render the filtered log lines with syntax highlighting."""
        display = self.query_one("#raw-logs-display", Static)
        counter = self.query_one("#line-counter", Label)

        if not self._filtered_lines:
            display.update("[dim]No matching lines found.[/]")
            counter.update("")
            return

        # Build formatted output with syntax highlighting
        parts = []
        for orig_idx, line in self._filtered_lines:
            highlighted = self._syntax_highlight(line)
            line_num = orig_idx + 1
            parts.append(f"[dim]{line_num:>6}[/] {highlighted}")

        display.update("\n".join(parts))

        # Update counter
        total = len(self._raw_lines)
        shown = len(self._filtered_lines)
        if self._search_term:
            counter.update(f"Showing {shown} of {total} lines (matched: '{self._search_term}')")
        else:
            suffix = f" (showing up to {self.max_lines})" if total > self.max_lines else ""
            counter.update(f"{total} line(s){suffix}")

    @staticmethod
    def _syntax_highlight(line: str) -> str:
        """Apply basic JSON syntax highlighting to a raw JSON string.

        Returns an ANSI-formatted string with Textual markup for keys, strings, numbers.
        """
        # Simple approach: find key-value pairs and wrap in markup
        try:
            obj = json.loads(line)
            return RawLogsModal._format_json(obj)
        except (json.JSONDecodeError, ValueError):
            # Not valid JSON — show as-is with dim prefix
            return f"[dim]⚠ malformed[/] {line}"

    @classmethod
    def _format_json(cls, obj, indent: int = 0) -> str:
        """Recursively format a parsed JSON object with syntax highlighting markup."""
        space = "  " * indent
        inner_space = "  " * (indent + 1)

        if isinstance(obj, dict):
            if not obj:
                return "{}"
            parts = []
            for key, value in obj.items():
                formatted_value = cls._format_json(value, indent + 1)
                parts.append(f"{inner_space}[bold cyan]{key}[/]: {formatted_value}")
            return "{\n" + "\n".join(parts) + f"\n{space}}}"

        elif isinstance(obj, list):
            if not obj:
                return "[]"
            parts = []
            for item in obj:
                formatted_item = cls._format_json(item, indent + 1)
                parts.append(f"{inner_space}{formatted_item}")
            return "[\n" + "\n".join(parts) + f"\n{space}]"

        elif isinstance(obj, str):
            # Escape any existing Textual markup in the string value
            escaped = obj.replace("[", "\\[").replace("]", "\\]")
            return f'[dim]"{escaped}"[/]'

        elif isinstance(obj, bool):
            return f"[bold magenta]{str(obj).lower()}[/]"

        elif isinstance(obj, (int, float)):
            return f"[yellow]{obj}[/]"

        elif obj is None:
            return "[italic dim]null[/]"

        else:
            return str(obj)

    # ── Actions ─────────────────────────────────────────────────────────

    def action_dismiss_modal(self) -> None:
        """Close the modal and return focus."""
        self.dismiss(None)
