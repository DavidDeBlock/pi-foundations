#!/usr/bin/env python3
"""
onboard.py — CLI for ``maestro onboard <path>`` — register a repo with Maestro.

The onboard command captures *per-repo context* (commands, conventions,
gotchas, evidence strategy) so every subsequent Maestro flow can
auto-load it instead of re-discovering it. Two modes:

- **Mechanical** (default): fast, deterministic, no human. Runs
  :func:`probe_repo` to detect languages / package manager / frameworks
  / git remote. Subjective fields (conventions, gotchas) stay empty
  until an interview is run.
- **``--interview``**: slow, agent-driven. Runs the interviewer
  agent (see ``prompts/interviewer.md``) to capture subjective
  context that mechanical probing can't see. The interview can take
  up to 10 minutes; the LLM calls the user back via AskUserQuestion.

Both modes write:
    - A new entry in ``.maestro/projects.json`` keyed by SHA256 hash
      of the resolved repo path (first 12 chars).
    - An initial ``.maestro/learnings.md`` in the target repo with
      the detected basics (only on first onboard — re-onboarding
      leaves the existing learnings alone).

``--re-interview`` re-runs the interview against an *existing* entry,
updating the subjective fields (conventions, gotchas, evidence
strategy) but keeping the mechanical data intact. ``--alias`` sets a
friendly name on the entry; without it, the alias defaults to the
repo's directory name.

Usage:
    maestro onboard /path/to/repo
    maestro onboard ./my-repo --interview
    maestro onboard /path/to/repo --re-interview
    maestro onboard /path/to/repo --alias my-cool-repo
    maestro onboard /path/to/repo --registry /custom/path/projects.json

Design notes:

- **Idempotent.** Running ``maestro onboard`` on an already-onboarded
  repo overwrites the existing entry rather than creating a duplicate.
  Mechanical data is always refreshed; subjective data is only
  overwritten when ``--interview`` / ``--re-interview`` is passed.
- **Backward compat.** The CLI never auto-onboards. Repos that haven't
  been onboarded still work — they just lack pre-loaded context. See
  ``flow_engine.py:run_flow_on_issue`` for the auto-load path.
- **Interview failures don't lose mechanical work.** If the
  interviewer agent errors out (timeout, parse failure), the entry
  is still written with the mechanical data only and a warning
  printed to stderr. Re-running with ``--re-interview`` retries the
  subjective half.
- **Learnings file is *seeded*, not replaced.** Re-onboarding never
  deletes a repo's existing ``.maestro/learnings.md`` — the file
  grows over time as the retrospective phase adds entries. The
  first-time seed is initialised only when the file is absent.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import click

# ─── Path setup ──────────────────────────────────────────────────────────
#
# This file lives at ``.pi/maestro/commands/onboard.py``. We need both
# ``.pi/maestro`` and ``.pi/maestro/lib`` on sys.path so the imports
# work whether the module is invoked via ``python3 -m commands.onboard``
# OR through the top-level ``maestro.py`` aggregator.

_COMMANDS_DIR = Path(__file__).parent.resolve()
_MAESTRO_DIR = _COMMANDS_DIR.parent
if str(_MAESTRO_DIR / "lib") not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR / "lib"))
if str(_MAESTRO_DIR) not in sys.path:
    sys.path.insert(0, str(_MAESTRO_DIR))

# Imports must come after path setup.
from repo_probe import ProbeResult, probe_repo  # noqa: E402
from projects_registry import (  # noqa: E402
    REGISTRY_FILENAME,
    ProjectsRegistry,
    hash_repo_path,
)
from rpc_client import run_rpc_with_session_log  # noqa: E402
from prompt_loader import load_prompt  # noqa: E402


# ─── PHASE_OUTPUT parser ────────────────────────────────────────────────

#: Regex matching the interviewer's ``PHASE_OUTPUT`` block. Mirrors the
#: shape used by every other agent prompt in the codebase — see
#: ``scout_findings.py`` and ``learnings.py`` for the same pattern.
_PHASE_OUTPUT_RE = re.compile(
    r"###\s*PHASE_OUTPUT:\s*success\s*\n(.*?)###\s*END_PHASE_OUTPUT",
    re.DOTALL,
)


def _now_iso() -> str:
    """Return current UTC time as ISO-8601 string (local helper)."""
    return datetime.now(timezone.utc).isoformat()


def parse_interview_output(raw_output: str) -> dict:
    """Parse the interviewer's ``PHASE_OUTPUT`` block.

    Returns the parsed JSON dict on success, or a ``{"parse_error": "..."}``
    envelope on any failure. The envelope shape matches
    :func:`learnings.parse_retrospective_output` so callers can use the
    same error-handling logic.

    Args:
        raw_output: The full text of the interviewer's response.

    Returns:
        Dict with at least one of: the parsed payload (containing
        ``evidence_strategy``, ``conventions``, ``gotchas``,
        ``playbooks_recommended``, ``primary_reviewer``), or a
        ``parse_error`` key with a human-readable reason.
    """
    if not isinstance(raw_output, str):
        return {"parse_error": "interviewer output is not a string"}

    match = _PHASE_OUTPUT_RE.search(raw_output)
    if not match:
        return {"parse_error": "no PHASE_OUTPUT block found in interviewer response"}

    payload = match.group(1).strip()
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        return {"parse_error": f"interviewer PHASE_OUTPUT is not valid JSON: {exc}"}

    if not isinstance(parsed, dict):
        return {
            "parse_error": (
                f"interviewer PHASE_OUTPUT is not a JSON object "
                f"(got {type(parsed).__name__})"
            )
        }

    return parsed


# ─── Interview prompt builder ───────────────────────────────────────────


def build_interview_prompt(repo_path: Path, probe_data: dict) -> str:
    """Build the prompt that drives the interviewer agent.

    Loads ``prompts/interviewer.md`` (frontmatter + body) and substitutes
    the repo path and the mechanical probe data into the template
    variables. The interviewer then asks the user 3-5 questions and
    emits a ``PHASE_OUTPUT`` block.

    Args:
        repo_path: Absolute path to the target repo. Used for display
            in the prompt and for the agent's Bash/Read calls.
        probe_data: The :func:`probe_repo` result as a dict (or any
            dict with the same shape — see :meth:`ProbeResult.to_dict`).

    Returns:
        A fully-rendered prompt string ready to feed to the LLM.
    """
    prompt_dir = _MAESTRO_DIR / "prompts"
    loaded = load_prompt(prompt_dir, "interviewer", explicit_tools=None)

    variables = {
        "{repo_path}": str(repo_path),
        "{probe_data_json}": json.dumps(probe_data, indent=2, ensure_ascii=False),
    }
    prompt = loaded.body
    for key, value in variables.items():
        prompt = prompt.replace(key, value)
    return prompt


# ─── Learnings seed ─────────────────────────────────────────────────────


def seed_learnings_file(
    repo_path: Path,
    probe: ProbeResult,
    interview_data: Optional[dict] = None,
) -> bool:
    """Seed ``<repo>/.maestro/learnings.md`` on first onboard.

    Idempotent — if the file already exists, this is a no-op (the
    retrospective phase will append new entries over time, and we
    don't want to clobber accumulated knowledge). The first-time
    seed gives the repo an initial set of observations based on
    the mechanical probe and (if available) the interview answers.

    Args:
        repo_path: The target repo's root directory.
        probe: The mechanical probe result.
        interview_data: Optional dict from the interviewer agent.
            Used to seed ``conventions`` and ``gotchas`` observations
            if present.

    Returns:
        ``True`` if the file was created, ``False`` if it already
        existed (no-op).
    """
    path = repo_path / ".maestro" / "learnings.md"
    if path.exists():
        return False

    path.parent.mkdir(parents=True, exist_ok=True)

    repo_name = repo_path.name or "repo"
    lines: list[str] = [
        f"# Maestro Learnings — {repo_name}",
        "",
        f"Accumulated learnings from Maestro runs on this repo. ",
        f"Initial observations seeded by ``maestro onboard`` on {_now_iso()[:10]}.",
        "",
        "## Onboarding observations",
        "",
    ]

    if probe.languages:
        lines.append(
            f"- **Languages detected:** {', '.join(probe.languages)}"
        )
    if probe.package_manager:
        lines.append(
            f"- **Package manager:** `{probe.package_manager}`"
        )
    if probe.test_command:
        lines.append(
            f"- **Test command:** `{probe.test_command}`"
        )
    if probe.build_command:
        lines.append(
            f"- **Build command:** `{probe.build_command}`"
        )
    if probe.lint_command:
        lines.append(
            f"- **Lint command:** `{probe.lint_command}`"
        )
    if probe.frameworks:
        lines.append(
            f"- **Frameworks:** {', '.join(probe.frameworks)}"
        )
    if probe.git_remote:
        lines.append(
            f"- **Git remote:** `{probe.git_remote}`"
        )

    if isinstance(interview_data, dict):
        ev_strategy = interview_data.get("evidence_strategy")
        if isinstance(ev_strategy, str) and ev_strategy:
            lines.append(
                f"- **Evidence strategy:** {ev_strategy}"
            )
        conventions = interview_data.get("conventions") or []
        if isinstance(conventions, list) and conventions:
            lines.append(
                f"- **Conventions:** {'; '.join(str(c) for c in conventions)}"
            )
        gotchas = interview_data.get("gotchas") or []
        if isinstance(gotchas, list) and gotchas:
            lines.append(
                f"- **Gotchas:** {'; '.join(str(g) for g in gotchas)}"
            )
        playbooks = interview_data.get("playbooks_recommended") or []
        if isinstance(playbooks, list) and playbooks:
            lines.append(
                f"- **Recommended playbooks:** {', '.join(str(p) for p in playbooks)}"
            )
        primary_reviewer = interview_data.get("primary_reviewer")
        if isinstance(primary_reviewer, str) and primary_reviewer:
            lines.append(
                f"- **Primary reviewer:** {primary_reviewer}"
            )

    lines.append("")
    # Atomic write: write the full file in one shot (the file is
    # brand new, so no read-modify-write race to worry about).
    path.write_text("\n".join(lines), encoding="utf-8")
    return True


# ─── Entry builder ──────────────────────────────────────────────────────


def build_entry(
    repo_path: Path,
    probe: ProbeResult,
    alias: Optional[str] = None,
    interview_data: Optional[dict] = None,
    existing_entry: Optional[dict] = None,
) -> dict:
    """Build the registry entry for a freshly-onboarded repo.

    Merges the mechanical probe data, the (optional) interview data,
    and the (optional) existing entry's subjective fields. The
    resulting dict is the canonical registry entry shape.

    Field semantics:
        - ``alias``: User-supplied or the repo's directory name.
        - ``path``: Resolved absolute path of the repo.
        - ``hash``: SHA256 (12 chars) of the resolved path.
        - ``probed_at``: Timestamp of *this* onboard call.
        - Mechanical fields (languages, package_manager, etc.):
          Always refreshed from the probe. Never preserved from
          the existing entry.
        - Subjective fields (evidence_strategy, conventions,
          gotchas, playbooks_recommended, primary_reviewer): Only
          overwritten if ``interview_data`` is provided AND has
          those keys. Otherwise preserved from ``existing_entry``.

    Args:
        repo_path: The target repo's absolute path.
        probe: The mechanical probe result.
        alias: Optional user-supplied alias. Defaults to
            ``repo_path.name`` (the directory name).
        interview_data: Optional dict from the interviewer. Only
            consulted for subjective fields; mechanical fields
            are always taken from ``probe``.
        existing_entry: Optional pre-existing entry to preserve
            subjective fields from. Used by ``--re-interview`` to
            avoid clobbering data not captured by the new interview.

    Returns:
        A registry entry dict ready to be passed to
        :meth:`ProjectsRegistry.upsert`.
    """
    resolved = Path(repo_path).resolve()
    resolved_str = str(resolved)

    final_alias = (alias or "").strip() or resolved.name or "repo"

    entry: dict = {
        "alias": final_alias,
        "path": resolved_str,
        "hash": hash_repo_path(resolved_str),
        "probed_at": _now_iso(),
        # Mechanical — always refreshed
        "languages": list(probe.languages),
        "package_manager": probe.package_manager,
        "test_command": probe.test_command,
        "build_command": probe.build_command,
        "lint_command": probe.lint_command,
        "frameworks": list(probe.frameworks),
        "is_git_repo": probe.is_git_repo,
        "git_remote": probe.git_remote,
    }

    # Subjective fields — preserve from existing if no new interview data
    interview_data = interview_data if isinstance(interview_data, dict) else {}
    existing = existing_entry if isinstance(existing_entry, dict) else {}

    def _subjective(key: str, default: object) -> object:
        """Pick the new interview value, else fall back to existing, else default."""
        if key in interview_data and interview_data[key] not in (None, "", []):
            return interview_data[key]
        if key in existing and existing[key] not in (None, "", []):
            return existing[key]
        return default

    entry["evidence_strategy"] = _subjective("evidence_strategy", "")
    entry["conventions"] = _subjective("conventions", [])
    entry["gotchas"] = _subjective("gotchas", [])
    entry["playbooks_recommended"] = _subjective("playbooks_recommended", [])
    entry["primary_reviewer"] = _subjective("primary_reviewer", "")

    # Coerce list fields to lists (defensive — corrupted entries or
    # weird interview outputs could yield scalars)
    for list_key in ("conventions", "gotchas", "playbooks_recommended"):
        if not isinstance(entry[list_key], list):
            entry[list_key] = []

    return entry


# ─── Interview runner ───────────────────────────────────────────────────


def run_interview(repo_path: Path, probe: ProbeResult) -> dict:
    """Run the interviewer agent and return the parsed output.

    Loads ``prompts/interviewer.md``, builds the full prompt with
    repo path + probe data, calls the LLM via
    :func:`run_rpc_with_session_log`, and parses the ``PHASE_OUTPUT``
    block from the response. On any failure (timeout, parse error,
    missing block) returns a ``{"parse_error": "..."}`` envelope —
    the caller decides whether that's a hard fail or just a warning.

    Args:
        repo_path: The target repo's absolute path.
        probe: The mechanical probe result (passed to the agent as
            context for its questions).

    Returns:
        The parsed interview dict (with ``evidence_strategy``,
        ``conventions``, etc.) or a ``parse_error`` envelope.
    """
    prompt = build_interview_prompt(repo_path, probe.to_dict())

    try:
        result = run_rpc_with_session_log(
            prompt,
            phase_name="interviewer",
            timeout_seconds=600,
            model=None,
            provider=None,
            session_dir=None,
            flow_name="onboard",
            issue_num=0,
            tools=["Read", "Bash", "Write"],
        )
    except Exception as e:  # noqa: BLE001
        return {
            "parse_error": f"interviewer agent raised: {type(e).__name__}: {e}"
        }

    raw_output = ""
    if isinstance(result, dict):
        raw_output = result.get("output", "") or ""

    return parse_interview_output(raw_output)


# ─── Click command ──────────────────────────────────────────────────────


@click.command(name="onboard")
@click.argument(
    "repo_path",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
@click.option(
    "--interview",
    is_flag=True,
    help="Run the interviewer agent to capture subjective context (slow).",
)
@click.option(
    "--re-interview",
    is_flag=True,
    help="Re-run the interviewer against an existing entry (updates subjective fields).",
)
@click.option(
    "--alias",
    "alias_name",
    type=str,
    default=None,
    help="Friendly name for this repo. Defaults to the directory name.",
)
@click.option(
    "--registry",
    "registry_path",
    type=click.Path(dir_okay=False, path_type=Path),
    default=REGISTRY_FILENAME,
    show_default=True,
    help="Path to the projects.json registry (relative to cwd or absolute).",
)
def onboard_cmd(
    repo_path: Path,
    interview: bool,
    re_interview: bool,
    alias_name: Optional[str],
    registry_path: Path,
) -> None:
    """Onboard REPO_PATH and register it in ``.maestro/projects.json``.

    Mechanical mode (default): detect languages, package manager,
    commands, and frameworks. Fast and deterministic.

    ``--interview``: also run the interviewer agent to capture
    subjective context (conventions, gotchas, evidence strategy).
    """
    repo = Path(repo_path).resolve()
    registry = ProjectsRegistry(registry_path)
    repo_hash = hash_repo_path(str(repo))

    # Step 1: Mechanical probe
    click.echo(f"Probing {repo}...")
    probe = probe_repo(repo)
    click.echo(
        f"  Detected: languages={probe.languages or '(none)'}, "
        f"package_manager={probe.package_manager or '(none)'}, "
        f"frameworks={probe.frameworks or '(none)'}"
    )
    if probe.git_remote:
        click.echo(f"  Git remote: {probe.git_remote}")

    # Step 2: Interview (optional, only if explicitly asked)
    interview_data: dict = {}
    if interview or re_interview:
        click.echo("")
        click.echo("Running interviewer agent (up to 10 minutes)...")
        interview_data = run_interview(repo, probe)
        if "parse_error" in interview_data:
            click.echo(
                click.style(
                    f"  ⚠ Interview failed: {interview_data['parse_error']}\n"
                    f"  Continuing with mechanical data only. "
                    f"Re-run with --re-interview to retry.",
                    fg="yellow",
                ),
                err=True,
            )
        else:
            click.echo("  ✓ Interview complete")

    # Step 3: Load any existing entry (for --re-interview preservation)
    existing_entry = registry.get(repo_hash)

    if re_interview and existing_entry is None:
        click.echo(
            click.style(
                f"  ⚠ --re-interview was passed but no existing entry was "
                f"found for {repo}. Treating as a fresh onboard.",
                fg="yellow",
            ),
            err=True,
        )

    # Step 4: Build the canonical entry
    entry = build_entry(
        repo_path=repo,
        probe=probe,
        alias=alias_name,
        interview_data=interview_data,
        existing_entry=existing_entry,
    )

    # Step 5: Persist
    registry.upsert(entry)
    click.echo("")
    click.echo(
        click.style(
            f"✓ Registered {entry['alias']} in {registry_path} "
            f"(hash={entry['hash']})",
            fg="green",
        )
    )

    # Step 6: Seed the per-repo learnings file (no-op if already exists)
    created = seed_learnings_file(
        repo, probe, interview_data=interview_data or None
    )
    if created:
        click.echo(
            click.style(
                f"✓ Seeded {repo / '.maestro' / 'learnings.md'}",
                fg="green",
            )
        )
    else:
        click.echo(
            f"  (learnings file already exists at {repo / '.maestro' / 'learnings.md'}; left intact)"
        )


# Allow `python -m commands.onboard ...` for ops scripts
if __name__ == "__main__":
    onboard_cmd()
