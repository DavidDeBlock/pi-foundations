#!/usr/bin/env python3
"""
prompt_validate.py — CLI to validate tool allowlists in a Maestro flow.

Walks the phases in a flow JSON and verifies that each resolves to a valid
tool set (non-empty, every tool is a known name, .md frontmatter parses,
override field is well-typed). Exits with code 0 on success, 1 on validation
errors. Useful as a CI gate before running a flow.

Usage:
    python3 prompt_validate.py <flow.json> [<flow.json> ...]
    python3 prompt_validate.py flows/builder-reviewer.json flows/prd-audit.json

Resolution of ``prompts_dir``:
    - If a flow JSON is given as an absolute path, its parent directory is the
      reference; otherwise the path is resolved relative to the cwd.
    - ``prompts_dir`` is ``<flow_dir>/prompts`` if it exists, else the project's
      default ``.pi/maestro/prompts`` (relative to the repo root inferred from
      this script's location).
"""

import argparse
import json
import sys
from pathlib import Path

# Ensure lib is in path
SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR / "lib"))

from prompt_loader import validate_flow_tools  # noqa: E402


def _resolve_prompts_dir(flow_path: Path) -> Path:
    """Pick a prompts dir to validate against.

    Order of preference:
        1. ``<flow_dir>/prompts`` (colocated with the flow JSON).
        2. ``<maestro_root>/prompts`` (default, relative to this script).
    """
    flow_dir = flow_path.parent.resolve()
    colocated = flow_dir / "prompts"
    if colocated.is_dir():
        return colocated
    return SCRIPT_DIR / "prompts"


def _validate_one(flow_path: Path) -> list[str]:
    """Validate a single flow file. Returns a list of error strings."""
    if not flow_path.exists():
        return [f"flow file not found: {flow_path}"]

    try:
        with open(flow_path) as f:
            config = json.load(f)
    except json.JSONDecodeError as exc:
        return [f"{flow_path}: invalid JSON: {exc}"]

    if not isinstance(config, dict):
        return [f"{flow_path}: top-level must be a JSON object"]

    prompts_dir = _resolve_prompts_dir(flow_path)
    return validate_flow_tools(config, prompts_dir)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate that all phases in a Maestro flow JSON have valid tool sets.",
    )
    parser.add_argument(
        "flows",
        nargs="+",
        type=Path,
        help="One or more flow JSON files to validate.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Only print errors (suppress per-flow OK messages).",
    )
    args = parser.parse_args(argv)

    total_errors = 0
    for flow_path in args.flows:
        errors = _validate_one(flow_path)
        if errors:
            print(f"✗ {flow_path}: {len(errors)} error(s)", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)
            total_errors += len(errors)
        else:
            if not args.quiet:
                print(f"✓ {flow_path}: all phases have valid tool sets")

    if total_errors:
        print(
            f"\n{total_errors} validation error(s) across {len(args.flows)} flow file(s).",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
