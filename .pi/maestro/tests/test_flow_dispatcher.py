#!/usr/bin/env python3
"""
Unit tests for ``flow_dispatcher.py`` — the new ``build_flow_context``
function that loads the static setup for a single flow run.

Per the deepening PRD, ``build_flow_context`` extracts the 7 setup
steps that previously lived at the top of ``run_flow_on_issue``:

  1. Fetch issue metadata
  2. Fetch parent PRD body if referenced
  3. Load working memory
  4. Prefetch context
  5. Persist git_sha / repo_path
  6. Load repo context
  7. Run scout synchronously

These tests verify each step in isolation (synthetic ``Flow`` +
mocked ``GithubClient`` + temp-dir ``MemoryStore`` + temp-file
``ProjectsRegistry``) and cover the happy path plus the five
failure modes the issue acceptance criteria call out:

  - All fields are populated when all sources succeed
  - Missing parent PRD → ``parent_prd: None``, no exception
  - Corrupt working memory → ``working_memory`` defaults to a fresh view
  - Missing projects registry → ``repo_context: None``, no exception
  - Scout failure → ``scout_findings: None``, flow can still proceed
  - Successful scout → ``scout_findings`` populated and persisted

Plus a few extras: issue-metadata failure, ``FlowContext`` frozen-ness,
and the subtle distinction between "scout disabled" and "scout failed"
that the legacy dict context must reproduce.

Run with: ``python3 tests/test_flow_dispatcher.py`` (custom runner)
       or ``python3 -m pytest tests/test_flow_dispatcher.py``
"""

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add parent to path so ``import flow_dispatcher`` works without a
# package install.
sys.path.insert(0, str(Path(__file__).parent.parent))

import flow_dispatcher  # noqa: E402
import flow_engine  # noqa: E402
from flow_engine import Flow, FlowContext  # noqa: E402
from working_memory import MemoryStore, WorkingMemory  # noqa: E402


# ─── Shared fixtures ─────────────────────────────────────────────────────


def _make_synthetic_flow(
    scout_enabled: bool = True,
    with_scout_phase: bool = True,
) -> dict:
    """Build a minimal flow config dict for testing."""
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
        "name": "test-flow",
        "description": "synthetic test flow",
        "scout_enabled": scout_enabled,
        "scout_timeout_seconds": 240,
        "phases": phases,
        "transitions": [
            {"from": "scout", "on_success": "builder", "on_reject": "builder", "on_error": "builder"},
            {"from": "builder", "on_success": "finish", "on_reject": "builder", "on_error": "builder"},
        ],
    }


def _make_flow_value(scout_enabled: bool = True) -> Flow:
    """Build a synthetic ``Flow`` value object (mirrors what the shim
    would build from a real flow config)."""
    return Flow(
        name="test-flow",
        description="synthetic test flow",
        scout_enabled=scout_enabled,
        evidence_policy={"on_missing_evidence": "warn_but_proceed"},
        phases={"scout": {}, "builder": {}},
        transitions=(),
    )


def _make_github_mock(
    issue_title: str = "Implement feature X",
    issue_body: str = "Please implement feature X.",
    parent_body: str | None = None,
    fetch_fails: bool = False,
) -> MagicMock:
    """Build a mocked ``GithubClient``.

    By default, returns a successful issue fetch with a body that
    references ``## Parent\\n\\n#99`` so the parent-PRD step has
    something to load. Pass ``parent_body=None`` to skip the parent
    PRD, ``fetch_fails=True`` to make ``fetch_issue`` raise, or
    override ``issue_body`` to test specific patterns.
    """
    mock_gh = MagicMock()
    issue = MagicMock(
        title=issue_title,
        body=issue_body,
        comments=[{"body": "c1"}, {"body": "c2"}, {"body": "c3"}],  # 3 comments
        created_at="2026-01-15T00:00:00Z",
    )
    if fetch_fails:
        mock_gh.fetch_issue.side_effect = RuntimeError("simulated network error")
    else:
        # The dispatcher fetches the issue itself, then the parent PRD
        # if the body contains the magic marker.
        def _fetch(num):
            if num == 99 and parent_body is not None:
                return MagicMock(
                    title="Parent PRD",
                    body=parent_body,
                    comments=[],
                    created_at="2025-12-01T00:00:00Z",
                )
            return issue
        mock_gh.fetch_issue.side_effect = _fetch
    return mock_gh


