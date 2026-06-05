#!/usr/bin/env python3
"""
Unit tests for verdict_extractor.py — Verdict code-fence extraction.

Covers:
- ```verdict``` code fence parsing (approved / rejected)
- Last-block-wins semantics (agent reasoning → final commit pattern)
- Wrong language tags (e.g. ```json```) are ignored
- Malformed JSONL handling (should not crash)
- Missing/empty file handling
- Invalid or missing verdict blocks return None status

Run with: python3 tests/test_verdict_extractor.py
"""

import json
import os
import tempfile
from pathlib import Path

# Add lib to path
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from verdict_extractor import (
    _extract_verdict_block,
    _extract_phase_output_block,
    extract_latest_verdict_from_log_dir,
    extract_phase_verdict,
    resolve_session_log,
)


def _write_jsonl(lines: list[str], suffix: str = ".jsonl") -> Path:
    """Helper to write JSONL lines to a temp file and return the path."""
    f = tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False, encoding="utf-8")
    for line in lines:
        f.write(line + "\n")
    f.close()
    return Path(f.name)


def _assistant_msg(text: str) -> dict:
    """Build a minimal assistant message JSON object."""
    return {
        "type": "message",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    }


# ─── _extract_verdict_block unit tests ──────────────────────────────────

def test_extract_verdict_approved():
    """Verdict block with approved status should parse correctly."""
    text = """Here is my analysis.

```verdict
{"status": "approved", "details": "All checks passed.", "issues": []}
```
"""
    result = _extract_verdict_block(text)
    assert result is not None
    assert result["status"] == "approved"
    assert result["details"] == "All checks passed."
    assert result["issues"] == []


def test_extract_verdict_rejected_with_issues():
    """Verdict block with rejected status and issues should parse correctly."""
    text = """```verdict
{"status": "rejected", "details": "Two problems found.", "issues": ["Missing type hints", "No docstring"]}
```"""
    result = _extract_verdict_block(text)
    assert result is not None
    assert result["status"] == "rejected"
    assert len(result["issues"]) == 2
    assert "Missing type hints" in result["issues"]


def test_extract_verdict_last_block_wins():
    """When multiple verdict blocks exist, the LAST one should win."""
    text = """First pass:

```verdict
{"status": "rejected", "details": "Needs work.", "issues": ["Incomplete"]}
```

After revision:

```verdict
{"status": "approved", "details": "All fixed now.", "issues": []}
```
"""
    result = _extract_verdict_block(text)
    assert result is not None
    assert result["status"] == "approved"


def test_extract_verdict_wrong_language_tag_ignored():
    """Code fences with language tags other than 'verdict' should be ignored."""
    text = """```json
{"status": "approved", "details": "", "issues": []}
```

Some reasoning...
"""
    result = _extract_verdict_block(text)
    assert result is None


def test_extract_verdict_no_fence_returns_none():
    """Text without any verdict fence should return None."""
    text = "The implementation looks good. All tests pass."
    result = _extract_verdict_block(text)
    assert result is None


def test_extract_verdict_invalid_json_in_fence():
    """Verdict fence with invalid JSON should return None."""
    text = """```verdict
this is not json at all
```"""
    result = _extract_verdict_block(text)
    assert result is None


def test_extract_verdict_empty_fence_returns_none():
    """Empty verdict fence should return None."""
    text = """```verdict

```"""
    result = _extract_verdict_block(text)
    assert result is None


def test_extract_verdict_invalid_status_ignored():
    """Verdict with an unknown status value should be ignored."""
    text = """```verdict
{"status": "no_gaps", "details": "", "issues": []}
```"""
    result = _extract_verdict_block(text)
    assert result is None


def test_extract_verdict_missing_status_ignored():
    """Verdict without a status key should be ignored."""
    text = """```verdict
{"details": "something", "issues": []}
```"""
    result = _extract_verdict_block(text)
    assert result is None


def test_extract_verdict_defaults_details_and_issues():
    """Missing details/issues keys should default to empty values."""
    text = """```verdict
{"status": "approved"}
```"""
    result = _extract_verdict_block(text)
    assert result is not None
    assert result["status"] == "approved"
    assert result["details"] == ""
    assert result["issues"] == []


# ─── extract_phase_verdict — approved verdict tests ─────────────────────

