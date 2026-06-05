# PRD: Working Memory (Per-Task Structured Context) + Context Prefetch

> **Wave:** 1 (Foundation)
> **Effort:** 2-3 hours
> **Depends on:** nothing (but benefits from [Tool Allowlists](maestro-tool-allowlists.md))
> **Required by:** [Scout Phase](maestro-scout-phase.md), [Retrospective](maestro-retrospective.md), [Repo Onboarding](maestro-repo-onboarding.md)
> **Roadmap:** [maestro-case-improvements-roadmap.md](maestro-case-improvements-roadmap.md#8-prds-in-this-set)

---

## Problem Statement

Maestro's only inter-phase context mechanism is `previous_output` — a single string overwritten by each phase's result. This creates three problems:

1. **Lossy context:** When the reviewer says "missing edge case in line 47," the next builder iteration gets the full reviewer text, not just the actionable critique. The builder has to re-parse natural language to find what to fix.
2. **No cross-phase query:** To answer "which files has the builder touched so far?" we have to grep the entire session log. There's no structured record.
3. **No persistence across flows:** If a flow fails and gets retried 3 days later, all `previous_output` is gone. The new builder starts from scratch, re-discovering what the previous attempt already learned.

The **workos/case** project solves this with a per-task `working-memory.ts` module — a structured JSON file per task that accumulates what each agent learned and survives across phases, retries, and even restarts. Combined with `src/context/prefetch.ts` (which pre-fetches repo context before the implementer runs), the implementer starts each phase with a curated, queryable view of the task's history.

## Solution

Add a **Working Memory** layer to Maestro:

1. Per-task JSON file at `.maestro/tasks/active/<issue>.memory.json`
2. Accumulator API: phases write structured updates (not just strings)
3. Read API: phases can query what other phases have done
4. Persistence: survives across flow restarts and retries
5. **Context Prefetch** (folded in): before the builder runs, prefetch static repo context (commands, conventions, dependencies) and inject it

**Schema is loose, not strict:** We don't want to fail when an agent writes a field we didn't anticipate. Unknown fields are stored as-is. Missing fields default to empty. This matches Case's `working-memory.ts` philosophy: "lenient on order, strict on shape, tolerant of evolution."

**Working Memory is additive, not replacement:** `previous_output` continues to work. Working Memory is a parallel, structured channel.

## User Stories

1. As a Maestro operator, I want per-task structured memory that persists across retries, so that the builder doesn't re-discover what previous attempts already learned
2. As a builder phase, I want to read the reviewer's structured feedback (not just a string), so that I can act on specific issues without re-parsing natural language
3. As a reviewer phase, I want to read what the builder did (files touched, tests run, test results), so that I can review informed by actual work
4. As a retrospective phase, I want to read the full task history, so that I can identify recurring failure patterns
5. As a Maestro operator, I want to inspect working memory for any past run via CLI, so that I can debug "what did the builder know when it made this decision?"
6. As a Maestro operator, I want static repo context (test command, build command, dependencies) prefetched before the builder runs, so that the builder doesn't waste time on `cat package.json`
7. As a Maestro developer, I want working memory to be schema-tolerant, so that adding new fields doesn't break old runs
8. As a Maestro operator, I want working memory to be a single source of truth per issue, so that retry logic can be deterministic
9. As a Maestro operator, I want prefetched context cached by git SHA, so that retries don't re-fetch unchanged files

## Implementation Decisions

### New Module: `lib/working_memory.py`

```python
# lib/working_memory.py
from pathlib import Path
import json
import time
from dataclasses import dataclass, field, asdict
from typing import Any

MEMORY_DIR = Path(".maestro/tasks/active")


@dataclass
class WorkingMemory:
    """Per-issue structured memory. Persisted as JSON."""
    issue: int
    created_at: str = ""
    updated_at: str = ""
    repo_path: str = ""
    git_sha: str = ""

    # Phase outputs (one section per phase name)
    scout: dict = field(default_factory=dict)
    builder: dict = field(default_factory=dict)
    reviewer: dict = field(default_factory=dict)
    test_runner: dict = field(default_factory=dict)
    diagnostic: dict = field(default_factory=dict)
    retrospective: dict = field(default_factory=dict)

    # Cross-cutting
    files_touched: list[str] = field(default_factory=list)
    test_results: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    notes: list[dict] = field(default_factory=list)  # Free-form annotations

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "WorkingMemory":
        """Construct from a dict, tolerating unknown/missing fields."""
        # Filter to known fields only
        known_fields = {f for f in cls.__dataclass_fields__}
        filtered = {k: v for k, v in d.items() if k in known_fields}
        return cls(**filtered)


class MemoryStore:
    """Read/write working memory for a specific issue."""

    def __init__(self, issue_num: int, memory_dir: Path = MEMORY_DIR):
        self.issue_num = issue_num
        self.path = memory_dir / f"{issue_num}.memory.json"

    def load(self) -> WorkingMemory:
        """Load memory from disk, or return empty WorkingMemory if file doesn't exist."""
        if not self.path.exists():
            return WorkingMemory(issue=self.issue_num, created_at=now_iso())
        try:
            data = json.loads(self.path.read_text())
            return WorkingMemory.from_dict(data)
        except (json.JSONDecodeError, KeyError) as e:
            # Corrupt file — back it up and start fresh
            backup = self.path.with_suffix(f".corrupt.{int(time.time())}.json")
            self.path.rename(backup)
            log(f"[memory] Corrupt memory backed up to {backup}: {e}")
            return WorkingMemory(issue=self.issue_num, created_at=now_iso())

    def save(self, memory: WorkingMemory) -> None:
        """Persist memory to disk atomically (write to .tmp, then rename)."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        memory.updated_at = now_iso()
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(memory.to_dict(), indent=2))
        tmp.rename(self.path)

    def update_phase(self, phase_name: str, data: dict) -> WorkingMemory:
        """Update a specific phase's section. Merges with existing data."""
        memory = self.load()
        if not hasattr(memory, phase_name):
            # Unknown phase — store in notes as a warning
            memory.notes.append({"type": "unknown_phase", "phase": phase_name, "data": data})
        else:
            existing = getattr(memory, phase_name) or {}
            existing.update(data)
            setattr(memory, phase_name, existing)
        self.save(memory)
        return memory

    def append_file_touched(self, file_path: str) -> None:
        """Record that a file was touched (deduplicates)."""
        memory = self.load()
        if file_path not in memory.files_touched:
            memory.files_touched.append(file_path)
            self.save(memory)

    def append_test_result(self, result: dict) -> None:
        """Record a test run result."""
        memory = self.load()
        memory.test_results.append({"timestamp": now_iso(), **result})
        self.save(memory)

    def append_error(self, phase: str, error: str) -> None:
        """Record an error for retrospective analysis."""
        memory = self.load()
        memory.errors.append({"timestamp": now_iso(), "phase": phase, "error": error})
        self.save(memory)


def now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
```

### New Module: `lib/context_prefetch.py`

Pre-fetches static repo context before the builder runs. Caches by git SHA.

```python
# lib/context_prefetch.py
from pathlib import Path
import json
import hashlib
import subprocess
from dataclasses import dataclass, asdict

CACHE_DIR = Path(".maestro/prefetch_cache")


@dataclass
class PrefetchedContext:
    """Static repo context, computed once per git SHA."""
    git_sha: str
    test_command: str = ""
    build_command: str = ""
    lint_command: str = ""
    package_manager: str = ""
    dependencies: dict = field(default_factory=dict)  # name -> version
    scripts: dict = field(default_factory=dict)  # name -> command (from package.json)
    test_files: list[str] = field(default_factory=list)  # discovered test files
    convention_hints: list[str] = field(default_factory=list)  # e.g., "uses pytest"


def get_git_sha(repo_path: Path) -> str:
    """Get current git SHA, or 'unknown' if not a git repo."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return "unknown"


def cache_key(repo_path: Path, git_sha: str) -> Path:
    """Cache file path keyed on repo path + git SHA."""
    repo_hash = hashlib.sha256(str(repo_path.resolve()).encode()).hexdigest()[:8]
    return CACHE_DIR / f"{repo_hash}-{git_sha}.json"


def prefetch_context(repo_path: Path) -> PrefetchedContext:
    """Prefetch static repo context, using cache if available."""
    git_sha = get_git_sha(repo_path)
    cache_path = cache_key(repo_path, git_sha)

    if cache_path.exists():
        return PrefetchedContext(**json.loads(cache_path.read_text()))

    # Detect package manager
    pkg_manager = ""
    if (repo_path / "package.json").exists():
        pkg_manager = "npm/pnpm/bun"  # could check lockfile
    elif (repo_path / "pyproject.toml").exists() or (repo_path / "setup.py").exists():
        pkg_manager = "python"
    elif (repo_path / "Cargo.toml").exists():
        pkg_manager = "rust"
    elif (repo_path / "go.mod").exists():
        pkg_manager = "go"

    # Extract commands and dependencies
    test_cmd = build_cmd = lint_cmd = ""
    scripts = {}
    deps = {}
    if pkg_manager.startswith("npm") or pkg_manager in ("pnpm", "bun"):
        pkg = json.loads((repo_path / "package.json").read_text())
        scripts = pkg.get("scripts", {})
        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        test_cmd = scripts.get("test", "")
        build_cmd = scripts.get("build", "")
        lint_cmd = scripts.get("lint", "")
    elif pkg_manager == "python":
        # Heuristics: pytest if pytest.ini/pyproject.toml has [tool.pytest.ini_options]
        test_cmd = "pytest"
        # Could parse pyproject.toml for more detail

    # Discover test files (top-level glob, capped at 20)
    test_files = []
    for pattern in ["**/*.test.ts", "**/*.test.js", "**/*.spec.ts", "**/test_*.py", "**/*_test.py"]:
        test_files.extend(str(p.relative_to(repo_path)) for p in repo_path.glob(pattern) if p.is_file())
        if len(test_files) >= 20:
            break
    test_files = test_files[:20]

    # Convention hints
    hints = []
    if (repo_path / ".eslintrc.json").exists() or (repo_path / "eslint.config.js").exists():
        hints.append("uses ESLint")
    if (repo_path / "tsconfig.json").exists():
        hints.append("TypeScript project")
    if (repo_path / "bunfig.toml").exists():
        hints.append("uses Bun runtime")
    if (repo_path / "Dockerfile").exists():
        hints.append("has Dockerfile")

    ctx = PrefetchedContext(
        git_sha=git_sha,
        test_command=test_cmd,
        build_command=build_cmd,
        lint_command=lint_cmd,
        package_manager=pkg_manager,
        dependencies=deps,
        scripts=scripts,
        test_files=test_files,
        convention_hints=hints,
    )

    # Cache it
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(asdict(ctx), indent=2))

    return ctx


def format_prefetched_context(ctx: PrefetchedContext) -> str:
    """Render as a markdown block for prompt injection."""
    parts = ["## Prefetched Repo Context", ""]
    if ctx.package_manager:
        parts.append(f"**Package manager:** {ctx.package_manager}")
    if ctx.test_command:
        parts.append(f"**Test command:** `{ctx.test_command}`")
    if ctx.build_command:
        parts.append(f"**Build command:** `{ctx.build_command}`")
    if ctx.lint_command:
        parts.append(f"**Lint command:** `{ctx.lint_command}`")
    if ctx.convention_hints:
        parts.append("")
        parts.append("**Convention hints:**")
        for h in ctx.convention_hints:
            parts.append(f"- {h}")
    if ctx.test_files:
        parts.append("")
        parts.append("**Test files (sample):**")
        for f in ctx.test_files[:10]:
            parts.append(f"- `{f}`")
    if ctx.dependencies:
        parts.append("")
        parts.append(f"**Dependencies:** {len(ctx.dependencies)} packages")
    return "\n".join(parts)
```

### Updated: `flow_engine.py` — Working Memory Integration

```python
# flow_engine.py — new imports and integration
from working_memory import MemoryStore, WorkingMemory
from context_prefetch import prefetch_context, format_prefetched_context


def run_flow(flow_config: dict, issue_num: int, repo_path: Path) -> dict:
    """Run a flow on an issue, with working memory and prefetch."""
    memory = MemoryStore(issue_num).load()

    # Context prefetch (once per flow)
    prefetched = prefetch_context(repo_path)
    memory.git_sha = prefetched.git_sha
    memory.repo_path = str(repo_path.resolve())
    MemoryStore(issue_num).save(memory)

    context = {
        "scout_findings": "(No scout findings yet)",
        "prefetched_context": format_prefetched_context(prefetched),
        "working_memory": memory.to_dict(),
    }

    current_phase = first_phase(flow_config, scout_enabled=flow_config.get("scout_enabled", False))
    while current_phase != "finish":
        result = run_phase(current_phase, flow_config, issue_num, context)
        # Update working memory with this phase's structured output
        MemoryStore(issue_num).update_phase(current_phase, result)
        # Append errors if any
        if result["status"] in ("error", "system_error"):
            MemoryStore(issue_num).append_error(current_phase, result.get("details", ""))
        # Update context for next phase
        context["working_memory"] = MemoryStore(issue_num).load().to_dict()
        context["previous_output"] = result.get("details", "")
        current_phase = get_next_step(flow_config["transitions"], current_phase, result["status"])

    return context["working_memory"]


def build_variables(phase_name, flow_config, issue_num, context):
    variables = {
        "issue_number": issue_num,
        "issue_body": fetch_issue_body(issue_num),  # existing
        "previous_output": context.get("previous_output", ""),
        "scout_findings": context.get("scout_findings", ""),
        "prefetched_context": context.get("prefetched_context", ""),
        "working_memory_json": json.dumps(context.get("working_memory", {}), indent=2),
    }
    return variables
```

### Updated Prompts: Inject Prefetched Context + Working Memory

```markdown
<!-- prompts/builder.md — new section at the top -->
# Builder — Implementation Agent

## Prefetched Repo Context

{prefetched_context}

## Working Memory (from previous phases)

```json
{working_memory_json}
```

## Scout Findings

{scout_findings}

## Task

You are implementing a fix or feature for issue #{issue_number}.

{issue_body}

## Workflow

1. Review the prefetched context (test command, build command, etc.)
2. Review the working memory (what previous phases have done)
3. Review the scout findings (relevant files, patterns, risks)
4. Write failing tests first (TDD)
5. Implement the minimal change
6. Run the test command from the prefetched context
7. Commit with a conventional message

[... rest of existing builder prompt ...]
```

### New CLI Commands

```bash
# View working memory for an issue
maestro memory show 42

# Pretty-print working memory as JSON
maestro memory show 42 --json

# Clear working memory for an issue (force fresh start)
maestro memory clear 42

# List all issues with working memory
maestro memory list
```

```python
# maestro/commands/memory.py
import click
from pathlib import Path
from lib.working_memory import MemoryStore

@click.group()
def memory():
    """Inspect and manage working memory."""
    pass

@memory.command()
@click.argument("issue_num", type=int)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def show(issue_num, as_json):
    """Show working memory for an issue."""
    mem = MemoryStore(issue_num).load()
    if as_json:
        click.echo(json.dumps(mem.to_dict(), indent=2))
    else:
        click.echo(format_memory_markdown(mem))

@memory.command()
@click.argument("issue_num", type=int)
@click.confirmation_option(prompt="Are you sure you want to clear working memory?")
def clear(issue_num):
    """Clear working memory for an issue."""
    store = MemoryStore(issue_num)
    if store.path.exists():
        store.path.unlink()
    click.echo(f"Cleared working memory for issue #{issue_num}")

@memory.command()
def list():
    """List all issues with working memory."""
    memory_dir = Path(".maestro/tasks/active")
    if not memory_dir.exists():
        click.echo("No working memory files found")
        return
    for path in sorted(memory_dir.glob("*.memory.json")):
        issue_num = path.stem.split(".")[0]
        mem = MemoryStore(int(issue_num)).load()
        click.echo(f"Issue #{issue_num} — last updated: {mem.updated_at}")
```

## Testing Decisions

### Unit Tests

**`tests/test_working_memory.py`** (new, ~12 tests):
- `test_load_creates_empty_memory_if_file_missing`
- `test_load_returns_existing_memory`
- `test_load_handles_corrupt_file_with_backup`
- `test_save_is_atomic_uses_tmp_rename`
- `test_update_phase_merges_with_existing_data`
- `test_update_phase_for_unknown_phase_goes_to_notes`
- `test_append_file_touched_deduplicates`
- `test_append_test_result_includes_timestamp`
- `test_append_error_records_phase_and_message`
- `test_from_dict_tolerates_unknown_fields`
- `test_from_dict_tolerates_missing_optional_fields`
- `test_working_memory_survives_across_save_load_cycle`

**`tests/test_context_prefetch.py`** (new, ~8 tests):
- `test_get_git_sha_returns_head_sha`
- `test_get_git_sha_returns_unknown_for_non_git_repo`
- `test_cache_key_is_deterministic_for_same_repo_and_sha`
- `test_prefetch_context_uses_cache_when_available`
- `test_prefetch_context_detects_npm_package_manager`
- `test_prefetch_context_detects_python_package_manager`
- `test_prefetch_context_extracts_test_command_from_package_json`
- `test_format_prefetched_context_includes_all_sections`

### Integration Tests

**`tests/test_integration_working_memory.py`** (new, ~4 tests):
- `test_working_memory_persists_across_flow_runs` — run a flow, then run it again, verify memory accumulates
- `test_working_memory_survives_simulated_restart` — save memory, create new MemoryStore instance, verify load
- `test_prefetched_context_injected_into_builder_prompt` — verify builder prompt contains prefetched section
- `test_working_memory_visible_to_retrospective` — simulate retrospective phase reading memory

### Manual Verification

- [ ] Run a builder-reviewer flow on a real issue; verify `.maestro/tasks/active/<issue>.memory.json` is created and updated
- [ ] Run `maestro memory show 42`; verify it pretty-prints the memory
- [ ] Restart a flow mid-run (kill and restart); verify memory persists and the new run picks up where the old one left off
- [ ] Inspect a builder's prompt; verify it contains the prefetched context section
- [ ] Run a flow on a non-git repo; verify prefetch returns `git_sha: "unknown"` and doesn't crash

### Prior Art

- **Case:** `src/memory/working-memory.ts` — `readWorkingMemory()` returns structured memory
- **Case:** `src/memory/format.ts` — `formatForImplementer()` renders memory as markdown
- **Case:** `src/context/prefetch.ts` — `prefetchRepoContext()` caches by git SHA
- **Case:** `src/context/assembler.ts` — `assemblePrompt()` combines scout findings + memory + prefetch + playbook
- **Maestro:** `lib/state_manager.py` — existing local state pattern (atomic write via `.tmp` + rename)
- **Maestro:** `lib/verdict_extractor.py` — pattern for tolerant parsing (regex + fallback)

## Out of Scope

- **Multi-issue memory** — one memory file per issue, no cross-issue aggregation. Could be added in a follow-up via `maestro memory aggregate`.
- **Memory versioning** — no schema version field. If we need to migrate, we can add `version: 1` later.
- **Memory diffing** — no `maestro memory diff <issue1> <issue2>`. Could be useful for comparing attempts.
- **Memory TTL** — no expiration. Files persist until manually cleared. Long-term retention is a follow-up.
- **Prefetch for non-JS projects** — this PRD handles JS/TS and Python. Other languages (Rust, Go) get basic detection but no deep introspection. Extending is per-language work.
- **Memory encryption** — working memory contains code snippets, not secrets. Not a concern.
- **Concurrent write safety** — `MemoryStore.save()` uses atomic rename, which is safe for single-writer. Multi-writer would need file locking. Out of scope.

## Further Notes

### Why JSON, not a database?

Case uses a JSON file because:
- Easy to inspect (`cat .maestro/tasks/active/42.memory.json`)
- Easy to back up (just copy the file)
- Easy to version (commit to git)
- No migration cost (just edit the file)

A SQLite database would add complexity without proportional value at this scale. We can migrate later if memory files get too large.

### Why a separate `lib/working_memory.py` instead of extending `lib/state_manager.py`?

`state_manager.py` is for **flow control state** (which phase are we in, retry counters, current verdict). Working memory is for **task content** (what agents have learned). Different lifecycles, different schemas, different access patterns. Keeping them separate is cleaner.

### Why context prefetch as a separate module?

Prefetch is **static, cacheable, deterministic** (modulo git SHA). Phase execution is **dynamic, ephemeral, agent-driven**. Mixing them would muddy responsibilities. Prefetch is also useful for non-Mastero tools (e.g., a future TUI dashboard could show prefetched context for any issue).

### Cache invalidation

Cache is keyed on `repo_path + git_sha`. When the SHA changes, a new cache file is created. Old files accumulate but are tiny (a few KB each). A `maestro prefetch clean` command (out of scope for this PRD) can prune them.

## Acceptance Criteria

- [ ] `lib/working_memory.py` exists with `MemoryStore` and `WorkingMemory` classes
- [ ] `lib/context_prefetch.py` exists with `prefetch_context()` and cache logic
- [ ] `.maestro/tasks/active/<issue>.memory.json` is created and updated on each phase run
- [ ] Working memory survives across flow restarts and retries
- [ ] `flow_engine.py` injects `{prefetched_context}` and `{working_memory_json}` into all phase prompts
- [ ] Prefetched context is cached by git SHA
- [ ] `maestro memory show/clear/list` CLI commands work
- [ ] Working memory is schema-tolerant (unknown fields preserved, missing fields default to empty)
- [ ] Corrupt memory files are backed up, not silently ignored
- [ ] New tests: `test_working_memory.py` (12), `test_context_prefetch.py` (8), `test_integration_working_memory.py` (4)
- [ ] All existing tests pass
- [ ] Manual verification on at least 2 real issues demonstrates persistence across retries
- [ ] Documentation: `README.md` updated with working memory and prefetch documentation

## References

### Case
- `src/memory/working-memory.ts` — `readWorkingMemory()` reads structured memory
- `src/memory/schema.ts` — schema definitions (loose validation)
- `src/memory/format.ts` — `formatForImplementer()` renders memory as markdown
- `src/context/prefetch.ts` — `prefetchRepoContext()` caches by git SHA
- `src/context/assembler.ts` — `assemblePrompt()` combines all context sources
- `src/phases/implement.ts:imports` — shows how working memory is read at the start of implement

### Maestro
- `lib/state_manager.py` — existing atomic-write pattern (`.tmp` + rename)
- `flow_engine.py:build_variables()` — to be extended with new variables
- `prompts/builder.tmpl` — to be updated with new context sections
- `lib/verdict_extractor.py` — example of tolerant parsing (regex with fallback)
- `tests/test_verdict_extractor.py` — example of comprehensive test structure for parsing logic

### Related PRDs in this set
- [Tool Allowlists](maestro-tool-allowlists.md) — working memory is read by phases that have specific tool sets
- [Scout Phase](maestro-scout-phase.md) — scout findings are persisted to working memory
- [Retrospective](maestro-retrospective.md) — retrospective reads the full working memory history
- [Repo Onboarding](maestro-repo-onboarding.md) — onboarding writes initial context to working memory
- [Evidence Gates](maestro-evidence-gates.md) — evidence files can reference working memory entries
