# Maestro Scripts — Python Analysis Toolkit

## Overview

Executable Python scripts that replace raw file-reading with structured, deterministic output. Every script follows the same contract:

| Rule | Constraint |
|------|-----------|
| **Input** | Zero or one argument (path) + optional flags |
| **Output** | Structured text (table/tree/JSON) — under 200 lines |
| **Speed** | Under 1 second execution |
| **Tokens** | Output fits in <500 tokens when pasted back to agent |
| **Help** | `--help` prints description, usage, flags, examples |
| **Flags** | `--json` for machine-readable output; `--help` for usage |

Run with: `python3 .pi/maestro/scripts/<script>.py [args] [--json|--help]`

---

## Quick Reference — Intent → Command

| I want to... | Command | Category |
|---|---|---|
| **see what a file exports** (classes, functions, constants) | `python3 .pi/maestro/scripts/exports.py <path>` | analysis |
| **see import dependencies** (stdlib / third-party / local) | `python3 .pi/maestro/scripts/imports.py [dir]` | discovery |
| **understand a flow's phases and transitions** | `python3 .pi/maestro/scripts/flow-info.py <name>` | analysis |
| **inspect a pipeline script** (setup/run, context vars) | `python3 .pi/maestro/scripts/pipeline-inspect.py <path>` | analysis |
| **summarize a session log** (model, ops, errors) | `python3 .pi/maestro/scripts/session-summary.py <path>` | debugging |
| **see class inheritance tree** | `python3 .pi/maestro/scripts/class-hierarchy.py [dir]` | architecture |
| **measure the Maestro build pass rate** | `python3 .pi/maestro/scripts/build-pass-rate.py` | metrics |
| **check the Wave 1 DoD checklist statically** | `python3 .pi/maestro/scripts/wave1-dod-check.py` | quality |

---

## Script Details

### exports.py — Python Export Extractor

Parses a `.py` file and outputs its public API: classes, functions, constants with signatures.

```bash
python3 .pi/maestro/scripts/exports.py <path>                    # Markdown table (default)
python3 .pi/maestro/scripts/exports.py <path> --json             # Detailed JSON output
python3 .pi/maestro/scripts/exports.py <path> --help             # Show usage information
```

**Examples:**
```bash
python3 .pi/maestro/scripts/exports.py .pi/maestro/lib/github_client.py
python3 .pi/maestro/scripts/exports.py .pi/maestro/pipelines/context.py --json
```

---

### imports.py — Import Graph Scanner

Scans a directory or file and outputs dependency graph categorized as stdlib / third-party / local.

```bash
python3 .pi/maestro/scripts/imports.py [path]                      # Markdown table (default)
python3 .pi/maestro/scripts/imports.py [path] --json               # Machine-readable JSON
python3 .pi/maestro/scripts/imports.py [path] --help               # Show usage information
```

**Examples:**
```bash
python3 .pi/maestro/scripts/imports.py .pi/maestro/lib/github_client.py
python3 .pi/maestro/scripts/imports.py .pi/maestro/pipelines/ --json
```

---

### flow-info.py — Flow Configuration Analyzer

Parses Maestro flow JSON configs and outputs phase structure + transitions.

```bash
python3 .pi/maestro/scripts/flow-info.py [name|path]                 # From flows/ dir (default)
python3 .pi/maestro/scripts/flow-info.py <path-to-flow.json>         # Direct file path
python3 .pi/maestro/scripts/flow-info.py --json                      # Machine-readable output
```

**Examples:**
```bash
python3 .pi/maestro/scripts/flow-info.py builder-reviewer
python3 .pi/maestro/scripts/flow-info.py .pi/maestro/flows/prd-audit.json --json
```

---

### pipeline-inspect.py — Pipeline Script Inspector

Loads a pipeline `.py` file and extracts setup/run functions, context variable usage.

```bash
python3 .pi/maestro/scripts/pipeline-inspect.py <path>                    # Markdown table (default)
python3 .pi/maestro/scripts/pipeline-inspect.py <path> --json             # Detailed JSON output
python3 .pi/maestro/scripts/pipeline-inspect.py <path> --help             # Show usage information
```

**Examples:**
```bash
python3 .pi/maestro/scripts/pipeline-inspect.py .pi/maestro/pipelines/autonomous.py
python3 .pi/maestro/scripts/pipeline-inspect.py .pi/maestro/pipelines/context.py --json
```

