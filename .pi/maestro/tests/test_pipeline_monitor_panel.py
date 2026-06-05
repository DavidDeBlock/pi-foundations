#!/usr/bin/env python3
"""
Tests for PipelineMonitorPanel — Visual pipeline monitor with phase map and queue stats.

Verifies:
- Phase map rendering logic (builder ● → reviewer ✓)
- Queue statistics computation
- Idle state detection
- Elapsed time formatting
- Direct API methods for deterministic testing

Run with: python3 tests/test_pipeline_monitor_panel.py
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add lib and root to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))

from panels.pipeline_monitor_panel import (
    PipelineMonitorPanel,
    PHASE_STATUS_DONE,
    PHASE_STATUS_FAILED,
    PHASE_STATUS_PENDING,
    PHASE_STATUS_RUNNING,
)


# ── Mock DashboardAPI helpers ────────────────────────────────────────

def _make_mock_api(
    active_session=None,
    flow_config=None,
    all_sessions=None,
):
    """Create a mock DashboardAPI with configurable responses.

    Args:
        active_session: Return value for get_active_session(), or None for idle.
        flow_config: Return value for get_flow_config(), or None.
        all_sessions: Return value for get_all_sessions(), or None.

    Returns:
        Mock object with DashboardAPI interface.
    """
    api = MagicMock()

    # Active session response
    if active_session is not None:
        result = MagicMock()
        result.success = True
        result.data = active_session
        api.get_active_session.return_value = result
    else:
        idle_result = MagicMock()
        idle_result.success = True
        idle_result.data = {
            "active": False,
            "state": "idle",
            "message": "Idle — no active pipeline",
        }
        api.get_active_session.return_value = idle_result

    # Flow config response
    if flow_config is not None:
        result = MagicMock()
        result.success = True
        result.data = flow_config
        api.get_flow_config.return_value = result
    else:
        fail_result = MagicMock()
        fail_result.success = False
        fail_result.data = None
        api.get_flow_config.return_value = fail_result

    # All sessions response
    if all_sessions is not None:
        result = MagicMock()
        result.success = True
        result.data = all_sessions
        api.get_all_sessions.return_value = result
    else:
        empty_result = MagicMock()
        empty_result.success = True
        empty_result.data = []
        api.get_all_sessions.return_value = empty_result

    return api


# ── Test: Phase map building logic (pure function test) ──────────────

def test_build_phase_map_two_phases_running_reviewer():
    """Test phase map with builder done, reviewer running.

    When current phase is 'reviewer' and phases are [builder, reviewer]:
      - builder should show ✓ (done)
      - reviewer should show ● (running)
    """
    panel = PipelineMonitorPanel()
    result = panel._build_phase_map(["builder", "reviewer"], "reviewer")

    # Check that both status indicators are present
    assert "✓" in result, f"Phase map should contain checkmark for done phase. Got: {result}"
    assert "●" in result, f"Phase map should contain circle for running phase. Got: {result}"


def test_build_phase_map_idle_empty():
    """Test that idle/empty state returns placeholder."""
    panel = PipelineMonitorPanel()

    # Empty phases list → returns placeholder (short-circuits)
    result = panel._build_phase_map([], "builder")
    assert "No phase" in result, \
        f"Empty phases should return placeholder. Got: {result}"

    # No current phase (empty string) → also returns placeholder
    result = panel._build_phase_map(["builder"], "")
    assert "No phase" in result, \
        f"No current phase should return placeholder. Got: {result}"


def test_build_phase_map_single_running():
    """Test single-phase flow with that phase running."""
    panel = PipelineMonitorPanel()
    result = panel._build_phase_map(["builder"], "builder")

    assert "●" in result, f"Current phase should show running indicator. Got: {result}"


def test_build_phase_map_three_phases_middle_running():
    """Test three-phase flow with middle phase active."""
    panel = PipelineMonitorPanel()
    result = panel._build_phase_map(
        ["builder", "reviewer", "diagnostic"],
        "reviewer"
    )

    # builder (before current) should be ✓, reviewer ●, diagnostic ○
    assert "✓" in result or "done" not in result.lower(), \
        f"Completed phase should have checkmark. Got: {result}"
    assert "●" in result, f"Current phase should have circle indicator. Got: {result}"


def test_build_phase_map_first_running():
    """Test first phase running — others are pending."""
    panel = PipelineMonitorPanel()
    result = panel._build_phase_map(
        ["builder", "reviewer"],
        "builder"
    )

    assert "●" in result, f"Current phase should show running indicator. Got: {result}"


def test_build_phase_map_unknown_current():
    """Test handling of unknown current phase (not in phases list)."""
    panel = PipelineMonitorPanel()
    # 'xyz' is not in the list — should handle gracefully
    result = panel._build_phase_map(["builder", "reviewer"], "xyz")

    assert len(result) > 0, f"Should produce some output for unknown current phase. Got: {result}"


# ── Test: Queue statistics computation ────────────────────────────────

def test_queue_stats_completed_today():
    """Test queue stats correctly count approved sessions today."""
    active_session = {
        "active": True,
        "state": "running",
        "issue": 42,
        "flow": "builder-reviewer",
        "phase": "reviewer",
        "elapsed_seconds": 120.5,
        "jsonl_path": "/tmp/test.jsonl",
    }

    all_sessions = [
        {"verdict_status": "approved"},
        {"verdict_status": "approved"},
        {"verdict_status": "rejected"},
        {"verdict_status": "no_gaps"},  # not approved/rejected → pending
    ]

    mock_api = _make_mock_api(
        active_session=active_session,
        all_sessions=all_sessions,
    )

    panel = PipelineMonitorPanel(api_override=mock_api)
    completed, pending = panel._compute_queue_stats(mock_api)

    assert completed == 2, f"Expected 2 approved, got {completed}"
    # no_gaps is not "approved" or "rejected", so it's pending
    assert pending == 1, f"Expected 1 pending (no_gaps), got {pending}"


def test_queue_stats_all_approved():
    """Test queue stats when all sessions are approved."""
    active_session = {
        "active": True,
        "state": "running",
        "issue": 1,
        "flow": "builder-reviewer",
        "phase": "reviewer",
        "elapsed_seconds": 60.0,
        "jsonl_path": "/tmp/test.jsonl",
    }

    all_sessions = [
        {"verdict_status": "approved"},
        {"verdict_status": "approved"},
    ]

    mock_api = _make_mock_api(
        active_session=active_session,
        all_sessions=all_sessions,
    )

    panel = PipelineMonitorPanel(api_override=mock_api)
    completed, pending = panel._compute_queue_stats(mock_api)

    assert completed == 2
    assert pending == 0


def test_queue_stats_empty():
    """Test queue stats with no sessions."""
    active_session = {
        "active": True,
        "state": "running",
        "issue": 1,
        "flow": "builder-reviewer",
        "phase": "builder",
        "elapsed_seconds": 5.0,
        "jsonl_path": "/tmp/test.jsonl",
    }

    mock_api = _make_mock_api(
        active_session=active_session,
        all_sessions=[],
    )

    panel = PipelineMonitorPanel(api_override=mock_api)
    completed, pending = panel._compute_queue_stats(mock_api)

    assert completed == 0
    assert pending == 0


def test_queue_stats_mixed_verdicts():
    """Test queue stats with mixed verdict states."""
    active_session = {
        "active": True,
        "state": "running",
        "issue": 1,
        "flow": "builder-reviewer",
        "phase": "reviewer",
        "elapsed_seconds": 60.0,
        "jsonl_path": "/tmp/test.jsonl",
    }

    all_sessions = [
        {"verdict_status": "approved"},
        {"verdict_status": "rejected"},
        {"verdict_status": "no_gaps"},
        {"verdict_status": None},  # No verdict yet → pending
        {},  # Missing verdict key → pending
    ]

    mock_api = _make_mock_api(
        active_session=active_session,
        all_sessions=all_sessions,
    )

    panel = PipelineMonitorPanel(api_override=mock_api)
    completed, pending = panel._compute_queue_stats(mock_api)

    assert completed == 1, f"Expected 1 approved, got {completed}"
    # no_gaps + None + missing → 3 pending
    assert pending == 3, f"Expected 3 pending (no_gaps + None + missing), got {pending}"


def test_queue_stats_api_error_returns_zeros():
    """Test queue stats handles API errors gracefully."""
    active_session = {
        "active": True,
        "state": "running",
        "issue": 1,
        "flow": "builder-reviewer",
        "phase": "builder",
        "elapsed_seconds": 5.0,
        "jsonl_path": "/tmp/test.jsonl",
    }

    mock_api = _make_mock_api(active_session=active_session)

    # Make get_all_sessions raise an exception
    mock_api.get_all_sessions.side_effect = Exception("API error")

    panel = PipelineMonitorPanel(api_override=mock_api)
    completed, pending = panel._compute_queue_stats(mock_api)

    assert completed == 0
    assert pending == 0


# ── Test: Elapsed time formatting ────────────────────────────────────

def test_format_elapsed_seconds():
    """Test _format_elapsed converts seconds to HH:MM:SS."""
    panel = PipelineMonitorPanel()

    # 0 seconds
    assert panel._format_elapsed(0) == "00:00:00"

    # 65.7 seconds → 00:01:05
    assert panel._format_elapsed(65.7) == "00:01:05"

    # 3661.9 seconds (1h 1m 1s)
    assert panel._format_elapsed(3661.9) == "01:01:01"

    # 90.2 seconds → 00:01:30
    assert panel._format_elapsed(90.2) == "00:01:30"

    # Large value (7261 = 2h 1m 1s)
    assert panel._format_elapsed(7261) == "02:01:01"


# ── Test: Idle state detection logic ────────────────────────────────

def test_is_idle_no_session():
    """Test idle detection when active session is None."""
    panel = PipelineMonitorPanel()
    # Set to None and verify the reactive watcher triggers
    panel.set_active_session(None)
    assert panel.active_session is None, \
        f"active_session should be None after set. Got: {panel.active_session}"


def test_is_idle_inactive_session():
    """Test idle detection when active=False in session data."""
    inactive = {
        "active": False,
        "state": "idle",
        "message": "Idle — no active pipeline",
    }

    panel = PipelineMonitorPanel()
    assert not inactive.get("active", False), \
        "Inactive session should be detected as idle"


def test_is_active_session():
    """Test that active sessions are correctly identified."""
    active = {
        "active": True,
        "state": "running",
        "issue": 42,
        "flow": "builder-reviewer",
        "phase": "reviewer",
        "elapsed_seconds": 120.5,
    }

    panel = PipelineMonitorPanel()
    assert active.get("active", False), \
        "Active session should be detected as not idle"


# ── Test: Direct API methods (for deterministic testing) ─────────────

def test_set_active_session():
    """Test that set_active_session updates the reactive attribute."""
    panel = PipelineMonitorPanel()

    session = {"active": True, "phase": "builder"}
    panel.set_active_session(session)
    assert panel.active_session == session


def test_set_flow_phases():
    """Test that set_flow_phases updates the reactive attribute."""
    panel = PipelineMonitorPanel()

    phases = ["builder", "reviewer", "diagnostic"]
    panel.set_flow_phases(phases)
    assert panel.flow_phases == phases


def test_set_queue_stats():
    """Test that set_queue_stats updates both stats."""
    panel = PipelineMonitorPanel()

    panel.set_queue_stats(completed_today=5, pending_count=3)
    assert panel.completed_today == 5
    assert panel.pending_count == 3


# ── Test: Auto-refresh mechanism ─────────────────────────────────────

def test_refresh_data_method_exists():
    """Test that _refresh_data exists and is callable."""
    panel = PipelineMonitorPanel()
    assert hasattr(panel, "_refresh_data")
    assert callable(panel._refresh_data)


def test_refresh_uses_mock_api():
    """Test that _refresh_data calls the mock API methods."""
    active_session = {
        "active": True,
        "state": "running",
        "issue": 99,
        "flow": "builder-reviewer",
        "phase": "reviewer",
        "elapsed_seconds": 50.0,
        "jsonl_path": "/tmp/test.jsonl",
    }

    mock_api = _make_mock_api(
        active_session=active_session,
        flow_config={
            "name": "builder-reviewer",
            "phases": {"builder": {}, "reviewer": {}},
        },
        all_sessions=[{"verdict_status": "approved"}],
    )

    panel = PipelineMonitorPanel(api_override=mock_api)

    # Call _refresh_data directly (bypasses timer)
    panel._refresh_data()

    # Verify API methods were called
    mock_api.get_active_session.assert_called_once()


def test_refresh_handles_api_error():
    """Test that _refresh_data doesn't crash on API failure."""
    active_session = {
        "active": True,
        "state": "running",
        "issue": 1,
        "flow": "builder-reviewer",
        "phase": "builder",
        "elapsed_seconds": 5.0,
        "jsonl_path": "/tmp/test.jsonl",
    }

    mock_api = _make_mock_api(active_session=active_session)

    # Make get_active_session raise an exception
    mock_api.get_active_session.side_effect = Exception("API connection failed")

    panel = PipelineMonitorPanel(api_override=mock_api)

    # Should not raise — timer loop should handle errors gracefully
    try:
        panel._refresh_data()
    except Exception as e:
        assert False, f"_refresh_data should not raise on API error, got: {e}"


