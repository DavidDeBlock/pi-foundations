#!/usr/bin/env python3
"""
Integration tests for working memory + context prefetch wiring.

These tests exercise the integration boundary between:
  - flow_engine.build_prompt() (variable injection)
  - MemoryStore persistence
  - PrefetchedContext cache + injection

They do NOT mock the LLM. They use fakes for the parts that would
otherwise call out to the world (RPC, GitHub, terminal UI).

Run with: python3 tests/test_integration_working_memory.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
# Add parent for flow_engine
sys.path.insert(0, str(Path(__file__).parent.parent))

from working_memory import MemoryStore, WorkingMemory
from context_prefetch import prefetch_context, format_prefetched_context


# ─── Helpers ─────────────────────────────────────────────────────────────


def _make_tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="maestro_int_test_"))


def _write_minimal_prompt(prompts_dir: Path, name: str) -> None:
    """Write a minimal prompt file that exercises all variable substitutions."""
    prompts_dir.mkdir(parents=True, exist_ok=True)
    (prompts_dir / f"{name}.md").write_text(
        f"""---
name: {name}
description: Test prompt
tools: ['Read']
---

## {name} prompt

issue={{issue_number}}
body={{issue_body}}
prev={{previous_output}}
prd={{prd_body}}
diag={{diagnostic_insights}}
prefetched={{prefetched_context}}
wm={{working_memory_json}}
"""
    )


# ─── Test 1: Memory persists across MemoryStore instances ───────────────


def test_working_memory_persists_across_flow_runs():
    """Simulate two flow runs: the second run should see the first run's state."""
    d = _make_tmpdir()
    try:
        # "Run 1": a builder phase runs, writes to memory
        store1 = MemoryStore(100, memory_dir=d)
        store1.update_phase("builder", {"summary": "implemented", "commit": "abc123"})
        store1.append_file_touched("src/foo.py")
        store1.append_test_result({"name": "test_foo", "status": "passed"})

        # "Run 2": a fresh MemoryStore, same path
        store2 = MemoryStore(100, memory_dir=d)
        mem = store2.load()

        # The reviewer (or whatever) on the next run should see all the state
        assert mem.builder["summary"] == "implemented"
        assert mem.builder["commit"] == "abc123"
        assert "src/foo.py" in mem.files_touched
        assert len(mem.test_results) == 1
        assert mem.test_results[0]["name"] == "test_foo"
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


# ─── Test 2: Memory survives a simulated restart ────────────────────────


def test_working_memory_survives_simulated_restart():
    """Write complex state, then re-load from a completely fresh process path."""
    d = _make_tmpdir()
    try:
        # Simulate "process A" building up state
        s = MemoryStore(200, memory_dir=d)
        s.update_phase("scout", {"findings": ["hot file: a.py"]})
        s.update_phase("builder", {"summary": "implemented", "files_created": ["a.py"]})
        s.append_file_touched("a.py")
        s.append_error("reviewer", "missing type hint on line 5")
        s.append_test_result({"name": "test_a", "status": "passed"})

        # Simulate "process B" coming up cold
        s2 = MemoryStore(200, memory_dir=d)
        mem = s2.load()

        # All state intact
        assert mem.issue == 200
        assert mem.scout["findings"] == ["hot file: a.py"]
        assert mem.builder["summary"] == "implemented"
        assert mem.builder["files_created"] == ["a.py"]
        assert mem.files_touched == ["a.py"]
        assert len(mem.errors) == 1
        assert mem.errors[0]["phase"] == "reviewer"
        assert mem.errors[0]["error"] == "missing type hint on line 5"
        assert mem.errors[0]["timestamp"] != ""
        assert len(mem.test_results) == 1
        assert mem.test_results[0]["name"] == "test_a"
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


# ─── Test 3: Prefetched context appears in the builder prompt ───────────


