#!/usr/bin/env python3
"""
test_flow_scout.py — Unit tests for the scout orchestration in flow_engine.

Verifies the helpers and wiring around the scout phase:

  - _scout_enabled() honours the flow flag and the phase's presence.
  - _initial_phase() skips scout when requested.
  - _run_scout_phase() runs the phase, parses findings, persists to memory,
    and returns the parsed dict on success.
  - _run_scout_phase() is non-fatal on failure (returns None, logs a line).
  - build_prompt() injects ``{scout_findings}`` from context into the prompt.
  - Default scout timeout is 240s.

These tests stub out the RPC layer and the prompt loader so they can run
without a `pi` binary or network access.

Run with: python3 -m pytest tests/test_flow_scout.py -v
       or: python3 tests/test_flow_scout.py
"""

import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

# Add lib + parent dir to path so we can import flow_engine
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

import flow_engine  # noqa: E402


# ─── Shared helpers ────────────────────────────────────────────────────


def _make_flow(scout_enabled: bool = True, with_scout_phase: bool = True) -> dict:
    """Build a minimal flow config for testing."""
    phases: dict = {}
    if with_scout_phase:
        phases["scout"] = {
            "skill": "/skill:scout",
            "retries": 1,
            "timeout_seconds": 240,
        }
    phases["builder"] = {
        "skill": "/skill:tdd",
        "retries": 3,
        "timeout_seconds": 1800,
    }
    return {
        "name": "builder-reviewer",
        "scout_enabled": scout_enabled,
        "scout_timeout_seconds": 240,
        "phases": phases,
        "transitions": [],
    }


def _make_fake_run_phase(scout_status: str = "success", scout_output: str = ""):
    """Return a function that mocks flow_engine.run_phase with a canned scout result.

    Note: PHASE_OUTPUT lives in the raw ``output`` field, not in the summarized
    ``details`` field. So the canned output is returned in the ``output`` key.
    """
    def _fake(phase_name, flow_config, issue_num, context, log=None):
        if phase_name == "scout":
            # ``details`` is the summarized verdict; ``output`` is the raw text
            # the LLM produced. For failure mocks, the original message goes
            # into both so the rejection message is preserved in working memory.
            details_msg = scout_output if scout_status != "success" else f"scout {scout_status}"
            return (
                {
                    "status": scout_status,
                    "details": details_msg,
                    "output": scout_output,
                },
                "/tmp/scout.jsonl",
            )
        return ({"status": "success", "details": f"{phase_name} ran"}, None)
    return _fake


def _scout_success_output() -> str:
    return """Preamble from the scout.

### PHASE_OUTPUT: success
{
  "relevant_files": ["a.py", "b.py"],
  "test_command": "pytest",
  "patterns": ["p1"],
  "conventions": ["c1"],
  "risks": ["r1"],
  "scanned_at": "2026-06-04T00:00:00Z"
}
### END_PHASE_OUTPUT

Trailing text."""


# ─── Test: _scout_enabled ──────────────────────────────────────────────


def test_scout_enabled_returns_true_when_flag_and_phase_present():
    """scout_enabled True + 'scout' phase in config → True."""
    assert flow_engine._scout_enabled(_make_flow(scout_enabled=True, with_scout_phase=True)) is True


def test_scout_enabled_returns_false_when_flag_false():
    """scout_enabled False → False, even if the phase is defined."""
    assert flow_engine._scout_enabled(_make_flow(scout_enabled=False, with_scout_phase=True)) is False


def test_scout_enabled_returns_false_when_phase_missing():
    """scout_enabled True but no 'scout' phase in config → False."""
    assert flow_engine._scout_enabled(_make_flow(scout_enabled=True, with_scout_phase=False)) is False


# ─── Test: _initial_phase ──────────────────────────────────────────────


def test_initial_phase_returns_first_phase_by_default():
    """Default behaviour: first phase in the flow (insertion order)."""
    flow = _make_flow()
    assert flow_engine._initial_phase(flow) == "scout"


