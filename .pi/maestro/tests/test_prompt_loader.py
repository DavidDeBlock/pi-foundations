#!/usr/bin/env python3
"""
test_prompt_loader.py — Unit tests for the prompt_loader module.

Verifies:
  - .md files with valid frontmatter parse correctly
  - Malformed frontmatter raises ValueError with a clear message
  - .tmpl files still load (with deprecation warning) for backward compat
  - Non-existent phases fall back to a default + permissive tools
  - Tool precedence: explicit > meta > DEFAULT_TOOLS > PERMISSIVE_FALLBACK
  - Variable placeholders survive the loader untouched (no premature substitution)

Run with: python3 tests/test_prompt_loader.py
"""

import sys
import tempfile
from pathlib import Path

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from prompt_loader import (
    DEFAULT_TOOLS,
    KNOWN_TOOLS,
    PERMISSIVE_FALLBACK,
    load_prompt,
)


def _tmp_prompts_dir() -> Path:
    """Create an empty temp directory for prompt files."""
    return Path(tempfile.mkdtemp(prefix="prompt_loader_test_"))


def _write(path: Path, content: str) -> None:
    """Helper to write content to a file inside a temp prompts dir."""
    path.write_text(content, encoding="utf-8")


# ─── Test 1: .md with valid frontmatter ───────────────────────────────

def test_load_md_with_valid_frontmatter():
    """Loading a .md with valid YAML frontmatter returns parsed meta + body."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "scout.md", """---
name: scout
description: Read-only exploration.
tools: ['Read', 'Bash', 'Glob', 'Grep']
---

# Scout — Read-Only Exploration

Find the relevant files. Use the **find-skills** skill to help locate them.
""")

    loaded = load_prompt(prompts_dir, "scout")

    assert loaded.source_format == "md"
    assert loaded.name == "scout"
    assert loaded.description == "Read-only exploration."
    assert loaded.tools == ["Read", "Bash", "Glob", "Grep"]
    assert loaded.deprecation_warning is None
    assert "Scout — Read-Only Exploration" in loaded.body
    assert "find-skills" in loaded.body
    # Frontmatter should be stripped from the body
    assert not loaded.body.startswith("---")
    assert "name: scout" not in loaded.body


# ─── Test 2: .md with malformed frontmatter raises ─────────────────────

def test_load_md_with_malformed_frontmatter_raises():
    """A .md missing the closing '---' raises ValueError with a clear path."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "reviewer.md", """name: reviewer
description: missing opening and closing fences
tools: ['Read']
""")

    try:
        load_prompt(prompts_dir, "reviewer")
    except ValueError as exc:
        # Error message should include the file path
        assert "reviewer.md" in str(exc)
        assert "---" in str(exc)
    else:
        raise AssertionError("Expected ValueError for malformed frontmatter")


# ─── Test 3: .tmpl returns deprecation warning ─────────────────────────

def test_load_tmpl_returns_deprecation_warning():
    """Loading a .tmpl (no .md sibling) returns source_format='tmpl' and a warning."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "builder.tmpl", "## PHASE: builder\n## ISSUE: {issue_number}\n")

    loaded = load_prompt(prompts_dir, "builder")

    assert loaded.source_format == "tmpl"
    assert loaded.deprecation_warning is not None
    assert "deprecated" in loaded.deprecation_warning
    assert "builder.md" in loaded.deprecation_warning
    # Body should be the raw file content
    assert "{issue_number}" in loaded.body
    # No frontmatter → tools come from DEFAULT_TOOLS (builder has a registered default)
    assert loaded.tools == DEFAULT_TOOLS["builder"]


# ─── Test 4: Non-existent phase returns default ────────────────────────

def test_load_nonexistent_phase_returns_default():
    """Loading a phase with no .md or .tmpl returns the in-memory default."""
    prompts_dir = _tmp_prompts_dir()
    # No files at all

    loaded = load_prompt(prompts_dir, "phantom-phase")

    assert loaded.source_format == "default"
    assert loaded.deprecation_warning is None
    assert loaded.name == "phantom-phase"
    # phantom-phase has no DEFAULT_TOOLS entry → permissive fallback
    assert loaded.tools == PERMISSIVE_FALLBACK
    # Body is the default stub
    assert "phantom-phase" in loaded.body
    assert "[default prompt" in loaded.body


