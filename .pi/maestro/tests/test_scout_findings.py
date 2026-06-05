#!/usr/bin/env python3
"""
Unit tests for scout_findings.py — Structured findings from the Scout phase.

Covers:
- from_dict tolerates all-fields, missing, unknown, and malformed inputs
- to_markdown includes all populated sections and omits empty ones
- to_markdown handles an empty ScoutFindings gracefully
- parse_scout_findings_from_details extracts JSON from PHASE_OUTPUT blocks
- parse_scout_findings_from_details returns a parse-error envelope on
  missing block / malformed JSON / non-object JSON
- format_scout_findings_markdown handles ScoutFindings, dict, None,
  parse-error envelope, and empty inputs

Run with: python3 -m pytest tests/test_scout_findings.py -v
       or: python3 tests/test_scout_findings.py
"""

import sys
from pathlib import Path

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from scout_findings import (
    ScoutFindings,
    parse_scout_findings_from_details,
    format_scout_findings_markdown,
)


# ─── ScoutFindings.from_dict ─────────────────────────────────────────────


def test_from_dict_with_all_fields():
    """All six fields round-trip cleanly when fully populated."""
    d = {
        "relevant_files": ["src/auth/session.ts", "src/auth/session.test.ts"],
        "test_command": "bun test src/auth",
        "patterns": ["uses repository pattern", "tests colocated as *.test.ts"],
        "conventions": ["no default exports", "snake_case for DB columns"],
        "risks": ["session.ts is imported by 12 modules"],
        "scanned_at": "2026-06-04T12:34:00Z",
    }
    sf = ScoutFindings.from_dict(d)

    assert sf.relevant_files == ["src/auth/session.ts", "src/auth/session.test.ts"]
    assert sf.test_command == "bun test src/auth"
    assert sf.patterns == ["uses repository pattern", "tests colocated as *.test.ts"]
    assert sf.conventions == ["no default exports", "snake_case for DB columns"]
    assert sf.risks == ["session.ts is imported by 12 modules"]
    assert sf.scanned_at == "2026-06-04T12:34:00Z"


def test_from_dict_with_missing_optional_fields():
    """Empty dict yields the default-constructed ScoutFindings (all empty)."""
    sf = ScoutFindings.from_dict({})
    assert sf.relevant_files == []
    assert sf.test_command == ""
    assert sf.patterns == []
    assert sf.conventions == []
    assert sf.risks == []
    assert sf.scanned_at == ""


def test_from_dict_with_unknown_fields_ignored():
    """Unknown keys in the input dict are silently dropped (no exception)."""
    d = {
        "relevant_files": ["foo.py"],
        "test_command": "pytest",
        "extra_field_we_dont_know": "should be dropped",
        "another_unknown": {"nested": "stuff"},
    }
    sf = ScoutFindings.from_dict(d)
    assert sf.relevant_files == ["foo.py"]
    assert sf.test_command == "pytest"
    # No public attribute for the unknown fields
    assert not hasattr(sf, "extra_field_we_dont_know")
    assert not hasattr(sf, "another_unknown")


def test_from_dict_with_malformed_types_defaults_safely():
    """A non-list value for a list field falls back to []; non-str to ''."""
    d = {
        "relevant_files": "not a list",       # should coerce to []
        "test_command": 42,                    # should coerce to ""
        "patterns": None,                      # should coerce to []
        "conventions": {"key": "value"},       # should coerce to []
        "risks": ["real risk"],                # should stay
        "scanned_at": ["not", "a", "string"],  # should coerce to ""
    }
    sf = ScoutFindings.from_dict(d)
    assert sf.relevant_files == []
    assert sf.test_command == ""
    assert sf.patterns == []
    assert sf.conventions == []
    assert sf.risks == ["real risk"]
    assert sf.scanned_at == ""


def test_from_dict_with_non_dict_input_returns_empty():
    """Non-dict input (e.g. a list, None, str) yields an empty ScoutFindings."""
    assert ScoutFindings.from_dict(None).relevant_files == []
    assert ScoutFindings.from_dict([]).relevant_files == []
    assert ScoutFindings.from_dict("not a dict").relevant_files == []
    assert ScoutFindings.from_dict(42).relevant_files == []


# ─── ScoutFindings.to_markdown ───────────────────────────────────────────


def test_to_markdown_includes_all_sections():
    """Populated findings render all five sub-sections in the correct order."""
    sf = ScoutFindings(
        relevant_files=["a.py", "b.py"],
        test_command="pytest tests/",
        patterns=["pattern one", "pattern two"],
        conventions=["conv one"],
        risks=["risk one", "risk two"],
        scanned_at="2026-06-04T12:34:00Z",
    )
    md = sf.to_markdown()

    # Heading first
    assert md.startswith("## Scout Findings\n")
    # Each section header present, in order
    idx_files = md.index("### Relevant Files")
    idx_test = md.index("### Test Command")
    idx_patterns = md.index("### Patterns")
    idx_conventions = md.index("### Conventions")
    idx_risks = md.index("### Risks")
    assert idx_files < idx_test < idx_patterns < idx_conventions < idx_risks

    # Spot-check contents
    assert "- `a.py`" in md
    assert "- `b.py`" in md
    assert "`pytest tests/`" in md
    assert "- pattern one" in md
    assert "- conv one" in md
    assert "- ⚠️ risk one" in md
    assert "- ⚠️ risk two" in md


def test_to_markdown_handles_empty_findings():
    """Empty ScoutFindings renders just the heading and a single trailing newline."""
    sf = ScoutFindings()
    md = sf.to_markdown()
    assert md == "## Scout Findings\n"
    # No sub-sections when nothing is populated
    assert "###" not in md


