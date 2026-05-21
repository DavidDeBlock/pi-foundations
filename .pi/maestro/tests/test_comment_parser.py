import sys
from pathlib import Path

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from comment_parser import parse_phase_output


def test_parse_success():
    """Test parsing a success phase output."""
    comment = """---
### PHASE_OUTPUT: success
builder: Implemented TodoFeature.tsx and routes. All tests passing.
### END_PHASE_OUTPUT
---"""
    result = parse_phase_output(comment)
    assert result is not None
    assert result["status"] == "success"
    assert "TodoFeature" in result["details"]


def test_parse_rejected():
    """Test parsing a rejected phase output."""
    comment = """---
### PHASE_OUTPUT: rejected
reviewer: 11 `as` assertions found. Fix priority #1: TodoFeature.tsx line 14.
### END_PHASE_OUTPUT
---"""
    result = parse_phase_output(comment)
    assert result is not None
    assert result["status"] == "rejected"
    assert "TodoFeature" in result["details"]


def test_parse_no_match():
    """Test parsing a comment without the phase output block."""
    comment = "Just some random text\nNo special formatting here."
    result = parse_phase_output(comment)
    assert result is None


if __name__ == "__main__":
    print("Running tests...")
    test_parse_success()
    print("✓ test_parse_success passed")
    
    test_parse_rejected()
    print("✓ test_parse_rejected passed")
    
    test_parse_no_match()
    print("✓ test_parse_no_match passed")
    
    print("\nAll tests passed!")
