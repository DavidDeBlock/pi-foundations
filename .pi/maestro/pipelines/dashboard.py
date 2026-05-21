#!/usr/bin/env python3
"""
dashboard.py — Live terminal updates for pipeline execution.

Provides:
- Progress bar with percentage complete during execution (in-place via carriage returns)
- Current phase name and active issue number displayed prominently
- Event log that updates in-place using carriage returns to show recent pipeline events
- Final scorecard summary table showing per-issue pass/fail status

Usage:
    dashboard = PipelineDashboard(term=term)
    dashboard.print_header("autonomous")
    dashboard.update_progress(5, total=10)
    dashboard.set_current_phase("builder-reviewer")
    dashboard.set_active_issue(42)
    dashboard.log_event("Issue #42: builder approved", "success")
    dashboard.print_scorecard("autonomous")
"""

import sys


# ANSI color codes (mirrors terminal.py for consistency)
CYAN = "\033[0;36m"
GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
RED = "\033[0;31m"
MAGENTA = "\033[0;35m"
BLUE = "\033[0;34m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


class PipelineDashboard:
    """Live terminal view for pipeline execution progress.

    Provides real-time in-place updates using carriage returns (\\r) so the
    dashboard stays compact and readable during long-running pipelines.

    Attributes:
        term: Terminal instance for output (injected at init).
        total_steps: Total number of steps in the pipeline run.
        completed_steps: Number of successfully completed steps.
        failed_steps: Number of failed steps.
        current_phase: Name of the currently executing phase.
        active_issue: GitHub issue number currently being processed.
        event_log: List of recent events for the in-place log display.
        issue_results: Dict mapping issue numbers to their pass/fail status.
    """

    # Maximum number of events kept in the rolling log buffer
    MAX_LOG_EVENTS = 8

    def __init__(self, term=None):
        """Initialize PipelineDashboard.

        Args:
            term: Terminal instance for output (optional).
        """
        self.term = term
        self.total_steps = 0
        self.completed_steps = 0
        self.failed_steps = 0
        self.current_phase = ""
        self.active_issue = None
        self.event_log: list[dict] = []
        self.issue_results: dict[int, str] = {}

    # ── Progress Tracking (in-place via carriage returns) ────────────────

    def update_progress(self, completed: int, total: int) -> None:
        """Update the progress counter and redraw the bar in-place.

        Uses carriage return (\\r) to overwrite the previous line so the
        terminal view stays compact during execution.

        Args:
            completed: Number of steps completed so far.
            total: Total number of steps in this pipeline run.
        """
        self.total_steps = total
        self.completed_steps = completed

        if self.term:
            # Delegate to the Terminal's existing progress method for consistent
            # styling, but also draw our own in-place bar below it.
            self._draw_progress_bar(completed, total)

    def _draw_progress_bar(self, completed: int, total: int) -> None:
        """Draw a compact progress bar using carriage returns.

        Format example (30-char bar):
           Progress: [████████░░░░░░░░░░░░░░░░░░] 42% (5/12)

        Args:
            completed: Number of steps completed so far.
            total: Total number of steps in this pipeline run.
        """
        if total <= 0:
            return

        pct = min(100, int((completed / total) * 100))
        bar_len = 30
        filled = int(bar_len * completed / total)
        bar = "█" * filled + "░" * (bar_len - filled)

        # Use carriage return to overwrite the previous line in-place
        sys.stderr.write(f"\r{DIM}Progress: [{bar}] {pct}% ({completed}/{total}){RESET}")
        sys.stderr.flush()

    # ── Phase & Issue Display ────────────────────────────────────────────

    def set_current_phase(self, phase_name: str) -> None:
        """Set and display the currently executing phase name.

        Called whenever the pipeline moves to a new phase (e.g., "builder",
        "reviewer", "prd-audit"). The phase name is shown prominently in
        both the progress bar line and the event log header.

        Args:
            phase_name: Name of the current phase.
        """
        self.current_phase = phase_name

    def set_active_issue(self, issue_num: int) -> None:
        """Set and display the currently active GitHub issue number.

        Called whenever the pipeline starts processing a new issue. The
        issue number is shown alongside the phase name for context.

        Args:
            issue_num: GitHub issue number being processed.
        """
        self.active_issue = issue_num

    def _status_line(self) -> str:
        """Build the compact status line shown above the progress bar.

        Format example:
           ⚡ Phase: builder-reviewer | Issue #42

        Returns:
            Formatted status string for display.
        """
        parts = []

        if self.current_phase:
            parts.append(f"{BOLD}Phase:{RESET} {self.current_phase}")

        if self.active_issue is not None:
            parts.append(f"{BOLD}Issue#{RESET} {self.active_issue}")

        if parts:
            return f"\r{DIM}⚡ {' | '.join(parts)}{RESET}"
        return ""

    # ── Event Logging (in-place via carriage returns) ────────────────────

    def log_event(self, message: str, event_type: str = "info") -> None:
        """Log an event and update the in-place event log.

        Maintains a rolling buffer of recent events displayed using carriage
        returns so the terminal view stays compact. Events are color-coded:
        green for success, red for failure, yellow for warnings.

        Args:
            message: Event description to display.
            event_type: One of "success", "failure", "warning", or "info".
        """
        # Add to rolling buffer (drop oldest if full)
        self.event_log.append({
            "message": message,
            "type": event_type,
        })

        if len(self.event_log) > self.MAX_LOG_EVENTS:
            self.event_log = self.event_log[-self.MAX_LOG_EVENTS:]

        # Redraw the entire status + progress + log area in-place
        self._redraw_dashboard()

    def _event_color(self, event_type: str) -> str:
        """Return ANSI color code for an event type.

        Args:
            event_type: One of "success", "failure", "warning", or "info".

        Returns:
            ANSI color code string.
        """
        colors = {
            "success": GREEN,
            "failure": RED,
            "warning": YELLOW,
            "info": BLUE,
        }
        return colors.get(event_type, DIM)

    def _redraw_dashboard(self) -> None:
        """Redraw the full dashboard area using carriage returns.

        Draws:
          1. Status line (phase + issue)
          2. Progress bar with percentage
          3. Event log buffer (last N events)

        All drawn on consecutive lines starting from the current cursor,
        using \\r to overwrite previous content.
        """
        # Build all lines that make up the dashboard snapshot
        lines = []

        # Status line
        status = self._status_line()
        if status:
            lines.append(status)

        # Progress bar (only if we have a total)
        if self.total_steps > 0:
            pct = min(100, int((self.completed_steps / self.total_steps) * 100))
            bar_len = 30
            filled = int(bar_len * self.completed_steps / self.total_steps)
            bar = "█" * filled + "░" * (bar_len - filled)
            lines.append(
                f"{DIM}Progress: [{bar}] {pct}% ({self.completed_steps}/{self.total_steps}){RESET}"
            )

        # Event log buffer
        if self.event_log:
            for i, event in enumerate(self.event_log):
                color = self._event_color(event["type"])
                prefix = {"success": "✓", "failure": "✗", "warning": "⚠", "info": "•"}
                icon = prefix.get(event["type"], "•")
                lines.append(f"{color}  {icon} {event['message']}{RESET}")

        # Write all lines using carriage returns to overwrite previous state
        for line in lines:
            sys.stderr.write(f"\r{line}\n")
        sys.stderr.flush()

    # ── Step Recording (legacy compatibility) ────────────────────────────

    def record_step(self, step_name: str, success: bool, details: str = "") -> None:
        """Record a pipeline step result.

        Legacy method for backward compatibility with existing code that
        calls dashboard.record_step(). Delegates to log_event() internally.

        Args:
            step_name: Name/identifier of the step.
            success: Whether the step succeeded.
            details: Optional detail message for failures.
        """
        if success:
            self.completed_steps += 1
            event_msg = f"[pipeline] {step_name}"
            if self.term:
                self.term.phase_approved(event_msg)
            # Also log to the in-place event log
            self.log_event(f"{step_name} approved", "success")
        else:
            self.failed_steps += 1
            msg = f"{step_name}: {details}" if details else step_name
            event_msg = f"[pipeline] {msg}"
            if self.term:
                self.term.failure(event_msg)
            # Also log to the in-place event log
            self.log_event(f"{step_name} failed", "failure")

    # ── Scorecard Display (per-issue pass/fail table) ────────────────────

    def print_scorecard(self, pipeline_name: str) -> None:
        """Print the final execution scorecard.

        Displays a clean summary table with per-issue results and overall
        success/failure counts. Uses carriage returns to clear any in-place
        dashboard content before printing the static scorecard.

        Also delegates to self.term.summary() for backward compatibility
        with existing code that expects the legacy summary output.

        Format example:
           ╔══════════════════════════════════════╗
           ║  Pipeline Scorecard: autonomous      ║
           ╠══════════════════════════════════════╣
           ║  Issues Completed:   7               ║
           ║  Issues Failed:      2               ║
           ║  Total Steps:       15               ║
           ╚══════════════════════════════════════╝

           ┌──────────┬───────────────┬──────────┐
           │ Issue #  │ Phase         │ Status   │
           ├──────────┼───────────────┼──────────┤
           │    42    │ builder       │ ✓ PASS   │
           │    43    │ reviewer      │ ✗ FAIL   │
           └──────────┴───────────────┴──────────┘

        Args:
            pipeline_name: Name of the pipeline that just ran.
        """
        # Clear any in-place dashboard content with blank lines
        sys.stderr.write("\r\n" * (len(self.event_log) + 2))
        sys.stderr.flush()

        if self.term:
            # Delegate to terminal's summary for backward compatibility
            self.term.summary(
                issues_completed=self.completed_steps,
                issues_failed=self.failed_steps
            )
            # Also print the enhanced scorecard table
            self._print_scorecard_table(pipeline_name)

    def _print_scorecard_table(self, pipeline_name: str) -> None:
        """Print the formatted scorecard table to stderr.

        Args:
            pipeline_name: Name of the pipeline that just ran.
        """
        total = self.completed_steps + self.failed_steps

        # ── Summary box ────────────────────────────────────────────────
        border_top = "╔" + "═" * 42 + "╗"
        border_bottom = "╚" + "═" * 42 + "╝"
        mid_border = "╠" + "═" * 42 + "╣"

        title_row = f"║{self._center_text(f'Pipeline Scorecard: {pipeline_name}', 40)}║"
        completed_row = f"║{self._pad_right(f'Issues Completed:', 20)} {str(self.completed_steps).rjust(18)}║"
        failed_row = f"║{self._pad_right(f'Issues Failed:', 20)} {str(self.failed_steps).rjust(18)}║"
        total_row = f"║{self._pad_right(f'Total Steps:', 20)} {str(total).rjust(18)}║"

        print(border_top, file=sys.stderr)
        print(title_row, file=sys.stderr)
        print(mid_border, file=sys.stderr)
        print(completed_row, file=sys.stderr)
        print(failed_row, file=sys.stderr)
        print(total_row, file=sys.stderr)
        print(border_bottom, file=sys.stderr)

        # ── Per-issue results table (if we have issue-level data) ───────
        if self.issue_results:
            print("", file=sys.stderr)
            self._print_issue_table()

        # ── Overall verdict ────────────────────────────────────────────
        if self.failed_steps == 0 and total > 0:
            verdict = f"{GREEN}{BOLD}✅ All {total} issue(s) completed successfully!{RESET}"
        elif total > 0:
            verdict = (
                f"{YELLOW}{BOLD}⚠️  Completed with {self.failed_steps} failure(s){RESET}\n"
                f"   {self.completed_steps} succeeded, {self.failed_steps} failed"
            )
        else:
            verdict = f"{DIM}No issues were processed.{RESET}"

        print(f"\n{verdict}", file=sys.stderr)
        print(border_top, file=sys.stderr)

    def _print_issue_table(self) -> None:
        """Print the per-issue results table."""
        # Table dimensions
        issue_col = 12
        phase_col = 18
        status_col = 10
        total_width = issue_col + phase_col + status_col + 6  # padding + separators

        top_border = "┌" + "─" * total_width + "┐"
        header_sep = "├" + "─" * total_width + "┤"
        bottom_border = "└" + "─" * total_width + "┘"

        # Header row
        header = (
            f"│{self._center_text('Issue #', issue_col)}"
            f"{self._center_text('Phase', phase_col)}"
            f"{self._center_text('Status', status_col)}│"
        )
        print(top_border, file=sys.stderr)
        print(header, file=sys.stderr)
        print(header_sep, file=sys.stderr)

        # Data rows (sorted by issue number)
        for issue_num in sorted(self.issue_results.keys()):
            status = self.issue_results[issue_num]
            if status == "pass":
                color = GREEN
                icon = "✓ PASS"
            elif status == "fail":
                color = RED
                icon = "✗ FAIL"
            else:
                color = DIM
                icon = f"? {status}"

            row = (
                f"{DIM}│{RESET}{self._center_text(str(issue_num), issue_col)}"
                f"{color}{self._center_text(icon, status_col)}{RESET}"
                f"{' ' * (phase_col - 2)}│"
            )
            print(row, file=sys.stderr)

        print(bottom_border, file=sys.stderr)

    # ── Header Display ───────────────────────────────────────────────────

    def print_header(self, pipeline_name: str) -> None:
        """Print the pipeline execution header.

        Args:
            pipeline_name: Name of the pipeline being executed.
        """
        if self.term:
            self.term.heading(f"[pipeline] {pipeline_name}")

    # ── Utility Methods ──────────────────────────────────────────────────

    @staticmethod
    def _pad_right(text: str, width: int) -> str:
        """Pad text to the right with spaces up to width.

        Args:
            text: Text to pad.
            width: Target width.

        Returns:
            Padded string.
        """
        return text.ljust(width)

    @staticmethod
    def _center_text(text: str, width: int) -> str:
        """Center text within a field of given width.

        Args:
            text: Text to center.
            width: Target width.

        Returns:
            Centered string.
        """
        padding = max(0, width - len(text))
        left_pad = padding // 2
        right_pad = padding - left_pad
        return " " * left_pad + text + " " * right_pad

    # ── Issue-Level Result Tracking ──────────────────────────────────────

    def record_issue_result(self, issue_num: int, success: bool) -> None:
        """Record the final pass/fail result for a specific issue.

        Used by the pipeline runner to track per-issue outcomes so they can
        be displayed in the scorecard table at the end of execution.

        Args:
            issue_num: GitHub issue number.
            success: True if the issue was processed successfully, False otherwise.
        """
        self.issue_results[issue_num] = "pass" if success else "fail"

    def clear(self) -> None:
        """Reset all dashboard state to initial values.

        Call this between pipeline runs to start fresh.
        """
        self.total_steps = 0
        self.completed_steps = 0
        self.failed_steps = 0
        self.current_phase = ""
        self.active_issue = None
        self.event_log.clear()
        self.issue_results.clear()
