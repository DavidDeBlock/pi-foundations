#!/usr/bin/env python3
"""
ControlBar — Pipeline control widget for Maestro Dashboard.

Layout (bottom-right panel, ~20% of right-side height):
  - Top row: OrchestratorControls (Start / Stop / Pause buttons)
  - Bottom row: AgentInputPanel (text input field for agent hooks)

Pure UI panel — no direct I/O. All data comes through dashboard callbacks.
"""

from textual.widgets import Label, Static
from textual.containers import Vertical, Horizontal

from panels.orchestrator_controls import OrchestratorControls
from panels.agent_input_panel import AgentInputPanel


class ControlBar(Vertical):
    """Bottom-right panel providing pipeline execution controls and agent input."""

    CSS = """
    #control-bar {
        width: 100%;
        height: 1fr;
        layout: vertical;
        padding: 0 1;
    }

    /* Actions row — top of the control bar */
    #actions-row {
        width: 100%;
        margin-bottom: 0.5;
    }

    /* Input row — bottom of the control bar */
    #input-row {
        width: 100%;
        height: auto;
        padding-top: 0.25;
        border-top: solid $secondary;
    }

    /* Info text — optional status line */
    #info-section {
        width: 100%;
        align-horizontal: center;
    }

    #info-text {
        text-align: center;
        color: $text-muted;
        font-style: italic;
        font-size: 0.8;
        width: 100%;
    }
    """

    def __init__(self):
        super().__init__()
        self._orchestrator_controls = None
        self._agent_input = None

    def compose(self):
        """Create child widgets for the control bar."""
        # Actions row — orchestrator buttons (Start / Stop / Pause)
        with Horizontal(id="actions-row"):
            self._orchestrator_controls = OrchestratorControls()
            yield self._orchestrator_controls

        # Input row — agent command input field
        with Vertical(id="input-row"):
            self._agent_input = AgentInputPanel()
            yield self._agent_input

    def set_pipeline_running(self, running: bool) -> None:
        """Update the pipeline status indicator.

        Args:
            running: True if a pipeline is currently executing, False otherwise.
        """
        try:
            if self._orchestrator_controls:
                self._orchestrator_controls.set_pipeline_running(running)
        except Exception:
            pass

    def set_pipeline_paused(self, paused: bool) -> None:
        """Update the pipeline paused state.

        Args:
            paused: True if a pipeline is currently paused.
        """
        try:
            if self._orchestrator_controls:
                self._orchestrator_controls.set_pipeline_paused(paused)
        except Exception:
            pass
