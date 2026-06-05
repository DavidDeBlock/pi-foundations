#!/usr/bin/env python3
"""
maestro.py — Top-level CLI entry point for Maestro.

Mounts the per-domain Click groups (``memory``, ``scout``, ``prompt``,
``evidence``) under a single ``maestro`` Click group, so operators can use:

    maestro memory show 42
    maestro memory list
    maestro memory clear 42
    maestro scout  show 42
    maestro scout  list
    maestro prompt validate flows/builder-reviewer.json
    maestro mark-tested 42 --command ... --tests-run N --tests-passed N --exit-code N
    maestro mark-reviewed 42 --critical 0 --non-blocking 2 --reviewer claude-sonnet
    maestro mark-manual-tested 42 --scenario "user can log in"
    maestro evidence check 42 --required tested --required reviewed
    maestro evidence show 42

The per-domain modules (``commands/memory.py``, ``commands/scout.py``,
``commands/prompt.py``, ``commands/evidence.py``) remain independently
invokable as ``python3 -m commands.<group> ...`` — this script is purely an
aggregating front-end.

Why a separate top-level entry point?
    The PRDs for slices #274, #275, #273, and #280 document user-facing
    invocations like ``maestro memory show 42``, ``maestro scout show 42``,
    and ``maestro mark-tested 42 ...``, but until now those were only
    reachable as ``python3 -m commands.<group> ...`` from inside
    ``.pi/maestro/``. This script closes that gap without reorganising the
    existing argparse-based ``app_shell.py`` / ``orchestrate.py`` (out of
    scope for #276 — see the issue body).

Usage:
    # From the project root, or any cwd (paths are resolved by each
    # subcommand):
    python3 .pi/maestro/maestro.py --help
    python3 .pi/maestro/maestro.py memory show 42
    python3 .pi/maestro/maestro.py scout list --memory-dir /tmp/foo
    python3 .pi/maestro/maestro.py prompt validate flows/*.json
    python3 .pi/maestro/maestro.py mark-tested 42 --command "pnpm test" --tests-run 47 --tests-passed 47 --exit-code 0
    python3 .pi/maestro/maestro.py evidence check 42 --required tested

    # If you put this directory on PATH, you can also run it as just
    # ``maestro`` (no ``.py`` extension needed once chmod +x is set).

Design notes:

- The script does its own ``sys.path`` setup so it works from any cwd
  (no need to ``cd .pi/maestro`` first).
- Each subcommand group keeps its own options (e.g. ``--memory-dir`` on
  ``memory`` / ``scout``). When invoked through this top-level group,
  those options must come before the sub-subcommand:
  ``maestro memory --memory-dir=/foo show 42`` ✓.
- Adding a new subcommand is one line: ``maestro_cli.add_command(<group>, name="...")``.
- The mark-tested / mark-reviewed / mark-manual-tested commands are
  flat top-level commands (not nested under ``evidence``) so the
  canonical agent-facing invocation is ``maestro mark-tested 42 ...``
  as specified in the issue's AC and the test_runner prompt.
"""

from __future__ import annotations

import sys
from pathlib import Path

import click

# ─── Path setup ──────────────────────────────────────────────────────────
#
# This script lives at ``.pi/maestro/maestro.py``. To import the lib
# package and the commands/* submodules, we need:
#
#   - <maestro>/lib    on sys.path   (for ``from working_memory import ...``)
#   - <maestro>        on sys.path   (for ``from commands.memory import ...``)
#
# Both manipulations are idempotent and safe to repeat (the script can
# itself be imported as a module without side effects beyond path setup).
_MAESTRO_DIR = Path(__file__).parent.resolve()
if str(_MAESTRO_DIR / "lib") not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR / "lib"))
if str(_MAESTRO_DIR) not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR))

# Imports must come after path setup.
from commands.memory import memory_cli  # noqa: E402
from commands.scout import scout_cli  # noqa: E402
from commands.prompt import prompt_cli  # noqa: E402
from commands.evidence import (  # noqa: E402,F401
    evidence_cli,
    mark_tested_cmd,
    mark_reviewed_cmd,
    mark_manual_tested_cmd,
)
from commands.retrospective import retrospective_cli  # noqa: E402
from commands.projects import projects_cli  # noqa: E402
from commands.onboard import onboard_cmd  # noqa: E402


# ─── Top-level group ─────────────────────────────────────────────────────


@click.group()
@click.version_option(
    version="0.3.0",
    prog_name="maestro",
    message="%(prog)s (Maestro orchestrator CLI)",
)
def maestro_cli() -> None:
    """Maestro — Configurable Loop Orchestrator for Pi Slices.

    Common subcommands:

      \b
      - maestro memory ...          inspect & manage per-issue working memory
      - maestro scout  ...          inspect Scout phase findings
      - maestro prompt ...          validate flow tool allowlists
      - maestro mark-tested ...     write a tested.json evidence marker
      - maestro mark-reviewed ...   write a reviewed.json evidence marker
      - maestro mark-manual-tested  write a manual_tested.json evidence marker
      - maestro evidence ...        inspect & verify evidence markers
      - maestro retrospective ...   manage per-repo learnings & amendments
      - maestro projects ...        inspect & manage the onboarded-projects registry
      - maestro onboard <path>      onboard a repo (mechanical + optional interview)

    Run ``maestro <subcommand> --help`` for details on each.
    """


# Mount the per-domain groups. ``add_command`` preserves each group's
# own options (e.g. ``--memory-dir``) — they apply to the subcommand,
# not the top-level group.
maestro_cli.add_command(memory_cli, name="memory")
maestro_cli.add_command(scout_cli, name="scout")
maestro_cli.add_command(prompt_cli, name="prompt")
maestro_cli.add_command(evidence_cli, name="evidence")
maestro_cli.add_command(retrospective_cli, name="retrospective")
maestro_cli.add_command(projects_cli, name="projects")

# Mount the mark-* commands as flat top-level commands (not nested under
# ``evidence``). The issue's AC specifies the canonical invocation as
# ``maestro mark-tested <issue> ...`` — agents see this exact form in the
# test_runner prompt and in CI scripts.
maestro_cli.add_command(mark_tested_cmd, name="mark-tested")
maestro_cli.add_command(mark_reviewed_cmd, name="mark-reviewed")
maestro_cli.add_command(mark_manual_tested_cmd, name="mark-manual-tested")

# Mount onboard as a flat top-level command (matches the canonical
# ``maestro onboard <path>`` invocation in the PRD and prompts).
maestro_cli.add_command(onboard_cmd, name="onboard")


# ─── Entrypoint ──────────────────────────────────────────────────────────


if __name__ == "__main__":
    maestro_cli()