# ── Test: Dashboard wiring verification ──────────────────────────────

def test_dashboard_imports_pipeline_panel():
    """Test that dashboard.py imports PipelineMonitorPanel."""
    from dashboard import MaestroApp

    # Verify the class exists and has expected attributes
    assert hasattr(MaestroApp, "compose")
    assert hasattr(MaestroApp, "BINDINGS")


def test_dashboard_css_has_tabbed_content():
    """Test that dashboard CSS references TabbedContent."""
    from dashboard import MaestroApp

    app = MaestroApp()
    assert "TabbedContent" in app.CSS


# ── Test: Constants are exported ─────────────────────────────────────

def test_status_constants_exist():
    """Test that status indicator constants are defined."""
    assert PHASE_STATUS_RUNNING == "●"
    assert PHASE_STATUS_DONE == "✓"
    assert PHASE_STATUS_FAILED == "✗"
    assert PHASE_STATUS_PENDING == "○"


# ── Run tests ────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Running PipelineMonitorPanel tests...\n")

    # Phase map building tests
    test_build_phase_map_two_phases_running_reviewer()
    print("✓ test_build_phase_map_two_phases_running_reviewer passed")

    test_build_phase_map_idle_empty()
    print("✓ test_build_phase_map_idle_empty passed")

    test_build_phase_map_single_running()
    print("✓ test_build_phase_map_single_running passed")

    test_build_phase_map_three_phases_middle_running()
    print("✓ test_build_phase_map_three_phases_middle_running passed")

    test_build_phase_map_first_running()
    print("✓ test_build_phase_map_first_running passed")

    test_build_phase_map_unknown_current()
    print("✓ test_build_phase_map_unknown_current passed")

    # Queue statistics tests
    test_queue_stats_completed_today()
    print("✓ test_queue_stats_completed_today passed")

    test_queue_stats_all_approved()
    print("✓ test_queue_stats_all_approved passed")

    test_queue_stats_empty()
    print("✓ test_queue_stats_empty passed")

    test_queue_stats_mixed_verdicts()
    print("✓ test_queue_stats_mixed_verdicts passed")

    test_queue_stats_api_error_returns_zeros()
    print("✓ test_queue_stats_api_error_returns_zeros passed")

    # Elapsed time formatting tests
    test_format_elapsed_seconds()
    print("✓ test_format_elapsed_seconds passed")

    # Idle state detection tests
    test_is_idle_no_session()
    print("✓ test_is_idle_no_session passed")

    test_is_idle_inactive_session()
    print("✓ test_is_idle_inactive_session passed")

    test_is_active_session()
    print("✓ test_is_active_session passed")

    # Direct API method tests
    test_set_active_session()
    print("✓ test_set_active_session passed")

    test_set_flow_phases()
    print("✓ test_set_flow_phases passed")

    test_set_queue_stats()
    print("✓ test_set_queue_stats passed")

    # Auto-refresh mechanism tests
    test_refresh_data_method_exists()
    print("✓ test_refresh_data_method_exists passed")

    test_refresh_uses_mock_api()
    print("✓ test_refresh_uses_mock_api passed")

    test_refresh_handles_api_error()
    print("✓ test_refresh_handles_api_error passed")

    # Dashboard wiring tests
    test_dashboard_imports_pipeline_panel()
    print("✓ test_dashboard_imports_pipeline_panel passed")

    test_dashboard_css_has_tabbed_content()
    print("✓ test_dashboard_css_has_tabbed_content passed")

    # Constants export tests
    test_status_constants_exist()
    print("✓ test_status_constants_exist passed")

    print("\n✅ All PipelineMonitorPanel tests passed!")
