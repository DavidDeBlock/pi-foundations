#!/usr/bin/env python3
"""
SessionFilesModal — Show files changed via git status --porcelain matched against session tool call paths.

Opens when user presses `[f]` on a selected session row in the Sessions tab.
Shows:
- Files touched by the session (from JSONL tool calls)
- Current `git status --porcelain` output
- Overlap between the two sets

Usage:
    from panels.session_files_modal import SessionFilesModal
    screen = app.push_screen(SessionFilesModal(session_path, file_ops))
"""

import subprocess
from pathlib import Path
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import (
    Label,
    Static,
)


class SessionFilesModal(ModalScreen):
    """Modal overlay showing file operations and git status correlation.

    Attributes:
        session_path: Path to the JSONL session file.
        file_ops: List of file operation dicts from the session's parsed log.
                  Each dict has keys: tool, path, status, timestamp, error_message.
    """

    BINDINGS = [
        Binding("escape", "dismiss_modal", "Close"),
        Binding("q", "dismiss_modal", "Quit"),
    ]

    CSS = """
    SessionFilesModal {
        align: center middle;
        background: $background 70%;
    }

    #files-container {
        width: 80;
        height: 65%;
        border: round $accent;
        background: $surface-darken-2;
        padding: 1 2;
        layout: vertical;
    }

    #files-title {
        text-align: center;
        text-style: bold;
        color: $accent;
        margin-bottom: 1;
    }

    /* Section headers */
    .section-header {
        text-style: bold;
        margin-top: 1;
        margin-bottom: 0.5;
    }

    #session-files-section, #git-status-section, #overlap-section {
        width: 100%;
    }

    /* File list items */
    .file-line {
        padding-left: 2;
        margin: 0;
    }

    .file-added {
        color: $success;
    }

    .file-modified {
        color: $warning;
    }

    .file-deleted {
        color: $error;
    }

    .file-tool-op {
        color: $primary;
    }

    /* Status indicators */
    #git-status-prefix {
        width: 3;
        text-align: right;
    }

    .status-added { color: $success; }
    .status-modified { color: $warning; }
    .status-deleted { color: $error; }
    .status-renamed { color: $secondary; }
    .status-untracked { color: $text-muted; }

    /* Summary */
    #file-summary {
        margin-top: 1;
        padding: 0.5 1;
        border: solid $secondary;
        background: $surface-darken-3;
    }

    /* No files message */
    .no-files {
        color: $text-muted;
        font-style: italic;
    }
    """

    def __init__(self, session_path: str, file_ops: list[dict] | None = None, **kwargs):
        super().__init__(**kwargs)
        self.session_path = Path(session_path)
        self.file_ops = file_ops or []

    def compose(self) -> ComposeResult:
        """Build the files modal layout."""
        with Horizontal():
            with Vertical(id="files-container"):
                yield Label(
                    f"[bold cyan]Files[/bold cyan] — "
                    f"{self.session_path.name}",
                    id="files-title",
                )

                # Session file operations
                yield Label("[bold yellow]📄 Session File Operations[/]", classes="section-header")
                yield Static("", id="session-files-list")

                # Git status output
                yield Label("[bold blue]🔍 git status --porcelain (current repo)[/]", classes="section-header")
                yield Static("", id="git-status-list")

                # Overlap section
                yield Label("[bold green]✅ Correlated Files[/]", classes="section-header")
                yield Static("", id="overlap-list")

                # Summary
                yield Static("", id="file-summary")

    def on_mount(self) -> None:
        """Render the modal content."""
        self._render_session_files()
        self._render_git_status()
        self._render_overlap()
        self._render_summary()

    def action_dismiss_modal(self) -> None:
        """Close the modal and return focus."""
        self.dismiss(None)

    # ── Rendering ───────────────────────────────────────────────────────

    def _render_session_files(self) -> None:
        """Render file operations extracted from the session log."""
        list_widget = self.query_one("#session-files-list", Static)

        if not self.file_ops:
            list_widget.update("[dim]No file operations recorded in this session.[/]")
            return

        lines = []
        for op in self.file_ops:
            tool = op.get("tool", "?")
            path = op.get("path", "?")
            status_icon = "✅" if op.get("status") == "success" else "❌"
            lines.append(f"{status_icon} [{tool}] {path}")

        list_widget.update("\n".join(lines))

    def _render_git_status(self) -> None:
        """Run `git status --porcelain` and render the output."""
        list_widget = self.query_one("#git-status-list", Static)

        try:
            # Determine repo root — go up from maestro directory
            repo_root = Path(__file__).resolve().parent.parent.parent.parent.parent
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True,
                text=True,
                timeout=10,
                cwd=str(repo_root),
            )

            if result.returncode != 0:
                list_widget.update(f"[dim]Not a git repo or git error:[/dim] {result.stderr.strip()[:200]}")
                return

            output = result.stdout.strip()
            if not output:
                list_widget.update("[dim]Working tree clean — no changes.[/]")
                return

            lines = []
            for line in output.splitlines():
                # git porcelain format: "XY filename" or "XY -> filename" (renamed)
                prefix = line[:2]
                path = line[3:] if len(line) > 3 else ""

                status_class = self._git_status_class(prefix)
                lines.append(f"[{status_class}]{prefix}[/] {path}")

            list_widget.update("\n".join(lines))

        except FileNotFoundError:
            list_widget.update("[dim]git CLI not found.[/]")
        except subprocess.TimeoutExpired:
            list_widget.update("[dim]git status timed out after 10s.[/]")
        except Exception as e:
            list_widget.update(f"[dim]Error running git status:[/dim] {e}")

    def _render_overlap(self) -> None:
        """Show files that appear in both session ops and git status."""
        overlap_widget = self.query_one("#overlap-list", Static)

        # Collect paths from session file operations (normalized)
        session_paths = set()
        for op in self.file_ops:
            path = op.get("path", "")
            if path and path != "unknown":
                # Normalize: remove leading ./ or /, use relative-ish form
                normalized = str(Path(path)).lstrip("./").lstrip("/")
                session_paths.add(normalized)

        # Collect paths from git status output (normalized)
        git_paths = set()
        try:
            repo_root = Path(__file__).resolve().parent.parent.parent.parent.parent
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True,
                text=True,
                timeout=10,
                cwd=str(repo_root),
            )

            if result.returncode == 0:
                for line in (result.stdout or "").splitlines():
                    path = line[3:].strip() if len(line) > 3 else ""
                    if path and not path.startswith("->"):
                        normalized = str(Path(path)).lstrip("./").lstrip("/")
                        git_paths.add(normalized)

        except Exception:
            pass  # If we can't run git, just show session files only

        # Find overlap
        overlapping = session_paths & git_paths

        if not overlapping and not session_paths:
            overlap_widget.update("[dim]No correlation data available.[/]")
            return

        lines = []
        if overlapping:
            for path in sorted(overlapping):
                lines.append(f"  ✅ {path}")
            lines.insert(0, f"[bold green]{len(overlapping)} file(s) matched between session ops and git status[/]\n")
        elif session_paths:
            lines.append("[dim]Session modified files not reflected in current working tree.[/]")
            for path in sorted(session_paths):
                lines.append(f"  • {path} (session only)")

        overlap_widget.update("\n".join(lines))

    def _render_summary(self) -> None:
        """Render a summary of file operations."""
        summary_widget = self.query_one("#file-summary", Static)

        total_ops = len(self.file_ops)
        successful = sum(1 for op in self.file_ops if op.get("status") == "success")
        failed = sum(1 for op in self.file_ops if op.get("status") == "failed")
        unique_paths = len(set(op.get("path", "") for op in self.file_ops if op.get("path")))

        summary_parts = [f"📊 **Summary:** {total_ops} total operation(s), ",
                         f"{successful} successful, {failed} failed"]
        if unique_paths:
            summary_parts.append(f", {unique_paths} unique file(s)")
        summary_widget.update("".join(summary_parts))

    @staticmethod
    def _git_status_class(prefix: str) -> str:
        """Map git status prefix to a CSS class name."""
        first_char = prefix[0] if len(prefix) >= 1 else " "
        second_char = prefix[1] if len(prefix) == 2 else ""

        if second_char == "D" or first_char == "D":
            return "status-deleted"
        elif second_char == "A" or first_char == "A":
            return "status-added"
        elif second_char == "R" or first_char == "R":
            return "status-renamed"
        elif first_char == "?":
            return "status-untracked"
        else:
            return "status-modified"
