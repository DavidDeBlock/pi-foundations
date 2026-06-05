#!/usr/bin/env python3
"""
Unit tests for ``lib/learnings.py`` — the per-repo learnings and
amendments module backing the Maestro retrospective phase.

Covers the 10 AC-listed tests:

- ``test_format_learning_entry_includes_all_sections``
- ``test_format_learning_entry_handles_empty_fields``
- ``test_append_to_learnings_creates_file_with_header``
- ``test_append_to_learnings_appends_to_existing_file``
- ``test_count_recurring_patterns_returns_zero_for_new_repo``
- ``test_count_recurring_patterns_detects_similar_failures``
- ``test_scan_all_learnings_aggregates_across_repos``
- ``test_extract_common_failures_finds_recurring_keywords``
- ``test_atomic_write_pattern_preserves_existing_content``
- ``test_learnings_file_format_is_valid_markdown``

Plus a few supporting tests (parse, amendment formatting, header
initialisation) that aren't in the AC but are needed for confidence.

Run with: ``python3 tests/test_learnings.py``
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

# Add lib to path so we can import the module under test without
# installing the package.
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from learnings import (  # noqa: E402
    AMENDMENTS_FILENAME,
    LEARNINGS_FILENAME,
    _extract_common_failures,
    _extract_keywords,
    append_to_amendments,
    append_to_learnings,
    count_recurring_patterns,
    format_amendment_entry,
    format_learning_entry,
    parse_retrospective_output,
    scan_all_learnings,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir(prefix: str = "maestro_learnings_test_") -> Path:
    """Return a fresh empty temp directory."""
    return Path(tempfile.mkdtemp(prefix=prefix))


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir."""
    import shutil
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


# ─── format_learning_entry ───────────────────────────────────────────────


def test_format_learning_entry_includes_all_sections():
    """A full retrospective output produces a markdown entry with every
    populated section rendered as a bullet."""
    output = {
        "outcome": "success",
        "what_worked": ["scout identified the right files", "builder followed conventions"],
        "what_failed": ["ignored the type hint in foo.ts"],
        "surprising": ["repo uses bun, not pnpm"],
        "repo_specific_learnings": ["bun, not pnpm"],
        "proposed_amendments": [{"title": "tighten builder prompt"}],
    }
    entry = format_learning_entry(42, "success", output)
    # Heading
    assert "## " in entry
    assert "Issue #42" in entry
    assert "(success)" in entry
    # All sections rendered
    assert "**What worked:**" in entry
    assert "**What failed:**" in entry
    assert "**Surprising:**" in entry
    assert "**Repo-specific learnings:**" in entry
    assert "**Proposed amendments:**" in entry
    # Specific content present
    assert "scout identified" in entry
    assert "tighten builder prompt" in entry


def test_format_learning_entry_handles_empty_fields():
    """Empty / missing fields produce a minimal but valid entry.

    A retrospective that finds nothing to report should still produce a
    heading-only entry (so the file gets a timestamp + issue marker).
    """
    entry = format_learning_entry(7, "success", {})
    # Heading still present
    assert "## " in entry
    assert "Issue #7" in entry
    assert "(success)" in entry
    # No bullet sections
    assert "**What worked:**" not in entry
    assert "**What failed:**" not in entry

    # Empty lists behave the same
    entry2 = format_learning_entry(8, "failure", {
        "what_worked": [],
        "what_failed": [],
        "surprising": [],
        "repo_specific_learnings": [],
        "proposed_amendments": [],
    })
    assert "## " in entry2
    assert "Issue #8" in entry2

    # Garbage types must not crash
    entry3 = format_learning_entry(9, "error", None)
    assert "## " in entry3
    assert "Issue #9" in entry3

    # Non-list fields coerced to empty
    entry4 = format_learning_entry(10, "error", {
        "what_worked": "not a list",
        "what_failed": 42,
    })
    assert "## " in entry4
    assert "**What worked:**" not in entry4  # string, not list — skipped


# ─── append_to_learnings ─────────────────────────────────────────────────


