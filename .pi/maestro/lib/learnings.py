#!/usr/bin/env python3
"""
learnings.py — Per-repo learnings and amendments for the Maestro
retrospective phase.

Every Maestro flow (success or failure) appends a dated, structured
entry to the target repo's ``.maestro/learnings.md``. When a failure
pattern recurs ≥3 times, an amendment is appended to
``.maestro/proposed-amendments.md`` for human review.

Key design choices (see docs/35-prds/maestro-retrospective.md):

- **Per-repo files, not global.** Each repo has its own conventions
  and gotchas. Per-repo also makes commits clean (the learnings file
  travels with the code it describes).
- **Keyword overlap, not embeddings.** Naive ≥4-char word overlap with
  a threshold of 3 shared words. Zero dependencies, good enough for v1.
  Embeddings can come later if false-positive rate is too high.
- **Amendments are proposals, not auto-applied.** Humans review and
  apply. Auto-applying prompt edits is dangerous.
- **Atomic appends.** The whole file is rewritten to a ``.tmp``
  sibling and then ``os.replace``'d into place. Single-writer is the
  contract (matches the working-memory and evidence gates modules).
- **Schema-tolerant parsing.** Missing fields default to empty. A
  malformed PHASE_OUTPUT yields a "minimal" entry rather than crashing
  the flow.

Public API:

- ``LEARNINGS_FILENAME`` / ``AMENDMENTS_FILENAME`` — canonical paths
- ``format_learning_entry(issue_num, outcome, output)`` — markdown string
- ``format_amendment_entry(amendment, occurrences)`` — markdown string
- ``append_to_learnings(repo_path, entry)`` — atomic append
- ``append_to_amendments(repo_path, entry)`` — atomic append
- ``count_recurring_patterns(repo_path, current_failure)`` — int
- ``parse_retrospective_output(details)`` — dict
- ``scan_all_learnings(memory_dir)`` — aggregate summary
- ``_extract_common_failures(learnings)`` — top failure keywords
- ``now_iso()`` / ``now_iso_date()`` — UTC timestamp helpers
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


# ─── Constants ───────────────────────────────────────────────────────────

LEARNINGS_FILENAME = ".maestro/learnings.md"
AMENDMENTS_FILENAME = ".maestro/proposed-amendments.md"

#: Outcomes in an entry's heading that count as "failure" for the
#: ``_extract_common_failures`` heuristic. Used to filter the corpus
#: down to entries where something went wrong, so we only count
#: failure-keywords that actually correlate with breakage.
FAILURE_OUTCOMES: tuple[str, ...] = ("failure", "rejected", "error")

#: Minimum word length for the recurrence detector's keyword set.
#: Shorter words ("the", "and", "test") produce too much overlap noise.
MIN_KEYWORD_LENGTH: int = 4

#: Minimum shared keywords between current failure and an existing
#: entry to count as "the same pattern". Picked empirically — see
#: tests/test_learnings.py::test_count_recurring_patterns_detects_similar_failures.
KEYWORD_OVERLAP_THRESHOLD: int = 3

#: Phases the synthetic-from-memory output looks at when no LLM is
#: available (used by the ``maestro retrospective run`` CLI command).
SYNTHETIC_PHASES: tuple[str, ...] = (
    "scout", "builder", "reviewer", "test_runner", "diagnostic",
)


# ─── Time helpers ────────────────────────────────────────────────────────


def now_iso() -> str:
    """Return current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def now_iso_date() -> str:
    """Return current UTC date as ``YYYY-MM-DD`` string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ─── PHASE_OUTPUT parsing ────────────────────────────────────────────────

#: Regex that captures the JSON payload between the PHASE_OUTPUT markers.
#: Mirrors the parser in ``scout_findings.py`` so the orchestrator's
#: extraction logic is uniform across phases.
_PHASE_OUTPUT_RE = re.compile(
    r"###\s*PHASE_OUTPUT:\s*success\s*\n(.*?)###\s*END_PHASE_OUTPUT",
    re.DOTALL,
)


def parse_retrospective_output(details: str) -> dict:
    """Parse the JSON block from a retrospective phase's ``PHASE_OUTPUT``.

    On success, returns the parsed dict (possibly partial — callers must
    tolerate missing fields). On any failure (no marker, malformed JSON,
    non-object payload), returns a ``{"parse_error": "<reason>"}``
    envelope so the caller can log the failure and still emit a
    minimal entry.

    Args:
        details: Raw phase output text. Expected to contain a
            ``PHASE_OUTPUT`` block but tolerates missing / malformed input.

    Returns:
        A dict — either the parsed payload or a parse-error envelope.
    """
    if not isinstance(details, str):
        return {"parse_error": "details is not a string"}

    match = _PHASE_OUTPUT_RE.search(details)
    if not match:
        return {"parse_error": "no PHASE_OUTPUT block found"}

    payload = match.group(1).strip()
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        return {"parse_error": str(exc)}

    if not isinstance(parsed, dict):
        return {
            "parse_error": (
                f"PHASE_OUTPUT JSON is not an object "
                f"(got {type(parsed).__name__})"
            ),
        }

    return parsed


# ─── format_learning_entry ───────────────────────────────────────────────


def _ensure_list(value: Any) -> list:
    """Return ``value`` if it's a list, else ``[]``.

    Defensive: the LLM might emit ``null``, a string, or a non-list by
    accident. The entry formatter must not crash on those.
    """
    return list(value) if isinstance(value, list) else []


def _stringify_amendment(a: Any) -> str:
    """Render an amendment object as a one-line human string.

    Accepts either a dict (preferred) or a string. Dict rendering
    prefers ``title``; falls back to ``description``; falls back to
    ``str(dict)`` as a last resort so we never crash.
    """
    if isinstance(a, dict):
        title = a.get("title") or a.get("description") or ""
        if isinstance(title, str) and title.strip():
            return title.strip()
        return str(a)
    if isinstance(a, str):
        return a
    return str(a)


def format_learning_entry(
    issue_num: int,
    outcome: str,
    retrospective_output: dict,
) -> str:
    """Format a retrospective output as a markdown entry.

    The output is the markdown chunk (starting with ``## <date> — Issue
    #N (outcome)``) that gets appended verbatim to the repo's
    ``.maestro/learnings.md``. Empty sections are skipped — a fully
    empty retrospective produces a heading-only entry, not a no-op.

    Args:
        issue_num: The issue number this entry is for.
        outcome: The flow outcome (``"success"``, ``"failure"``,
            ``"rejected"``, ``"error"``). Drives the heading text.
        retrospective_output: Parsed ``PHASE_OUTPUT`` from the
            retrospective phase. Tolerant of missing fields.

    Returns:
        A markdown string ready to append to the learnings file.
    """
    if not isinstance(retrospective_output, dict):
        retrospective_output = {}

    date = now_iso_date()
    parts: list[str] = [f"## {date} — Issue #{issue_num} ({outcome})", ""]

    what_worked = _ensure_list(retrospective_output.get("what_worked"))
    what_failed = _ensure_list(retrospective_output.get("what_failed"))
    surprising = _ensure_list(retrospective_output.get("surprising"))
    repo_specific = _ensure_list(retrospective_output.get("repo_specific_learnings"))
    amendments = _ensure_list(retrospective_output.get("proposed_amendments"))

    if what_worked:
        parts.append(
            "- **What worked:** " + "; ".join(str(x) for x in what_worked)
        )
    if what_failed:
        parts.append(
            "- **What failed:** " + "; ".join(str(x) for x in what_failed)
        )
    if surprising:
        parts.append(
            "- **Surprising:** " + "; ".join(str(x) for x in surprising)
        )
    if repo_specific:
        parts.append(
            "- **Repo-specific learnings:** "
            + "; ".join(str(x) for x in repo_specific)
        )
    if amendments:
        parts.append(
            "- **Proposed amendments:** "
            + "; ".join(_stringify_amendment(a) for a in amendments)
        )

    parts.append("")
    return "\n".join(parts)


def format_amendment_entry(
    amendment: dict,
    occurrences: int,
    today: Optional[str] = None,
) -> str:
    """Format a single amendment proposal as a markdown entry.

    Args:
        amendment: Dict with at least one of ``title`` / ``root_cause`` /
            ``proposed_fix`` / ``effort``. Missing fields fall back to
            ``"TBD"`` so the entry is always well-formed.
        occurrences: How many times this pattern was observed. Recorded
            in the entry so reviewers know how strong the signal is.
        today: Optional override for the date (defaults to today UTC).
            Exposed for tests; not used in production code paths.

    Returns:
        A markdown string ready to append to the amendments file.
    """
    if not isinstance(amendment, dict):
        amendment = {"title": str(amendment)}

    date = today or now_iso_date()
    title = str(amendment.get("title") or "Untitled amendment")
    root_cause = str(amendment.get("root_cause") or "Unknown")
    proposed_fix = str(amendment.get("proposed_fix") or "TBD")
    effort = str(amendment.get("effort") or "TBD")

    return (
        f"## {date} — Recurring: {title}\n"
        f"- **Occurrences:** {occurrences}\n"
        f"- **Root cause:** {root_cause}\n"
        f"- **Proposed fix:** {proposed_fix}\n"
        f"- **Effort:** {effort}\n"
        f"- **Owner:** (unassigned)\n\n"
    )


# ─── Atomic write helpers ────────────────────────────────────────────────


def _learnings_header(repo_name: str) -> str:
    """Return the initial header for a brand-new learnings file."""
    return (
        f"# Maestro Learnings — {repo_name}\n\n"
        f"Accumulated learnings from Maestro runs. Each entry is a dated, "
        f"scoped observation about this repo.\n\n"
    )


def _amendments_header() -> str:
    """Return the initial header for a brand-new amendments file."""
    return (
        f"# Proposed Maestro Amendments\n\n"
        f"Auto-generated amendment proposals based on recurring failure "
        f"patterns. Review and apply manually — do NOT auto-apply.\n\n"
    )


def _atomic_write_text(path: Path, content: str) -> None:
    """Write ``content`` to ``path`` via ``.tmp`` + ``os.replace``.

    Same atomic pattern as ``working_memory.py`` and ``evidence.py``.
    The ``.tmp`` file is a sibling with a literal ``.tmp`` suffix
    appended (e.g. ``learnings.md.tmp``), so a partial file is
    obviously a temp, not a different file type.
    """
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def append_to_learnings(repo_path: Path, entry: str) -> None:
    """Append a formatted entry to the repo's learnings file.

    Initialises the file with a header on first write. Uses an atomic
    write pattern (read existing → write ``.tmp`` → rename) to avoid
    corruption from a crash mid-write.

    Args:
        repo_path: The target repo's root directory. The learnings file
            is ``<repo_path>/.maestro/learnings.md``.
        entry: The markdown string to append. Usually the output of
            :func:`format_learning_entry`.

    Raises:
        OSError: If the directory cannot be created or the file cannot
            be written.
    """
    path = Path(repo_path) / LEARNINGS_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)

    if path.exists():
        existing = path.read_text(encoding="utf-8")
    else:
        # Use the repo directory name as the header title. Falls back to
        # "repo" for paths whose ``.name`` is empty (defensive — shouldn't
        # happen in normal use, but cheap to handle).
        repo_name = path.parent.parent.name or "repo"
        existing = _learnings_header(repo_name)

    _atomic_write_text(path, existing + entry)


def append_to_amendments(repo_path: Path, entry: str) -> None:
    """Append a formatted amendment entry to the repo's amendments file.

    Same atomic write semantics as :func:`append_to_learnings`. The
    file is created on first write with a generic header (no
    per-repo name — the amendments file describes the harness, not
    a single repo).

    Args:
        repo_path: The target repo's root directory. The amendments
            file is ``<repo_path>/.maestro/proposed-amendments.md``.
        entry: The markdown string to append. Usually the output of
            :func:`format_amendment_entry`.
    """
    path = Path(repo_path) / AMENDMENTS_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)

    if path.exists():
        existing = path.read_text(encoding="utf-8")
    else:
        existing = _amendments_header()

    _atomic_write_text(path, existing + entry)


# ─── count_recurring_patterns ────────────────────────────────────────────


def _extract_keywords(text: str, min_length: int = MIN_KEYWORD_LENGTH) -> set[str]:
    """Extract lowercase keywords (length ≥ ``min_length``) from text.

    Words are sequences of word characters (``\\w``) — ASCII letters,
    digits, and underscore. We lowercase before dedup so case
    differences (``Test`` vs ``test``) don't fragment the keyword set.
    """
    if not isinstance(text, str):
        return set()
    return set(re.findall(rf"\b\w{{{min_length},}}\b", text.lower()))


def _iter_entries(text: str) -> list[str]:
    """Split a learnings file's text into per-entry chunks.

    Each entry starts with ``## <date> — Issue #N (outcome)`` so we
    split on ``"\\n## "``. The file header (which begins with ``#``
    not ``##``) is the only chunk we want to skip — we filter it out
    explicitly.
    """
    entries: list[str] = []
    for chunk in text.split("\n## "):
        stripped = chunk.strip()
        if not stripped:
            continue
        # Skip the file header (it starts with `# Maestro Learnings`).
        # After split, the header becomes the first chunk WITHOUT the
        # leading `## `, so it still has `# Maestro Learnings` at top.
        if stripped.startswith("# Maestro Learnings"):
            continue
        entries.append(stripped)
    return entries


def count_recurring_patterns(repo_path: Path, current_failure: str) -> int:
    """Count how many times a similar failure pattern has appeared.

    Uses naive keyword overlap: extract ≥4-char words from
    ``current_failure``, then count entries in the repo's learnings
    file where ≥3 keywords match. The threshold keeps the detector
    from firing on shared stop-word-like substrings.

    Args:
        repo_path: The target repo's root directory.
        current_failure: Free-form description of the current failure
            (typically the ``what_failed`` joined text).

    Returns:
        ``0`` if the file is missing or no entry overlaps. Otherwise
        the number of entries that look similar enough to be the
        "same pattern".

    Note:
        No external dependencies. If the keyword approach produces too
        many false positives, swap in embedding similarity later
        (out of scope for v1).
    """
    path = Path(repo_path) / LEARNINGS_FILENAME
    if not path.exists():
        return 0

    text = path.read_text(encoding="utf-8")
    keywords = _extract_keywords(current_failure)
    if not keywords:
        return 0

    count = 0
    for entry in _iter_entries(text):
        entry_keywords = _extract_keywords(entry)
        if len(keywords & entry_keywords) >= KEYWORD_OVERLAP_THRESHOLD:
            count += 1
    return count


# ─── scan_all_learnings ──────────────────────────────────────────────────


def scan_all_learnings(memory_dir: Path) -> dict:
    """Aggregate learnings across all repos for the ``patterns`` command.

    Walks ``memory_dir`` recursively looking for any
    ``.maestro/learnings.md`` and bundles every entry into a single
    summary. The ``by_repo`` counter is a :class:`collections.Counter`
    (preserves insertion order via ``most_common``). ``recent`` is the
    last 10 entries as encountered on disk (no time-based sort — the
    caller is free to sort if needed).

    Args:
        memory_dir: Root directory to scan. Usually ``.maestro`` or
            the project root. The function matches
            ``**/.maestro/learnings.md`` from this root.

    Returns:
        ``{
            "total_entries": int,
            "by_repo": Counter[str, int],
            "recent": list[{"repo": str, "entry": str}],
            "common_failures": list[{"keyword": str, "count": int}],
        }``

    Note:
        The function is intentionally read-only and never raises —
        a corrupt or partial file is silently skipped, and an empty
        directory returns zero-everything. The CLI is the only
        place that surfaces this to the user.
    """
    all_learnings: list[dict] = []

    root = Path(memory_dir)
    if not root.exists():
        return {
            "total_entries": 0,
            "by_repo": Counter(),
            "recent": [],
            "common_failures": [],
        }

    # Use rglob to walk subdirs. Skip files that don't exist rather
    # than raising — the user might point us at a half-initialised
    # .maestro tree during bootstrap.
    for path in root.rglob(LEARNINGS_FILENAME):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            # Corrupt or unreadable — skip and let the user investigate.
            print(
                f"[learnings] Skipping unreadable file: {path}",
                file=sys.stderr,
            )
            continue

        # The repo name is the directory two levels up from the file:
        # ``<repo>/.maestro/learnings.md`` → ``path.parent.parent.name``.
        repo = path.parent.parent.name or "(unknown)"

        for chunk in _iter_entries(text):
            all_learnings.append({
                "repo": repo,
                "entry": "## " + chunk,
            })

    return {
        "total_entries": len(all_learnings),
        "by_repo": Counter(l["repo"] for l in all_learnings),
        "recent": all_learnings[-10:],
        "common_failures": _extract_common_failures(all_learnings),
    }


def _extract_common_failures(learnings: list[dict]) -> list[dict]:
    """Find failure keywords that appear across multiple entries.

    Heuristic:
        - Only look at entries whose heading contains a failure outcome
          (default: ``failure``, ``rejected``, ``error``).
        - Extract 5+ char words (tighter than the recurrence detector —
          we want signal-rich keywords like ``convention`` not noise
          like ``tests``).
        - Return the top 20 by raw count.

    The output is *correlated with failure* but not causal — a high
    count for the keyword "tests" doesn't mean tests are the problem,
    just that the word "tests" appears in many failure entries. The
    retrospective prompt + a human reviewer are the actual filters.

    Args:
        learnings: List of ``{"repo": str, "entry": str}`` dicts, in
            the same shape returned by :func:`scan_all_learnings`.

    Returns:
        Up to 20 ``{"keyword": str, "count": int}`` dicts, sorted by
        count descending.
    """
    failure_keywords: Counter = Counter()
    for l in learnings:
        entry = l.get("entry", "")
        if not isinstance(entry, str):
            continue
        # Only count entries that look like failures. The outcome is
        # embedded in the first 200 chars (the heading line).
        head = entry[:200]
        is_failure = any(
            f"({outcome}" in head for outcome in FAILURE_OUTCOMES
        )
        if is_failure:
            # 5+ chars to filter noise like "test" / "fail" / "code".
            keywords = re.findall(r"\b\w{5,}\b", entry.lower())
            failure_keywords.update(keywords)

    return [
        {"keyword": k, "count": c}
        for k, c in failure_keywords.most_common(20)
    ]
