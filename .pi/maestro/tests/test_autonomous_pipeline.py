#!/usr/bin/env python3
"""
Tests for pipelines/autonomous.py — Autonomous Pipeline.

Run with: python3 tests/test_autonomous_pipeline.py
"""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock, call

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))


def test_autonomous_pipeline_loads():
    """Test that the autonomous pipeline can be loaded by PipelineRunner."""
    from pipelines.runner import PipelineRunner
    
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term)
    
    # Load from the actual pipelines directory
    pipeline_func = runner.load_pipeline("autonomous.py")
    
    assert pipeline_func is not None, "Pipeline should load successfully"
    assert 'setup' in pipeline_func, "Pipeline must have setup() function"
    assert 'run' in pipeline_func, "Pipeline must have run() function"
    print("✓ test_autonomous_pipeline_loads passed")


def test_autonomous_setup():
    """Test that the autonomous pipeline setup initializes context correctly."""
    from pipelines.autonomous import setup
    
    mock_term = MagicMock()
    ctx = MagicMock()
    ctx.term = mock_term
    
    setup(ctx)
    
    # Verify variables were set
    assert ctx.set_variable.call_count == 2, "Should set 2 variables"
    calls = [c[0] for c in ctx.set_variable.call_args_list]
    assert ('pipeline_name', 'autonomous') in calls, "Should set pipeline_name"
    assert ('started_at', 'now') in calls, "Should set started_at"
    
    # Verify terminal info was called
    mock_term.info.assert_called()
    print("✓ test_autonomous_setup passed")


def test_autonomous_run_empty_backlog():
    """Test autonomous pipeline run with empty ready-for-agent backlog."""
    from pipelines.autonomous import setup, run
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    
    # Mock: no issues in either label
    mock_gh.fetch_issues_by_label.return_value = []
    
    ctx = MagicMock()
    ctx.term = mock_term
    ctx.github = mock_gh
    ctx.set_variable = MagicMock()
    ctx.get_summary.return_value = {"completed_steps": 0, "failed_steps": 0, "errors": []}
    
    # Mock dashboard at the module level where it's imported in run()
    with patch('pipelines.dashboard.PipelineDashboard') as MockDashboard:
        mock_dashboard = MagicMock()
        MockDashboard.return_value = mock_dashboard
        
        setup(ctx)
        run(ctx)
        
        # Verify GitHub calls were made for both labels
        assert mock_gh.fetch_issues_by_label.call_count == 2, "Should fetch ready-for-agent and parent-prd"
        fetch_calls = [c[0][0] for c in mock_gh.fetch_issues_by_label.call_args_list]
        assert 'ready-for-agent' in fetch_calls, "Should fetch ready-for-agent issues"
        assert 'parent-prd' in fetch_calls, "Should fetch parent-prd issues"
        
        # Dashboard should have been initialized and scorecard printed
        MockDashboard.assert_called_once()
        mock_dashboard.print_header.assert_called_with("autonomous")
        mock_dashboard.print_scorecard.assert_called_with("autonomous")
    
    print("✓ test_autonomous_run_empty_backlog passed")


def test_autonomous_run_with_backlog():
    """Test autonomous pipeline run with issues in ready-for-agent backlog."""
    from pipelines.autonomous import setup, run
    
    # Create mock issue objects — pickup-eligible per issue #50:
    # sole state label is ready-for-agent, no type:prd.
    mock_issue_1 = MagicMock()
    mock_issue_1.number = 42
    mock_issue_1.title = "Fix login bug"
    mock_issue_1.labels = ["ready-for-agent"]
    
    mock_issue_2 = MagicMock()
    mock_issue_2.number = 43
    mock_issue_2.title = "Add payment gateway"
    mock_issue_2.labels = ["ready-for-agent"]
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    
    # Mock: 2 issues ready for the agent, no parent-prd issues
    mock_gh.fetch_issues_by_label.side_effect = [
        [mock_issue_1, mock_issue_2],  # ready-for-agent
        []                              # parent-prd
    ]
    
    ctx = MagicMock()
    ctx.term = mock_term
    ctx.github = mock_gh
    ctx.set_variable = MagicMock()
    ctx.get_summary.return_value = {"completed_steps": 2, "failed_steps": 0, "errors": []}
    
    # Mock run_flow to return success for both issues.
    # Issue #50: success swaps the issue to awaiting-manual-check
    # (in the dispatcher finalizer); the pipeline no longer closes.
    def mock_run_flow(flow_name, issue_num):
        if flow_name == "builder-reviewer":
            return True
        return False
    
    ctx.run_flow = MagicMock(side_effect=mock_run_flow)
    
    # Mock dashboard at the module level where it's imported in run()
    with patch('pipelines.dashboard.PipelineDashboard') as MockDashboard:
        mock_dashboard = MagicMock()
        MockDashboard.return_value = mock_dashboard
        
        setup(ctx)
        run(ctx)
        
        # Verify flow was called for each issue
        assert ctx.run_flow.call_count == 2, "Should run flow on both issues"
        
        # Issue #50: success lands on awaiting-manual-check — a human
        # verifies and closes. The pipeline never closes issues.
        mock_gh.close_issue.assert_not_called()
        
        # Dashboard should have been updated with progress
        assert mock_dashboard.set_current_phase.called, "Dashboard should set phase"
        assert mock_dashboard.update_progress.called, "Dashboard should update progress"
    
    print("✓ test_autonomous_run_with_backlog passed")


