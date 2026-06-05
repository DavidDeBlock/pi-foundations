#!/usr/bin/env python3
"""
autonomous.py — Autonomous Pipeline for Maestro Orchestrator.

Migrates the existing hardcoded autonomous loop from app_shell.py into a
fully functional pipeline script powered by the new engine, context API,
and live dashboard.

Workflow:
  1. Fetch open issues labeled "needs-triage"
  2. Run builder-reviewer flow on each issue (close when done)
  3. After backlog processing, run prd-audit on all open parent-prd issues
  4. Display live progress dashboard with final scorecard summary

Usage:
    # Via PipelineRunner
    from pipelines.runner import PipelineRunner
    runner = PipelineRunner(term=term)
    pipeline = runner.load_pipeline("autonomous.py")
    result = runner.execute_pipeline(pipeline, "autonomous")
    
    # Or run directly (for testing)
    python3 pipelines/autonomous.py
"""

import sys
from pathlib import Path


def setup(ctx):
    """Initialize the autonomous pipeline context.
    
    Sets up the dashboard, loads GitHub client from config, and records
    initial state for tracking.
    """
    # Record pipeline name and start time
    ctx.set_variable("pipeline_name", "autonomous")
    ctx.set_variable("started_at", "now")
    
    if ctx.term:
        ctx.term.info("Autonomous pipeline initialized")