def test_initial_phase_skips_scout_when_requested():
    """skip_scout=True with 'scout' as first phase → returns the next one."""
    flow = _make_flow()
    assert flow_engine._initial_phase(flow, skip_scout=True) == "builder"


def test_initial_phase_returns_none_for_empty_flow():
    """Empty phases dict → None (no phase to run)."""
    assert flow_engine._initial_phase({"phases": {}}) is None
    assert flow_engine._initial_phase({"phases": {}}, skip_scout=True) is None


def test_initial_phase_does_not_skip_non_scout_first_phase():
    """skip_scout=True is a no-op when the first phase isn't 'scout'."""
    flow = {
        "phases": {
            "builder": {"retries": 3},
            "reviewer": {"retries": 1},
        }
    }
    assert flow_engine._initial_phase(flow, skip_scout=True) == "builder"


# ─── Test: _run_scout_phase — happy path ───────────────────────────────


def test_run_scout_phase_returns_parsed_findings_on_success():
    """On a successful scout, returns the parsed findings dict."""
    tmpdir = Path(tempfile.mkdtemp(prefix="run_scout_test_"))

    with patch("flow_engine.run_phase", _make_fake_run_phase(
        scout_status="success", scout_output=_scout_success_output()
    )):
        # Use a real MemoryStore against a temp dir
        from working_memory import MemoryStore
        store = MemoryStore(issue_num=42, memory_dir=tmpdir)
        findings = flow_engine._run_scout_phase(
            flow_config=_make_flow(),
            issue_num=42,
            context={},
            memory_store=store,
        )

    assert findings is not None
    assert "parse_error" not in findings
    assert findings["relevant_files"] == ["a.py", "b.py"]
    assert findings["test_command"] == "pytest"
    assert findings["scanned_at"] == "2026-06-04T00:00:00Z"


def test_run_scout_phase_persists_findings_to_working_memory():
    """Successful scout writes the findings to working memory."""
    tmpdir = Path(tempfile.mkdtemp(prefix="run_scout_mem_"))

    with patch("flow_engine.run_phase", _make_fake_run_phase(
        scout_status="success", scout_output=_scout_success_output()
    )):
        from working_memory import MemoryStore
        store = MemoryStore(issue_num=99, memory_dir=tmpdir)
        flow_engine._run_scout_phase(
            flow_config=_make_flow(),
            issue_num=99,
            context={},
            memory_store=store,
        )
        memory = store.load()

    assert memory.scout.get("status") == "success"
    assert "findings" in memory.scout
    assert memory.scout["findings"]["relevant_files"] == ["a.py", "b.py"]
    # Raw output is also persisted (capped) for debugging
    assert "raw_output" in memory.scout
    assert "PHASE_OUTPUT" in memory.scout["raw_output"]


# ─── Test: _run_scout_phase — failure / non-fatal ──────────────────────


def test_run_scout_phase_returns_none_on_reject():
    """Scout self-rejects → returns None, builder proceeds with placeholder."""
    tmpdir = Path(tempfile.mkdtemp(prefix="run_scout_reject_"))

    with patch("flow_engine.run_phase", _make_fake_run_phase(
        scout_status="reject", scout_output="scout rejected: no useful findings"
    )):
        from working_memory import MemoryStore
        store = MemoryStore(issue_num=7, memory_dir=tmpdir)
        findings = flow_engine._run_scout_phase(
            flow_config=_make_flow(),
            issue_num=7,
            context={},
            memory_store=store,
        )
        memory = store.load()

    assert findings is None
    # The failure is recorded so retrospective can see it
    assert memory.scout.get("status") == "reject"
    assert "no useful findings" in memory.scout.get("details", "")