def _scout_output_payload() -> str:
    """Return a synthetic scout ``PHASE_OUTPUT`` block."""
    return (
        "Preamble from the scout.\n\n"
        "### PHASE_OUTPUT: success\n"
        "{\n"
        '  "relevant_files": ["a.py", "b.py"],\n'
        '  "test_command": "pytest",\n'
        '  "patterns": ["uses repository pattern"],\n'
        '  "conventions": ["no default exports"],\n'
        '  "risks": ["session.ts is imported by 12 modules"],\n'
        '  "scanned_at": "2026-06-04T12:34:00Z"\n'
        "}\n"
        "### END_PHASE_OUTPUT\n"
    )


# ─── Test: happy path ────────────────────────────────────────────────────


def test_happy_path_all_fields_populated(tmp_path: Path):
    """When every source succeeds, every FlowContext field is populated."""
    flow_config = _make_synthetic_flow(scout_enabled=True, with_scout_phase=True)
    gh = _make_github_mock(
        issue_body="Please implement.\n\n## Parent\n\n#99",
        parent_body="## Parent PRD body",
    )
    # Build the repo entry the dispatcher's registry lookup should hit.
    repo_entry = {
        "alias": "myrepo",
        "path": str(Path.cwd().resolve()),
        "hash": "abc123",
        "languages": ["python"],
        "test_command": "pytest",
    }

    with patch.object(flow_engine, "load_flow", return_value=flow_config), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg, \
         patch.object(flow_engine, "_run_scout_phase") as mock_scout:
        # Real MemoryStore against the temp dir
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="deadbeef")
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        # Registry has an entry for the current repo
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = repo_entry
        MockReg.return_value = reg_instance
        # Scout returns a parsed dict AND persists it to memory (mirrors
        # the real ``_run_scout_phase`` behaviour). The dispatcher's
        # job is to call the helper and pick up the post-scout state;
        # the helper's job is the persistence.
        expected_findings = {"relevant_files": ["a.py"], "test_command": "pytest"}
        def fake_scout(_flow_config, _issue_num, _context, memory_store):
            memory_store.update_phase("scout", {
                "status": "success",
                "details": "scout succeeded",
                "findings": expected_findings,
            })
            return expected_findings
        mock_scout.side_effect = fake_scout

        flow = _make_flow_value(scout_enabled=True)
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)

    # Every field is populated
    assert fc.issue_num == 42
    assert fc.issue_title == "Implement feature X"
    assert "Please implement" in fc.issue_body
    assert fc.comments_count == 3
    assert fc.created_at == "2026-01-15"
    assert fc.parent_prd is not None
    assert "## Parent PRD body" in fc.parent_prd
    assert isinstance(fc.working_memory, WorkingMemory)
    assert fc.working_memory.git_sha == "deadbeef"
    assert fc.working_memory.repo_path == str(Path.cwd().resolve())
    assert fc.prefetched.git_sha == "deadbeef"
    assert fc.repo_context is not None
    assert fc.repo_context["alias"] == "myrepo"
    assert fc.scout_findings is not None
    assert fc.scout_findings["relevant_files"] == ["a.py"]
    # The dispatcher's post-scout refresh picked up the scout section
    assert fc.working_memory.scout.get("status") == "success"


# ─── Test: missing parent PRD ───────────────────────────────────────────


def test_missing_parent_prd_yields_none(tmp_path: Path):
    """When the issue body has no `## Parent` reference, parent_prd is None."""
    gh = _make_github_mock(
        issue_body="Please implement feature X.\nNo parent reference here.",
        parent_body=None,  # defensive — won't be called
    )

    with patch.object(flow_engine, "load_flow", return_value=_make_synthetic_flow()), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg:
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="abc")
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        # Empty registry → get_by_path returns None
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = None
        MockReg.return_value = reg_instance

        flow = _make_flow_value(scout_enabled=False)
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)

    assert fc.parent_prd is None
    # And the parent fetch was never attempted
    assert all(call.args[0] != 99 for call in gh.fetch_issue.call_args_list)


# ─── Test: corrupt working memory ───────────────────────────────────────


