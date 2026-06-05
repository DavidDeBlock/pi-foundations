# Maestro — Configurable Loop Orchestrator for Pi Slices

Maestro replaces `run-slices.sh` with a configurable, testable Python-based orchestrator. It supports arbitrary loop topologies defined in JSON configuration files and uses GitHub comments as the message bus for inter-phase communication.

## Quick Start

```bash
# Run a flow on a specific issue (Single Issue Mode)
python3 .pi/maestro/orchestrate.py --flow builder-reviewer --issue 42

# Run autonomously across the backlog (Autonomous Loop Mode)
python3 .pi/maestro/orchestrate.py --flow builder-reviewer

# Inspect working memory, scout findings, evidence markers, learnings,
# and validate flow prompts (see Top-Level CLI section below for full details)
python3 .pi/maestro/maestro.py --help

# Register a repo for context auto-loading (one-time per repo)
maestro onboard . --interview --alias pi-pos-v1
```

---

## Architecture Overview

Maestro consists of **five layers**, plus a **per-domain CLI surface**:

| Layer | Directory/File | Purpose |
|-------|---------------|---------|
| **Entry Point** | `orchestrate.py` | CLI entry point & argument parsing |
| **App Shell** | `app_shell.py` | High-level workflow manager (modes, gap-check logic, autonomous loop) |
| **Flow Engine** | `flow_engine.py` | Core engine: runs flows on issues, manages phase transitions, enforces tool allowlists + evidence policies |
| **Pipelines** | `pipelines/` | Scriptable pipeline abstraction with context API and runner |
| **Dashboard** | `dashboard.py` + `panels/` + `lib/dashboard_api.py` | Interactive Textual UI for monitoring orchestrator state |
| **CLI Surface** | `commands/` + `maestro.py` | Top-level `maestro` Click group aggregating all subcommand groups (memory, scout, prompt, evidence, retrospective, onboard, projects) |

### Directory Structure

```
.pi/maestro/
├── flows/                    # JSON loop topology definitions (6 flows)
│   ├── builder-reviewer.json             # Standard Builder→Reviewer loop (scout → builder → test_runner → reviewer → close → retrospective → finish)
│   ├── builder-test-reviewer.json        # 3-phase loop (Builder → TestRunner → Reviewer → Retrospective → Finish)
│   ├── full-lifecycle.json               # End-to-end PRD-driven flow (issue-readiness → archivist → builder → reviewer → retrospective → finish)
│   ├── gap-check.json                    # PRD validation pipeline (Analyze → To-PRD → To-Issues) — audit flow, no retrospective
│   ├── prd-audit.json                    # Full PRD audit flow — audit flow, no retrospective
│   └── prd-to-issues-reviewer.json       # PRD-to-Issues review flow (issue-readiness → archivist → retrospective → finish)
├── commands/                 # Click CLI subcommand groups (mounted under top-level `maestro` group)
│   ├── memory.py                # `maestro memory {show,list,clear}` — working memory inspector
│   ├── scout.py                 # `maestro scout {show,list}` — scout findings inspector
│   ├── prompt.py                # `maestro prompt validate` — flow-level tool-allowlist enforcement check
│   ├── evidence.py              # `maestro {mark-tested,mark-reviewed,mark-manual-tested,evidence check,evidence show}` — evidence gates
│   ├── retrospective.py         # `maestro retrospective {run,show,patterns,amendments}` — learnings + recurring patterns
│   ├── onboard.py               # `maestro onboard <path> [--interview] [--re-interview] [--alias]` — register a repo
│   └── projects.py              # `maestro projects {list,show,remove}` — projects registry inspector
├── lib/                      # Python modules (17 files)
│   ├── comment_parser.py         # Parses strict PHASE_OUTPUT blocks from GitHub comments
│   ├── github_client.py          # Wraps `gh` CLI for issue/comment/label operations
│   ├── rpc_client.py             # Spawns Pi RPC client with JSON stdin protocol
│   ├── session_reader.py         # Parses JSONL agent session logs into structured summaries
│   ├── verdict_extractor.py      # Extracts phase verdicts from session log text (Phase 1+)
│   ├── state_manager.py          # Local resume/rollback state (JSON)
│   ├── terminal.py               # Formatted console output with tree layout & progress indicators
│   ├── dashboard_api.py          # Shared data layer for Dashboard UI (lazy GitHub init, flow loading)
│   ├── context_prefetch.py       # Caches static repo context (test/build commands, deps) keyed on git SHA
│   ├── working_memory.py         # Per-issue structured memory — JSON file in .maestro/tasks/active/<issue>.memory.json
│   ├── scout_findings.py         # ScoutFindings dataclass + parser + renderer for the scout phase
│   ├── evidence.py               # EvidenceStore + EvidenceMarker — SHA256-hashed, atomic-write evidence files
│   ├── learnings.py              # format_learning_entry, append_to_learnings, count_recurring_patterns
│   ├── repo_probe.py             # Mechanical probe: detects languages, package manager, frameworks, git remote
│   ├── projects_registry.py      # .maestro/projects.json CRUD with atomic writes (tempfile + os.rename)
│   └── prompt_loader.py          # Loads .md/.tmpl prompts, parses YAML frontmatter, enforces `tools:` allowlists
├── pipelines/                # Scriptable pipeline abstraction
│   ├── context.py              # PipelineContext: rich context object (vars, artifacts, error tracking)
│   ├── runner.py               # PipelineRunner: loads & executes .py pipeline scripts with retry logic
│   ├── autonomous.py           # Autonomous backlog processor (needs-triage → builder-reviewer → prd-audit)
│   ├── dashboard.py            # PipelineDashboard: progress bars, scorecards, live updates
│   └── dummy_pipeline.py       # Minimal example pipeline for testing the engine
├── panels/                   # Textual UI panel components (for dashboard.py)
│   ├── agent_input_panel.py        # Agent input capture and display
│   ├── control_bar.py              # Footer command bar with key bindings
│   ├── issues_panel.py             # GitHub Issues tab (clickable rows)
│   ├── live_monitor_panel.py       # Real-time pipeline status monitor
│   ├── orchestrator_controls.py    # Orchestrator action buttons
│   ├── session_browser_panel.py    # Session log browser and viewer
│   └── shared_detail_view.py       # Shared detail drawer for selected items
├── prompts/                  # Prompt templates — 15 `.md` (with YAML frontmatter declaring `tools:` & `timeout_seconds`) + 11 legacy `.tmpl` (backward compat)
│   ├── analyze.md / .tmpl          # Drift audit & gap analysis instructions
│   ├── archivist.md / .tmpl        # Repo context enrichment (reads docs/code, never edits)
│   ├── auditor.md / .tmpl          # PRD audit template
│   ├── builder.md / .tmpl          # Implementation & self-review instructions
│   ├── close.md                    # Mechanical close phase (local-only, `tools: []`) — evidence gate
│   ├── diagnostic.md / .tmpl       # Diagnostic pass after errors/repeated failures
│   ├── generate-issues.md / .tmpl  # Issue generation template
│   ├── interviewer.md              # Onboarding agent — asks 3–5 clarifying questions (`tools: [Read, Bash, Write]`)
│   ├── issue-readiness.md / .tmpl  # Pre-implementation issue quality check
│   ├── retrospective.md            # Self-improvement agent (`tools: [Read, Edit, Write, Grep, Glob]`, `is_optional: true`)
│   ├── reviewer.md / .tmpl         # Quality validation against acceptance criteria
│   ├── scout.md                    # Read-only exploration (`tools: [Read, Bash, Grep, Glob]`, 240s budget)
│   ├── test_runner.md / .tmpl      # Local test execution instructions
│   ├── to-issues.md / .tmpl        # Convert PRD/plan to GitHub issues
│   └── to-prd.md / .tmpl           # Convert plan/discussion to PRD format
├── tests/                    # Unit + integration tests (~36 files, ~480 tests)
│   ├── test_autonomous_pipeline.py       # Autonomous pipeline logic (7 tests)
│   ├── test_comment_parser.py            # Phase output parsing (3 tests)
│   ├── test_github_client.py             # GitHub client operations (14 tests)
│   ├── test_integration_data_layer.py    # Data layer integration (3 tests)
│   ├── test_pipeline_context.py          # PipelineContext class (15 tests)
│   ├── test_pipeline_dashboard.py        # Dashboard rendering (6 tests)
│   ├── test_pipeline_dashboard_extended.py # Extended dashboard tests (12 tests)
│   ├── test_pipeline_monitor_panel.py    # Monitor panel rendering (24 tests)
│   ├── test_pipeline_runner.py           # PipelineRunner engine (13 tests)
│   ├── test_run_single_flow.py           # Single flow execution (15 tests)
│   ├── test_verdict_extractor.py         # Verdict extraction (26 tests)
│   ├── test_verdict_regression.py        # Regression with real session logs (23 tests)
│   ├── test_dashboard_app.py             # Dashboard app shell (19 tests)
│   ├── test_session_browser.py           # Session browser panel (26 tests)
│   ├── test_context_prefetch.py          # Repo context prefetch cache (12 tests)
│   ├── test_working_memory.py            # Per-issue memory (12 tests)
│   ├── test_integration_working_memory.py # Working memory end-to-end (4 tests)
│   ├── test_scout_findings.py            # Scout findings parser/renderer (18 tests)
│   ├── test_flow_scout.py                # Scout flow integration (15 tests)
│   ├── test_integration_scout.py         # Scout end-to-end (4 tests)
│   ├── test_evidence.py                  # Evidence store + marker factories (23 tests)
│   ├── test_flow_evidence.py             # Evidence-aware flow engine (10 tests)
│   ├── test_integration_evidence_gates.py # Evidence gates end-to-end (15 tests)
│   ├── test_learnings.py                 # Learnings format/append/recurrence (16 tests)
│   ├── test_retrospective_phase.py       # Retrospective flow glue (10 tests)
│   ├── test_integration_retrospective.py # Retrospective end-to-end (9 tests)
│   ├── test_repo_probe.py                # Mechanical repo probe (31 tests)
│   ├── test_projects_registry.py         # Projects registry CRUD + atomicity (33 tests)
│   ├── test_onboard_command.py           # Onboard CLI (10 tests)
│   ├── test_integration_onboarding.py    # Onboarding end-to-end (14 tests)
│   ├── test_flow_engine_tools.py         # Flow-level tool-allowlist enforcement (5 tests)
│   ├── test_prompt_loader.py             # Prompt loader + frontmatter parsing (8 tests)
│   ├── test_integration_tool_enforcement.py # Tool enforcement end-to-end (3 tests)
│   ├── test_flow_engine_integration.py   # Flow engine end-to-end (10 tests)
│   ├── test_maestro_cli.py               # Top-level `maestro` Click group (15 tests)
├── scripts/                  # Python analysis toolkit — structured codebase introspection
│   ├── class-hierarchy.py            # Class inheritance tree scanner
│   ├── exports.py                    # Extract public API from .py files
│   ├── flow-info.py                  # Analyze flow JSON configs (phases + transitions)
│   ├── imports.py                    # Import dependency graph scanner
│   ├── pipeline-inspect.py           # Inspect pipeline scripts (setup/run, context vars)
│   └── session-summary.py            # Summarize JSONL session logs (model, ops, errors)
├── sessions/                 # Agent session logs (JSONL files)
│   └── <issue_num>/              # Grouped by issue number
│       └── <flow>-<phase>-<ISO8601>.jsonl/  # Nested: flow-phase-ts dir containing .jsonl file
├── config.json               # Runtime configuration (repo_override, gh_timeout, default_model/provider, session_dir)
├── orchestrate.py            # CLI entry point & argument parsing
├── app_shell.py              # High-level workflow manager (modes, gap-check logic, autonomous loop)
├── flow_engine.py            # Core engine: runs flows on issues, manages phase transitions
├── dashboard.py              # Interactive Textual UI for monitoring orchestrator state
├── cli-demo.py               # Demo script showcasing Rich library features (tables, syntax highlighting, live progress)
└── IMPLEMENTATION_PLAN.md    # Phased implementation roadmap
```

