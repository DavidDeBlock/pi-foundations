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

        # Now import build_prompt and call it
        from flow_engine import build_prompt
        prompts_dir = _make_tmpdir()
        try:
            _write_minimal_prompt(prompts_dir, "builder")

            phase_config = {"skill": "/skill:builder"}
            flow_config = {"phases": {"builder": phase_config}}

            context = {
                "prompt": "## Issue #42\n\nImplement the thing.",
                "prefetched_context_md": format_prefetched_context(ctx),
                "working_memory": {
                    "issue": 42,
                    "builder": {"summary": "previous attempt"},
                    "files_touched": ["a.py"],
                },
            }

            prompt, _tools = build_prompt(
                phase_name="builder",
                phase_config=phase_config,
                flow_config=flow_config,
                issue_num=42,
                context=context,
            )

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
