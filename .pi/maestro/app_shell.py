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
from flow_engine import (
    FlowContext,
    PhaseState,
    _flow_from_config,
    _initial_phase,
    load_flow,
    run_flow,
)
from flow_dispatcher import build_flow_context
import flow_logger as _flow_logger


def _run(flow_name: str, issue_num: int, term: Terminal,
         gh: GithubClient, log: "_flow_logger.FlowLogger | None" = None
         ) -> bool:
    """Run a flow on a single issue using the narrow :func:`run_flow` API.

    The dispatching work (load flow → build :class:`FlowContext` → pick
    first phase → call ``run_flow``) is the responsibility of the
    caller now that ``run_flow_on_issue`` has been deleted. This
    helper keeps the three call sites in :class:`MaestroApp`
    one-liners.

    Args:
        flow_name: Name of the flow JSON to load (e.g.
            ``"builder-reviewer"``).
        issue_num: GitHub issue number to run the flow on.
        term: The :class:`Terminal` for verbose output.
        gh: The :class:`GithubClient` for comment / label updates.
        log: Optional :class:`FlowLogger` port. Defaults to a fresh
            :class:`StderrLogger` so terminal output stays
            unchanged.

    Returns:
        ``True`` iff the flow's :class:`FlowOutcome` reports
        ``status == "success"``.
    """
    flow_config = load_flow(flow_name)
    flow = _flow_from_config(flow_config)
    flow_context = build_flow_context(flow, issue_num, gh)
    state = PhaseState(
        current_phase=_initial_phase(flow_config, skip_scout=True),
    )
    _log = log if log is not None else _flow_logger.StderrLogger()
    outcome = run_flow(flow, flow_context, state, term, gh, _log)
    return outcome.status == "success"


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
    
    def _run_pipeline_with_issues(self, flow_name: str, issue_nums: list[int]):
        """Run a pipeline on one or more issues with deterministic label management.

        Uses the PipelineRunner to execute the specified flow through the full-lifecycle
        pipeline (or any pipeline that supports phase callbacks).
        """
        from pipelines.runner import PipelineRunner
        from pipelines.context import PipelineContext

        runner = PipelineRunner(
            term=self.term,
            gh_client=self.gh_client,
            continue_on_error=True,
            max_retries=3,
        )

        # Determine which pipeline to use
        if flow_name == "full-lifecycle":
            pipeline_file = "full-lifecycle.py"
        else:
            # For other flows, fall back to running each issue individually
            success_count = 0
            fail_count = 0
            for num in issue_nums:
                self.term._print_verbose(f"[START] Processing issue #{num} with flow '{flow_name}'")
                try:
                    success = _run(flow_name, num, self.term, self.gh_client)
                    if success:
                        success_count += 1
                    else:
                        fail_count += 1
                except KeyboardInterrupt:
                    print(
                        f"\n{self.term.DIM}⚠️  Interrupted by user.{self.term.RESET}",
                        file=sys.stderr,
                    )
                    sys.exit(130)
            self.term.summary(issues_completed=success_count, issues_failed=fail_count)
            return

        try:
            # Set issue numbers in context for the pipeline to pick up
            ctx = PipelineContext(term=self.term, gh_client=self.gh_client)
            ctx.set_variable("issue_numbers", issue_nums)

            pipeline_func = runner.load_pipeline(pipeline_file)
            result = runner.execute_pipeline(
                pipeline_func,
                pipeline_name=flow_name,
                continue_on_error=True,
            )

            if not result["success"]:
                self.term.warning(
                    f"Pipeline completed with errors: {result.get('error', 'Unknown')}"
                )

        except (FileNotFoundError, ValueError) as e:
            self.term.failure(f"Failed to load pipeline '{pipeline_file}': {e}")
            sys.exit(1)
        except KeyboardInterrupt:
            print(
                f"\n{self.term.DIM}⚠️  Pipeline interrupted by user.{self.term.RESET}",
                file=sys.stderr,
            )
            sys.exit(130)

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
            try:
                success = _run(flow_name, self.args.issue, self.term, self.gh_client)
                if success:
                    self.term.summary(issues_completed=1, issues_failed=0)
                else:
                    self.term.summary(issues_completed=0, issues_failed=1)
            except KeyboardInterrupt:
                print(f"\n{self.term.DIM}⚠️  Interrupted by user.{self.term.RESET}", file=sys.stderr)
                sys.exit(130)

        # --- Batch Issue Mode (--issues) ---
        elif self.args.issues:
            issue_nums = [int(n.strip()) for n in self.args.issues.split(",")]
            self._run_pipeline_with_issues(flow_name, issue_nums)

        # --- Auto Mode (--auto) ---
        elif getattr(self.args, "auto", False):
            self.term.info("Auto mode — fetching needs-triage backlog...")
            issues = self.gh_client.fetch_issues_by_label("needs-triage")
            if not issues:
                self.term.info("No 'needs-triage' issues found. Nothing to do.")
                return
            issue_nums = [issue.number for issue in issues]
            self._run_pipeline_with_issues(flow_name, issue_nums)

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


# Make Terminal colors accessible for app_shell formatting
Terminal.DIM = "\033[2m"
Terminal.GREEN = "\033[0;32m"
Terminal.RESET = "\033[0m"
