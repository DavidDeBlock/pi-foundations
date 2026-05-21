#!/usr/bin/env python3
"""
app_shell.py — High-level workflow manager for Maestro.

Handles:
- CLI argument parsing and mode selection (single issue vs loop)
- Autonomous backlog processing via pipelines/autonomous.py
- Flow switching (builder-reviewer for tickets, gap-check for PRD validation)
- Gap Check logic: parses PRD checkboxes, runs LLM analysis, creates new issues if needed
"""

import json
import sys
import os
from pathlib import Path
import re
import subprocess

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent / "lib"))
sys.path.insert(0, str(Path(__file__).parent))

from terminal import Terminal
from github_client import GithubClient
from flow_engine import run_flow_on_issue


class MaestroApp:
    """Application shell that manages the overall Maestro workflow."""
    
    def __init__(self, args):
        self.args = args
        
        # Load global config
        CONFIG_FILE = Path(__file__).parent / "config.json"
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE) as f:
                self.config = json.load(f)
        else:
            self.config = {
                "repo_override": None,
                "gh_timeout": 30,
                "default_model": "qwen-27b-64k-q8",
                "default_provider": "llama-cpp-3090"
            }
        
        # Initialize terminal and GitHub client
        self.term = Terminal(verbose=True)
        try:
            self.gh_client = GithubClient(
                repo_override=self.config.get("repo_override"),
                timeout=self.config.get("gh_timeout", 30)
            )
        except RuntimeError as e:
            self.term.failure(f"Failed to initialize GitHub client: {e}")
            sys.exit(1)
    
    def run(self):
        """Main entry point for the application shell."""
        import json
        
        flow_name = self.args.flow
        
        # Load flow metadata for header display
        FLOWS_DIR = Path(__file__).parent / "flows"
        flow_file = FLOWS_DIR / f"{flow_name}.json"
        if flow_file.exists():
            with open(flow_file) as f:
                flow_meta = json.load(f)
        else:
            flow_meta = {"name": flow_name, "description": ""}
        
        self.term.heading(flow_meta.get("name", "maestro"))
        if flow_meta.get("description"):
            self.term.info(flow_meta["description"][:100])
        sys.stderr.flush()
        
        # --- Single Issue Mode ---
        if self.args.issue:
            self.term._print_verbose(f"[START] Processing issue #{self.args.issue} with flow '{flow_name}'")
            success = run_flow_on_issue(self.term, self.gh_client, flow_name, self.args.issue)
            if success:
                self.term.summary(issues_completed=1, issues_failed=0)
            else:
                self.term.summary(issues_completed=0, issues_failed=1)
        
        # --- Autonomous Loop Mode (via Pipeline Engine) ---
        else:
            print(f"\n{self.term.DIM}🔄 Entering Autonomous Loop Mode...{self.term.RESET}", file=sys.stderr)
            
            # Load and execute the autonomous pipeline
            from pipelines.runner import PipelineRunner
            
            runner = PipelineRunner(term=self.term, gh_client=self.gh_client, continue_on_error=True, max_retries=3)
            
            try:
                pipeline_func = runner.load_pipeline("autonomous.py")
                result = runner.execute_pipeline(
                    pipeline_func,
                    pipeline_name="autonomous",
                    continue_on_error=True
                )
                
                if not result["success"]:
                    self.term.warning(f"Autonomous pipeline completed with errors: {result.get('error', 'Unknown')}")
                    
            except (FileNotFoundError, ValueError) as e:
                self.term.failure(f"Failed to load autonomous pipeline: {e}")
                sys.exit(1)
            except KeyboardInterrupt:
                print("\n{self.term.YELLOW}⚠️  Autonomous loop interrupted by user.{self.term.RESET}", file=sys.stderr)
                sys.exit(130)


def parse_prd_checkboxes(prd_body: str) -> list[tuple[str, str]]:
    """Parse markdown checkboxes from a PRD body. Returns (status, text)."""
    return re.findall(r'- \[([ x])\] (.+)', prd_body)


def run_prd_audit_loop(term: Terminal, gh_client: GithubClient) -> int:
    """
    Run PRD Audit on ALL open parent-prd issues.
    For each issue: runs the prd-audit flow (Auditor → Generate Issues/Close).
    Returns count of processed PRDs.
    
    Lifecycle rules:
    - Auditor checks code vs PRD. If approved, closes issue.
    - If rejected, generates follow-up issues via /skill:to-prd and closes the parent.
    """
    term._print_verbose("[STEP D] Starting PRD Audit...")
    
    # 1. Find ALL open parent-prd issues
    prd_issues = gh_client.fetch_issues_by_label("parent-prd")
    if not prd_issues:
        print(f"{term.DIM}⚠️ No 'parent-prd' issue found. Skipping PRD Audit.{term.RESET}", file=sys.stderr)
        return 0
    
    processed_count = 0
    
    for prd_issue in prd_issues:
        term._print_verbose(f"\n[AUDIT] Running prd-audit on #{prd_issue.number}: {prd_issue.title}")
        
        try:
            # Run the audit flow. The flow itself handles closing/rejecting logic internally.
            success = run_flow_on_issue(
                term, gh_client, "prd-audit", prd_issue.number
            )
            
            if not success:
                print(f"{term.DIM}[AUDIT] Flow did not complete successfully for #{prd_issue.number}.{term.RESET}", file=sys.stderr)
        except Exception as e:
            term._print_verbose(f"[WARNING] PRD audit failed for #{prd_issue.number}: {e}")
        
        processed_count += 1
    
    return processed_count


# Make Terminal colors accessible for app_shell formatting
Terminal.DIM = "\033[2m"
Terminal.GREEN = "\033[0;32m"
Terminal.RESET = "\033[0m"
