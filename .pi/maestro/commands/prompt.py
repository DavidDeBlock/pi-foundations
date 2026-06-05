#!/usr/bin/env python3
"""
prompt.py — Click group for prompt-related Maestro subcommands.

Subcommands:
    validate  <flow.json> [<flow.json> ...]   Validate that all phases in
                                              a flow JSON have valid tool
                                              sets (non-empty, every tool
                                              is a known name, .md front-
                                              matter parses, override field
                                              is well-typed).

Usage examples:
    maestro prompt validate flows/builder-reviewer.json
    maestro prompt validate flows/*.json --quiet

Design notes:

- The validation logic itself lives in ``lib/prompt_loader.py`` and is
  shared with the standalone argparse-based ``prompt_validate.py`` script.
  This module is a thin Click adapter on top of that logic.
- ``prompts_dir`` resolution is the same as ``prompt_validate.py``:
  ``<flow_dir>/prompts`` if it exists, else the project's default
  ``.pi/maestro/prompts`` (relative to the script's location).
- This module is intentionally CLI-only — no library exports. Tests
  exercise ``validate_flow_tools`` directly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

# Add parent to path so we can import the lib package
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from prompt_loader import validate_flow_tools  # noqa: E402

#: Default prompts directory, used when a flow has no colocated ``prompts/``.
DEFAULT_PROMPTS_DIR = (Path(__file__).parent.parent / "prompts").resolve()


# ─── Helpers ─────────────────────────────────────────────────────────────


def _resolve_prompts_dir(flow_path: Path) -> Path:
    """Pick a prompts dir to validate against.

    Order of preference:
        1. ``<flow_dir>/prompts`` (colocated with the flow JSON).
        2. ``DEFAULT_PROMPTS_DIR`` (relative to this script).

    Matches the behavior of the standalone ``prompt_validate.py`` script
    so that ``maestro prompt validate`` and ``python3 prompt_validate.py``
    produce identical results for the same input.
    """
    flow_dir = flow_path.parent.resolve()
    colocated = flow_dir / "prompts"
    if colocated.is_dir():
        return colocated
    return DEFAULT_PROMPTS_DIR


def _validate_one(flow_path: Path) -> list[str]:
    """Validate a single flow file. Returns a list of error strings.

    Mirrors the helper in ``prompt_validate.py`` exactly so both entry
    points behave identically. If you change this, change that one too.
    """
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


# ─── Click group ─────────────────────────────────────────────────────────


@click.group()
def prompt_cli() -> None:
    """Inspect and validate Maestro prompt tool allowlists."""


@prompt_cli.command("validate")
@click.argument(
    "flows",
    nargs=-1,
    required=True,
    type=click.Path(exists=False, path_type=Path),
)
@click.option(
    "--quiet",
    is_flag=True,
    help="Only print errors (suppress per-flow OK messages).",
)
def validate_cmd(flows: tuple[Path, ...], quiet: bool) -> None:
    """Validate that all phases in FLOW have valid tool sets.

    Exits with code 0 on success, 1 on validation errors. Useful as a CI
    gate before running a flow.
    """
    total_errors = 0
    for flow_path in flows:
        errors = _validate_one(flow_path)
        if errors:
            click.echo(f"✗ {flow_path}: {len(errors)} error(s)", err=True)
            for err in errors:
                click.echo(f"  - {err}", err=True)
            total_errors += len(errors)
        else:
            if not quiet:
                click.echo(f"✓ {flow_path}: all phases have valid tool sets")

    if total_errors:
        click.echo(
            f"\n{total_errors} validation error(s) across {len(flows)} flow file(s).",
            err=True,
        )
        sys.exit(1)


# Allow `python -m commands.prompt ...` for ops scripts that want a
# programmatic entry point (mirrors the pattern in memory.py / scout.py).
if __name__ == "__main__":
    prompt_cli()
