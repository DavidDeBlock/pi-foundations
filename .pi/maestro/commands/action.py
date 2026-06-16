#!/usr/bin/env python3
"""
action.py — Click entry point for the ``maestro`` action menu.

This module is intentionally thin. The state machine and I/O
adapter live in :mod:`action_menu` (under ``lib/``) so the menu
can be unit-tested without a TTY. The command's job is to:

  1. Build the production :class:`InquirerPyMenuIO` adapter.
  2. Call :func:`action_menu.run_action_menu`.
  3. Translate the return code into a process exit code.

The command is mounted as the **default** subcommand of the
top-level ``maestro`` group — running ``maestro`` with no
subcommand launches the action menu. This is wired in
:mod:`maestro` itself (the group callback detects
``ctx.invoked_subcommand is None`` and invokes this command).

Usage:

    maestro                          # launch the action menu
    maestro --help                   # show all subcommands (this one is implicit)
    maestro menu --help              # show this command's options (for ops scripts)

Design notes:

  - The function does no I/O of its own — every interaction
    goes through the :class:`MenuIO` adapter. The command's
    only direct I/O is the ``print`` for the help text.
  - The command takes no required arguments. Optional flags
    (e.g. ``--repo-root``) are accepted for ops-script use
    but default to "current working directory" in the normal
    case.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import click
from rich.console import Console

# ─── Path setup ──────────────────────────────────────────────────────────
#
# Same pattern as ``commands/monitor.py`` — the lib directory
# must be on ``sys.path`` so ``import action_menu`` resolves
# whether we are invoked as ``python3 -m commands.action`` OR
# through the top-level ``maestro.py`` aggregator.
_COMMANDS_DIR = Path(__file__).parent.resolve()
_MAESTRO_DIR = _COMMANDS_DIR.parent
if str(_MAESTRO_DIR / "lib") not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR / "lib"))
if str(_MAESTRO_DIR) not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR))

# Imports must come after path setup.
from action_menu import (  # noqa: E402
    InquirerPyMenuIO,
    run_action_menu,
)


# ─── Click command ──────────────────────────────────────────────────────


@click.command(name="menu", context_settings={"ignore_unknown_options": False})
@click.option(
    "--repo-root",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help=(
        "Working directory for spawned runners. Defaults to the current "
        "working directory. Provided for ops scripts that want to pin the "
        "cwd (e.g. CI)."
    ),
)
def action_cmd(repo_root: Optional[Path]) -> None:
    """Launch the interactive action menu.

    Pick "Start single issue" / "Start batch" / "Quit" with the
    arrow keys, then ``enter`` to confirm. Cancel any prompt
    with ``Ctrl-C`` to return to the menu (or, from the top-level
    menu, to quit cleanly).

    All started flows are recorded in
    ``.maestro/logs/maestro-actions.log`` (see
    :mod:`audit_log`).
    """
    io = InquirerPyMenuIO(console=Console())
    rc = run_action_menu(
        io=io,
        repo_root=repo_root,
    )
    sys.exit(rc)


# Allow ``python3 -m commands.action`` for ops scripts that
# prefer the module-style invocation.
if __name__ == "__main__":
    action_cmd()
