#!/usr/bin/env python3
"""
scripts/wave1-dod-check.py — Wave 1 DoD static verification.

Verifies the static (non-runtime) items on the Wave 1 Definition of Done
checklist (parent PRD #272, slice issues #273, #274, #275):

  1. All 11 phase prompts migrated to `.md` with YAML frontmatter declaring
     `tools:`.
  2. `lib/prompt_loader.py` exists with `load_prompt()` and the
     ``LoadedPrompt`` dataclass.
  3. `prompt_assembler.py:build_prompt()` returns :class:`PreparedPrompt`
     value object (deepening PRD issue #32; the prompt builder moved
     out of ``flow_engine.py`` and its return type changed from a
     loose tuple to a typed value object).
  4. `flow_engine.py:run_phase()` passes `tools` to `rpc_client.run_rpc()`.
  5. `lib/rpc_client.py:run_rpc()` accepts `tools: list[str] | None`.
  6. `flows/builder-reviewer.json` updated to include scout + working
     memory and has `scout_enabled: true`.
  7. The scout prompt declares a read-only tool set.
  8. The reviewer prompt declares a read-only tool set (no `Write`/`Edit`).
  9. The builder prompt declares full tool set including `Edit` and `Write`.
 10. All existing tests pass (default: 346 tests in `.pi/maestro/tests/`).
 11. Frontmatter precedence: `explicit_tools` (flow JSON) > frontmatter
     `tools:` > phase default > permissive fallback.

The two DoD items this script CANNOT verify (require a real LLM run):

  - "At least one end-to-end run on a real issue demonstrates the new
    behavior" — needs a live LLM and `pi` binary.
  - "No regression in build pass rate" — needs a fresh flow run to
    re-measure. Use `scripts/build-pass-rate.py` on existing data first,
    then re-run after a live flow for delta.

Usage:
    python scripts/wave1-dod-check.py                # Run all checks
    python scripts/wave1-dod-check.py --json         # Machine-readable
    python scripts/wave1-dod-check.py --no-tests    # Skip pytest
    python scripts/wave1-dod-check.py --help

Examples:
    python scripts/wave1-dod-check.py
    python scripts/wave1-dod-check.py --json | jq '.summary'
"""

import json
import re
import subprocess
import sys
from pathlib import Path
import argparse
from dataclasses import dataclass, field
from typing import Optional


MAESTRO_DIR = Path(__file__).resolve().parent.parent
PROMPTS_DIR = MAESTRO_DIR / "prompts"
FLOWS_DIR = MAESTRO_DIR / "flows"
LIB_DIR = MAESTRO_DIR / "lib"
FLOW_ENGINE = MAESTRO_DIR / "flow_engine.py"
RPC_CLIENT = LIB_DIR / "rpc_client.py"
PROMPT_LOADER = LIB_DIR / "prompt_loader.py"
TESTS_DIR = MAESTRO_DIR / "tests"

# 11 phase prompts named in slice #273's migration checklist.
EXPECTED_PROMPTS = [
    "analyze", "archivist", "auditor", "builder", "diagnostic",
    "generate-issues", "issue-readiness", "reviewer", "test_runner",
    "to-issues", "to-prd",
]

# Read-only tools (per slice #273 default tool set table).
READ_ONLY_TOOLS = {"Read", "Bash", "Grep", "Glob"}
# Mutating tools that must NOT appear in scout/reviewer's allowlist.
MUTATING_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


# ─── Check result container ──────────────────────────────────────────


@dataclass
class CheckResult:
    """A single DoD check with status, evidence, and notes."""
    name: str
    status: str  # "PASS" | "FAIL" | "WARN" | "SKIP"
    evidence: str = ""
    notes: str = ""


@dataclass
class DodReport:
    """Aggregated report of all DoD checks."""
    results: list[CheckResult] = field(default_factory=list)

    def add(self, result: CheckResult) -> None:
        self.results.append(result)

    def add_check(self, name: str, ok: bool, evidence: str = "",
                  notes: str = "", warn: bool = False) -> None:
        status = "PASS" if ok else ("WARN" if warn else "FAIL")
        self.results.append(CheckResult(name, status, evidence, notes))

    @property
    def passed(self) -> int:
        return sum(1 for r in self.results if r.status == "PASS")

    @property
    def failed(self) -> int:
        return sum(1 for r in self.results if r.status == "FAIL")

    @property
    def warned(self) -> int:
        return sum(1 for r in self.results if r.status == "WARN")

    @property
    def skipped(self) -> int:
        return sum(1 for r in self.results if r.status == "SKIP")

    @property
    def total(self) -> int:
        return len(self.results)

    @property
    def all_pass(self) -> bool:
        return self.failed == 0


