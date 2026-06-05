#!/usr/bin/env python3
"""
Tests for lib/github_client.py — GithubClient class.

Run with: python3 tests/test_github_client.py
"""

import sys
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))

from lib.github_client import GithubClient, Issue


def test_github_client_fetch_issues_by_label_success():
    """Test fetching issues by label returns parsed Issue objects."""
    mock_gh = MagicMock()
    
    # Mock successful gh CLI response (gh already filters by label)
    mock_output = json.dumps([
        {
            "number": 108,
            "title": "Implement pipeline data layer",
            "body": "This is the issue body text.",
            "state": "open",
            "labels": [{"name": "ready-for-agent"}, {"name": "pipeline"}]
        },
        {
            "number": 106,
            "title": "Autonomous pipeline engine PRD",
            "body": "Parent issue body.",
            "state": "open",
            "labels": [{"name": "ready-for-agent"}, {"name": "prd"}]
        }
    ])
    
    mock_gh.return_value = (True, mock_output)
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        issues = client.fetch_issues_by_label("ready-for-agent")
    
    assert len(issues) == 2
    assert isinstance(issues[0], Issue)
    # Should be sorted by number ascending
    assert issues[0].number == 106
    assert issues[1].number == 108
    assert "ready-for-agent" in issues[0].labels


def test_github_client_fetch_issues_by_label_empty():
    """Test fetching by label with no matching issues returns empty list."""
    mock_gh = MagicMock(return_value=(True, json.dumps([])))
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        issues = client.fetch_issues_by_label("nonexistent-label")
    
    assert issues == []


def test_github_client_fetch_issues_by_label_failure():
    """Test fetching by label when gh CLI fails returns empty list."""
    mock_gh = MagicMock(return_value=(False, "auth error"))
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        issues = client.fetch_issues_by_label("ready-for-agent")
    
    assert issues == []


def test_github_client_fetch_issue_success():
    """Test fetching a single issue by number returns full Issue object."""
    mock_gh = MagicMock()
    
    mock_output = json.dumps({
        "number": 108,
        "title": "Implement pipeline data layer",
        "body": "Full body text with details.",
        "labels": [{"name": "pipeline"}, {"name": "builder"}],
        "comments": [
            {"body": "First comment", "created_at": "2024-01-01T00:00:00Z"},
            {"body": "Second comment", "created_at": "2024-01-02T00:00:00Z"}
        ],
        "createdAt": "2024-01-01T00:00:00Z"
    })
    
    mock_gh.return_value = (True, mock_output)
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        issue = client.fetch_issue(108)
    
    assert issue is not None
    assert isinstance(issue, Issue)
    assert issue.number == 108
    assert issue.title == "Implement pipeline data layer"
    assert issue.body == "Full body text with details."
    assert len(issue.comments) == 2
    assert issue.comments[0]["body"] == "First comment"


def test_github_client_fetch_issue_not_found():
    """Test fetching a non-existent issue returns None."""
    mock_gh = MagicMock(return_value=(False, "Issue not found"))
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        issue = client.fetch_issue(999)
    
    assert issue is None


def test_github_client_fetch_issue_parse_error():
    """Test fetching an issue with malformed JSON returns None."""
    mock_gh = MagicMock(return_value=(True, "not valid json"))
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        issue = client.fetch_issue(108)
    
    assert issue is None


def test_github_client_fetch_issues_sorted_by_number():
    """Test that fetched issues are sorted by number ascending."""
    mock_gh = MagicMock()
    
    # Return in non-sorted order
    mock_output = json.dumps([
        {"number": 110, "title": "Third", "body": "", "state": "open", "labels": []},
        {"number": 106, "title": "First", "body": "", "state": "open", "labels": []},
        {"number": 108, "title": "Second", "body": "", "state": "open", "labels": []}
    ])
    
    mock_gh.return_value = (True, mock_output)
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        issues = client.fetch_issues_by_label("any-label")
    
    assert len(issues) == 3
    assert issues[0].number == 106
    assert issues[1].number == 108
    assert issues[2].number == 110


def test_github_client_find_issue_by_label():
    """Test find_issue_by_label returns first match or None."""
    mock_gh = MagicMock()
    
    # No matching issues
    mock_gh.return_value = (True, json.dumps([]))
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        result = client.find_issue_by_label("nonexistent")
    
    assert result is None


