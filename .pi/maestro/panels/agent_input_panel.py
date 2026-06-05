#!/usr/bin/env python3
"""
AgentInputPanel — Text input field for future agent hook integration.

Shows:
  - A labeled text Input widget at the bottom-left of the control bar
  - Placeholder handler that logs input for now (stubbed for future use)

Pure UI panel — no direct I/O. All data comes through dashboard callbacks.
"""

from textual.widgets import Input, Label
from textual.containers import Vertical


class AgentInputPanel(Vertical):
    """Text input field container with label for agent command integration."""

    CSS = """
    #agent-input-container {
        layout: vertical;
        height: auto;
        width: 100%;
    }

    #input-label {
        text-align: left;
        color: $text-accent;
        padding-left: 1;
        margin-bottom: 0.5;
    }

    #agent-input-field {
        width: 1fr;
        height: auto;
        padding: 0 1;
    }

    #agent-input-field:focus {
        border: solid $primary;
    }
    """

    def __init__(self):
        super().__init__()
        self._input_widget = None

    def compose(self):
        """Create child widgets for the agent input panel."""
        yield Label("Agent Input →", id="input-label")
        self._input_widget = Input(placeholder="Enter agent command...", id="agent-input-field")
        yield self._input_widget

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle Enter key press in the input field.

        Dispatches the command to the parent dashboard for processing.
        Currently stubbed — logs the command and shows a placeholder response.

        Args:
            event: The Input submission event containing the typed text.
        """
        command = event.value.strip()
        if not command:
            return

        # Stubbed handler — log the input for now
        self._dispatch_command(command)

    def _dispatch_command(self, command: str):
        """Dispatch an agent command to the parent dashboard.

        Args:
            command: The text entered by the user in the input field.
        """
        try:
            parent = self.app
            if hasattr(parent, "action_agent_input"):
                parent.action_agent_input(command)
            else:
                # Fallback: log to the live monitor panel
                if hasattr(parent, "_live_panel") and parent._live_panel:
                    parent._live_panel.update_logs(f"[dim]Agent input stub:[/] {command}")
        except Exception as e:
            print(
                f"[agent-input] ERROR dispatching command '{command}': {e}",
                file=__import__("sys").stderr,
            )
