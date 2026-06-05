# Maestro — Configurable Loop Orchestrator for Pi Slices

Maestro replaces `run-slices.sh` with a configurable, testable Python-based orchestrator. It supports arbitrary loop topologies defined in JSON configuration files and uses GitHub comments as the message bus for inter-phase communication.

## Quick Start

```bash
# Run a flow on a specific issue (Single Issue Mode)
python3 .pi/maestro/orchestrate.py --flow builder-reviewer --issue 42

# Run autonomously across the backlog (Autonomous Loop Mode)
python3 .pi/maestro/orchestrate.py --flow builder-reviewer
```

## Architecture

### Directory Structure
```
.pi/maestro/
├── flows/                # JSON loop topology definitions
│   ├── builder-reviewer.json      # Standard Builder→Reviewer loop
│   ├── builder-test-reviewer.json # 3-phase loop (Builder → TestRunner → Reviewer)
│   └── gap-check.json             # PRD validation pipeline (Analyze → To-PRD → To-Issues)
├── lib/                  # Python modules
│   ├── comment_parser.py        # Parses strict PHASE_OUTPUT blocks from GitHub comments
│   ├── github_client.py         # Wraps `gh` CLI for issue/comment/label operations
│   ├── rpc_client.py            # Spawns slices/rpc-client.py to invoke agents via skills
│   ├── session_reader.py        # Parses JSONL agent session logs into structured summaries
│   ├── state_manager.py         # Local resume/rollback state (JSON)
│   └── terminal.py              # Formatted console output with tree layout & progress indicators
├── prompts/              # Prompt templates (.tmpl files)
│   ├── analyze.tmpl       # Drift audit & gap analysis instructions
│   ├── builder.tmpl       # Implementation & self-review instructions
│   ├── reviewer.tmpl      # Quality validation against acceptance criteria
│   └── test_runner.tmpl   # Local test execution instructions
├── tests/                # Unit tests (all passing ✓)
│   ├── test_comment_parser.py
│   └── test_github_client.py
├── orchestrate.py        # CLI entry point & argument parsing
└── app_shell.py          # High-level workflow manager (modes, gap-check logic, autonomous loop)
```

## Flow Configuration (`flows/*.json`)

Flows define the execution topology via phases and transition rules:

- **`phases`**: Named stages with skill/command config, model/provider overrides, timeouts, and retry limits.
- **`transitions`**: Rules mapping `{from_phase} + {status} → next_phase`. Supports `on_success`, `on_reject`, `on_error`, and domain-specific statuses like `on_no_gaps`.

### Example: Builder-Reviewer Loop
```json
{
  "name": "builder-reviewer",
  "default_provider": "llama-cpp-3090",
  "phases": {
    "builder": { "skill": "/skill:tdd", "model": "qwen-35b-a3b-118k-bf16", "retries": 3 },
    "reviewer": { "skill": "/skill:reviewer", "model": "claude-sonnet", "retries": 2 },
    "diagnostic": { "skill": "/skill:debugger", "retries": 1 }
  },
  "transitions": [
    { "from": "builder", "on_success": "reviewer", "on_reject": "builder", "on_error": "diagnostic" },
    { "from": "reviewer", "on_success": "finish", "on_reject": "builder", "on_error": "diagnostic" }
  ]
}
```

### Example: Multi-Phase Loop (Builder → TestRunner → Reviewer)
Adds a local command phase that runs `pnpm test --run` without LLM involvement. If tests fail, feedback loops back to the builder.

## Strict Comment Format (Message Bus)

Phases communicate via GitHub comments with a strict markdown block format:

```markdown
---
### PHASE_OUTPUT: success|rejected|system_error
{phase_name}: {summary or details}
### END_PHASE_OUTPUT
---
```

`comment_parser.py` extracts the status and details using regex. `github_client.post_phase_comment()` generates these blocks. This makes GitHub the source of truth for state and inter-phase communication, enabling resume capability without relying solely on local files.

## Modes of Operation

