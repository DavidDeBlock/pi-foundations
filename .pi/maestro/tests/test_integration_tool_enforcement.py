#!/usr/bin/env python3
"""
test_integration_tool_enforcement.py — Integration tests for the tools-allowlist contract.

These tests verify the contract that Maestro's flow engine hands to Pi's agent
runtime: when a phase declares a tool allowlist, that list is faithfully
embedded in the JSON spawn options sent to `pi --mode rpc`. Pi-side
enforcement (returning an error when a disallowed tool is invoked) is out of
scope for this issue and lives in the Pi agent codebase.

We mock the `pi` subprocess so we can inspect exactly what payload is sent
over stdin, then assert it matches the contract the PRD defines.

The three control cases:

  1. **Reviewer** runs with the reviewer tool set (no Write/Edit). The contract
     guarantees the spawn options will refuse Write/Edit invocations.
  2. **Scout** runs with the scout tool set (read-only). The contract
     guarantees the spawn options will refuse Edit invocations.
  3. **Builder** runs with the full tool set. The contract guarantees the spawn
     options will allow every common tool.

Updated for the post-deepening ``run_phase`` signature
(issue #31): now takes typed inputs (``Flow``, ``FlowContext``,
``PhaseState``, ``Terminal``, ``GithubClient``, ``FlowLogger``)
instead of the legacy ``(phase_name, flow_config, issue_num,
context)`` tuple. The contract under test is unchanged — only the
plumbing is.

Run with: python3 tests/test_integration_tool_enforcement.py
       or python3 -m pytest tests/test_integration_tool_enforcement.py
"""

import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add lib + parent dir to path
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

import flow_engine  # noqa: E402
import phase_runner  # noqa: E402  # Issue #44: run_phase moved to phase_runner
import prompt_assembler  # noqa: E402  # Issue #44: load_prompt's new home
from flow_engine import Flow, FlowContext, PhaseState  # noqa: E402
from flow_logger import ListLogger  # noqa: E402
from prompt_loader import LoadedPrompt  # noqa: E402
from terminal import Terminal  # noqa: E402
from working_memory import WorkingMemory  # noqa: E402


# ─── Helpers ───────────────────────────────────────────────────────────


def _make_typed_inputs(phase_name: str, expected_tools: list[str]) -> tuple:
    """Build the typed inputs the new ``run_phase`` signature requires.

    Returns ``(flow, context, state, term, gh, log)`` — the 6
    post-phase-name arguments to ``run_phase``.
    """
    phase_cfg = {
        "skill": f"/skill:{phase_name}",
        "retries": 1,
        "timeout_seconds": 60,
    }
    flow = Flow(
        name="test-flow",
        description="",
        scout_enabled=False,
        evidence_policy={},
        phases={phase_name: phase_cfg},
        transitions=(),
    )
    working_memory = WorkingMemory(
        issue=1, created_at="2026-01-01T00:00:00Z",
    )
    from context_prefetch import PrefetchedContext
    context = FlowContext(
        flow=flow,
        issue_num=1,
        issue_title="",
        issue_body="",
        comments_count=0,
        created_at="2026-01-01",
        parent_prd=None,
        working_memory=working_memory,
        prefetched=PrefetchedContext(git_sha="abc"),
        repo_context=None,
        scout_findings=None,
    )
    state = PhaseState(current_phase=phase_name)
    term = Terminal(verbose=False)
    gh = MagicMock()  # GithubClient is unused inside run_phase
    log = ListLogger()
    return flow, context, state, term, gh, log