def run(ctx):
    """Execute the autonomous workflow.
    
    Phase 1: Process needs-triage backlog (builder-reviewer flow)
    Phase 2: Run prd-audit on all open parent-prd issues
    Phase 3: Display final scorecard
    
    Uses ctx.github for GitHub operations and ctx.run_flow() for
    flow execution with automatic retry logic.
    """
    term = ctx.term
    gh = ctx.github
    dashboard = None
    
    # ── Initialize Dashboard ────────────────────────────────────────
    
    if term:
        from pipelines.dashboard import PipelineDashboard
        dashboard = PipelineDashboard(term=term)
        dashboard.print_header("autonomous")
    
    # ── Phase 1: Process Needs-Triage Backlog ───────────────────────
    
    if term:
        term._print_verbose("[PHASE 1] Fetching needs-triage backlog...")
    
    # Fetch all open issues with "needs-triage" label
    backlog = gh.fetch_issues_by_label("needs-triage")
    
    if not backlog:
        if term:
            term.info("No issues in 'needs-triage' queue. Skipping backlog processing.")
        if dashboard:
            dashboard.log_event("No needs-triage issues found", "info")
    else:
        total_backlog = len(backlog)
        
        if term:
            term._print_verbose(f"[PHASE 1] Found {total_backlog} issue(s) in backlog")
        
        # Set up progress tracking for this phase
        if dashboard:
            dashboard.set_current_phase("backlog-processing")
            dashboard.update_progress(0, total=total_backlog)
        
        processed_count = 0
        
        for issue in backlog:
            if term:
                term._print_verbose(f"\n[BACKLOG] Processing #{issue.number}: {issue.title}")
            
            # Update dashboard with current issue
            if dashboard:
                dashboard.set_active_issue(issue.number)
                dashboard.log_event(
                    f"Processing #{issue.number}: {issue.title[:60]}",
                    "info"
                )
            
            # Run builder-reviewer flow on this issue
            success = ctx.run_flow("builder-reviewer", issue.number)
            
            if success:
                # Close the issue (removes all labels including needs-triage)
                gh.close_issue(issue.number)
                
                if dashboard:
                    dashboard.record_step(f"#{issue.number}", success=True, details="Builder-reviewer approved")
                    dashboard.log_event(f"#{issue.number} completed ✓", "success")
                
                processed_count += 1
                
                # Update progress bar
                if dashboard:
                    dashboard.update_progress(processed_count, total=total_backlog)
            else:
                # Record failure but continue processing (continue_on_error mode)
                if dashboard:
                    dashboard.record_step(f"#{issue.number}", success=False, details="Flow failed")
                    dashboard.log_event(f"#{issue.number} failed ✗", "failure")
                
                processed_count += 1
                
                if dashboard:
                    dashboard.update_progress(processed_count, total=total_backlog)
        
        # Clear active issue after backlog phase
        if dashboard:
            dashboard.set_active_issue(None)
            dashboard.log_event(
                f"Backlog complete: {processed_count} processed",
                "success" if processed_count > 0 else "info"
            )
    
    # ── Phase 2: PRD Audit on All Open Parent-PRDs ─────────────────
    
    if term:
        term._print_verbose("\n[PHASE 2] Starting PRD Audit...")
    
    # Fetch all open issues with "parent-prd" label
    prds = gh.fetch_issues_by_label("parent-prd")
    
    if not prds:
        if term:
            term.info("No 'parent-prd' issues found. Skipping PRD audit.")
        if dashboard:
            dashboard.log_event("No parent-prd issues found", "info")
    else:
        total_prds = len(prds)
        
        if term:
            term._print_verbose(f"[PHASE 2] Found {total_prds} parent-prd issue(s)")
        
        # Set up progress tracking for this phase
        if dashboard:
            dashboard.set_current_phase("prd-audit")
            dashboard.update_progress(0, total=total_prds)
        
        audited_count = 0
        
        for prd_issue in prds:
            if term:
                term._print_verbose(f"\n[AUDIT] Running prd-audit on #{prd_issue.number}: {prd_issue.title}")
            
            # Update dashboard with current issue
            if dashboard:
                dashboard.set_active_issue(prd_issue.number)
                dashboard.log_event(
                    f"Auditing #{prd_issue.number}: {prd_issue.title[:60]}",
                    "info"
                )
            
            try:
                # Run the prd-audit flow. The flow itself handles closing/rejecting logic internally.
                success = ctx.run_flow("prd-audit", prd_issue.number)
                
                if dashboard:
                    dashboard.record_step(f"AUDIT #{prd_issue.number}", success=success, details="PRD audit")
                    
                    if success:
                        dashboard.log_event(f"#{prd_issue.number} audited ✓", "success")
                    else:
                        dashboard.log_event(f"#{prd_issue.number} audit failed ✗", "failure")
                
                audited_count += 1
                
                # Update progress bar
                if dashboard:
                    dashboard.update_progress(audited_count, total=total_prds)
                    
            except Exception as e:
                error_msg = str(e)[:200]
                if term:
                    term._print_verbose(f"[WARNING] PRD audit failed for #{prd_issue.number}: {error_msg}")
                
                if dashboard:
                    dashboard.record_step(f"AUDIT #{prd_issue.number}", success=False, details=error_msg)
                    dashboard.log_event(f"#{prd_issue.number} error ✗", "failure")
                
                audited_count += 1
                
                if dashboard:
                    dashboard.update_progress(audited_count, total=total_prds)
        
        # Clear active issue after audit phase
        if dashboard:
            dashboard.set_active_issue(None)
            dashboard.log_event(
                f"PRD audit complete: {audited_count} audited",
                "success" if audited_count > 0 else "info"
            )
    
    # ── Phase 3: Final Scorecard ────────────────────────────────────
    
    if dashboard:
        # Calculate totals from context errors and completed steps
        ctx_summary = ctx.get_summary()
        dashboard.completed_steps = ctx_summary["completed_steps"]
        dashboard.failed_steps = ctx_summary["failed_steps"]
        
        # Print the final scorecard
        dashboard.print_scorecard("autonomous")


# ── Direct Execution (for testing) ─────────────────────────────────────

if __name__ == "__main__":
    # Add lib and parent to path for imports
    sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
    sys.path.insert(0, str(Path(__file__).parent.parent))
    
    from terminal import Terminal
    from github_client import GithubClient
    from pipelines.context import PipelineContext
    
    term = Terminal(verbose=True)
    
    try:
        gh_client = GithubClient()
    except RuntimeError as e:
        term.failure(f"Failed to initialize GitHub client: {e}")
        sys.exit(1)
    
    ctx = PipelineContext(term=term, gh_client=gh_client)
    
    setup(ctx)
    run(ctx)
    
    print(f"\nPipeline '{ctx.get_variable('pipeline_name')}' completed.", file=sys.stderr)
