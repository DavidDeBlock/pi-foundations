#!/usr/bin/env python3
"""
test_prompt_assembler.py — Unit tests for the prompt_assembler module.

Verifies the deepening PRD issue #32 contract:

- :class:`PreparedPrompt` is a frozen dataclass with the five
  required fields (``text``, ``tools``, ``model_override``,
  ``provider_override``, ``template_loaded``).
- :func:`build_prompt` returns a :class:`PreparedPrompt` (not a
  loose tuple).
- Variable substitution covers all the expected placeholders
  (``{issue_number}``, ``{issue_body}``, ``{prd_body}``,
  ``{previous_output}``, ``{diagnostic_insights}``,
  ``{working_memory_json}``, ``{prefetched_context}``,
  ``{repo_context}``, ``{scout_findings}``).
- The tool allowlist comes from the prompt's frontmatter
  (the existing prompt_loader contract).
- A missing template falls back to the in-memory default, and
  ``PreparedPrompt.template_loaded`` is False.
- ``SKILL TO USE:`` is appended for non-local phases.
- ``LOCAL COMMAND TO RUN:`` is appended for local phases.

The tests stub the on-disk prompts directory with a temp dir
so they run without depending on the live ``prompts/`` tree.

Run with: ``python3 tests/test_prompt_assembler.py``
       or: ``python3 -m pytest tests/test_prompt_assembler.py``
"""

import json
import sys
import tempfile
from dataclasses import FrozenInstanceError, fields, is_dataclass
from pathlib import Path
from typing import Optional

# Add lib + parent dir to path so we can import prompt_assembler
TEST_DIR = Path(__file__).parent
MAESTRO_DIR = TEST_DIR.parent
sys.path.insert(0, str(MAESTRO_DIR / "lib"))
sys.path.insert(0, str(MAESTRO_DIR))

import prompt_assembler  # noqa: E402
from prompt_assembler import PreparedPrompt, build_prompt  # noqa: E402
from flow_engine import (  # noqa: E402
    Flow,
    FlowContext,
    PhaseConfig,
    PhaseState,
)
from flow_logger import ListLogger  # noqa: E402
from working_memory import WorkingMemory  # noqa: E402


# ─── Shared fixtures ────────────────────────────────────────────────────


def _tmp_prompts_dir() -> Path:
    """Create an empty temp directory for prompt files."""
    return Path(tempfile.mkdtemp(prefix="prompt_assembler_test_"))


def _write(path: Path, content: str) -> None:
    """Helper to write content to a file inside a temp prompts dir."""
    path.write_text(content, encoding="utf-8")


def _make_flow() -> Flow:
    """Minimal :class:`Flow` value object for the tests."""
    return Flow(
        name="test-flow",
        description="",
        scout_enabled=False,
        evidence_policy={},
        phases={"builder": {}},
        transitions=(),
    )


def _make_phase_config(
    *,
    skill: str = "/skill:builder",
    is_local: bool = False,
    command: Optional[str] = None,
    tools: tuple = (),
) -> PhaseConfig:
    """Build a :class:`PhaseConfig` value object for the tests."""
    return PhaseConfig(
        name="builder",
        skill=skill,
        timeout_seconds=1800,
        retries=1,
        is_local=is_local,
        is_optional=False,
        model=None,
        provider=None,
        command=command,
        tools=tools,
    )


def _make_flow_context(
    flow: Flow,
    *,
    issue_num: int = 42,
    issue_body: str = "## Issue #42\n\nDo the thing.",
    parent_prd: Optional[str] = None,
    working_memory: Optional[WorkingMemory] = None,
    prefetched=None,
    repo_context: Optional[dict] = None,
) -> FlowContext:
    """Build a :class:`FlowContext` value object for the tests."""
    return FlowContext(
        flow=flow,
        issue_num=issue_num,
        issue_body=issue_body,
        issue_title="",
        parent_prd=parent_prd,
        working_memory=working_memory or WorkingMemory(
            issue=issue_num, created_at="2026-06-15T00:00:00Z"
        ),
        prefetched=prefetched,
        repo_context=repo_context,
        scout_findings=None,
    )


