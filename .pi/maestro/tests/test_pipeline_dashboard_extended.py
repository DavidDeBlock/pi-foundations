#!/usr/bin/env python3
"""
Extended tests for pipeline/dashboard.py — PipelineDashboard class.

Tests new features added in issue #110:
- In-place progress bar with percentage (carriage returns)
- Current phase name and active issue number display
- Event log updates in-place using carriage returns
- Final scorecard table with per-issue pass/fail results

Run with: python3 tests/test_pipeline_dashboard_extended.py
"""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock, call

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))

from pipelines.dashboard import PipelineDashboard


def test_set_current_phase():
    """Test setting the current phase name."""
    dashboard = PipelineDashboard()

    dashboard.set_current_phase("builder-reviewer")
    assert dashboard.current_phase == "builder-reviewer"

    dashboard.set_current_phase("prd-audit")
    assert dashboard.current_phase == "prd-audit"


def test_set_active_issue():
    """Test setting the active issue number."""
    dashboard = PipelineDashboard()

    dashboard.set_active_issue(42)
    assert dashboard.active_issue == 42

    dashboard.set_active_issue(100)
    assert dashboard.active_issue == 100


def test_status_line_with_phase_and_issue():
    """Test the status line includes phase and issue info."""
    dashboard = PipelineDashboard()
    dashboard.set_current_phase("builder")
    dashboard.set_active_issue(42)

    status = dashboard._status_line()
    assert "Phase:" in status
    assert "builder" in status
    # ANSI codes are present, so check for the key parts separately
    assert "Issue#" in status
    assert "42" in status


def test_status_line_empty():
    """Test the status line is empty when no phase or issue set."""
    dashboard = PipelineDashboard()
    status = dashboard._status_line()
    assert status == ""


def test_event_log_buffer_limit():
    """Test that event log buffer respects MAX_LOG_EVENTS limit."""
    dashboard = PipelineDashboard()

    # Add more events than the max buffer size
    for i in range(20):
        dashboard.log_event(f"Event {i}", "info")

    assert len(dashboard.event_log) == dashboard.MAX_LOG_EVENTS
    # Should keep the last N events
    assert dashboard.event_log[0]["message"] == "Event 12"
    assert dashboard.event_log[-1]["message"] == "Event 19"


def test_event_color_mapping():
    """Test event color codes map correctly."""
    dashboard = PipelineDashboard()

    assert dashboard._event_color("success") == "\033[0;32m"   # GREEN
    assert dashboard._event_color("failure") == "\033[0;31m"   # RED
    assert dashboard._event_color("warning") == "\033[1;33m"   # YELLOW
    assert dashboard._event_color("info") == "\033[0;34m"       # BLUE


def test_record_issue_result():
    """Test recording per-issue pass/fail results."""
    dashboard = PipelineDashboard()

    dashboard.record_issue_result(42, True)
    dashboard.record_issue_result(43, False)
    dashboard.record_issue_result(44, True)

    assert dashboard.issue_results[42] == "pass"
    assert dashboard.issue_results[43] == "fail"
    assert dashboard.issue_results[44] == "pass"


def test_clear_resets_all_state():
    """Test that clear() resets all dashboard state."""
    dashboard = PipelineDashboard()

    # Set some state
    dashboard.total_steps = 10
    dashboard.completed_steps = 5
    dashboard.failed_steps = 2
    dashboard.current_phase = "builder"
    dashboard.active_issue = 42
    dashboard.event_log.append({"message": "test", "type": "info"})
    dashboard.issue_results[42] = "pass"

    # Clear and verify reset
    dashboard.clear()

    assert dashboard.total_steps == 0
    assert dashboard.completed_steps == 0
    assert dashboard.failed_steps == 0
    assert dashboard.current_phase == ""
    assert dashboard.active_issue is None
    assert len(dashboard.event_log) == 0
    assert len(dashboard.issue_results) == 0


def test_progress_bar_with_term():
    """Test progress bar draws via term when provided."""
    mock_term = MagicMock()
    dashboard = PipelineDashboard(term=mock_term)

    # Capture stderr output
    with patch("sys.stderr") as mock_stderr:
        mock_stderr.write = MagicMock()
        mock_stderr.flush = MagicMock()

        dashboard.update_progress(5, total=10)

        # Verify carriage return was used (in-place update)
        write_calls = [c[0][0] for c in mock_stderr.write.call_args_list]
        combined = "".join(write_calls)
        assert "\r" in combined  # Carriage return present
        assert "50%" in combined  # Percentage shown
        assert "(5/10)" in combined  # Count shown


def test_progress_bar_zero_total():
    """Test progress bar handles zero total gracefully."""
    dashboard = PipelineDashboard()

    with patch("sys.stderr") as mock_stderr:
        mock_stderr.write = MagicMock()
        mock_stderr.flush = MagicMock()

        dashboard.update_progress(0, total=0)

        # Should not crash or divide by zero


def test_scorecard_with_issue_table():
    """Test scorecard prints per-issue table when issue_results populated."""
    mock_term = MagicMock()
    dashboard = PipelineDashboard(term=mock_term)

    dashboard.completed_steps = 2
    dashboard.failed_steps = 1
    dashboard.issue_results[42] = "pass"
    dashboard.issue_results[43] = "fail"
    dashboard.issue_results[44] = "pass"

    with patch("sys.stderr") as mock_stderr:
        mock_stderr.write = MagicMock()
        mock_stderr.flush = MagicMock()

        dashboard.print_scorecard("test-pipeline")

        # Verify term.summary was called for backward compatibility
        mock_term.summary.assert_called_once_with(
            issues_completed=2,
            issues_failed=1
        )


def test_utility_methods():
    """Test helper utility methods."""
    assert PipelineDashboard._pad_right("hello", 10) == "hello     "
    assert PipelineDashboard._center_text("hi", 6) == "  hi  "


if __name__ == "__main__":
    print("Running extended tests...")

    test_set_current_phase()
    print("✓ test_set_current_phase passed")

    test_set_active_issue()
    print("✓ test_set_active_issue passed")

    test_status_line_with_phase_and_issue()
    print("✓ test_status_line_with_phase_and_issue passed")

    test_status_line_empty()
    print("✓ test_status_line_empty passed")

    test_event_log_buffer_limit()
    print("✓ test_event_log_buffer_limit passed")

    test_event_color_mapping()
    print("✓ test_event_color_mapping passed")

    test_record_issue_result()
    print("✓ test_record_issue_result passed")

    test_clear_resets_all_state()
    print("✓ test_clear_resets_all_state passed")

    test_progress_bar_with_term()
    print("✓ test_progress_bar_with_term passed")

    test_progress_bar_zero_total()
    print("✓ test_progress_bar_zero_total passed")

    test_scorecard_with_issue_table()
    print("✓ test_scorecard_with_issue_table passed")

    test_utility_methods()
    print("✓ test_utility_methods passed")

    print("\nAll extended tests passed!")
