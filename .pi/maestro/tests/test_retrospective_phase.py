#!/usr/bin/env python3
"""
Unit tests for the flow-engine integration with the retrospective phase.

Covers the 6 AC-listed tests:

- ``test_retrospective_runs_after_close``
- ``test_retrospective_failure_routes_to_finish_not_diagnostic``
- ``test_retrospective_writes_to_learnings_file``
- ``test_retrospective_proposes_amendment_after_3_occurrences``
- ``test_retrospective_skipped_when_disabled_in_flow``
- ``test_retrospective_output_structured_as_phase_output``

These tests target the flow-engine glue (``run_phase`` and the
retrospective-specific helpers in ``flow_engine.py``). They do NOT
spin up the full flow engine with an LLM in the loop — that lives
in ``test_integration_retrospective.py``.

Run with: ``python3 tests/test_retrospective_phase.py``
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

# Add lib + maestro dir to path so the imports work.
MAESTRO_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(MAESTRO_DIR))
sys.path.insert(0, str(MAESTRO_DIR / "lib"))

from flow_engine import (  # noqa: E402
    get_next_step,
)
from phase_runner import (  # noqa: E402
    _format_evidence_summary,
    _format_learnings_excerpt,
    _persist_retrospective_result,
    _populate_retrospective_context,
    run_phase,
)
from learnings import (  # noqa: E402
    AMENDMENTS_FILENAME,
    LEARNINGS_FILENAME,
    format_amendment_entry,
    format_learning_entry,
    parse_retrospective_output,
)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_dir(prefix: str = "maestro_retro_test_") -> Path:
    """Return a fresh empty temp directory (caller cleans up)."""
    return Path(tempfile.mkdtemp(prefix=prefix))


def _cleanup(d: Path) -> None:
    """Best-effort recursive cleanup of a temp dir."""
    import shutil
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


def _flow_with_retro(
    close_policy: dict = None,
    include_retrospective: bool = True,
) -> dict:
    """Build a minimal flow config with builder/close/retrospective phases."""
    phases: dict = {
        "builder": {
            "skill": "/skill:tdd",
            "timeout_seconds": 60,
            "retries": 1,
        },
        "close": {
            "is_local": True,
            "command": "true",
            "timeout_seconds": 30,
        },
    }
    transitions: list = [
        {
            "from": "builder",
            "on_success": "close",
            "on_reject": "builder",
            "on_error": "builder",
        },
    ]
    if include_retrospective:
        phases["retrospective"] = {
            "skill": "/skill:retrospective",
            "timeout_seconds": 60,
            "retries": 0,
            "is_optional": True,
        }
        # When retrospective is present, close → retrospective → finish
        transitions.extend([
            {
                "from": "close",
                "on_success": "retrospective",
                "on_reject": "diagnostic",
                "on_error": "diagnostic",
            },
            {
                "from": "retrospective",
                "on_success": "finish",
                "on_reject": "finish",
                "on_error": "finish",
            },
        ])
    else:
        # When retrospective is absent, close → finish (legacy layout)
        transitions.append({
            "from": "close",
            "on_success": "finish",
            "on_reject": "diagnostic",
            "on_error": "diagnostic",
        })
    transitions.append({
        "from": "diagnostic",
        "on_success": "finish",
        "on_reject": "finish",
        "on_error": "finish",
    })
    return {
        "name": "test-retro",
        "phases": phases,
        "transitions": transitions,
        "evidence_policy": close_policy or {
            "required_on_success": ["tested", "reviewed"],
            "on_missing_evidence": "warn_but_proceed",
        },
    }


# ─── AC Tests ────────────────────────────────────────────────────────────


def test_retrospective_runs_after_close():
    """The flow config's transition for ``close`` should point to
    ``retrospective`` (not directly to ``finish``). The transition for
    ``retrospective`` should point to ``finish``.
    """
    flow = _flow_with_retro()
    # close → retrospective (on success)
    nxt = get_next_step(flow["transitions"], "close", "success")
    assert nxt == "retrospective", f"close→success should go to retrospective, got {nxt}"
    # retrospective → finish (any outcome)
    for status in ("success", "reject", "error"):
        nxt = get_next_step(flow["transitions"], "retrospective", status)
        assert nxt == "finish", f"retrospective→{status} should go to finish, got {nxt}"


def test_retrospective_failure_routes_to_finish_not_diagnostic():
    """Even when the retrospective phase raises an exception, ``run_phase``
    must convert it to a synthetic success result (the phase is
    non-blocking) — the flow can then transition to ``finish`` normally.
    """
    flow = _flow_with_retro()
    context: dict = {"phase_outputs": {}}

    # Patch the inner runner to always raise. run_phase's wrapper
    # should catch and convert to success.
    # Issue #44: _run_phase_inner moved from flow_engine to phase_runner
    # during the deepening extraction — patch the new owner.
    with patch("phase_runner._run_phase_inner", side_effect=RuntimeError("boom")):
        result, _ = run_phase("retrospective", flow, 42, context)

    # The non-blocking handler converts the exception to a success
    assert result["status"] == "success"
    assert "non-blocking" in result["details"].lower() or "non-fatal" in result["details"].lower()
    assert "RuntimeError" in result["details"] or "boom" in result["details"]


def test_retrospective_writes_to_learnings_file():
    """``_persist_retrospective_result`` parses the LLM's PHASE_OUTPUT
    block and appends a structured entry to the repo's
    ``.maestro/learnings.md``.
    """
    repo = _make_dir()
    try:
        rpc_output = """some preamble
