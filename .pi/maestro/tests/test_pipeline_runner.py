#!/usr/bin/env python3
"""
Tests for pipeline/runner.py — PipelineRunner class.

Run with: python3 tests/test_pipeline_runner.py
"""

import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))

from pipelines.runner import PipelineRunner


def test_runner_initialization():
    """Test that PipelineRunner initializes with correct defaults."""
    mock_term = MagicMock()
    
    runner = PipelineRunner(term=mock_term)
    
    assert runner.term is mock_term
    assert runner.continue_on_error is True
    assert runner.max_retries == 3


def test_runner_load_pipeline_success():
    """Test loading a valid pipeline script from temp directory."""
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create a simple pipeline file
        pipeline_path = Path(tmpdir) / "test_pipeline.py"
        pipeline_path.write_text("""
def setup(ctx):
    ctx.set_variable("status", "ok")

def run(ctx):
    pass
""")
        
        result = runner.load_pipeline_from_dir(test_pipeline="test_pipeline.py", pipelines_dir=Path(tmpdir))
        
        assert result is not None
        assert 'setup' in result
        assert 'run' in result


def test_runner_load_pipeline_not_found():
    """Test loading a non-existent pipeline raises FileNotFoundError."""
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            runner.load_pipeline_from_dir(test_pipeline="nonexistent.py", pipelines_dir=Path(tmpdir))
            assert False, "Should have raised FileNotFoundError"
        except FileNotFoundError as e:
            assert "nonexistent.py" in str(e)


def test_runner_load_pipeline_syntax_error():
    """Test loading a pipeline with syntax errors raises ValueError."""
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create a broken pipeline file
        pipeline_path = Path(tmpdir) / "broken.py"
        pipeline_path.write_text("def broken(")
        
        try:
            runner.load_pipeline_from_dir(test_pipeline="broken.py", pipelines_dir=Path(tmpdir))
            assert False, "Should have raised ValueError"
        except ValueError as e:
            assert "syntax error" in str(e).lower()


def test_runner_execute_pipeline_success():
    """Test executing a pipeline that runs successfully."""
    mock_term = MagicMock()
    
    runner = PipelineRunner(term=mock_term)
    result = runner.execute_pipeline({'run': lambda ctx: None}, pipeline_name="dummy")
    
    assert result["success"] is True
    assert result["pipeline"] == "dummy"


def test_runner_execute_with_setup_and_run():
    """Test executing a pipeline with both setup and run phases."""
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term)
    
    def dummy_setup(ctx):
        ctx.set_variable("status", "running")
    
    result = runner.execute_pipeline(
        {'setup': dummy_setup, 'run': lambda ctx: None},
        pipeline_name="full"
    )
    
    assert result["success"] is True


def test_runner_execute_pipeline_failure():
    """Test executing a pipeline that raises an exception."""
    mock_term = MagicMock()
    
    def failing_setup(ctx):
        raise RuntimeError("Pipeline crashed")
    
    runner = PipelineRunner(term=mock_term)
    result = runner.execute_pipeline({'run': failing_setup}, pipeline_name="failing", continue_on_error=True)
    
    assert result["success"] is False
    assert "Pipeline crashed" in str(result.get("error", ""))


def test_runner_execute_with_retry():
    """Test that retry logic works on transient failures."""
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=2)
    
    call_count = [0]
    
    def flaky_run(ctx):
        call_count[0] += 1
        if call_count[0] < 2:
            raise ConnectionError("Network blip")
    
    result = runner.execute_pipeline({'run': flaky_run}, pipeline_name="flaky", continue_on_error=True)
    
    assert result["success"] is True
    assert call_count[0] == 2


def test_runner_execute_retry_exhausted():
    """Test that retry exhaustion records error and continues."""
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=1)
    
    def always_fails(ctx):
        raise ConnectionError("Persistent failure")
    
    result = runner.execute_pipeline({'run': always_fails}, pipeline_name="always-fail", continue_on_error=True)
    
    assert result["success"] is False


def test_runner_execute_continue_on_error_false():
    """Test that continue_on_error=False stops on first failure."""
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term, max_retries=1)
    
    def fails(ctx):
        raise RuntimeError("First step failed")
    
    try:
        result = runner.execute_pipeline({'run': fails}, pipeline_name="stop-early", continue_on_error=False)
        assert False, "Should have raised exception"
    except RuntimeError as e:
        assert "First step failed" in str(e)


def test_runner_list_pipelines():
    """Test listing available pipelines in a directory."""
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create some pipeline files
        Path(tmpdir, "dummy_pipeline.py").write_text("def run(ctx): pass")
        Path(tmpdir, "autonomous.py").write_text("def run(ctx): pass")
        Path(tmpdir, "__init__.py").write_text("")
        
        pipelines = runner.list_pipelines(Path(tmpdir))
        
        assert len(pipelines) == 2
        assert "dummy_pipeline.py" in pipelines
        assert "autonomous.py" in pipelines


def test_runner_list_pipelines_empty():
    """Test listing pipelines when directory has no .py files."""
    mock_term = MagicMock()
    runner = PipelineRunner(term=mock_term)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create a non-.py file
        Path(tmpdir, "readme.txt").write_text("hello")
        
        pipelines = runner.list_pipelines(Path(tmpdir))
        
        assert len(pipelines) == 0


def test_runner_run_all_pipelines():
    """Test running all available pipelines."""
    mock_term = MagicMock()
    
    runner = PipelineRunner(term=mock_term)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create a valid pipeline
        Path(tmpdir, "good.py").write_text("""
def setup(ctx):
    ctx.set_variable("status", "ok")

def run(ctx):
    pass
""")
        
        results = runner.run_all_pipelines(Path(tmpdir))
        
        assert len(results) == 1
        assert results[0]["success"] is True


if __name__ == "__main__":
    print("Running tests...")
    
    test_runner_initialization()
    print("✓ test_runner_initialization passed")
    
    test_runner_load_pipeline_success()
    print("✓ test_runner_load_pipeline_success passed")
    
    test_runner_load_pipeline_not_found()
    print("✓ test_runner_load_pipeline_not_found passed")
    
    test_runner_load_pipeline_syntax_error()
    print("✓ test_runner_load_pipeline_syntax_error passed")
    
    test_runner_execute_pipeline_success()
    print("✓ test_runner_execute_pipeline_success passed")
    
    test_runner_execute_pipeline_failure()
    print("✓ test_runner_execute_pipeline_failure passed")
    
    test_runner_execute_with_retry()
    print("✓ test_runner_execute_with_retry passed")
    
    test_runner_execute_retry_exhausted()
    print("✓ test_runner_execute_retry_exhausted passed")
    
    test_runner_execute_continue_on_error_false()
    print("✓ test_runner_execute_continue_on_error_false passed")
    
    test_runner_list_pipelines()
    print("✓ test_runner_list_pipelines passed")
    
    test_runner_list_pipelines_empty()
    print("✓ test_runner_list_pipelines_empty passed")
    
    test_runner_run_all_pipelines()
    print("✓ test_runner_run_all_pipelines passed")
    
    print("\nAll tests passed!")
