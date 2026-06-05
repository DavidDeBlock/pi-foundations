#!/usr/bin/env python3
"""
full-lifecycle.py — End-to-end pipeline with deterministic label management.

Chains PRD review → build → test → review for one or more issues, setting
labels at each phase boundary based on flow outcomes.

Modes:
    Single  — ctx variable "issue_numbers" = [42]
    Batch   — ctx variable "issue_numbers" = [42, 43, 45]
    Auto    — no variable set; fetches all open issues with label "needs-triage"

Label lifecycle:
    needs-triage → needs-info → ready-for-agent → implementing → testing → awaiting-manual-check
                                                                                      ↓
                                                                    failed-slice (on max-retry failure)

Usage:
    from pipelines.runner import PipelineRunner
    runner = PipelineRunner(term=term, gh_client=gh)
    pipeline = runner.load_pipeline("full-lifecycle.py")
    result = runner.execute_pipeline(pipeline, "full-lifecycle")
"""


def setup(ctx):
    """Initialize the full-lifecycle pipeline context."""
    ctx.set_variable("pipeline_name", "full-lifecycle")

    if ctx.term:
        ctx.term.info("Full-lifecycle pipeline initialized")


# ── Label transition map ────────────────────────────────────────────────
# Maps (phase, status) → {add: [...], remove: [...]}
# Only fires on first occurrence of each phase+status combo per issue.

_LABEL_TRANSITIONS = {
    # Issue readiness check passes → ready for build
    ("issue-readiness", "success"): {
        "add": ["ready-for-agent"],
        "remove": ["needs-info"],
    },
    # Builder produced code → implementing state
    ("builder", "success"): {
        "add": ["implementing"],
        "remove": [],
    },
    # Reviewer approves → final human gate
    ("reviewer", "success"): {
        "add": ["awaiting-manual-check"],
        "remove": ["ready-for-agent", "implementing", "testing"],
    },
}


def _build_callback(ctx, issue_num: int):
    """Return a phase callback that applies deterministic label transitions.

    Fires once per (phase, status) combination — subsequent retries of the
    same phase+status are ignored to avoid redundant API calls.
    """
    seen = set()  # tracks (phase_name, status) pairs already applied

    def on_phase(phase_name: str, status: str, attempt_count: int, details: str):
        key = (phase_name, status)
        if key in seen:
            return
        seen.add(key)

        transition = _LABEL_TRANSITIONS.get(key)
        if not transition:
            return

        add_labels = transition["add"]
        remove_labels = transition["remove"]

        if ctx.term:
            label_summary = ""
            if add_labels:
                label_summary += f" +{','.join(add_labels)}"
            if remove_labels:
                label_summary += f" -{','.join(remove_labels)}"
            ctx.term._print_verbose(
                f"[LABELS] #{issue_num} {phase_name}/{status}{label_summary}"
            )

        if add_labels or remove_labels:
            ctx.github.update_issue_labels(
                issue_num,
                add_labels=add_labels if add_labels else None,
                remove_labels=remove_labels if remove_labels else None,
            )

    return on_phase


def _process_issue(ctx, issue_num: int) -> bool:
    """Run the full-lifecycle flow on a single issue with label management.

    Returns True if the flow completed successfully, False otherwise.
    """
    gh = ctx.github

    # ── Entry label: needs-triage → needs-info (review starting) ──
    gh.update_issue_labels(issue_num, add=["needs-info"], remove=["needs-triage"])

    if ctx.term:
        ctx.term._print_verbose(f"[LABELS] #{issue_num} entry → needs-info")

    # ── Build phase callback for deterministic label transitions ──
    on_phase = _build_callback(ctx, issue_num)

    # ── Run the full lifecycle flow with callback ──
    success = ctx.run_flow(
        "full-lifecycle",
        issue_num,
        phase_callback=on_phase,
    )

    # ── Failure cleanup: remove all intermediate labels, add failed-slice ──
    if not success:
        gh.update_issue_labels(
            issue_num,
            add=["failed-slice"],
            remove=["needs-info", "ready-for-agent", "implementing", "testing"],
        )

        if ctx.term:
            ctx.term.failure(f"#{issue_num} failed — labelled 'failed-slice'")

    return success


def run(ctx):
    """Execute the full-lifecycle pipeline.

    Determines which issues to process based on context variables or auto-mode,
    then runs each through the full lifecycle with deterministic label management.
    """
    # ── Determine issue list ────────────────────────────────────────
    issue_numbers = ctx.get_variable("issue_numbers")

    if not issue_numbers:
        # Auto mode: fetch all open issues with "needs-triage" label
        if ctx.term:
            ctx.term.info("Auto mode — fetching needs-triage backlog...")

        issues = ctx.github.fetch_issues_by_label("needs-triage")

        if not issues:
            if ctx.term:
                ctx.term.info("No 'needs-triage' issues found. Nothing to do.")
            return

        issue_numbers = [issue.number for issue in issues]

    if ctx.term:
        ctx.term.info(f"Processing {len(issue_numbers)} issue(s): {issue_numbers}")

    # ── Process each issue sequentially ─────────────────────────────
    success_count = 0
    fail_count = 0

    for num in issue_numbers:
        if ctx.term:
            ctx.term._print_verbose(f"\n{'=' * 60}")
            ctx.term._print_verbose(f"[ISSUE] Starting #{num}")

        try:
            success = _process_issue(ctx, num)

            if success:
                success_count += 1
                if ctx.term:
                    ctx.term.success(f"#{num} completed successfully")
            else:
                fail_count += 1

        except Exception as e:
            fail_count += 1
            ctx.record_error(f"issue-{num}", str(e)[:300])

    # ── Summary ─────────────────────────────────────────────────────
    if ctx.term:
        ctx.term.info(
            f"\nFull-lifecycle complete: {success_count} succeeded, "
            f"{fail_count} failed out of {len(issue_numbers)}"
        )


# ── Direct Execution (for testing) ─────────────────────────────────────

if __name__ == "__main__":
    import sys
    from pathlib import Path

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

    # Parse CLI args for direct execution
    import argparse

    parser = argparse.ArgumentParser(description="Full-lifecycle pipeline")
    parser.add_argument("--issue", type=int, help="Single issue number")
    parser.add_argument(
        "--issues",
        type=str,
        help="Comma-separated list of issue numbers (e.g., '42,43,45')",
    )
    args = parser.parse_args()

    if args.issue:
        ctx.set_variable("issue_numbers", [args.issue])
    elif args.issues:
        nums = [int(n.strip()) for n in args.issues.split(",")]
        ctx.set_variable("issue_numbers", nums)
    # else: auto mode (no variable set — pipeline fetches needs-triage)

    setup(ctx)
    run(ctx)

    print(
        f"\nPipeline '{ctx.get_variable('pipeline_name')}' completed.",
        file=sys.stderr,
    )