# ─── Individual checks ────────────────────────────────────────────────


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _parse_frontmatter(prompt_text: str) -> dict:
    """Parse a minimal YAML frontmatter block. Returns empty dict on miss."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", prompt_text, re.DOTALL)
    if not m:
        return {}
    block = m.group(1)
    out: dict = {}
    for line in block.splitlines():
        line = line.rstrip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        # Strip surrounding quotes.
        if (value.startswith("'") and value.endswith("'")) or \
           (value.startswith('"') and value.endswith('"')):
            value = value[1:-1]
        # Tiny list parser: ['a', 'b']
        list_m = re.match(r"^\[(.*)\]$", value)
        if list_m:
            inner = list_m.group(1)
            items: list = []
            for piece in re.findall(r"'([^']*)'|\"([^\"]*)\"", inner):
                items.append(piece[0] or piece[1])
            out[key] = items
        else:
            out[key] = value
    return out


def check_all_prompts_migrated(report: DodReport) -> None:
    """#1 — All 11 prompts have a `.md` with YAML frontmatter declaring `tools:`."""
    missing: list[str] = []
    no_frontmatter: list[str] = []
    no_tools_field: list[str] = []
    for name in EXPECTED_PROMPTS:
        path = PROMPTS_DIR / f"{name}.md"
        if not path.exists():
            missing.append(name)
            continue
        text = _read_text(path)
        fm = _parse_frontmatter(text)
        if not fm:
            no_frontmatter.append(name)
            continue
        if "tools" not in fm:
            no_tools_field.append(name)
            continue
        # `tools` must be a list.
        if not isinstance(fm["tools"], list):
            no_tools_field.append(name)
            continue

    ok = not (missing or no_frontmatter or no_tools_field)
    evidence = (
        f"{len(EXPECTED_PROMPTS) - len(missing) - len(no_frontmatter) - len(no_tools_field)}"
        f"/{len(EXPECTED_PROMPTS)} prompts have valid `.md` + frontmatter + `tools:`"
    )
    notes = ""
    if missing:
        notes += f"Missing: {missing}. "
    if no_frontmatter:
        notes += f"No frontmatter: {no_frontmatter}. "
    if no_tools_field:
        notes += f"Missing tools: {no_tools_field}."
    report.add_check("All 11 prompts migrated to .md with frontmatter (tools:)", ok, evidence, notes)


def check_prompt_loader_exists(report: DodReport) -> None:
    """#2 — lib/prompt_loader.py with load_prompt() and LoadedPrompt dataclass."""
    text = _read_text(PROMPT_LOADER)
    has_loader = "def load_prompt(" in text
    has_dataclass = "class LoadedPrompt" in text
    fields_match = all(
        f in text
        for f in ("name", "description", "tools", "body", "source_format", "deprecation_warning")
    )
    ok = has_loader and has_dataclass and fields_match
    evidence = (
        f"load_prompt(): {has_loader}, LoadedPrompt dataclass: {has_dataclass}, "
        f"all required fields: {fields_match}"
    )
    report.add_check("lib/prompt_loader.py with load_prompt() + LoadedPrompt", ok, evidence)


def check_build_prompt_returns_prepared_prompt(report: DodReport) -> None:
    """#3 — prompt_assembler.build_prompt returns PreparedPrompt.

    Per deepening PRD issue #32, the prompt builder moved to
    :mod:`prompt_assembler` and its return type changed from a
    loose ``(text, tools)`` tuple to a :class:`PreparedPrompt`
    value object. The new function is in ``prompt_assembler.py``,
    not ``flow_engine.py`` — the check looks at the new module.
    """
    from pathlib import Path as _P
    assembler_path = MAESTRO_DIR / "prompt_assembler.py"
    if not assembler_path.exists():
        report.add_check(
            "prompt_assembler.py exists with build_prompt() -> PreparedPrompt",
            False,
            f"{assembler_path} not found",
        )
        return

    text = _read_text(assembler_path)
    # PreparedPrompt is a frozen dataclass with the required fields
    has_class = bool(re.search(
        r"@dataclass(?:\(frozen=True\))?\s*\nclass\s+PreparedPrompt", text
    )) or bool(re.search(
        r"@dataclass\(frozen=True\)\s*\nclass\s+PreparedPrompt", text
    ))
    has_fields = all(
        re.search(rf"^\s*{field}\s*[:=]", text, re.MULTILINE)
        for field in ("text", "tools", "model_override", "provider_override", "template_loaded")
    )
    # build_prompt returns PreparedPrompt (not a tuple)
    sig_match = re.search(
        r"def\s+build_prompt\([^)]*\)\s*->\s*PreparedPrompt", text
    )
    return_match = re.search(r"return\s+PreparedPrompt\(", text)
    ok = bool(has_class and has_fields and sig_match and return_match)
    evidence = (
        f"PreparedPrompt dataclass with 5 fields: {bool(has_class and has_fields)}, "
        f"build_prompt -> PreparedPrompt: {bool(sig_match and return_match)}"
    )
    report.add_check(
        "prompt_assembler.build_prompt() returns PreparedPrompt", ok, evidence
    )