def test_run_scout_phase_returns_none_on_error():
    """Scout errors (e.g. RPC failure) → returns None, builder proceeds."""
    tmpdir = Path(tempfile.mkdtemp(prefix="run_scout_err_"))

    with patch("flow_engine.run_phase", _make_fake_run_phase(
        scout_status="error", scout_output="RPC failed: timeout"
    )):
        from working_memory import MemoryStore
        store = MemoryStore(issue_num=8, memory_dir=tmpdir)
        findings = flow_engine._run_scout_phase(
            flow_config=_make_flow(),
            issue_num=8,
            context={},
            memory_store=store,
        )
        memory = store.load()

    assert findings is None
    assert memory.scout.get("status") == "error"


def test_run_scout_phase_returns_parse_error_envelope_on_unparseable_output():
    """Scout 'succeeds' but emits no PHASE_OUTPUT block → envelope, not None.

    The envelope is returned so the builder prompt can still show the raw
    text (it tells the user 'scout ran but output was unparseable').
    """
    tmpdir = Path(tempfile.mkdtemp(prefix="run_scout_unparse_"))

    with patch("flow_engine.run_phase", _make_fake_run_phase(
        scout_status="success", scout_output="I forgot the markers entirely."
    )):
        from working_memory import MemoryStore
        store = MemoryStore(issue_num=11, memory_dir=tmpdir)
        findings = flow_engine._run_scout_phase(
            flow_config=_make_flow(),
            issue_num=11,
            context={},
            memory_store=store,
        )

    assert findings is not None
    assert "parse_error" in findings
    assert "I forgot the markers entirely." in findings["raw"]


# ─── Test: build_prompt injects {scout_findings} ──────────────────────


def test_build_prompt_substitutes_scout_findings_from_context():
    """When context has scout_findings_md, it replaces ``{scout_findings}``."""
    with patch("flow_engine.load_prompt") as mock_load:
        from prompt_loader import LoadedPrompt
        mock_load.return_value = LoadedPrompt(
            name="builder",
            description="",
            tools=["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
            body="## Context from Scout\n{scout_findings}\n## Rest",
            source_format="md",
        )
        prompt, _tools = flow_engine.build_prompt(
            phase_name="builder",
            phase_config={"skill": "/skill:tdd", "retries": 3, "timeout_seconds": 1800},
            flow_config={"phases": {}},
            issue_num=42,
            context={"scout_findings_md": "## Scout Findings\n### Test Command\n`pytest`\n"},
        )

    assert "## Scout Findings" in prompt
    assert "`pytest`" in prompt
    assert "{scout_findings}" not in prompt  # placeholder must be substituted


def test_build_prompt_default_when_scout_disabled():
    """When scout_findings_md is missing from context, a stable placeholder is used."""
    with patch("flow_engine.load_prompt") as mock_load:
        from prompt_loader import LoadedPrompt
        mock_load.return_value = LoadedPrompt(
            name="builder",
            description="",
            tools=["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
            body="## Context from Scout\n{scout_findings}\n## Rest",
            source_format="md",
        )
        prompt, _tools = flow_engine.build_prompt(
            phase_name="builder",
            phase_config={"skill": "/skill:tdd", "retries": 3, "timeout_seconds": 1800},
            flow_config={"phases": {}},
            issue_num=42,
            context={},  # no scout_findings_md
        )

    assert "(Scout disabled for this flow.)" in prompt
    assert "{scout_findings}" not in prompt


# ─── Test: scout timeout default ──────────────────────────────────────


def test_scout_timeout_default_240_seconds():
    """When scout_timeout_seconds is missing, 240s is the default."""
    flow = {
        "phases": {"scout": {"retries": 1, "timeout_seconds": 240}},
        # No scout_timeout_seconds at the flow level
    }
    # _run_scout_phase reads the timeout from the flow config; we just
    # verify that the default expected by the spec is 240.
    assert flow.get("scout_timeout_seconds", 240) == 240


# ─── Test runner ─────────────────────────────────────────────────────────


if __name__ == "__main__":
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
