# Maestro Dashboard Panels
# Each panel is a pure UI component - all I/O goes through DashboardAPI

from panels.issues_panel import IssuesPanel
from panels.live_monitor_panel import LiveMonitorPanel
from panels.session_browser_panel import SessionBrowserPanel
from panels.shared_detail_view import SharedDetailView
from panels.control_bar import ControlBar
from panels.orchestrator_controls import OrchestratorControls
from panels.agent_input_panel import AgentInputPanel

__all__ = [
    "IssuesPanel",
    "LiveMonitorPanel",
    "SessionBrowserPanel",
    "SharedDetailView",
    "ControlBar",
    "OrchestratorControls",
    "AgentInputPanel",
]
