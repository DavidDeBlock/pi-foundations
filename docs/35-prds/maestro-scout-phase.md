# PRD: Scout Phase (Read-Only Pre-Implementation Exploration)

> **Wave:** 1 (Foundation)
> **Effort:** 1-2 hours
> **Depends on:** [Tool Allowlists](maestro-tool-allowlists.md) (for read-only enforcement)
> **Required by:** [Working Memory](maestro-working-memory.md) (scout findings flow into memory)
> **Roadmap:** [maestro-case-improvements-roadmap.md](maestro-case-improvements-roadmap.md#8-prds-in-this-set)

---

## Problem Statement

The Maestro `builder` phase currently has to discover repo context **while writing code**:

- Which files are relevant to this issue?
- What patterns does this codebase use? (repository pattern, test colocation, naming conventions)
- What's the test command? Build command? Lint command?
- What risks exist? (shared utilities, public APIs, etc.)

This means the first 20-30% of every builder run is **exploration cost** that gets thrown away. Worse, the builder sometimes misses critical context (e.g., a shared utility that breaks three downstream callers) and produces broken code on the first try, triggering a rejection loop.

The **workos/case** project solves this with a **scout phase** that runs *before* the implementer. The scout has a 3-minute wall-clock budget, can only use read-only tools, and returns a structured `ScoutFindings` object that the orchestrator injects into the implementer's prompt. The implementer starts with concrete files, patterns, and conventions — no exploration tax.

## Solution

Add a `scout` phase to Maestro flows that:

1. Runs **before** the `builder` phase
2. Has read-only tools enforced via [Tool Allowlists](maestro-tool-allowlists.md)
3. Explores the target repo and emits a structured findings block
4. Has a tight timeout (default 4 minutes) to prevent wasted runs
5. Writes findings to **working memory** (see [Working Memory PRD](maestro-working-memory.md))
6. Findings get injected as `{scout_findings}` into the builder's prompt

**Backward compatibility:** Scout is **opt-in per flow** via a `"scout_enabled": true` flag in the flow JSON. Existing flows without the flag skip the scout phase entirely.

**Graceful degradation:** If the scout fails (timeout, error, no findings), the builder proceeds without findings — the existing behavior. This prevents scout failures from blocking the entire pipeline.

## User Stories

1. As a Maestro operator, I want a scout phase to run before the builder, so that the builder starts with concrete repo context
2. As a Maestro operator, I want the scout to be physically read-only (via tool allowlist), so that "exploration" can't accidentally mutate state
3. As a Maestro operator, I want the scout to have a tight time budget, so that scout failures don't block the pipeline indefinitely
4. As a Maestro operator, I want scout findings to be injected into the builder's prompt as structured context, so that the builder can act on them
5. As a Maestro operator, I want scout findings to be persisted to working memory, so that retries and retrospectives can reference them
6. As a Maestro operator, I want scout failures to be non-fatal, so that the builder can still proceed if the scout times out
7. As a Maestro operator, I want to disable scout per flow (e.g., for trivial fixes), so that I don't pay the exploration cost when not needed
8. As a Maestro developer, I want scout findings to follow a defined schema, so that the synthesizer produces consistent markdown blocks
9. As a Maestro operator, I want a CLI command to inspect scout findings for a past run, so that I can debug "why did the builder miss this?" questions

## Implementation Decisions

### New Prompt: `prompts/scout.md`

```markdown
---
name: scout
description: Read-only exploration agent. Runs before the implementer to surface relevant files, patterns, and constraints so the implementer starts with concrete context.
tools: ['Read', 'Bash', 'Grep', 'Glob']
timeout_seconds: 240
---

# Scout — Read-Only Exploration

You are a read-only scout. You have **{timeout_seconds} seconds** to explore the target repository and return structured findings.

## Input

You receive from the orchestrator:
- **Issue title and body:** {issue_body}
- **Target repo path:** the working directory
- **Working directory:** {working_dir}

## Workflow

### 1. Locate relevant code (1.5 min budget)

Use `Grep` and `Glob` to find files related to the issue. Look for:
- Direct references in the issue body (file paths, function names, error messages)
- Test files in the same area (to understand expected behavior)
- Adjacent modules (callers, callees, siblings)

Capture as `relevant_files` in the output.

### 2. Identify patterns (1 min budget)

Look for:
- **Test command:** What command runs tests? (check `package.json`, `pyproject.toml`, `Makefile`, `bunfig.toml`, etc.)
- **Code style:** Indentation, naming, import order, etc.
- **Architectural patterns:** Repository pattern, service layer, dependency injection, etc.
- **Conventions:** Commit message format, branch naming, file naming

Capture as `patterns` in the output.

### 3. Identify risks (1 min budget)

Look for:
- **Public APIs** that the change might break
- **Shared utilities** that other modules depend on
- **Migration files** or schema changes that need coordination
- **Performance-sensitive paths** (hot loops, DB queries)

Capture as `risks` in the output.

### 4. Emit findings

At the end of your run, output a single `PHASE_OUTPUT` block with structured findings:

```
---
### PHASE_OUTPUT: success
{
  "relevant_files": ["src/auth/session.ts", "src/auth/session.test.ts"],
  "test_command": "bun test src/auth",
  "patterns": [
    "uses repository pattern via src/db/repositories/",
    "tests colocated as *.test.ts",
    "conventional commits: feat/fix/chore"
  ],
  "conventions": [
    "no default exports",
    "use snake_case for DB columns, camelCase for TS"
  ],
  "risks": [
    "session.ts is imported by 12 modules — check for breaking changes",
    "DB migration 0042 must run before deploy"
  ],
  "scanned_at": "2026-06-04T12:34:00Z"
}
### END_PHASE_OUTPUT
---
```

## Rules

- **DO NOT** edit, write, or create any file
- **DO NOT** run mutating commands (`git commit`, `git push`, `npm install`, `rm`, etc.)
- **DO NOT** exceed {timeout_seconds} seconds
- If you have not produced findings by minute 3, finalize what you have and emit the result block immediately
- If the repo is too large to fully explore, prioritize the files mentioned in the issue body
```

> **Note (post-review fix):** The flow engine does **not** perform Jinja-style `{{...}}` substitution. Use single-brace placeholders that the engine actually resolves, and only for variables it injects. The supported placeholders in the scout's prompt are: `{issue_body}`, `{prefetched_context}`, `{working_memory_json}`, `{scout_findings}`. The `{timeout_seconds}` value comes from the frontmatter; render it as a literal in the prompt body (e.g. `240`). Drop the `{{issue_num}}` reference — the issue number is already in `{issue_body}`. Drop the `{{session_dir}}` reference — the engine does not inject this variable.

### New Flow Example: `flows/builder-reviewer.json` (updated)

```json
{
  "name": "builder-reviewer",
  "default_provider": "llama-cpp-3090",
  "scout_enabled": true,
  "scout_timeout_seconds": 240,
  "phases": {
    "scout": {
      "skill": "/skill:scout",
      "model": "qwen-27b-118k-q8",
      "provider": "llama-cpp-3090",
      "timeout_seconds": 240,
      "retries": 1
    },
    "builder": {
      "skill": "/skill:tdd",
      "model": "qwen-27b-118k-q8",
      "provider": "llama-cpp-3090",
      "timeout_seconds": 1800,
      "retries": 3
    },
    "reviewer": {
      "skill": "/skill:reviewer",
      "model": "qwen-27b-118k-q8",
      "provider": "llama-cpp-3090",
      "timeout_seconds": 1200,
      "retries": 2
    },
    "diagnostic": {
      "skill": "/skill:diagnose",
      "model": "qwen-27b-118k-q8",
      "provider": "llama-cpp-3090",
      "timeout_seconds": 600,
      "retries": 1
    }
  },
  "transitions": [
    { "from": "scout", "on_success": "builder", "on_error": "builder", "on_reject": "builder" },
    { "from": "builder", "on_success": "reviewer", "on_reject": "builder", "on_error": "diagnostic" },
    { "from": "reviewer", "on_success": "finish", "on_reject": "builder", "on_error": "diagnostic" },
    { "from": "diagnostic", "on_success": "builder", "on_reject": "finish", "on_error": "finish" }
  ]
}
```

**Key change:** Scout's transitions route `on_reject` and `on_error` directly to `builder` (not back to scout). Scout failures are non-fatal — the builder proceeds without findings.

### Updated: `flow_engine.py` — Scout Phase Handling

```python
# flow_engine.py — add scout handling
def run_flow(flow_config: dict, issue_num: int) -> dict:
    """Run a flow on an issue, handling scout specially."""
    scout_enabled = flow_config.get("scout_enabled", False)
    scout_timeout = flow_config.get("scout_timeout_seconds", 240)

    # If scout enabled, run it first
    scout_findings = None
    if scout_enabled and "scout" in flow_config["phases"]:
        scout_result = run_phase("scout", flow_config, issue_num, context={}, timeout_override=scout_timeout)
        if scout_result["status"] == "success":
            scout_findings = parse_scout_findings(scout_result["details"])
            # Persist to working memory
            working_memory.update(issue_num, "scout", scout_findings)
        else:
            # Non-fatal: log and proceed
            log(f"[scout] {scout_result['status']}: {scout_result.get('details', 'no details')}")
            log("[scout] Builder will proceed without scout findings")

    # Inject scout_findings into context for builder
    context = {"scout_findings": format_scout_findings_markdown(scout_findings)}

    # Run the rest of the flow
    current_phase = "builder" if scout_enabled else first_phase(flow_config)
    while current_phase != "finish":
        result = run_phase(current_phase, flow_config, issue_num, context)
        current_phase = get_next_step(flow_config["transitions"], current_phase, result["status"])


def parse_scout_findings(details: str) -> dict:
    """Parse the JSON block from the scout's PHASE_OUTPUT."""
    import json, re
    match = re.search(r"\{.*\}", details, re.DOTALL)
    if not match:
        return {"raw": details, "parse_error": "no JSON block found"}
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError as e:
        return {"raw": details, "parse_error": str(e)}


def format_scout_findings_markdown(findings: dict | None) -> str:
    """Format scout findings as a markdown block for injection into the builder's prompt."""
    if not findings:
        return "(No scout findings — proceed with general exploration)"
    if "parse_error" in findings:
        return f"## Scout Findings (raw, unparseable)\n\n```\n{findings['raw']}\n```"
    parts = ["## Scout Findings", ""]
    if findings.get("relevant_files"):
        parts.append("### Relevant Files")
        for f in findings["relevant_files"]:
            parts.append(f"- `{f}`")
        parts.append("")
    if findings.get("test_command"):
        parts.append(f"### Test Command\n`{findings['test_command']}`\n")
    if findings.get("patterns"):
        parts.append("### Patterns")
        for p in findings["patterns"]:
            parts.append(f"- {p}")
        parts.append("")
    if findings.get("conventions"):
        parts.append("### Conventions")
        for c in findings["conventions"]:
            parts.append(f"- {c}")
        parts.append("")
    if findings.get("risks"):
        parts.append("### Risks")
        for r in findings["risks"]:
            parts.append(f"- ⚠️ {r}")
        parts.append("")
    return "\n".join(parts)
```

### Updated: `prompts/builder.md` — Inject Scout Findings

The builder's prompt template adds a `{scout_findings}` section near the top:

```markdown
# Builder — Implementation Agent

## Context from Scout

{scout_findings}

## Task

You are implementing a fix or feature for issue #{issue_num}.

{issue_body}

## Workflow

1. Review the scout findings above (if any)
2. Read the relevant files identified by the scout
3. Write failing tests first (TDD)
4. Implement the minimal change
5. Run the test command: check the scout findings for the exact command
6. Commit with a conventional message

[... rest of existing builder prompt ...]
```

### Variable Injection: `{scout_findings}`

In `flow_engine.py`, the `build_variables()` function adds a new variable:

```python
def build_variables(phase_name, flow_config, issue_num, context):
    variables = {
        # ... existing variables ...
        "scout_findings": context.get("scout_findings", "(No scout findings)"),
    }
    return variables
```

### Schema: `ScoutFindings`

The findings follow a defined schema (loose — unknown fields are allowed, missing fields default to empty):

```python
# lib/scout_findings.py
from dataclasses import dataclass, field
from typing import Literal

@dataclass
class ScoutFindings:
    relevant_files: list[str] = field(default_factory=list)
    test_command: str = ""
    patterns: list[str] = field(default_factory=list)
    conventions: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    scanned_at: str = ""  # ISO 8601

    @classmethod
    def from_dict(cls, d: dict) -> "ScoutFindings":
        """Construct from a dict, tolerating unknown/missing fields."""
        return cls(
            relevant_files=d.get("relevant_files", []),
            test_command=d.get("test_command", ""),
            patterns=d.get("patterns", []),
            conventions=d.get("conventions", []),
            risks=d.get("risks", []),
            scanned_at=d.get("scanned_at", ""),
        )

    def to_markdown(self) -> str:
        """Render as markdown for prompt injection."""
        # ... see format_scout_findings_markdown() above ...
```

### New CLI Command: `maestro scout-show <issue>`

```bash
maestro scout-show 42
```

Prints the scout findings (pretty-printed JSON) for issue #42, read from working memory.

## Testing Decisions

### Unit Tests

**`tests/test_scout_findings.py`** (new, ~8 tests):
- `test_from_dict_with_all_fields`
- `test_from_dict_with_missing_optional_fields`
- `test_from_dict_with_unknown_fields_ignored`
- `test_from_dict_with_malformed_types_defaults_safely`
- `test_to_markdown_includes_all_sections`
- `test_to_markdown_handles_empty_findings`
- `test_parse_scout_findings_extracts_json_from_phase_output`
- `test_parse_scout_findings_handles_unparseable_output`

**`tests/test_flow_scout.py`** (new, ~6 tests):
- `test_scout_enabled_runs_before_builder`
- `test_scout_disabled_skips_scout_phase`
- `test_scout_failure_routes_to_builder_not_finish`
- `test_scout_findings_injected_into_builder_prompt`
- `test_scout_findings_persisted_to_working_memory`
- `test_scout_timeout_default_240_seconds`

### Integration Tests

**`tests/test_integration_scout.py`** (new, ~3 tests):
- `test_end_to_end_scout_to_builder` — run scout, then builder with mock RPC; verify builder receives findings
- `test_scout_with_no_findings_still_proceeds` — scout returns empty findings; builder runs
- `test_scout_with_readonly_tools_cannot_write` — tool allowlist enforced (depends on Tool Allowlists PRD)

### Manual Verification

- [ ] Run a builder-reviewer flow on a real issue; verify scout runs and produces findings
- [ ] Inspect `.maestro/tasks/active/<issue>.memory.json` after run; verify `scout` section is populated
- [ ] Check that the builder's prompt contains the `## Scout Findings` section
- [ ] Verify scout timeout is enforced (kill a scout mid-run; verify it routes to builder, not finish)
- [ ] Disable scout via `"scout_enabled": false`; verify flow runs without scout phase

### Prior Art

- **Case:** `agents/scout.md` — full scout agent definition with tools allowlist
- **Case:** `src/phases/scout.ts` — scout phase execution with 3-min default timeout
- **Case:** `src/scout/findings.ts` — `ScoutFindings` schema + synthesis
- **Maestro:** `prompts/diagnostic.tmpl` — existing read-only-style prompt (close in spirit to scout)
- **Maestro:** `flow_engine.py:run_phase()` — existing phase execution pattern

## Out of Scope

- **Parallel scout + builder** — the whole point of scout is to inform builder; running them in parallel defeats the purpose. (See [DAG Support PRD](maestro-dag-support.md) for parallel phase execution in other contexts.)
- **Scout caching across runs** — could cache findings keyed on git SHA, but adds complexity. Defer until we have evidence that scout cost is a bottleneck.
- **Multi-scout coordination** — e.g., one scout for code, one for tests. Single scout is simpler and sufficient.
- **Scout for non-PRD flows** — this PRD focuses on `builder-reviewer` flows. Scout can be added to gap-check, prd-audit, etc. as follow-ups.

## Further Notes

### Why 4 minutes (not Case's 3)?

Case uses 3 minutes because their scout is invoked frequently and the cost adds up. Maestro's scout is opt-in per flow, so we have more headroom. 4 minutes gives scouts time to handle larger repos without timing out.

### Why JSON output (not free-form markdown)?

Structured JSON:
- Is machine-parseable (no regex fragility)
- Can be validated against a schema
- Can be queried (`maestro scout-show` CLI)
- Can be persisted cleanly to working memory

Free-form markdown is what `previous_output` is — lossy and hard to query.

### Why default to "no findings" instead of failing the build?

Scout failures should not block the pipeline. The existing builder behavior (discover context while writing) is the fallback. If scout consistently fails, that's a signal to improve the scout prompt, not a reason to break the build.

### Why `on_reject` and `on_error` route to `builder` (not `scout`)?

Scout is a one-shot exploration — there's no value in retrying it. If it produces bad findings, the builder will reject, and on the next iteration the builder has a chance to do its own exploration. Re-running scout would just produce different (possibly worse) findings.

## Acceptance Criteria

- [ ] `prompts/scout.md` exists with read-only tools in frontmatter
- [ ] `flows/builder-reviewer.json` updated to include scout phase with `scout_enabled: true`
- [ ] `flow_engine.py` runs scout before builder when enabled
- [ ] `flow_engine.py` injects `{scout_findings}` into builder's prompt
- [ ] Scout failures are non-fatal (route to builder, not finish)
- [ ] Scout findings persisted to working memory
- [ ] `lib/scout_findings.py` exists with `ScoutFindings` dataclass
- [ ] `maestro scout-show <issue>` CLI command works
- [ ] New tests: `test_scout_findings.py` (8), `test_flow_scout.py` (6), `test_integration_scout.py` (3)
- [ ] All existing tests pass
- [ ] Manual verification on at least 2 real issues demonstrates the new behavior
- [ ] Documentation: `README.md` updated with scout phase documentation

## References

### Case
- `agents/scout.md` — full scout agent (111 lines)
- `src/phases/scout.ts` — scout phase execution with 3-min default timeout (`DEFAULT_SCOUT_TIMEOUT_MS = 3 * 60 * 1000`)
- `src/scout/findings.ts` — `ScoutFindings` schema validation + synthesis
- `src/phases/implement.ts` — shows how scout findings are synthesized into the implementer prompt
- `src/context/assembler.ts` — context assembly that includes scout findings
- `docs/philosophy.md` — "Context isolation. Scout context is read-only exploration of the target repo"

### Maestro
- `flow_engine.py:200-280` — current `run_phase()` function (to be extended for scout)
- `prompts/diagnostic.tmpl` — closest existing read-only-style prompt
- `prompts/builder.tmpl` — to be updated to include `{scout_findings}` section
- `lib/working_memory.py` (new, see [Working Memory PRD](maestro-working-memory.md)) — where scout findings are persisted
- `tests/test_run_single_flow.py` — example of single-flow execution test

### Related PRDs in this set
- [Tool Allowlists](maestro-tool-allowlists.md) — prerequisite for read-only enforcement
- [Working Memory](maestro-working-memory.md) — scout findings are persisted here
- [Evidence Gates](maestro-evidence-gates.md) — scout can be gated to require `scout_findings.json` evidence file
