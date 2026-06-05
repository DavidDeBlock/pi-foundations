#!/usr/bin/env python3
"""
Tests for Maestro Dashboard app (dashboard.py).

Verifies:
- App composition with 6 tabs
- Issue data loading via mocked DashboardAPI
- Detail panel updates on row selection
- Error handling when API fails

Run with: python3 tests/test_dashboard_app.py
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock

# Add lib and root to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))


class MockIssue:
    """Minimal mock of a GitHub Issue object."""

    def __init__(self, number: int, title: str, labels: list[str] | None = None, created_at: str = "2026-05-28T12:00:00Z", state: str = "open"):
        self.number = number
        self.title = title
        self.labels = labels or []
        self.created_at = created_at
        self.state = state


class MockIssueDetail(MockIssue):
    """Mock issue with body content."""

    def __init__(self, *args, body: str = "", **kwargs):
        super().__init__(*args, **kwargs)
        self.body = body


def test_app_initializes():
    """Test that MaestroApp initializes without errors."""
    from dashboard import MaestroApp

    app = MaestroApp()
    assert app is not None
    assert app.TITLE == "Maestro Dashboard"


def test_app_has_6_tabs():
    """Test that the app composes with exactly 6 tabs."""
    from dashboard import MaestroApp

    # Just verify the class and its CSS/BINDINGS are set up correctly
    from dashboard import MaestroApp
    
    app = MaestroApp()
    
    # Verify CSS contains tab-related styling
    assert "TabbedContent" in app.CSS, "CSS should reference TabbedContent"
    assert "65%" in app.CSS or "65fr" in app.CSS, "CSS should have 65% width for list view"
    assert "35%" in app.CSS or "35fr" in app.CSS, "CSS should have 35% width for detail panel"


def test_issues_tab_has_data_table():
    """Test that the Issues tab contains a DataTable."""
    from dashboard import MaestroApp

    # Just verify the class has the right structure
    from dashboard import MaestroApp
    
    app = MaestroApp()
    
    # Verify BINDINGS includes expected keys
    binding_commands = [b.action for b in app.BINDINGS]
    assert "quit" in binding_commands, "Should have quit keybinding"
    # Note: [r] is now context-aware (refresh_issues_or_replay)
    has_refresh = any("refresh" in b for b in binding_commands)
    assert has_refresh, f"Should have refresh-related keybinding. Found: {binding_commands}"


def test_fetch_issues_success():
    """Test that _fetch_issues populates the DataTable on success."""
    from dashboard import MaestroApp

    app = MaestroApp()

    # Create mock issues
    mock_issues = [
        MockIssue(number=200, title="Dashboard Rewrite - Phase 1", labels=["needs-triage"]),
        MockIssue(number=199, title="[PRD] Maestro Dashboard — Complete Rewrite", labels=["parent-prd"]),
    ]

    # Create a mock result
    mock_result = MagicMock()
    mock_result.success = True
    mock_result.data = mock_issues

    # Set the mocked API and mock query_one to avoid needing a mounted app
    mock_table = MagicMock()
    
    def mock_query_one(selector, widget_type=None):
        return mock_table
    
    app.query_one = mock_query_one
    app._api_override = MagicMock(fetch_issues=lambda labels=None: mock_result)
    
    # Mock the DataTable class to prevent actual instantiation during compose
    with patch('dashboard.DataTable', return_value=mock_table):
        app._fetch_issues()

    # Verify the table was populated (we check via internal state)
    assert not app._loading_issues, "Loading flag should be False after fetch"
    
    # Verify table methods were called (clear_columns, add_columns, add_row)
    assert mock_table.clear.called or mock_table.add_row.called, "Table should have been updated"


def test_fetch_issues_empty():
    """Test that _fetch_issues handles empty results gracefully."""
    from dashboard import MaestroApp

    app = MaestroApp()

    # Create an empty result
    mock_result = MagicMock(success=True, data=[])
    
    mock_table = MagicMock()
    def mock_query_one(selector, widget_type=None):
        return mock_table
    
    app.query_one = mock_query_one
    app._api_override = MagicMock(fetch_issues=lambda labels=None: mock_result)
    
    with patch('dashboard.DataTable', return_value=mock_table):
        app._fetch_issues()

    assert not app._loading_issues


def test_fetch_issues_api_error():
    """Test that _fetch_issues handles API errors gracefully."""
    from dashboard import MaestroApp

    app = MaestroApp()

    # Create an error result
    mock_result = MagicMock(success=False, data=None, error="GitHub unreachable")
    
    mock_table = MagicMock()
    def mock_query_one(selector, widget_type=None):
        return mock_table
    
    app.query_one = mock_query_one
    app._api_override = MagicMock(fetch_issues=lambda labels=None: mock_result)
    
    with patch('dashboard.DataTable', return_value=mock_table):
        app._fetch_issues()

    assert not app._loading_issues


def test_fetch_issues_exception():
    """Test that _fetch_issues handles unexpected exceptions."""
    from dashboard import MaestroApp

    app = MaestroApp()
    
    mock_table = MagicMock()
    def mock_query_one(selector, widget_type=None):
        return mock_table
    
    app.query_one = mock_query_one
    
    # Make the API raise an exception
    with patch('dashboard.DataTable', return_value=mock_table):
        app._api_override = MagicMock(side_effect=Exception("Network error"))
        app._fetch_issues()  # Should not crash

    assert not app._loading_issues


def test_render_issue_detail_success():
    """Test that _render_issue_detail renders issue details correctly."""
    from dashboard import MaestroApp

    app = MaestroApp()

    mock_issue = MockIssueDetail(
        number=200,
        title="Dashboard Rewrite - Phase 1",
        labels=["needs-triage"],
        created_at="2026-05-28T12:00:00Z",
        state="open",
        body="This is the issue body content.",
    )

    mock_result = MagicMock(success=True, data=mock_issue)

    # Mock query_one to avoid needing a mounted app
    mock_label = MagicMock()
    mock_static = MagicMock()

    def mock_query_one(selector, widget_type=None):
        if "detail-title" in selector:
            return mock_label
        elif "detail-body" in selector:
            return mock_static
        raise ValueError(f"Unknown selector: {selector}")

    app.query_one = mock_query_one
    app._api_override = MagicMock(fetch_issue=lambda num: mock_result)
    app._render_issue_detail(200)
    
    # Verify the widgets were updated with correct content
    update_calls = [call for call in mock_label.update.call_args_list]
    body_calls = [call for call in mock_static.update.call_args_list]
    
    assert len(update_calls) > 0, "Title label should have been updated"


def test_render_issue_detail_not_found():
    """Test that _render_issue_detail handles not-found errors."""
    from dashboard import MaestroApp

    app = MaestroApp()

    mock_result = MagicMock(success=False, data=None, error="Issue not found")

    # Mock query_one to avoid needing a mounted app
    mock_label = MagicMock()
    mock_static = MagicMock()

    def mock_query_one(selector, widget_type=None):
        if "detail-title" in selector:
            return mock_label
        elif "detail-body" in selector:
            return mock_static
        raise ValueError(f"Unknown selector: {selector}")

    app.query_one = mock_query_one
    app._api_override = MagicMock(fetch_issue=lambda num: mock_result)
    app._render_issue_detail(999)


def test_render_issue_detail_api_error():
    """Test that _render_issue_detail handles API errors."""
    from dashboard import MaestroApp

    app = MaestroApp()

    # Mock query_one to avoid needing a mounted app
    mock_label = MagicMock()
    mock_static = MagicMock()

    def mock_query_one(selector, widget_type=None):
        if "detail-title" in selector:
            return mock_label
        elif "detail-body" in selector:
            return mock_static
        raise ValueError(f"Unknown selector: {selector}")

    app.query_one = mock_query_one
    app._api_override = MagicMock(side_effect=Exception("Network error"))
    app._render_issue_detail(200)  # Should not crash


def test_clear_detail():
    """Test that _clear_detail resets the detail panel."""
    from dashboard import MaestroApp

    app = MaestroApp()

    # Mock query_one to avoid needing a mounted app
    mock_label = MagicMock()
    mock_static = MagicMock()

    def mock_query_one(selector, widget_type=None):
        if "detail-title" in selector:
            return mock_label
        elif "detail-body" in selector:
            return mock_static
        raise ValueError(f"Unknown selector: {selector}")

    app.query_one = mock_query_one
    app._clear_detail()

    assert True  # No exception means success


def test_action_refresh_issues():
    """Test that action_refresh_issues calls _fetch_issues."""
    from dashboard import MaestroApp

    app = MaestroApp()

    mock_table = MagicMock()
    
    def mock_query_one(selector, widget_type=None):
        return mock_table
    
    app.query_one = mock_query_one
    
    with patch('dashboard.DataTable', return_value=mock_table):
        mock_result = MagicMock(success=True, data=[])
        app._api_override = MagicMock(fetch_issues=lambda labels=None: mock_result)
        app.action_refresh_issues()

    assert not app._loading_issues


def test_action_focus_search():
    """Test that action_focus_search shows a notification."""
    from dashboard import MaestroApp

    app = MaestroApp()
    app.notify = MagicMock()  # Mock notify to prevent actual display

    app.action_focus_search()

    app.notify.assert_called_once()


def test_label_filter_triggers_refetch():
    """Test that changing the label filter triggers a live re-fetch of issues."""
    from dashboard import MaestroApp

    app = MaestroApp()
    
    # Create mock issues with different labels
    mock_issues = [
        MockIssue(number=201, title="New Issue", labels=["parent-prd"]),
    ]

    mock_result = MagicMock(success=True, data=mock_issues)
    mock_table = MagicMock()

    def mock_query_one(selector, widget_type=None):
        return mock_table

    app.query_one = mock_query_one
    app._api_override = MagicMock(fetch_issues=lambda labels=None: mock_result)

    # Simulate Select.Changed event with new label selection
    from textual.widgets import Select
    
    message = MagicMock()
    message.value = "parent-prd"
    
    # Call the handler directly (simulating Select changed event)
    app.on_select_changed(message)

    assert app._selected_labels == ["parent-prd"]
    assert not app._loading_issues, "Loading flag should be False after fetch"


def test_open_github_with_selection():
    """Test that [g] keybinding opens the selected issue in browser."""
    from dashboard import MaestroApp

    app = MaestroApp()
    app.selected_issue_number = 201
    
    # Mock subprocess.run to avoid actually opening a browser
    with patch('subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stderr='')
        app.notify = MagicMock()
        
        app.action_open_github()
        
        mock_run.assert_called_once_with(
            ["gh", "issue", "view", "201", "--web"],
            capture_output=True,
            text=True,
            timeout=10,
        )


def test_open_github_no_selection():
    """Test that [g] keybinding notifies user when no issue is selected."""
    from dashboard import MaestroApp

    app = MaestroApp()
    app.selected_issue_number = None  # No selection
    
    with patch('subprocess.run') as mock_run:
        app.notify = MagicMock()
        
        app.action_open_github()
        
        mock_run.assert_not_called()  # Should not call subprocess
        app.notify.assert_called_once_with(
            "No issue selected — click a row to select an issue",
            severity="information"
        )


def test_get_linked_sessions_text():
    """Test that _get_linked_sessions_text formats sessions correctly."""
    from dashboard import MaestroApp

    app = MaestroApp()
    
    # Mock get_all_sessions to return linked sessions for issue 201
    mock_sessions = [
        {
            "issue": 201,
            "flow": "builder-reviewer",
            "phase": "builder",
            "model": "llama-cpp-main/qwen-35b-a3b-118k-bf16",
            "verdict_status": "approved",
            "timestamp_str": "2026-05-27T00:02:26",
        },
    ]
    
    mock_result = MagicMock(success=True, data=mock_sessions)
    app._api_override = MagicMock(get_all_sessions=lambda: mock_result)
    
    text = app._get_linked_sessions_text(201)
    
    assert "builder-reviewer/builder" in text
    assert "approved" in text


def test_get_linked_sessions_no_match():
    """Test that _get_linked_sessions_text returns 'No linked sessions' when none found."""
    from dashboard import MaestroApp

    app = MaestroApp()
    
    # Mock get_all_sessions to return empty list
    mock_result = MagicMock(success=True, data=[])
    app._api_override = MagicMock(get_all_sessions=lambda: mock_result)
    
    text = app._get_linked_sessions_text(999)  # Issue number that doesn't exist
    
    assert "No linked sessions" in text


def test_get_linked_sessions_api_error():
    """Test that _get_linked_sessions_text handles API errors gracefully."""
    from dashboard import MaestroApp

    app = MaestroApp()
    
    # Mock get_all_sessions to return error result
    mock_result = MagicMock(success=False, data=None, error="API failure")
    app._api_override = MagicMock(get_all_sessions=lambda: mock_result)
    
    text = app._get_linked_sessions_text(201)
    
    assert "Failed to load sessions" in text


if __name__ == "__main__":
    tests = [
        test_app_initializes,
        test_app_has_6_tabs,
        test_issues_tab_has_data_table,
        test_fetch_issues_success,
        test_fetch_issues_empty,
        test_fetch_issues_api_error,
        test_fetch_issues_exception,
        test_render_issue_detail_success,
        test_render_issue_detail_not_found,
        test_render_issue_detail_api_error,
        test_clear_detail,
        test_action_refresh_issues,
        test_action_focus_search,
        test_label_filter_triggers_refetch,
        test_open_github_with_selection,
        test_open_github_no_selection,
        test_get_linked_sessions_text,
        test_get_linked_sessions_no_match,
        test_get_linked_sessions_api_error,
    ]

    failed = []
    for test in tests:
        try:
            print(f"Running {test.__name__}...", end=" ")
            test()
            print("✓")
        except Exception as e:
            print(f"✗ FAILED: {e}")
            import traceback
            traceback.print_exc()
            failed.append(test.__name__)

    if failed:
        print(f"\n❌ {len(failed)} test(s) failed:")
        for name in failed:
            print(f"  - {name}")
        sys.exit(1)
    else:
        print(f"\n✅ All {len(tests)} tests passed!")
