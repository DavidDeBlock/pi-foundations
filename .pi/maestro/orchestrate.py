#!/usr/bin/env python3
"""
orchestrate.py — CLI entry point for Maestro.

Delegates workflow management to app_shell.py and execution to flow_engine.py.

Usage:
    # Single issue mode
    python orchestrate.py --flow builder-reviewer --issue 42
    
    # Autonomous loop mode (grabs ready-for-agent, runs them, then checks PRD)
    python orchestrate.py --flow builder-reviewer
"""

import argparse
import sys
from pathlib import Path

# Ensure lib is in path for imports within modules
sys.path.insert(0, str(Path(__file__).parent / "lib"))

from app_shell import MaestroApp


def main():
    parser = argparse.ArgumentParser(description="Maestro — Autonomous AI Workflow Orchestrator")
    parser.add_argument("--flow", required=True, help="Name of the flow to run (e.g., builder-reviewer)")
    parser.add_argument("--issue", type=int, help="Process specific issue number (Single Issue Mode)")
    args = parser.parse_args()
    
    app = MaestroApp(args)
    app.run()


if __name__ == "__main__":
    main()