def test_autonomous_run_prd_audit():
    """Test autonomous pipeline run with parent-prd issues for audit."""
    from pipelines.autonomous import setup, run
    
    # Create mock issue objects
    mock_prd = MagicMock()
    mock_prd.number = 106
    mock_prd.title = "PRD: Autonomous Pipeline Engine"
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    
    # Mock: no ready-for-agent issues, but one parent-prd issue
    mock_gh.fetch_issues_by_label.side_effect = [
        [],                              # ready-for-agent (empty)
        [mock_prd]                       # parent-prd
    ]
    
    ctx = MagicMock()
    ctx.term = mock_term
    ctx.github = mock_gh
    ctx.set_variable = MagicMock()
    ctx.get_summary.return_value = {"completed_steps": 1, "failed_steps": 0, "errors": []}
    
    # Mock run_flow to return success for prd-audit
    def mock_run_flow(flow_name, issue_num):
        if flow_name == "prd-audit" and issue_num == 106:
            return True
        return False
    
    ctx.run_flow = MagicMock(side_effect=mock_run_flow)
    
    # Mock dashboard at the module level where it's imported in run()
    with patch('pipelines.dashboard.PipelineDashboard') as MockDashboard:
        mock_dashboard = MagicMock()
        MockDashboard.return_value = mock_dashboard
        
        setup(ctx)
        run(ctx)
        
        # Verify prd-audit flow was called
        assert ctx.run_flow.call_count == 1, "Should run flow once"
        call_args = ctx.run_flow.call_args_list[0]
        assert call_args[0][0] == "prd-audit", f"Flow should be 'prd-audit', got {call_args[0][0]}"
        assert call_args[0][1] == 106, f"Issue should be #106, got {call_args[0][1]}"
        
        # Dashboard phase should be set to prd-audit
        mock_dashboard.set_current_phase.assert_called_with("prd-audit")
    
    print("✓ test_autonomous_run_prd_audit passed")


def test_autonomous_run_mixed_success_failure():
    """Test autonomous pipeline handles mixed success/failure correctly."""
    from pipelines.autonomous import setup, run
    
    # Create mock issue objects — pickup-eligible (issue #50)
    mock_issue = MagicMock()
    mock_issue.number = 42
    mock_issue.title = "Flaky issue"
    mock_issue.labels = ["ready-for-agent"]
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    
    # Mock: one ready-for-agent issue that fails, no parent-prd issues
    mock_gh.fetch_issues_by_label.side_effect = [
        [mock_issue],  # ready-for-agent (1 issue)
        []             # parent-prd (empty)
    ]
    
    ctx = MagicMock()
    ctx.term = mock_term
    ctx.github = mock_gh
    ctx.set_variable = MagicMock()
    ctx.get_summary.return_value = {"completed_steps": 0, "failed_steps": 1, "errors": [{"step": "builder-reviewer:issue-42", "message": "Flow failed"}]}
    
    # Mock run_flow to return failure
    def mock_run_flow(flow_name, issue_num):
        return False
    
    ctx.run_flow = MagicMock(side_effect=mock_run_flow)
    
    # Mock dashboard at the module level where it's imported in run()
    with patch('pipelines.dashboard.PipelineDashboard') as MockDashboard:
        mock_dashboard = MagicMock()
        MockDashboard.return_value = mock_dashboard
        
        setup(ctx)
        run(ctx)
        
        # Flow should still be called even though it fails (continue_on_error mode)
        assert ctx.run_flow.call_count == 1, "Should attempt flow despite failure"
        
        # close_issue should NOT be called for failed flows
        # (nor for successful ones anymore — issue #50)
        mock_gh.close_issue.assert_not_called()
    
    print("✓ test_autonomous_run_mixed_success_failure passed")


def test_autonomous_pipeline_direct_execution():
    """Test that the autonomous pipeline can execute directly (with mocked GitHub)."""
    from pipelines.runner import PipelineRunner
    
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, continue_on_error=True)
    
    # Load and execute the actual autonomous pipeline file
    pipeline_func = runner.load_pipeline("autonomous.py")
    result = runner.execute_pipeline(pipeline_func, "autonomous", continue_on_error=True)
    
    # Should not raise an exception (continue_on_error mode)
    assert isinstance(result, dict), "Result should be a dict"
    assert "success" in result, "Result should have 'success' key"
    assert "pipeline" in result, "Result should have 'pipeline' key"
    
    print("✓ test_autonomous_pipeline_direct_execution passed")


if __name__ == "__main__":
    print("Running autonomous pipeline tests...\n")
    
    test_autonomous_pipeline_loads()
    test_autonomous_setup()
    test_autonomous_run_empty_backlog()
    test_autonomous_run_with_backlog()
    test_autonomous_run_prd_audit()
    test_autonomous_run_mixed_success_failure()
    test_autonomous_pipeline_direct_execution()
    
    print("\n✅ All autonomous pipeline tests passed!")
