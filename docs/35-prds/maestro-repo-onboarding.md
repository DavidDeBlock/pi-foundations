# PRD: Repo Onboarding (Interviewer Agent + Project Registry)

> **Wave:** 2 (Quality & Learning)
> **Effort:** 1-2 days
> **Depends on:** [Tool Allowlists](maestro-tool-allowlists.md), [Working Memory](maestro-working-memory.md)
> **Required by:** [Playbooks](maestro-playbooks.md) (playbooks can be auto-recommended based on repo type)
> **Roadmap:** [maestro-case-improvements-roadmap.md](maestro-case-improvements-roadmap.md#8-prds-in-this-set)

---

## Problem Statement

Maestro currently treats every target repo as anonymous. When the builder runs, it has no knowledge of:

- The package manager (npm, pnpm, bun, poetry, uv, cargo, go)
- The test command (might be in `package.json`, `Makefile`, `pyproject.toml`, or just convention)
- The build command
- The lint command
- The evidence strategy (UI changes need Playwright; library changes need test output; infra changes need scenario scripts)
- The conventions (commit format, branch naming, file naming, import order)
- Past failures and workarounds specific to this repo

Every flow re-discovers this from scratch (or fails to discover it and produces broken work).

The **workos/case** project solves this with a dedicated **onboarding** step:

```bash
ca onboard <path>                    # mechanical probe only
ca onboard <path> --interview        # mechanical probe + interactive interview
ca onboard <repo> --re-interview     # update an existing entry by re-interviewing
```

The mechanical probe detects commands, package manager, and project type. The `--interview` flag runs an **interviewer agent** that asks the human (or another agent) about evidence strategy, conventions, and gotchas. The result is a `projects.json` entry plus a per-repo seed `.case/learnings.md`.

Subsequent runs read this context automatically.

## Solution

Add **Repo Onboarding** to Maestro:

1. New CLI command: `maestro onboard <path> [--interview]`
2. Mechanical probe: detect package manager, commands, project type, languages
3. Optional interview phase: agent asks the user clarifying questions
4. Write to `.maestro/projects.json` (registry of known repos)
5. Write per-repo context to `.maestro/repos/<repo-hash>.json` (or use the repo's own `.maestro/` directory)
6. Subsequent flows auto-load repo context (via [Working Memory PRD](maestro-working-memory.md))
7. Backward compatible: flows still work on un-onboarded repos (they just lack pre-loaded context)

**Two modes:**

- **`maestro onboard <path>`** (mechanical only): fast, no human in the loop, captures commands + project type. Good for CI/automation.
- **`maestro onboard <path> --interview`** (mechanical + interview): slower, runs an interviewer agent that asks 3-5 clarifying questions, captures evidence strategy and conventions. Good for first-time setup of a project you'll work on repeatedly.

## User Stories

1. As a Maestro operator, I want to onboard a repo once, so that subsequent flows have its commands and conventions pre-loaded
2. As a Maestro operator, I want a mechanical probe (no human in the loop), so that I can onboard repos in CI/scripted contexts
3. As a Maestro operator, I want an interview mode, so that I can capture subjective context (evidence strategy, conventions) that mechanical probing misses
4. As a Maestro operator, I want the onboarding to write a structured projects.json registry, so that I can list all onboarded repos
5. As a Maestro operator, I want the onboarding to write a per-repo context file, so that each repo's context is portable
6. As a Maestro operator, I want subsequent flows to auto-load repo context, so that the builder doesn't re-discover the test command
7. As a Maestro operator, I want to re-interview a repo, so that I can update its context as the project evolves
8. As a Maestro operator, I want onboarding to seed `.maestro/learnings.md` with initial observations, so that the retrospective phase has a starting point
9. As a Maestro operator, I want `maestro projects list` to show all onboarded repos with their context, so that I can audit my project registry
10. As a Maestro operator, I want onboarding to be idempotent (running twice doesn't duplicate), so that I can re-run safely

## Implementation Decisions

### New CLI Command: `maestro onboard`

```python
# maestro/commands/onboard.py
import click
import json
import hashlib
import subprocess
from pathlib import Path
from lib.repo_probe import probe_repo
from lib.projects_registry import ProjectsRegistry

PROJECTS_FILE = Path(".maestro/projects.json")


@click.command()
@click.argument("repo_path", type=click.Path(exists=True))
@click.option("--interview", is_flag=True, help="Run interviewer agent to capture subjective context")
@click.option("--re-interview", is_flag=True, help="Update existing entry with new interview")
@click.option("--alias", type=str, help="Friendly name for this repo (e.g., 'pos-backend')")
def onboard(repo_path, interview, re_interview, alias):
    """Onboard a repo: detect commands, capture context, register."""
    repo_path = Path(repo_path).resolve()
    registry = ProjectsRegistry(PROJECTS_FILE)
    repo_hash = hashlib.sha256(str(repo_path).encode()).hexdigest()[:12]

    # Step 1: Mechanical probe
    click.echo(f"Probing {repo_path}...")
    probe_data = probe_repo(repo_path)
    click.echo(f"  Detected: {probe_data['languages']}, package manager: {probe_data['package_manager']}")
    click.echo(f"  Test command: {probe_data['test_command']}")

    # Step 2: Interview (optional)
    interview_data = {}
    if interview or re_interview:
        click.echo("\nRunning interviewer agent...")
        from prompts.interviewer import build_interview_prompt
        from lib.rpc_client import run_rpc

        prompt = build_interview_prompt(repo_path, probe_data)
        result = run_rpc(prompt, timeout_seconds=600, model="claude-sonnet")
        interview_data = parse_interview_output(result)

    # Step 3: Build project entry
    entry = {
        "alias": alias or repo_path.name,
        "path": str(repo_path),
        "hash": repo_hash,
        "probed_at": now_iso(),
        "languages": probe_data["languages"],
        "package_manager": probe_data["package_manager"],
        "test_command": probe_data["test_command"],
        "build_command": probe_data["build_command"],
        "lint_command": probe_data["lint_command"],
        "frameworks": probe_data["frameworks"],
        "evidence_strategy": interview_data.get("evidence_strategy", "test-output"),
        "conventions": interview_data.get("conventions", []),
        "gotchas": interview_data.get("gotchas", []),
        "playbooks_recommended": interview_data.get("playbooks_recommended", []),
    }

    # Step 4: Register
    registry.upsert(entry)
    click.echo(f"\n✓ Registered '{entry['alias']}' in {PROJECTS_FILE}")

    # Step 5: Seed per-repo learnings
    learnings_path = repo_path / ".maestro" / "learnings.md"
    if not learnings_path.exists():
        learnings_path.parent.mkdir(parents=True, exist_ok=True)
        seed = generate_learnings_seed(entry, probe_data, interview_data)
        learnings_path.write_text(seed)
        click.echo(f"✓ Seeded {learnings_path}")

    click.echo(f"\nNext: run `maestro projects list` to see all onboarded repos")


def generate_learnings_seed(entry, probe_data, interview_data):
    """Generate a starter learnings file for the repo."""
    parts = [
        f"# Maestro Learnings — {entry['alias']}",
        "",
        f"_Seeded by `maestro onboard` on {now_iso()[:10]}_",
        "",
        "## Initial Observations (from onboarding)",
        "",
    ]
    parts.append(f"- **Package manager:** {probe_data['package_manager']}")
    parts.append(f"- **Test command:** `{probe_data['test_command']}`")
    parts.append(f"- **Evidence strategy:** {entry['evidence_strategy']}")
    if interview_data.get("conventions"):
        parts.append("- **Conventions:**")
        for c in interview_data["conventions"]:
            parts.append(f"  - {c}")
    if interview_data.get("gotchas"):
        parts.append("- **Gotchas:**")
        for g in interview_data["gotchas"]:
            parts.append(f"  - ⚠️ {g}")
    parts.append("")
    parts.append("## Runs")
    parts.append("")
    return "\n".join(parts)


def now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
```

### New Module: `lib/repo_probe.py`

```python
# lib/repo_probe.py
from pathlib import Path
import json
import subprocess
from dataclasses import dataclass, asdict, field

LANGUAGE_PATTERNS = {
    "python": ["*.py", "pyproject.toml", "setup.py", "requirements.txt"],
    "typescript": ["*.ts", "*.tsx", "tsconfig.json"],
    "javascript": ["*.js", "*.jsx", "package.json"],
    "rust": ["*.rs", "Cargo.toml"],
    "go": ["*.go", "go.mod"],
}

FRAMEWORK_INDICATORS = {
    "fastapi": ["fastapi"],
    "django": ["django"],
    "flask": ["flask"],
    "react": ["react", "react-dom"],
    "vue": ["vue"],
    "svelte": ["svelte"],
    "express": ["express"],
    "hono": ["hono"],
    "next": ["next"],
    "nuxt": ["nuxt"],
}


@dataclass
class ProbeResult:
    path: str
    languages: list[str] = field(default_factory=list)
    package_manager: str = ""
    test_command: str = ""
    build_command: str = ""
    lint_command: str = ""
    frameworks: list[str] = field(default_factory=list)
    is_git_repo: bool = False
    git_remote: str = ""

    def to_dict(self):
        return asdict(self)


def probe_repo(path: Path) -> ProbeResult:
    """Mechanically probe a repo to detect language, commands, frameworks."""
    result = ProbeResult(path=str(path))

    # Detect languages
    for lang, patterns in LANGUAGE_PATTERNS.items():
        for pattern in patterns:
            matches = list(path.glob(f"**/{pattern}"))[:5]  # Sample
            if matches:
                if lang not in result.languages:
                    result.languages.append(lang)
                break  # Found this language, no need to check more patterns

    # Detect package manager + commands
    if (path / "package.json").exists():
        pkg = json.loads((path / "package.json").read_text())
        scripts = pkg.get("scripts", {})
        result.test_command = scripts.get("test", "")
        result.build_command = scripts.get("build", "")
        result.lint_command = scripts.get("lint", "")
        # Detect lockfile
        if (path / "pnpm-lock.yaml").exists():
            result.package_manager = "pnpm"
        elif (path / "bun.lockb").exists() or (path / "bun.lock").exists():
            result.package_manager = "bun"
        elif (path / "yarn.lock").exists():
            result.package_manager = "yarn"
        elif (path / "package-lock.json").exists():
            result.package_manager = "npm"
        else:
            result.package_manager = "npm (assumed)"

        # Detect frameworks from dependencies
        all_deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        for framework, indicators in FRAMEWORK_INDICATORS.items():
            if any(ind in all_deps for ind in indicators):
                result.frameworks.append(framework)
    elif (path / "pyproject.toml").exists():
        result.package_manager = "python (pyproject.toml)"
        result.test_command = "pytest"  # common default
        # Could parse [tool.pytest.ini_options] for more detail
        toml_text = (path / "pyproject.toml").read_text()
        if "fastapi" in toml_text.lower():
            result.frameworks.append("fastapi")
        if "django" in toml_text.lower():
            result.frameworks.append("django")
    elif (path / "Cargo.toml").exists():
        result.package_manager = "cargo"
        result.test_command = "cargo test"
        result.build_command = "cargo build"
    elif (path / "go.mod").exists():
        result.package_manager = "go modules"
        result.test_command = "go test ./..."

    # Detect git
    if (path / ".git").exists():
        result.is_git_repo = True
        try:
            result.git_remote = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                cwd=path, capture_output=True, text=True, timeout=5,
            ).stdout.strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass

    return result
```

### New Module: `lib/projects_registry.py`

```python
# lib/projects_registry.py
from pathlib import Path
import json
import tempfile
import os


class ProjectsRegistry:
    """Thread-safe-ish read/write of the projects.json registry."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict:
        """Load the registry. Returns {alias: entry, ...}."""
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text())

    def save(self, registry: dict) -> None:
        """Save the registry atomically."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: write to temp file, then rename
        fd, tmp_path = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(registry, f, indent=2)
            os.rename(tmp_path, self.path)
        except Exception:
            os.unlink(tmp_path)
            raise

    def upsert(self, entry: dict) -> None:
        """Insert or update a project entry by hash."""
        registry = self.load()
        registry[entry["hash"]] = entry
        self.save(registry)

    def get(self, repo_hash: str) -> dict | None:
        """Get a project entry by hash."""
        return self.load().get(repo_hash)

    def get_by_path(self, repo_path: str) -> dict | None:
        """Get a project entry by path."""
        for entry in self.load().values():
            if entry["path"] == str(Path(repo_path).resolve()):
                return entry
        return None

    def remove(self, repo_hash: str) -> None:
        """Remove a project entry."""
        registry = self.load()
        registry.pop(repo_hash, None)
        self.save(registry)
```

### New Prompt: `prompts/interviewer.md`

```markdown
---
name: interviewer
description: Onboarding agent. Asks clarifying questions about a repo to capture subjective context (evidence strategy, conventions, gotchas).
tools: ['Read', 'Bash', 'Write']
timeout_seconds: 600
---

# Interviewer — Repo Onboarding Agent

You are onboarding a new repository for Maestro. Your job is to ask the user (via `AskUserQuestion` or similar) about subjective context that mechanical probing cannot detect.

## Input

You receive from the orchestrator:
- **Repo path:** {repo_path}
- **Mechanical probe results:** {probe_data_json}

The probe has detected:
- Languages: {languages}
- Package manager: {package_manager}
- Test command: {test_command}
- Frameworks: {frameworks}

## Workflow

Ask the user **3-5 clarifying questions** about the repo. Focus on:

### Question 1: Evidence Strategy

> "What evidence strategy should Maestro use for changes to this repo?"
>
> Options:
> - **test-output**: Automated test output only (good for libraries)
> - **ui-screenshot**: Playwright before/after screenshots (good for UI)
> - **scenario-script**: A consumer script that exercises the user-facing scenario

### Question 2: Conventions

> "Are there any conventions (commit format, file naming, import order) that Maestro should respect?"

Free-form text answer.

### Question 3: Gotchas

> "Are there any gotchas — things that have bitten you in the past, or that are easy to get wrong?"

Free-form text answer.

### Question 4: Recommended Playbooks

> "Which playbooks should be the default for issues in this repo?"
>
> Options (multi-select):
> - `fix-bug.md` — bug fix workflow
> - `add-feature.md` — feature addition workflow
> - `add-cli-command.md` — CLI command workflow
> - `cross-repo-update.md` — coordinated changes across repos

### Question 5 (optional): Primary Reviewer

> "Should the reviewer phase use a specific model, or is the default fine?"

Free-form text answer.

## Output

After asking questions, output a structured `PHASE_OUTPUT` block:

```
---
### PHASE_OUTPUT: success
{
  "evidence_strategy": "test-output",
  "conventions": [
    "conventional commits",
    "no default exports"
  ],
  "gotchas": [
    "migrations must be backwards-compatible",
    "tests require a running postgres on port 5432"
  ],
  "playbooks_recommended": ["fix-bug.md", "add-feature.md"],
  "primary_reviewer": "claude-sonnet"
}
### END_PHASE_OUTPUT
---
```

## Rules

- **DO NOT** edit any code file
- **DO NOT** run mutating commands
- Ask the minimum number of questions needed to capture the essentials
- If the user skips a question, use a sensible default
```

### New CLI Command: `maestro projects`

```python
# maestro/commands/projects.py
import click
import json
from pathlib import Path
from lib.projects_registry import ProjectsRegistry


@click.group()
def projects():
    """Manage the projects registry."""
    pass


@projects.command(name="list")
@click.option("--json", "as_json", is_flag=True)
def list_projects(as_json):
    """List all onboarded repos."""
    registry = ProjectsRegistry(Path(".maestro/projects.json"))
    data = registry.load()
    if as_json:
        click.echo(json.dumps(data, indent=2))
    else:
        if not data:
            click.echo("No projects onboarded. Run `maestro onboard <path>`.")
            return
        for entry in data.values():
            click.echo(f"\n{entry['alias']} ({entry['hash']})")
            click.echo(f"  Path: {entry['path']}")
            click.echo(f"  Languages: {', '.join(entry['languages'])}")
            click.echo(f"  Test: {entry['test_command']}")
            click.echo(f"  Evidence: {entry['evidence_strategy']}")


@projects.command()
@click.argument("repo_path", type=click.Path(exists=True))
def show(repo_path):
    """Show details for a specific repo."""
    from lib.projects_registry import ProjectsRegistry
    registry = ProjectsRegistry(Path(".maestro/projects.json"))
    entry = registry.get_by_path(str(Path(repo_path).resolve()))
    if not entry:
        click.echo(f"Repo {repo_path} is not onboarded")
        raise click.exceptions.Exit(1)
    click.echo(json.dumps(entry, indent=2))


@projects.command()
@click.argument("alias_or_hash", type=str)
def remove(alias_or_hash):
    """Remove a repo from the registry (does not delete the repo itself)."""
    registry = ProjectsRegistry(Path(".maestro/projects.json"))
    data = registry.load()
    # Find by alias or hash
    found = None
    for h, entry in data.items():
        if h == alias_or_hash or entry.get("alias") == alias_or_hash:
            found = h
            break
    if not found:
        click.echo(f"Project {alias_or_hash} not found")
        raise click.exceptions.Exit(1)
    registry.remove(found)
    click.echo(f"✓ Removed {alias_or_hash} from registry")
```

### Updated: `flow_engine.py` — Auto-Load Repo Context

```python
# flow_engine.py — auto-load repo context
from lib.projects_registry import ProjectsRegistry

def run_flow(flow_config: dict, issue_num: int, repo_path: Path) -> dict:
    """Run a flow, auto-loading repo context from projects registry."""
    # Auto-load repo context if registered
    registry = ProjectsRegistry(Path(".maestro/projects.json"))
    repo_entry = registry.get_by_path(str(repo_path.resolve()))

    context = {}
    if repo_entry:
        context["repo_context"] = {
            "alias": repo_entry["alias"],
            "languages": repo_entry["languages"],
            "test_command": repo_entry["test_command"],
            "build_command": repo_entry["build_command"],
            "lint_command": repo_entry["lint_command"],
            "evidence_strategy": repo_entry["evidence_strategy"],
            "conventions": repo_entry.get("conventions", []),
            "gotchas": repo_entry.get("gotchas", []),
            "playbooks_recommended": repo_entry.get("playbooks_recommended", []),
        }
        log(f"[onboard] Loaded context for {repo_entry['alias']}")
    else:
        log(f"[onboard] No context for {repo_path}; run `maestro onboard` to register")

    # ... rest of run_flow ...
```

### Updated: `prompts/builder.md` — Inject Repo Context

```markdown
# Builder — Implementation Agent

## Repo Context (from onboarding)

{repo_context_json}

## Prefetched Repo Context

{prefetched_context}

[... existing prompt ...]
```

## Testing Decisions

### Unit Tests

**`tests/test_repo_probe.py`** (new, ~10 tests):
- `test_probe_detects_python_repo`
- `test_probe_detects_typescript_repo`
- `test_probe_detects_pnpm_package_manager`
- `test_probe_detects_bun_package_manager`
- `test_probe_detects_fastapi_framework`
- `test_probe_detects_react_framework`
- `test_probe_extracts_test_command_from_package_json`
- `test_probe_handles_repo_without_package_json`
- `test_probe_detects_git_remote`
- `test_probe_handles_non_git_directory`

**`tests/test_projects_registry.py`** (new, ~8 tests):
- `test_load_empty_registry`
- `test_upsert_new_entry`
- `test_upsert_existing_entry_overwrites`
- `test_get_by_path_returns_correct_entry`
- `test_remove_deletes_entry`
- `test_save_is_atomic`
- `test_registry_survives_corrupt_file_with_backup`
- `test_multiple_entries_with_unique_hashes`

**`tests/test_onboard_command.py`** (new, ~6 tests):
- `test_onboard_creates_registry_entry`
- `test_onboard_seeds_learnings_file`
- `test_onboard_idempotent_does_not_duplicate`
- `test_onboard_with_interview_captures_evidence_strategy`
- `test_re_interview_updates_existing_entry`
- `test_onboard_handles_non_git_directory`

### Integration Tests

**`tests/test_integration_onboarding.py`** (new, ~3 tests):
- `test_end_to_end_onboard_then_flow` — onboard a real repo, then run a flow, verify context is auto-loaded
- `test_onboard_with_interview_runs_agent` — mock the agent, verify the prompt is built correctly
- `test_projects_list_shows_onboarded_repos`

### Manual Verification

- [ ] Onboard a real Python repo; verify `projects.json` is created with correct probe data
- [ ] Onboard a real TypeScript repo; verify frameworks are detected
- [ ] Run `maestro onboard <path> --interview`; verify the interviewer agent asks the expected questions
- [ ] Run `maestro projects list`; verify all onboarded repos are shown
- [ ] Run a flow on an onboarded repo; verify `repo_context` is injected into the builder's prompt
- [ ] Re-onboard an existing repo; verify no duplicates are created
- [ ] Run `maestro onboard <path> --re-interview`; verify the existing entry is updated

### Prior Art

- **Case:** `src/commands/onboard.ts` — `ca onboard` command with mechanical + interview modes
- **Case:** `agents/interviewer.md` — full interviewer agent (162 lines)
- **Case:** `projects.schema.json` — JSON schema for `projects.json`
- **Case:** `src/interview/findings.ts` — interview findings schema
- **Case:** `src/interview/writers.ts` — writes seed `.case/learnings.md` and `CLAUDE.local.md`
- **Maestro:** `lib/repo_probe.py` (new) — mechanical probing
- **Maestro:** `lib/working_memory.py` (from [Working Memory PRD](maestro-working-memory.md)) — context storage

## Out of Scope

- **Cross-repo coordination** — Case has `cross-repo-update.md` playbook for coordinated changes. We add a `playbooks_recommended` field but don't implement the cross-repo logic in this PRD. That's a [Playbooks PRD](maestro-playbooks.md) follow-up.
- **CLAUDE.local.md generation** — Case writes a `CLAUDE.local.md` per-repo for Claude-specific instructions. Maestro doesn't target Claude specifically; it uses its own prompt system. Could add later.
- **Remote repo onboarding** — `maestro onboard https://github.com/...` is out of scope. We only onboard local paths.
- **Auto-onboarding** — running onboarding automatically on first flow is risky. User must explicitly onboard.
- **Interviewer agent memory** — the interviewer could remember previous interviews and skip questions. Defer.
- **Multi-user interviews** — if multiple humans onboard the same repo, their answers could conflict. Defer (single-user assumption).

## Further Notes

### Why per-repo context (not global)?

Each repo has its own conventions. A global `~/.maestro/projects.json` (Case's design) would work, but per-project `.maestro/` keeps the context portable — if the project moves, the context moves with it.

### Why mechanical + interview (not interview-only)?

Mechanical probing is **fast, deterministic, and requires no human** — perfect for CI/scripted contexts. Interview is **slow and subjective** — perfect for first-time setup of a project you'll work on repeatedly. Both are useful; the flag selects which to run.

### Why not auto-onboard on first flow?

Auto-onboarding adds magic and risk:
- First-flow experience becomes "what is this writing to my project?"
- The user might not want a `.maestro/` directory in their repo
- Silent context loading makes flows harder to debug

Explicit `maestro onboard` is safer.

### Why atomic writes with `tempfile` + `os.rename`?

Same pattern as `state_manager.py` and `working_memory.py` — atomic writes prevent corruption on crash. We use `tempfile.mkstemp` (instead of `.tmp` + rename) because it's more robust on filesystems that don't support rename-over-existing-file (e.g., some network filesystems).

## Acceptance Criteria

- [ ] `maestro onboard <path>` CLI command exists (mechanical mode)
- [ ] `maestro onboard <path> --interview` runs the interviewer agent
- [ ] `lib/repo_probe.py` detects language, package manager, frameworks, test command
- [ ] `.maestro/projects.json` is created/updated with the entry
- [ ] Per-repo `.maestro/learnings.md` is seeded with initial observations
- [ ] `lib/projects_registry.py` provides atomic read/write
- [ ] `prompts/interviewer.md` exists with interview questions
- [ ] `maestro projects list/show/remove` CLI commands work
- [ ] `flow_engine.py` auto-loads repo context for onboarded repos
- [ ] Onboarding is idempotent (re-running doesn't duplicate)
- [ ] Re-interview updates the existing entry
- [ ] New tests: `test_repo_probe.py` (10), `test_projects_registry.py` (8), `test_onboard_command.py` (6), `test_integration_onboarding.py` (3)
- [ ] All existing tests pass
- [ ] Manual verification: onboard 2-3 real repos with different stacks
- [ ] Documentation: `README.md` updated with onboarding documentation

## References

### Case
- `src/commands/onboard.ts` — `ca onboard` command implementation
- `agents/interviewer.md` — full interviewer agent definition
- `projects.schema.json` — schema for the projects registry
- `src/interview/findings.ts` — interview findings schema
- `src/interview/session.ts` — interview session management
- `src/interview/writers.ts` — writes seed `.case/learnings.md` and `CLAUDE.local.md`
- `src/commands/onboard.ts:onInterview()` — the `--interview` flag handler

### Maestro
- `lib/state_manager.py` — atomic write pattern (tempfile + rename)
- `lib/working_memory.py` (new, from [Working Memory PRD](maestro-working-memory.md)) — per-issue context
- `flow_engine.py:build_variables()` — to be extended with `repo_context`
- `prompts/builder.tmpl` — to be updated to inject repo context
- `tests/test_pipeline_context.py` — example of context-related tests
- `config.json` — existing config pattern (compare to projects.json)

### Related PRDs in this set
- [Tool Allowlists](maestro-tool-allowlists.md) — interviewer agent has constrained tools
- [Working Memory](maestro-working-memory.md) — repo context is loaded into working memory
- [Evidence Gates](maestro-evidence-gates.md) — onboarded `evidence_strategy` configures per-flow evidence policy
- [Playbooks](maestro-playbooks.md) — `playbooks_recommended` from onboarding is used by playbook selection
- [Retrospective](maestro-retrospective.md) — seeded `.maestro/learnings.md` is the starting point for retrospectives
