#!/usr/bin/env python3
"""
dummy_pipeline.py — Example pipeline that initializes context and prints headers.

This is a minimal "hello world" pipeline for testing the pipeline layer.
It demonstrates:
- Context initialization via setup()
- Terminal output via ctx.term
- Clean exit without errors

Usage:
    # Run directly
    python3 pipelines/dummy_pipeline.py
    
    # Or load via PipelineRunner
    from pipelines.runner import PipelineRunner
    runner = PipelineRunner(term=term)
    pipeline = runner.load_pipeline("dummy_pipeline.py")
    runner.execute_pipeline(pipeline, "dummy")
"""

import sys
from pathlib import Path


def setup(ctx):
    """Initialize the pipeline context."""
    ctx.set_variable("pipeline_name", "dummy")
    ctx.set_variable("status", "initialized")
    
    # Print header via terminal
    if ctx.term:
        ctx.term.info("Dummy pipeline initialized")


def run(ctx):
    """Execute the dummy pipeline logic."""
    name = ctx.get_variable("pipeline_name", "unknown")
    
    if ctx.term:
        ctx.term.info(f"Running {name} pipeline...")
        ctx.term.info("Pipeline completed successfully")
    
    # Mark as complete
    ctx.completed_steps += 1


# ── Direct Execution (for testing) ─────────────────────────────────────

if __name__ == "__main__":
    # Add lib and parent to path for imports
    sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
    sys.path.insert(0, str(Path(__file__).parent.parent))
    
    from terminal import Terminal
    from pipelines.context import PipelineContext
    
    term = Terminal(verbose=True)
    ctx = PipelineContext(term=term)
    
    setup(ctx)
    run(ctx)
    
    print(f"\nPipeline '{ctx.get_variable('pipeline_name')}' completed.", file=sys.stderr)