def test_verdict_approved_from_log():
    """Approved verdict block in session log should be detected."""
    text = "Analysis complete.\n\n```verdict\n{\"status\": \"approved\", \"details\": \"All good.\", \"issues\": []}\n```"
    path = _write_jsonl([json.dumps(_assistant_msg(text))])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved"
        assert result["details"] == "All good."
        assert len(result["issues"]) == 0
    finally:
        os.unlink(path)


def test_verdict_rejected_from_log():
    """Rejected verdict block in session log should be detected with issues."""
    text = "```verdict\n{\"status\": \"rejected\", \"details\": \"Issues found.\", \"issues\": [\"Missing type hints\", \"No docstring\"]}\n```"
    path = _write_jsonl([json.dumps(_assistant_msg(text))])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "rejected"
        assert len(result["issues"]) == 2
        assert "Missing type hints" in result["issues"]
    finally:
        os.unlink(path)


def test_last_verdict_wins_in_log():
    """When multiple assistant messages contain verdict blocks, the last one wins."""
    # First message has rejected verdict
    msg1 = _assistant_msg("```verdict\n{\"status\": \"rejected\", \"details\": \"First pass.\", \"issues\": [\"Incomplete\"]}\n```")
    # Second message has approved verdict (final)
    msg2 = _assistant_msg("Revised.\n\n```verdict\n{\"status\": \"approved\", \"details\": \"All fixed.\", \"issues\": []}\n```")

    path = _write_jsonl([json.dumps(msg1), json.dumps(msg2)])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved"
    finally:
        os.unlink(path)


# ─── No verdict tests ──────────────────────────────────────────────────

def test_no_verdict_found():
    """When no verdict block is found, status should be None."""
    path = _write_jsonl([json.dumps(_assistant_msg("Let me start by reading the schema file."))])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] is None
        assert result["issues"] == []
        assert result["raw_text"] == ""
    finally:
        os.unlink(path)


def test_no_verdict_json_fence_ignored():
    """A ```json``` fence should NOT be treated as a verdict block."""
    path = _write_jsonl([json.dumps(_assistant_msg('```json\n{"status":"approved"}\n```'))])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] is None
    finally:
        os.unlink(path)


def test_no_verdict_empty_file():
    """Empty file should return no verdict."""
    path = _write_jsonl([])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] is None
    finally:
        os.unlink(path)


# ─── Malformed JSONL handling tests ─────────────────────────────────────

def test_malformed_json_lines_skipped():
    """Malformed JSON lines should be silently skipped, never crash."""
    content = [
        "not valid json at all",
        '{"type": "message", "broken',  # truncated
        "",  # empty line
        json.dumps(_assistant_msg("```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```")),
    ]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved"
    finally:
        os.unlink(path)


def test_malformed_file_does_not_crash():
    """Completely garbage file should not crash."""
    path = _write_jsonl(["garbage", "more garbage", "12345"])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] is None
    finally:
        os.unlink(path)


# ─── Missing file tests ────────────────────────────────────────────────

def test_missing_file():
    """Non-existent file should return no verdict."""
    result = extract_phase_verdict("/tmp/does_not_exist_12345.jsonl")
    assert result["status"] is None


# ─── Raw text tests ────────────────────────────────────────────────────

def test_raw_text_is_truncated():
    """Raw text should be truncated to 500 chars max."""
    big_text = "Let me think about this...\n\n" + ("x" * 1000) + "\n\n```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```"
    path = _write_jsonl([json.dumps(_assistant_msg(big_text))])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved"
        assert len(result["raw_text"]) <= 500
    finally:
        os.unlink(path)


# ─── resolve_session_log tests ─────────────────────────────────────────

def test_resolve_single_jsonl_file():
    """resolve_session_log should return the file when it's already a .jsonl."""
    path = _write_jsonl(['{"type":"session"}'])
    try:
        result = resolve_session_log(path)
        assert result == path
    finally:
        os.unlink(path)


def test_resolve_dir_with_one_jsonl():
    """resolve_session_log should return the single .jsonl in a directory."""
    d = tempfile.mkdtemp()
    try:
        f1 = Path(d) / "session.jsonl"
        with open(f1, "w") as fh:
            fh.write('{"type":"session"}\n')

        result = resolve_session_log(d)
        assert result == f1
    finally:
        import shutil
        shutil.rmtree(d)