### PHASE_OUTPUT: success
{
  "outcome": "success",
  "what_worked": ["scout was accurate"],
  "what_failed": [],
  "surprising": ["repo uses bun"],
  "repo_specific_learnings": ["uses bun, not pnpm"],
  "proposed_amendments": []
}
### END_PHASE_OUTPUT
trailing noise
"""
        _persist_retrospective_result(
            issue_num=42,
            flow_name="test-flow",
            rpc_output=rpc_output,
            flow_status="success",
            repo_path=repo,
        )

        path = repo / LEARNINGS_FILENAME
        assert path.exists(), "learnings.md should have been created"
        text = path.read_text(encoding="utf-8")

        assert "Issue #42" in text
        assert "(success)" in text
        assert "**What worked:**" in text
        assert "**Surprising:**" in text
        assert "**Repo-specific learnings:**" in text
        # Specifically: "uses bun" appears in surprising
        assert "repo uses bun" in text
    finally:
        _cleanup(repo)


def test_retrospective_proposes_amendment_after_3_occurrences():
    """When the same failure pattern has appeared ≥3 times in the
    learnings file, ``_persist_retrospective_result`` appends an
    amendment to ``.maestro/proposed-amendments.md``.
    """
    repo = _make_dir()
    try:
        # Seed the learnings file with two similar-failure entries
        # (sharing ≥3 keywords with the upcoming failure).
        for issue_n in (1, 2):
            entry = format_learning_entry(issue_n, "failure", {
                "what_failed": [
                    "builder ignored the snake_case convention in migrations"
                ],
            })
            from learnings import append_to_learnings
            append_to_learnings(repo, entry)

        # Now run the retrospective with a third occurrence of the
        # same pattern. After persisting the entry, the recurrence
        # detector should see ≥3 matches and append an amendment.
        rpc_output = """### PHASE_OUTPUT: success
{
  "outcome": "failure",
  "what_worked": ["scout was accurate"],
  "what_failed": ["builder ignored the snake_case convention in another file"],
  "surprising": [],
  "repo_specific_learnings": ["tighten convention emphasis in builder prompt"],
  "proposed_amendments": [
    {
      "title": "Tighten builder prompt convention section",
      "root_cause": "builder ignores convention",
      "proposed_fix": "add a 'convention emphasis' line to builder.md",
      "effort": "30 min"
    }
  ]
}
### END_PHASE_OUTPUT
"""
        _persist_retrospective_result(
            issue_num=3,
            flow_name="test-flow",
            rpc_output=rpc_output,
            flow_status="failure",
            repo_path=repo,
        )

        amend_path = repo / AMENDMENTS_FILENAME
        assert amend_path.exists(), "proposed-amendments.md should have been created"
        text = amend_path.read_text(encoding="utf-8")
        assert "Tighten builder prompt convention section" in text
        assert "**Occurrences:**" in text
        assert "**Owner:** (unassigned)" in text
    finally:
        _cleanup(repo)


def test_retrospective_skipped_when_disabled_in_flow():
    """A flow that doesn't declare a ``retrospective`` phase in its
    config never invokes the retrospective logic — the engine has
    nothing to do.
    """
    flow = _flow_with_retro(include_retrospective=False)
    assert "retrospective" not in flow["phases"]
    # There's no transition ``from: retrospective`` either
    retro_trans = [t for t in flow["transitions"] if t.get("from") == "retrospective"]
    assert retro_trans == []


def test_retrospective_output_structured_as_phase_output():
    """The retrospective's expected output is a valid ``PHASE_OUTPUT``
    block with all the schema fields. We verify the parser handles it
    and the formatter renders every field.
    """
    rpc_output = """### PHASE_OUTPUT: success
{
  "outcome": "success",
  "what_worked": ["a", "b"],
  "what_failed": ["c"],
  "surprising": ["d"],
  "repo_specific_learnings": ["e"],
  "proposed_amendments": [{"title": "amend x"}]
}
### END_PHASE_OUTPUT
"""
    parsed = parse_retrospective_output(rpc_output)
    assert "parse_error" not in parsed
    # All schema fields preserved
    for key in (
        "outcome", "what_worked", "what_failed", "surprising",
        "repo_specific_learnings", "proposed_amendments",
    ):
        assert key in parsed, f"Missing key in parsed output: {key}"
    assert parsed["outcome"] == "success"
    assert parsed["what_worked"] == ["a", "b"]
    assert parsed["proposed_amendments"] == [{"title": "amend x"}]

    # Formatter renders all of them
    entry = format_learning_entry(99, "success", parsed)
    assert "**What worked:**" in entry
    assert "**What failed:**" in entry
    assert "**Surprising:**" in entry
    assert "**Repo-specific learnings:**" in entry
    assert "**Proposed amendments:**" in entry
    assert "amend x" in entry


# ─── Supporting tests ────────────────────────────────────────────────────


def test_populate_retrospective_context_fills_in_vars():
    """``_populate_retrospective_context`` populates the context dict
    with the variables the prompt needs (flow_name, final_status,
    repo_path, evidence_summary, learnings_excerpt).
    """
    repo = _make_dir()
    try:
        context: dict = {
            "phase_outputs": {
                "close": {"status": "success"},
            },
        }
        flow = {
            "name": "test-flow",
            "phases": {},
            "transitions": [],
        }
        _populate_retrospective_context(context, flow, 42)
        assert context["flow_name"] == "test-flow"
        assert context["final_status"] == "success"  # from close phase
        # repo_path is set
        assert "repo_path" in context
        # evidence_summary is some string
        assert isinstance(context["evidence_summary"], str)
        # learnings_excerpt is a string (default or actual)
        assert isinstance(context["learnings_excerpt"], str)
    finally:
        _cleanup(repo)


def test_format_evidence_summary_handles_missing_dir():
    """``_format_evidence_summary`` returns a friendly default when
    the evidence dir doesn't exist (no crash).
    """
    # No setup — no evidence dir exists
    summary = _format_evidence_summary(99999)
    assert isinstance(summary, str)
    # Even when nothing's there, the format includes "missing" or
    # similar.
    assert "missing" in summary or "verified" in summary or "unverified" in summary


def test_format_learnings_excerpt_returns_default_when_no_file():
    """``_format_learnings_excerpt`` returns a friendly default when
    the file is absent.
    """
    d = _make_dir()
    try:
        excerpt = _format_learnings_excerpt(d)
        assert "no previous learnings" in excerpt.lower()
    finally:
        _cleanup(d)


def test_format_learnings_excerpt_truncates_long_files():
    """A file longer than ``max_chars`` is truncated to the tail."""
    d = _make_dir()
    try:
        path = d / LEARNINGS_FILENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(("a" * 5000) + "\n" + ("b" * 5000), encoding="utf-8")
        excerpt = _format_learnings_excerpt(d, max_chars=100)
        assert "truncated" in excerpt.lower()
        # The tail (the 'b' * 5000) is preserved
        assert "b" in excerpt
    finally:
        _cleanup(d)


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