def test_github_client_post_comment():
    """Test posting a comment returns success."""
    mock_gh = MagicMock(return_value=(True, "Comment created"))
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        result = client.post_comment(108, "Test comment")
    
    assert result is True
    # Verify gh command was called correctly
    call_args = mock_gh.call_args[0][0]
    assert "issue" in call_args
    assert "comment" in call_args
    assert "108" in call_args


def test_github_client_post_phase_comment():
    """Test posting a phase output comment creates formatted body."""
    mock_gh = MagicMock(return_value=(True, "Comment created"))
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        result = client.post_phase_comment(108, "builder", "success", "Implemented feature X")
    
    assert result is True
    # Verify the comment body contains phase markers
    call_args = mock_gh.call_args[0][0]
    # The last argument should be the comment body (after --body)
    body_idx = call_args.index("--body") + 1 if "--body" in call_args else -1
    assert body_idx > 0, "Expected --body flag in gh command"
    comment_body = call_args[body_idx]
    
    assert "PHASE_OUTPUT: success" in comment_body
    assert "builder:" in comment_body


def test_github_client_fetch_builder_comment():
    """Test fetching the last builder comment from an issue."""
    mock_gh = MagicMock()
    
    # Mock fetch_issue to return comments with a builder comment
    def mock_fetch(issue_num):
        return Issue(
            number=issue_num,
            title="Test",
            body="",
            labels=[],
            comments=[
                {"body": "Regular comment", "created_at": "2024-01-01"},
                {"body": "[BUILDER] Implemented feature X\n### PHASE_OUTPUT: success", "created_at": "2024-01-02"}
            ]
        )
    
    client = GithubClient()
    with patch.object(client, 'fetch_issue', mock_fetch):
        result = client.fetch_builder_comment(108)
    
    assert "[BUILDER]" in result


def test_github_client_fetch_last_phase_output():
    """Test extracting phase output from issue comments."""
    mock_gh = MagicMock()
    
    def mock_fetch(issue_num):
        return Issue(
            number=issue_num,
            title="Test",
            body="",
            labels=[],
            comments=[
                {"body": "---\n### PHASE_OUTPUT: rejected\nSome details here\n### END_PHASE_OUTPUT\n---", "created_at": "2024-01-01"}
            ]
        )
    
    client = GithubClient()
    with patch.object(client, 'fetch_issue', mock_fetch):
        result = client.fetch_last_phase_output(108)
    
    assert result is not None
    assert result["status"] == "rejected"


def test_github_client_create_issue():
    """Test creating a new issue returns the issue number."""
    mock_gh = MagicMock(return_value=(True, "Created issue #42"))
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        result = client.create_issue("New feature", "Feature description", ["enhancement"])
    
    assert result == 42


def test_github_client_close_issue():
    """Test closing an issue returns success."""
    mock_gh = MagicMock(return_value=(True, ""))
    
    client = GithubClient()
    with patch.object(client, '_run_gh', mock_gh):
        result = client.close_issue(108)
    
    assert result is True


if __name__ == "__main__":
    print("Running tests...")
    
    test_github_client_fetch_issues_by_label_success()
    print("✓ test_github_client_fetch_issues_by_label_success passed")
    
    test_github_client_fetch_issues_by_label_empty()
    print("✓ test_github_client_fetch_issues_by_label_empty passed")
    
    test_github_client_fetch_issues_by_label_failure()
    print("✓ test_github_client_fetch_issues_by_label_failure passed")
    
    test_github_client_fetch_issue_success()
    print("✓ test_github_client_fetch_issue_success passed")
    
    test_github_client_fetch_issue_not_found()
    print("✓ test_github_client_fetch_issue_not_found passed")
    
    test_github_client_fetch_issue_parse_error()
    print("✓ test_github_client_fetch_issue_parse_error passed")
    
    test_github_client_fetch_issues_sorted_by_number()
    print("✓ test_github_client_fetch_issues_sorted_by_number passed")
    
    test_github_client_find_issue_by_label()
    print("✓ test_github_client_find_issue_by_label passed")
    
    test_github_client_post_comment()
    print("✓ test_github_client_post_comment passed")
    
    test_github_client_post_phase_comment()
    print("✓ test_github_client_post_phase_comment passed")
    
    test_github_client_fetch_builder_comment()
    print("✓ test_github_client_fetch_builder_comment passed")
    
    test_github_client_fetch_last_phase_output()
    print("✓ test_github_client_fetch_last_phase_output passed")
    
    test_github_client_create_issue()
    print("✓ test_github_client_create_issue passed")
    
    test_github_client_close_issue()
    print("✓ test_github_client_close_issue passed")
    
    print("\nAll tests passed!")
