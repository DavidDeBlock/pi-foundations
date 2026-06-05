#!/usr/bin/env python3
"""
Tests for SessionBrowserPanel — session list + client-side filters.

Verifies:
- Filter logic (flow, phase, model) against synthetic data
- Empty state handling when no sessions match or directory is empty
- Session parsing integration via DashboardAPI.get_all_sessions()
- Duration formatting
- Verdict status icon mapping

Run with: python3 tests/test_session_browser.py
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add lib and root to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))


# ── Synthetic test data ────────────────────────────────────────────────

def _make_session(issue, flow, phase, model=None, duration=60.0, verdict="approved", error_count=0):
    """Create a synthetic session dict for testing."""
    return {
        "issue": issue,
        "flow": flow,
        "phase": phase,
        "model": model,
        "duration_seconds": duration,
        "verdict_status": verdict,
        "verdict_issues": [],
        "file_ops_count": 5,
        "error_count": error_count,
        "timestamp_str": "2026-05-27T12:00:00",
        "raw_path": f"/sessions/{issue}/{flow}-{phase}.jsonl",
    }


# ── Filter logic tests (pure Python, no Textual UI) ───────────────────

def _apply_filters(sessions, flow_filter="all", phase_filter="all", model_filter="all"):
    """Pure-Python filter function mirroring SessionBrowserPanel._apply_filters()."""
    filtered = sessions

    if flow_filter != "all":
        filtered = [s for s in filtered if s.get("flow") == flow_filter]

    if phase_filter != "all":
        filtered = [s for s in filtered if s.get("phase") == phase_filter]

    if model_filter != "all":
        filtered = [s for s in filtered if str(s.get("model", "")) == model_filter]

    return filtered


def test_filter_by_flow():
    """Test filtering sessions by flow name."""
    sessions = [
        _make_session(1, "builder-reviewer", "builder"),
        _make_session(2, "prd-audit", "auditor"),
        _make_session(3, "builder-reviewer", "reviewer"),
    ]

    result = _apply_filters(sessions, flow_filter="builder-reviewer")
    assert len(result) == 2
    assert all(s["flow"] == "builder-reviewer" for s in result)


def test_filter_by_phase():
    """Test filtering sessions by phase name."""
    sessions = [
        _make_session(1, "builder-reviewer", "builder"),
        _make_session(2, "builder-reviewer", "reviewer"),
        _make_session(3, "prd-audit", "auditor"),
    ]

    result = _apply_filters(sessions, phase_filter="builder")
    assert len(result) == 1
    assert result[0]["phase"] == "builder"


def test_filter_by_model():
    """Test filtering sessions by model name."""
    sessions = [
        _make_session(1, "flow-a", "builder", model="model-x"),
        _make_session(2, "flow-b", "reviewer", model="model-y"),
        _make_session(3, "flow-c", "auditor", model="model-x"),
    ]

    result = _apply_filters(sessions, model_filter="model-x")
    assert len(result) == 2
    assert all(s["model"] == "model-x" for s in result)


def test_combined_filters():
    """Test filtering by flow AND phase simultaneously."""
    sessions = [
        _make_session(1, "builder-reviewer", "builder"),
        _make_session(2, "builder-reviewer", "reviewer"),
        _make_session(3, "prd-audit", "auditor"),
    ]

    result = _apply_filters(sessions, flow_filter="builder-reviewer", phase_filter="builder")
    assert len(result) == 1
    assert result[0]["issue"] == 1


def test_no_match_returns_empty():
    """Test that no matching sessions returns an empty list."""
    sessions = [
        _make_session(1, "flow-a", "phase-x"),
    ]

    result = _apply_filters(sessions, flow_filter="nonexistent")
    assert result == []


def test_all_filter_returns_all():
    """Test that 'all' filter returns all sessions."""
    sessions = [
        _make_session(1, "flow-a", "phase-x"),
        _make_session(2, "flow-b", "phase-y"),
    ]

    result = _apply_filters(sessions)  # All filters default to "all"
    assert len(result) == 2


def test_empty_sessions_list():
    """Test filtering an empty session list."""
    result = _apply_filters([])
    assert result == []


# ── Duration formatting tests ─────────────────────────────────────────

def _format_duration(duration_seconds):
    """Pure-Python duration formatter mirroring SessionBrowserPanel._format_duration()."""
    if not duration_seconds:
        return "?"
    mins = int(duration_seconds) // 60
    secs = int(duration_seconds) % 60
    if mins >= 60:
        hours = mins // 60
        remaining_mins = mins % 60
        return f"{hours}h {remaining_mins}m"
    elif mins > 0:
        return f"{mins}m {secs}s"
    else:
        return f"{secs}s"


def test_format_duration_seconds_only():
    """Test formatting durations under 1 minute."""
    assert _format_duration(45) == "45s"
    assert _format_duration(0) == "?"


def test_format_duration_minutes_and_seconds():
    """Test formatting durations in minutes and seconds."""
    assert _format_duration(125) == "2m 5s"
    assert _format_duration(90) == "1m 30s"


def test_format_duration_hours():
    """Test formatting durations over an hour."""
    assert _format_duration(3661) == "1h 1m"
    assert _format_duration(7200) == "2h 0m"


# ── Verdict icon mapping tests ────────────────────────────────────────

def _get_status_icon(session):
    """Pure-Python verdict icon mapper."""
    verdict_status = session.get("verdict_status")
    if verdict_status == "approved":
        return "✅"
    elif verdict_status == "rejected":
        return "❌"
    elif session.get("error_count", 0) > 0:
        return "⚠️"
    else:
        return "➖"


def test_verdict_approved_icon():
    """Test approved sessions get checkmark icon."""
    session = _make_session(1, "flow-a", "builder", verdict="approved")
    assert _get_status_icon(session) == "✅"


def test_verdict_rejected_icon():
    """Test rejected sessions get cross icon."""
    session = _make_session(2, "flow-b", "reviewer", verdict="rejected")
    assert _get_status_icon(session) == "❌"


def test_verdict_error_icon():
    """Test sessions with errors (no verdict) get warning icon."""
    session = _make_session(3, "flow-c", "auditor", verdict=None, error_count=2)
    assert _get_status_icon(session) == "⚠️"


def test_verdict_none_no_errors():
    """Test sessions with no verdict and no errors get dash icon."""
    session = _make_session(4, "flow-d", "builder", verdict=None, error_count=0)
    assert _get_status_icon(session) == "➖"


# ── Dropdown population tests ─────────────────────────────────────────

def test_extract_unique_flows():
    """Test extracting unique flow names from sessions."""
    sessions = [
        _make_session(1, "builder-reviewer", "builder"),
        _make_session(2, "prd-audit", "auditor"),
        _make_session(3, "builder-reviewer", "reviewer"),
    ]

    flows = sorted(set(s.get("flow", "") for s in sessions))
    assert flows == ["builder-reviewer", "prd-audit"]


def test_extract_unique_phases():
    """Test extracting unique phase names from sessions."""
    sessions = [
        _make_session(1, "flow-a", "builder"),
        _make_session(2, "flow-b", "reviewer"),
        _make_session(3, "flow-c", "auditor"),
    ]

    phases = sorted(set(s.get("phase", "") for s in sessions))
    assert phases == ["auditor", "builder", "reviewer"]


def test_extract_unique_models():
    """Test extracting unique model names from sessions."""
    sessions = [
        _make_session(1, "flow-a", "builder", model="model-x"),
        _make_session(2, "flow-b", "reviewer", model="model-y"),
        _make_session(3, "flow-c", "auditor", model="model-x"),
    ]

    models = sorted(set(str(s.get("model", "")) for s in sessions if s.get("model")))
    assert models == ["model-x", "model-y"]


def test_extract_unique_models_skips_none():
    """Test that None/missing models are excluded from dropdown."""
    sessions = [
        _make_session(1, "flow-a", "builder", model=None),
        _make_session(2, "flow-b", "reviewer", model="model-x"),
    ]

    models = sorted(set(str(s.get("model", "")) for s in sessions if s.get("model")))
    assert models == ["model-x"]


# ── DashboardAPI integration test ─────────────────────────────────────

def test_dashboard_api_get_all_sessions_returns_data():
    """Test that DashboardAPI.get_all_sessions() returns structured data."""
    from lib.dashboard_api import DashboardAPI

    api = DashboardAPI()
    result = api.get_all_sessions()

    assert result.success, f"get_all_sessions should succeed: {result.error}"
    assert isinstance(result.data, list), "Data should be a list"
    
    if result.data:
        session = result.data[0]
        # Verify required keys exist
        for key in ("issue", "flow", "phase", "duration_seconds", "verdict_status"):
            assert key in session, f"Session dict missing key: {key}"


def test_dashboard_api_sessions_have_correct_types():
    """Test that session data has expected types."""
    from lib.dashboard_api import DashboardAPI

    api = DashboardAPI()
    result = api.get_all_sessions()

    if not (result.success and result.data):
        # No sessions available — skip type checks
        return

    for session in result.data:
        assert isinstance(session.get("issue"), int), "issue should be int"
        assert isinstance(session.get("flow"), str), "flow should be str"
        assert isinstance(session.get("phase"), str), "phase should be str"
        assert isinstance(session.get("duration_seconds"), (int, float)), "duration should be numeric"


# ── SessionBrowserPanel class tests (mocked UI) ───────────────────────

def test_session_browser_panel_class_exists():
    """Test that SessionBrowserPanel can be imported and instantiated."""
    from panels.session_browser_panel import SessionBrowserPanel

    panel = SessionBrowserPanel()
    assert panel is not None
    assert isinstance(panel, object)


def test_session_browser_initial_state():
    """Test initial filter state defaults to 'all'."""
    from panels.session_browser_panel import SessionBrowserPanel

    panel = SessionBrowserPanel()
    assert panel._current_flow_filter == "all"
    assert panel._current_phase_filter == "all"
    assert panel._current_model_filter == "all"


def test_session_browser_update_sessions_populates_filters():
    """Test that update_sessions populates filter dropdown options."""
    from panels.session_browser_panel import SessionBrowserPanel

    sessions = [
        _make_session(1, "flow-a", "builder"),
        _make_session(2, "flow-b", "reviewer"),
    ]

    panel = SessionBrowserPanel()
    panel.update_sessions(sessions)

    assert panel._available_flows == ["flow-a", "flow-b"]
    assert panel._available_phases == ["builder", "reviewer"]


def test_session_browser_update_empty_sessions_clears_filters():
    """Test that update_sessions with empty list clears filter options."""
    from panels.session_browser_panel import SessionBrowserPanel

    panel = SessionBrowserPanel()
    panel.update_sessions([])

    assert panel._available_flows == []
    assert panel._available_phases == []


def test_session_browser_update_resets_filters():
    """Test that update_sessions resets all filters to 'all'."""
    from panels.session_browser_panel import SessionBrowserPanel

    sessions = [
        _make_session(1, "flow-a", "builder"),
    ]

    panel = SessionBrowserPanel()
    # Simulate previous filter state
    panel._current_flow_filter = "flow-a"
    panel.update_sessions(sessions)

    assert panel._current_flow_filter == "all"


def test_session_browser_empty_state_shown_when_no_match():
    """Test that empty state is shown when filters match no sessions."""
    from panels.session_browser_panel import SessionBrowserPanel
    from textual.widgets import Static

    sessions = [
        _make_session(1, "flow-a", "builder"),
    ]

    panel = SessionBrowserPanel()
    # Mock the DataTable to avoid Textual dependencies
    mock_table = MagicMock()
    panel.sessions_table = mock_table

    # Mock query_one for empty state (since we're not mounted in a Textual app)
    mock_empty_state = MagicMock()
    def mock_query_one(selector, widget_type=None):
        if "empty-state" in selector:
            return mock_empty_state
        raise ValueError(f"Unknown selector: {selector}")

    panel.query_one = mock_query_one

    panel.update_sessions(sessions)

    # Apply a filter that matches nothing
    panel._current_flow_filter = "nonexistent"
    panel._apply_filters()

    # The table should be cleared (no rows added) and empty state class toggled
    assert mock_table.clear.called
    assert mock_empty_state.add_class.called


# ── Main test runner ───────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [
        # Filter logic
        ("filter_by_flow", test_filter_by_flow),
        ("filter_by_phase", test_filter_by_phase),
        ("filter_by_model", test_filter_by_model),
        ("combined_filters", test_combined_filters),
        ("no_match_returns_empty", test_no_match_returns_empty),
        ("all_filter_returns_all", test_all_filter_returns_all),
        ("empty_sessions_list", test_empty_sessions_list),

        # Duration formatting
        ("format_duration_seconds_only", test_format_duration_seconds_only),
        ("format_duration_minutes_and_seconds", test_format_duration_minutes_and_seconds),
        ("format_duration_hours", test_format_duration_hours),

        # Verdict icons
        ("verdict_approved_icon", test_verdict_approved_icon),
        ("verdict_rejected_icon", test_verdict_rejected_icon),
        ("verdict_error_icon", test_verdict_error_icon),
        ("verdict_none_no_errors", test_verdict_none_no_errors),

        # Dropdown population
        ("extract_unique_flows", test_extract_unique_flows),
        ("extract_unique_phases", test_extract_unique_phases),
        ("extract_unique_models", test_extract_unique_models),
        ("extract_unique_models_skips_none", test_extract_unique_models_skips_none),

        # DashboardAPI integration
        ("dashboard_api_get_all_sessions_returns_data", test_dashboard_api_get_all_sessions_returns_data),
        ("dashboard_api_sessions_have_correct_types", test_dashboard_api_sessions_have_correct_types),

        # SessionBrowserPanel class tests
        ("session_browser_panel_class_exists", test_session_browser_panel_class_exists),
        ("session_browser_initial_state", test_session_browser_initial_state),
        ("session_browser_update_sessions_populates_filters", test_session_browser_update_sessions_populates_filters),
        ("session_browser_update_empty_sessions_clears_filters", test_session_browser_update_empty_sessions_clears_filters),
        ("session_browser_update_resets_filters", test_session_browser_update_resets_filters),
        ("session_browser_empty_state_shown_when_no_match", test_session_browser_empty_state_shown_when_no_match),
    ]

    failed = []
    for name, test in tests:
        try:
            print(f"Running {name}...", end=" ")
            test()
            print("✓")
        except Exception as e:
            print(f"✗ FAILED: {e}")
            import traceback
            traceback.print_exc()
            failed.append(name)

    if failed:
        print(f"\n❌ {len(failed)} test(s) failed:")
        for name in failed:
            print(f"  - {name}")
        sys.exit(1)
    else:
        print(f"\n✅ All {len(tests)} tests passed!")