def _make_phase_state(
    *, previous_output: str = "", diagnostic_insights: str = "",
) -> PhaseState:
    """Build a :class:`PhaseState` value object for the tests."""
    return PhaseState(
        current_phase="builder",
        phase_attempt=1,
        previous_output=previous_output,
        diagnostic_insights=diagnostic_insights,
        phase_outputs={},
    )


def _builder_prompt_md(tools: list[str]) -> str:
    """Minimal valid ``builder.md`` with frontmatter + placeholders."""
    return (
        "---\n"
        "name: builder\n"
        "description: Test builder prompt.\n"
        f"tools: {json.dumps(tools)}\n"
        "---\n\n"
        "## PHASE: builder\n"
        "## ISSUE: {issue_number}\n\n"
        "{issue_body}\n"
        "{prd_body}\n"
        "{previous_output}\n"
        "{diagnostic_insights}\n"
        "{prefetched_context}\n"
        "{scout_findings}\n"
        "{repo_context}\n"
        "{working_memory_json}\n"
    )


class _PromptsDirSwap:
    """Context manager that swaps the on-disk prompts dir for a temp one.

    The :func:`build_prompt` function reads ``prompts/<phase>.md``
    from a hard-coded path next to the module. The tests need
    control over what those files contain, so this manager
    copies the test's prompt files into the real location for
    the duration of the test, then restores the originals.
    """

    def __init__(self, prompts_dir: Path) -> None:
        self.prompts_dir = prompts_dir
        self.real_dir = prompt_assembler.Path(prompt_assembler.__file__).parent / "prompts"
        self._backups: dict[str, Path] = {}

    def __enter__(self) -> "_PromptsDirSwap":
        for src in self.prompts_dir.iterdir():
            if not src.is_file():
                continue
            dst = self.real_dir / src.name
            backup = self.real_dir / f"{src.name}.bak"
            if dst.exists():
                dst.replace(backup)
                self._backups[src.name] = backup
            src.replace(dst)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        # Restore: move the test's files back out, put originals back.
        for name, backup in self._backups.items():
            test_path = self.real_dir / name
            if test_path.exists():
                test_path.replace(self.prompts_dir / name)
            backup.replace(self.real_dir / name)
        # Clean up any test file we put down that has no backup
        for src in list(self.prompts_dir.iterdir()):
            if not src.is_file():
                continue
            dst = self.real_dir / src.name
            if dst.exists() and src.name not in self._backups:
                dst.replace(src)


# ─── Test 1: PreparedPrompt is a frozen dataclass with 5 fields ─────


def test_prepared_prompt_is_frozen_dataclass_with_required_fields():
    """PreparedPrompt is a @dataclass(frozen=True) with the 5 required fields."""
    assert is_dataclass(PreparedPrompt), "PreparedPrompt must be a dataclass"

    field_names = {f.name for f in fields(PreparedPrompt)}
    expected = {
        "text", "tools", "model_override", "provider_override", "template_loaded",
    }
    assert field_names == expected, (
        f"PreparedPrompt fields {field_names} != expected {expected}"
    )

    # Mutation must raise — frozen dataclass.
    pp = PreparedPrompt(
        text="hi",
        tools=("Read",),
        model_override=None,
        provider_override=None,
        template_loaded=True,
    )
    try:
        pp.text = "changed"  # type: ignore[misc]
    except FrozenInstanceError:
        pass
    else:
        raise AssertionError("Expected FrozenInstanceError when mutating PreparedPrompt")


# ─── Test 2: Variable substitution works for all expected placeholders ─