def test_corrupt_working_memory_yields_fresh_view(tmp_path: Path):
    """When the memory file is corrupt, build_flow_context returns a
    fresh empty WorkingMemory instead of raising."""
    # Write a corrupt memory file
    memory_file = tmp_path / "42.memory.json"
    memory_file.write_text("{not valid json at all")

    gh = _make_github_mock(issue_body="No parent here.")

    with patch.object(flow_engine, "load_flow", return_value=_make_synthetic_flow()), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg:
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="abc")
        # Use the REAL MemoryStore (which backs up the corrupt file)
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = None
        MockReg.return_value = reg_instance

        flow = _make_flow_value(scout_enabled=False)
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)

    # The dispatcher returned a usable, fresh WorkingMemory
    assert fc.working_memory is not None
    assert isinstance(fc.working_memory, WorkingMemory)
    assert fc.working_memory.issue == 42
    # The corrupt file was backed up (one *.corrupt.*.json file appeared)
    corrupt_backups = list(tmp_path.glob("42.corrupt.*.json"))
    assert len(corrupt_backups) >= 1
    # A fresh memory file was written with git_sha + repo_path
    fresh = json.loads(memory_file.read_text())
    assert fresh["git_sha"] == "abc"
    assert fresh["repo_path"] == str(Path.cwd().resolve())


# ─── Test: missing projects registry ────────────────────────────────────


def test_missing_projects_registry_yields_none_repo_context(tmp_path: Path):
    """When no projects.json exists, repo_context is None and no exception is raised."""
    # No registry file in tmp_path → ProjectsRegistry.get_by_path returns None
    gh = _make_github_mock(issue_body="No parent here.")

    with patch.object(flow_engine, "load_flow", return_value=_make_synthetic_flow()), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg:
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="abc")
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = None  # no entry for this repo
        MockReg.return_value = reg_instance

        flow = _make_flow_value(scout_enabled=False)
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)

    assert fc.repo_context is None


# ─── Test: scout failure ────────────────────────────────────────────────


def test_scout_failure_yields_none_findings(tmp_path: Path):
    """A failing scout leaves scout_findings as None and lets the flow continue."""
    gh = _make_github_mock(issue_body="No parent here.")

    with patch.object(flow_engine, "load_flow", return_value=_make_synthetic_flow()), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg, \
         patch.object(flow_engine, "_run_scout_phase") as mock_scout:
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="abc")
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = None
        MockReg.return_value = reg_instance
        # Scout returns None (failure)
        mock_scout.return_value = None

        flow = _make_flow_value(scout_enabled=True)
        # No exception should be raised
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)

    assert fc.scout_findings is None
    # Working memory is still populated (the dispatcher kept going)
    assert fc.working_memory is not None
    assert fc.working_memory.issue == 42


# ─── Test: successful scout persists to memory ─────────────────────────


def test_successful_scout_persists_findings_to_memory(tmp_path: Path):
    """A successful scout writes its findings to the memory store on disk.

    The real ``_run_scout_phase`` does the persistence via
    ``memory_store.update_phase``. The test patches the helper to
    simulate that (the helper's own logic is covered by
    ``test_flow_scout.py``).
    """
    gh = _make_github_mock(issue_body="No parent here.")

    with patch.object(flow_engine, "load_flow", return_value=_make_synthetic_flow()), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg, \
         patch.object(flow_engine, "_run_scout_phase") as mock_scout:
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="abc")
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = None
        MockReg.return_value = reg_instance
        # Scout returns a parsed findings dict AND persists it (mirrors
        # the real ``_run_scout_phase`` contract — it persists, then
        # returns the parsed dict).
        expected_findings = {
            "relevant_files": ["a.py", "b.py"],
            "test_command": "pytest",
            "scanned_at": "2026-06-04T00:00:00Z",
        }
        def fake_scout(_flow_config, _issue_num, _context, memory_store):
            memory_store.update_phase("scout", {
                "status": "success",
                "details": "scout succeeded",
                "findings": expected_findings,
            })
            return expected_findings
        mock_scout.side_effect = fake_scout

        flow = _make_flow_value(scout_enabled=True)
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)

    # The FlowContext carries the parsed findings
    assert fc.scout_findings == expected_findings
    # And the helper was called with the dispatcher's memory_store
    args, _kwargs = mock_scout.call_args
    assert args[1] == 42  # issue_num
    assert isinstance(args[3], MemoryStore)  # memory_store

    # The on-disk memory file has the scout section populated
    memory_file = tmp_path / "42.memory.json"
    on_disk = json.loads(memory_file.read_text())
    assert on_disk["scout"]["status"] == "success"
    assert on_disk["scout"]["findings"] == expected_findings
    # And the dispatcher's refresh picked it up
    assert fc.working_memory.scout.get("status") == "success"


# ─── Test: issue metadata fetch failure ─────────────────────────────────