---

## Flow Configuration (`flows/*.json`)

Flows define the execution topology via phases and transition rules:

- **`phases`**: Named stages with skill/command config, model/provider overrides, timeouts, and retry limits.
- **`transitions`**: Rules mapping `{from_phase} + {status} → next_phase`. Supports `on_success`, `on_reject`, `on_error`, and domain-specific statuses like `on_no_gaps`.

### Example: Builder-Reviewer Loop (with scout, evidence gate, and retrospective)

```json
{
  "name": "builder-reviewer",
  "default_provider": "llama-cpp-3090",

  "scout_enabled": true,
  "scout_timeout_seconds": 240,

  "evidence_policy": {
    "required_on_success": ["tested", "reviewed"],
    "on_missing_evidence": "warn_but_proceed"
  },

  "phases": {
    "scout":         { "skill": "/skill:scout",        "timeout_seconds": 240,  "retries": 1 },
    "builder":       { "skill": "/skill:tdd",          "timeout_seconds": 1800, "retries": 3 },
    "test_runner":   { "skill": "/skill:test_runner",  "timeout_seconds": 600,  "retries": 1, "on_success_evidence": "tested" },
    "reviewer":      { "skill": "/skill:reviewer",     "timeout_seconds": 600,  "retries": 2 },
    "close":         { "is_local": true, "command": "python3 -m maestro.commands.evidence check {issue_num}", "timeout_seconds": 30 },
    "retrospective": { "skill": "/skill:retrospective","timeout_seconds": 300,  "retries": 0, "is_optional": true },
    "diagnostic":    { "skill": "/skill:debugger",     "timeout_seconds": 300,  "retries": 1 }
  },
  "transitions": [
    { "from": "scout",         "on_success": "builder", "on_reject": "builder", "on_error": "builder" },
    { "from": "builder",       "on_success": "test_runner", "on_reject": "builder", "on_error": "diagnostic" },
    { "from": "test_runner",   "on_success": "reviewer",    "on_reject": "builder", "on_error": "diagnostic" },
    { "from": "reviewer",      "on_success": "close",       "on_reject": "builder", "on_error": "diagnostic" },
    { "from": "close",         "on_success": "retrospective", "on_reject": "diagnostic", "on_error": "diagnostic" },
    { "from": "retrospective", "on_success": "finish", "on_reject": "finish", "on_error": "finish" }
  ]
}
```

