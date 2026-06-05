#!/usr/bin/env python3
"""
SharedDetailView — Dynamic detail view widget for issues and sessions.

Replaces the old embedded drawers from IssuesPanel and SessionBrowserPanel.
Renders metadata, logs, file operations, and error summaries in a clean layout.

Usage:
    from panels.shared_detail_view import SharedDetailView

    view = SharedDetailView()
    view.populate(issue_data)   # Renders issue detail
    view.populate(session_data) # Renders session detail
"""

from textual.widgets import Static


class SharedDetailView(Static):
    """Detail view widget that renders either an Issue or a Session.

    Detects the item type from ``item_data`` and renders the appropriate
    metadata section. Handles empty states gracefully with a placeholder
    message.
    """

    CSS = """
    SharedDetailView {
        width: 100%;
        /* Height controlled by parent layout (#shared-detail in dashboard) */
        background: $surface-darken-1;
        padding: 1 2;
        overflow-y: auto;
    }

    /* ── Section headers ─────────────────────────────────────────────── */
    .detail-section {
        margin-bottom: 1;
        border-left: double $primary;
        padding-left: 1;
    }

    .section-title {
        text-align: left;
        width: 100%;
        color: $text-muted;
        dock: top;
        margin-bottom: 0.5;
    }

    /* ── Empty state ─────────────────────────────────────────────────── */
    #empty-state {
        text-align: center;
        color: $text-muted;
        padding: 4;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    }

    #empty-state .icon {
        font-size: 3;
        margin-bottom: 1;
    }

    /* ── Issue-specific styling ──────────────────────────────────────── */
    #issue-title {
        color: $text;
        width: 100%;
        text-align: left;
        margin-bottom: 0.5;
    }

    .label-badge {
        background: $boost;
        color: $text;
        padding: 0 1;
        margin-right: 0.5;
        margin-bottom: 0.25;
        height: auto;
    }

    #issue-body {
        width: 100%;
        color: $text;
        text-align: left;
        margin-top: 0.5;
    }

    /* ── Session-specific styling ────────────────────────────────────── */
    .meta-row {
        width: 100%;
        margin-bottom: 0.25;
    }

    .meta-key {
        color: $text-muted;
        width: auto;
    }

    .meta-value {
        color: $text;
        width: auto;
    }

    /* ── File operations timeline ────────────────────────────────────── */
    #file-ops-timeline {
        width: 100%;
        margin-top: 0.5;
    }

    .op-entry {
        color: $text;
        padding-left: 1;
        height: auto;
    }

    /* ── Errors section ──────────────────────────────────────────────── */
    #errors-section {
        width: 100%;
        margin-top: 0.5;
    }

    .error-entry {
        color: $warning;
        padding-left: 1;
        height: auto;
    }

    /* ── Loading state ───────────────────────────────────────────────── */
    #loading-state {
        text-align: center;
        color: $text-muted;
        padding: 4;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
    }
    """

    # ── Public API ───────────────────────────────────────────────────────

    def populate(self, item_data: dict) -> None:
        """Populate the detail view with an Issue or Session.

        Detects the type from ``item_data`` and renders the appropriate
        metadata sections.

        Args:
            item_data: A dict representing either:
                - An **Issue** (keys: number, title, body, labels,
                  created_at, state, assignee).
                - A **Session** (keys: flow, phase, model, duration_seconds,
                  file_ops_count, error_count, timestamp_str, verdict_status,
                  raw_path).

        Examples:
            >>> view.populate({
            ...     "type": "issue",
            ...     "number": 42,
            ...     "title": "Fix login bug",
            ...     "body": "Users can't log in...",
            ...     "labels": ["bug", "critical"],
            ... })

            >>> view.populate({
            ...     "type": "session",
            ...     "flow": "builder-reviewer",
            ...     "phase": "builder",
            ...     "model": "qwen-27b",
            ...     "duration_seconds": 180.5,
            ... })
        """
        # Clear current content
        self.remove_children()

        item_type = item_data.get("type", "")

        if not item_data:
            self._render_empty_state()
            return

        if item_type == "issue":
            self._render_issue(item_data)
        elif item_type == "session":
            self._render_session(item_data)
        else:
            # Unknown type — fall back to empty state with a hint
            self._render_empty_state(hint=f"Unknown item type: {item_type!r}")

    def clear(self) -> None:
        """Clear the detail view and return to the empty state."""
        self.remove_children()
        self._render_empty_state()

    # ── Rendering helpers ────────────────────────────────────────────────

    def _render_empty_state(self, hint: str = "") -> None:
        """Render the placeholder when no item is selected.

        Args:
            hint: Optional extra text shown below the default message.
        """
        self.mount(Static(
            f"[dim]Select an item to view details[/]\n\n"
            f"Click on a row in Issues or Sessions to see details here.",
            id="empty-state",
        ))

    def _render_issue(self, data: dict) -> None:
        """Render issue detail sections.

        Args:
            data: Issue dict with keys like number, title, body, labels,
                  created_at, state, assignee.
        """
        # ── Title row ─────────────────────────────────────────────────────
        issue_num = data.get("number", "?")
        title = data.get("title", "Untitled Issue")

        self.mount(Static(
            f"[bold cyan]#{issue_num}[/] {title}",
            id="issue-title",
            classes="detail-section",
        ))

        # ── Status / assignee / created row ───────────────────────────────
        status = data.get("state", "open").capitalize()
        assignee = data.get("assignee", "")
        created_at = self._format_timestamp(data.get("created_at", ""))

        meta_parts: list[str] = [f"Status: **[bold]{status}[/]**"]
        if assignee:
            meta_parts.append(f"Assignee: {assignee}")
        if created_at:
            meta_parts.append(f"Created: {created_at}")

        self.mount(Static(
            f"[dim]{' | '.join(meta_parts)}[/]",
            id="issue-meta",
        ))

        # ── Labels row ────────────────────────────────────────────────────
        labels = data.get("labels", []) or []
        if isinstance(labels, list) and labels:
            label_spans = " ".join(
                f"[bold]#{label}[/]" for label in labels[:10]
            )
            self.mount(Static(label_spans, id="issue-labels"))

        # ── Body (truncated) ─────────────────────────────────────────────
        body = data.get("body", "") or ""
        if body:
            preview = body[:500] + ("..." if len(body) > 500 else "")
            self.mount(Static(
                f"[dim]{preview}[/]",
                classes="detail-section",
                id="issue-body",
            ))

    def _render_session(self, data: dict) -> None:
        """Render session detail sections.

        Args:
            data: Session dict with keys like flow, phase, model,
                  duration_seconds, file_ops_count, error_count,
                  timestamp_str, verdict_status.  Also accepts enriched
                  dicts containing parsed ``file_operations`` and ``errors``
                  lists from session_reader.
        """
        # ── Metadata section ──────────────────────────────────────────────
        meta_lines = []

        issue_num = data.get("issue")
        if issue_num:
            meta_lines.append(f"[dim]Issue:[/] [bold cyan]#{issue_num}[/]")

        if data.get("flow"):
            meta_lines.append(
                f"[dim]Flow:[/] [bold]{data['flow']}[/]"
            )
        if data.get("phase"):
            meta_lines.append(
                f"[dim]Phase:[/] {data['phase']}"
            )
        if data.get("model"):
            model_str = str(data["model"])[:60]
            meta_lines.append(f"[dim]Model:[/] {model_str}")

        duration = self._format_duration(data.get("duration_seconds", 0))
        meta_lines.append(f"[dim]Duration:[/] {duration}")

        verdict = data.get("verdict_status")
        if verdict:
            icon_map = {"approved": "✅", "rejected": "❌", "error": "⚠️"}
            icon = icon_map.get(verdict, "➖")
            meta_lines.append(f"[dim]Verdict:[/] {icon} **{verdict}**")

        timestamp = self._format_timestamp(data.get("timestamp_str", ""))
        if timestamp:
            meta_lines.append(f"[dim]Timestamp:[/] {timestamp}")

        raw_path = data.get("raw_path", "")
        if raw_path:
            # Truncate long paths for display
            short_path = raw_path
            if len(short_path) > 80:
                short_path = "..." + short_path[-75:]
            meta_lines.append(f"[dim]Log path:[/] `{short_path}`")

        self.mount(Static("\n".join(meta_lines), id="session-meta"))

        # ── File operations timeline ──────────────────────────────────────
        file_ops = data.get("file_operations", [])
        if file_ops:
            lines = ["[bold]📋 File Operations[/]"]
            for op in file_ops[:30]:  # Cap at 30 entries
                status_icon = "✅" if op.get("status") == "success" else "❌"
                tool = (op.get("tool", "?") or "?").upper()
                path = op.get("path", "unknown")
                lines.append(f"  {status_icon} [{tool}] {path}")
            if len(file_ops) > 30:
                lines.append(f"  [dim]... and {len(file_ops) - 30} more[/]")
            self.mount(Static("\n".join(lines), classes="detail-section", id="file-ops-timeline"))
        else:
            ops_count = data.get("file_ops_count", 0)
            if ops_count > 0:
                self.mount(Static(
                    f"[bold]File Operations:[/] {ops_count}",
                    classes="detail-section",
                    id="file-ops-summary",
                ))
            else:
                self.mount(Static("[dim]No file operations recorded.[/]", id="file-ops-empty"))

        # ── Errors section ────────────────────────────────────────────────
        errors = data.get("errors", [])
        if errors:
            lines = ["[bold red]⚠️ Errors[/]"]
            for err in errors[:15]:  # Cap at 15 entries
                err_type = err.get("type", "unknown") or "unknown"
                msg = (err.get("message", "") or "")[:120]
                lines.append(f"  - [{err_type}] {msg}")
            if len(errors) > 15:
                lines.append(f"  [dim]... and {len(errors) - 15} more[/]")
            self.mount(Static("\n".join(lines), classes="detail-section", id="errors-section"))
        else:
            err_count = data.get("error_count", 0)
            if err_count > 0:
                self.mount(Static(
                    f"[bold warning]Errors:[/] {err_count}",
                    classes="detail-section",
                    id="errors-summary",
                ))
            else:
                self.mount(Static("[dim]No errors recorded.[/]", id="errors-empty"))

    # ── Formatting utilities ─────────────────────────────────────────────

    @staticmethod
    def _format_duration(seconds: float) -> str:
        """Format seconds into a human-readable duration string.

        Args:
            seconds: Duration in seconds.

        Returns:
            Formatted string like "2m 30s" or "1h 5m".
        """
        if not seconds:
            return "?"
        mins = int(seconds) // 60
        secs = int(seconds) % 60
        if mins >= 60:
            hours = mins // 60
            remaining_mins = mins % 60
            return f"{hours}h {remaining_mins}m"
        elif mins > 0:
            return f"{mins}m {secs}s"
        else:
            return f"{secs}s"

    @staticmethod
    def _format_timestamp(ts_str: str) -> str:
        """Format an ISO timestamp string into a human-readable form.

        Args:
            ts_str: ISO 8601 timestamp (e.g., '2025-05-27T10:30:00Z').

        Returns:
            Human-readable date/time or empty string if invalid.
        """
        from datetime import datetime, timezone

        if not ts_str:
            return ""

        try:
            # Handle both Z and +00:00 suffixes
            cleaned = ts_str.replace("Z", "+00:00")
            dt = datetime.fromisoformat(cleaned)
            now = datetime.now(timezone.utc)
            delta = now - dt

            total_seconds = int(delta.total_seconds())

            if total_seconds < 60:
                return f"{total_seconds}s ago"
            elif total_seconds < 3600:
                minutes = total_seconds // 60
                return f"{minutes}m ago"
            elif total_seconds < 86400:
                hours = total_seconds // 3600
                return f"{hours}h ago"
            elif total_seconds < 604800:
                days = total_seconds // 86400
                return f"{days}d ago"
            else:
                # Older than a week — show the date
                return dt.strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            return ts_str if len(ts_str) <= 16 else ""
