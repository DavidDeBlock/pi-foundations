# PRD: Per-Phase Tool Allowlists

> **Wave:** 1 (Foundation)
> **Effort:** 2-3 hours
> **Depends on:** nothing
> **Required by:** [Scout Phase](maestro-scout-phase.md), [Retrospective](maestro-retrospective.md), [Playbooks](maestro-playbooks.md)
> **Roadmap:** [maestro-case-improvements-roadmap.md](maestro-case-improvements-roadmap.md#8-prds-in-this-set)

---

## Problem Statement

Maestro's agent role boundaries are **prompt-enforced, not tool-enforced**. A `reviewer` prompt that says "do not edit files" can still call `Write` if the underlying skill permits it. This means:

- A misbehaving reviewer can accidentally (or intentionally) edit code
- A scout that runs "read-only" can still mutate the filesystem
- Auditing "what tools did phase X actually use" is impossible — we only have the prompt's word for it

The **workos/case** project solves this with explicit `tools:` lists in each agent's frontmatter (e.g., `agents/scout.md` declares `tools: ['Read', 'Bash', 'Glob', 'Grep']`). The agent runtime refuses to invoke tools not in the list. Role boundaries are mechanically enforced.

Maestro currently has 11 prompt templates (`prompts/*.tmpl`) that map to phases. None of them declare tool boundaries.

## Solution

Migrate Maestro's prompt templates from `.tmpl` files (plain text with `{variable}` substitution) to `.md` files with **YAML frontmatter** that declares:

1. The agent's name and description
2. The list of allowed tools
3. The model/provider (already supported via flow JSON, but moving to frontmatter makes the prompt self-describing)

The flow engine reads the frontmatter and passes the `tools` list to Pi's RPC client, which forwards it to the agent runtime. Pi enforces the list — disallowed tools return an error before execution.

**Default tool sets per phase type:**

| Phase Type | Default Tools | Rationale |
|---|---|---|
| `scout` | `['Read', 'Bash', 'Grep', 'Glob']` | Read-only exploration; Bash only for `git log`, `ls`, etc. |
| `builder` | `['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']` | Full implementation access |
| `reviewer` | `['Read', 'Bash', 'Grep', 'Glob']` | Read-only; can run test commands but not edit |
| `test_runner` | `['Read', 'Bash']` | Runs commands only |
| `diagnostic` | `['Read', 'Bash', 'Grep', 'Glob']` | Investigation only |
| `retrospective` | `['Read', 'Edit', 'Write']` | Appends to `.maestro/learnings.md` |
| `interviewer` | `['Read', 'Bash', 'Write']` | Writes onboarding context files |

**Backward compatibility:** `.tmpl` files continue to work — if a flow references a phase whose prompt is still a `.tmpl`, the engine defaults to the most-permissive tool set (`['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']`) and emits a deprecation warning. Migration can be incremental.

## User Stories

1. As a Maestro operator, I want each phase to declare its allowed tools in a structured format, so that role boundaries are machine-readable and auditable
2. As a Maestro operator, I want the reviewer phase to be physically unable to edit files, so that a misbehaving reviewer can't corrupt the codebase
3. As a Maestro operator, I want the scout phase to be physically unable to mutate state, so that "read-only" is a guarantee, not a polite request
4. As a Pi agent developer, I want to receive a `tools` list from the RPC spawn options, so that I can enforce allowlists in the agent runtime
5. As a Maestro developer, I want to query the tool set a phase used after a run completes, so that I can audit compliance
6. As a Maestro operator, I want the migration to be backward-compatible, so that I can convert prompts incrementally without breaking existing flows
7. As a Maestro operator, I want flow JSON to optionally override the default tool set for a phase, so that I can grant additional tools for specific flows (e.g., a builder that needs to run migrations)
8. As a Maestro developer, I want a CLI command to validate that all phases in a flow have valid tool sets, so that I catch misconfigurations before runtime

## Implementation Decisions

### New Module: `lib/prompt_loader.py`

Replaces the current inline `build_prompt()` in `flow_engine.py`. Handles both `.tmpl` and `.md` formats.

```python
# lib/prompt_loader.py
from pathlib import Path
import re
import yaml
from dataclasses import dataclass, field

DEFAULT_TOOLS = {
    "scout": ["Read", "Bash", "Grep", "Glob"],
    "builder": ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    "reviewer": ["Read", "Bash", "Grep", "Glob"],
    "test_runner": ["Read", "Bash"],
    "diagnostic": ["Read", "Bash", "Grep", "Glob"],
    "retrospective": ["Read", "Edit", "Write"],
    "interviewer": ["Read", "Bash", "Write"],
}

PERMISSIVE_FALLBACK = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]

@dataclass
class LoadedPrompt:
    name: str
    description: str
    tools: list[str]
    body: str  # The actual prompt text (without frontmatter)
    source_format: str  # "md" or "tmpl"
    deprecation_warning: str | None = None


def load_prompt(prompts_dir: Path, phase_name: str, explicit_tools: list[str] | None = None) -> LoadedPrompt:
    """Load a phase prompt, supporting both .md (with frontmatter) and .tmpl (legacy)."""
    md_path = prompts_dir / f"{phase_name}.md"
    tmpl_path = prompts_dir / f"{phase_name}.tmpl"

    if md_path.exists():
        text = md_path.read_text()
        match = re.match(r"^---\n(.*?)\n---\n?(.*)", text, re.DOTALL)
        if not match:
            raise ValueError(f"{md_path} has malformed frontmatter (missing '---' delimiters)")
        meta = yaml.safe_load(match.group(1)) or {}
        body = match.group(2).strip()
        tools = explicit_tools or meta.get("tools") or DEFAULT_TOOLS.get(phase_name, PERMISSIVE_FALLBACK)
        return LoadedPrompt(
            name=meta.get("name", phase_name),
            description=meta.get("description", ""),
            tools=tools,
            body=body,
            source_format="md",
        )
    elif tmpl_path.exists():
        body = tmpl_path.read_text()
        tools = explicit_tools or DEFAULT_TOOLS.get(phase_name, PERMISSIVE_FALLBACK)
        return LoadedPrompt(
            name=phase_name,
            description="",
            tools=tools,
            body=body,
            source_format="tmpl",
            deprecation_warning=f"{phase_name}.tmpl is deprecated; migrate to {phase_name}.md with frontmatter",
        )
    else:
        # Fall back to default prompt
        return LoadedPrompt(
            name=phase_name,
            description="",
            tools=explicit_tools or PERMISSIVE_FALLBACK,
            body=f"## Phase: {phase_name}\n\n[default prompt]\n",
            source_format="default",
        )
```

### Updated: `flow_engine.py` — `build_prompt()`

Replace the current prompt loading with a call to `prompt_loader.load_prompt()`. The loaded `tools` list is attached to the phase config and passed to `rpc_client.run_rpc()`.

```python
# flow_engine.py — new build_prompt
from prompt_loader import load_prompt

def build_prompt(phase_name: str, phase_config: dict, flow_config: dict, issue_num: int, context: dict) -> tuple[str, list[str]]:
    """Build prompt and return (prompt_text, tools_list)."""
    prompt_dir = Path(__file__).parent / "prompts"
    explicit_tools = phase_config.get("tools")
    loaded = load_prompt(prompt_dir, phase_name, explicit_tools)
    if loaded.deprecation_warning:
        print(f"[WARN] {loaded.deprecation_warning}", file=sys.stderr)

    # Variable substitution (existing logic, unchanged)
    variables = build_variables(phase_name, flow_config, issue_num, context)
    prompt = loaded.body.format(**variables) if variables else loaded.body

    return prompt, loaded.tools
```

### Updated: `lib/rpc_client.py` — Accept and Forward `tools`

Add a `tools` field to the RPC spawn options. Pi's agent runtime will enforce the list.

```python
# lib/rpc_client.py — updated run_rpc signature
def run_rpc(
    prompt: str,
    session_dir: Path,
    timeout_seconds: int,
    model: str | None = None,
    provider: str | None = None,
    tools: list[str] | None = None,  # NEW
) -> dict:
    spawn_options = {
        "prompt": prompt,
        "session_dir": str(session_dir),
        "model": model,
        "provider": provider,
    }
    if tools is not None:
        spawn_options["tools"] = tools

    # ... existing subprocess.Popen logic, but serialize spawn_options
    # as the JSON payload to pi --mode rpc ...
```

### Flow JSON: `tools` Override

Add an optional `tools` field to each phase in flow JSON. Allows per-flow overrides.

```json
// flows/builder-reviewer.json — example override
{
  "phases": {
    "builder": {
      "skill": "/skill:tdd",
      "tools": ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Migrate"],
      "retries": 3
    }
  }
}
```

If `tools` is omitted, the frontmatter's `tools` is used; if the frontmatter is also missing, the phase-type default is used.

### Migration: `.tmpl` → `.md` Frontmatter

Each existing `.tmpl` gets a `.md` sibling with the same body plus frontmatter. The `.tmpl` is kept (with deprecation warning) until all flows are migrated, then deleted in a follow-up.

**Example migration: `prompts/reviewer.tmpl` → `prompts/reviewer.md`**

```markdown
---
name: reviewer
description: Code quality validator. Read-only — produces verdict, never edits.
tools: ['Read', 'Bash', 'Grep', 'Glob']
---

# Reviewer — Code Quality Validation

You are a code reviewer. Review the changes in the current branch...

[... existing reviewer.tmpl body ...]
```

**Migration checklist (11 prompts):**

- [ ] `analyze.tmpl` → `analyze.md` (default: full tool set)
- [ ] `archivist.tmpl` → `archivist.md` (default: full tool set)
- [ ] `auditor.tmpl` → `auditor.md` (default: full tool set)
- [ ] `builder.tmpl` → `builder.md` (default: full tool set)
- [ ] `diagnostic.tmpl` → `diagnostic.md` (default: `diagnostic` tools)
- [ ] `generate-issues.tmpl` → `generate-issues.md` (default: full tool set)
- [ ] `issue-readiness.tmpl` → `issue-readiness.md` (default: full tool set)
- [ ] `reviewer.tmpl` → `reviewer.md` (default: `reviewer` tools)
- [ ] `test_runner.tmpl` → `test_runner.md` (default: `test_runner` tools)
- [ ] `to-issues.tmpl` → `to-issues.md` (default: full tool set)
- [ ] `to-prd.tmpl` → `to-prd.md` (default: full tool set)

### Updated: `tests/test_prompt_loader.py` (new file)

Tests for the prompt loader:

- Load `.md` with valid frontmatter → returns parsed meta + body
- Load `.md` with malformed frontmatter → raises `ValueError`
- Load `.tmpl` → returns legacy format with deprecation warning
- Load non-existent phase → returns default prompt with permissive tools
- Explicit `tools` override beats frontmatter `tools`
- Frontmatter `tools` beats `DEFAULT_TOOLS[phase_name]`
- `DEFAULT_TOOLS[phase_name]` beats `PERMISSIVE_FALLBACK`

### Pi-Side Change: Accept `tools` in RPC Spawn Options

This requires a small change to Pi's RPC client. The agent runtime should:

1. Parse the `tools` field from the JSON spawn options
2. Wrap tool invocations in a filter that checks the list
3. Return a clear error if a disallowed tool is invoked: `{"error": "Tool 'Write' not in allowlist ['Read', 'Bash', 'Grep', 'Glob']"}`

This change is outside Maestro's codebase but is a prerequisite. Coordinate with the Pi agent codebase.

## Testing Decisions

### Unit Tests

**`tests/test_prompt_loader.py`** (new, ~8 tests):
- `test_load_md_with_valid_frontmatter`
- `test_load_md_with_malformed_frontmatter_raises`
- `test_load_tmpl_returns_deprecation_warning`
- `test_load_nonexistent_phase_returns_default`
- `test_explicit_tools_override_beats_frontmatter`
- `test_frontmatter_tools_beats_phase_default`
- `test_phase_default_beats_permissive_fallback`
- `test_body_variable_substitution_preserved`

**`tests/test_flow_engine_tools.py`** (new, ~5 tests):
- `test_build_prompt_returns_tools`
- `test_phase_config_tools_override_prompt_tools`
- `test_rpc_client_receives_tools_in_spawn_options`
- `test_deprecation_warning_emitted_for_tmpl`
- `test_legacy_tmpl_still_works`

### Integration Tests

**`tests/test_integration_tool_enforcement.py`** (new, ~3 tests):
- `test_reviewer_invoking_write_is_blocked` — mock RPC, simulate reviewer calling Write, assert blocked
- `test_scout_invoking_edit_is_blocked` — same for scout
- `test_builder_invoking_all_allowed_tools_succeeds` — control case

### Manual Verification

- [ ] Run a builder-reviewer flow on a real issue; verify reviewer can read code but cannot edit
- [ ] Run a scout phase; verify it can list files but cannot modify them
- [ ] Check `state/` directory for recorded tool usage; verify disallowed tools are absent

### Prior Art

- **Case:** `src/agent/pi-runner.ts` — spawns agent with tools list
- **Case:** `agents/scout.md` — example of frontmatter tools declaration
- **Maestro:** `lib/rpc_client.py` — existing spawn options pattern
- **Maestro:** `tests/test_comment_parser.py` — example of clean unit test structure for prompt parsing

## Out of Scope

- **Runtime enforcement of tools list** — this PRD defines the *contract*; actual enforcement is a Pi-side change. Maestro's responsibility is to pass the list correctly.
- **Tool usage analytics** — recording which tools each phase invoked during a run. Could be a follow-up.
- **Per-tool argument validation** — e.g., preventing Bash from running `rm -rf`. The tools list is coarse-grained.
- **Migration of `.tmpl` to `.md` for prompts outside `prompts/`** — e.g., `panel` prompts in `panels/`. Focus on phase prompts first.

## Further Notes

### Why frontmatter, not a separate YAML file?

Case uses frontmatter because it co-locates the metadata with the prompt body — easier to maintain and version. A separate `prompts/reviewer.yaml` would require two files to keep in sync. Frontmatter is also standard in modern agent systems (Claude Code skills, Cursor rules, etc.).

### Why pass tools as a list, not a dict with constraints?

Some systems (e.g., AWS Bedrock AgentCore) allow per-tool constraints like `{"Bash": {"allowed_commands": ["git", "bun", "pnpm"]}}`. We could add this later, but it adds complexity. The current `list[str]` is the simplest correct contract. If we need constraints, we can add a `tool_constraints` field without breaking the `tools` field.

### What about the `panels/*.py` files?

The TUI dashboard panels are Python code, not agent prompts. They run inside Maestro's process, not inside Pi. The tool allowlist concept doesn't apply to them — they can call any Python function. This PRD only affects the prompts that get sent to Pi via RPC.

### Migration strategy

Don't migrate all 11 prompts in one PR. Migrate the highest-risk ones first (reviewer, scout, builder) and verify they work end-to-end. Then migrate the rest. The `.tmpl` deprecation warning makes it visible which prompts still need migration.

## Acceptance Criteria

- [ ] `lib/prompt_loader.py` exists with `load_prompt()` function
- [ ] All 11 existing prompts migrated to `.md` with YAML frontmatter
- [ ] `.tmpl` files still work (with deprecation warning)
- [ ] `flow_engine.py` passes `tools` list to `rpc_client.run_rpc()`
- [ ] `lib/rpc_client.py` includes `tools` in RPC spawn options JSON
- [ ] Pi agent runtime accepts and enforces `tools` list (Pi-side change)
- [ ] All existing tests pass
- [ ] New tests: `test_prompt_loader.py` (8 tests), `test_flow_engine_tools.py` (5 tests), `test_integration_tool_enforcement.py` (3 tests)
- [ ] Manual verification: reviewer cannot edit, scout cannot edit, builder can do everything
- [ ] Documentation: `README.md` updated with frontmatter format and tool defaults
- [ ] No regression: all existing flow JSONs continue working

## References

### Case
- `agents/scout.md` — example frontmatter with `tools: ['Read', 'Bash', 'Glob', 'Grep']`
- `agents/implementer.md` — full tool set example
- `agents/reviewer.md` — read-only reviewer example
- `src/agent/pi-runner.ts` — Pi agent spawn with tools option
- `src/agent/orchestrator-session.ts` — session-level tool enforcement
- `src/agent/adapters/pi-adapter.ts` — adapter that translates tools list to Pi runtime

### Maestro
- `flow_engine.py:80-150` — current `build_prompt()` function (to be replaced)
- `lib/rpc_client.py:50-120` — current `run_rpc()` function (to be extended)
- `prompts/*.tmpl` — 11 existing prompt templates to migrate
- `config.json` — `default_model` and `default_provider` (orthogonal to tools)
- `tests/test_comment_parser.py` — example of clean unit test structure

### Related PRDs in this set
- [Scout Phase](maestro-scout-phase.md) — uses tool allowlists to enforce read-only scout
- [Retrospective](maestro-retrospective.md) — uses tool allowlists to scope `Edit`/`Write` to specific files
- [Playbooks](maestro-playbooks.md) — uses tool allowlists to constrain playbook phases