def test_variable_substitution_covers_all_placeholders():
    """build_prompt substitutes every expected {placeholder} in the body."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "builder.md", _builder_prompt_md(["Read", "Edit"]))

    flow = _make_flow()
    flow_context = _make_flow_context(
        flow,
        issue_num=99,
        issue_body="## Issue #99\n\nImplement X.",
        parent_prd="## Parent PRD\n\nBackground for X.",
        repo_context={"alias": "pi-foundations"},
    )
    state = _make_phase_state(
        previous_output="builder said: approved",
        diagnostic_insights="diag-1: no obvious bugs",
    )

    with _PromptsDirSwap(prompts_dir):
        prepared = build_prompt(
            phase_name="builder",
            phase_config=_make_phase_config(skill="/skill:builder"),
            flow=flow,
            issue_num=99,
            context=flow_context,
            state=state,
            log=ListLogger(),
            extra_context={
                "prefetched_context_md": "## Prefetched\nTypeScript project",
            },
        )

    # The render produced a string and substituted every variable.
    text = prepared.text
    assert "{issue_number}" not in text
    assert "{issue_body}" not in text
    assert "{prd_body}" not in text
    assert "{previous_output}" not in text
    assert "{diagnostic_insights}" not in text
    assert "{prefetched_context}" not in text
    assert "{scout_findings}" not in text
    assert "{repo_context}" not in text
    assert "{working_memory_json}" not in text

    # And the substituted values are present.
    assert "99" in text  # issue_number
    assert "Implement X" in text  # issue_body
    assert "Background for X" in text  # prd_body
    assert "builder said: approved" in text  # previous_output
    assert "diag-1" in text  # diagnostic_insights
    assert "TypeScript project" in text  # prefetched_context (from extra_context)
    assert "Scout disabled" in text  # scout_findings (default fallback)
    assert "pi-foundations" in text  # repo_context
    # working_memory_json is JSON-encoded; the issue number is in there
    assert '"issue": 99' in text


# ─── Test 3: Tool allowlist is extracted from frontmatter ───────────


def test_tool_allowlist_extracted_from_frontmatter():
    """build_prompt's PreparedPrompt.tools mirrors the frontmatter tools list."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "builder.md", _builder_prompt_md(["Read", "Edit", "Write", "Bash"]))

    flow = _make_flow()
    flow_context = _make_flow_context(flow)

    with _PromptsDirSwap(prompts_dir):
        prepared = build_prompt(
            phase_name="builder",
            phase_config=_make_phase_config(skill="/skill:builder"),
            flow=flow,
            issue_num=42,
            context=flow_context,
            state=_make_phase_state(),
            log=ListLogger(),
        )

    assert prepared.tools == ("Read", "Edit", "Write", "Bash")


# ─── Test 4: Missing template → default + template_loaded=False ─────


def test_missing_template_falls_back_to_default():
    """No .md on disk → PreparedPrompt.template_loaded is False; tools = PERMISSIVE_FALLBACK."""
    prompts_dir = _tmp_prompts_dir()
    # Do NOT create builder.md in the temp dir.
    # But the swap is a no-op (nothing to move), so the real
    # prompts/builder.md will be present — and we'd hit the
    # real template. To test the missing-template case, we need
    # a phase name that has NO on-disk template anywhere.

    flow = _make_flow()
    flow_context = _make_flow_context(flow)

    # Use a phase name that is not in the real prompts/ dir.
    with _PromptsDirSwap(prompts_dir):
        prepared = build_prompt(
            phase_name="definitely_not_a_real_phase",
            phase_config=_make_phase_config(skill="/skill:nonexistent"),
            flow=flow,
            issue_num=42,
            context=flow_context,
            state=_make_phase_state(),
            log=ListLogger(),
        )

    assert prepared.template_loaded is False
    # PERMISSIVE_FALLBACK is the most-permissive set when no other
    # source declares tools. ``PreparedPrompt.tools`` is a tuple.
    from prompt_loader import PERMISSIVE_FALLBACK
    assert set(prepared.tools) == set(PERMISSIVE_FALLBACK)
    # And the body is the in-memory default — contains "[default prompt"
    assert "default prompt" in prepared.text.lower()


