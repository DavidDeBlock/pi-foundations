#!/usr/bin/env python3
"""
evidence.py — CLI for writing and inspecting Maestro evidence markers.

Commands (mounted on the top-level ``maestro`` Click group):

    mark-tested         <issue> --command --tests-run --tests-passed --exit-code
    mark-reviewed       <issue> [--critical 0] [--non-blocking 0] [--reviewer human]
    mark-manual-tested  <issue> --scenario [--screenshot-before] [--screenshot-after]
    evidence check      <issue> [--required TYPE]...   exit 0/1
    evidence show       <issue>                        pretty-print all markers

Usage examples:

    maestro mark-tested 42 --command "pnpm test" --tests-run 47 --tests-passed 47 --exit-code 0
    maestro mark-reviewed 42 --critical 0 --non-blocking 2 --reviewer claude-sonnet
    maestro mark-manual-tested 42 --scenario "user can log in"
    maestro evidence check 42 --required tested --required reviewed
    maestro evidence check 42              # defaults to tested + reviewed
    maestro evidence show 42

Design notes:

- The mark-* commands are top-level (not nested under ``evidence``) so they
  match the issue AC: ``maestro mark-tested <issue> ...`` is the canonical
  invocation agents see in the test_runner prompt and in CI scripts.
- The ``check`` and ``show`` subcommands live under ``evidence`` because
  they're inspector/verifier tools, not producers.
- The default evidence directory is ``.maestro/evidence`` (project-relative).
  ``--evidence-dir`` overrides it for ops or tests.
- ``--output-file`` and ``--screenshot-*`` are optional; the marker is still
  useful without them.
- This module is intentionally CLI-only — no library exports. Tests
  exercise the underlying ``EvidenceStore`` and factories directly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

# Add parent to path so we can import the lib package
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from evidence import (  # noqa: E402
    EVIDENCE_DIR,
    EvidenceStore,
    EvidenceType,
    make_manual_tested_marker,
    make_reviewed_marker,
    make_tested_marker,
)


# ─── Top-level Click group (for mark-* commands) ─────────────────────────
#
# These three commands are mounted directly on the top-level ``maestro``
# group (see maestro.py), matching the issue's AC that the canonical
# invocation is ``maestro mark-tested <issue> ...``. We keep them in a
# dedicated Click group here so the implementation is co-located with the
# nested ``evidence`` group, but the group itself is never registered with
# a name in the top-level CLI.
#
# Naming: ``top_evidence_cli`` to distinguish it from the nested
# ``evidence_cli`` group below. The mount sites are in maestro.py.

# Choices string for the ``--required`` option of ``evidence check``.
# Must stay in sync with the EvidenceType enum values.
_EVIDENCE_CHOICES = [t.value for t in EvidenceType]


# ─── mark-tested ─────────────────────────────────────────────────────────


@click.command("mark-tested")
@click.argument("issue_num", type=int)
@click.option("--command", required=True, help="Test command that was run.")
@click.option("--tests-run", required=True, type=int, help="Number of tests executed.")
@click.option("--tests-passed", required=True, type=int, help="Number of tests that passed.")
@click.option("--exit-code", required=True, type=int, help="Exit code of the test command.")
@click.option(
    "--output-file",
    type=click.Path(exists=True, path_type=Path),
    default=None,
    help="Optional file containing test output (recorded for audit).",
)
@click.option(
    "--evidence-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=EVIDENCE_DIR,
    show_default=True,
    help="Directory for evidence files.",
)
def mark_tested_cmd(
    issue_num: int,
    command: str,
    tests_run: int,
    tests_passed: int,
    exit_code: int,
    output_file: Path,
    evidence_dir: Path,
) -> None:
    """Mark ISSUE_NUM as having passed automated tests."""
    marker = make_tested_marker(
        issue=issue_num,
        command=command,
        exit_code=exit_code,
        tests_run=tests_run,
        tests_passed=tests_passed,
    )

    # If a log file is provided, record its existence in ``data`` for
    # downstream audit (size only, not content — we keep markers small).
    if output_file is not None:
        try:
            size = output_file.stat().st_size
        except OSError:
            size = 0
        marker.data["output_file"] = str(output_file)
        marker.data["output_file_size"] = size

    store = EvidenceStore(issue_num, evidence_dir=Path(evidence_dir))
    store.write(marker)

    status = "✓" if marker.verified else "✗"
    click.echo(
        f"{status} Wrote tested evidence for issue #{issue_num} "
        f"({tests_passed}/{tests_run} passed, exit={exit_code}, "
        f"verified={marker.verified})"
    )
    # Exit non-zero if the marker ended up unverified — this makes the
    # command useful in CI scripts that want to fail on bad test runs.
    if not marker.verified:
        sys.exit(1)


# ─── mark-reviewed ───────────────────────────────────────────────────────


@click.command("mark-reviewed")
@click.argument("issue_num", type=int)
@click.option("--critical", default=0, type=int, help="Number of critical issues (default: 0).")
@click.option(
    "--non-blocking",
    default=0,
    type=int,
    help="Number of non-blocking issues (default: 0).",
)
@click.option(
    "--reviewer",
    default="human",
    show_default=True,
    help="Reviewer identifier (name, model, or agent).",
)
@click.option(
    "--evidence-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=EVIDENCE_DIR,
    show_default=True,
    help="Directory for evidence files.",
)
def mark_reviewed_cmd(
    issue_num: int,
    critical: int,
    non_blocking: int,
    reviewer: str,
    evidence_dir: Path,
) -> None:
    """Mark ISSUE_NUM as having been reviewed."""
    marker = make_reviewed_marker(
        issue=issue_num,
        critical_issues=critical,
        non_blocking_issues=non_blocking,
        reviewer=reviewer,
    )
    store = EvidenceStore(issue_num, evidence_dir=Path(evidence_dir))
    store.write(marker)

    status = "✓" if marker.verified else "✗"
    click.echo(
        f"{status} Wrote reviewed evidence for issue #{issue_num} "
        f"(critical={critical}, non-blocking={non_blocking}, "
        f"verified={marker.verified})"
    )
    if not marker.verified:
        sys.exit(1)


# ─── mark-manual-tested ──────────────────────────────────────────────────


@click.command("mark-manual-tested")
@click.argument("issue_num", type=int)
@click.option(
    "--scenario",
    required=True,
    help="User-facing scenario verified (free text, e.g. 'user can log in').",
)
@click.option(
    "--screenshot-before",
    type=click.Path(exists=True, path_type=Path),
    default=None,
    help="Optional path to a 'before' screenshot.",
)
@click.option(
    "--screenshot-after",
    type=click.Path(exists=True, path_type=Path),
    default=None,
    help="Optional path to an 'after' screenshot.",
)
@click.option(
    "--verified-by",
    default="playwright",
    show_default=True,
    help="What produced the manual verification (e.g. 'playwright', 'human').",
)
@click.option(
    "--evidence-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=EVIDENCE_DIR,
    show_default=True,
    help="Directory for evidence files.",
)
def mark_manual_tested_cmd(
    issue_num: int,
    scenario: str,
    screenshot_before: Path,
    screenshot_after: Path,
    verified_by: str,
    evidence_dir: Path,
) -> None:
    """Mark ISSUE_NUM as having been manually verified (e.g. via Playwright)."""
    marker = make_manual_tested_marker(
        issue=issue_num,
        scenario=scenario,
        screenshot_before=str(screenshot_before) if screenshot_before else "",
        screenshot_after=str(screenshot_after) if screenshot_after else "",
        verified_by=verified_by,
    )
    store = EvidenceStore(issue_num, evidence_dir=Path(evidence_dir))
    store.write(marker)

    click.echo(
        f"✓ Wrote manual-tested evidence for issue #{issue_num} "
        f"(scenario: {scenario}, verified_by: {verified_by})"
    )


# ─── Nested ``evidence`` group (for check / show) ────────────────────────


@click.group(name="evidence")
def evidence_cli() -> None:
    """Inspect and verify Maestro evidence markers."""


@evidence_cli.command("check")
@click.argument("issue_num", type=int)
@click.option(
    "--required",
    "required",
    multiple=True,
    type=click.Choice(_EVIDENCE_CHOICES, case_sensitive=False),
    help=(
        "Required evidence type. May be passed multiple times. "
        "Defaults to 'tested' and 'reviewed' (PR-flow policy) if not given."
    ),
)
@click.option(
    "--evidence-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=EVIDENCE_DIR,
    show_default=True,
    help="Directory for evidence files.",
)
def check_cmd(issue_num: int, required: tuple, evidence_dir: Path) -> None:
    """Check that all required evidence markers are present for ISSUE_NUM.

    Exits 0 if all required markers are present and verified, 1 if any
    are missing or unverified. Designed for use as a local ``is_local``
    phase command (the close phase invokes this).
    """
    # Default policy for PR flows when --required is not given.
    if not required:
        required = ("tested", "reviewed")
    required_types = [EvidenceType(r) for r in required]

    store = EvidenceStore(issue_num, evidence_dir=Path(evidence_dir))
    ok, missing = store.check(required_types)
    required_values = [t.value for t in required_types]

    if ok:
        click.echo(
            f"✓ All required evidence present for issue #{issue_num}: {required_values}"
        )
        return

    missing_values = [
        m.value if isinstance(m, EvidenceType) else str(m) for m in missing
    ]
    click.echo(
        f"✗ Missing evidence for issue #{issue_num}: {missing_values} "
        f"(required: {required_values})",
        err=True,
    )
    sys.exit(1)


@evidence_cli.command("show")
@click.argument("issue_num", type=int)
@click.option(
    "--evidence-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=EVIDENCE_DIR,
    show_default=True,
    help="Directory for evidence files.",
)
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Output raw JSON instead of a pretty tree.",
)
def show_cmd(issue_num: int, evidence_dir: Path, as_json: bool) -> None:
    """Show all evidence markers for ISSUE_NUM (verified/unverified/missing)."""
    store = EvidenceStore(issue_num, evidence_dir=Path(evidence_dir))
    markers = {}
    for etype in EvidenceType:
        marker = store.read(etype)
        markers[etype] = marker

    if as_json:
        out = {
            etype.value: (marker.to_file_payload() if marker else None)
            for etype, marker in markers.items()
        }
        click.echo(json.dumps(out, indent=2, ensure_ascii=False))
        return

    # Pretty tree: one line per type with a status glyph.
    click.echo(f"Evidence for issue #{issue_num} ({store.dir}):")
    click.echo("")
    for etype, marker in markers.items():
        if marker is None:
            click.echo(f"  · {etype.value:<14}  (missing)")
            continue
        glyph = "✓" if marker.verified else "✗"
        verified_str = "verified" if marker.verified else "UNVERIFIED"
        click.echo(
            f"  {glyph} {etype.value:<14}  {verified_str}  "
            f"by={marker.created_by}  at={marker.created_at}"
        )
        # Indent the data block
        data_lines = json.dumps(marker.data, indent=2, ensure_ascii=False).splitlines()
        for line in data_lines:
            click.echo(f"      {line}")
        if marker.content_hash:
            click.echo(f"      hash: {marker.content_hash[:16]}...")


# Allow `python -m commands.evidence ...` for ops scripts that want a
# programmatic entry point (mirrors the pattern in memory.py / scout.py).
if __name__ == "__main__":
    # The ``if __name__ == "__main__"`` block invokes the mark-tested command
    # by default for backward-compat with ad-hoc CLI usage — most ops scripts
    # call ``python3 -m commands.evidence mark-tested 42 ...`` directly though.
    evidence_cli()