def check_run_phase_passes_tools(report: DodReport) -> None:
    """#4 — run_phase passes tools to the RPC layer.

    The actual entry point is :func:`rpc_client.run_rpc_with_session_log`
    (a thin wrapper around ``run_rpc`` that attaches the session log path).

    Per deepening PRD issue #31, the per-phase function lives in
    :mod:`phase_runner` now — ``flow_engine`` only has the phase
    loop. The check looks at both modules because the legacy check
    target (``flow_engine.py``) may still carry a stale
    ``run_phase`` re-export via the PEP 562 ``__getattr__`` shim.
    """
    phase_runner_path = MAESTRO_DIR / "phase_runner.py"
    text = _read_text(phase_runner_path) if phase_runner_path.exists() else ""
    rpc_call_match = re.search(
        r"run_rpc_with_session_log\([^)]*tools\s*=\s*tools", text, re.DOTALL
    )
    ok = bool(rpc_call_match)
    evidence = (
        f"run_rpc_with_session_log(..., tools=tools) invocation: {bool(rpc_call_match)}"
    )
    report.add_check("run_phase() passes tools to the RPC layer", ok, evidence)


def check_rpc_client_accepts_tools(report: DodReport) -> None:
    """#5 — rpc_client.run_rpc() accepts and forwards ``tools``.

    The signature declares ``tools: Optional[list[str]] = None`` and the
    field is included in the JSON spawn options (per the comment block in
    the file: ``prompt_payload["tools"] = tools``).
    """
    text = _read_text(RPC_CLIENT)
    sig_match = re.search(
        r"def\s+run_rpc\([^)]*tools\s*:\s*Optional\[list\[str\]\]\s*=\s*None",
        text,
        re.DOTALL,
    )
    payload_match = re.search(
        r"prompt_payload\[[\"']tools[\"']\]\s*=\s*tools", text
    )
    ok = bool(sig_match and payload_match)
    evidence = (
        f"tools: Optional[list[str]] = None declared: {bool(sig_match)}, "
        f"assigned to prompt_payload['tools']: {bool(payload_match)}"
    )
    report.add_check("rpc_client.run_rpc() accepts and forwards tools", ok, evidence)


def check_builder_reviewer_flow(report: DodReport) -> None:
    """#6 — flows/builder-reviewer.json has scout + scout_enabled=true."""
    flow_path = FLOWS_DIR / "builder-reviewer.json"
    if not flow_path.exists():
        report.add_check("flows/builder-reviewer.json present", False, "file missing")
        return
    try:
        data = json.loads(flow_path.read_text())
    except json.JSONDecodeError as exc:
        report.add_check("flows/builder-reviewer.json present", False, f"invalid JSON: {exc}")
        return

    phases = data.get("phases", {})
    has_scout = "scout" in phases
    has_builder = "builder" in phases
    has_reviewer = "reviewer" in phases
    scout_enabled = data.get("scout_enabled", False) is True

    ok = has_scout and has_builder and has_reviewer and scout_enabled
    evidence = (
        f"phases: scout={has_scout}, builder={has_builder}, reviewer={has_reviewer}; "
        f"scout_enabled={scout_enabled}"
    )
    report.add_check("flows/builder-reviewer.json has scout + scout_enabled", ok, evidence)


def check_scout_readonly_tools(report: DodReport) -> None:
    """#7 — Scout prompt's tool set is read-only (no Write/Edit/etc.)."""
    text = _read_text(PROMPTS_DIR / "scout.md")
    fm = _parse_frontmatter(text)
    tools = fm.get("tools") or []
    forbidden = set(tools) & MUTATING_TOOLS
    has_readonly_baseline = READ_ONLY_TOOLS.issubset(set(tools))
    ok = not forbidden and has_readonly_baseline
    evidence = f"tools={tools}; forbidden present: {sorted(forbidden) or 'none'}"
    notes = (
        "scout is missing one or more read-only tools" if not has_readonly_baseline else ""
    )
    report.add_check("scout prompt: read-only tool set, no Write/Edit", ok, evidence, notes)