def test_resolve_dir_with_multiple_jsonl():
    """resolve_session_log should return the most recent .jsonl."""
    d = tempfile.mkdtemp()
    try:
        f1 = Path(d) / "001.jsonl"
        with open(f1, "w") as fh:
            fh.write('{"type":"session"}\n')

        f2 = Path(d) / "002.jsonl"
        with open(f2, "w") as fh:
            fh.write('{"type":"session"}\n')

        result = resolve_session_log(d)
        assert result == f2  # Most recent by sort order
    finally:
        import shutil
        shutil.rmtree(d)


def test_resolve_nonexistent():
    """resolve_session_log should return None for non-existent paths."""
    assert resolve_session_log("/tmp/nonexistent_dir_xyz") is None


# ─── extract_latest_verdict_from_log_dir tests ─────────────────────────

def test_extract_verdicts_empty_dir():
    """Empty directory should return empty dict."""
    d = tempfile.mkdtemp()
    try:
        result = extract_latest_verdict_from_log_dir(d)
        assert result == {}
    finally:
        import shutil
        shutil.rmtree(d)


def test_extract_single_verdict():
    """Single JSONL file should return one verdict."""
    d = tempfile.mkdtemp()
    try:
        f1 = Path(d) / "session.jsonl"
        with open(f1, "w") as fh:
            json.dump(_assistant_msg("```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```"), fh)

        result = extract_latest_verdict_from_log_dir(d)
        assert len(result) == 1
        assert "session.jsonl" in result
        assert result["session.jsonl"]["status"] == "approved"
    finally:
        import shutil
        shutil.rmtree(d)


# ─── Run all tests ─────────────────────────────────────────────────────


# ─── PHASE_OUTPUT fallback tests (retrospective phase) ──────────────────
#
# The retrospective phase emits a `### PHASE_OUTPUT: success|failure|...`
# block (per ``prompts/retrospective.md``) instead of a `````verdict``
# code fence. These tests pin the extraction logic so it doesn't regress.


def test_phase_output_success_is_approved():
    """`### PHASE_OUTPUT: success` should map to verdict status 'approved'."""
    text = """Some agent reasoning text.

---
### PHASE_OUTPUT: success
{
  "outcome": "success",
  "what_worked": ["x"]
}
### END_PHASE_OUTPUT
---
"""
    result = _extract_phase_output_block(text)
    assert result is not None
    assert result["status"] == "approved"
    assert "PHASE_OUTPUT" in result["details"]
    assert result["issues"] == []


def test_phase_output_failure_is_rejected():
    """`### PHASE_OUTPUT: failure` should map to verdict status 'rejected'."""
    text = """---
### PHASE_OUTPUT: failure
{ "outcome": "failure" }
### END_PHASE_OUTPUT
---"""
    result = _extract_phase_output_block(text)
    assert result is not None
    assert result["status"] == "rejected"


def test_phase_output_rejected_is_rejected():
    """`### PHASE_OUTPUT: rejected` is an alias used by the orchestrator's
    GitHub-comment parser — should also map to 'rejected'."""
    text = """---
### PHASE_OUTPUT: rejected
{ "outcome": "rejected" }
### END_PHASE_OUTPUT
---"""
    result = _extract_phase_output_block(text)
    assert result is not None
    assert result["status"] == "rejected"


def test_phase_output_system_error_is_rejected():
    """`### PHASE_OUTPUT: system_error` (a runtime error in the
    retrospective itself) maps to 'rejected' so the flow can route
    to diagnostic if it ever needs to."""
    text = """---
### PHASE_OUTPUT: system_error
{ "outcome": "system_error" }
### END_PHASE_OUTPUT
---"""
    result = _extract_phase_output_block(text)
    assert result is not None
    assert result["status"] == "rejected"


def test_phase_output_block_with_json_body():
    """The block should be detected regardless of the JSON body shape.
    We don't parse the body here — that's ``learnings.parse_retrospective_output``'s
    job — we only need the outer marker."""
    text = """Final summary.

---
### PHASE_OUTPUT: success
{
  "outcome": "success",
  "what_worked": ["a", "b", "c"],
  "what_failed": [],
  "surprising": ["x"],
  "repo_specific_learnings": ["y"],
  "proposed_amendments": [{"title": "z", "root_cause": "c", "proposed_fix": "p", "effort": "1h"}]
}
### END_PHASE_OUTPUT
---"""
    result = _extract_phase_output_block(text)
    assert result is not None
    assert result["status"] == "approved"


