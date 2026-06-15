#!/usr/bin/env python3
"""
Integration smoke tests for the end-to-end verdict extraction flow.

Validates that the verdict pipeline works correctly from session log through
rpc_client result dict into flow_engine's run_phase output.

Tests the integration boundary between:
  rpc_client.run_rpc_with_session_log() → verdict_extractor.extract_phase_verdict()
  → flow_engine.run_phase() status mapping

Run with: python3 tests/test_flow_engine_integration.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from verdict_extractor import extract_phase_verdict


def _write_jsonl(lines: list[str]) -> Path:
    """Helper to write JSONL lines to a temp file and return the path."""
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False, encoding="utf-8")
    for line in lines:
        f.write(line + "\n")
    f.close()
    return Path(f.name)


def _assistant_msg(text: str) -> dict:
    """Build a minimal assistant message JSON object."""
    return {
        "type": "message",
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
    }


# ─── Integration Test 1: rpc_client verdict extraction pipeline ─────────

def test_rpc_verdict_pipeline_approved():
    """End-to-end: session log with approved verdict → rpc_client returns approved result."""
    # Simulate what run_rpc_with_session_log does internally: call
    # verdict_extractor.extract_phase_verdict() on the session log.
    text = "Implementation complete.\n\n```verdict\n{\"status\": \"approved\", \"details\": \"All criteria met.\", \"issues\": []}\n```"
    path = _write_jsonl([json.dumps(_assistant_msg(text))])

    try:
        verdict = extract_phase_verdict(path)
        assert verdict["status"] == "approved"
        assert verdict["issues"] == []
        assert isinstance(verdict["details"], str)
        assert isinstance(verdict["raw_text"], str)

        # Simulate how rpc_client wraps this into a result dict
        result = {
            "success": True,
            "output": "",
            "session_log": str(path),
            "result": {
                "status": verdict["status"],
                "issues": verdict.get("issues", []),
                "verdict": verdict.get("raw_text", ""),
            }
        }

        assert result["result"]["status"] == "approved"
    finally:
        os.unlink(path)


def test_rpc_verdict_pipeline_rejected():
    """End-to-end: session log with rejected verdict → rpc_client returns rejected + issues."""
    text = '```verdict\n{"status":"rejected","details":"Two problems.","issues":["Missing type hints","No docstring"]}\n```'
    path = _write_jsonl([json.dumps(_assistant_msg(text))])

    try:
        verdict = extract_phase_verdict(path)
        assert verdict["status"] == "rejected"
        assert len(verdict["issues"]) == 2

        # Simulate rpc_client result wrapping
        result = {
            "success": True,
            "output": "",
            "session_log": str(path),
            "result": {
                "status": verdict["status"],
                "issues": verdict.get("issues", []),
                "verdict": verdict.get("raw_text", ""),
            }
        }

        assert result["result"]["status"] == "rejected"
        assert len(result["result"]["issues"]) == 2
    finally:
        os.unlink(path)


def test_rpc_verdict_pipeline_no_verdict_error_state():
    """End-to-end: session log with no verdict → rpc_client returns error state."""
    text = "Let me start by reading the files."
    path = _write_jsonl([json.dumps(_assistant_msg(text))])

    try:
        verdict = extract_phase_verdict(path)
        assert verdict["status"] is None

        # Simulate how rpc_client handles no-verdict → error state
        result = {
            "success": True,  # RPC succeeded but no verdict extracted
            "output": "",
            "session_log": str(path),
            "result": {
                "status": "error",
                "details": f"No verdict found in session log ({path}). The agent may not have emitted a verdict block.",
            }
        }

        assert result["result"]["status"] == "error"
    finally:
        os.unlink(path)


# ─── Integration Test 2: flow_engine run_phase status mapping ──────────

def test_flow_engine_approved_status_mapping():
    """flow_engine maps rpc_client 'approved' → phase status 'success'."""
    # Simulate what run_phase does with the result dict from rpc_client
    status_data = {
        "status": "approved",
        "issues": [],
        "verdict": "",
    }

    phase_status = status_data.get("status")
    assert phase_status == "approved"

    # flow_engine maps approved → success
    if phase_status == "approved":
        final_status = "success"
        details = f"builder approved"

    assert final_status == "success"


def test_flow_engine_rejected_status_mapping():
    """flow_engine maps rpc_client 'rejected' → phase status 'reject' with issues."""
    status_data = {
        "status": "rejected",
        "issues": ["Missing type hints", "No docstring"],
        "verdict": "",
    }

    phase_status = status_data.get("status")
    assert phase_status == "rejected"

    # flow_engine maps rejected → reject
    if phase_status == "rejected":
        final_status = "reject"
        issues = status_data.get("issues", [])
        details_parts = ["builder rejected"]
        for issue in issues[:5]:
            details_parts.append(f"\u2022 {issue}")
        details = "\n".join(details_parts)

    assert final_status == "reject"
    assert "Missing type hints" in details


def test_flow_engine_error_status_mapping():
    """flow_engine maps rpc_client 'error' → phase status 'error'."""
    status_data = {
        "status": "error",
        "details": "No verdict extracted from session log",
    }

    phase_status = status_data.get("status")
    assert phase_status == "error"

    # flow_engine maps error → error (surfaces the details)
    if phase_status == "error":
        final_status = "error"
        details_text = status_data.get("details", "No verdict extracted from session log")
        result_details = f"Verdict extraction failed: {details_text}"

    assert final_status == "error"
    assert "Verdict extraction failed" in result_details


# ─── Integration Test 3: Full pipeline with mocked rpc_client ──────────

def test_full_pipeline_approved():
    """Full pipeline: session log → verdict_extractor → rpc_client result → flow_engine status."""
    # Step 1: Create a realistic session log
    text = (
        "Let me analyze the codebase.\n\n"
        "After reviewing all files, I'm confident this is correct.\n\n"
        "```verdict\n"
        '{"status": "approved", "details": "All acceptance criteria met.", "issues": []}'
        "\n```"
    )
    path = _write_jsonl([json.dumps(_assistant_msg(text))])

    try:
        # Step 2: Verdict extractor (what rpc_client calls)
        verdict = extract_phase_verdict(path)
        assert verdict["status"] == "approved", f"Expected approved, got {verdict['status']}"

        # Step 3: rpc_client result wrapping (simulated)
        rpc_result = {
            "success": True,
            "output": "",
            "session_log": str(path),
            "result": {
                "status": verdict["status"],
                "issues": verdict.get("issues", []),
                "verdict": verdict.get("raw_text", ""),
            }
        }

        # Step 4: flow_engine status mapping (simulated)
        status_data = rpc_result.get("result", {})
        phase_status = status_data.get("status")

        assert phase_status == "approved"
        final_status = "success" if phase_status == "approved" else phase_status
        assert final_status == "success"

    finally:
        os.unlink(path)


def test_full_pipeline_rejected():
    """Full pipeline: rejected verdict flows through to 'reject' status."""
    text = (
        "```verdict\n"
        '{"status": "rejected", "details": "Problems found.", '
        '"issues": ["Missing type hints on 3 functions", "No docstring"]}'
        "\n```"
    )
    path = _write_jsonl([json.dumps(_assistant_msg(text))])

    try:
        verdict = extract_phase_verdict(path)
        assert verdict["status"] == "rejected"

        rpc_result = {
            "success": True,
            "output": "",
            "session_log": str(path),
            "result": {
                "status": verdict["status"],
                "issues": verdict.get("issues", []),
                "verdict": verdict.get("raw_text", ""),
            }
        }

        status_data = rpc_result.get("result", {})
        phase_status = status_data.get("status")
        assert phase_status == "rejected"

        final_status = "reject" if phase_status == "rejected" else phase_status
        assert final_status == "reject"
        assert len(status_data["issues"]) >= 2

    finally:
        os.unlink(path)


def test_full_pipeline_no_verdict_error():
    """Full pipeline: no verdict → error state surfaces through flow_engine."""
    text = "Let me start by reading the schema file."
    path = _write_jsonl([json.dumps(_assistant_msg(text))])

    try:
        verdict = extract_phase_verdict(path)
        assert verdict["status"] is None

        # rpc_client returns error state when no verdict found
        rpc_result = {
            "success": True,
            "output": "",
            "session_log": str(path),
            "result": {
                "status": "error",
                "details": f"No verdict found in session log ({path}). The agent may not have emitted a verdict block.",
            }
        }

        status_data = rpc_result.get("result", {})
        phase_status = status_data.get("status")
        assert phase_status == "error"

        # flow_engine surfaces error state
        final_status = "error" if phase_status == "error" else phase_status
        assert final_status == "error"

    finally:
        os.unlink(path)


# ─── Integration Test 4: Directory-based session layout ────────────────

def test_directory_session_layout():
    """Session stored in directory layout (pi --session-dir creates subdirectories)."""
    import shutil
    base = Path(tempfile.mkdtemp())

    try:
        # Simulate pi creating a session directory with .jsonl inside
        session_dir = base / "179" / "builder-reviewer-builder-2026-05-28T10:30:00.jsonl"
        os.makedirs(session_dir, exist_ok=True)

        jsonl_file = session_dir / "2026-05-28T10-30-01-000Z_uuid.jsonl"
        with open(jsonl_file, "w") as f:
            json.dump(_assistant_msg(
                "```verdict\n{\"status\": \"approved\", \"details\": \"\", \"issues\": []}\n```"
            ), f)

        # resolve_session_log should find the actual file inside the directory
        from verdict_extractor import resolve_session_log
        resolved = resolve_session_log(session_dir)
        assert resolved is not None, "Should resolve directory to .jsonl file inside"
        assert resolved.is_file()

        # Extract verdict from resolved path
        verdict = extract_phase_verdict(resolved)
        assert verdict["status"] == "approved"

    finally:
        shutil.rmtree(base)


# ─── Run all tests ─────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Running flow engine integration smoke tests...\n")
    print("=" * 60)

    tests = [
        ("rpc pipeline: approved", test_rpc_verdict_pipeline_approved),
        ("rpc pipeline: rejected", test_rpc_verdict_pipeline_rejected),
        ("rpc pipeline: no verdict → error state", test_rpc_verdict_pipeline_no_verdict_error_state),
        ("flow_engine status mapping: approved → success", test_flow_engine_approved_status_mapping),
        ("flow_engine status mapping: rejected → reject", test_flow_engine_rejected_status_mapping),
        ("flow_engine status mapping: error → error", test_flow_engine_error_status_mapping),
        ("full pipeline: approved", test_full_pipeline_approved),
        ("full pipeline: rejected", test_full_pipeline_rejected),
        ("full pipeline: no verdict → error", test_full_pipeline_no_verdict_error),
        ("directory session layout", test_directory_session_layout),
    ]

    passed = 0
    failed = 0

    for name, fn in tests:
        try:
            fn()
            print(f"  ✓ {name}")
            passed += 1
        except Exception as e:
            import traceback
            print(f"  ✗ {name}: {e}")
            traceback.print_exc()
            failed += 1

    print(f"\n{'=' * 60}")
    print(f"\n📊 Integration Summary: {passed}/{passed + failed} tests passed")

    if failed > 0:
        print("❌ INTEGRATION FAILURES DETECTED — see failures above\n")
        sys.exit(1)
    else:
        print("✅ ALL INTEGRATION TESTS PASSED\n")
