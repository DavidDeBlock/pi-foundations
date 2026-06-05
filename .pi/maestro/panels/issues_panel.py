#!/usr/bin/env python3
"""
IssuesPanel — Interactive GitHub Issues panel with expand/collapse detail.

Pure UI panel that receives data from DashboardAPI and renders it.
No direct I/O - all data comes through the API layer.

Features:
- DataTable showing issue number, title, labels, and age
- Click any row to expand/collapse a detail drawer below the table
- Detail view shows full PRD body, acceptance criteria, and parent-child links
"""

from textual.events import Event
from textual.widgets import DataTable, Label
from textual.containers import Vertical
from datetime import datetime, timezone


class IssueSelected(Event):
    """Emitted when an issue row is selected.

    Attributes:
        issue_number: The GitHub issue number that was selected.
    """
    def __init__(self, issue_number: int) -> None:
        super().__init__()
        self.issue_number = issue_number


class IssuesPanel(Vertical):
    """Left panel showing open GitHub issues with expandable detail views."""

    CSS = '''
    IssuesPanel {
        width: 100%;
        height: 100%;
        border: solid $primary;
        background: $surface;
        padding: 1;
        layout: vertical;
    }

    #issues-title {
        text-align: center;
        width: 100%;
        margin-bottom: 1;
    }

    DataTable#issues-table {
        height: 1fr;
    }

    .error-state {
        text-align: center;
        color: $error;
        padding: 2;
    }
    '''

    def __init__(self):
        super().__init__()
        self.issues_table = None
        self._all_issues: list[dict] = []

    def compose(self):
        """Create child widgets for the issues panel."""
        yield Label("[bold cyan]Open GitHub Issues[/]", id="issues-title")

        table = DataTable(id="issues-table", zebra_stripes=True)
        table.add_columns("#", "Title", "Labels", "Age")
        table.columns_width = [6, 40, 35, 10]
        table.cursor_type = "row"
        self.issues_table = table
        yield table

    def on_mount(self) -> None:
        """Register the row selection handler."""
        if self.issues_table:
            self.issues_table.can_focus = True

    def update_issues(self, issues):
        """Update the panel with a list of Issue objects from DashboardAPI.

        Args:
            issues: List of Issue dataclasses or dicts with number, title,
                    labels, created_at fields.
        """
        if not self.issues_table:
            return

        # Store for later lookup when row is selected
        self._all_issues = [
            self._issue_to_dict(i) for i in issues
        ]

        # Clear and rebuild table
        self.issues_table.clear()

        for issue_data in self._all_issues:
            number = issue_data['number']
            title = issue_data['title']
            labels = issue_data['labels'] or []
            created_at = issue_data.get('created_at')

            age_str = self._calculate_age(created_at) if created_at else "?"
            labels_str = ", ".join(labels[:3]) if isinstance(labels, list) else str(labels)
            if len(labels) > 3:
                labels_str += f" (+{len(labels) - 3})"

            self.issues_table.add_row(
                str(number),
                title,
                labels_str,
                age_str
            )

        # Show error state if no issues found (GitHub unreachable case)
        if not issues:
            pass  # Empty table is fine - could show a "no results" message

    def _issue_to_dict(self, issue) -> dict:
        """Convert an Issue object or dict to a plain dict.

        Args:
            issue: An Issue dataclass instance or dict.

        Returns:
            A plain dict with keys: number, title, labels, created_at,
            body, comments.
        """
        if hasattr(issue, 'number'):
            return {
                "number": issue.number,
                "title": issue.title,
                "labels": getattr(issue, 'labels', []) or [],
                "created_at": getattr(issue, 'created_at', None),
                "body": getattr(issue, 'body', '') or '',
                "comments": getattr(issue, 'comments', []) or [],
            }
        return {
            "number": issue.get('number', '?'),
            "title": issue.get('title', ''),
            "labels": issue.get('labels', []),
            "created_at": issue.get('created_at'),
            "body": issue.get('body', '') or '',
            "comments": issue.get('comments', []) or [],
        }

    def clear_issues(self):
        """Clear all issues from the panel."""
        if self.issues_table:
            self.issues_table.clear()
        self._all_issues = []

    def _calculate_age(self, created_at_str: str) -> str:
        """Calculate human-readable age from ISO timestamp.

        Args:
            created_at_str: ISO 8601 timestamp string (e.g., '2025-05-27T10:30:00Z').

        Returns:
            Human-readable age string like '2h', '3d', '1w'.
        """
        try:
            # Parse ISO format - handle both Z and +00:00 suffixes
            ts = created_at_str.replace('Z', '+00:00')
            created_dt = datetime.fromisoformat(ts)

            now = datetime.now(timezone.utc)
            delta = now - created_dt

            total_seconds = int(delta.total_seconds())

            if total_seconds < 60:
                return f"{total_seconds}s"
            elif total_seconds < 3600:
                minutes = total_seconds // 60
                return f"{minutes}m"
            elif total_seconds < 86400:
                hours = total_seconds // 3600
                return f"{hours}h"
            elif total_seconds < 604800:
                days = total_seconds // 86400
                return f"{days}d"
            else:
                weeks = total_seconds // 604800
                return f"{weeks}w"
        except (ValueError, TypeError):
            return "?"



    def _extract_parent_child(self, body: str) -> dict:
        """Extract parent/child issue references from PRD body.

        Looks for patterns like "#182" or "Parent #182" in the body text.

        Args:
            body: The raw markdown body of an issue.

        Returns:
            Dict with 'parent' (int|None) and 'children' (list[int]) keys.
        """
        import re
        result = {"parent": None, "children": []}

        if not body:
            return result

        # Look for explicit parent references
        parent_match = re.search(r"Parent\s+[#]?(\d+)", body)
        if parent_match:
            result["parent"] = int(parent_match.group(1))

        # Look for child references like "Blocked by #XXX" or "#XXX (child)"
        blocked_matches = re.findall(r"Blocked by\s+[#]?(\d+)", body)
        for match in blocked_matches:
            result["children"].append(int(match))

        # Also look for any parent-prd pattern references
        child_pattern = re.search(
            r"#(\d+)\s*—\s*[A-Z].*(?:Feature|Implementation|Slice)",
            body
        )
        if child_pattern:
            result["children"].append(int(child_pattern.group(1)))

        return result

    def _extract_acceptance_criteria(self, body: str) -> list[dict]:
        """Extract acceptance criteria from PRD body.

        Looks for checklist-style items like "- [ ] criterion" or
        "Acceptance Criteria:" followed by list items.

        Args:
            body: The raw markdown body of an issue.

        Returns:
            List of dicts with 'text' and 'done' keys.
        """
        if not body:
            return []

        import re

        # Find the acceptance criteria section
        ac_match = re.search(
            r"(?:Acceptance\s+Criteria|AC)\s*:\s*\n((?:[-*].*\n?)+)",
            body,
            re.IGNORECASE
        )
        if not ac_match:
            return []

        ac_section = ac_match.group(1)
        criteria = []

        # Parse checklist items: "- [ ] text" or "- [x] text"
        for line in ac_section.split("\n"):
            line = line.strip()
            checked_match = re.match(r"[-*]\s+\[([ xX])\]\s+(.+)", line)
            if checked_match:
                done = checked_match.group(1).lower() == 'x'
                criteria.append({
                    "text": checked_match.group(2),
                    "done": done,
                })

        return criteria

    def _extract_non_acceptance_body(self, body: str) -> str:
        """Extract the PRD body excluding the acceptance criteria section.

        Args:
            body: The raw markdown body of an issue.

        Returns:
            Body text with acceptance criteria section removed.
        """
        if not body:
            return ""

        import re

        # Remove the acceptance criteria section
        cleaned = re.sub(
            r"\n(?:Acceptance\s+Criteria|AC)\s*:\s*\n((?:[-*].*\n?)+)",
            "",
            body,
            flags=re.IGNORECASE
        )
        return cleaned

    def _truncate_body(self, body: str) -> str:
        """Truncate a long body to a reasonable display length.

        Args:
            body: Raw markdown body text.

        Returns:
            Truncated string with ellipsis if too long.
        """
        max_lines = 20
        lines = body.split("\n")
        if len(lines) <= max_lines:
            return "\n".join(lines)
        truncated = "\n".join(lines[:max_lines])
        remaining = len(lines) - max_lines
        return f"{truncated}\n\n... ({remaining} more lines)"

    # ── Event Handlers ───────────────────────────────────────────────────

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle row selection in the issues table.

        Emits an IssueSelected event with the issue number for the dashboard
        to handle (fetch details and render in SharedDetailView).
        """
        if not self.issues_table:
            return

        cursor_row = event.cursor_row
        rows = list(self.issues_table.data.keys())

        if cursor_row < len(rows):
            issue_num_str = self.issues_table.get_cell_at(cursor_row, 0)
            try:
                issue_num = int(issue_num_str)
                # Emit custom event — dashboard handles fetching + rendering
                self.post_message(IssueSelected(issue_number=issue_num))
            except (ValueError, TypeError):
                pass