def test_append_to_learnings_creates_file_with_header():
    """First write to a new repo creates the file with a header."""
    d = _make_dir()
    try:
        # Treat ``d`` as the repo root
        entry = format_learning_entry(1, "success", {"what_worked": ["x"]})
        append_to_learnings(d, entry)

        path = d / LEARNINGS_FILENAME
        assert path.exists(), "learnings.md should be created"
        text = path.read_text(encoding="utf-8")
        # Header present
        assert text.startswith("# Maestro Learnings — ")
        # Header includes the repo name (from ``d.name``)
        assert d.name in text
        # Entry appended
        assert "Issue #1" in text
        assert "**What worked:**" in text
    finally:
        _cleanup(d)


def test_append_to_learnings_appends_to_existing_file():
    """Subsequent writes append (don't replace) and the header stays
    on top of the file."""
    d = _make_dir()
    try:
        # First entry
        append_to_learnings(d, format_learning_entry(1, "success", {"what_worked": ["a"]}))
        # Second entry
        append_to_learnings(d, format_learning_entry(2, "failure", {"what_failed": ["b"]}))

        text = (d / LEARNINGS_FILENAME).read_text(encoding="utf-8")
        # Header is on the first line (not duplicated)
        assert text.startswith("# Maestro Learnings")
        # Both entries present
        assert "Issue #1" in text
        assert "Issue #2" in text
        # Order: header first, then entry 1, then entry 2
        idx1 = text.index("Issue #1")
        idx2 = text.index("Issue #2")
        assert idx1 < idx2
    finally:
        _cleanup(d)


# ─── count_recurring_patterns ────────────────────────────────────────────


def test_count_recurring_patterns_returns_zero_for_new_repo():
    """A repo with no learnings file returns 0 (not an error)."""
    d = _make_dir()
    try:
        # No file exists
        count = count_recurring_patterns(d, "anything goes here")
        assert count == 0
    finally:
        _cleanup(d)


def test_count_recurring_patterns_detects_similar_failures():
    """Two entries that share ≥3 keywords with the current failure
    should both be counted."""
    d = _make_dir()
    try:
        # First entry: contains "convention", "snake_case", "migrations", "ignored"
        append_to_learnings(d, format_learning_entry(
            1, "failure", {
                "what_failed": [
                    "builder ignored the snake_case convention in migrations directory"
                ],
            },
        ))
        # Second entry: contains "convention", "snake_case", "schema", "ignored"
        # (shares "convention", "snake_case", "ignored" with the first)
        append_to_learnings(d, format_learning_entry(
            2, "failure", {
                "what_failed": [
                    "schema builder ignored the snake_case convention again"
                ],
            },
        ))

        # Current failure: shares "convention", "snake_case", "ignored" with both
        current = "type builder ignored the snake_case convention in another file"
        count = count_recurring_patterns(d, current)
        assert count == 2, f"Expected 2 matching entries, got {count}"
    finally:
        _cleanup(d)


# ─── scan_all_learnings ──────────────────────────────────────────────────


def test_scan_all_learnings_aggregates_across_repos():
    """scan_all_learnings walks the root, finds every
    ``.maestro/learnings.md``, and aggregates counts + recents + common
    failures across all of them."""
    root = _make_dir()
    try:
        # Two repos under root
        repo_a = root / "repo-a"
        repo_b = root / "repo-b"
        repo_a.mkdir()
        repo_b.mkdir()

        append_to_learnings(repo_a, format_learning_entry(
            1, "success", {"what_worked": ["scout"], "repo_specific_learnings": ["x"]},
        ))
        append_to_learnings(repo_a, format_learning_entry(
            2, "failure", {"what_failed": ["convention ignored in migrations"]},
        ))
        append_to_learnings(repo_b, format_learning_entry(
            3, "failure", {"what_failed": ["convention ignored in auth layer"]},
        ))

        result = scan_all_learnings(root)
        assert result["total_entries"] == 3
        # by_repo is a Counter — both repos present
        assert dict(result["by_repo"]) == {"repo-a": 2, "repo-b": 1}
        # recent: last 3 (or 10, whichever smaller) — should be 3 here
        assert len(result["recent"]) == 3
        # common_failures: at least one keyword present
        assert isinstance(result["common_failures"], list)
    finally:
        _cleanup(root)