def test_issue_metadata_failure_does_not_raise(tmp_path: Path):
    """When gh.fetch_issue raises, the dispatcher still returns a valid FlowContext."""
    gh = _make_github_mock(fetch_fails=True)

    with patch.object(flow_engine, "load_flow", return_value=_make_synthetic_flow()), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg:
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="abc")
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = None
        MockReg.return_value = reg_instance

        flow = _make_flow_value(scout_enabled=False)
        # No exception
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)

    # Sensible defaults
    assert fc.issue_title == "No title"
    assert fc.issue_body == ""
    assert fc.comments_count == 0
    assert fc.created_at is None
    assert fc.parent_prd is None


# ─── Test: FlowContext is frozen ────────────────────────────────────────


def test_flow_context_returned_is_frozen(tmp_path: Path):
    """The FlowContext returned by build_flow_context is frozen (immutable)."""
    gh = _make_github_mock()

    with patch.object(flow_engine, "load_flow", return_value=_make_synthetic_flow()), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg:
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="abc")
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = None
        MockReg.return_value = reg_instance

        flow = _make_flow_value(scout_enabled=False)
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)

    from dataclasses import FrozenInstanceError
    try:
        fc.issue_num = 99  # type: ignore[misc]
    except FrozenInstanceError:
        return
    raise AssertionError("FlowContext returned by build_flow_context is not frozen")


# ─── Test: scout disabled vs failed (legacy parity) ─────────────────────


def test_scout_disabled_vs_failed_different_outcomes(tmp_path: Path):
    """The legacy dict context distinguishes "scout disabled" (no
    scout_findings_md key) from "scout failed" (scout_findings_md is
    the "no findings" markdown). The dispatcher must communicate that
    distinction so the shim can rebuild the right dict.

    In the typed view, both cases have scout_findings == None, so the
    test asserts the dispatcher's invariants the shim depends on: the
    shim calls ``_scout_enabled(flow_config)`` to decide whether to
    set ``scout_findings_md``. In both cases the FlowContext the
    shim receives has ``scout_findings is None`` — the shim is
    responsible for the legacy reproduction.
    """
    gh = _make_github_mock()

    # Case 1: scout disabled at the flow level
    with patch.object(flow_engine, "load_flow", return_value=_make_synthetic_flow(scout_enabled=False)), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg, \
         patch.object(flow_engine, "_run_scout_phase") as mock_scout:
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="abc")
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = None
        MockReg.return_value = reg_instance
        # Scout must NOT be called
        mock_scout.return_value = {"relevant_files": ["a.py"]}

        flow = _make_flow_value(scout_enabled=False)
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)
    assert fc.scout_findings is None
    mock_scout.assert_not_called()

    # Case 2: scout enabled but fails
    with patch.object(flow_engine, "load_flow", return_value=_make_synthetic_flow(scout_enabled=True)), \
         patch.object(flow_engine, "MemoryStore") as MockStore, \
         patch.object(flow_engine, "prefetch_context") as mock_pref, \
         patch.object(flow_engine, "ProjectsRegistry") as MockReg, \
         patch.object(flow_engine, "_run_scout_phase") as mock_scout:
        from context_prefetch import PrefetchedContext
        mock_pref.return_value = PrefetchedContext(git_sha="abc")
        def factory(issue_num, memory_dir=None):
            return MemoryStore(issue_num, memory_dir=tmp_path)
        MockStore.side_effect = factory
        reg_instance = MagicMock()
        reg_instance.get_by_path.return_value = None
        MockReg.return_value = reg_instance
        # Scout was called, returned None (failure)
        mock_scout.return_value = None

        flow = _make_flow_value(scout_enabled=True)
        fc = flow_dispatcher.build_flow_context(flow, 42, gh)
    assert fc.scout_findings is None
    mock_scout.assert_called_once()


# ─── Custom test runner ────────────────────────────────────────────────


# Collect test functions for both pytest discovery and the custom
# runner. Pytest picks up functions starting with ``test_``; the
# custom runner iterates ``tests`` explicitly.
tests = [
    test_happy_path_all_fields_populated,
    test_missing_parent_prd_yields_none,
    test_corrupt_working_memory_yields_fresh_view,
    test_missing_projects_registry_yields_none_repo_context,
    test_scout_failure_yields_none_findings,
    test_successful_scout_persists_findings_to_memory,
    test_issue_metadata_failure_does_not_raise,
    test_flow_context_returned_is_frozen,
    test_scout_disabled_vs_failed_different_outcomes,
]


if __name__ == "__main__":
    passed = 0
    failed = 0
    for test_fn in tests:
        try:
            test_fn(Path(tempfile.mkdtemp(prefix="flow_dispatcher_test_")))
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