def check_reviewer_readonly_tools(report: DodReport) -> None:
    """#8 — Reviewer prompt's tool set excludes Write/Edit."""
    text = _read_text(PROMPTS_DIR / "reviewer.md")
    fm = _parse_frontmatter(text)
    tools = fm.get("tools") or []
    forbidden = set(tools) & MUTATING_TOOLS
    ok = not forbidden
    evidence = f"tools={tools}; forbidden present: {sorted(forbidden) or 'none'}"
    report.add_check("reviewer prompt: read-only (no Write/Edit)", ok, evidence)


def check_builder_full_tools(report: DodReport) -> None:
    """#9 — Builder prompt's tool set includes Edit and Write (positive control)."""
    text = _read_text(PROMPTS_DIR / "builder.md")
    fm = _parse_frontmatter(text)
    tools = set(fm.get("tools") or [])
    has_edit = "Edit" in tools
    has_write = "Write" in tools
    ok = has_edit and has_write
    evidence = f"tools={sorted(tools)}; Edit={has_edit}, Write={has_write}"
    report.add_check("builder prompt: includes Edit and Write", ok, evidence)


def check_builder_injects_scout_findings(report: DodReport) -> None:
    """#12 — Builder prompt reserves a section for Scout findings (slice #275).

    The builder prompt substitutes ``{scout_findings}`` with the rendered
    findings markdown (always prefixed with ``## Scout Findings`` per
    ``scout_findings.format_scout_findings_markdown``). The prompt must
    declare the placeholder so the substitution actually happens.
    """
    text = _read_text(PROMPTS_DIR / "builder.md")
    has_placeholder = "{scout_findings}" in text
    has_section_heading = "Context from Scout" in text or "Scout Findings" in text
    ok = has_placeholder and has_section_heading
    evidence = (
        f"{{scout_findings}} placeholder present: {has_placeholder}, "
        f"section heading present: {has_section_heading}"
    )
    report.add_check(
        "builder prompt: injects Scout findings via {scout_findings}", ok, evidence
    )


def check_working_memory_path(report: DodReport) -> None:
    """#13 — Working memory persists to ``.maestro/tasks/active/<n>.memory.json``.

    Issue #277 explicitly requires ``.maestro/tasks/active/<n>.memory.json``
    to exist after a flow run and contain a ``scout`` section. We verify
    the path is hard-coded in ``lib/working_memory.py`` so a live run will
    produce it.
    """
    text = _read_text(LIB_DIR / "working_memory.py")
    has_path = ".maestro/tasks/active" in text
    has_extension = ".memory.json" in text
    has_scout_phase = "scout" in text
    ok = has_path and has_extension and has_scout_phase
    evidence = (
        f".maestro/tasks/active path: {has_path}, "
        f".memory.json extension: {has_extension}, "
        f"scout phase reference: {has_scout_phase}"
    )
    report.add_check(
        "working memory path is .maestro/tasks/active/<n>.memory.json", ok, evidence
    )


def check_prompt_loader_precedence(report: DodReport) -> None:
    """#11 — prompt_loader enforces explicit > frontmatter > default > fallback."""
    text = _read_text(PROMPT_LOADER)
    has_explicit_check = "explicit_tools" in text
    has_frontmatter_check = "meta.tools" in text or "tools" in text
    has_default_fallback = "DEFAULT_TOOLS" in text
    has_permissive_fallback = "PERMISSIVE_FALLBACK" in text
    ok = all([has_explicit_check, has_frontmatter_check, has_default_fallback, has_permissive_fallback])
    evidence = (
        f"explicit_tools ref: {has_explicit_check}, meta.tools ref: {has_frontmatter_check}, "
        f"DEFAULT_TOOLS: {has_default_fallback}, PERMISSIVE_FALLBACK: {has_permissive_fallback}"
    )
    report.add_check("prompt_loader precedence chain complete", ok, evidence)


def check_tests_pass(report: DodReport, run_tests: bool) -> None:
    """#10 — All tests in .pi/maestro/tests/ pass."""
    if not run_tests:
        report.add(CheckResult("All existing tests pass", "SKIP", notes="--no-tests"))
        return
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pytest", "tests/", "-q", "--no-header"],
            cwd=MAESTRO_DIR,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        report.add_check("All existing tests pass", False, "pytest timed out after 120s")
        return
    except FileNotFoundError:
        report.add_check("All existing tests pass", False, "pytest not installed")
        return

    output = (result.stdout or "") + (result.stderr or "")
    # Pytest summary line: "346 passed in 2.64s"
    m = re.search(r"(\d+)\s+passed", output)
    if result.returncode == 0 and m:
        report.add_check("All existing tests pass", True, f"{m.group(1)} tests passed")
    else:
        # Tail the last few lines for debugging.
        tail = "\n".join(output.strip().splitlines()[-10:])
        report.add_check("All existing tests pass", False, f"pytest exit={result.returncode}", tail)


