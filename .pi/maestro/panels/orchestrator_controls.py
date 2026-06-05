#!/usr/bin/env python3
"""
OrchestratorControls — Pipeline execution control buttons for Maestro Dashboard.

Shows:
  - Start (▶), Stop (⏹), and Pause (⏸) buttons in a horizontal row
  - Button press events are captured and dispatched to the parent dashboard

Pure UI panel — no direct I/O. All data comes through dashboard callbacks.
"""

from textual.widgets import Button, Label
from textual.containers import Horizontal


class OrchestratorControls(Horizontal):
    """Horizontal button row for pipeline execution control."""

    CSS = """
    #orchestrator-controls {
        layout: horizontal;
        align-horizontal: center;
        height: auto;
    }

    Button#btn-start-pipeline {
        width: auto;
        min-width: 24;
        margin-right: 0.5;
    }

    Button#btn-stop-pipeline {
        width: auto;
        min-width: 24;
        margin-left: 0.5;
        margin-right: 0.5;
    }

    Button#btn-pause-resume {
        width: auto;
        min-width: 24;
        margin-left: 0.5;
    }

    /* Label above the buttons */
    #controls-label {
        text-align: center;
        color: $text-accent;
        width: 100%;
        padding-bottom: 0.5;
    }
    """

    def __init__(self):
        super().__init__()
        self._pipeline_running = False
        self._pipeline_paused = False

    def compose(self):
        """Create child widgets for the orchestrator controls."""
        yield Label("Pipeline Execution", id="controls-label")

        with Horizontal(id="orchestrator-controls"):
            yield Button("▶ Start", variant="success", id="btn-start-pipeline")
            yield Button("⏹ Stop", variant="error", id="btn-stop-pipeline")
            yield Button("⏸ Pause", variant="warning", id="btn-pause-resume")

    def set_pipeline_running(self, running: bool) -> None:
        """Update the pipeline running state.

        Args:
            running: True if a pipeline is currently executing (not paused).
        """
        self._pipeline_running = running
        self._update_pause_button()

    def set_pipeline_paused(self, paused: bool) -> None:
        """Update the pipeline paused state.

        Args:
            paused: True if the pipeline is currently paused.
        """
        self._pipeline_paused = paused
        self._update_pause_button()

    def _update_pause_button(self):
        """Update the pause/resume button text based on current state."""
        try:
            btn = self.query_one("#btn-pause-resume", Button)
            if self._pipeline_running and not self._pipeline_paused:
                btn.update("⏸ Pause")
            elif self._pipeline_paused:
                btn.update("▶ Resume")
            else:
                btn.update("⏸ Pause")
        except Exception:
            pass

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle button presses. Dispatches actions to the parent dashboard."""
        btn_id = event.button.id
        if btn_id == "btn-start-pipeline":
            self._on_start()
        elif btn_id == "btn-stop-pipeline":
            self._on_stop()
        elif btn_id == "btn-pause-resume":
            if self._pipeline_paused:
                self._on_resume()
            else:
                self._on_pause()

    def _on_start(self):
        """Handle start pipeline action. Dispatches to parent app."""
        try:
            parent = self.app
            if hasattr(parent, "action_start_pipeline"):
                parent.action_start_pipeline()
        except Exception:
            pass

    def _on_stop(self):
        """Handle stop pipeline action. Dispatches to parent app."""
        try:
            parent = self.app
            if hasattr(parent, "action_stop_pipeline"):
                parent.action_stop_pipeline()
        except Exception:
            pass

    def _on_pause(self):
        """Handle pause pipeline action. Dispatches to parent app."""
        try:
            parent = self.app
            if hasattr(parent, "action_pause_pipeline"):
                parent.action_pause_pipeline()
        except Exception:
            pass

    def _on_resume(self):
        """Handle resume pipeline action. Dispatches to parent app."""
        try:
            parent = self.app
            if hasattr(parent, "action_resume_pipeline"):
                parent.action_resume_pipeline()
        except Exception:
            pass