def test_scan_all_learnings_handles_empty_root():
    """An empty / missing root returns zero-everything, no crash."""
    d = _make_dir()
    try:
        result = scan_all_learnings(d)
        assert result["total_entries"] == 0
        assert dict(result["by_repo"]) == {}
        assert result["recent"] == []
        assert result["common_failures"] == []
    finally:
        _cleanup(d)


# ─── _extract_common_failures ────────────────────────────────────────────


def test_extract_common_failures_finds_recurring_keywords():
    """Failure entries contribute their keywords to the failure counter;
    success entries do not."""
    learnings = [
        {"repo": "a", "entry": "## 2026-01-01 — Issue #1 (failure)\n- **What failed:** migrations convention ignored"},
        {"repo": "b", "entry": "## 2026-01-02 — Issue #2 (success)\n- **What worked:** scout"},
        {"repo": "c", "entry": "## 2026-01-03 — Issue #3 (failure)\n- **What failed:** convention ignored again"},
    ]
    failures = _extract_common_failures(learnings)
    assert isinstance(failures, list)
    # The keyword "convention" appears in BOTH failure entries but not
    # the success entry. It should be ranked.
    keywords = {f["keyword"] for f in failures}
    assert "convention" in keywords
    # "convention" should have count 2
    convention = next(f for f in failures if f["keyword"] == "convention")
    assert convention["count"] == 2


# ─── Atomic write ────────────────────────────────────────────────────────


def test_atomic_write_pattern_preserves_existing_content():
    """A crash simulation: if a ``.tmp`` file is left behind, the next
    append still works correctly (and overwrites the stale tmp)."""
    d = _make_dir()
    try:
        # Stale .tmp from a previous (crashed) write
        (d / LEARNINGS_FILENAME).parent.mkdir(parents=True, exist_ok=True)
        (d / (LEARNINGS_FILENAME + ".tmp")).write_text("garbage", encoding="utf-8")

        # Normal append — should work despite the stale tmp
        append_to_learnings(d, format_learning_entry(1, "success", {"what_worked": ["x"]}))

        text = (d / LEARNINGS_FILENAME).read_text(encoding="utf-8")
        assert "Issue #1" in text
        # No leftover .tmp files
        leftovers = list(d.glob("*.tmp"))
        assert leftovers == [], f"Leftover .tmp files: {leftovers}"
    finally:
        _cleanup(d)


# ─── Markdown validity ───────────────────────────────────────────────────


def test_learnings_file_format_is_valid_markdown():
    """The produced file has a sane Markdown structure: a single
    ``# Maestro Learnings — <repo>`` header on the first line, optional
    prose lines after, then one or more ``## YYYY-MM-DD — Issue #N``
    entry headings. We don't enforce bullet-by-bullet structure
    because entries are free-form LLM output.
    """
    d = _make_dir()
    try:
        append_to_learnings(d, format_learning_entry(
            1, "success", {
                "what_worked": ["scout", "builder"],
                "repo_specific_learnings": ["x"],
            },
        ))
        text = (d / LEARNINGS_FILENAME).read_text(encoding="utf-8")
        # No ``<<<EOF`` style shell markers
        assert "EOF" not in text
        # No raw triple-backticks that would unbalance a markdown viewer
        # (the LLM might emit them in surprising text, but our formatter
        # should never add unbalanced fences)
        assert text.count("```") % 2 == 0
        # Top-level header is the first line and references the repo
        first_line = text.splitlines()[0]
        assert first_line.startswith("# Maestro Learnings — ")
        assert d.name in first_line
        # At least one entry heading present (matches ``## YYYY-MM-DD — Issue #N``)
        entry_re = re.compile(r"^## \d{4}-\d{2}-\d{2} — Issue #\d+", re.MULTILINE)
        assert entry_re.search(text), f"No entry heading found in:\n{text}"
    finally:
        _cleanup(d)