def test_prefetched_context_injected_into_builder_prompt():
    """build_prompt should inject {prefetched_context} with the prefetched markdown."""
    # Create a temp project so prefetch has something to detect
    project_dir = _make_tmpdir()
    cache_dir = _make_tmpdir()
    try:
        (project_dir / "package.json").write_text(json.dumps({
            "scripts": {"test": "vitest", "build": "tsc", "lint": "eslint ."},
            "dependencies": {"react": "^18"},
        }))
        (project_dir / "tsconfig.json").write_text("{}")

        # Compute prefetched context (with cwd pointing to our fake project)
        original_cwd = Path.cwd()
        try:
            os.chdir(str(project_dir))
            ctx = prefetch_context(project_dir, cache_dir=cache_dir)
        finally:
            os.chdir(str(original_cwd))

        # Now import build_prompt and call it.
        # Per deepening PRD issue #32, build_prompt lives in
        # ``prompt_assembler`` and returns a :class:`PreparedPrompt`
        # value object (not a tuple). It takes typed objects
        # (``PhaseConfig`` / ``Flow`` / ``FlowContext`` / ``PhaseState``)
        # — we construct those directly here (issue #43 deleted the
        # ``_build_*_from_dict`` helpers in ``phase_runner`` that used
        # to do this conversion).
        from prompt_assembler import build_prompt
        from flow_engine import (
            Flow,
            FlowContext,
            PhaseConfig,
            PhaseState,
            _flow_from_config,
        )
        prompts_dir = _make_tmpdir()
        try:
            _write_minimal_prompt(prompts_dir, "builder")

            phase_config = {"skill": "/skill:builder"}
            flow_config = {"phases": {"builder": phase_config}}

            # build_prompt reads templates from a hard-coded prompts
            # directory next to ``prompt_assembler``. The test wrote
            # a minimal ``builder.md`` to a temp dir, so for the
            # duration of this test we swap the on-disk file in and
            # out. The real prompts are preserved by backup.
            import prompt_assembler
            real_prompts_path = prompt_assembler.Path(
                prompt_assembler.__file__
            ).parent / "prompts" / "builder.md"
            test_prompts_path = prompts_dir / "builder.md"
            backup_existed = real_prompts_path.exists()
            backup_path = real_prompts_path.with_suffix(".md.bak")
            from shutil import copy2
            if backup_existed:
                copy2(real_prompts_path, backup_path)
            copy2(test_prompts_path, real_prompts_path)

            # Construct the typed objects directly. The previous
            # ``_build_*_from_dict`` shims in :mod:`phase_runner` used
            # to do this conversion from a legacy ``context`` dict;
            # now callers (including the tests) build the typed
            # objects themselves.
            wm_dict = {
                "issue": 42,
                "builder": {"summary": "previous attempt"},
                "files_touched": ["a.py"],
            }
            try:
                wm = WorkingMemory.from_dict(wm_dict)
            except Exception:
                wm = None

            try:
                flow = _flow_from_config(flow_config)
                pc = PhaseConfig(
                    name="builder",
                    skill="/skill:builder",
                    timeout_seconds=1800,
                    retries=1,
                    is_local=False,
                    is_optional=False,
                    model=None,
                    provider=None,
                    command=None,
                    tools=(),
                )
                fc = FlowContext(
                    flow=flow,
                    issue_num=42,
                    issue_body="Implement the thing.",
                    issue_title="",
                    parent_prd=None,
                    working_memory=wm,
                    prefetched=ctx,
                    repo_context=None,
                    scout_findings=None,
                )
                st = PhaseState(
                    current_phase="builder",
                    phase_attempt=1,
                    previous_output="",
                    diagnostic_insights="",
                    phase_outputs={},
                )
                # extra_context: the dict :func:`build_prompt` reads
                # for the pre-formatted markdown caches (and, for the
                # retrospective phase, retro-specific vars). This
                # test only exercises the prefetched cache, so the
                # other keys are absent.
                ec = {
                    "prefetched_context_md": format_prefetched_context(ctx),
                }
                prepared = build_prompt(
                    phase_name="builder",
                    phase_config=pc,
                    flow=flow,
                    issue_num=42,
                    context=fc,
                    state=st,
                    extra_context=ec,
                )
                prompt = prepared.text
                _tools = list(prepared.tools)
            finally:
                if backup_existed:
                    copy2(backup_path, real_prompts_path)
                    backup_path.unlink()
                else:
                    real_prompts_path.unlink()

            # The {prefetched_context} placeholder should be replaced
            assert "{prefetched_context}" not in prompt, (
                f"{{prefetched_context}} was not substituted in:\n{prompt}"
            )
            assert "## Prefetched Repo Context" in prompt
            assert "vitest" in prompt  # the test command we set
            assert "TypeScript project" in prompt  # tsconfig.json hint

            # {working_memory_json} should also be replaced
            assert "{working_memory_json}" not in prompt
            assert "previous attempt" in prompt
            assert "a.py" in prompt
        finally:
            import shutil
            try:
                shutil.rmtree(prompts_dir)
            except OSError:
                pass
    finally:
        import shutil
        try:
            shutil.rmtree(project_dir)
            shutil.rmtree(cache_dir)
        except OSError:
            pass


# ─── Test 4: Working memory visible to later phase ─────────────────────


def test_working_memory_visible_to_retrospective():
    """A later phase (e.g. retrospective) should be able to read prior phase output."""
    d = _make_tmpdir()
    try:
        # Simulate: builder wrote some state
        s = MemoryStore(300, memory_dir=d)
        s.update_phase("builder", {
            "summary": "implemented",
            "files": ["a.py", "b.py"],
            "commit": "abc123",
        })
        s.append_file_touched("a.py")
        s.append_file_touched("b.py")

        # Simulate: reviewer wrote feedback
        s.update_phase("reviewer", {
            "verdict": "approved",
            "issues_resolved": ["missing type hints"],
        })

        # Now a "retrospective" phase reads the memory
        s2 = MemoryStore(300, memory_dir=d)
        mem = s2.load()

        # Retrospective should be able to ask: what did the builder do?
        assert mem.builder["summary"] == "implemented"
        assert mem.builder["files"] == ["a.py", "b.py"]
        assert mem.builder["commit"] == "abc123"

        # What did the reviewer say?
        assert mem.reviewer["verdict"] == "approved"
        assert mem.reviewer["issues_resolved"] == ["missing type hints"]

        # What files were touched across the whole flow?
        assert mem.files_touched == ["a.py", "b.py"]

        # Round-trip via to_dict should preserve the structure
        d_dict = mem.to_dict()
        assert d_dict["builder"]["commit"] == "abc123"
        assert d_dict["reviewer"]["issues_resolved"] == ["missing type hints"]
    finally:
        import shutil
        try:
            shutil.rmtree(d)
        except OSError:
            pass


# ─── Test runner ─────────────────────────────────────────────────────────


if __name__ == "__main__":
    print("Running working memory + context prefetch integration tests...\n")

    tests = [
        test_working_memory_persists_across_flow_runs,
        test_working_memory_survives_simulated_restart,
        test_prefetched_context_injected_into_builder_prompt,
        test_working_memory_visible_to_retrospective,
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
