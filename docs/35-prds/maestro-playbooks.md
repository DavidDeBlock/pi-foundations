# PRD: Playbooks (Reusable Task-Type Workflows)

> **Wave:** 3 (Advanced Capabilities)
> **Effort:** 1-2 days
> **Depends on:** [Tool Allowlists](maestro-tool-allowlists.md), [Working Memory](maestro-working-memory.md), [Repo Onboarding](maestro-repo-onboarding.md)
> **Required by:** nothing (terminal node)
> **Roadmap:** [maestro-case-improvements-roadmap.md](maestro-case-improvements-roadmap.md#8-prds-in-this-set)

---

## Problem Statement

Maestro's prompt templates (`prompts/*.md`) are **generic** — they describe what a phase does (build, review, test) but not **how to approach a specific type of task**. A "fix a bug" task and an "add a feature" task both use the same `builder.md` prompt, even though the workflow is fundamentally different:

- **Bug fix:** reproduce → diagnose → write failing test → minimal fix → verify no regression
- **Add feature:** design → write tests first → implement → integrate → verify
- **Add CLI command:** study existing commands → follow pattern → add command → test → document

Case solves this with **playbooks** — reusable recipes that capture the workflow for a specific task type. A playbook is a markdown document with phases, guardrails, and decision points. Flows reference playbooks; the playbook is injected into the relevant phase's prompt as `{playbook}`.

**Playbooks are different from prompts:**
- A prompt is **what an agent does** (a role definition with tools)
- A playbook is **how an agent should approach a task** (a workflow with steps)

A builder prompt + a "fix-bug" playbook = a builder that follows the bug-fix workflow.

## Solution

Add a **Playbooks** layer to Maestro:

1. New directory: `playbooks/` with markdown files (one per task type)
2. New flow JSON field: `"playbook": "fix-bug"` per flow or per phase
3. New flow engine feature: inject `{playbook}` into the relevant phase's prompt
4. New CLI command: `maestro playbook list/show` for inspection
5. Backward compatible: flows without a `playbook` field work as before

**Initial playbooks (4 total, matching Case):**

| Playbook | Purpose | Target Phases |
|---|---|---|
| `fix-bug.md` | Bug fix workflow | builder, reviewer |
| `add-feature.md` | Feature addition workflow | builder, reviewer |
| `add-cli-command.md` | CLI command workflow | builder |
| `cross-repo-update.md` | Coordinated changes across repos | builder, reviewer |

**Playbook format:**

```markdown
# Playbook: Fix Bug

## Phase 1: Reproduce (5 min budget)

1. Run the failing test, capture output
2. Identify the **minimal** reproduction
3. Mark as `reproducible: true` in working memory

**Guardrail:** If you can't reproduce, stop and report — don't guess at a fix.

## Phase 2: Diagnose (10 min budget)

1. Read the stack trace, locate root cause file:line
2. Use `git blame <file>` for context on that line
3. Check for related test files (might be testing the wrong thing)

**Decision point:** If the root cause is in shared utility code, check callers FIRST before fixing.

## Phase 3: Fix (15 min budget)

1. Write a **failing test** that captures the bug (TDD)
2. Run the test, confirm it fails
3. Implement the **minimal** fix
4. Run the test, confirm it passes
5. Run the full test suite, verify no regressions

**Guardrail:** Don't refactor unrelated code in a bug fix. Stay minimal.

## Phase 4: Commit (2 min budget)

1. Stage the changes
2. Commit with conventional message: `fix: <short description>`
3. Reference the issue number in the commit body

## Reviewer Checklist

- [ ] Test was written FIRST, then fix
- [ ] Fix is minimal (no unrelated changes)
- [ ] No regressions in the full test suite
- [ ] Commit message follows convention
- [ ] Issue is referenced in the commit
```

## User Stories

1. As a Maestro operator, I want a `fix-bug` playbook that captures the bug-fix workflow, so that builders follow best practices by default
2. As a Maestro operator, I want to reference a playbook from a flow JSON, so that the workflow is configurable per flow
3. As a Maestro operator, I want to reference a playbook per phase, so that different phases can use different playbooks
4. As a Maestro operator, I want to write my own playbooks, so that I can capture domain-specific workflows
5. As a builder agent, I want the playbook to be injected into my prompt, so that I know the workflow steps
6. As a reviewer agent, I want the reviewer's checklist from the playbook, so that I know what to verify
7. As a Maestro operator, I want `maestro playbook list` to show all available playbooks, so that I can discover them
8. As a Maestro operator, I want `maestro playbook show <name>` to render a playbook, so that I can read it
9. As a Maestro operator, I want playbooks to support decision points and guardrails (not just step lists), so that workflows handle non-linear cases
10. As a Maestro operator, I want playbooks to be auto-recommended by repo onboarding (see [Repo Onboarding PRD](maestro-repo-onboarding.md)), so that the right playbook is used by default
11. As a Maestro developer, I want playbooks to be plain markdown (not a new format), so that they're easy to write and review
12. As a Maestro operator, I want playbooks to be committed to the repo (per-repo), so that they evolve with the project

## Implementation Decisions

### New Directory: `playbooks/`

```
playbooks/
├── fix-bug.md
├── add-feature.md
├── add-cli-command.md
└── cross-repo-update.md
```

### Example: `playbooks/fix-bug.md`

```markdown
# Playbook: Fix Bug

A disciplined workflow for bug fixes. Use this when an issue describes a specific bug (broken behavior, error, regression) rather than a new feature.

## Phase 1: Reproduce (5 min budget)

1. Read the issue carefully. Note the **expected** vs **actual** behavior.
2. Find or write a test that captures the bug.
3. Run the test, confirm it fails.
4. Mark as `reproducible: true` in working memory.

**Guardrail:** If you can't reproduce the bug from the issue description, STOP. Ask the user for more details or a screenshot. Do not guess at a fix.

## Phase 2: Diagnose (10 min budget)

1. Read the stack trace (if any) — note the file:line.
2. Use `git blame <file>` to see who last touched the code and why.
3. Use `git log --oneline <file>` for recent changes.
4. Check for related test files. Are they testing the right thing?
5. Read the **callers** of the buggy function. Is the bug in the function or in how it's called?

**Decision point:** If the root cause is in a shared utility (e.g., a function imported by 10+ files), the fix might break callers. Check all callers before fixing.

## Phase 3: Fix (15 min budget)

1. Write a **failing test** that captures the bug (TDD red).
2. Run the test, confirm it fails for the right reason.
3. Implement the **minimal** fix — change as few lines as possible.
4. Run the test, confirm it passes (TDD green).
5. Run the full test suite. Verify no regressions.

**Guardrail:** Do NOT refactor unrelated code in a bug fix. The commit should be minimal. A bug fix is not an excuse to clean up.

## Phase 4: Verify (5 min budget)

1. Re-read the issue. Does the fix address the **original** problem?
2. Check edge cases: empty input, large input, concurrent calls, etc.
3. Verify the fix is documented (if the behavior is user-facing).
4. Check for similar bugs elsewhere (does this pattern exist in other files?).

## Phase 5: Commit (2 min budget)

1. Stage the changes: `git add <files>`
2. Commit with conventional message: `fix: <short description>`
3. Reference the issue: `Closes #N` or `Refs #N` in the commit body
4. Verify the commit is clean: `git log -1` shows only the relevant changes

## Reviewer Checklist

When reviewing a bug fix, verify:

- [ ] **Test-first:** A test was written that fails without the fix and passes with it
- [ ] **Minimal:** The diff is small and focused on the bug
- [ ] **No regressions:** All existing tests still pass
- [ ] **Edge cases:** The fix handles edge cases (empty, large, concurrent)
- [ ] **Commit hygiene:** Conventional commit message, issue referenced
- [ ] **No scope creep:** No unrelated changes or "while I was here" refactors
```

### Example: `playbooks/add-feature.md`

```markdown
# Playbook: Add Feature

A disciplined workflow for adding new features. Use this when an issue describes a new capability, not a bug fix.

## Phase 1: Design (10 min budget)

1. Read the issue carefully. Identify:
   - **User-facing behavior:** What does the user see/do?
   - **API surface:** What endpoints, functions, or UI elements are added?
   - **Data model:** Any new tables, fields, or relationships?
2. Check the codebase for similar features. Follow existing patterns.
3. Sketch the implementation in working memory: which files, which functions, which tests.

**Guardrail:** If the feature is larger than 200 lines of code, break it into smaller issues. Don't ship a 1000-line PR.

## Phase 2: Tests First (15 min budget)

1. Write integration tests for the user-facing behavior.
2. Write unit tests for any new business logic.
3. Run the tests, confirm they fail (TDD red).
4. Update working memory with the test plan.

**Decision point:** If the feature requires database migrations, write the migration FIRST and verify it applies cleanly.

## Phase 3: Implement (30 min budget)

1. Implement the data model changes (if any).
2. Implement the service layer (business logic).
3. Implement the route handler / API endpoint.
4. Implement the UI changes (if any).
5. Run the tests, confirm they pass (TDD green).
6. Run the full test suite. Verify no regressions.

**Guardrail:** Stay within scope. If you discover a related issue, file it separately. Do not fix unrelated bugs in a feature commit.

## Phase 4: Document (5 min budget)

1. Update API documentation (if any).
2. Update the user-facing changelog (if any).
3. Add code comments for non-obvious logic.
4. Update the README if the feature is user-visible.

## Phase 5: Commit (5 min budget)

1. Stage the changes: `git add <files>`
2. Commit with conventional message: `feat: <short description>`
3. Reference the issue: `Closes #N` or `Refs #N`
4. If the feature is user-visible, include a screenshot in the PR description

## Reviewer Checklist

When reviewing a feature, verify:

- [ ] **Tests:** Integration tests for user-facing behavior, unit tests for logic
- [ ] **Patterns:** Follows existing codebase patterns (no new conventions)
- [ ] **Documentation:** API docs, changelog, README updated
- [ ] **No scope creep:** Only the feature described in the issue
- [ ] **Migrations:** Any database migrations apply cleanly
- [ ] **Commit hygiene:** Conventional message, issue referenced
```

### Updated Flow JSON: `playbook` Field

```json
// flows/builder-reviewer.json — add playbook per phase
{
  "name": "builder-reviewer",
  "phases": {
    "builder": {
      "skill": "/skill:tdd",
      "playbook": "fix-bug",  // NEW
      ...
    },
    "reviewer": {
      "skill": "/skill:reviewer",
      "playbook": "fix-bug",  // NEW
      ...
    }
  }
}
```

The `playbook` field can be:
- A string: `"fix-bug"` — looks up `playbooks/fix-bug.md`
- A list: `["fix-bug", "add-feature"]` — concatenates multiple playbooks
- A path: `"path/to/custom.md"` — loads from a custom path (for per-repo playbooks)
- Omitted: no playbook injected (backward compatible)

### New Module: `lib/playbook.py`

```python
# lib/playbook.py
from pathlib import Path
import re
from typing import Optional

DEFAULT_PLAYBOOK_DIR = Path(__file__).parent.parent / "playbooks"
REPO_PLAYBOOK_DIR = Path(".maestro/playbooks")


def load_playbook(name_or_path: str, repo_path: Optional[Path] = None) -> str:
    """Load a playbook by name or path. Search order: repo > default."""
    if repo_path:
        repo_path = Path(repo_path)
        # 1. Repo-specific playbook (absolute path)
        candidate = repo_path / name_or_path
        if candidate.exists():
            return candidate.read_text()
        # 2. Repo .maestro/playbooks/<name>.md
        candidate = repo_path / REPO_PLAYBOOK_DIR / f"{name_or_path}.md"
        if candidate.exists():
            return candidate.read_text()
    # 3. Default playbook
    candidate = DEFAULT_PLAYBOOK_DIR / f"{name_or_path}.md"
    if candidate.exists():
        return candidate.read_text()
    raise FileNotFoundError(f"Playbook not found: {name_or_path}")


def resolve_playbooks(playbook_spec, repo_path: Optional[Path] = None) -> str:
    """Resolve a playbook spec (string, list, or path) to a concatenated markdown string."""
    if not playbook_spec:
        return ""
    if isinstance(playbook_spec, str):
        specs = [playbook_spec]
    else:
        specs = list(playbook_spec)
    parts = []
    for spec in specs:
        try:
            content = load_playbook(spec, repo_path)
            parts.append(content)
        except FileNotFoundError as e:
            print(f"[WARN] {e}")
    return "\n\n---\n\n".join(parts)


def extract_reviewer_checklist(playbook_content: str) -> str:
    """Extract just the 'Reviewer Checklist' section from a playbook."""
    match = re.search(
        r"## Reviewer Checklist\s*\n(.*?)(?=\n## |\Z)",
        playbook_content,
        re.DOTALL,
    )
    return match.group(1).strip() if match else ""


def list_available_playbooks(repo_path: Optional[Path] = None) -> list[dict]:
    """List all available playbooks (default + repo-specific)."""
    results = []
    seen_names = set()
    # Repo-specific first (override defaults)
    if repo_path:
        for path in (repo_path / REPO_PLAYBOOK_DIR).glob("*.md"):
            results.append({"name": path.stem, "source": "repo", "path": str(path)})
            seen_names.add(path.stem)
    # Default playbooks
    for path in DEFAULT_PLAYBOOK_DIR.glob("*.md"):
        if path.stem not in seen_names:
            results.append({"name": path.stem, "source": "default", "path": str(path)})
    return results
```

### Updated: `flow_engine.py` — Inject Playbook

```python
# flow_engine.py — inject playbook into phase prompt
from lib.playbook import resolve_playbooks, extract_reviewer_checklist

def build_variables(phase_name, phase_config, flow_config, issue_num, context, repo_path=None):
    variables = {
        # ... existing variables ...
    }
    # Inject playbook
    playbook_spec = phase_config.get("playbook")
    if playbook_spec:
        playbook_content = resolve_playbooks(playbook_spec, repo_path)
        variables["playbook"] = playbook_content
        # For reviewer phase, extract just the checklist
        if phase_name == "reviewer":
            variables["reviewer_checklist"] = extract_reviewer_checklist(playbook_content)
    return variables
```

### Updated Prompts: Reference Playbook

```markdown
<!-- prompts/builder.md — new section -->
# Builder — Implementation Agent

## Repo Context
{repo_context_json}

## Prefetched Repo Context
{prefetched_context}

## Working Memory
{working_memory_json}

## Playbook

{playbook}

## Scout Findings
{scout_findings}

## Task
You are implementing a fix or feature for issue #{issue_number}.

{issue_body}

[... existing workflow ...]
```

```markdown
<!-- prompts/reviewer.md — new section -->
# Reviewer — Code Quality Validation

## Reviewer Checklist (from playbook)

{reviewer_checklist}

## Working Memory

{working_memory_json}

[... existing review workflow ...]
```

### New CLI Commands

```python
# maestro/commands/playbook.py
import click
from pathlib import Path
from lib.playbook import list_available_playbooks, load_playbook, DEFAULT_PLAYBOOK_DIR


@click.group()
def playbook():
    """Manage playbooks."""
    pass


@playbook.command(name="list")
@click.option("--repo-path", type=click.Path(exists=True), default=".")
def list_playbooks(repo_path):
    """List all available playbooks."""
    playbooks = list_available_playbooks(Path(repo_path))
    if not playbooks:
        click.echo("No playbooks found")
        return
    for pb in playbooks:
        marker = "📁" if pb["source"] == "repo" else "📦"
        click.echo(f"{marker} {pb['name']} ({pb['source']})")


@playbook.command()
@click.argument("name")
@click.option("--repo-path", type=click.Path(exists=True), default=".")
def show(name, repo_path):
    """Show a playbook's contents."""
    try:
        content = load_playbook(name, Path(repo_path))
        click.echo(content)
    except FileNotFoundError:
        click.echo(f"Playbook not found: {name}")
        raise click.exceptions.Exit(1)


@playbook.command()
@click.argument("name")
@click.option("--output", type=click.Path(), help="Output file (default: playbooks/<name>.md)")
def init(name, output):
    """Create a new playbook from a template."""
    template = """# Playbook: <NAME>

## Phase 1: ...

[Add phases, guardrails, decision points, and a reviewer checklist]

## Reviewer Checklist

- [ ] ...
"""
    output_path = Path(output) if output else DEFAULT_PLAYBOOK_DIR / f"{name}.md"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(template.replace("<NAME>", name.replace("-", " ").title()))
    click.echo(f"✓ Created {output_path}")
```

### Integration with Onboarding: Auto-Recommend Playbooks

The [Repo Onboarding PRD](maestro-repo-onboarding.md) already captures `playbooks_recommended` per repo. The flow engine uses this as a default when a flow doesn't specify a playbook:

```python
# flow_engine.py — fallback to onboarding-recommended playbooks
def get_default_playbook(phase_name, repo_path):
    """Get the default playbook for a phase, falling back to onboarding recommendations."""
    from lib.projects_registry import ProjectsRegistry
    registry = ProjectsRegistry(Path(".maestro/projects.json"))
    entry = registry.get_by_path(str(repo_path.resolve()))
    if entry and "playbooks_recommended" in entry:
        return entry["playbooks_recommended"]
    return None
```

## Testing Decisions

### Unit Tests

**`tests/test_playbook.py`** (new, ~10 tests):
- `test_load_default_playbook_by_name`
- `test_load_repo_playbook_overrides_default`
- `test_load_playbook_with_absolute_path`
- `test_resolve_playbooks_with_string_spec`
- `test_resolve_playbooks_with_list_spec`
- `test_resolve_playbooks_concatenates_multiple`
- `test_resolve_playbooks_warns_on_missing`
- `test_extract_reviewer_checklist_from_playbook`
- `test_extract_reviewer_checklist_returns_empty_if_missing`
- `test_list_available_playbooks_includes_default_and_repo`

**`tests/test_flow_playbook.py`** (new, ~6 tests):
- `test_playbook_injected_into_builder_prompt`
- `test_reviewer_checklist_extracted_for_reviewer_phase`
- `test_missing_playbook_logs_warning_but_proceeds`
- `test_multiple_playbooks_concatenated_in_prompt`
- `test_repo_playbook_overrides_default`
- `test_onboarding_recommended_playbook_used_as_fallback`

### Integration Tests

**`tests/test_integration_playbooks.py`** (new, ~3 tests):
- `test_end_to_end_flow_with_playbook` — full flow using a playbook
- `test_playbook_recommendation_from_onboarding` — onboard a repo, verify recommended playbooks are used
- `test_custom_repo_playbook_used` — repo has its own playbook, verify it's used instead of default

### Manual Verification

- [ ] Run `maestro playbook list`; verify all 4 default playbooks are listed
- [ ] Run `maestro playbook show fix-bug`; verify it renders correctly
- [ ] Run `maestro playbook init my-workflow`; verify a new playbook is created
- [ ] Run a flow with `playbook: "fix-bug"`; verify the playbook content appears in the builder's prompt
- [ ] Onboard a repo with `playbooks_recommended: ["add-feature"]`; run a flow; verify the playbook is auto-selected
- [ ] Create a repo-specific playbook at `.maestro/playbooks/custom.md`; verify it overrides the default

### Prior Art

- **Case:** `docs/playbooks/add-feature.md` — full feature playbook
- **Case:** `docs/playbooks/fix-bug.md` — bug fix playbook
- **Case:** `docs/playbooks/add-cli-command.md` — CLI command playbook
- **Case:** `docs/playbooks/cross-repo-update.md` — cross-repo update playbook
- **Case:** `docs/playbooks/README.md` — playbook index
- **Maestro:** `lib/working_memory.py` (from [Working Memory PRD](maestro-working-memory.md)) — source of context for playbook-driven flows
- **Maestro:** `lib/repo_probe.py` (from [Repo Onboarding PRD](maestro-repo-onboarding.md)) — detects repo type, informs playbook selection

## Out of Scope

- **Playbook versioning** — no `version: 1` field. If we change a playbook, flows use the new version. Could add a "playbook snapshot in working memory" feature for traceability.
- **Playbook composition** — combining playbooks (e.g., `fix-bug` + `add-test`) is supported via the list spec, but no composition DSL. Defer.
- **Playbook enforcement** — playbooks are advisory text injected into prompts. We don't mechanically check that the agent followed the steps. Could add a "playbook compliance checker" that reviews the agent's transcript.
- **Playbook editor UI** — no TUI panel for editing playbooks. Use any text editor.
- **Playbook analytics** — `maestro playbook stats` showing which playbooks are most used, which lead to success, etc. Defer.
- **Conditional playbook sections** — e.g., "if the issue has a 'regression' label, include this section." Defer; can be done with simple string substitution later.

## Further Notes

### Why playbooks separate from prompts?

Prompts define **role** ("you are a builder"). Playbooks define **workflow** ("follow these steps"). A builder prompt + a fix-bug playbook = a builder that follows the bug-fix workflow. A builder prompt + an add-feature playbook = a builder that follows the feature-addition workflow. Mixing them into one document would be rigid (one role, one workflow).

### Why markdown, not YAML or JSON?

Case uses markdown, and it's the right call:
- Easy to write and review (just a text file)
- Supports rich formatting (lists, code blocks, decision trees)
- Version-controllable (diffs are meaningful)
- Renders nicely in GitHub, IDEs, and terminals

YAML/JSON would be more structured but harder to read. Markdown is the right level of formality.

### Why per-repo override?

Different repos have different conventions. A monorepo might have a `monorepo-change.md` playbook that's more relevant than the default `add-feature.md`. Per-repo override lets each repo customize without forking the orchestrator.

### Why not auto-detect the playbook from the issue labels?

Tempting (e.g., `bug` label → `fix-bug` playbook), but:
- Issue labels are inconsistent across repos
- Some issues are ambiguous (is this a bug or a feature refactor?)
- Explicit is better than implicit — the user should choose the playbook

We could add a CLI flag (`--playbook fix-bug`) for explicit selection. Defer to a follow-up.

## Acceptance Criteria

- [ ] `playbooks/` directory with 4 default playbooks: `fix-bug.md`, `add-feature.md`, `add-cli-command.md`, `cross-repo-update.md`
- [ ] Flow JSON supports `"playbook": "fix-bug"` (string), `["fix-bug", "add-test"]` (list), or `"path/to/custom.md"` (path)
- [ ] `lib/playbook.py` exists with `load_playbook`, `resolve_playbooks`, `extract_reviewer_checklist`
- [ ] `flow_engine.py` injects `{playbook}` into the relevant phase's prompt
- [ ] Reviewer phase extracts `{reviewer_checklist}` from the playbook
- [ ] Repo-specific playbooks (`.maestro/playbooks/*.md`) override defaults
- [ ] `maestro playbook list/show/init` CLI commands work
- [ ] Onboarding-recommended playbooks are used as fallback when flow doesn't specify
- [ ] Backward compatible: flows without `playbook` field work as before
- [ ] New tests: `test_playbook.py` (10), `test_flow_playbook.py` (6), `test_integration_playbooks.py` (3)
- [ ] All existing tests pass
- [ ] Manual verification on at least 2 real issues demonstrates playbook-driven behavior
- [ ] Documentation: `README.md` updated with playbook documentation

## References

### Case
- `docs/playbooks/add-feature.md` — full feature playbook (~80 lines)
- `docs/playbooks/fix-bug.md` — bug fix playbook (~70 lines)
- `docs/playbooks/add-cli-command.md` — CLI command playbook
- `docs/playbooks/cross-repo-update.md` — cross-repo update playbook
- `docs/playbooks/README.md` — playbook index and usage docs
- `src/context/assembler.ts` — shows how playbook is injected into prompts

### Maestro
- `lib/working_memory.py` (new, from [Working Memory PRD](maestro-working-memory.md)) — context for playbook-driven flows
- `lib/repo_probe.py` (new, from [Repo Onboarding PRD](maestro-repo-onboarding.md)) — informs playbook selection
- `flow_engine.py:build_variables()` — to be extended with playbook injection
- `prompts/builder.tmpl` — to be updated to include `{playbook}` section
- `prompts/reviewer.tmpl` — to be updated to include `{reviewer_checklist}` section
- `tests/test_flow_engine.py` — example of flow execution tests

### Related PRDs in this set
- [Tool Allowlists](maestro-tool-allowlists.md) — playbooks may recommend specific tool sets per phase
- [Working Memory](maestro-working-memory.md) — playbook output (e.g., `reproducible: true`) is persisted to memory
- [Repo Onboarding](maestro-repo-onboarding.md) — `playbooks_recommended` is used as default
- [Retrospective](maestro-retrospective.md) — amendments can propose new playbook entries
