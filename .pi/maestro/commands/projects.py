#!/usr/bin/env python3
"""
projects.py — CLI for ``maestro projects ...`` — inspect and manage
the projects registry populated by ``maestro onboard``.

Subcommands:

    list                      Show all onboarded repos (alias, hash,
                              path, languages, test command, evidence
                              strategy, probed_at).
    list --json               Machine-readable output for CI / scripts.
    show <repo_path>          Full JSON entry for a repo.
    show <alias_or_hash>      Same, looked up by hash or alias.
    remove <alias_or_hash>    Remove a repo from the registry (does
                              NOT delete the repo from disk).

Usage examples:

    maestro projects list
    maestro projects list --json
    maestro projects show /path/to/repo
    maestro projects show my-cool-alias
    maestro projects remove my-cool-alias
    maestro projects remove abc123def456
    maestro projects list --registry /custom/path/projects.json

Design notes:

- ``list`` and ``show`` are read-only; they never mutate the
  registry. ``remove`` is the only mutating subcommand and is
  intentional — deleting a registry entry does NOT delete the
  repo (per the PRD: "removes a repo from the registry (does NOT
  delete the repo)").
- Lookups by alias AND hash are both supported in ``show`` /
  ``remove``. The registry is keyed by hash, but users remember
  aliases better. The aliases field is unique-ish (we don't enforce
  it; users may pick the same alias twice for different repos —
  in which case the *first* match wins).
- All subcommands accept ``--registry`` to point at a non-default
  registry path. The default is ``.maestro/projects.json`` (project-
  relative).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

import click

# ─── Path setup ──────────────────────────────────────────────────────────
#
# This file lives at ``.pi/maestro/commands/projects.py``. We need both
# ``.pi/maestro`` and ``.pi/maestro/lib`` on sys.path so the imports
# work whether the module is invoked via ``python3 -m commands.projects``
# OR through the top-level ``maestro.py`` aggregator.

_COMMANDS_DIR = Path(__file__).parent.resolve()
_MAESTRO_DIR = _COMMANDS_DIR.parent
if str(_MAESTRO_DIR / "lib") not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR / "lib"))
if str(_MAESTRO_DIR) not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR))

# Imports must come after path setup.
from projects_registry import (  # noqa: E402
    HASH_PREFIX_LENGTH,
    REGISTRY_FILENAME,
    ProjectsRegistry,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _looks_like_hash(s: str) -> bool:
    """Return True iff ``s`` is the right shape to be a 12-char hash key."""
    return (
        isinstance(s, str)
        and len(s) == HASH_PREFIX_LENGTH
        and all(c in "0123456789abcdef" for c in s.lower())
    )


def _find_by_hash_or_alias(registry: ProjectsRegistry, key: str) -> Optional[dict]:
    """Look up an entry by hash first, then by alias.

    Hash lookup is unambiguous (the registry is keyed by hash).
    Alias lookup is "first match wins" — the registry doesn't enforce
    alias uniqueness, so we just return the first hit. Returns
    ``None`` if neither lookup succeeds.
    """
    if not isinstance(key, str) or not key:
        return None

    # Hash lookup
    if _looks_like_hash(key):
        entry = registry.get(key)
        if entry is not None:
            return entry

    # Alias lookup — walk all entries
    for entry in registry.list_all():
        if not isinstance(entry, dict):
            continue
        if entry.get("alias") == key:
            return entry
    return None


def _format_summary_table(entries: list[dict]) -> str:
    """Render a list of entries as a human-readable table.

    Columns: alias, hash (12 chars), languages, test_command,
    evidence_strategy, probed_at. Truncates long values to keep
    the table readable on a 100-column terminal.
    """
    if not entries:
        return "(no onboarded repos)"

    def _truncate(s: str, n: int) -> str:
        s = str(s) if s is not None else ""
        return s if len(s) <= n else s[: n - 1] + "…"

    lines: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        alias = _truncate(entry.get("alias", "?"), 20)
        repo_hash = _truncate(entry.get("hash", "?"), 12)
        languages = ",".join(entry.get("languages") or []) or "—"
        languages = _truncate(languages, 18)
        test_cmd = _truncate(entry.get("test_command", "—"), 30)
        evidence = _truncate(entry.get("evidence_strategy", "—"), 18)
        probed = _truncate(str(entry.get("probed_at", "—")), 19)

        lines.append(
            f"  {alias:<20}  {repo_hash:<12}  {languages:<18}  "
            f"{test_cmd:<30}  {evidence:<18}  {probed}"
        )
    return "\n".join(lines)


# ─── Click group ─────────────────────────────────────────────────────────


@click.group(name="projects")
@click.option(
    "--registry",
    "registry_path",
    type=click.Path(dir_okay=False, path_type=Path),
    default=REGISTRY_FILENAME,
    show_default=True,
    help="Path to the projects.json registry (relative to cwd or absolute).",
)
@click.pass_context
def projects_cli(ctx: click.Context, registry_path: Path) -> None:
    """Inspect and manage onboarded projects (``.maestro/projects.json``)."""
    ctx.ensure_object(dict)
    ctx.obj["registry"] = ProjectsRegistry(registry_path)


# ─── list ───────────────────────────────────────────────────────────────


@projects_cli.command("list")
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Output as a JSON array (one entry per object).",
)
@click.pass_context
def list_cmd(ctx: click.Context, as_json: bool) -> None:
    """List all onboarded repos with a one-line summary each."""
    registry: ProjectsRegistry = ctx.obj["registry"]
    entries = registry.list_all()

    if as_json:
        click.echo(json.dumps(entries, indent=2, ensure_ascii=False))
        return

    click.echo(f"Onboarded repos in {registry.path}:")
    click.echo("")
    click.echo(
        f"  {'ALIAS':<20}  {'HASH':<12}  {'LANGUAGES':<18}  "
        f"{'TEST_COMMAND':<30}  {'EVIDENCE':<18}  PROBED_AT"
    )
    click.echo(
        f"  {'-'*20}  {'-'*12}  {'-'*18}  "
        f"{'-'*30}  {'-'*18}  {'-'*19}"
    )
    click.echo(_format_summary_table(entries))


# ─── show ───────────────────────────────────────────────────────────────


@projects_cli.command("show")
@click.argument("key")
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Output raw JSON for the entry.",
)
@click.pass_context
def show_cmd(ctx: click.Context, key: str, as_json: bool) -> None:
    """Show the full entry for KEY (a path, alias, or 12-char hash)."""
    registry: ProjectsRegistry = ctx.obj["registry"]

    # Try path lookup first (handles absolute and relative paths)
    entry = registry.get_by_path(key)
    if entry is None:
        # Fall back to alias / hash lookup
        entry = _find_by_hash_or_alias(registry, key)

    if entry is None:
        click.echo(f"No project found for {key!r}", err=True)
        sys.exit(1)

    if as_json:
        click.echo(json.dumps(entry, indent=2, ensure_ascii=False))
    else:
        click.echo(json.dumps(entry, indent=2, ensure_ascii=False))


# ─── remove ─────────────────────────────────────────────────────────────


@projects_cli.command("remove")
@click.argument("key")
@click.option(
    "--yes",
    "-y",
    is_flag=True,
    help="Skip the confirmation prompt.",
)
@click.pass_context
def remove_cmd(ctx: click.Context, key: str, yes: bool) -> None:
    """Remove a project from the registry (does NOT delete the repo)."""
    registry: ProjectsRegistry = ctx.obj["registry"]

    # Resolve the key to a hash for the actual remove() call
    entry = _find_by_hash_or_alias(registry, key)
    if entry is None:
        click.echo(f"No project found for {key!r}", err=True)
        sys.exit(1)

    repo_hash = entry.get("hash")
    alias = entry.get("alias", "?")
    path = entry.get("path", "?")

    if not yes:
        if not click.confirm(
            f"Remove {alias} ({repo_hash}) at {path} from the registry?",
            default=False,
        ):
            click.echo("Aborted.")
            sys.exit(1)

    removed = registry.remove(repo_hash)
    if removed:
        click.echo(
            click.style(
                f"✓ Removed {alias} ({repo_hash}) from {registry.path}",
                fg="green",
            )
        )
        click.echo(
            f"  (Note: the repo at {path} is unchanged. "
            f"Re-run ``maestro onboard {path}`` to re-register.)"
        )
    else:
        click.echo(f"  No entry was removed (already gone?).")


# Allow `python -m commands.projects ...` for ops scripts
if __name__ == "__main__":
    projects_cli()
