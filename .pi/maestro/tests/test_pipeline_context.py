#!/usr/bin/env python3
"""
Tests for pipeline/context.py — PipelineContext class.

Run with: python3 tests/test_pipeline_context.py
"""

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock, PropertyMock

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))

from pipelines.context import PipelineContext


def test_context_initialization():
    """Test that PipelineContext initializes with terminal and github client."""
    mock_term = MagicMock()
    mock_gh = MagicMock()
    
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    assert ctx.term is mock_term
    assert ctx.github is mock_gh
    assert ctx.variables == {}
    assert ctx.errors == []
    assert ctx.completed_steps == 0


def test_context_set_variable():
    """Test setting a context variable."""
    ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
    
    ctx.set_variable("key", "value")
    
    assert ctx.variables["key"] == "value"


def test_context_get_variable_default():
    """Test getting a missing variable returns default."""
    ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
    
    result = ctx.get_variable("missing", default="fallback")
    
    assert result == "fallback"


def test_context_get_existing_variable():
    """Test getting an existing variable."""
    ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
    ctx.set_variable("key", "value")
    
    result = ctx.get_variable("key")
    
    assert result == "value"


def test_context_record_error():
    """Test recording an error in context."""
    mock_term = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=MagicMock())
    
    ctx.record_error("step-1", "Something went wrong")
    
    assert len(ctx.errors) == 1
    assert ctx.errors[0]["step"] == "step-1"
    assert ctx.errors[0]["message"] == "Something went wrong"


def test_context_record_error_prints_to_terminal():
    """Test that recording an error prints to terminal."""
    mock_term = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=MagicMock())
    
    ctx.record_error("step-1", "Error message")
    
    mock_term.failure.assert_called_once_with("[pipeline] step-1: Error message")


def test_context_run_flow_calls_flow_engine():
    """Test that run_flow calls flow_engine.run_flow_on_issue."""
    from unittest.mock import patch
    
    mock_term = MagicMock()
    mock_gh = MagicMock()
    ctx = PipelineContext(term=mock_term, gh_client=mock_gh)
    
    with patch('flow_engine.run_flow_on_issue') as mock_run:
        mock_run.return_value = True
        result = ctx.run_flow("builder-reviewer", 42)
        
        assert result is True
        mock_run.assert_called_once()
        call_args = mock_run.call_args
        assert call_args[1]['term'] is mock_term
        assert call_args[1]['gh_client'] is mock_gh
        assert call_args[1]['flow_name'] == "builder-reviewer"
        assert call_args[1]['issue_num'] == 42


def test_context_artifact_write_in_memory():
    """Test writing small artifact stores it in context variables."""
    ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
    
    # Small data (<50KB) should go to memory
    small_data = "x" * 1000
    result = ctx.artifact_write("small-artifact", small_data, force_file=False)
    
    assert result == ":memory:"
    assert "artifact:small-artifact" in ctx.variables


def test_context_artifact_read_in_memory():
    """Test reading a small artifact from memory."""
    ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
    ctx.set_variable("artifact:small-artifact", "test data")
    
    result = ctx.artifact_read("small-artifact")
    
    assert result == "test data"


def test_context_artifact_read_missing():
    """Test reading a missing artifact returns None."""
    ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
    
    result = ctx.artifact_read("nonexistent")
    
    assert result is None


def test_context_artifact_write_large_blob_to_file():
    """Test writing large artifact (>50KB) writes to disk."""
    import tempfile
    from pathlib import Path
    
    # Use a temp dir for artifacts to avoid polluting the real directory
    with tempfile.TemporaryDirectory() as tmpdir:
        ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
        ctx.ARTIFACT_FILE_DIR = Path(tmpdir) / "artifacts"
        
        # Large data (>50KB) should go to file
        large_data = "x" * (60 * 1024)  # 60KB
        result = ctx.artifact_write("large-artifact", large_data)
        
        assert result != ":memory:"
        assert Path(result).exists()
        
        # Verify file content
        with open(result) as f:
            content = f.read()
        assert len(content) == 60 * 1024


def test_context_artifact_read_from_file():
    """Test reading a large artifact from disk."""
    import tempfile
    from pathlib import Path
    
    with tempfile.TemporaryDirectory() as tmpdir:
        ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
        ctx.ARTIFACT_FILE_DIR = Path(tmpdir) / "artifacts"
        
        # Write large data to file first
        large_data = "y" * (55 * 1024)
        path = ctx.artifact_write("readable-large", large_data)
        
        # Read it back
        result = ctx.artifact_read("readable-large")
        
        assert result == large_data


def test_context_artifact_force_file():
    """Test force_file=True writes even small data to disk."""
    import tempfile
    from pathlib import Path
    
    with tempfile.TemporaryDirectory() as tmpdir:
        ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
        ctx.ARTIFACT_FILE_DIR = Path(tmpdir) / "artifacts"
        
        # Small data but force_file=True should go to file
        small_data = "small"
        result = ctx.artifact_write("forced-file", small_data, force_file=True)
        
        assert result != ":memory:"
        assert Path(result).exists()


def test_context_artifact_write_serializes_dict():
    """Test that non-string data is serialized to JSON."""
    ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
    
    data = {"key": "value", "nested": {"a": 1}}
    result = ctx.artifact_write("dict-artifact", data)
    
    assert result == ":memory:"
    stored = ctx.variables["artifact:dict-artifact"]
    assert stored == data


def test_context_artifact_read_from_file_json():
    """Test reading JSON-serialized dict from file."""
    import tempfile
    from pathlib import Path
    
    with tempfile.TemporaryDirectory() as tmpdir:
        ctx = PipelineContext(term=MagicMock(), gh_client=MagicMock())
        ctx.ARTIFACT_FILE_DIR = Path(tmpdir) / "artifacts"
        
        # Write a dict (will be JSON-serialized)
        data = {"issues": [108, 106], "status": "open"}
        path = ctx.artifact_write("json-artifact", data)
        
        # Read it back
        result = ctx.artifact_read("json-artifact")
        
        assert result == data


if __name__ == "__main__":
    print("Running tests...")
    
    test_context_initialization()
    print("✓ test_context_initialization passed")
    
    test_context_set_variable()
    print("✓ test_context_set_variable passed")
    
    test_context_get_variable_default()
    print("✓ test_context_get_variable_default passed")
    
    test_context_get_existing_variable()
    print("✓ test_context_get_existing_variable passed")
    
    test_context_record_error()
    print("✓ test_context_record_error passed")
    
    test_context_record_error_prints_to_terminal()
    print("✓ test_context_record_error_prints_to_terminal passed")
    
    test_context_run_flow_calls_flow_engine()
    print("✓ test_context_run_flow_calls_flow_engine passed")
    
    test_context_artifact_write_in_memory()
    print("✓ test_context_artifact_write_in_memory passed")
    
    test_context_artifact_read_in_memory()
    print("✓ test_context_artifact_read_in_memory passed")
    
    test_context_artifact_read_missing()
    print("✓ test_context_artifact_read_missing passed")
    
    test_context_artifact_write_large_blob_to_file()
    print("✓ test_context_artifact_write_large_blob_to_file passed")
    
    test_context_artifact_read_from_file()
    print("✓ test_context_artifact_read_from_file passed")
    
    test_context_artifact_force_file()
    print("✓ test_context_artifact_force_file passed")
    
    test_context_artifact_write_serializes_dict()
    print("✓ test_context_artifact_write_serializes_dict passed")
    
    test_context_artifact_read_from_file_json()
    print("✓ test_context_artifact_read_from_file_json passed")
    
    print("\nAll tests passed!")
