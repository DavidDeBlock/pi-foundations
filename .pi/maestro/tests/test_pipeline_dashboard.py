#!/usr/bin/env python3
"""
Tests for pipeline/dashboard.py — PipelineDashboard class.

Run with: python3 tests/test_pipeline_dashboard.py
"""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))

from pipelines.dashboard import PipelineDashboard


def test_dashboard_initialization():
    """Test that PipelineDashboard initializes with correct defaults."""
    mock_term = MagicMock()
    
    dashboard = PipelineDashboard(term=mock_term)
    
    assert dashboard.term is mock_term
    assert dashboard.total_steps == 0
    assert dashboard.completed_steps == 0
    assert dashboard.failed_steps == 0


def test_dashboard_update_progress():
    """Test updating progress increments completed count."""
    mock_term = MagicMock()
    dashboard = PipelineDashboard(term=mock_term)
    
    dashboard.update_progress(5, total=10)
    
    assert dashboard.completed_steps == 5
    assert dashboard.total_steps == 10


def test_dashboard_record_success():
    """Test recording a successful step."""
    mock_term = MagicMock()
    dashboard = PipelineDashboard(term=mock_term)
    
    dashboard.record_step("step-1", success=True, details="All good")
    
    assert dashboard.completed_steps == 1
    mock_term.phase_approved.assert_called_once_with("[pipeline] step-1")


def test_dashboard_record_failure():
    """Test recording a failed step."""
    mock_term = MagicMock()
    dashboard = PipelineDashboard(term=mock_term)
    
    dashboard.record_step("step-2", success=False, details="Something broke")
    
    assert dashboard.failed_steps == 1
    mock_term.failure.assert_called_once_with("[pipeline] step-2: Something broke")


def test_dashboard_print_scorecard():
    """Test printing the final scorecard."""
    mock_term = MagicMock()
    dashboard = PipelineDashboard(term=mock_term)
    
    dashboard.completed_steps = 3
    dashboard.failed_steps = 1
    
    dashboard.print_scorecard("test-pipeline")
    
    # Verify summary was called with correct counts
    mock_term.summary.assert_called_once_with(
        issues_completed=3,
        issues_failed=1
    )


def test_dashboard_print_header():
    """Test printing the pipeline header."""
    mock_term = MagicMock()
    dashboard = PipelineDashboard(term=mock_term)
    
    dashboard.print_header("my-pipeline")
    
    mock_term.heading.assert_called_once_with("[pipeline] my-pipeline")


if __name__ == "__main__":
    print("Running tests...")
    
    test_dashboard_initialization()
    print("✓ test_dashboard_initialization passed")
    
    test_dashboard_update_progress()
    print("✓ test_dashboard_update_progress passed")
    
    test_dashboard_record_success()
    print("✓ test_dashboard_record_success passed")
    
    test_dashboard_record_failure()
    print("✓ test_dashboard_record_failure passed")
    
    test_dashboard_print_scorecard()
    print("✓ test_dashboard_print_scorecard passed")
    
    test_dashboard_print_header()
    print("✓ test_dashboard_print_header passed")
    
    print("\nAll tests passed!")
