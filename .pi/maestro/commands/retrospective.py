#!/usr/bin/env python3
"""
retrospective.py — CLI for the Maestro retrospective phase.

Subcommands (mounted on the top-level ``maestro`` Click group):

    run         <issue_num> [--repo-path PATH]   Re-derive a learning entry from working memory
    show        <repo>                          Print the repo's .maestro/learnings.md
    patterns                                    Aggregate learnings across all repos
    amendments  <repo>                          Print the repo's .maestro/proposed-amendments.md

Usage examples:

    maestro retrospective show /path/to/repo
    maestro retrospective patterns
    maestro retrospective patterns --memory-dir /path/to/root
    maestro retrospective amendments /path/to/repo
    maestro retrospective run 42 --repo-path /path/to/repo
    maestro retrospective run 42 --repo-path /path/to/repo --memory-dir .maestro/tasks/active

Design notes:

- ``show`` and ``amendments`` are pure read commands. Missing files
  print a friendly message and exit 0 — the operator should not have
  to grep for "no such file" errors when nothing has been learned yet.
- ``patterns`` calls :func:`learnings.scan_all_learnings` and prints
  a human summary. ``--json`` is supported for machine-readable
  output (CI dashboards, etc.).
- ``run`` is the manual re-run command. It does NOT call an LLM — it
  reads the working memory and synthesises a learning entry from the
  data we already have. The LLM-based retrospective is what the flow
  engine does automatically; this CLI is a fallback / reprocessor
  for past issues whose flow already finished.
- ``--memory-dir`` defaults to ``.maestro/tasks/active`` (the working
  memory default) but is overridable for ops / tests.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

# ─── Path setup ──────────────────────────────────────────────────────────
#
# This file lives at ``.pi/maestro/commands/retrospective.py``. We need
# both ``.pi/maestro`` and ``.pi/maestro/lib`` on sys.path so the
# imports work when the module is invoked via
# ``python3 -m commands.retrospective ...`` OR through the top-level
# ``maestro.py`` aggregator.

_COMMANDS_DIR = Path(__file__).parent.resolve()
_MAESTRO_DIR = _COMMANDS_DIR.parent
if str(_MAESTRO_DIR / "lib") not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR / "lib"))
if str(_MAESTRO_DIR) not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR))

# Imports must come after path setup.
from learnings import (  # noqa: E402
    AMENDMENTS_FILENAME,
    LEARNINGS_FILENAME,
    append_to_amendments,
    append_to_learnings,
    count_recurring_patterns,
    format_amendment_entry,
    format_learning_entry,
    parse_retrospective_output,
    scan_all_learnings,
)
from working_memory import MemoryStore  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────


def _synthesize_from_memory(
    issue_num: int,
    memory_dir: Path,
    repo_path: Path,
) -> dict:
    """Build a retrospective output from working memory (no LLM).

    This is the fallback used by ``maestro retrospective run`` when the
    user wants to re-derive a learning entry for a past issue without
    burning an LLM call. It walks the working memory's phase sections
    and produces a structured output that the flow engine could have
    written if it had run a real retrospective.

    The output is intentionally conservative — it only reports what
    the data already shows, never invents new content. If a section is
    missing or empty, the corresponding list is empty.

    Args:
        issue_num: The issue to re-derive a learning for.
        memory_dir: Directory containing working memory files.
        repo_path: The target repo (used as a fallback for the
            repo-specific learnings header).

    Returns:
        A retrospective-output dict with the same shape as a parsed
        ``PHASE_OUTPUT`` block. Keys: ``outcome``, ``what_worked``,
        ``what_failed``, ``surprising``, ``repo_specific_learnings``,
        ``proposed_amendments``.
    """
    store = MemoryStore(issue_num, memory_dir=memory_dir)
    memory = store.load()

    what_worked: list[str] = []
    what_failed: list[str] = []

    for phase_name in ("scout", "builder", "reviewer", "test_runner", "diagnostic"):
        phase_data = getattr(memory, phase_name, None)
        if not isinstance(phase_data, dict) or not phase_data:
            continue
        status = str(phase_data.get("status", ""))
        if status == "success":
            what_worked.append(f"{phase_name} completed successfully")
        elif status in ("reject", "rejected", "error"):
            details = str(phase_data.get("details", "") or "")[:120]
            what_failed.append(f"{phase_name} {status}: {details}")

    # Repo-specific facts we can derive from memory
    repo_specific: list[str] = []
    if isinstance(memory.files_touched, list) and memory.files_touched:
        repo_specific.append(
            f"Modified {len(memory.files_touched)} files in this flow"
        )
    if isinstance(memory.test_results, list) and memory.test_results:
        passed = sum(
            1 for r in memory.test_results
            if isinstance(r, dict) and r.get("status") in ("success", "passed")
        )
        total = len(memory.test_results)
        if total:
            repo_specific.append(
                f"Test results in this flow: {passed}/{total} passed"
            )

    # Outcome: any phase in a non-success state means the flow failed
    has_failure = bool(what_failed) or bool(
        isinstance(memory.errors, list) and memory.errors
    )
    outcome = "failure" if has_failure else "success"

    # Recurrence check: if we've seen similar failures ≥3 times, propose
    # an amendment. We synthesise a "current failure" string from
    # ``what_failed`` and let the detector do its work.
    proposed_amendments: list[dict] = []
    if what_failed:
        current_failure = "; ".join(what_failed)
        try:
            occurrences = count_recurring_patterns(repo_path, current_failure)
        except Exception:
            occurrences = 0
        if occurrences >= 3:
            proposed_amendments.append({
                "title": f"Recurring pattern in {repo_path.name or 'repo'}",
                "root_cause": (
                    "Same failure category appeared in "
                    f"{occurrences} entries (see learnings.md)"
                ),
                "proposed_fix": (
                    "Review .maestro/learnings.md and harden the relevant prompt "
                    "or guardrail."
                ),
                "effort": "TBD",
            })

    return {
        "outcome": outcome,
        "what_worked": what_worked,
        "what_failed": what_failed,
        "surprising": [],
        "repo_specific_learnings": repo_specific,
        "proposed_amendments": proposed_amendments,
    }


# ─── Click group ─────────────────────────────────────────────────────────


@click.group(name="retrospective")
def retrospective_cli() -> None:
    """Manage retrospectives and per-repo learnings."""


# ─── run ─────────────────────────────────────────────────────────────────


@retrospective_cli.command("run")
@click.argument("issue_num", type=int)
@click.option(
    "--repo-path",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default=".",
    show_default=True,
    help="Target repo path (defaults to cwd).",
)
@click.option(
    "--memory-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path(".maestro/tasks/active"),
    show_default=True,
    help="Working memory directory.",
)
def run_cmd(issue_num: int, repo_path: Path, memory_dir: Path) -> None:
    """Manually re-derive a retrospective entry for ISSUE_NUM.

    Reads the working memory and synthesises a learning entry without
    calling the LLM. For full LLM-based re-runs, use the flow
    engine's auto-retrospective (run a flow that has ``retrospective``
    configured in its transitions).

    The synthesised entry is appended to ``<repo>/.maestro/learnings.md``.
    If the recurrence detector fires, an amendment is also appended to
    ``<repo>/.maestro/proposed-amendments.md``.
    """
    repo = Path(repo_path).resolve()
    output = _synthesize_from_memory(issue_num, memory_dir=memory_dir, repo_path=repo)

    entry = format_learning_entry(issue_num, output["outcome"], output)
    append_to_learnings(repo, entry)
    click.echo(
        f"✓ Wrote retrospective entry for issue #{issue_num} "
        f"to {repo / LEARNINGS_FILENAME}"
    )

    # If the synthesiser proposed amendments, persist them too
    for amendment in output.get("proposed_amendments", []):
        # Recompute the occurrence count for the amendment (we already
        # computed it, but we don't have it here — re-derive cheaply).
        occurrences = 3  # the threshold we triggered on
        amend_entry = format_amendment_entry(amendment, occurrences)
        append_to_amendments(repo, amend_entry)
        click.echo(
            f"  + Proposed amendment: {amendment.get('title', '?')}"
        )


# ─── show ────────────────────────────────────────────────────────────────


@retrospective_cli.command("show")
@click.argument(
    "repo",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
def show_cmd(repo: Path) -> None:
    """Show learnings for REPO (reads ``<repo>/.maestro/learnings.md``)."""
    path = Path(repo) / LEARNINGS_FILENAME
    if not path.exists():
        click.echo(f"No learnings file at {path}")
        return
    click.echo(path.read_text(encoding="utf-8"))


# ─── patterns ────────────────────────────────────────────────────────────


@retrospective_cli.command("patterns")
@click.option(
    "--memory-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=".",
    show_default=True,
    help="Root directory to scan for .maestro/learnings.md files.",
)
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Output as JSON instead of human-readable text.",
)
def patterns_cmd(memory_dir: Path, as_json: bool) -> None:
    """Scan all repos for recurring patterns and aggregate.

    Walks ``--memory-dir`` (defaults to cwd) recursively, reading every
    ``.maestro/learnings.md`` it finds. Prints:

    \b
    - Total entry count
    - Entries broken down by repo
    - Top failure keywords across all repos
    - Most recent 5 entries (truncated to 200 chars each)
    """
    result = scan_all_learnings(memory_dir)

    if as_json:
        # Counter isn't JSON-serialisable; convert to a plain dict.
        out = {
            "total_entries": result["total_entries"],
            "by_repo": dict(result["by_repo"]),
            "recent": result["recent"],
            "common_failures": result["common_failures"],
        }
        click.echo(json.dumps(out, indent=2, ensure_ascii=False))
        return

    click.echo(f"Total entries: {result['total_entries']}")
    click.echo("")

    click.echo("By repo:")
    if result["by_repo"]:
        for repo_name, count in result["by_repo"].most_common():
            click.echo(f"  {repo_name}: {count}")
    else:
        click.echo("  (no learnings found)")
    click.echo("")

    click.echo("Common failure keywords:")
    if result["common_failures"]:
        for kw in result["common_failures"][:10]:
            click.echo(f"  {kw['keyword']}: {kw['count']}")
    else:
        click.echo("  (no failures found)")
    click.echo("")

    click.echo("Recent entries:")
    if result["recent"]:
        for entry in result["recent"][:5]:
            short = entry["entry"][:200].replace("\n", " ")
            click.echo(f"  [{entry['repo']}] {short}...")
    else:
        click.echo("  (no recent entries)")


# ─── amendments ──────────────────────────────────────────────────────────


@retrospective_cli.command("amendments")
@click.argument(
    "repo",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
def amendments_cmd(repo: Path) -> None:
    """Show proposed amendments for REPO.

    Reads ``<repo>/.maestro/proposed-amendments.md``. The file is
    created on demand by ``retrospective run`` (or the in-flow
    retrospective) when a pattern recurs ≥3 times.
    """
    path = Path(repo) / AMENDMENTS_FILENAME
    if not path.exists():
        click.echo(f"No amendments file at {path}")
        return
    click.echo(path.read_text(encoding="utf-8"))


# Allow `python -m commands.retrospective ...` for ops scripts that
# want a programmatic entry point (matches the pattern in
# memory.py / scout.py / evidence.py).
if __name__ == "__main__":
    retrospective_cli()