### 1. Single Issue Mode
Processes one issue end-to-end through its flow topology. Stops when it hits `finish`, max retries exhausted, or an unrecoverable error. Posts final success/rejection comments to GitHub.

### 2. Autonomous Loop Mode
Runs continuously against the project backlog:
1. **Backlog Sweep**: Fetches all issues labeled `ready-for-agent`
2. **Slice Processing**: Runs the default flow on each issue, closing them upon successful completion
3. **Gap Check Pipeline**: After the backlog is empty, processes all open `parent-prd` issues through an `analyze → to-prd → to-issues` pipeline (defined in `gap-check.json`)
4. **Loop**: Returns to step 1 for newly created issues

## Context Passing Between Phases

Maestro accumulates and injects context into prompt templates using variable substitution:

| Variable | Source |
|----------|--------|
| `{issue_number}` | CLI argument or loop iteration |
| `{issue_body}` | GitHub issue body (fetched via `gh issue view`) |
| `{prd_body}` | Parent PRD body, extracted if issue contains `## Parent\n\n#NNN` |
| `{previous_output}` | Last phase's result summary (updated on each transition) |
| `{diagnostic_insights}` | Output from the diagnostic pass after errors or repeated failures |

Variables are injected into `.tmpl` files before sending to the RPC client. If a template is missing, `flow_engine.py` falls back to a default prompt structure.

## How Phases Execute

### LLM-Driven Phases (`skill` configured)
1. Build prompt from template + context variables
2. Call `rpc_client.run_rpc()` → spawns `slices/rpc-client.py` with the prompt as a file argument
3. Agent executes the skill, writes results to `.pi/maestro/state/slice-result.json`
4. Maestro reads the JSON for `status`, `issues`, `verdict`, etc.
5. Parses session log (JSONL) for metadata (model, duration, file ops, errors)

### Local Command Phases (`is_local: true`)
1. Runs shell command via `subprocess.run()` with configured timeout
2. Exit code 0 → success; non-zero → reject with stderr/stdout captured as details
3. No LLM or RPC involved (e.g., test runner, linter)

## Extending Maestro

1. **Add a new flow**: Create a `.json` file in `flows/` defining phases and transitions
2. **Add a new phase type**: Define it in any flow's `phases` section with `skill`, `is_local`, or both
3. **Customize prompts**: Edit or create `.tmpl` files in `prompts/`
4. **Override models/providers per-phase**: Set `model` and `provider` fields in the phase config

## Testing & Validation

Since Maestro is Python-based, you can write unit tests for:
- Flow configuration parsing & validation
- Comment block parsing logic (`comment_parser.py`)
- Phase execution paths & state transitions
- Error handling and diagnostic pass behavior

### Running Tests

```bash
# Run individual test modules
python3 .pi/maestro/tests/test_comment_parser.py
python3 .pi/maestro/tests/test_github_client.py

# Or run with pytest (if installed)
pytest .pi/maestro/tests/ -v
```

## Comparison: Bash vs Maestro

| Feature | `run-slices.sh` | Maestro |
|---------|-----------------|---------|
| **Testability** | Nearly impossible | Full unit tests available |
| **Configurability** | Hardcoded bash logic | JSON flow definitions |
| **Phase Communication** | Local files + critique strings | Strict GitHub comment blocks |
| **Error Handling** | Basic retry loops | Built-in diagnostic pass + structured transitions |
| **Context Management** | Manual file reads/writes | Automatic variable injection across phases |
| **Metadata Tracking** | None | Session log parsing (model, duration, file ops) |

## Next Steps / Known Gaps

- [ ] Wire `state_manager.py` into CLI (`--resume`, `--rollback`) for offline recovery
- [ ] Add rate-limiting & concurrency controls for autonomous loop mode
- [ ] Implement dry-run mode to validate flow topology without executing phases
- [x] Phase 1: Core engine & RPC integration
- [x] Phase 2: GitHub message bus connection
- [x] Phase 3: Flow configuration & context passing

## License

Internal tool — not for external distribution.