def test_to_markdown_omits_empty_sections():
    """Sections with empty content are not emitted (no orphan headers)."""
    sf = ScoutFindings(relevant_files=["only.py"], test_command="")
    md = sf.to_markdown()
    assert "### Relevant Files" in md
    assert "- `only.py`" in md
    # Empty sections are skipped
    assert "### Test Command" not in md
    assert "### Patterns" not in md
    assert "### Conventions" not in md
    assert "### Risks" not in md


# ─── parse_scout_findings_from_details ──────────────────────────────────


def test_parse_scout_findings_extracts_json_from_phase_output():
    """The JSON payload between the markers is parsed and returned as a dict."""
    details = """Some preamble text from the scout.

### PHASE_OUTPUT: success
{
  "relevant_files": ["a.py", "b.py"],
  "test_command": "pytest",
  "patterns": ["uses repository pattern"],
  "conventions": [],
  "risks": ["risky module"],
  "scanned_at": "2026-06-04T00:00:00Z"
}
### END_PHASE_OUTPUT

Some trailing text."""

    parsed = parse_scout_findings_from_details(details)
    assert isinstance(parsed, dict)
    assert "parse_error" not in parsed
    assert parsed["relevant_files"] == ["a.py", "b.py"]
    assert parsed["test_command"] == "pytest"
    assert parsed["patterns"] == ["uses repository pattern"]
    assert parsed["risks"] == ["risky module"]


def test_parse_scout_findings_handles_missing_phase_output_block():
    """No markers → returns a parse-error envelope with the raw text."""
    details = "I explored the repo but forgot to emit the PHASE_OUTPUT block."
    result = parse_scout_findings_from_details(details)
    assert "parse_error" in result
    assert result["raw"] == details
    assert "no PHASE_OUTPUT block found" in result["parse_error"]


def test_parse_scout_findings_handles_malformed_json():
    """Bad JSON inside the markers → parse-error envelope, raw preserved."""
    details = """### PHASE_OUTPUT: success
{ this is not: valid json,,, }
### END_PHASE_OUTPUT"""
    result = parse_scout_findings_from_details(details)
    assert "parse_error" in result
    assert result["raw"] == details
    # json.JSONDecodeError message is included
    assert "parse_error" in result and len(result["parse_error"]) > 0


def test_parse_scout_findings_handles_non_object_json():
    """JSON that's valid but not an object (e.g. a list) is a parse error."""
    details = """### PHASE_OUTPUT: success
["just", "a", "list"]
### END_PHASE_OUTPUT"""
    result = parse_scout_findings_from_details(details)
    assert "parse_error" in result
    assert "not an object" in result["parse_error"]


def test_parse_scout_findings_handles_non_string_input():
    """Non-string input (e.g. None) yields a parse-error envelope, no crash."""
    result = parse_scout_findings_from_details(None)
    assert "parse_error" in result
    assert "not a string" in result["parse_error"]


# ─── format_scout_findings_markdown ─────────────────────────────────────


def test_format_scout_findings_markdown_with_scout_findings_instance():
    """A populated ScoutFindings is rendered via its own to_markdown()."""
    sf = ScoutFindings(relevant_files=["x.py"], test_command="pytest")
    md = format_scout_findings_markdown(sf)
    assert "## Scout Findings" in md
    assert "- `x.py`" in md
    assert "`pytest`" in md


def test_format_scout_findings_markdown_with_dict():
    """A plain dict is upgraded to ScoutFindings and rendered."""
    d = {"relevant_files": ["y.py"], "test_command": "cargo test"}
    md = format_scout_findings_markdown(d)
    assert "## Scout Findings" in md
    assert "- `y.py`" in md
    assert "`cargo test`" in md


def test_format_scout_findings_markdown_with_none():
    """None input yields the heading + a stable placeholder string."""
    md = format_scout_findings_markdown(None)
    assert md.startswith("## Scout Findings")
    assert "(No scout findings — proceed with general exploration.)" in md


def test_format_scout_findings_markdown_with_empty_findings():
    """Empty ScoutFindings or dict yields the heading + a 'ran but no findings' message."""
    md_sf = format_scout_findings_markdown(ScoutFindings())
    assert md_sf.startswith("## Scout Findings")
    assert "(Scout ran but produced no findings.)" in md_sf

    md_dict = format_scout_findings_markdown({})
    assert md_dict.startswith("## Scout Findings")
    assert "(Scout ran but produced no findings.)" in md_dict


def test_format_scout_findings_markdown_with_parse_error_envelope():
    """A parse-error envelope renders the raw text under a labelled section."""
    envelope = {
        "raw": "I forgot the markers.",
        "parse_error": "no PHASE_OUTPUT block found",
    }
    md = format_scout_findings_markdown(envelope)
    assert "## Scout Findings (raw, unparseable)" in md
    assert "no PHASE_OUTPUT block found" in md
    assert "I forgot the markers." in md


# ─── Test runner ─────────────────────────────────────────────────────────


if __name__ == "__main__":
    # Lightweight in-process runner so the file is runnable without pytest.
    import inspect

    test_funcs = [
        (name, fn)
        for name, fn in globals().items()
        if name.startswith("test_") and callable(fn)
    ]
    failed = 0
    for name, fn in test_funcs:
        try:
            fn()
            print(f"PASS  {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {name}: {e}")
        except Exception as e:
            failed += 1
            print(f"ERROR {name}: {type(e).__name__}: {e}")
    print(f"\n{len(test_funcs) - failed}/{len(test_funcs)} tests passed")
    sys.exit(0 if failed == 0 else 1)