---

### session-summary.py — JSONL Session Log Summarizer

Parses Pi agent JSONL session logs into human-readable summaries: model, duration, file ops, errors.

```bash
python3 .pi/maestro/scripts/session-summary.py <path>                    # Human-readable (default)
python3 .pi/maestro/scripts/session-summary.py <path> --json             # Machine-readable JSON
python3 .pi/maestro/scripts/session-summary.py <path> --help             # Show usage information
```

**Examples:**
```bash
python3 .pi/maestro/scripts/session-summary.py maestro/sessions/177-*/session.jsonl
python3 .pi/maestro/scripts/session-summary.py /tmp/debug.jsonl --json
```

---

### class-hierarchy.py — Class Inheritance Tree Scanner

Scans files and outputs the class hierarchy: which classes inherit from what, with depth tracking.

```bash
python3 .pi/maestro/scripts/class-hierarchy.py [path]                      # Markdown table (default)
python3 .pi/maestro/scripts/class-hierarchy.py [path] --json               # Machine-readable JSON
python3 .pi/maestro/scripts/class-hierarchy.py [path] --help               # Show usage information
```

**Examples:**
```bash
python3 .pi/maestro/scripts/class-hierarchy.py .pi/maestro/lib/github_client.py
python3 .pi/maestro/scripts/class-hierarchy.py .pi/maestro/pipelines/ --json
```

---

### build-pass-rate.py — Build Pass Rate Measurement

Walks `.pi/maestro/sessions/<n>/` and extracts the verdict emitted by the
builder (or reviewer) phase of each flow run. Computes the percentage of
issues whose final verdict was `approved`.

```bash
python3 .pi/maestro/scripts/build-pass-rate.py                              # Default
python3 .pi/maestro/scripts/build-pass-rate.py --json                       # Machine-readable
python3 .pi/maestro/scripts/build-pass-rate.py --flow builder-reviewer      # Filter by flow
python3 .pi/maestro/scripts/build-pass-rate.py --issue 240                  # Single issue
python3 .pi/maestro/scripts/build-pass-rate.py --help                       # Show usage
```

**Examples:**
```bash
python3 .pi/maestro/scripts/build-pass-rate.py
python3 .pi/maestro/scripts/build-pass-rate.py --json | jq '.metrics.pass_rate_pct'
```

**Reference targets** (per `docs/35-prds/maestro-case-improvements-roadmap.md` §6):
- Baseline (pre-Wave 1): ~60%
- Wave 1 target: ~70%

---

### wave1-dod-check.py — Wave 1 DoD Static Verifier

Statically verifies the 11 items on the Wave 1 Definition-of-Done checklist
(parent PRD #272, slice issues #273, #274, #275). The two DoD items that
require a live LLM run are listed as "needs manual check" in the output.

```bash
python3 .pi/maestro/scripts/wave1-dod-check.py                    # Run all checks (incl. tests)
python3 .pi/maestro/scripts/wave1-dod-check.py --no-tests         # Skip pytest
python3 .pi/maestro/scripts/wave1-dod-check.py --json              # Machine-readable output
python3 .pi/maestro/scripts/wave1-dod-check.py --help              # Show usage
```

**Examples:**
```bash
python3 .pi/maestro/scripts/wave1-dod-check.py
python3 .pi/maestro/scripts/wave1-dod-check.py --no-tests --json
```

**What it checks:**
1. All 11 prompts migrated to `.md` with YAML frontmatter declaring `tools:`
2. `lib/prompt_loader.py` with `load_prompt()` and `LoadedPrompt` dataclass
3. `flow_engine.build_prompt()` returns `(prompt, tools)` tuple
4. `flow_engine.run_phase()` passes `tools` to the RPC layer
5. `rpc_client.run_rpc()` accepts and forwards `tools` in the JSON payload
6. `flows/builder-reviewer.json` has `scout` + `scout_enabled=true`
7. Scout prompt: read-only tool set (no `Write`/`Edit`)
8. Reviewer prompt: read-only (no `Write`/`Edit`)
9. Builder prompt: includes `Edit` and `Write` (positive control)
10. prompt_loader precedence chain: explicit > frontmatter > default > fallback
11. All existing tests in `.pi/maestro/tests/` pass

---

## Shared Library

These scripts use only Python stdlib (`ast`, `json`, `argparse`). No pip dependencies required.