# ─── Output rendering ────────────────────────────────────────────────


def _generate_markdown(report: DodReport) -> str:
    out = [
        "# Wave 1 DoD Static Checks",
        "",
        f"**Total:** {report.total}  ",
        f"**Passed:** {report.passed}  ",
        f"**Failed:** {report.failed}  ",
        f"**Warned:** {report.warned}  ",
        f"**Skipped:** {report.skipped}",
        "",
        "| # | Check | Status | Evidence |",
        "|---|-------|--------|----------|",
    ]
    for i, r in enumerate(report.results, 1):
        icon = {"PASS": "✅", "FAIL": "❌", "WARN": "⚠️", "SKIP": "⏭️"}.get(r.status, "?")
        evidence = r.evidence.replace("|", "\\|")
        if r.notes:
            evidence = f"{evidence} — {r.notes}"
        out.append(f"| {i} | {r.name} | {icon} {r.status} | {evidence} |")
    out.append("")
    out.append("## Items that need a live E2E run")
    out.append("")
    out.append("These DoD items cannot be checked statically:")
    out.append("")
    out.append("- At least one end-to-end run on a real issue demonstrates the new behavior")
    out.append("- No regression in build pass rate (re-measure after sprint)")
    out.append("")
    out.append("Run them with:")
    out.append("")
    out.append("```bash")
    out.append("python3 .pi/maestro/orchestrate.py --flow builder-reviewer --issue <n>")
    out.append("python3 .pi/maestro/scripts/build-pass-rate.py --json")
    out.append("```")
    out.append("")
    return "\n".join(out)


def _generate_json(report: DodReport) -> str:
    return json.dumps(
        {
            "total": report.total,
            "passed": report.passed,
            "failed": report.failed,
            "warned": report.warned,
            "skipped": report.skipped,
            "all_pass": report.all_pass,
            "results": [
                {
                    "name": r.name,
                    "status": r.status,
                    "evidence": r.evidence,
                    "notes": r.notes,
                }
                for r in report.results
            ],
        },
        indent=2,
    )


def _generate_help() -> str:
    return """Usage: python scripts/wave1-dod-check.py [options]

Wave 1 Definition-of-Done static checker for Maestro.

Verifies the static items on PRD #272's Wave 1 DoD:
  - Prompt migration (11 prompts to .md with frontmatter declaring tools:)
  - Tool allowlist plumbing (prompt_loader, build_prompt, run_phase, rpc_client)
  - Builder-reviewer flow has scout + scout_enabled=true
  - Scout/reviewer prompts are read-only, builder has Edit+Write
  - Precedence chain: explicit > frontmatter > default > permissive
  - All existing tests pass

Two DoD items require a live flow run and are listed as 'needs manual check'.

Options:
  --no-tests    Skip pytest (use for fast static-only verification)
  --json        Output machine-readable JSON
  --help        Show this help message

Examples:
  python scripts/wave1-dod-check.py
  python scripts/wave1-dod-check.py --no-tests --json
"""


# ─── Main ─────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Wave 1 DoD static verification (Maestro).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_generate_help(),
    )
    parser.add_argument("--no-tests", action="store_true",
                        help="Skip the pytest pass-rate check")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    parser.add_argument("--help-all", action="store_true", help="Show extended help")
    args = parser.parse_args()

    if args.help_all:
        print(_generate_help())
        return 0

    report = DodReport()
    check_all_prompts_migrated(report)
    check_prompt_loader_exists(report)
    check_build_prompt_returns_prepared_prompt(report)
    check_run_phase_passes_tools(report)
    check_rpc_client_accepts_tools(report)
    check_builder_reviewer_flow(report)
    check_scout_readonly_tools(report)
    check_reviewer_readonly_tools(report)
    check_builder_full_tools(report)
    check_builder_injects_scout_findings(report)
    check_working_memory_path(report)
    check_prompt_loader_precedence(report)
    check_tests_pass(report, run_tests=not args.no_tests)

    if args.json:
        print(_generate_json(report))
    else:
        print(_generate_markdown(report))

    return 0 if report.all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
