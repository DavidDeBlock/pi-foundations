#!/usr/bin/env python3
"""
memory.py — CLI for inspecting and managing Maestro working memory.

Subcommands:
    show   <issue> [--json]   Pretty-print working memory for an issue
    clear  <issue>            Delete the working memory file (with confirmation)
    list                       List all issues with working memory files

Usage examples:
    maestro memory show 42
    maestro memory show 42 --json
    maestro memory clear 42
    maestro memory list

Design notes:

- The default ``MEMORY_DIR`` is ``.maestro/tasks/active`` (project-relative).
  ``--memory-dir`` overrides it for ops or tests.
- ``clear`` requires a confirmation prompt by default; ``--yes`` skips it
  for automation (e.g. CI cleanup).
- This module is intentionally CLI-only — no library exports. Tests
  exercise the underlying ``MemoryStore`` directly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

# Add parent to path so we can import the lib package
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from working_memory import MemoryStore, WorkingMemory, MEMORY_DIR, format_memory_markdown


# ─── Helpers ─────────────────────────────────────────────────────────────


def _list_memory_files(memory_dir: Path) -> list:
    """Return all ``*.memory.json`` files in ``memory_dir``, sorted by mtime desc."""
    if not memory_dir.exists():
        return []
    return sorted(
        memory_dir.glob("*.memory.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )


def _issue_num_from_path(path: Path) -> str:
    """Extract the issue number stem from a ``<num>.memory.json`` path.

    Falls back to the full stem if the format doesn't match (defensive —
    corrupt filenames shouldn't crash the list command).
    """
    stem = path.stem  # strips .json
    if stem.endswith(".memory"):
        return stem[: -len(".memory")]
    return stem


# ─── Click group ─────────────────────────────────────────────────────────


@click.group()
@click.option(
    "--memory-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=MEMORY_DIR,
    show_default=True,
    help="Directory containing working memory files.",
)
@click.pass_context
def memory_cli(ctx: click.Context, memory_dir: Path) -> None:
    """Inspect and manage Maestro working memory."""
    ctx.ensure_object(dict)
    ctx.obj["memory_dir"] = Path(memory_dir)


@memory_cli.command("show")
@click.argument("issue_num", type=int)
@click.option("--json", "as_json", is_flag=True, help="Output raw JSON instead of markdown.")
@click.pass_context
def show_cmd(ctx: click.Context, issue_num: int, as_json: bool) -> None:
    """Show working memory for ISSUE_NUM."""
    memory_dir: Path = ctx.obj["memory_dir"]
    store = MemoryStore(issue_num, memory_dir=memory_dir)
    mem = store.load()

    if as_json:
        click.echo(json.dumps(mem.to_dict(), indent=2, ensure_ascii=False))
    else:
        click.echo(format_memory_markdown(mem))


@memory_cli.command("clear")
@click.argument("issue_num", type=int)
@click.option("--yes", "-y", is_flag=True, help="Skip the confirmation prompt.")
@click.pass_context
def clear_cmd(ctx: click.Context, issue_num: int, yes: bool) -> None:
    """Clear working memory for ISSUE_NUM (deletes the file)."""
    memory_dir: Path = ctx.obj["memory_dir"]
    store = MemoryStore(issue_num, memory_dir=memory_dir)

    if not store.path.exists():
        click.echo(f"No working memory for issue #{issue_num} at {store.path}", err=True)
        sys.exit(0)

    if not yes:
        if not click.confirm(
            f"Delete working memory file {store.path} for issue #{issue_num}?",
            default=False,
        ):
            click.echo("Aborted.")
            sys.exit(1)

    try:
        store.path.unlink()
    except OSError as e:
        click.echo(f"Failed to delete {store.path}: {e}", err=True)
        sys.exit(1)

    click.echo(f"Cleared working memory for issue #{issue_num}")


@memory_cli.command("list")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON array.")
@click.pass_context
def list_cmd(ctx: click.Context, as_json: bool) -> None:
    """List all issues with working memory files."""
    memory_dir: Path = ctx.obj["memory_dir"]
    files = _list_memory_files(memory_dir)

    if not files:
        if as_json:
            click.echo("[]")
        else:
            click.echo(f"No working memory files found in {memory_dir}")
        return

    rows: list = []
    for path in files:
        issue_str = _issue_num_from_path(path)
        try:
            issue_num = int(issue_str)
        except ValueError:
            issue_num = -1
        try:
            mem = MemoryStore(issue_num if issue_num >= 0 else 0, memory_dir=memory_dir).load()
            # If we couldn't parse the issue number, override with whatever
            # the path said so the user can still see it
            if issue_num < 0:
                mem.issue = issue_str  # type: ignore[assignment]
            updated = mem.updated_at or ""
        except Exception:
            updated = ""
        rows.append({
            "issue": mem.issue if 'mem' in locals() else issue_str,
            "updated_at": updated,
            "path": str(path),
        })

    if as_json:
        click.echo(json.dumps(rows, indent=2, ensure_ascii=False))
        return

    # Pretty table
    click.echo(f"Working memory files in {memory_dir}:")
    click.echo("")
    for row in rows:
        issue = row["issue"]
        ts = row["updated_at"] or "(unknown)"
        click.echo(f"  #{issue}  — last updated: {ts}")
        click.echo(f"           {row['path']}")


# Allow `python -m commands.memory ...` for ops scripts that want a
# programmatic entry point
if __name__ == "__main__":
    memory_cli()