### Flow-level flags (top-level keys)

| Flag | Default | Purpose |
|------|---------|---------|
| `scout_enabled` | `false` | When `true`, the flow runs the optional `scout` phase before `builder` (see [Scout Phase](#scout-phase-read-only-pre-builder-exploration)) |
| `scout_timeout_seconds` | `240` | Wall-clock budget for the scout phase |
| `evidence_policy.required_on_success` | `["tested", "reviewed"]` | Evidence markers the `close` phase mechanically checks for |
| `evidence_policy.on_missing_evidence` | `"warn_but_proceed"` | `block` (route to `diagnostic` on missing), `warn_but_proceed` (log + proceed), or `ignore` (skip check) |
| `phases.<name>.is_local` | `false` | When `true`, the phase runs a local `command` (no LLM) — used for `close` evidence gate |
| `phases.<name>.is_optional` | `false` | When `true`, failures are caught and converted to `success` — used for `retrospective` so learnings never break a flow |
| `phases.<name>.on_success_evidence` | — | When set on a phase (e.g. `test_runner`), the flow engine auto-writes the corresponding evidence marker on success |

### Available Flows (6 total)

| Flow | Description | Phases | Has retrospective? |
|------|-------------|--------|--------------------|
| `builder-reviewer` | Standard Builder→Reviewer loop with diagnostic fallback | scout → builder → test_runner → reviewer → close → **retrospective** → finish | yes |
| `builder-test-reviewer` | 3-phase loop: implementation, tests, review | builder → test_runner → reviewer → **retrospective** → finish | yes |
| `full-lifecycle` | End-to-end PRD-driven flow | issue-readiness → archivist → builder → reviewer → **retrospective** → finish | yes |
| `prd-to-issues-reviewer` | Convert PRDs to issues with review gate | issue-readiness → archivist → **retrospective** → finish | yes |
| `gap-check` | PRD validation pipeline (audit flow) | analyze → to-prd → to-issues | no (audit) |
| `prd-audit` | Full PRD audit flow (audit flow) | auditor | no (audit) |

---

## Strict Comment Format (Message Bus)

Phases communicate via GitHub comments with a strict markdown block format:

```markdown
---
### PHASE_OUTPUT: success|rejected|system_error
{details}
### END_PHASE_OUTPUT
---
```

`comment_parser.py` extracts the status and details using regex. `github_client.post_phase_comment()` generates these blocks. This makes GitHub the source of truth for state and inter-phase communication, enabling resume capability without relying solely on local files.

---

## Modes of Operation

### 1. Single Issue Mode
Processes one issue end-to-end through its flow topology. Stops when it hits `finish`, max retries exhausted, or an unrecoverable error. Posts final success/rejection comments to GitHub.

```bash
python3 orchestrate.py --flow builder-reviewer --issue 42
```

### 2. Autonomous Loop Mode (via pipelines/)
Runs continuously against the project backlog using the pipeline engine:

1. **Backlog Sweep**: Fetches all issues labeled `needs-triage` via `ctx.github.fetch_issues_by_label()`
2. **Slice Processing**: Runs `builder-reviewer` flow on each issue, closing them upon successful completion
3. **PRD Audit**: After backlog is empty, runs `prd-audit` flow on all open `parent-prd` issues
4. **Loop**: Returns to step 1 for newly created issues

```bash
python3 orchestrate.py --flow builder-reviewer    # Without --issue flag = autonomous mode
```

---

## Pipeline Abstraction (`pipelines/`)

Maestro supports a higher-level pipeline abstraction on top of flows. Pipelines are Python scripts that define `setup()` and/or `run()` functions, executed by `PipelineRunner` with rich context.

### PipelineContext API

Every pipeline step receives a `PipelineContext` object:

```python
def setup(ctx):
    ctx.set_variable("pipeline_name", "autonomous")
    
def run(ctx):
    # GitHub operations
    issues = ctx.github.fetch_issues_by_label("needs-triage")
    
    # Run flows within pipelines
    success = ctx.run_flow("builder-reviewer", issue.number)
    
    # Artifact management (hybrid in-memory/file storage, 50KB threshold)
    path = ctx.artifact_write("report", json_data)
    
    # Error recording
    ctx.record_error("phase_name", "error message")
```

### PipelineRunner

Loads and executes pipeline scripts with configurable retry logic:

```python
from pipelines.runner import PipelineRunner

runner = PipelineRunner(continue_on_error=True, max_retries=3)
pipeline = runner.load_pipeline("autonomous.py")
result = runner.execute_pipeline(pipeline, "autonomous")
```

---

## Interactive Dashboard (`dashboard.py`)

A full Textual-based terminal UI for monitoring Maestro in real-time:

- **Left pane**: Two tabs — GitHub Issues (clickable rows) and Session History
- **Right pane**: Live pipeline monitor with progress bars and scorecards
- **Footer**: Command input with key bindings (`q` quit, `r` refresh, `esc` clear detail)
- **Auto-refresh**: Issues every 60s, sessions every 30s, pipeline status every 2s

```bash
cd .pi/maestro && python3 dashboard.py
```

---

## Context Passing Between Phases

Maestro accumulates and injects context into prompt templates using variable substitution:

| Variable | Source |
|----------|--------|
| `{issue_number}` / `{issue_num}` | CLI argument or loop iteration |
| `{issue_body}` / `{body}` | GitHub issue body (fetched via `gh issue view`) |
| `{prd_body}` | Parent PRD body, extracted if issue contains `## Parent\n\n#NNN` |
| `{previous_output}` | Last phase's result summary (updated on each transition) |
| `{diagnostic_insights}` | Output from the diagnostic pass after errors or repeated failures |
| `{prefetched_context}` | Static repo context (commands, deps, conventions) computed once per git SHA — see [Working Memory & Context Prefetch](#working-memory--context-prefetch) |
| `{working_memory_json}` | Current state of the per-issue working memory (all phase outputs, files touched, errors) |
| `{scout_findings}` | Structured findings from the optional scout phase (markdown block) |
| `{flow_name}` | Name of the current flow (e.g. `builder-reviewer`) |
| `{final_status}` | Status of the most recent non-retrospective phase (used by retrospective) |
| `{repo_path}` | Target repo's root path (working memory's `repo_path` if set, else `Path.cwd()`) |
| `{repo_context}` | Per-repo JSON from `maestro onboard` (languages, package manager, test/build/lint commands, evidence strategy, conventions, gotchas) — see [Repo Onboarding](#repo-onboarding-per-repo-context-capture). Empty `{}` on un-onboarded repos |
| `{evidence_summary}` | One-line summary of evidence markers (e.g. `tested=verified, reviewed=missing`) — retrospective only — see [Evidence Gates](#evidence-gates-mechanical-quality-enforcement) |
| `{learnings_excerpt}` | Tail of the repo's `.maestro/learnings.md` (or default) — retrospective only |

Additional runtime variables: `{phase_name}`, `{verdict}`, `{session_dir}`, `{iso_ts}`, `{attempt_num}`, `{max_retries}`, etc.

Variables are injected into `.md` (preferred) or `.tmpl` (legacy) prompt files before sending to the RPC client. The `.md` form is required for tool allowlists — see [Tool Allowlists](#tool-allowlists-per-phase-tool-enforcement). If a template is missing entirely, `flow_engine.py` falls back to a default prompt structure.

---

## Working Memory & Context Prefetch

Per-issue structured memory survives across flow restarts, retries, and agent loops. The context prefetch module caches static repo info (test command, build command, dependencies, conventions) once per git SHA so the builder doesn't waste time on `cat package.json`.

Memory lives in `.maestro/tasks/active/<issue>.memory.json` as a single JSON file. It accumulates structured state across phases — not just strings — so the reviewer can read what the builder actually did, and the retrospective can scan the full task history.

### Inspecting memory

The top-level `maestro` CLI groups everything under one entry point. Both invocation styles below are supported — the `python3 -m commands.*` form is the older programmatic entry point; the `maestro` form is the user-facing one (see [Top-Level CLI](#top-level-cli-maestro-) below).

```bash
# User-facing (preferred): pretty-print working memory for issue #42
maestro memory show 42
python3 .pi/maestro/maestro.py memory show 42

# Or as raw JSON
maestro memory show 42 --json

# List every issue with a memory file
maestro memory list

# Clear a memory file (deletes the JSON; prompts for confirmation)
maestro memory clear 42
maestro memory clear 42 --yes   # skip confirmation
```

Use `--memory-dir <path>` (before the subcommand) to point at a non-default location:

```bash
maestro memory --memory-dir /tmp/foo list
maestro scout  --memory-dir /tmp/foo show 42
```

### How it's wired in

- `flow_engine.run_flow_on_issue()` loads/initialises the memory at flow start, computes the prefetched context once, and injects both into every phase prompt.

---

## Tool Allowlists (Per-Phase Tool Enforcement)

Every prompt template declares its tool surface in **YAML frontmatter**, replacing the old implicit "the LLM can do whatever it wants" model. The flow engine parses the frontmatter at load time, validates it against the phase role, and refuses to start the phase if the declared tools contradict the phase's intent.

### Prompt frontmatter format

```markdown
---
name: scout
description: Read-only exploration agent. Runs before the implementer to surface relevant files, patterns, and constraints.
tools: ['Read', 'Bash', 'Grep', 'Glob']
timeout_seconds: 240
---
```

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | yes | Phase identifier — must match a phase name in the flow JSON |
| `description` | yes | One-line summary shown in `maestro prompt validate` output |
| `tools` | yes | Closed allowlist of tool names the LLM may call. `[]` = local-only phase (e.g. `close`) |
| `timeout_seconds` | optional | Wall-clock budget. Defaults to the flow's global default if absent |

### Phase-by-phase allowlists

| Phase | Tools | Why |
|-------|-------|-----|
| `scout` | `['Read', 'Bash', 'Grep', 'Glob']` | Read-only exploration — no edits, no writes |
| `builder` | (declared per prompt) | Implementation — needs full read/write tool set |
| `test_runner` | `['Bash', 'Read']` | Runs the test command and inspects output |
| `reviewer` | `['Read', 'Grep', 'Glob']` | Quality check — no code changes, no execution |
| `close` | `[]` | Local-only evidence gate (no LLM) |
| `retrospective` | `['Read', 'Edit', 'Write', 'Grep', 'Glob']` | Read code, write to `.maestro/learnings.md` only |
| `interviewer` | `['Read', 'Bash', 'Write']` | Ask questions + write the projects.json entry |

### File format migration: `.tmpl` → `.md`

The old `.tmpl` files are kept for backward compatibility, but **new phases use `.md` with YAML frontmatter**. `lib/prompt_loader.py` looks up `<name>.md` first, falls back to `<name>.tmpl` if missing, and raises a clear error if neither exists. The tool allowlist is enforced on whichever file wins.

### Validating tool allowlists

```bash
# Validate one flow — checks every phase has a prompt, tools are syntactically valid, and
# tool names match the closed allowlist registered in the flow engine.
maestro prompt validate flows/builder-reviewer.json
maestro prompt validate flows/*.json --quiet
```

A non-zero exit code means at least one phase is missing a prompt, the frontmatter is malformed, or a phase declares a tool that the engine doesn't recognise. Add `--json` for machine-readable output suitable for CI gates.

### How it's wired in

- `lib/prompt_loader.py:load_prompt(phase_name, prompt_dir)` returns `(body, frontmatter)`; raises `PromptNotFoundError` if neither `<name>.md` nor `<name>.tmpl` exists.
- `flow_engine._validate_phase_tools(phase_name, declared_tools)` cross-checks the declared list against the closed registry (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `AskUserQuestion`, etc.).
- `flow_engine.run_phase()` injects the declared `tools` into the RPC client envelope so the LLM cannot call a tool that wasn't declared — enforcement happens at the RPC layer, not the prompt.

---

## Top-Level CLI (`maestro ...`)

All Maestro subcommands are mounted on a single top-level `maestro` Click group, exposed via `.pi/maestro/maestro.py`. The per-domain groups (`commands/memory.py`, `commands/scout.py`, `commands/prompt.py`, `commands/evidence.py`, `commands/retrospective.py`, `commands/onboard.py`, `commands/projects.py`) remain independently invokable as `python3 -m commands.<group> ...` — the top-level entry point is purely an aggregating front-end.

```bash
# Top-level help (lists all subcommand groups)
python3 .pi/maestro/maestro.py --help

# Memory subcommands
maestro memory show 42
maestro memory show 42 --json
maestro memory list
maestro memory clear 42           # prompts for confirmation
maestro memory clear 42 --yes     # skip confirmation

# Scout subcommands
maestro scout  show 42
maestro scout  show 42 --json
maestro scout  list
maestro scout  list --scout-only  # only issues with non-empty scout data

# Prompt tool-allowlist validation
maestro prompt validate flows/builder-reviewer.json
maestro prompt validate flows/*.json --quiet

# Evidence gates (Wave 2) — write & inspect evidence markers
maestro mark-tested        42 --command "pnpm test" --tests-run 47 --tests-passed 47 --exit-code 0
maestro mark-reviewed      42 --critical 0 --non-blocking 2 --reviewer claude-sonnet
maestro mark-manual-tested 42 --scenario "user can log in" \
                                    --screenshot-before before.png --screenshot-after after.png
maestro evidence check     42 --required tested --required reviewed   # exit 0/1
maestro evidence show      42                                       # pretty-print all markers

# Retrospective (Wave 2) — read & aggregate learnings
maestro retrospective show       /path/to/repo
maestro retrospective amendments /path/to/repo
maestro retrospective patterns   [--json] [--memory-dir <path>]
maestro retrospective run        42 --repo-path /path/to/repo [--memory-dir <path>]

# Repo Onboarding (Wave 2) — register a repo & inspect the projects registry
maestro onboard  /path/to/repo                  # mechanical probe only
maestro onboard  /path/to/repo --interview      # also runs the interviewer agent
maestro onboard  /path/to/repo --re-interview   # re-run interview against existing entry
maestro onboard  /path/to/repo --alias my-app   # friendly name on the registry entry
maestro projects list   [--json]                # all onboarded repos
maestro projects show   /path/to/repo           # full entry (also accepts alias or hash)
maestro projects remove my-app                  # remove from registry (does not delete repo)
```

`maestro mark-tested`, `maestro mark-reviewed`, and `maestro mark-manual-tested` are top-level (not nested under `evidence`) so they match the canonical invocation agents see in the `test_runner` prompt and in CI scripts. The `evidence check` and `evidence show` subcommands are nested under `evidence` because they're inspector tools, not producers.

The `maestro prompt validate` subcommand is a Click wrapper around the same validation logic that the standalone `python3 prompt_validate.py <flow.json>` script exposes — both produce identical output for the same input. The script form is retained for backward compatibility with any CI jobs that already call it.

If you put `.pi/maestro/` on your `PATH` (and `maestro.py` is `chmod +x`), the `maestro` binary can be invoked directly without the `python3 ...` prefix.

---

## Scout Phase (read-only pre-builder exploration)

The `scout` phase is a **read-only exploration agent** that runs *before* the `builder` phase. It returns a structured `ScoutFindings` block (relevant files, test command, patterns, conventions, risks) which is persisted to working memory and injected into the builder's prompt as `{scout_findings}`. The builder starts each run with concrete repo context — no more exploration tax wasted on the first iteration of every issue.

### Opt-in per flow

Scout is **opt-in** via a `"scout_enabled": true` flag in the flow JSON. Existing flows without the flag skip the scout phase entirely.

```json
{
  "scout_enabled": true,
  "scout_timeout_seconds": 240,
  "phases": {
    "scout": { "skill": "/skill:scout", "timeout_seconds": 240, "retries": 1 },
    "builder": { ... }
  }
}
```

The `scout` phase runs with the read-only tool allowlist `['Read', 'Bash', 'Grep', 'Glob']` (enforced via prompt frontmatter — see `prompts/scout.md`).

### Failure modes (all non-fatal)

| Outcome | Effect |
|---|---|
| Scout times out | Logs `[scout] error: ...` + `[scout] Builder will proceed without scout findings` |
| Scout self-rejects | Same as above — proceeds without findings |
| Scout emits unparseable output | Builder gets a raw text block under `## Scout Findings (raw, unparseable)` |
| Scout returns empty findings | Builder gets a "ran but no findings" placeholder |

In all cases the builder proceeds. Scout never blocks the pipeline.

### Inspecting scout findings

```bash
# User-facing (preferred): pretty-print scout findings for issue #42
maestro scout show 42

# Or as raw JSON
maestro scout show 42 --json

# List every issue that has scout data
maestro scout list
maestro scout list --scout-only
```

Use `--memory-dir <path>` (before the subcommand) to point at a non-default location, same as the memory CLI:

```bash
maestro scout --memory-dir /tmp/foo show 42
```

The `python3 -m commands.scout ...` invocation still works as a programmatic entry point (see [Top-Level CLI](#top-level-cli-maestro-)).

### How it's wired in

- `flow_engine._scout_enabled()` returns True iff the flow has both `scout_enabled: true` and a `scout` phase defined.
- `flow_engine._run_scout_phase()` runs the phase synchronously, parses the `### PHASE_OUTPUT: success` block from the raw LLM output, persists to working memory, and returns the parsed dict (or `None` on failure).
- `flow_engine._initial_phase()` skips scout in the main loop, so the builder is always the first phase the loop visits.
- `flow_engine.build_prompt()` substitutes `{scout_findings}` from `context["scout_findings_md"]`. When scout is disabled, a stable placeholder is used: `(Scout disabled for this flow.)`.
- `lib/scout_findings.py` owns the `ScoutFindings` dataclass + parser + renderer. The builder always gets a `## Scout Findings` heading in its prompt.
- After each phase, the phase's structured result is written to memory via `MemoryStore.update_phase()`. Errors are appended via `append_error()`.
- The prefetch cache (`.maestro/prefetch_cache/<repo-hash>-<sha>.json`) is keyed on `repo_path + git_sha`, so retries on the same SHA short-circuit re-detection.

### Schema tolerance

`WorkingMemory.from_dict()` silently drops unknown fields and fills defaults for missing ones — adding new fields to the dataclass won't break existing memory files on disk. Corrupt files (invalid JSON) are backed up as `<issue>.corrupt.<unix_ts>.json` instead of being silently ignored.

---

## Retrospective Phase (compounding self-improvement)

The `retrospective` phase runs **after** every flow (success or failure) and extracts learnings into per-repo files. It's a deliberate divergence from the rest of the engine: the phase is **non-blocking** — a failed retrospective is logged but never fails the flow. This is the difference between *adapting to failures* and *learning from them*.

### What it writes

After every flow, the flow engine appends a structured entry to the target repo's `.maestro/learnings.md`:

```markdown
# Maestro Learnings — <repo-name>

## 2026-06-04 — Issue #42 (success)
- **What worked:** Scout identified the right files; builder passed tests first try
- **Surprising:** repo uses bun, not pnpm
- **Repo-specific learnings:** This repo uses bun, not pnpm

## 2026-06-04 — Issue #43 (failure)
- **What failed:** builder ignored the snake_case convention in migrations
- **Repo-specific learnings:** enforce snake_case in migrations
```

If the same failure pattern recurs **≥3 times** across entries, a proposal is appended to `.maestro/proposed-amendments.md` for human review. Amendments are never auto-applied.

### Why non-blocking?

A failed retrospective should not break the flow. The whole point is to **compound** learnings — if one is missed, the next retrospective can still extract it. Failing the flow would punish the user for retrospective bugs. The phase is declared with `is_optional: true` in the flow JSON; `flow_engine.run_phase` wraps it in `try/except` and converts any exception to a synthetic success.

### Phase prompt (`prompts/retrospective.md`)

The LLM-driven prompt asks the agent to:

1. Read the working memory (1 min budget)
2. Identify patterns — what worked, what failed, what was surprising (2 min)
3. Extract repo-specific learnings (1 min)
4. Check for recurring patterns (30 sec)
5. Emit a `### PHASE_OUTPUT: success` block with structured findings

The flow engine parses the block, formats a markdown entry via `format_learning_entry`, and atomically appends it to the learnings file. The LLM is **not** allowed to write the file itself — that keeps the persistence path deterministic and auditable.

### Flow wiring

The retrospective is added to the four PR flows (`builder-reviewer`, `builder-test-reviewer`, `full-lifecycle`, `prd-to-issues-reviewer`) with `is_optional: true` and a `close|reviewer|archivist → retrospective → finish` transition chain. The two audit flows (`gap-check`, `prd-audit`) are intentionally skipped — they're check-only, not PR flows.

All retrospective transitions route to `finish` regardless of `on_success`/`on_reject`/`on_error`. A failed retrospective is logged but never re-routed to `diagnostic`.

### CLI commands

```bash
# Show the learnings file for a repo
maestro retrospective show /path/to/repo

# Show proposed amendments for a repo
maestro retrospective amendments /path/to/repo

# Aggregate learnings across all repos (defaults to cwd as scan root)
maestro retrospective patterns
maestro retrospective patterns --memory-dir /path/to/root

# Machine-readable output for CI dashboards
maestro retrospective patterns --json

# Manually re-derive a learning entry for a past issue
# (reads working memory; no LLM call)
maestro retrospective run 42 --repo-path /path/to/repo
maestro retrospective run 42 --repo-path /path/to/repo --memory-dir .maestro/tasks/active
```

### Recurrence detection (`count_recurring_patterns`)

The detector uses **keyword overlap**, not embeddings. It extracts ≥4-char words from the current failure, then counts entries in the learnings file where ≥3 keywords match. Zero dependencies, good enough for v1. If false-positive rate is too high, embeddings can be swapped in later.

### Module map

- `lib/learnings.py` — `format_learning_entry`, `append_to_learnings`, `count_recurring_patterns`, `scan_all_learnings`, `parse_retrospective_output`. Atomic writes via `.tmp` + `os.replace`.
- `commands/retrospective.py` — Click group with `run`, `show`, `patterns`, `amendments` subcommands.
- `flow_engine._persist_retrospective_result` — invoked after the LLM-driven phase; parses `PHASE_OUTPUT` and persists.
- `flow_engine._populate_retrospective_context` — fills `{flow_name}`, `{final_status}`, `{repo_path}`, `{evidence_summary}`, `{learnings_excerpt}` on the context dict before the prompt is built.

### Why per-repo, not global?

Each repo has its own conventions. Per-repo also makes commits cleaner (the learnings file travels with the code it describes). A global file would mix concerns and make version-control noisy.

---

## Evidence Gates (Mechanical Quality Enforcement)

The `close` phase replaces LLM-judged "APPROVED" with **physical, auditable evidence files**. A flow can only mark an issue complete when the required evidence markers exist on disk, have a valid SHA256 content hash, and were produced by the phase that owns them.

### Evidence taxonomy

| Marker | Producer | Verifies |
|---|---|---|
| `tested.json` | `maestro mark-tested` or `test_runner` phase auto-write | Automated test output (exit code, tests run, tests passed) |
| `manual_tested.json` | `maestro mark-manual-tested` or Playwright verifier phase | Browser / manual verification (scenario, before/after screenshots) |
| `reviewed.json` | `maestro mark-reviewed` or `reviewer` phase | Human or structured review (critical / non-blocking issue counts) |

Markers live in `.maestro/evidence/<issue_num>/<type>.json`. Each file is JSON of the form:

```json
{
  "issue": 42,
  "type": "tested",
  "verified": true,
  "created_at": "2026-06-04T19:32:11Z",
  "created_by": "test_runner_phase",
  "data": { "command": "pnpm test", "tests_run": 47, "tests_passed": 47, "exit_code": 0 },
  "content_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}
```

- The `content_hash` is SHA256 of the JSON-serialised `data` field only (re-stamping with a new `created_at` doesn't invalidate the marker).
- `verified` is computed by the factory (e.g. `verified = exit_code == 0 and tests_passed == tests_run`) — the producer cannot lie about it.
- Writes are atomic: `<file>.tmp` is fully flushed, then `os.replace()` swaps it in.

### The `close` phase

The `close` phase is **local-only** (`is_local: true`, `tools: []` in the prompt frontmatter). It runs:

```bash
python3 -m maestro.commands.evidence check <issue_num> --required tested --required reviewed
```

…and applies the flow's `evidence_policy` to the result:

| Policy | Missing or unverified evidence |
|---------|-------------------------------|
| `block` (strict, Case-style) | Phase emits `rejected` → flow routes to `diagnostic` |
| `warn_but_proceed` (Maestro default) | Phase logs a warning and emits `success` |
| `ignore` (escape hatch) | Phase emits `success` silently, no check runs |

`block` is what you want on PR flows (`builder-reviewer`); `ignore` is what you want on audit flows (`gap-check`, `prd-audit`); `warn_but_proceed` is the personal-use default. Set the policy at the top of the flow JSON:

```json
{
  "evidence_policy": {
    "required_on_success": ["tested", "reviewed"],
    "on_missing_evidence": "warn_but_proceed"
  }
}
```

### Writing evidence from agent prompts

The `test_runner` prompt now ends with:

```bash
maestro mark-tested {issue_number} \
  --command "{test_command}" \
  --tests-run $TESTS_RUN \
  --tests-passed $TESTS_PASSED \
  --exit-code $EXIT_CODE
```

Similarly, the `reviewer` prompt ends with `maestro mark-reviewed`. The LLM **never writes the evidence file directly** — the CLI guarantees the schema, the hash, the atomic write, and the `verified` flag.

### Inspecting evidence

```bash
# Pretty-print all markers for an issue
maestro evidence show 42

# CI gate: exit 0 if tested + reviewed are present and verified, 1 otherwise
maestro evidence check 42
maestro evidence check 42 --required tested           # single-marker check
maestro evidence check 42 --required tested --required reviewed --evidence-dir /custom/path
```

### Tamper detection

`EvidenceStore.read()` recomputes the SHA256 hash of the `data` field on every read. If the file was edited after creation (even by a byte), `read()` returns the marker with `verified=False`. The `close` phase then applies the `on_missing_evidence` policy as if the marker were missing. This is enough to catch casual tampering and accidental edits; HMAC signatures (which would catch forgery too) are deferred to a follow-up.

### Module map

- `lib/evidence.py` — `EvidenceStore`, `EvidenceMarker` dataclass, marker factories (`make_tested_marker`, `make_reviewed_marker`, `make_manual_tested_marker`).
- `commands/evidence.py` — Click group with `mark-tested`, `mark-reviewed`, `mark-manual-tested`, `check`, `show` subcommands.
- `prompts/close.md` — the local-only phase prompt (no LLM, `tools: []`).
- `flow_engine._run_close_phase()` — wires `evidence_policy` from the flow JSON to `EvidenceStore.check()`.

---

## Repo Onboarding (Per-Repo Context Capture)

`maestro onboard <path>` registers a repo with Maestro so every subsequent flow auto-loads its context — languages, package manager, test command, conventions, gotchas — instead of re-discovering it. Two modes: **mechanical** (fast, no human) and **`--interview`** (slow, agent-driven, captures subjective context).

### Mechanical probe

`lib/repo_probe.py` scans the target repo and detects:

| Field | Detection |
|-------|-----------|
| `languages` | Globs for `.py`/`.ts`/`.rs`/`.go` source files + config files (`pyproject.toml`, `tsconfig.json`, `Cargo.toml`, `go.mod`) |
| `package_manager` | First match: `pnpm-lock.yaml` → `bun.lockb`/`bun.lock` → `yarn.lock` → `package-lock.json` |
| `test_command`, `build_command`, `lint_command` | Read from `package.json` `scripts` block (or Python: `pytest`; Rust: `cargo test`; Go: `go test ./...`) |
| `frameworks` | Inspect `dependencies` + `devDependencies` for fastapi/django/react/vue/svelte/express/hono/next/nuxt |
| `git_remote` | `git remote get-url origin` (5s timeout; `null` if not a git repo) |

Mechanical mode runs in <1 second and requires no human. The probe is **idempotent** — re-running with the same path overwrites the existing entry, never duplicates.

### `--interview` mode

Slow path: the interviewer agent (`prompts/interviewer.md`, `tools: ['Read', 'Bash', 'Write']`) runs an LLM-driven Q&A session to capture the **subjective** fields mechanical probing can't see:

- **Evidence strategy**: `test-output` | `ui-screenshot` | `scenario-script`
- **Conventions**: free-form list (e.g. `["conventional commits", "snake_case for DB columns"]`)
- **Gotchas**: free-form list (e.g. `["migrations must be backwards-compatible", "tests require postgres on 5432"]`)
- **Recommended playbooks**: multi-select (`fix-bug.md`, `add-feature.md`, `add-cli-command.md`, `cross-repo-update.md`)
- **Primary reviewer**: model name (default: `claude-sonnet`)

The agent asks 3–5 clarifying questions, emits a `PHASE_OUTPUT` block, and the flow engine writes the structured data into the existing `projects.json` entry. Re-running with `--re-interview` updates only the subjective fields; mechanical data is preserved.

### Projects registry

Entries live in `.maestro/projects.json`, keyed by the first 12 hex chars of `SHA256(resolved_repo_path)`. Each entry looks like:

```json
{
  "hash": "a1b2c3d4e5f6",
  "alias": "pi-pos-v1",
  "path": "/home/david/projects/pi-pos-v1",
  "probed_at": "2026-06-04T19:32:11Z",
  "languages": ["python", "typescript"],
  "package_manager": "pnpm",
  "test_command": "pnpm test",
  "build_command": "pnpm build",
  "lint_command": "pnpm lint",
  "frameworks": ["react", "fastapi", "hono"],
  "evidence_strategy": "test-output",
  "conventions": ["conventional commits", "snake_case for DB columns"],
  "gotchas": ["migrations must be backwards-compatible"],
  "playbooks_recommended": ["fix-bug.md", "add-feature.md"]
}
```

`lib/projects_registry.py` uses `tempfile.mkstemp` + `os.rename` for atomic writes (more robust on network filesystems than the `.tmp` + rename pattern used elsewhere). Corrupt files are backed up to `projects.corrupt.<unix_ts>.json` instead of being silently ignored.

### Auto-loading context into flows

`flow_engine.run_flow()` resolves the target repo's path, looks up its entry in the registry, and injects it as `context["repo_context"]`. Every phase prompt that references `{repo_context}` (notably `builder.md`) renders the JSON inline near the top of the prompt. The builder starts each run knowing the test command, the conventions, and the gotchas — no re-discovery tax on iteration 1.

```markdown
## Repo Context (from onboarding)

{repo_context_json}
```

On un-onboarded repos the variable renders to an empty `{}` placeholder, and the flow proceeds exactly as it did pre-onboarding. **Onboarding is explicit — it's never auto-triggered on the first flow.**

### CLI commands

```bash
# Mechanical probe (default)
maestro onboard /path/to/repo

# Add the agent-driven interview
maestro onboard /path/to/repo --interview

# Re-run only the interview against an existing entry
maestro onboard /path/to/repo --re-interview

# Set a friendly alias (default: the repo's directory name)
maestro onboard /path/to/repo --alias my-app

# Inspect the registry
maestro projects list   [--json]                  # all onboarded repos
maestro projects show   /path/to/repo             # full entry (also accepts alias or hash)
maestro projects remove my-app                    # remove from registry (does not delete repo)
```

### Module map

- `lib/repo_probe.py` — `ProbeResult` dataclass + `probe_repo(path)`.
- `lib/projects_registry.py` — `ProjectsRegistry` class with `load`/`save`/`upsert`/`get`/`get_by_path`/`remove`.
- `commands/onboard.py` — Click group orchestrating probe + (optional) interview + registry write.
- `commands/projects.py` — Click group for registry inspection (`list`, `show`, `remove`).
- `prompts/interviewer.md` — the onboarding agent prompt.
- `flow_engine._load_repo_context()` — called at the top of `run_flow()`, populates `context["repo_context"]`.
- `flow_engine.build_prompt()` — renders `{repo_context}` into prompts that reference it.

---

## How Phases Execute

### LLM-Driven Phases (`skill` configured)
1. Build prompt from template + context variables
2. Call `rpc_client.run_rpc()` → spawns Pi RPC client with JSON stdin protocol
3. Agent executes the skill, writes session log (JSONL) to `.pi/maestro/sessions/<issue>/<flow>-<phase>-<ts>.jsonl/<jsonl>`
4. **Verdict extraction**: `verdict_extractor.extract_phase_verdict()` parses session log text for approval/rejection patterns (`✅ APPROVED`, `STATUS: approved`, etc.)
5. **Fallback chain**: If no verdict found in session log → reads `.pi/maestro/state/slice-result.json` as secondary source
6. Parses session log (JSONL) for metadata (model, duration, file ops, errors)

### Local Command Phases (`is_local: true`)
1. Runs shell command via `subprocess.run()` with configured timeout
2. Exit code 0 → success; non-zero → reject with stderr/stdout captured as details
3. No LLM or RPC involved (e.g., test runner, linter)

---

## Extending Maestro

### Adding a New Flow
1. Create a `.json` file in `flows/` defining phases and transitions
2. Use `flow-info.py <name>` to validate structure:
   ```bash
   python3 scripts/flow-info.py my-new-flow --json
   ```

### Adding a Pipeline Script
1. Create a `.py` file in `pipelines/` with `setup(ctx)` and/or `run(ctx)` functions
2. Use `ctx.github`, `ctx.run_flow()`, `ctx.artifact_write()`, etc. for operations
3. Run via `PipelineRunner`:
   ```python
   runner = PipelineRunner(term=term)
   pipeline = runner.load_pipeline("my-pipeline.py")
   result = runner.execute_pipeline(pipeline, "my-pipeline")
   ```

### Customizing Prompts
Edit or create `.md` files in `prompts/`. The new format is YAML-frontmatter + Markdown — see [Tool Allowlists](#tool-allowlists-per-phase-tool-enforcement) for the frontmatter schema. Legacy `.tmpl` files still work for backward compatibility but cannot declare tool allowlists. Use `{variable}` syntax for context injection (see [Context Passing](#context-passing-between-phases) for the full variable list).

### Overriding Models/Providers Per-Phase
Set `model` and `provider` fields in the phase config:
```json
{
  "phases": {
    "builder": { "skill": "/skill:tdd", "model": "qwen-35b-a3b-118k-bf16", "retries": 3 }
  }
}
```

---

## Runtime Configuration (`config.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `repo_override` | `null` | Override GitHub repo (format: `owner/repo`) |
| `gh_timeout` | `30` | Timeout in seconds for `gh` CLI operations |
| `default_model` | `"qwen-27b-64k-q8"` | Default LLM model name |
| `default_provider` | `"llama-cpp-3090"` | Default LLM provider |
| `session_dir` | `".pi/maestro/sessions"` | Directory for session logs (overridable via `MAESTRO_SESSION_DIR` env var) |

---

## Analysis Scripts (`scripts/`)

Python analysis toolkit that replaces raw file-reading with structured, deterministic output. Every script follows the same contract: zero or one argument + optional flags, under 1 second execution, output fits in <500 tokens.

| I want to... | Command |
|--------------|---------|
| **see what a file exports** (classes, functions, constants) | `python3 scripts/exports.py <path>` |
| **see import dependencies** (stdlib / third-party / local) | `python3 scripts/imports.py [dir]` |
| **understand a flow's phases and transitions** | `python3 scripts/flow-info.py <name>` |
| **inspect a pipeline script** (setup/run, context vars) | `python3 scripts/pipeline-inspect.py <path>` |
| **summarize a session log** (model, ops, errors) | `python3 scripts/session-summary.py <path>` |
| **see class inheritance tree** | `python3 scripts/class-hierarchy.py [dir]` |

All scripts support `--json` for machine-readable output and `--help` for usage info. Uses only Python stdlib (`ast`, `json`, `argparse`). No pip dependencies required.

---

## Testing & Validation

Maestro has comprehensive test coverage across multiple layers: **~38 test files, ~480 tests**.

| Layer | File | Coverage |
|-------|------|----------|
| **Verdict extraction** | `test_verdict_extractor.py` | 26 tests — regex patterns, malformed JSONL handling, missing/empty files, issue extraction, verdict priority |
| **Regression** | `test_verdict_regression.py` | 23 tests — real session logs from all flows, edge cases (crash prevention), directory operations |
| **Pipeline engine** | `test_pipeline_runner.py`, `test_pipeline_context.py` | 28 tests — PipelineRunner execution, context variable management, artifact storage |
| **Dashboard UI** | `test_pipeline_dashboard.py`, `test_pipeline_dashboard_extended.py`, `test_pipeline_monitor_panel.py`, `test_dashboard_app.py`, `test_session_browser.py` | 87 tests — dashboard rendering, progress bars, scorecards, session browser, monitor panel |
| **Autonomous pipeline** | `test_autonomous_pipeline.py` | 7 tests — full autonomous workflow logic |
| **Flow execution** | `test_run_single_flow.py`, `test_flow_engine_integration.py` | 25 tests — single flow on issue with retries + flow engine end-to-end |
| **Comment parsing** | `test_comment_parser.py` | 3 tests — phase output block extraction |
| **GitHub client** | `test_github_client.py` | 14 tests — GitHub API wrapper operations |
| **Context prefetch** | `test_context_prefetch.py` | 12 tests — repo context cache keyed on git SHA |
| **Working memory** | `test_working_memory.py`, `test_integration_working_memory.py` | 16 tests — JSON load/save, atomic writes, corrupt-file backup, schema tolerance |
| **Scout phase** | `test_scout_findings.py`, `test_flow_scout.py`, `test_integration_scout.py` | 37 tests — findings parser/renderer, flow integration, parse-error envelopes |
| **Evidence gates** | `test_evidence.py`, `test_flow_evidence.py`, `test_integration_evidence_gates.py` | 48 tests — marker write/read/hash, policy enforcement, end-to-end CLI |
| **Retrospective** | `test_learnings.py`, `test_retrospective_phase.py`, `test_integration_retrospective.py` | 35 tests — format/append, recurrence detection, patterns/amendments CLI, non-blocking flow glue |
| **Repo onboarding** | `test_repo_probe.py`, `test_projects_registry.py`, `test_onboard_command.py`, `test_integration_onboarding.py` | 88 tests — mechanical probe (31), registry CRUD + atomicity (33), CLI (10), end-to-end (14) |
| **CLI** | `test_maestro_cli.py` | 15 tests — top-level group wiring, mark-* commands, evidence subcommands |
| **Tool enforcement** | `test_flow_engine_tools.py`, `test_prompt_loader.py`, `test_integration_tool_enforcement.py` | 16 tests — tool allowlist loading + validation, flow-level enforcement |

### Running Tests

```bash
# Run all tests
pytest .pi/maestro/tests/ -v

# Run specific test module
python3 .pi/maestro/tests/test_verdict_extractor.py

# Run with verbose output
pytest .pi/maestro/tests/ --tb=short
```

---

## Session Log Layout

Session logs are stored in a nested directory structure:

```
.pi/maestro/sessions/
└── <issue_num>/                          # Grouped by issue number
    └── <flow>-<phase>-<ISO8601>.jsonl/   # Named by flow-phase-timestamp
        └── <uuid>.jsonl                  # Actual session log file
```

Example:
```
sessions/
├── 177-builder-reviewer-builder-20260526-193930/
│   └── 2026-05-26T19-39-31-179Z_019e65cc....jsonl
├── 187/builder-reviewer-builder-2026-05-27T15:41:05.jsonl/
│   └── 2026-05-27T15-41-06-450Z_019e6a18....jsonl
```

`verdict_extractor.py` parses session log JSONL files for verdict patterns. `session_reader.py` provides structured summaries (model, duration, file ops, errors). Use the `session-summary.py` script for human-readable output:

```bash
python3 scripts/session-summary.py sessions/187/builder-reviewer-builder-2026-05-27T15:41:05.jsonl/*.jsonl
```

---

## Comparison: Bash vs Maestro

| Feature | `run-slices.sh` | Maestro |
|---------|-----------------|---------|
| **Testability** | Nearly impossible | ~480 tests across ~36 files |
| **Configurability** | Hardcoded bash logic | JSON flow definitions + pipeline scripts |
| **Phase Communication** | Local files + critique strings | Strict GitHub comment blocks |
| **Tool Safety** | No tool enforcement | Per-phase tool allowlists enforced at the RPC layer (`.md` frontmatter) |
| **Quality Gates** | "Reviewer said APPROVED" | Mechanical evidence files with SHA256 tamper detection |
| **Self-Improvement** | None | Per-repo `.maestro/learnings.md` + recurring-pattern amendments |
| **Repo Awareness** | Anonymous target | `maestro onboard` captures commands, conventions, gotchas |
| **Error Handling** | Basic retry loops | Built-in diagnostic pass + structured transitions + PipelineRunner retries + non-blocking retrospective |
| **Context Management** | Manual file reads/writes | Automatic variable injection across phases + PipelineContext + prefetch cache keyed on git SHA + working memory per issue |
| **Metadata Tracking** | None | Session log parsing (model, duration, file ops) via verdict_extractor & session_reader |
| **UI/Monitoring** | None | Full Textual dashboard with live progress and scorecards + session browser + evidence inspector |

---

## Next Steps / Known Gaps

- [ ] Wire `state_manager.py` into CLI (`--resume`, `--rollback`) for offline recovery
  - `state_manager.py` currently only provides `load_state()` / `save_state()` — no CLI integration yet
- [ ] Add rate-limiting & concurrency controls for autonomous loop mode
- [ ] Implement dry-run mode to validate flow topology without executing phases
- [ ] HMAC signatures on evidence markers (currently SHA256 content hash only — catches tampering, not forgery)
- [ ] Embedding-based recurring pattern detection in `count_recurring_patterns` (currently keyword overlap, ≥3 matches)
- [ ] Auto-applying amendments from `.maestro/proposed-amendments.md` (currently proposals only — humans review)

---

## License

Internal tool — not for external distribution.
