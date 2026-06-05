#!/usr/bin/env python3
"""
ReplayModal — Step-through JSONL event playback for a session.

Opens when user presses `[r]` on a selected session row in the Sessions tab.
Shows each JSONL event one-by-one with navigation controls:
- `←` / `→` or `h` / `l` — Navigate prev/next event
- `Home` / `End` / `g` / `G` — Jump to first/last event
- `Space` — Toggle auto-play (auto-advance every 300ms)
- `Esc` / `q` — Close modal

Usage:
    from panels.replay_modal import ReplayModal
    screen = app.push_screen(ReplayModal(session_path, events))
"""

import json
from pathlib import Path
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Center, Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import (
    Button,
    Label,
    Static,
)


class ReplayModal(ModalScreen):
    """Modal overlay for step-through JSONL event playback.

    Attributes:
        session_path: Path to the JSONL session file.
        events: List of parsed JSON dict objects from the session log.
    """

    BINDINGS = [
        Binding("left", "prev_event", "Prev"),
        Binding("right", "next_event", "Next"),
        Binding("h", "prev_event", "Prev"),
        Binding("l", "next_event", "Next"),
        Binding("home", "first_event", "First"),
        Binding("end", "last_event", "Last"),
        Binding("g", "first_event", "First"),
        Binding("G", "last_event", "Last"),
        Binding("space", "toggle_autoplay", "Auto-play"),
        Binding("escape", "dismiss_modal", "Close"),
        Binding("q", "dismiss_modal", "Quit"),
    ]

    CSS = """
    ReplayModal {
        align: center middle;
        background: $background 70%;
    }

    #replay-container {
        width: 80;
        height: 70%;
        border: round $accent;
        background: $surface-darken-2;
        padding: 1 2;
    }

    #replay-title {
        text-align: center;
        text-style: bold;
        color: $accent;
        margin-bottom: 1;
    }

    #event-display {
        width: 100%;
        height: 1fr;
        border: solid $secondary;
        background: $surface-darken-3;
        padding: 1 2;
        overflow-y: auto;
        margin-bottom: 1;
    }

    #event-display .json-key {
        color: $primary;
    }

    #event-display .json-string {
        color: $success;
    }

    #event-display .json-number {
        color: $warning;
    }

    #replay-controls {
        height: 4;
        dock: bottom;
        layout: horizontal;
        align-horizontal: center;
    }

    #btn-prev, #btn-next, #btn-first, #btn-last, #btn-autoplay {
        margin: 0 1;
    }

    #event-counter {
        width: auto;
        color: $text-muted;
        margin: 0 2;
        align: center middle;
    }

    .autoplay-active {
        text-style: bold;
        color: $success;
    }
    """

    def __init__(self, session_path: str, events: list[dict], **kwargs):
        super().__init__(**kwargs)
        self.session_path = Path(session_path)
        self.events = events or []
        self._current_index = 0
        self._autoplaying = False

    def compose(self) -> ComposeResult:
        """Build the replay modal layout."""
        with Center():
            with Vertical(id="replay-container"):
                yield Label(
                    f"[bold cyan]Replay[/bold cyan] — "
                    f"{self.session_path.name} ({len(self.events)} events)",
                    id="replay-title",
                )

                # Event display area
                yield Static(
                    "[dim]Select an event to view details.[/]",
                    id="event-display",
                )

                # Navigation controls
                with Horizontal(id="replay-controls"):
                    yield Button("⏮ First", id="btn-first")
                    yield Label(f"0 / {len(self.events)}", id="event-counter")
                    yield Button("⏭ Last", id="btn-last")
                    yield Button("◀ Prev", id="btn-prev")
                    yield Button("Next ▶", id="btn-next")
                    yield Label("[dim]Auto-play[/]", id="autoplay-label")

    def on_mount(self) -> None:
        """Initialize the display with the first event."""
        self._render_event(0)

    # ── Navigation Actions ──────────────────────────────────────────────

    def action_prev_event(self) -> None:
        """Navigate to the previous event."""
        if self.events and self._current_index > 0:
            self._current_index -= 1
            self._render_event(self._current_index)

    def action_next_event(self) -> None:
        """Navigate to the next event."""
        if self.events and self._current_index < len(self.events) - 1:
            self._current_index += 1
            self._render_event(self._current_index)

    def action_first_event(self) -> None:
        """Jump to the first event."""
        if self.events:
            self._current_index = 0
            self._render_event(0)

    def action_last_event(self) -> None:
        """Jump to the last event."""
        if self.events:
            self._current_index = len(self.events) - 1
            self._render_event(self._current_index)

    def action_toggle_autoplay(self) -> None:
        """Toggle auto-play mode (auto-advance every 300ms)."""
        self._autoplaying = not self._autoplaying
        autoplay_label = self.query_one("#autoplay-label", Label)
        if self._autoplaying:
            autoplay_label.set_class("autoplay-active")
            autoplay_label.update("[bold green]▶ Auto-play[/]")
            # Start auto-advance interval
            self.set_interval(0.3, self._auto_advance)
        else:
            autoplay_label.remove_class("autoplay-active")
            autoplay_label.update("[dim]Auto-play[/]")
            self.clear_interval(self._auto_advance)

    def _auto_advance(self) -> None:
        """Advance to the next event (called by auto-play interval)."""
        if not self.events:
            return
        if self._current_index < len(self.events) - 1:
            self._current_index += 1
            self._render_event(self._current_index)
        else:
            # Reached end — stop autoplay
            self.action_toggle_autoplay()

    def action_dismiss_modal(self) -> None:
        """Close the modal and return focus."""
        if self._autoplaying:
            self.clear_interval(self._auto_advance)
        self.dismiss(None)

    # ── Rendering ───────────────────────────────────────────────────────

    def _render_event(self, index: int) -> None:
        """Render a single JSONL event in the display area.

        Args:
            index: Index of the event to render.
        """
        if not self.events or index < 0 or index >= len(self.events):
            return

        event = self.events[index]
        display = self.query_one("#event-display", Static)

        # Build a formatted representation of the event
        lines = [f"[bold cyan]Event {index + 1} / {len(self.events)}[/]\n"]

        # Show type first (most important field)
        event_type = event.get("type", "unknown")
        timestamp = event.get("timestamp", "")

        if event_type == "message":
            msg = event.get("message", {})
            role = msg.get("role", "?")
            content_parts = msg.get("content", [])

            lines.append(f"[bold]Type:[/bold] {event_type}")
            lines.append(f"[dim]Role:[/dim] {role}")
            if timestamp:
                lines.append(f"[dim]Time:[/dim] {timestamp}")

            # Extract text content
            texts = []
            for part in (content_parts if isinstance(content_parts, list) else []):
                if isinstance(part, dict):
                    part_type = part.get("type", "")
                    if part_type == "text":
                        text = part.get("text", "")
                        if isinstance(text, str):
                            texts.append(text)

            if texts:
                combined_text = "\n".join(texts)
                # Truncate long messages for display
                if len(combined_text) > 2000:
                    combined_text = combined_text[:2000] + "...\n[truncated]"
                lines.append(f"\n[dim]Content:[/dim]\n{combined_text}")

            # Show model info if present
            api_info = msg.get("api", "") or msg.get("provider", "") or ""
            model = msg.get("model", "") or ""
            if api_info:
                lines.append(f"\n[dim]API:[/dim] {msg.get('api', '')} | [dim]Model:[/dim] {model}")

        elif event_type == "toolCall":
            # This might be nested in a message — handle at top level too
            tool_name = event.get("name", "") or event.get("message", {}).get("name", "")
            args = event.get("arguments", {}) or event.get("message", {}).get("arguments", {})
            lines.append(f"[bold]Type:[/bold] {event_type}")
            if tool_name:
                lines.append(f"[dim]Tool:[/dim] {tool_name}")
            if args:
                lines.append(f"[dim]Args:[/dim] {json.dumps(args, default=str)[:500]}")

        elif event_type == "model_change":
            provider = event.get("provider", "")
            model_id = event.get("modelId", "")
            lines.append(f"[bold]Type:[/bold] Model Change")
            if provider:
                lines.append(f"[dim]Provider:[/dim] {provider}")
            if model_id:
                lines.append(f"[dim]Model:[/dim] {model_id}")

        elif event_type == "toolResult":
            tool_call_id = event.get("toolCallId", "") or event.get("parentId", "")
            is_error = event.get("isError", False)
            content = event.get("content", "")
            lines.append(f"[bold]Type:[/bold] {event_type}")
            if tool_call_id:
                lines.append(f"[dim]Tool Call ID:[/dim] {tool_call_id}")
            status = "❌ ERROR" if is_error else "✅ Success"
            lines.append(f"[bold]{status}[/]")
            if content:
                text_content = self._extract_text_from_content(content)
                if len(text_content) > 500:
                    text_content = text_content[:500] + "...\n[truncated]"
                lines.append(f"\n[dim]Content:[/dim]\n{text_content}")

        else:
            # Generic event — show as compact JSON
            lines.append(f"[bold]Type:[/bold] {event_type}")
            if timestamp:
                lines.append(f"[dim]Time:[/dim] {timestamp}")
            # Show a compact representation of remaining fields
            filtered = {k: v for k, v in event.items()
                        if k not in ("type", "timestamp") and v is not None}
            if filtered:
                lines.append(f"\n[dim]Data:[/dim]\n{json.dumps(filtered, default=str, indent=2)[:800]}")

        display.update("\n".join(lines))

        # Update counter
        counter = self.query_one("#event-counter", Label)
        counter.update(f"{index + 1} / {len(self.events)}")

    @staticmethod
    def _extract_text_from_content(content) -> str:
        """Extract plain text from tool result content."""
        if not content:
            return ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            texts = [
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            ]
            return "\n".join(texts)
        return str(content)

    # ── Button Handlers ─────────────────────────────────────────────────

    def on_button_pressed(self, message: Button.Pressed) -> None:
        """Handle button presses for navigation."""
        btn_id = message.button.id
        if btn_id == "btn-prev":
            self.action_prev_event()
        elif btn_id == "btn-next":
            self.action_next_event()
        elif btn_id == "btn-first":
            self.action_first_event()
        elif btn_id == "btn-last":
            self.action_last_event()
        elif btn_id == "btn-autoplay":
            self.action_toggle_autoplay()