# ─── Test 5: SKILL TO USE directive for non-local phases ────────────


def test_skill_directive_appended_for_non_local_phase():
    """Non-local phase with a skill → text ends with **SKILL TO USE:** `<skill>`."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "builder.md", _builder_prompt_md(["Read"]))

    flow = _make_flow()
    flow_context = _make_flow_context(flow)

    with _PromptsDirSwap(prompts_dir):
        prepared = build_prompt(
            phase_name="builder",
            phase_config=_make_phase_config(
                skill="/skill:builder", is_local=False,
            ),
            flow=flow,
            issue_num=42,
            context=flow_context,
            state=_make_phase_state(),
            log=ListLogger(),
        )

    assert "**SKILL TO USE:** `/skill:builder`" in prepared.text
    assert "LOCAL COMMAND TO RUN" not in prepared.text


# ─── Test 6: LOCAL COMMAND TO RUN directive for local phases ─────────


def test_local_command_directive_appended_for_local_phase():
    """Local phase with a command → text ends with **LOCAL COMMAND TO RUN:** `<cmd>`."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "close.md", _builder_prompt_md([]).replace(
        "name: builder", "name: close"
    ))

    flow = _make_flow()
    flow_context = _make_flow_context(flow)

    with _PromptsDirSwap(prompts_dir):
        prepared = build_prompt(
            phase_name="close",
            phase_config=_make_phase_config(
                skill="", is_local=True, command="echo done", tools=(),
            ),
            flow=flow,
            issue_num=42,
            context=flow_context,
            state=_make_phase_state(),
            log=ListLogger(),
        )

    assert "**LOCAL COMMAND TO RUN:** `echo done`" in prepared.text
    assert "**SKILL TO USE:**" not in prepared.text


# ─── Test 7: model_override / provider_override flow through ──────


def test_model_and_provider_overrides_flow_through():
    """build_prompt copies phase_config.model / .provider into PreparedPrompt."""
    prompts_dir = _tmp_prompts_dir()
    _write(prompts_dir / "builder.md", _builder_prompt_md(["Read"]))

    flow = _make_flow()
    flow_context = _make_flow_context(flow)

    with _PromptsDirSwap(prompts_dir):
        prepared = build_prompt(
            phase_name="builder",
            phase_config=PhaseConfig(
                name="builder",
                skill="/skill:builder",
                timeout_seconds=1800,
                retries=1,
                is_local=False,
                is_optional=False,
                model="opus-4",
                provider="anthropic",
                command=None,
                tools=("Read",),
            ),
            flow=flow,
            issue_num=42,
            context=flow_context,
            state=_make_phase_state(),
            log=ListLogger(),
        )

    assert prepared.model_override == "opus-4"
    assert prepared.provider_override == "anthropic"


# ─── Test runner ────────────────────────────────────────────────────────


if __name__ == "__main__":
    print("Running prompt_assembler unit tests...\n")
    print("=" * 60)

    tests = [
        ("PreparedPrompt is a frozen dataclass with 5 fields",
         test_prepared_prompt_is_frozen_dataclass_with_required_fields),
        ("Variable substitution covers all expected placeholders",
         test_variable_substitution_covers_all_placeholders),
        ("Tool allowlist extracted from frontmatter",
         test_tool_allowlist_extracted_from_frontmatter),
        ("Missing template falls back to default + template_loaded=False",
         test_missing_template_falls_back_to_default),
        ("SKILL TO USE directive appended for non-local phase",
         test_skill_directive_appended_for_non_local_phase),
        ("LOCAL COMMAND TO RUN directive appended for local phase",
         test_local_command_directive_appended_for_local_phase),
        ("model/provider overrides flow through to PreparedPrompt",
         test_model_and_provider_overrides_flow_through),
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
        print("✅ ALL PROMPT_ASSEMBLER TESTS PASSED\n")
