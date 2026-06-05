#!/usr/bin/env python3
"""
Unit tests for wave1-dod-check.py — Wave 1 DoD static verification script.

Covers:
- YAML frontmatter parsing
- All 11 prompt migration check
- prompt_loader existence / LoadedPrompt dataclass
- build_prompt() returns tuple check
- run_phase passes tools check
- rpc_client accepts and forwards tools check
- flows/builder-reviewer.json structure check
- Read-only tool enforcement (scout, reviewer)
- Builder full tool set check
- prompt_loader precedence chain check

Run with: python3 -m pytest tests/test_wave1_dod_check.py
"""

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

import pytest

# Add scripts/ to path so we can import the script module.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))


def _load_script(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


wdc = _load_script("wave1-dod-check")


# ─── _parse_frontmatter ──────────────────────────────────────────────


class TestParseFrontmatter:
    def test_basic_key_values(self):
        text = "---\nname: scout\ndescription: Read-only\ntools: ['Read', 'Bash']\n---\n\nbody"
        fm = wdc._parse_frontmatter(text)
        assert fm["name"] == "scout"
        assert fm["description"] == "Read-only"
        assert fm["tools"] == ["Read", "Bash"]

    def test_double_quoted_values(self):
        text = '---\nname: "scout"\ndescription: "Read-only"\n---\nbody'
        fm = wdc._parse_frontmatter(text)
        assert fm["name"] == "scout"
        assert fm["description"] == "Read-only"

    def test_no_frontmatter(self):
        text = "just a body, no frontmatter"
        fm = wdc._parse_frontmatter(text)
        assert fm == {}

    def test_skips_comments(self):
        text = "---\n# this is a comment\nname: scout\n---\nbody"
        fm = wdc._parse_frontmatter(text)
        assert fm.get("name") == "scout"
        # The comment key shouldn't leak through.


# ─── check_all_prompts_migrated ──────────────────────────────────────


class TestAllPromptsMigrated:
    def test_all_present(self, tmp_path, monkeypatch):
        # Create fake prompts dir with all 11 valid .md files.
        prompts = tmp_path / "prompts"
        prompts.mkdir()
        for name in wdc.EXPECTED_PROMPTS:
            (prompts / f"{name}.md").write_text(
                "---\nname: x\ndescription: x\ntools: ['Read']\n---\nbody\n",
                encoding="utf-8",
            )
        monkeypatch.setattr(wdc, "PROMPTS_DIR", prompts)

        report = wdc.DodReport()
        wdc.check_all_prompts_migrated(report)
        assert report.results[0].status == "PASS"

    def test_missing_prompt(self, tmp_path, monkeypatch):
        prompts = tmp_path / "prompts"
        prompts.mkdir()
        # Only 10 of 11
        for name in wdc.EXPECTED_PROMPTS[:10]:
            (prompts / f"{name}.md").write_text(
                "---\nname: x\ntools: ['Read']\n---\n", encoding="utf-8"
            )
        monkeypatch.setattr(wdc, "PROMPTS_DIR", prompts)

        report = wdc.DodReport()
        wdc.check_all_prompts_migrated(report)
        assert report.results[0].status == "FAIL"
        assert "scout" in report.results[0].notes or "scout" not in wdc.EXPECTED_PROMPTS[:10]

    def test_no_frontmatter(self, tmp_path, monkeypatch):
        prompts = tmp_path / "prompts"
        prompts.mkdir()
        for name in wdc.EXPECTED_PROMPTS:
            (prompts / f"{name}.md").write_text("just a body, no frontmatter", encoding="utf-8")
        monkeypatch.setattr(wdc, "PROMPTS_DIR", prompts)

        report = wdc.DodReport()
        wdc.check_all_prompts_migrated(report)
        assert report.results[0].status == "FAIL"
        assert "No frontmatter" in report.results[0].notes


# ─── check_scout_readonly_tools ──────────────────────────────────────


class TestScoutReadOnlyTools:
    def test_readonly_passes(self, tmp_path, monkeypatch):
        prompts = tmp_path / "prompts"
        prompts.mkdir()
        (prompts / "scout.md").write_text(
            "---\nname: scout\ntools: ['Read', 'Bash', 'Grep', 'Glob']\n---\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(wdc, "PROMPTS_DIR", prompts)

        report = wdc.DodReport()
        wdc.check_scout_readonly_tools(report)
        assert report.results[0].status == "PASS"

    def test_write_forbidden(self, tmp_path, monkeypatch):
        prompts = tmp_path / "prompts"
        prompts.mkdir()
        (prompts / "scout.md").write_text(
            "---\nname: scout\ntools: ['Read', 'Write']\n---\n", encoding="utf-8"
        )
        monkeypatch.setattr(wdc, "PROMPTS_DIR", prompts)

        report = wdc.DodReport()
        wdc.check_scout_readonly_tools(report)
        assert report.results[0].status == "FAIL"


# ─── check_reviewer_readonly_tools ──────────────────────────────────


class TestReviewerReadOnlyTools:
    def test_readonly_passes(self, tmp_path, monkeypatch):
        prompts = tmp_path / "prompts"
        prompts.mkdir()
        (prompts / "reviewer.md").write_text(
            "---\nname: reviewer\ntools: ['Read', 'Bash', 'Grep', 'Glob']\n---\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(wdc, "PROMPTS_DIR", prompts)

        report = wdc.DodReport()
        wdc.check_reviewer_readonly_tools(report)
        assert report.results[0].status == "PASS"

    def test_edit_forbidden(self, tmp_path, monkeypatch):
        prompts = tmp_path / "prompts"
        prompts.mkdir()
        (prompts / "reviewer.md").write_text(
            "---\nname: reviewer\ntools: ['Read', 'Edit']\n---\n", encoding="utf-8"
        )
        monkeypatch.setattr(wdc, "PROMPTS_DIR", prompts)

        report = wdc.DodReport()
        wdc.check_reviewer_readonly_tools(report)
        assert report.results[0].status == "FAIL"


# ─── check_builder_full_tools ────────────────────────────────────────


class TestBuilderFullTools:
    def test_full_set_passes(self, tmp_path, monkeypatch):
        prompts = tmp_path / "prompts"
        prompts.mkdir()
        (prompts / "builder.md").write_text(
            "---\nname: builder\ntools: ['Read', 'Edit', 'Write', 'Bash']\n---\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(wdc, "PROMPTS_DIR", prompts)

        report = wdc.DodReport()
        wdc.check_builder_full_tools(report)
        assert report.results[0].status == "PASS"

    def test_missing_write(self, tmp_path, monkeypatch):
        prompts = tmp_path / "prompts"
        prompts.mkdir()
        (prompts / "builder.md").write_text(
            "---\nname: builder\ntools: ['Read', 'Edit']\n---\n", encoding="utf-8"
        )
        monkeypatch.setattr(wdc, "PROMPTS_DIR", prompts)

        report = wdc.DodReport()
        wdc.check_builder_full_tools(report)
        assert report.results[0].status == "FAIL"


# ─── check_builder_reviewer_flow ─────────────────────────────────────


class TestBuilderReviewerFlow:
    def test_complete_flow_passes(self, tmp_path, monkeypatch):
        flows = tmp_path / "flows"
        flows.mkdir()
        (flows / "builder-reviewer.json").write_text(
            json.dumps(
                {
                    "phases": {"scout": {}, "builder": {}, "reviewer": {}},
                    "scout_enabled": True,
                }
            ),
            encoding="utf-8",
        )
        monkeypatch.setattr(wdc, "FLOWS_DIR", flows)

        report = wdc.DodReport()
        wdc.check_builder_reviewer_flow(report)
        assert report.results[0].status == "PASS"

    def test_scout_disabled(self, tmp_path, monkeypatch):
        flows = tmp_path / "flows"
        flows.mkdir()
        (flows / "builder-reviewer.json").write_text(
            json.dumps(
                {
                    "phases": {"scout": {}, "builder": {}, "reviewer": {}},
                    "scout_enabled": False,
                }
            ),
            encoding="utf-8",
        )
        monkeypatch.setattr(wdc, "FLOWS_DIR", flows)

        report = wdc.DodReport()
        wdc.check_builder_reviewer_flow(report)
        assert report.results[0].status == "FAIL"


# ─── DodReport aggregation ───────────────────────────────────────────


class TestDodReport:
    def test_passes(self):
        report = wdc.DodReport()
        report.add_check("a", True)
        report.add_check("b", True)
        assert report.passed == 2
        assert report.failed == 0
        assert report.all_pass is True

    def test_fails(self):
        report = wdc.DodReport()
        report.add_check("a", True)
        report.add_check("b", False)
        assert report.passed == 1
        assert report.failed == 1
        assert report.all_pass is False

    def test_warn(self):
        report = wdc.DodReport()
        report.add_check("a", True)
        report.add_check("b", False, warn=True)
        # Warnings don't count as failures.
        assert report.warned == 1
        assert report.failed == 0
        assert report.all_pass is True


# ─── Smoke test: run the full checker against the real repo ─────────


class TestSmokeAgainstRealRepo:
    """End-to-end: the script must run on the real .pi/maestro tree and pass."""

    def test_runs_against_real_repo(self):
        # Re-import the real modules from the live tree.
        report = wdc.DodReport()
        wdc.check_all_prompts_migrated(report)
        wdc.check_prompt_loader_exists(report)
        wdc.check_build_prompt_returns_tuple(report)
        wdc.check_run_phase_passes_tools(report)
        wdc.check_rpc_client_accepts_tools(report)
        wdc.check_builder_reviewer_flow(report)
        wdc.check_scout_readonly_tools(report)
        wdc.check_reviewer_readonly_tools(report)
        wdc.check_builder_full_tools(report)
        wdc.check_builder_injects_scout_findings(report)
        wdc.check_working_memory_path(report)
        wdc.check_prompt_loader_precedence(report)
        # Skip the pytest check (subprocess) for unit-test speed.

        failing = [r for r in report.results if r.status == "FAIL"]
        assert not failing, (
            f"Real-repo static checks failed:\n"
            + "\n".join(f"  - {r.name}: {r.notes}" for r in failing)
        )
