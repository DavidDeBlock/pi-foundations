#!/usr/bin/env python3
"""
github_client.py — GitHub API wrappers for Maestro orchestrator.

Wraps the `gh` CLI with consistent patterns for issue fetching, 
comment posting, and label management.

Usage:
    from lib.github_client import GithubClient
    
    client = GithubClient()
    issues = await client.fetch_issues_by_label("needs-triage")
    await client.post_phase_comment(issue_num=42, phase="builder", status="success", details="Implemented feature X")
"""

import subprocess
import sys
import json
import re
from pathlib import Path
from dataclasses import dataclass
from typing import Optional


@dataclass
class Issue:
    number: int
    title: str
    body: str
    labels: list[str]
    comments: list[dict]  # List of comment dicts with 'body' and 'created_at'
    created_at: Optional[str] = None

PHASE_OUTPUT_PATTERN = re.compile(
    r"---\s*\n### PHASE_OUTPUT:\s*(success|rejected|system_error)\s*\n(.+?)\n### END_PHASE_OUTPUT\s*\n---",
    re.DOTALL
)


class GithubClient:
    """Wrapper around gh CLI for GitHub API interactions."""
    
    def __init__(self, repo_override: Optional[str] = None, timeout: int = 30):
        self.repo = repo_override or self._detect_repo()
        self.timeout = timeout
    
    def _run_gh(self, args: list[str], capture_output: bool = True) -> tuple[bool, str]:
        """Execute a gh CLI command and return (success, output)."""
        cmd = ["gh"] + args
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self.timeout
            )
            
            if result.returncode == 0:
                return True, result.stdout.strip()
            else:
                error_msg = result.stderr.strip() or f"gh command failed (exit {result.returncode})"
                print(f"[github] ERROR: {error_msg}", file=sys.stderr)
                return False, error_msg
                
        except subprocess.TimeoutExpired:
            error_msg = f"gh command timed out after {self.timeout}s"
            print(f"[github] TIMEOUT: {error_msg}", file=sys.stderr)
            return False, error_msg
        except FileNotFoundError:
            error_msg = "gh CLI not found in PATH"
            print(f"[github] ERROR: {error_msg}", file=sys.stderr)
            return False, error_msg
    
    def _detect_repo(self) -> str:
        """Detect the GitHub repository from git remote or gh config."""
        # Try git remote first
        try:
            result = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                url = result.stdout.strip()
                # Extract OWNER/REPO from GitHub URL
                match = re.search(r'github\.com[:/]([^/.]+\/[^/.]+?)(?:\.git)?$', url)
                if match:
                    return match.group(1)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
        
        # Fallback to gh config
        success, output = self._run_gh(["config", "get", "defaultRepo"])
        if success and output:
            return output.strip()
        
        raise RuntimeError("Could not detect GitHub repository. Set REPO_OVERRIDE or configure git remote.")
    
    def fetch_issue(self, issue_num: int) -> Optional[Issue]:
        """Fetch a single issue by number with full details.
        
        Args:
            issue_num: GitHub issue number to fetch.
            
        Returns:
            Issue object with body, comments, labels, or None on failure.
        """
        success, raw_output = self._run_gh([
            "issue", "view", str(issue_num),
            "--repo", self.repo,
            "--json", "body,title,number,labels,comments,createdAt"
        ])
        
        if not success:
            print(f"[github] ERROR fetching issue #{issue_num}: {raw_output}", file=sys.stderr)
            return None
        
        try:
            data = json.loads(raw_output)
            
            # Parse comments
            comments = []
            for comment in data.get('comments', []):
                comments.append({
                    'body': comment.get('body', ''),
                    'created_at': comment.get('created_at', '')
                })
            
            labels = [l.get('name', '') if isinstance(l, dict) else str(l)
                      for l in data.get('labels', [])]
            
            return Issue(
                number=data['number'],
                title=data['title'],
                body=data.get('body', ''),
                labels=labels,
                comments=comments,
                created_at=data.get('createdAt')
            )
        except (json.JSONDecodeError, KeyError) as e:
            print(f"[github] ERROR parsing issue #{issue_num}: {e}", file=sys.stderr)
            return None
    
    def fetch_issues_by_label(self, label: str) -> list[Issue]:
        """Fetch all open issues with a specific label, sorted by number.
        
        Returns full issue data including body text. For large bodies,
        consider using fetch_issue() individually to avoid payload limits.
        
        Args:
            label: GitHub label to filter by (e.g., 'needs-triage').
            
        Returns:
            List of Issue objects sorted by number ascending.
        """
        success, raw_output = self._run_gh([
            "issue", "list",
            "--label", label,
            "--json", "number,title,body,state,labels",
            "--state", "open",
            "--limit", "100"
        ])
        
        if not success:
            print(f"[github] ERROR fetching issues with label '{label}': {raw_output}", file=sys.stderr)
            return []
        
        try:
            data = json.loads(raw_output)
            issues = sorted(data, key=lambda x: int(x['number']))
            
            result = []
            for issue_data in issues:
                labels = [l.get('name', '') if isinstance(l, dict) else str(l)
                          for l in issue_data.get('labels', [])]
                result.append(Issue(
                    number=issue_data['number'],
                    title=issue_data['title'],
                    body=issue_data.get('body', ''),
                    labels=labels,
                    comments=[],
                    created_at=None
                ))
            
            print(f"[github] Found {len(result)} open issues with label '{label}'")
            return result
        except json.JSONDecodeError as e:
            print(f"[github] ERROR parsing issue list: {e}", file=sys.stderr)
            return []
    
    def find_issue_by_label(self, label: str) -> Optional[Issue]:
        """Find a single specific issue by label (returns the first match)."""
        issues = self.fetch_issues_by_label(label)
        if issues:
            return issues[0]
        return None
    
    def create_issue(self, title: str, body: str, labels: list[str] = None) -> Optional[int]:
        """Create a new GitHub issue."""
        cmd_args = ["issue", "create",
                    "--repo", self.repo,
                    "--title", title,
                    "--body", body]
        
        if labels:
            for label in labels:
                cmd_args.append("--label")
                cmd_args.append(label)
        
        success, raw_output = self._run_gh(cmd_args)
        if not success:
            print(f"[github] ERROR creating issue: {raw_output}", file=sys.stderr)
            return None
        
        # Extract number from output (e.g., "Created issue #42")
        try:
            import re
            match = re.search(r'#(\d+)', raw_output)
            if match:
                print(f"[github] Created new issue #{match.group(1)}")
                return int(match.group(1))
        except Exception as e:
            print(f"[github] WARNING: Could not parse issue number from output: {e}")
        
        return None
    
    def close_issue(self, issue_num: int) -> bool:
        """Close an existing GitHub issue."""
        success, raw_output = self._run_gh([
            "issue", "close", str(issue_num),
            "--repo", self.repo
        ])
        
        if success:
            print(f"[github] Closed issue #{issue_num}")
        else:
            print(f"[github] ERROR closing issue #{issue_num}: {raw_output}", file=sys.stderr)
        return success
    
    def update_issue_labels(self, issue_num: int, add_labels: list[str] = None, remove_labels: list[str] = None) -> bool:
        """Add or remove labels from an issue."""
        cmd_args = ["issue", "edit", str(issue_num),
                    "--repo", self.repo]
        
        if add_labels:
            for label in add_labels:
                cmd_args.append("--add-label")
                cmd_args.append(label)
        
        if remove_labels:
            for label in remove_labels:
                cmd_args.append("--remove-label")
                cmd_args.append(label)
        
        success, raw_output = self._run_gh(cmd_args)
        return success
    
    def post_comment(self, issue_num: int, body: str) -> bool:
        """Post a comment on an issue."""
        success, output = self._run_gh([
            "issue", "comment", str(issue_num),
            "--repo", self.repo,
            "--body", body
        ])
        
        if success:
            print(f"[github] Posted comment on #{issue_num}")
        else:
            print(f"[github] ERROR posting comment on #{issue_num}: {output}", file=sys.stderr)
        
        return success
    
    def post_phase_comment(self, issue_num: int, phase: str, status: str, details: str = "") -> bool:
        """Post a strictly-formatted phase output comment."""
        comment_body = f"""---
### PHASE_OUTPUT: {status}
{phase}: {details}
### END_PHASE_OUTPUT
---

*Posted by Maestro orchestrator at {self._get_timestamp()}*"""
        
        return self.post_comment(issue_num, comment_body)
    
    def update_labels(self, issue_num: int, action: str = "success") -> bool:
        """Update labels based on phase outcome."""
        if action == "success":
            # Remove processing label, add success label
            success1, _ = self._run_gh([
                "issue", "edit", str(issue_num),
                "--repo", self.repo,
                "--remove-label", "needs-triage"  # Adjust based on your config
            ])
            
            success2, _ = self._run_gh([
                "issue", "edit", str(issue_num),
                "--repo", self.repo,
                "--add-label", "awaiting-manual-check"
            ])
            
            return success1 and success2
            
        elif action == "fail":
            # Add failure label, remove processing label
            success1, _ = self._run_gh([
                "issue", "edit", str(issue_num),
                "--repo", self.repo,
                "--add-label", "failed-slice"
            ])
            
            success2, _ = self._run_gh([
                "issue", "edit", str(issue_num),
                "--repo", self.repo,
                "--remove-label", "needs-triage"
            ])
            
            return success1 and success2
        
        return False
    
    def fetch_builder_comment(self, issue_num: int) -> Optional[str]:
        """Fetch the last [BUILDER] comment from an issue."""
        issue = self.fetch_issue(issue_num)
        if not issue:
            return None
        
        # Search comments in reverse order for the most recent builder comment
        for comment in reversed(issue.comments):
            body = comment.get('body', '')
            if '[BUILDER]' in body or '### PHASE_OUTPUT:' in body:
                return body
        
        return None
    
    def fetch_last_phase_output(self, issue_num: int) -> Optional[dict]:
        """Extract the last phase output from GitHub comments."""
        issue = self.fetch_issue(issue_num)
        if not issue:
            return None
        
        # Search comments in reverse order
        for comment in reversed(issue.comments):
            body = comment.get('body', '')
            match = PHASE_OUTPUT_PATTERN.search(body)
            if match:
                status = match.group(1).strip()
                details = match.group(2).strip()
                return {"status": status, "details": details}
        
        return None
    
    def _get_timestamp(self) -> str:
        """Get current timestamp in ISO format."""
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()
