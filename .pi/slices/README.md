# Slice Orchestrator

GitHub Issues-driven slice execution via Pi RPC mode. Each GitHub Issue represents one vertical slice. Builder ↔ Reviewer loop driven by local state, GitHub comments, and labels.

**Refactored (v2):** Modular architecture with external config, prompt templates, hook system, signal handling, and batch resilience.

## Quick Start

```bash
# Run all pending slices (issues with 'needs-triage' label)
.pi/slices/run-slices.sh

# Process a single issue directly
.pi/slices/run-slices.sh --issue 42

# Dry-run: simulate without side effects
.pi/slices/run-slices.sh --dry-run

# Resume from last saved state (skips completed issues)
.pi/slices/run-slices.sh --resume

# Use a different label or repo
.pi/slices/run-slices.sh --label ready-to-build --repo owner/repo
```

## Architecture

### Modular Structure

```
.pi/slices/
├── run-slices.sh          # Thin orchestrator (~450 lines)
├── config.json            # Project-level configuration
├── lib/                   # Reusable modules (sourced by orchestrator)
│   ├── config.sh          # Config loading with env var overrides
│   ├── state.sh           # State management + session log tracking
│   ├── github.sh          # GitHub API wrappers (caching, timeouts)
│   ├── result.sh          # Result file validation/parsing
│   ├── prompt.sh          # Template-based prompt building
│   └── rpc.sh             # RPC client wrapper with log extraction
├── prompts/               # Externalized prompt templates (optional)
│   ├── builder.tmpl       # Builder prompt template
│   └── reviewer.tmpl     # Reviewer prompt template
├── hooks/                 # Lifecycle hooks (optional, user-defined)
│   ├── pre-builder.sh     # Runs before each builder phase
│   ├── post-reviewer.sh   # Runs after each reviewer phase
│   ├── on-success.sh      # Runs when a slice passes all checks
│   └── on-failure.sh      # Runs when a slice fails all retries
├── rpc-client.py          # Pi RPC subprocess client (unchanged)
└── inspect-sessions.py    # Session inspector (unchanged)
```

### Key Improvements Over v1

| Concern | v1 (Monolith) | v2 (Modular) |
|---------|---------------|--------------|
| **Customization** | Edit script source | Edit `config.json` or drop in `.tmpl` files |
| **Extensibility** | Hardcoded phases | Hook system for pre/post/conditional phases |
| **Robustness** | No cleanup, no validation | Signal traps, JSON validation, API timeouts |
| **Batch Resilience** | Exits on first failure | Continues through batch, reports summary |
| **Resume** | Reloads state, re-processes all | Checks labels, skips completed issues |
| **State Format** | Space-separated string + line parsing | Proper JSON + bash arrays |
| **PRD Fetching** | No caching (6 API calls/issue) | Cached per issue (2 API calls max) |

## Configuration

### config.json

All settings are in `.pi/slices/config.json`. Edit this file instead of the script:

```json
{
  "model": "qwen-35b-a3b-118k-bf16",
  "provider": "llama-cpp-3090",
  "max_retries": 3,
  "timeout_seconds": 900,
  "target_label": "needs-triage",
  "success_label": "awaiting-manual-check",
  "fail_label": "failed-slice",
  "builder_skill": "/skill:tdd",
  "reviewer_skill": "/skill:reviewer",
  "continue_on_failure": true,
  "post_builder_comment": true,
  "post_reviewer_comment": true,
  "update_labels": true,
  "fetch_parent_prd": true,
  "load_context_md": true,
  "session_log_tracking": true
}
```

### Environment Variable Overrides

| Env Var | Overrides | Example |
|---------|-----------|---------|
| `PI_MODEL` | `model` in config.json | `PI_MODEL=other-model .pi/slices/run-slices.sh` |
| `PI_PROVIDER` | `provider` in config.json | `PI_PROVIDER=openai .pi/slices/run-slices.sh` |

### Prompt Templates (Optional)

Place `.tmpl` files in `.pi/slices/prompts/` to override inline prompts. Templates use `{{VARIABLE}}` syntax:

**Available variables:**
- `{{SKILL}}`, `{{CONTEXT}}`, `{{PARENT_PRD}}`, `{{ISSUE_BODY}}`
- `{{RESULT_FILE}}`, `{{ISSUE_NUMBER}}`, `{{RETRY_COUNT}}`
- `{{CRITIQUE}}` (builder only), `{{BUILDER_COMMENT}}` (reviewer only)

**Conditional blocks:** `{{#IF_CRITIQUE}}...{{/IF_CRITIQUE}}` — included only when the variable is non-empty.