# ─── Test 5: explicit_tools override beats frontmatter ────────────────

def test_explicit_tools_override_beats_frontmatter():
    """When explicit_tools is passed, it overrides the frontmatter's tools list."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "reviewer.md", """---
name: reviewer
tools: ['Read', 'Bash', 'Grep', 'Glob']
---

Reviewer body.
""")

    loaded = load_prompt(
        prompts_dir, "reviewer", explicit_tools=["Read", "Write"]
    )

    assert loaded.tools == ["Read", "Write"]
    # Frontmatter is parsed, but tools is overridden
    assert loaded.source_format == "md"


# ─── Test 6: frontmatter tools beat phase default ─────────────────────

def test_frontmatter_tools_beats_phase_default():
    """When frontmatter declares tools, it wins over DEFAULT_TOOLS[phase_name]."""
    prompts_dir = _tmp_prompts_dir()
    # builder's default is full tool set, but we restrict it via frontmatter
    _write(prompts_dir / "builder.md", """---
name: builder
tools: ['Read', 'Edit']
---

Builder body.
""")

    loaded = load_prompt(prompts_dir, "builder")  # no explicit_tools

    assert loaded.tools == ["Read", "Edit"]
    # Would have been DEFAULT_TOOLS['builder'] without the frontmatter override


# ─── Test 7: phase default beats permissive fallback ──────────────────

def test_phase_default_beats_permissive_fallback():
    """For phases with DEFAULT_TOOLS entries, .tmpl falls back to phase default (not permissive)."""
    prompts_dir = _tmp_prompts_dir()
    # reviewer.tmpl only, no .md. The default tools for reviewer must win over PERMISSIVE_FALLBACK.
    _write(prompts_dir / "reviewer.tmpl", "Reviewer body.\n")

    loaded = load_prompt(prompts_dir, "reviewer")  # no explicit_tools

    assert loaded.source_format == "tmpl"
    assert loaded.tools == DEFAULT_TOOLS["reviewer"]
    # And specifically: not the permissive fallback
    assert loaded.tools != PERMISSIVE_FALLBACK
    assert "Edit" not in loaded.tools  # reviewer must NOT have Edit
    assert "Write" not in loaded.tools  # reviewer must NOT have Write


# ─── Test 8: body variable substitution preserved ─────────────────────

def test_body_variable_substitution_preserved():
    """The loader must not substitute {variable} placeholders; that's flow_engine's job."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "test_runner.md", """---
name: test_runner
tools: ['Read', 'Bash']
---

## PHASE: test_runner
## ISSUE: {issue_number}

Previous output: {previous_output}
""")

    loaded = load_prompt(prompts_dir, "test_runner")

    # Placeholders must survive untouched in the body
    assert "{issue_number}" in loaded.body
    assert "{previous_output}" in loaded.body
    # Loader does not have access to context, so it cannot substitute
    assert "42" not in loaded.body
    assert "test passed" not in loaded.body


# ─── Test runner ───────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Running prompt_loader unit tests...\n")
    print("=" * 60)

    tests = [
        ("load .md with valid frontmatter", test_load_md_with_valid_frontmatter),
        ("load .md with malformed frontmatter raises", test_load_md_with_malformed_frontmatter_raises),
        ("load .tmpl returns deprecation warning", test_load_tmpl_returns_deprecation_warning),
        ("load non-existent phase returns default", test_load_nonexistent_phase_returns_default),
        ("explicit_tools override beats frontmatter", test_explicit_tools_override_beats_frontmatter),
        ("frontmatter tools beat phase default", test_frontmatter_tools_beats_phase_default),
        ("phase default beats permissive fallback", test_phase_default_beats_permissive_fallback),
        ("body variable substitution preserved", test_body_variable_substitution_preserved),
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
    print(f"\n📊 Summary: {passed}/{passed + failed} tests passed")

    if failed > 0:
        print("❌ FAILURES — see above\n")
        sys.exit(1)
    else:
        print("✅ ALL PROMPT LOADER TESTS PASSED\n")
