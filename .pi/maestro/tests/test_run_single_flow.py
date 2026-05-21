#!/usr/bin/env python3
"""
Tests for ctx.run_flow() retry logic and PipelineRunner.run_single_flow().

Covers:
- Automatic retry on transient failures (network blips, LLM timeouts)
- Configurable retry limits per step
- Failed steps accumulated in context without blocking batch
- Success/failure/retry state tracking
- Continue-on-error mode for batch processing

Run with: python3 tests/test_run_single_flow.py
"""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock, call

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))


def test_run_flow_retries_on_transient_failure():
    """Test that ctx.run_flow() retries on transient failures."""
    from pipelines.context import PipelineContext
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    call_count = [0]
    
    def flaky_run_flow(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] < 3:
            raise ConnectionError("Network blip")
        return True
    
    with patch('flow_engine.run_flow_on_issue', side_effect=flaky_run_flow):
        result = ctx.run_flow("builder-reviewer", 42, max_retries=3)
    
    assert result is True
    assert call_count[0] == 3


def test_run_flow_fails_after_max_retries():
    """Test that ctx.run_flow() returns False after exhausting retries."""
    from pipelines.context import PipelineContext
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    call_count = [0]
    
    def always_fails(*args, **kwargs):
        call_count[0] += 1
        raise ConnectionError("Persistent failure")
    
    with patch('flow_engine.run_flow_on_issue', side_effect=always_fails):
        result = ctx.run_flow("builder-reviewer", 42, max_retries=3)
    
    assert result is False
    assert call_count[0] == 3


def test_run_flow_records_error_in_context():
    """Test that failed flow execution records error in context.errors."""
    from pipelines.context import PipelineContext
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    def always_fails(*args, **kwargs):
        raise ConnectionError("Network blip")
    
    with patch('flow_engine.run_flow_on_issue', side_effect=always_fails):
        result = ctx.run_flow("builder-reviewer", 42, max_retries=1)
    
    assert result is False
    assert len(ctx.errors) == 1
    assert ctx.errors[0]["step"] == "builder-reviewer:issue-42"


def test_run_flow_accumulates_multiple_failures():
    """Test that multiple failed flows accumulate errors in context."""
    from pipelines.context import PipelineContext
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    def always_fails(*args, **kwargs):
        raise ConnectionError("Network blip")
    
    with patch('flow_engine.run_flow_on_issue', side_effect=always_fails):
        result1 = ctx.run_flow("builder-reviewer", 42, max_retries=1)
        result2 = ctx.run_flow("prd-audit", 106, max_retries=1)
    
    assert result1 is False
    assert result2 is False
    assert len(ctx.errors) == 2


def test_run_flow_success_does_not_record_error():
    """Test that successful flow execution does not record error."""
    from pipelines.context import PipelineContext
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    with patch('flow_engine.run_flow_on_issue', return_value=True):
        result = ctx.run_flow("builder-reviewer", 42, max_retries=3)
    
    assert result is True
    assert len(ctx.errors) == 0


def test_run_flow_increments_completed_steps():
    """Test that successful flow increments completed_steps counter."""
    from pipelines.context import PipelineContext
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    with patch('flow_engine.run_flow_on_issue', return_value=True):
        result1 = ctx.run_flow("builder-reviewer", 42)
        result2 = ctx.run_flow("prd-audit", 106)
    
    assert ctx.completed_steps == 2


def test_run_flow_default_max_retries():
    """Test that run_flow uses default max_retries=3 when not specified."""
    from pipelines.context import PipelineContext
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    call_count = [0]
    
    def flaky(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] < 3:
            raise ConnectionError("blip")
        return True
    
    with patch('flow_engine.run_flow_on_issue', side_effect=flaky):
        result = ctx.run_flow("builder-reviewer", 42)
    
    assert result is True
    assert call_count[0] == 3


def test_run_flow_prints_retry_warning():
    """Test that run_flow prints retry warnings to terminal."""
    from pipelines.context import PipelineContext
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    call_count = [0]
    
    def flaky(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] < 2:
            raise ConnectionError("Network blip")
        return True
    
    with patch('flow_engine.run_flow_on_issue', side_effect=flaky):
        result = ctx.run_flow("builder-reviewer", 42, max_retries=3)
    
    assert result is True
    # Should have printed a warning for the first retry attempt
    mock_term.warning.assert_called()


def test_run_single_flow_success_state():
    """Test PipelineRunner.run_single_flow returns success state."""
    from pipelines.runner import PipelineRunner
    
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=3)
    
    with patch('flow_engine.run_flow_on_issue', return_value=True):
        result = runner.run_single_flow(
            term=mock_term,
            gh_client=MagicMock(),
            flow_name="builder-reviewer",
            issue_num=42
        )
    
    assert result["success"] is True
    assert result["flow"] == "builder-reviewer"
    assert result["issue"] == 42
    assert result["state"] == "success"


def test_run_single_flow_failure_state():
    """Test PipelineRunner.run_single_flow returns failure state after retries."""
    from pipelines.runner import PipelineRunner
    
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=2)
    
    def always_fails(*args, **kwargs):
        raise ConnectionError("Persistent failure")
    
    with patch('flow_engine.run_flow_on_issue', side_effect=always_fails):
        result = runner.run_single_flow(
            term=mock_term,
            gh_client=MagicMock(),
            flow_name="builder-reviewer",
            issue_num=42
        )
    
    assert result["success"] is False
    assert result["flow"] == "builder-reviewer"
    assert result["issue"] == 42
    assert result["state"] == "failure"


