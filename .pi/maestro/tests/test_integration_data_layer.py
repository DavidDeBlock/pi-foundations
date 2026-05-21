#!/usr/bin/env python3
"""
Integration test for issue #108: Pipeline data interaction layer.

Demonstrates the complete workflow:
1. Fetch open issues by label from GitHub (mocked)
2. Store fetched issues as artifacts (hybrid memory/file storage)
3. Display list of fetched issues via terminal output

Run with: python3 tests/test_integration_data_layer.py
"""

import sys
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent.parent))

from pipelines.context import PipelineContext
from pipelines.dashboard import PipelineDashboard
from lib.terminal import Terminal


def test_integration_fetch_store_display_issues():
    """Integration: fetch issues by label → store as artifacts → display."""
    
    # ── Setup ────────────────────────────────────────────────────────
    term = Terminal(verbose=True)
    dashboard = PipelineDashboard(term=term)
    
    from lib.github_client import GithubClient
    
    client = GithubClient()
    
    # Mock GitHub response: 3 open issues with "needs-triage" label
    mock_output = json.dumps([
        {
            "number": 106,
            "title": "[PRD] Autonomous Pipeline Engine",
            "body": "Build a pipeline layer for the Maestro orchestrator...",
            "state": "open",
            "labels": [{"name": "needs-triage"}, {"name": "prd"}]
        },
        {
            "number": 107,
            "title": "[PRD] Pipeline Engine Foundation & Context API",
            "body": "Build the core pipeline engine with context API...",
            "state": "open",
            "labels": [{"name": "needs-triage"}, {"name": "prd"}]
        },
        {
            "number": 108,
            "title": "[PRD] Pipeline Data Interaction Layer",
            "body": "Implement ctx.github methods and hybrid artifact storage...",
            "state": "open",
            "labels": [{"name": "needs-triage"}, {"name": "pipeline"}]
        }
    ])
    
    mock_run_gh = MagicMock(return_value=(True, mock_output))
    
    # ── Create context with mocked GitHub client ─────────────────────
    ctx = PipelineContext(term=term, gh_client=client)
    
    # ── Step 1: Fetch issues by label ────────────────────────────────
    print("\n--- Step 1: Fetching issues by label ---")
    with patch.object(ctx.github, '_run_gh', mock_run_gh):
        issues = ctx.github.fetch_issues_by_label("needs-triage")
    
    assert len(issues) == 3, f"Expected 3 issues, got {len(issues)}"
    assert issues[0].number == 106
    assert issues[2].number == 108
    
    # ── Step 2: Store each issue as an artifact ──────────────────────
    print("\n--- Step 2: Storing issues as artifacts ---")
    
    for issue in issues:
        # Each issue body is stored as an artifact
        path = ctx.artifact_write(
            f"issue-{issue.number}",
            issue.body,
            force_file=True  # PRD bodies are large, always write to file
        )
        
        assert path != ":memory:", f"Issue {issue.number} should be stored in file"
        assert Path(path).exists(), f"Artifact file {path} does not exist"
    
    # Store the list of issue numbers for quick reference (small data → memory)
    ctx.artifact_write("fetched-issue-numbers", [i.number for i in issues])
    
    # ── Step 3: Display fetched issues via terminal ──────────────────
    print("\n--- Step 3: Displaying fetched issues ---")
    
    dashboard.print_header("data-layer-integration")
    dashboard.update_progress(0, total=len(issues))
    
    for i, issue in enumerate(issues):
        # Read back the artifact to verify storage worked
        stored_body = ctx.artifact_read(f"issue-{issue.number}")
        assert stored_body is not None, f"Could not read artifact for issue {issue.number}"
        
        dashboard.record_step(
            step_name=f"#{issue.number}: {issue.title}",
            success=True,
            details=f"Artifact size: {len(stored_body)} chars"
        )
        dashboard.update_progress(i + 1, total=len(issues))
    
    # Display summary
    print("\n--- Fetched Issues Summary ---")
    for issue in issues:
        stored = ctx.artifact_read(f"issue-{issue.number}")
        print(f"  #{issue.number}: {issue.title} ({len(stored)} chars)")
    
    dashboard.print_scorecard("data-layer-integration")
    
    # ── Verify artifact list ─────────────────────────────────────────
    fetched_numbers = ctx.artifact_read("fetched-issue-numbers")
    assert fetched_numbers == [106, 107, 108]
    
    print("\n✅ Integration test passed!")


def test_integration_large_prd_body_storage():
    """Integration: Verify large PRD bodies (>50KB) go to disk."""
    
    term = Terminal(verbose=False)
    mock_gh = MagicMock()
    ctx = PipelineContext(term=term, gh_client=mock_gh)
    
    # Simulate a very large PRD body (128KB — well above 50KB threshold)
    # Generate enough content to exceed the 50KB limit
    sections = []
    for i in range(30):
        section_content = f"## Section {i}\n"
        section_content += "This is detailed technical documentation for section {}.\n".format(i) * 20
        section_content += "Additional notes and implementation details follow.\n" * 15
        sections.append(section_content)
    
    large_prd_body = "# PRD: Large Feature\n\nComprehensive product requirements document.\n\n" + "\n".join(sections)
    
    # Write to artifact (should go to file due to size)
    path = ctx.artifact_write("large-prd", large_prd_body, force_file=False)
    
    assert path != ":memory:", "Large PRD should be stored in file"
    assert Path(path).exists()
    
    # Read back and verify content integrity
    stored = ctx.artifact_read("large-prd")
    assert stored == large_prd_body
    
    print(f"\n✅ Large PRD storage test passed ({len(large_prd_body)} bytes → {path})")


def test_integration_fetch_single_issue():
    """Integration: Fetch single issue by number and store as artifact."""
    
    term = Terminal(verbose=False)
    from lib.github_client import GithubClient
    client = GithubClient()
    
    # Mock fetch_issue response
    mock_output = json.dumps({
        "number": 108,
        "title": "[PRD] Pipeline Data Interaction Layer",
        "body": "Full body of issue #108 with all details...",
        "labels": [{"name": "needs-triage"}, {"name": "pipeline"}],
        "comments": [],
        "createdAt": "2024-05-20T00:00:00Z"
    })
    
    mock_run_gh = MagicMock(return_value=(True, mock_output))
    
    ctx = PipelineContext(term=term, gh_client=client)
    
    # Fetch single issue
    with patch.object(ctx.github, '_run_gh', mock_run_gh):
        issue = ctx.github.fetch_issue(108)
    assert issue is not None
    assert issue.number == 108
    assert "Pipeline Data Interaction" in issue.title
    
    # Store as artifact
    path = ctx.artifact_write(f"issue-{issue.number}", issue.body, force_file=True)
    assert Path(path).exists()
    
    # Verify round-trip
    stored = ctx.artifact_read(f"issue-{issue.number}")
    assert stored == issue.body
    
    print(f"\n✅ Single issue fetch + store test passed!")


if __name__ == "__main__":
    print("=" * 60)
    print("Integration Tests for Issue #108: Pipeline Data Layer")
    print("=" * 60)
    
    test_integration_fetch_store_display_issues()
    test_integration_large_prd_body_storage()
    test_integration_fetch_single_issue()
    
    print("\n" + "=" * 60)
    print("All integration tests passed!")
    print("=" * 60)
