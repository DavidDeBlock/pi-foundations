#!/usr/bin/env python3
"""
scout.py — CLI for inspecting Maestro Scout phase findings.

Subcommands:
    show   <issue> [--json]   Pretty-print scout findings for an issue
    list   [--scout-only]    List issues with scout findings in working memory

Usage examples:
    maestro scout show 42
    maestro scout show 42 --json
    maestro scout list

Design notes:

- The default ``MEMORY_DIR`` is ``.maestro/tasks/active`` (project-relative).
  ``--memory-dir`` overrides it for ops or tests.
- ``scout show`` reads the ``scout`` section of the per-issue working memory
  file. If the section is empty (scout never ran, or ran with no findings),
  a helpful message is printed.
- This module is intentionally CLI-only — no library exports. Tests
  exercise the underlying ``MemoryStore`` and ``ScoutFindings`` directly.

The companion data layer is ``lib/scout_findings.py``; this CLI is a thin
adapter that calls ``ScoutFindings.from_dict()`` + ``to_markdown()`` on
whatever the working memory has stored.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

# Add parent to path so we can import the lib package
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from working_memory import MemoryStore, MEMORY_DIR
from scout_findings import ScoutFindings, format_scout_findings_markdown


# ─── Helpers ─────────────────────────────────────────────────────────────


def _load_scout_section(issue_num: int, memory_dir: Path) -> tuple[dict, bool]:
    """Return ``(scout_section, exists)`` for ``issue_num``.

    - ``scout_section`` is the raw dict stored under the ``scout`` key in
      working memory (empty ``{}`` if no section).
    - ``exists`` is True if a memory file was found, False if a fresh
      empty memory was synthesised.
    """
    store = MemoryStore(issue_num, memory_dir=memory_dir)
    # We use the existence of the file as the "exists" signal so the CLI
    # can distinguish "scout never ran" from "scout ran with no findings".
    exists = store.path.exists()
    mem = store.load()
    return mem.scout or {}, exists


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
def scout_cli(ctx: click.Context, memory_dir: Path) -> None:
    """Inspect Scout phase findings from Maestro working memory."""
    ctx.ensure_object(dict)
    ctx.obj["memory_dir"] = Path(memory_dir)


@scout_cli.command("show")
@click.argument("issue_num", type=int)
@click.option("--json", "as_json", is_flag=True, help="Output raw JSON instead of markdown.")
@click.pass_context
def show_cmd(ctx: click.Context, issue_num: int, as_json: bool) -> None:
    """Show Scout findings for ISSUE_NUM (from working memory)."""
    memory_dir: Path = ctx.obj["memory_dir"]
    scout_section, exists = _load_scout_section(issue_num, memory_dir)

    if not exists:
        click.echo(
            f"No working memory for issue #{issue_num} at {memory_dir} — "
            f"the scout phase has not run yet.",
            err=True,
        )
        sys.exit(0)

    if not scout_section:
        click.echo(f"No scout findings recorded for issue #{issue_num}.")
        click.echo("(The scout phase may not have run, or it ran with no output.)")
        sys.exit(0)

    # Extract the stored findings dict (or the parse-error envelope)
    findings = scout_section.get("findings")
    if findings is None:
        # Older / partial records may not have a ``findings`` key. Surface
        # the whole scout section so the operator can still see what was
        # recorded (status, details, raw_output, etc.).
        click.echo(f"# Scout Section for Issue #{issue_num}", err=False)
        click.echo("```json")
        click.echo(json.dumps(scout_section, indent=2, ensure_ascii=False))
        click.echo("```")
        return

    if as_json:
        click.echo(json.dumps(findings, indent=2, ensure_ascii=False))
    else:
        # If we have a real ScoutFindings dict (no parse_error key), upgrade
        # it to the dataclass for a guaranteed-typed render path. Otherwise
        # the format_scout_findings_markdown helper handles envelopes.
        md = format_scout_findings_markdown(findings)
        click.echo(md)


@scout_cli.command("list")
@click.option(
    "--scout-only",
    is_flag=True,
    help="Only list issues that have a non-empty scout section.",
)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON array.")
@click.pass_context
def list_cmd(ctx: click.Context, scout_only: bool, as_json: bool) -> None:
    """List issues with working memory files (and their scout status)."""
    memory_dir: Path = ctx.obj["memory_dir"]
    if not memory_dir.exists():
        if as_json:
            click.echo("[]")
        else:
            click.echo(f"No working memory directory at {memory_dir}")
        return

    rows: list = []
    for path in sorted(memory_dir.glob("*.memory.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        stem = path.stem  # strips .json
        if stem.endswith(".memory"):
            issue_str = stem[: -len(".memory")]
        else:
            issue_str = stem
        try:
            issue_num = int(issue_str)
        except ValueError:
            continue

        store = MemoryStore(issue_num, memory_dir=memory_dir)
        mem = store.load()
        has_scout = bool(mem.scout)
        if scout_only and not has_scout:
            continue

        # Pull a few useful summary fields for the listing
        scout_status = mem.scout.get("status", "") if mem.scout else ""
        scout_files = ""
        if mem.scout.get("findings", {}).get("relevant_files"):
            files = mem.scout["findings"]["relevant_files"]
            scout_files = ", ".join(files[:3])
            if len(files) > 3:
                scout_files += f" (+{len(files) - 3} more)"

        rows.append({
            "issue": issue_num,
            "has_scout": has_scout,
            "scout_status": scout_status,
            "scout_files": scout_files,
            "updated_at": mem.updated_at or "",
            "path": str(path),
        })

    if as_json:
        click.echo(json.dumps(rows, indent=2, ensure_ascii=False))
        return

    if not rows:
        click.echo(f"No working memory files{' with scout data' if scout_only else ''} found in {memory_dir}")
        return

    click.echo(f"Issues in {memory_dir} ({len(rows)}):")
    click.echo("")
    for row in rows:
        flag = "🔍" if row["has_scout"] else "  "
        status = f"[{row['scout_status']}]" if row["scout_status"] else ""
        files_part = f"  files: {row['scout_files']}" if row["scout_files"] else ""
        ts = row["updated_at"] or "(unknown)"
        click.echo(f"  {flag} #{row['issue']}  {status}  — updated: {ts}{files_part}")


# Allow `python -m commands.scout ...` for ops scripts that want a
# programmatic entry point
if __name__ == "__main__":
    scout_cli()