def _run_phase_and_capture_tools(phase_name: str, expected_tools: list[str]) -> dict:
    """Run ``phase_runner.run_phase`` with the RPC layer mocked.

    Returns the kwargs that were passed to ``run_rpc_with_session_log`` so
    we can inspect the ``tools`` field directly.
    """
    flow, context, state, term, gh, log = _make_typed_inputs(phase_name, expected_tools)

    mock_loaded = LoadedPrompt(
        name=phase_name,
        description=f"Mocked {phase_name}",
        tools=list(expected_tools),
        body=f"Mocked body for {phase_name}.",
        source_format="md",
    )

    # Issue #44: re-point mocks to the new module owners from the
    # deepening extraction — load_prompt lives in prompt_assembler,
    # run_rpc_with_session_log is imported into phase_runner.
    with patch("prompt_assembler.load_prompt", return_value=mock_loaded), \
         patch("phase_runner.run_rpc_with_session_log") as mock_rpc, \
         patch("flow_engine.parse_session_log", return_value={}):
        mock_rpc.return_value = {
            "success": True,
            "output": "",
            "session_log": None,
            "result": {"status": "approved", "issues": [], "verdict": ""},
        }
        # Issue #31: ``run_phase`` takes 7 args now (post-deepening).
        phase_runner.run_phase(phase_name, flow, context, state, term, gh, log)

    mock_rpc.assert_called_once()
    _, kwargs = mock_rpc.call_args
    return kwargs


def _spawn_options_for_tools(tools: list[str] | None) -> dict:
    """Mirror the JSON spawn-options shape that run_rpc() emits over stdin."""
    payload: dict = {"type": "prompt", "message": "..."}
    if tools is not None:
        payload["tools"] = tools
    return payload


# ─── Test 1: reviewer invoking Write is blocked ───────────────────────

def test_reviewer_invoking_write_is_blocked():
    """Reviewer phase spawns with a tool set that excludes Write/Edit.

    The contract guarantees that Pi's runtime will refuse a Write or Edit
    invocation from this phase. Maestro's job is to deliver the correct
    allowlist in the spawn options; we verify that contract here.
    """
    expected = ["Read", "Bash", "Grep", "Glob"]
    kwargs = _run_phase_and_capture_tools("reviewer", expected)
    tools = kwargs.get("tools")

    # Contract: reviewer tool set must NOT include Write or Edit
    assert tools is not None, "tools must be passed (not None) so the contract is explicit"
    assert "Write" not in tools, f"Reviewer contract violated: Write must not be in {tools}"
    assert "Edit" not in tools, f"Reviewer contract violated: Edit must not be in {tools}"

    # And the spawn-options shape mirrors the contract
    spawn = _spawn_options_for_tools(tools)
    assert "tools" in spawn
    assert spawn["tools"] == tools


# ─── Test 2: scout invoking Edit is blocked ───────────────────────────

def test_scout_invoking_edit_is_blocked():
    """Scout phase spawns with a read-only tool set."""
    expected = ["Read", "Bash", "Grep", "Glob"]
    kwargs = _run_phase_and_capture_tools("scout", expected)
    tools = kwargs.get("tools")

    assert tools is not None
    # Scout is read-only — no Edit, no Write
    assert "Edit" not in tools, f"Scout contract violated: Edit must not be in {tools}"
    assert "Write" not in tools, f"Scout contract violated: Write must not be in {tools}"
    # Sanity: scout should have at least one read-only tool
    assert any(t in tools for t in ("Read", "Glob", "Grep"))


# ─── Test 3: builder invoking all allowed tools succeeds ─────────────

def test_builder_invoking_all_allowed_tools_succeeds():
    """Builder phase spawns with the full tool set — all common tools allowed."""
    expected = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]
    kwargs = _run_phase_and_capture_tools("builder", expected)
    tools = kwargs.get("tools")

    assert tools is not None
    # Builder has the full set
    assert "Read" in tools
    assert "Edit" in tools
    assert "Write" in tools
    assert "Bash" in tools
    assert "Grep" in tools
    assert "Glob" in tools


# ─── Run all tests ─────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Running tool-enforcement integration tests...\n")
    print("=" * 60)

    tests = [
        ("reviewer invoking Write is blocked (contract)", test_reviewer_invoking_write_is_blocked),
        ("scout invoking Edit is blocked (contract)", test_scout_invoking_edit_is_blocked),
        ("builder invoking all allowed tools succeeds (contract)", test_builder_invoking_all_allowed_tools_succeeds),
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
        print("❌ INTEGRATION FAILURES DETECTED — see above\n")
        sys.exit(1)
    else:
        print("✅ ALL TOOL-ENFORCEMENT INTEGRATION TESTS PASSED\n")
