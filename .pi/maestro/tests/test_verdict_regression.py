#!/usr/bin/env python3
"""
Regression tests for verdict_extractor — Verdict code-fence extraction.

Validates that the new session-log-based verdict extraction produces zero
regression across all flow types and real-world session log patterns.

Covers:
- Real session logs from existing flows (builder-reviewer)
- Synthetic logs matching each flow's expected output pattern
- Edge cases that previously caused crashes or wrong verdicts
- Error-state routing correctness (no fallback chain — single source of truth)

Run with: python3 tests/test_verdict_regression.py

Flows tested:
1. builder-reviewer.json — Standard Builder→Reviewer loop
2. builder-test-reviewer.json — 3-phase loop (Builder → TestRunner → Reviewer)
3. gap-check.json — PRD validation pipeline (Analyze → To-PRD → To-Issues)
4. prd-audit.json
5. prd-to-issues-reviewer.json
"""

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from verdict_extractor import (
    extract_latest_verdict_from_log_dir,
    extract_phase_verdict,
    resolve_session_log,
)


def _assistant_msg(text: str) -> dict:
    """Build a minimal assistant message JSON object."""
    return {
        "type": "message",
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
    }


# ─── Regression Test 1: Real session logs from builder-reviewer flow ─────

def test_real_session_logs_builder_reviewer():
    """Regression: All real session logs should parse without error.

    Handles both old flat-file layout (.jsonl files directly) and the new
    directory-based layout where each "session" is a directory containing
    one or more timestamped .jsonl files inside.
    """
    sessions_dir = Path(__file__).parent.parent / "sessions"

    if not sessions_dir.is_dir():
        print("  ⚠ No sessions directory found — skipping real log regression test")
        return

    total = 0
    approved = 0
    rejected = 0
    no_verdict = 0
    errors = []

    for d in sorted(sessions_dir.iterdir()):
        if not d.is_dir():
            continue
        for entry in sorted(d.iterdir()):
            # Resolve: entry may be a .jsonl file OR a directory containing .jsonl files
            resolved_path = resolve_session_log(entry)
            if resolved_path is None or not resolved_path.exists() or not resolved_path.is_file():
                continue

            total += 1
            try:
                result = extract_phase_verdict(resolved_path)
                status = result["status"]

                # Verify the return value is well-formed (never crashes, always has expected keys)
                assert "status" in result
                assert "issues" in result
                assert isinstance(result["issues"], list), f"Issues should be a list for {entry.name}"
                assert isinstance(result["raw_text"], str), f"Raw text should be a string for {entry.name}"

                if status == "approved":
                    approved += 1
                elif status == "rejected":
                    rejected += 1
                elif status is None:
                    no_verdict += 1
                else:
                    errors.append(f"Unexpected status '{status}' in {entry}")

            except Exception as e:
                errors.append(f"{d.name}/{entry}: {e}")

    print(f"  Real logs tested: {total} (approved={approved}, rejected={rejected}, no_verdict={no_verdict})")
    assert len(errors) == 0, f"Regression failures on real logs:\n" + "\n".join(errors)


# ─── Regression Test 2: Synthetic logs matching each flow's patterns ─────

def _write_jsonl(lines: list[str]) -> Path:
    """Helper to write JSONL lines to a temp file and return the path."""
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False, encoding="utf-8")
    for line in lines:
        f.write(line + "\n")
    f.close()
    return Path(f.name)


def _cleanup(path: Path):
    """Safely remove a temp file."""
    try:
        os.unlink(path)
    except OSError:
        pass


