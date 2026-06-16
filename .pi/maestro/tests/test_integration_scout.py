#!/usr/bin/env python3
"""
test_integration_scout.py — End-to-end integration tests for the scout slice.

These tests verify the integration boundary between:
  - flow_engine.run_flow_on_issue() (scout orchestration)
  - run_phase() → build_prompt() → run_rpc_with_session_log() (the actual LLM call)
  - MemoryStore (scout findings persistence)
  - Working memory JSON injection in builder prompt

They do NOT mock the LLM. They mock the RPC boundary (`run_rpc_with_session_log`)
plus the GitHub / Terminal / prefetch fakes so the flow can run end-to-end
without network access or a real `pi` binary.

The third integration test the issue body calls out
(``test_scout_with_readonly_tools_cannot_write``) is already covered by
``tests/test_integration_tool_enforcement.py::test_scout_invoking_edit_is_blocked``
and is intentionally not duplicated here.

Run with: python3 -m pytest tests/test_integration_scout.py -v
       or: python3 tests/test_integration_scout.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add lib + parent dir to path
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

import flow_engine  # noqa: E402
from working_memory import MemoryStore  # noqa: E402
from terminal import Terminal  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="maestro_scout_int_"))


def _scout_rpc_response(findings_payload: dict) -> dict:
    """Build a canned run_rpc_with_session_log response for a successful scout."""
    details = (
        "Preamble text from the scout.\n\n"
        "### PHASE_OUTPUT: success\n"
        f"{json.dumps(findings_payload, indent=2)}\n"
        "### END_PHASE_OUTPUT\n"
    )
    return {
        "success": True,
        "output": details,
        "session_log": "/tmp/scout.jsonl",
        "result": {
            "status": "approved",
            "verdict": "scout completed",
            "issues": [],
        },
    }


def _success_rpc_response(verdict: str = "ok") -> dict:
    """Build a canned RPC response for a generic successful phase."""
    return {
        "success": True,
        "output": f"Output for {verdict}",
        "session_log": f"/tmp/{verdict}.jsonl",
        "result": {
            "status": "approved",
            "verdict": verdict,
            "issues": [],
        },
    }


def _finish_rpc_response() -> dict:
    """Return a 'finish' verdict (reviewer approves) so the flow terminates."""
    return {
        "success": True,
        "output": "Looks good.",
        "session_log": "/tmp/reviewer.jsonl",
        "result": {
            "status": "approved",
            "verdict": "approved",
            "issues": [],
        },
    }


def _run_flow_with_canned_rpc(rpc_responses: list, scout_enabled: bool = True) -> list:
    """Run a builder-reviewer flow with canned RPC responses.

    Returns the list of prompts (one per phase call) sent through the RPC,
    in order. This is what we assert on to verify scout findings propagate.
    """
    prompts_sent: list = []
    response_iter = iter(rpc_responses)

    def fake_rpc(prompt, phase_name, timeout, **kwargs):
        prompts_sent.append({"phase": phase_name, "prompt": prompt, "tools": kwargs.get("tools")})
        try:
            return next(response_iter)
        except StopIteration:
            # Default to a successful verdict to avoid hanging the flow
            return _success_rpc_response(verdict=phase_name)

    flow = {
        "name": "builder-reviewer",
        "scout_enabled": scout_enabled,
        "scout_timeout_seconds": 240,
        "phases": {
            "scout": {"skill": "/skill:scout", "retries": 1, "timeout_seconds": 240},
            "builder": {"skill": "/skill:tdd", "retries": 3, "timeout_seconds": 1800},
            "reviewer": {"skill": "/skill:reviewer", "retries": 1, "timeout_seconds": 1200},
        },
        "transitions": [
            {"from": "scout", "on_success": "builder", "on_reject": "builder", "on_error": "builder"},
            {"from": "builder", "on_success": "reviewer", "on_reject": "builder", "on_error": "reviewer"},
            {"from": "reviewer", "on_success": "finish", "on_reject": "builder", "on_error": "reviewer"},
        ],
    }

    gh_mock = MagicMock()
    gh_mock.fetch_issue.return_value = MagicMock(
        title="Test issue",
        body="Issue body",
        comments=[],
        created_at="2026-01-01T00:00:00Z",
    )

    term = Terminal(verbose=False)

    tmpdir = _make_tmpdir()
    try:
        with patch.object(flow_engine, "prefetch_context") as mock_pref, \
             patch("flow_engine.MemoryStore") as MockStore, \
             patch.object(flow_engine, "load_flow", return_value=flow), \
             patch("flow_engine.run_rpc_with_session_log", side_effect=fake_rpc), \
             patch("flow_engine.parse_session_log", return_value={}):
            # Mock the prefetch
            from context_prefetch import PrefetchedContext
            mock_pref.return_value = PrefetchedContext(git_sha="abc123")

            # Mock MemoryStore to use our temp dir
            def factory(issue_num, memory_dir=None):
                return MemoryStore(issue_num, memory_dir=tmpdir)
            MockStore.side_effect = factory

            # Issue #34: ``run_flow_on_issue`` was replaced by the narrow
            # :func:`flow_engine.run_flow` + caller-side dispatch. The
            # :func:`app_shell._run` helper does the dispatching work
            # (load flow → build :class:`FlowContext` → pick first
            # phase) so this integration test can call a single
            # function and exercise the full scout → builder →
            # reviewer path.
            from app_shell import _run
            _run(
                "builder-reviewer", 42, term, gh_mock,
            )
    finally:
        import shutil
        try:
            shutil.rmtree(tmpdir)
        except OSError:
            pass

    return prompts_sent


# ─── Test 1: end-to-end scout → builder → reviewer ──────────────────────


def test_end_to_end_scout_to_builder():
    """Full flow runs scout first, then builder receives findings in its prompt.

    Verifies:
      - Scout is the first phase invoked
      - The builder's prompt contains the formatted scout findings
      - The reviewer runs after the builder (not before)
    """
    scout_findings = {
        "relevant_files": ["src/auth/session.ts", "src/auth/session.test.ts"],
        "test_command": "bun test src/auth",
        "patterns": ["uses repository pattern"],
        "conventions": ["no default exports"],
        "risks": ["session.ts is imported by 12 modules"],
        "scanned_at": "2026-06-04T12:34:00Z",
    }

    prompts_sent = _run_flow_with_canned_rpc([
        _scout_rpc_response(scout_findings),  # scout
        _success_rpc_response("builder"),    # builder
        _finish_rpc_response(),               # reviewer (approves → finish)
    ])

    phase_order = [p["phase"] for p in prompts_sent]
    assert phase_order[0] == "scout", f"scout should be first, got {phase_order}"
    assert "scout" not in phase_order[1:], "scout should only run once"

    # The builder's prompt should contain the formatted scout findings
    builder_prompt = next(p["prompt"] for p in prompts_sent if p["phase"] == "builder")
    assert "## Scout Findings" in builder_prompt
    assert "`src/auth/session.ts`" in builder_prompt
    assert "`bun test src/auth`" in builder_prompt
    assert "uses repository pattern" in builder_prompt
    assert "⚠️ session.ts is imported by 12 modules" in builder_prompt

    # The scout itself was called with read-only tools
    scout_call = next(p for p in prompts_sent if p["phase"] == "scout")
    assert "Edit" not in scout_call["tools"]
    assert "Write" not in scout_call["tools"]


# ─── Test 2: empty scout findings still proceed ─────────────────────────


def test_scout_with_no_findings_still_proceeds():
    """Scout returns an empty PHASE_OUTPUT block; builder still runs.

    The builder's prompt gets a 'no findings' placeholder (not nothing) so
    the variable substitution is always defined.
    """
    prompts_sent = _run_flow_with_canned_rpc([
        _scout_rpc_response({}),  # scout returns empty findings
        _success_rpc_response("builder"),
        _finish_rpc_response(),
    ])

    phase_order = [p["phase"] for p in prompts_sent]
    assert "scout" in phase_order
    assert "builder" in phase_order, "builder should still run after empty scout"

    # The builder's prompt gets a stable placeholder, not the literal JSON
    builder_prompt = next(p["prompt"] for p in prompts_sent if p["phase"] == "builder")
    assert "## Scout Findings" in builder_prompt  # heading always present
    # Empty findings → "ran but no findings" message
    assert "ran but produced no findings" in builder_prompt


# ─── Test 3: scout with scout_enabled=false is skipped ─────────────────


def test_scout_disabled_skips_scout_phase():
    """When scout_enabled is false, the flow starts at the first non-scout phase."""
    prompts_sent = _run_flow_with_canned_rpc(
        rpc_responses=[
            _success_rpc_response("builder"),
            _finish_rpc_response(),
        ],
        scout_enabled=False,
    )

    phase_order = [p["phase"] for p in prompts_sent]
    assert "scout" not in phase_order, f"scout should not run when disabled, got {phase_order}"
    assert phase_order[0] == "builder"

    # The builder's prompt gets the "scout disabled" placeholder under the
    # "## Context from Scout" heading (which is part of the prompt template,
    # not the placeholder itself).
    builder_prompt = next(p["prompt"] for p in prompts_sent if p["phase"] == "builder")
    assert "## Context from Scout" in builder_prompt
    assert "(Scout disabled for this flow.)" in builder_prompt


# ─── Test 4: scout failure is non-fatal ─────────────────────────────────


def test_scout_failure_routes_to_builder_not_finish():
    """A failed scout (reject verdict) logs a warning but the builder still runs."""
    failed_rpc = {
        "success": True,
        "output": "scout ran out of time",
        "session_log": "/tmp/scout.jsonl",
        "result": {
            "status": "rejected",
            "verdict": "scout timed out",
            "issues": ["no findings produced"],
        },
    }

    prompts_sent = _run_flow_with_canned_rpc([
        failed_rpc,                          # scout fails
        _success_rpc_response("builder"),    # builder still runs
        _finish_rpc_response(),              # reviewer approves
    ])

    phase_order = [p["phase"] for p in prompts_sent]
    assert "scout" in phase_order
    assert "builder" in phase_order, "builder must still run after scout failure"
    # The builder prompt gets the "no findings" placeholder (scout never produced any)
    builder_prompt = next(p["prompt"] for p in prompts_sent if p["phase"] == "builder")
    assert "## Scout Findings" in builder_prompt
    assert "No scout findings" in builder_prompt
    assert "proceed with general exploration" in builder_prompt


# ─── Test runner ─────────────────────────────────────────────────────────


if __name__ == "__main__":
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
            import traceback
            failed += 1
            print(f"ERROR {name}: {type(e).__name__}: {e}")
            traceback.print_exc()
    print(f"\n{len(test_funcs) - failed}/{len(test_funcs)} tests passed")
    sys.exit(0 if failed == 0 else 1)