def test_phase_output_block_without_horizontal_rule():
    """The horizontal-rule delimiter is a convention, not a requirement.
    The regex should match the bare `### PHASE_OUTPUT:` line."""
    text = """### PHASE_OUTPUT: success
{ "outcome": "success" }
### END_PHASE_OUTPUT"""
    result = _extract_phase_output_block(text)
    assert result is not None
    assert result["status"] == "approved"


def test_phase_output_missing_returns_none():
    """Text with no PHASE_OUTPUT block should return None (not crash)."""
    text = "Just some prose without any markers."
    assert _extract_phase_output_block(text) is None
    assert _extract_phase_output_block("") is None
    assert _extract_phase_output_block(None) is None


def test_phase_output_outcome_case_insensitive():
    """Outcome keyword should be matched case-insensitively for robustness."""
    for keyword in ("SUCCESS", "Success", "sUcCeSs"):
        text = f"### PHASE_OUTPUT: {keyword}\n{{}}\n### END_PHASE_OUTPUT"
        result = _extract_phase_output_block(text)
        assert result is not None, f"failed for {keyword!r}"
        assert result["status"] == "approved", f"failed for {keyword!r}"


def test_extractor_falls_back_to_phase_output():
    """The full ``_extract_verdict_block`` should fall through to the
    PHASE_OUTPUT helper when no `````verdict`` fence is present."""
    text = """Some agent reasoning.

---
### PHASE_OUTPUT: success
{ "outcome": "success" }
### END_PHASE_OUTPUT
---"""
    result = _extract_verdict_block(text)
    assert result is not None
    assert result["status"] == "approved"
    assert "PHASE_OUTPUT" in result["details"]


def test_extractor_fence_wins_over_phase_output():
    """When both a `````verdict`` fence and a PHASE_OUTPUT block are
    present, the fence (canonical contract) wins — preserving
    last-fence-wins semantics."""
    text = """First thought.

```verdict
{"status": "rejected", "details": "explicit fence", "issues": []}
```

Final thought.

---
### PHASE_OUTPUT: success
{ "outcome": "success" }
### END_PHASE_OUTPUT
---"""
    result = _extract_verdict_block(text)
    assert result is not None
    assert result["status"] == "rejected", "fence must win over PHASE_OUTPUT"

if __name__ == "__main__":
    print("Running verdict_extractor unit tests...\n")

    tests = [
        test_extract_verdict_approved,
        test_extract_verdict_rejected_with_issues,
        test_extract_verdict_last_block_wins,
        test_extract_verdict_wrong_language_tag_ignored,
        test_extract_verdict_no_fence_returns_none,
        test_extract_verdict_invalid_json_in_fence,
        test_extract_verdict_empty_fence_returns_none,
        test_extract_verdict_invalid_status_ignored,
        test_extract_verdict_missing_status_ignored,
        test_extract_verdict_defaults_details_and_issues,
        test_verdict_approved_from_log,
        test_verdict_rejected_from_log,
        test_last_verdict_wins_in_log,
        test_no_verdict_found,
        test_no_verdict_json_fence_ignored,
        test_no_verdict_empty_file,
        test_malformed_json_lines_skipped,
        test_malformed_file_does_not_crash,
        test_missing_file,
        test_raw_text_is_truncated,
        test_resolve_single_jsonl_file,
        test_resolve_dir_with_one_jsonl,
        test_resolve_dir_with_multiple_jsonl,
        test_resolve_nonexistent,
        test_extract_verdicts_empty_dir,
        test_extract_single_verdict,
        # PHASE_OUTPUT fallback (retrospective phase) — added 2026-06-05
        test_phase_output_success_is_approved,
        test_phase_output_failure_is_rejected,
        test_phase_output_rejected_is_rejected,
        test_phase_output_system_error_is_rejected,
        test_phase_output_block_with_json_body,
        test_phase_output_block_without_horizontal_rule,
        test_phase_output_missing_returns_none,
        test_phase_output_outcome_case_insensitive,
        # Integration with the full extractor
        test_extractor_falls_back_to_phase_output,
        test_extractor_fence_wins_over_phase_output,
    ]

    passed = 0
    failed = 0

    for test_fn in tests:
        try:
            test_fn()
            print(f"  ✓ {test_fn.__name__}")
            passed += 1
        except Exception as e:
            import traceback
            print(f"  ✗ {test_fn.__name__}: {e}")
            traceback.print_exc()
            failed += 1

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed > 0:
        sys.exit(1)