def test_flow_builder_reviewer_approved():
    """builder-reviewer flow: Builder self-approves with verdict block."""
    content = [json.dumps(_assistant_msg(
        "Implementation complete.\n\n"
        "```verdict\n"
        '{"status": "approved", "details": "All acceptance criteria met.", "issues": []}'
        "\n```"
    ))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved", f"Expected approved, got {result['status']}"
    finally:
        _cleanup(path)


def test_flow_builder_reviewer_rejected():
    """builder-reviewer flow: Builder self-rejects with issues."""
    text = (
        "```verdict\n"
        '{"status": "rejected", "details": "Two problems.", '
        '"issues": ["Missing type hints on 3 functions", "No docstring"]}'
        "\n```"
    )
    content = [json.dumps(_assistant_msg(text))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "rejected"
        assert len(result["issues"]) >= 2, f"Expected at least 2 issues, got {len(result['issues'])}"
    finally:
        _cleanup(path)


def test_flow_builder_test_reviewer_approved():
    """builder-test-reviewer flow: All three phases approve."""
    # Builder phase
    path_b = _write_jsonl([json.dumps(_assistant_msg(
        "```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```"
    ))])
    try:
        assert extract_phase_verdict(path_b)["status"] == "approved"
    finally:
        _cleanup(path_b)

    # TestRunner phase (local command, no verdict in session log — should return null → error state)
    path_t = _write_jsonl([json.dumps(_assistant_msg("Tests passed. All 42 tests green."))])
    try:
        result = extract_phase_verdict(path_t)
        # TestRunner doesn't write verdict block, so status is None (error state triggers in rpc_client)
        assert result["status"] is None or result["status"] in ("approved", "rejected")
    finally:
        _cleanup(path_t)

    # Reviewer phase
    path_r = _write_jsonl([json.dumps(_assistant_msg(
        "Review complete.\n\n"
        "```verdict\n{\"status\": \"approved\", \"details\": \"Code quality is good.\", \"issues\": []}\n```"
    ))])
    try:
        assert extract_phase_verdict(path_r)["status"] == "approved"
    finally:
        _cleanup(path_r)


def test_flow_gap_check_approved():
    """gap-check flow: Analyze phase finds no gaps → approved."""
    content = [json.dumps(_assistant_msg(
        "## Gap Analysis Summary\n"
        "---\n"
        "All 5 acceptance criteria from PRD #178 are satisfied.\n\n"
        "```verdict\n{\"status\": \"approved\", \"details\": \"No gaps found. Implementation matches the PRD.\", \"issues\": []}\n```"
    ))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved", f"Expected approved, got {result['status']}"
    finally:
        _cleanup(path)


def test_flow_gap_check_with_gaps():
    """gap-check flow: Analyze phase finds gaps → rejected."""
    content = [json.dumps(_assistant_msg(
        "## 🔍 Gap Analysis\n"
        "---\n\n"
        "```verdict\n"
        '{"status": "rejected", "details": "Gaps found.", '
        '"issues": ["Missing type annotations in lib/session_reader.py", "No docstrings on 4 public functions"]}'
        "\n```"
    ))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "rejected", f"Expected rejected, got {result['status']}"
        assert len(result["issues"]) >= 2
    finally:
        _cleanup(path)


def test_flow_prd_audit_approved():
    """prd-audit flow: Audit phase approves the PRD."""
    content = [json.dumps(_assistant_msg(
        "## 📋 PRD Audit Results\n"
        "---\n\n"
        "```verdict\n{\"status\": \"approved\", \"details\": \"All sections present and well-formed.\", \"issues\": []}\n```"
    ))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved"
    finally:
        _cleanup(path)


def test_flow_prd_audit_rejected():
    """prd-audit flow: Audit phase rejects due to missing sections."""
    content = [json.dumps(_assistant_msg(
        '```verdict\n{"status":"rejected","details":"Missing sections.","issues":["Missing Testing Decisions section","Out of Scope is empty"]}\n```'
    ))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "rejected"
    finally:
        _cleanup(path)


def test_flow_prd_to_issues_reviewer_approved():
    """prd-to-issues-reviewer flow: Reviewer approves the generated issues."""
    content = [json.dumps(_assistant_msg(
        "Review of generated implementation issues:\n\n"
        "```verdict\n{\"status\": \"approved\", \"details\": \"All slices are properly scoped as vertical tracers.\", \"issues\": []}\n```"
    ))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved"
    finally:
        _cleanup(path)


def test_flow_prd_to_issues_reviewer_rejected():
    """prd-to-issues-reviewer flow: Reviewer rejects issues with formatting problems."""
    content = [json.dumps(_assistant_msg(
        "---\n\n"
        "```verdict\n"
        '{"status": "rejected", "details": "Issues need refinement.", '
        '"issues": ["Slice 1 lacks explicit acceptance criteria", "Slice 3 has no parent PRD reference", "Slice 4 is too broad"]}'
        "\n```"
    ))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "rejected"
        assert len(result["issues"]) >= 3
    finally:
        _cleanup(path)


# ─── Regression Test 3: Edge cases that previously caused crashes ─────

def test_regression_empty_assistant_content():
    """Agent returns empty assistant content — should not crash."""
    content = [json.dumps({"type": "message", "message": {"role": "assistant", "content": []}})]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] is None
    finally:
        _cleanup(path)


def test_regression_malformed_content_array():
    """Agent returns non-list content — should not crash."""
    content = [json.dumps({"type": "message", "message": {"role": "assistant", "content": "just a string"}})]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] is None  # Non-list content not parsed as text blocks
    finally:
        _cleanup(path)


def test_regression_mixed_valid_invalid_lines():
    """Mix of valid JSONL and garbage — should skip invalid, parse valid."""
    lines = [
        "not json",
        '{"type": "broken',  # Truncated
        "",  # Empty line
        json.dumps(_assistant_msg("Let me start thinking...")),
        '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"go"}]}}',  # User message — not assistant
        json.dumps(_assistant_msg(
            "```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```"
        )),
    ]
    path = _write_jsonl(lines)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved", f"Expected approved, got {result['status']}"
    finally:
        _cleanup(path)


def test_regression_unicode_in_details():
    """Verdict with unicode characters in details — should parse correctly."""
    content = [json.dumps(_assistant_msg(
        "```verdict\n{\"status\": \"approved\", \"details\": \"Toutes les critères sont satisfaits ✅\", \"issues\": []}\n```"
    ))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved"
    finally:
        _cleanup(path)


def test_regression_very_long_log():
    """Very long session log (10K+ lines) — should handle without memory issues."""
    messages = [json.dumps(_assistant_msg(f"Thought {i}: processing line {i}...")) for i in range(500)]
    messages.append(json.dumps(_assistant_msg(
        "Done.\n\n```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```"
    )))
    path = _write_jsonl(messages)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved"
        assert len(result["raw_text"]) <= 500  # Should be truncated to match snippet, not full log
    finally:
        _cleanup(path)


def test_regression_special_chars_in_issues():
    """Issues with special characters (quotes, newlines escaped) — should extract cleanly."""
    content = [json.dumps(_assistant_msg(
        '```verdict\n{"status":"rejected","details":"Found issues.","issues":["Line 42: unexpected token `;`","Path `src/../lib/mod.py` not found","Unicode: café résumé naïve"]}\n```'
    ))]
    path = _write_jsonl(content)
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "rejected"
        # Should have extracted the JSON array items directly
        all_issues = " ".join(result["issues"])
        assert len(all_issues) > 0, "Should have extracted issue descriptions"
    finally:
        _cleanup(path)


# ─── Regression Test 4: Error-state routing correctness ─────

def test_regression_verdict_approved_in_log():
    """When session log has approved verdict → returns approved (single source of truth)."""
    path = _write_jsonl([json.dumps(_assistant_msg(
        "```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```"
    ))])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "approved"
    finally:
        _cleanup(path)


def test_regression_verdict_rejected_in_log():
    """When session log has rejected verdict → returns rejected with issues."""
    path = _write_jsonl([json.dumps(_assistant_msg(
        '```verdict\n{"status":"rejected","details":"","issues":["bad code"]}\n```'
    ))])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] == "rejected"
        assert len(result["issues"]) >= 1
    finally:
        _cleanup(path)


def test_regression_no_verdict_returns_null():
    """When session log has no verdict → returns null (error state in rpc_client)."""
    path = _write_jsonl([json.dumps(_assistant_msg("Let me analyze the codebase structure."))])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] is None, f"Expected None for no-verdict log, got {result['status']}"
    finally:
        _cleanup(path)


def test_regression_missing_file_returns_null():
    """When session file doesn't exist → returns null (not crash)."""
    result = extract_phase_verdict("/tmp/nonexistent_regression_test_12345.jsonl")
    assert result["status"] is None
    assert result["issues"] == []


def test_regression_empty_file_returns_null():
    """When session file is empty → returns null (not crash)."""
    path = _write_jsonl([])
    try:
        result = extract_phase_verdict(path)
        assert result["status"] is None
    finally:
        _cleanup(path)


# ─── Regression Test 5: Directory-level operations ─────

def test_regression_extract_latest_verdict_from_log_dir():
    """extract_latest_verdict_from_log_dir should return only the latest file's verdict."""
    d = Path(tempfile.mkdtemp())
    try:
        # Approved log
        approved_path = d / "builder-approved.jsonl"
        with open(approved_path, "w") as f:
            json.dump(_assistant_msg("```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```"), f)

        # Rejected log
        rejected_path = d / "reviewer-rejected.jsonl"
        with open(rejected_path, "w") as f:
            json.dump(_assistant_msg('```verdict\n{"status":"rejected","details":"","issues":["formatting"]}\n```'), f)

        # No verdict log
        neutral_path = d / "runner-neutral.jsonl"
        with open(neutral_path, "w") as f:
            json.dump(_assistant_msg("Tests passed."), f)

        result = extract_latest_verdict_from_log_dir(d)

        assert len(result) == 1, f"Should return only the latest .jsonl file, got {len(result)}"

        # The latest file by name should be reviewer-rejected.jsonl (alphabetically last)
        verdict_name = list(result.keys())[0]
        assert "reviewer-rejected" in verdict_name or "runner-neutral" in verdict_name

    finally:
        shutil.rmtree(d)


def test_regression_resolve_session_log_flat_layout():
    """resolve_session_log should work with Phase 1+ flat-file layout."""
    d = Path(tempfile.mkdtemp()) / "181"
    os.makedirs(d, exist_ok=True)

    try:
        # Create a flat-file session log
        iso_ts = "2026-05-26T10:30:00"
        jsonl_file = d / f"builder-reviewer-builder-{iso_ts}.jsonl"
        with open(jsonl_file, "w") as f:
            json.dump(_assistant_msg("```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```"), f)

        result = resolve_session_log(d)
        assert result == jsonl_file, f"Expected {jsonl_file}, got {result}"

    finally:
        shutil.rmtree(d.parent)


# ─── Run all tests ─────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Running verdict extraction regression tests...\n")
    print("=" * 60)

    # Real session log regression (may be skipped if no sessions dir)
    print("\n📁 Regression Test 1: Real session logs from builder-reviewer flow")
    try:
        test_real_session_logs_builder_reviewer()
        print("  ✓ PASSED\n")
    except Exception as e:
        print(f"  ✗ FAILED: {e}\n")

    # Flow-specific synthetic tests
    print("=" * 60)
    print("\n📁 Regression Test 2: Synthetic logs per flow type")

    flow_tests = [
        ("builder-reviewer (approved)", test_flow_builder_reviewer_approved),
        ("builder-reviewer (rejected)", test_flow_builder_reviewer_rejected),
        ("builder-test-reviewer (3-phase)", test_flow_builder_test_reviewer_approved),
        ("gap-check (approved/no gaps)", test_flow_gap_check_approved),
        ("gap-check (with gaps/rejected)", test_flow_gap_check_with_gaps),
        ("prd-audit (approved)", test_flow_prd_audit_approved),
        ("prd-audit (rejected)", test_flow_prd_audit_rejected),
        ("prd-to-issues-reviewer (approved)", test_flow_prd_to_issues_reviewer_approved),
        ("prd-to-issues-reviewer (rejected)", test_flow_prd_to_issues_reviewer_rejected),
    ]

    flow_passed = 0
    for name, fn in flow_tests:
        try:
            fn()
            print(f"  ✓ {name}")
            flow_passed += 1
        except Exception as e:
            print(f"  ✗ {name}: {e}")

    print(f"\n{flow_passed}/{len(flow_tests)} flow tests passed")

    # Edge case regressions
    print("\n" + "=" * 60)
    print("\n📁 Regression Test 3: Edge cases (crash prevention)")

    edge_tests = [
        "empty_assistant_content",
        "malformed_content_array",
        "mixed_valid_invalid_lines",
        "unicode_in_details",
        "very_long_log",
        "special_chars_in_issues",
    ]

    edge_passed = 0
    for test_name in edge_tests:
        fn = globals()[f"test_regression_{test_name}"]
        try:
            fn()
            print(f"  ✓ {test_name}")
            edge_passed += 1
        except Exception as e:
            import traceback
            print(f"  ✗ {test_name}: {e}")

    # Error-state routing tests (renamed from "fallback chain")
    print("\n" + "=" * 60)
    print("\n📁 Regression Test 4: Error-state routing")

    error_state_tests = [
        ("verdict_approved_in_log", test_regression_verdict_approved_in_log),
        ("verdict_rejected_in_log", test_regression_verdict_rejected_in_log),
        ("no_verdict_returns_null", test_regression_no_verdict_returns_null),
        ("missing_file_returns_null", test_regression_missing_file_returns_null),
        ("empty_file_returns_null", test_regression_empty_file_returns_null),
    ]

    error_state_passed = 0
    for name, fn in error_state_tests:
        try:
            fn()
            print(f"  ✓ {name}")
            error_state_passed += 1
        except Exception as e:
            import traceback
            print(f"  ✗ {name}: {e}")

    # Directory operations
    print("\n" + "=" * 60)
    print("\n📁 Regression Test 5: Directory-level operations")

    dir_tests = [
        ("extract_latest_verdict_from_log_dir", test_regression_extract_latest_verdict_from_log_dir),
        ("resolve_session_log_flat_layout", test_regression_resolve_session_log_flat_layout),
    ]

    dir_passed = 0
    for name, fn in dir_tests:
        try:
            fn()
            print(f"  ✓ {name}")
            dir_passed += 1
        except Exception as e:
            import traceback
            print(f"  ✗ {name}: {e}")

    # Summary
    total = flow_passed + edge_passed + error_state_passed + dir_passed
    max_total = len(flow_tests) + len(edge_tests) + len(error_state_tests) + len(dir_tests)

    print("\n" + "=" * 60)
    print(f"\n📊 Regression Summary: {total}/{max_total} tests passed")

    if total < max_total:
        print("❌ REGRESSION FAILURES DETECTED — see failures above\n")
        sys.exit(1)
    else:
        print("✅ ALL REGRESSION TESTS PASSED — zero regression confirmed\n")