# ─── Supporting tests (not in AC) ────────────────────────────────────────


def test_parse_retrospective_output_extracts_json():
    """The PHASE_OUTPUT parser extracts a valid JSON block."""
    text = """some preamble
### PHASE_OUTPUT: success
{
  "outcome": "success",
  "what_worked": ["x"]
}
### END_PHASE_OUTPUT
trailing noise
"""
    parsed = parse_retrospective_output(text)
    assert "parse_error" not in parsed
    assert parsed["outcome"] == "success"
    assert parsed["what_worked"] == ["x"]


def test_parse_retrospective_output_returns_envelope_on_failure():
    """A missing or malformed PHASE_OUTPUT block returns a parse_error
    envelope (so the caller can still log + proceed)."""
    # No marker at all
    assert "parse_error" in parse_retrospective_output("just text")
    # Malformed JSON between markers
    bad = """### PHASE_OUTPUT: success
{ not valid
### END_PHASE_OUTPUT"""
    assert "parse_error" in parse_retrospective_output(bad)
    # Non-dict JSON
    arr = """### PHASE_OUTPUT: success
[1, 2, 3]
### END_PHASE_OUTPUT"""
    assert "parse_error" in parse_retrospective_output(arr)
    # Non-string input
    assert "parse_error" in parse_retrospective_output(None)


def test_format_amendment_entry_produces_well_formed_markdown():
    """Amendment entries are well-formed even with missing fields."""
    amend = {
        "title": "tighten builder prompt",
        "root_cause": "builder ignores conventions",
        "proposed_fix": "add a 'convention emphasis' line",
        "effort": "30 min",
    }
    entry = format_amendment_entry(amend, occurrences=5)
    assert "## " in entry
    assert "Recurring: tighten builder prompt" in entry
    assert "**Occurrences:** 5" in entry
    assert "**Root cause:** builder ignores conventions" in entry
    assert "**Proposed fix:**" in entry
    assert "**Effort:** 30 min" in entry
    assert "**Owner:** (unassigned)" in entry

    # Missing fields fall back to safe defaults (TBD / Unknown)
    partial = format_amendment_entry({"title": "x"}, occurrences=3)
    assert "**Root cause:** Unknown" in partial
    assert "**Proposed fix:** TBD" in partial


def test_amendments_file_creates_with_header():
    """First write to ``.maestro/proposed-amendments.md`` creates the
    file with a generic header."""
    d = _make_dir()
    try:
        amend_entry = format_amendment_entry({"title": "x"}, occurrences=3)
        append_to_amendments(d, amend_entry)

        path = d / AMENDMENTS_FILENAME
        assert path.exists()
        text = path.read_text(encoding="utf-8")
        assert text.startswith("# Proposed Maestro Amendments")
        assert "Recurring: x" in text
    finally:
        _cleanup(d)


def test_keyword_extraction_filters_short_words():
    """``_extract_keywords`` only returns words ≥ ``MIN_KEYWORD_LENGTH``."""
    # "this" (4 chars) is exactly at the threshold; "and" (3) is filtered
    kw = _extract_keywords("this and that test")
    assert "this" in kw
    assert "that" in kw
    assert "test" in kw
    assert "and" not in kw
    # Non-strings return empty
    assert _extract_keywords(None) == set()
    assert _extract_keywords(12345) == set()


# ─── Test runner ─────────────────────────────────────────────────────────


def main() -> int:
    """Run all tests in this file and return exit code 0 iff all pass."""
    import inspect

    failures: list[tuple[str, str]] = []
    tests = sorted(
        (name, fn)
        for name, fn in inspect.getmembers(sys.modules[__name__], inspect.isfunction)
        if name.startswith("test_")
    )

    for name, fn in tests:
        try:
            fn()
        except AssertionError as e:
            failures.append((name, f"AssertionError: {e}"))
        except Exception as e:  # noqa: BLE001
            failures.append((name, f"{type(e).__name__}: {e}"))

    total = len(tests)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        print("\nFAILURES:")
        for name, msg in failures:
            print(f"  - {name}: {msg}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