If `.tmpl` files are missing, the orchestrator falls back to inline prompts (same behavior as before).

### Hooks (Optional)

Place executable scripts in `.pi/slices/hooks/` to run at lifecycle points:

| Hook | When It Runs | Arguments |
|------|-------------|-----------|
| `pre-builder.sh` | Before each builder phase | `$1`=issue_number, `$2`=attempt |
| `post-builder.sh` | After each builder phase | `$1`=issue_number, `$2`=status |
| `pre-reviewer.sh` | Before each reviewer phase | `$1`=issue_number |
| `post-reviewer.sh` | After each reviewer phase | `$1`=issue_number, `$2`=verdict |
| `on-success.sh` | When a slice passes all checks | `$1`=issue_number |
| `on-failure.sh` | When a slice fails all retries | `$1`=issue_number, `$2`=attempts_made |

Missing hooks are silently skipped. Non-zero exit from a hook does NOT abort the orchestrator.

See `.pi/slices/hooks/README.md` for examples.

## How It Works (GitHub Issues Mode)

### Execution Flow

```
gh issue list --label needs-triage  →  ordered by number ascending
       │
       ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Builder     │────▶│  Self-review │────▶│ Write result    │
│  (RPC)       │     │              │     │ file            │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                        approved ◄─────────────────┤ rejected
                           │                       │
                           ▼                       ▼
                    ┌──────────────┐      Retry (max N)
                    │  Reviewer    │      with critique
                    │  (RPC + tests)│
                    └──────┬───────┘
                           │
                  approved ◄── rejected
                     │          │
                     ▼          ▼
           Update labels   Retry loop
```

### Label Strategy

| Label | Meaning |
|-------|---------|
| `needs-triage` | Pending execution (removed once Reviewer approves) |
| `awaiting-manual-check` | Approved by Reviewer, ready for human verification |
| `failed-slice` | Hit retry limit. Batch continues to next issue. |

### State Management

Local state file: `.pi/state/slice-run.json`

```json
{
  "issueList": [123, 124, 125],
  "currentSliceIndex": 0,
  "agentPhase": "builder",
  "builderRetries": 0,
  "totalIterations": 1
}
```

- **Fresh run**: State file is initialized empty
- **Resume** (`--resume`): Loads existing state, skips issues with `awaiting-manual-check` or `failed-slice` labels
- **After completion**: State persists for inspection; session logs saved to `.pi/state/slice-logs.json`

### Result File Format

Pi writes `.pi/state/slice-result.json` after each RPC session:

**Builder Approved:**
```json
{"status":"approved","slice":42}
```

**Builder Rejected:**
```json
{"status":"rejected","slice":42,"issues":["CSS mismatch on button","Missing Zod validation"]}
```

**Reviewer Approved:**
```json
{"status":"approved","slice":42,"verdict":"reviewer-approved"}
```

**Reviewer Rejected:**
```json
{"status":"rejected","slice":42,"verdict":"reviewer-rejected","critique":["Test failure in auth.test.ts"]}
```

## Session Inspector

Monitor Pi agent sessions: detect loops, errors, track token usage and slice status.

```bash
# Full dashboard (last 5 sessions)
.pi/slices/inspect-sessions.py

# Focused views
.pi/slices/inspect-sessions.py --slice-status   # Slice execution state
.pi/slices/inspect-sessions.py --timeline       # Recent activity timeline
.pi/slices/inspect-sessions.py --metrics        # Token/cost metrics
.pi/slices/inspect-sessions.py --loops          # Loop detection only
.pi/slices/inspect-sessions.py --errors         # Error scan only

# Other projects
.pi/slices/inspect-sessions.py --project test   # Different project's sessions
.pi/slices/inspect-sessions.py --latest 10      # Analyze more sessions
```

## Troubleshooting

**"gh: command not found"** — Install the GitHub CLI. Check with `which gh`.

**Timeout errors** — Increase `timeout_seconds` in config.json for complex slices.

**Stuck on retry loop** — Check `.pi/state/slice-result.json` for reviewer critique, fix manually if needed.

**Label update failures** — Verify the issue has the label being removed; check repo permissions with `gh auth status`.

**Script interrupted (Ctrl+C)** — State is saved automatically via signal trap. Resume with `--resume`.

## Migration from v1

The old monolithic script is preserved as `run-slices.sh.bak`. To revert:

```bash
cp .pi/slices/run-slices.sh.bak .pi/slices/run-slices.sh
```

v2 is fully backward-compatible: same CLI flags, same result file format, same label strategy. The only difference is internal architecture (modular vs monolithic).