def test_run_single_flow_retry_state():
    """Test PipelineRunner.run_single_flow returns success after retries."""
    from pipelines.runner import PipelineRunner
    
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=3)
    
    call_count = [0]
    
    def flaky(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] < 3:
            raise ConnectionError("Network blip")
        return True
    
    with patch('flow_engine.run_flow_on_issue', side_effect=flaky):
        result = runner.run_single_flow(
            term=mock_term,
            gh_client=MagicMock(),
            flow_name="builder-reviewer",
            issue_num=42
        )
    
    assert result["success"] is True
    assert result["state"] == "success"


def test_run_single_flow_accumulates_errors_in_context():
    """Test that run_single_flow accumulates errors in context when continue_on_error=True."""
    from pipelines.runner import PipelineRunner
    
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=1)
    
    def always_fails(*args, **kwargs):
        raise ConnectionError("Network blip")
    
    with patch('flow_engine.run_flow_on_issue', side_effect=always_fails):
        result = runner.run_single_flow(
            term=mock_term,
            gh_client=MagicMock(),
            flow_name="builder-reviewer",
            issue_num=42,
            continue_on_error=True
        )
    
    assert result["success"] is False
    # Errors should be accumulated in the context returned by run_single_flow
    assert "context" in result or len(mock_term.failure.call_args_list) > 0


def test_run_single_flow_continue_on_error_false_raises():
    """Test that run_single_flow raises when continue_on_error=False and flow fails."""
    from pipelines.runner import PipelineRunner
    
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=1)
    
    def always_fails(*args, **kwargs):
        raise ConnectionError("Persistent failure")
    
    with patch('flow_engine.run_flow_on_issue', side_effect=always_fails):
        try:
            result = runner.run_single_flow(
                term=mock_term,
                gh_client=MagicMock(),
                flow_name="builder-reviewer",
                issue_num=42,
                continue_on_error=False
            )
            assert False, "Should have raised exception"
        except RuntimeError as e:
            # run_single_flow wraps errors in RuntimeError for consistency
            assert "Persistent failure" in str(e)


def test_run_single_flow_with_custom_retry_limit():
    """Test that run_single_flow respects custom retry limit."""
    from pipelines.runner import PipelineRunner
    
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=3)
    
    call_count = [0]
    
    def always_fails(*args, **kwargs):
        call_count[0] += 1
        raise ConnectionError("Persistent failure")
    
    with patch('flow_engine.run_flow_on_issue', side_effect=always_fails):
        result = runner.run_single_flow(
            term=mock_term,
            gh_client=MagicMock(),
            flow_name="builder-reviewer",
            issue_num=42,
            max_retries=1  # Override default
        )
    
    assert call_count[0] == 1


def test_run_single_flow_batch_accumulates():
    """Test that running multiple flows accumulates errors without blocking."""
    from pipelines.runner import PipelineRunner
    
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=1)
    
    call_count = [0]
    
    def flaky(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] in (2, 4):  # Fail on issues 43 and 45
            raise ConnectionError("Network blip")
        return True
    
    with patch('flow_engine.run_flow_on_issue', side_effect=flaky):
        results = []
        for issue_num in [42, 43, 44, 45]:
            result = runner.run_single_flow(
                term=mock_term,
                gh_client=MagicMock(),
                flow_name="builder-reviewer",
                issue_num=issue_num,
                continue_on_error=True
            )
            results.append(result)
    
    # All 4 should have been attempted (continue on error)
    assert len(results) == 4
    # 2 succeeded, 2 failed
    successes = [r for r in results if r["success"]]
    failures = [r for r in results if not r["success"]]
    assert len(successes) == 2
    assert len(failures) == 2


if __name__ == "__main__":
    print("Running tests...")
    
    test_run_flow_retries_on_transient_failure()
    print("✓ test_run_flow_retries_on_transient_failure passed")
    
    test_run_flow_fails_after_max_retries()
    print("✓ test_run_flow_fails_after_max_retries passed")
    
    test_run_flow_records_error_in_context()
    print("✓ test_run_flow_records_error_in_context passed")
    
    test_run_flow_accumulates_multiple_failures()
    print("✓ test_run_flow_accumulates_multiple_failures passed")
    
    test_run_flow_success_does_not_record_error()
    print("✓ test_run_flow_success_does_not_record_error passed")
    
    test_run_flow_increments_completed_steps()
    print("✓ test_run_flow_increments_completed_steps passed")
    
    test_run_flow_default_max_retries()
    print("✓ test_run_flow_default_max_retries passed")
    
    test_run_flow_prints_retry_warning()
    print("✓ test_run_flow_prints_retry_warning passed")
    
    test_run_single_flow_success_state()
    print("✓ test_run_single_flow_success_state passed")
    
    test_run_single_flow_failure_state()
    print("✓ test_run_single_flow_failure_state passed")
    
    test_run_single_flow_retry_state()
    print("✓ test_run_single_flow_retry_state passed")
    
    test_run_single_flow_accumulates_errors_in_context()
    print("✓ test_run_single_flow_accumulates_errors_in_context passed")
    
    test_run_single_flow_continue_on_error_false_raises()
    print("✓ test_run_single_flow_continue_on_error_false_raises passed")
    
    test_run_single_flow_with_custom_retry_limit()
    print("✓ test_run_single_flow_with_custom_retry_limit passed")
    
    test_run_single_flow_batch_accumulates()
    print("✓ test_run_single_flow_batch_accumulates passed")
    
    print("\nAll tests passed!")
