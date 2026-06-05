---
name: session-parser
description: >
  Lists, searches, and parses raw JSONL agent session logs into human-readable
  Markdown summaries and machine-parsable JSON. USE WHEN reviewing past sessions,
  searching for tool calls or errors across sessions, debugging agent behavior,
  or extracting structured data from session logs.
---

# Session Parser Skill

## Overview
This skill provides the ability to list, search, and parse raw JSONL session logs into human-readable Markdown and machine-parsable JSON structures. It uses the `parseSessionLog` library function from the project's shared codebase.

## 🔍 Location of Sessions

Sessions are stored in **two locations** depending on how they were created:

### Agent Sessions (direct runs)
```bash
/home/david/.pi/agent/sessions/--home-david-projects-pi-pos-v1--/
```
Flat `.jsonl` files from direct agent invocations.

### Maestro Sessions (multi-agent pipelines)
```bash
.pi/maestro/sessions/<number>/<flow>/session.jsonl
```
Nested directories from multi-agent pipeline runs. Each numbered session contains one or more flow subdirectories, each with its own `.jsonl` file.

**Default behavior:** Scripts scan **both** locations unless `--source agent|maestro` is specified.

---

## 🛠️ Usage

### 1. List Sessions
Browse available sessions sorted newest-first:

```bash
tsx .pi/skills/session-parser/scripts/list-sessions.ts [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--last N` | Show only the last N sessions (default: all) |
| `--today` | Show only today's sessions |
| `--path` | Print file paths only (machine-readable, pipe-friendly) |
| `--source agent|maestro|both` | Which session store to scan (default: both) |

**Examples:**
```bash
# List 5 most recent sessions (from both stores)
tsx .pi/skills/session-parser/scripts/list-sessions.ts --last 5

# List only maestro pipeline sessions
tsx .pi/skills/session-parser/scripts/list-sessions.ts --source maestro --last 10

# List only direct agent sessions
tsx .pi/skills/session-parser/scripts/list-sessions.ts --source agent --today

# Get paths only (for piping into parse-session.ts)
tsx .pi/skills/session-parser/scripts/list-sessions.ts --path --last 1 --source maestro
```

**Output:** Table with rank, timestamp, file size, event count, session ID, and a title extracted from the first user message.

---

### 2. Search Sessions
Search across all session logs for tool calls, file paths, errors, or text:

```bash
tsx .pi/skills/session-parser/scripts/search-sessions.ts <query> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--tool-name` | Match against tool call names (e.g., "edit", "bash") |
| `--file-path` | Match against file paths in tool arguments |
| `--errors-only` | Only show sessions that contain errors |
| `--context N` | Show N lines of context around matches (default: 1) |
| `--json` | Output structured JSON instead of human-readable text |
| `--source agent|maestro|both` | Which session store to scan (default: both) |

**Examples:**
```bash
# Find all sessions where "edit" tool was called
tsx .pi/skills/session-parser/scripts/search-sessions.ts edit --tool-name

# Find sessions that touched schema.prisma
tsx .pi/skills/session-parser/scripts/search-sessions.ts schema.prisma --file-path

# List all sessions with errors (no query needed)
tsx .pi/skills/session-parser/scripts/search-sessions.ts "" --errors-only

# Search for text across all messages
tsx .pi/skills/session-parser/scripts/search-sessions.ts "pricing model"

# Search only maestro pipeline sessions
tsx .pi/skills/session-parser/scripts/search-sessions.ts edit --tool-name --source maestro
```

**Output:** Matching sessions sorted by match count, with snippets showing what matched and context from surrounding events.

---

### 3. Parse a Session
Generate a full summary report for a specific session:

```bash
tsx .pi/skills/session-parser/scripts/parse-session.ts <path-to-jsonl>
```

**Example:**
```bash
tsx .pi/skills/session-parser/scripts/parse-session.ts /home/david/.pi/agent/sessions/--home-david-projects-pi-pos-v1--/2026-05-08T19-12-59-256Z_019e0901.jsonl
```

**Output:** Two sections:
*   **Markdown Summary**: Structured report (Decisions, File Operations, Errors) for human review.
*   **JSON Block**: Structured data containing `raw_messages` and metadata for programmatic analysis or LLM context injection.

---

### 4. Extract Verdict & Summary
Extract the verdict block and final summary from a session's last assistant message:

```bash
tsx .pi/skills/session-parser/scripts/extract-verdict.ts <path-to-jsonl> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--json` | Output full structured JSON (session metadata + verdict)
| `--summary-only` | Print summary text without verdict block |
| `--verdict-only` | Print verdict JSON block only (pipe-friendly) |
| `--last N` | Auto-discover last N sessions and extract from each |
| `--source agent\|maestro\|both` | Which session store to scan (default: both) |

**Examples:**
```bash
# Extract verdict from a specific session
tsx .pi/skills/session-parser/scripts/extract-verdict.ts <path-to-jsonl>

# Get just the verdict JSON for piping into other tools
tsx .pi/skills/session-parser/scripts/extract-verdict.ts <path> --verdict-only

# Extract verdicts from last 5 maestro sessions
tsx .pi/skills/session-parser/scripts/extract-verdict.ts --last 5 --source maestro

# Full JSON output for programmatic use
tsx .pi/skills/session-parser/scripts/extract-verdict.ts <path> --json
```

**Output:** Verdict status (`approved`/`rejected`), verdict label (`ready`/`complete`/`changes required`), issues, findings, and suggested label changes — plus the full summary text from the agent's final message.

---

### 5. Extract File Operations
Get a clean overview of which files were read vs modified in a session:

```bash
tsx .pi/skills/session-parser/scripts/extract-files.ts <path-to-jsonl> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--json` | Output full structured JSON (session metadata + file ops)
| `--edits-only` | Show only edited/written files (skip reads) |
| `--reads-only` | Show only read files |
| `--count` | Show operation counts per file instead of listing each op |
| `--last N` | Auto-discover last N sessions and extract from each |
| `--source agent\|maestro\|both` | Which session store to scan (default: both) |

**Examples:**
```bash
# Show all file operations from a specific session
tsx .pi/skills/session-parser/scripts/extract-files.ts <path-to-jsonl>

# Just the modified files (no reads)
tsx .pi/skills/session-parser/scripts/extract-files.ts <path> --edits-only

# With counts for repeated operations
tsx .pi/skills/session-parser/scripts/extract-files.ts <path> --count

# Modified files from last 5 maestro sessions
tsx .pi/skills/session-parser/scripts/extract-files.ts --last 5 --source maestro --edits-only
```

**Output:** Clean list of modified files (✏️ edits, 📄 writes) and read files (👁️ reads), with optional operation counts.

---

## 📝 Typical Workflows

### "What did I do last?"
```bash
# 1. Find the most recent completed session (not the current one)
tsx .pi/skills/session-parser/scripts/list-sessions.ts --last 2

# 2. Parse it for details
tsx .pi/skills/session-parser/scripts/parse-session.ts <path-from-step-1>
```

### "Where did we decide X?"
```bash
tsx .pi/skills/session-parser/scripts/search-sessions.ts "pricing" 
```

### "Which sessions modified this file?"
```bash
tsx .pi/skills/session-parser/scripts/search-sessions.ts checkout.ts --file-path
```

### "Any sessions with errors?"
```bash
tsx .pi/skills/session-parser/scripts/search-sessions.ts "" --errors-only
```

### "Explore a maestro pipeline session"
```bash
# 1. List recent maestro sessions (multi-agent pipelines)
tsx .pi/skills/session-parser/scripts/list-sessions.ts --source maestro --last 5

# 2. Parse a specific flow from the pipeline
tsx .pi/skills/session-parser/scripts/parse-session.ts <path-from-step-1>

# 3. Search for tool calls across all maestro sessions
tsx .pi/skills/session-parser/scripts/search-sessions.ts edit --tool-name --source maestro
```

### "Compare agent vs maestro sessions"
```bash
# List from both stores side-by-side (default behavior)
tsx .pi/skills/session-parser/scripts/list-sessions.ts --last 20

# The 🤖 icon = direct agent session, 🎼 icon = maestro pipeline flow
```

### "What was the verdict on issue #230?"
```bash
# 1. Find all flows for a specific issue
tsx .pi/skills/session-parser/scripts/search-sessions.ts "ISSUE: 230" --source maestro

# 2. Extract verdicts from each flow
tsx .pi/skills/session-parser/scripts/extract-verdict.ts <path-from-step-1> --verdict-only
```

### "Quick status of last N sessions"
```bash
# Get verdicts from the 5 most recent maestro sessions
tsx .pi/skills/session-parser/scripts/extract-verdict.ts --last 5 --source maestro

# Or just the JSON verdict blocks for piping
tsx .pi/skills/session-parser/scripts/extract-verdict.ts --last 10 --source maestro --verdict-only
```

### "What happened in this session?"
```bash
# 1. Get the verdict and summary
tsx .pi/skills/session-parser/scripts/extract-verdict.ts <path>

# 2. See what files were touched
tsx .pi/skills/session-parser/scripts/extract-files.ts <path> --edits-only --count
```

### "Quick diff of last N sessions"
```bash
# Show verdicts and modified files from recent maestro runs
tsx .pi/skills/session-parser/scripts/extract-verdict.ts --last 5 --source maestro --verdict-only
tsx .pi/skills/session-parser/scripts/extract-files.ts --last 5 --source maestro --edits-only --count
```

---

## 🔗 Related Resources

- **Issue tracker conventions** — [`docs/agents/issue-tracker.md`](../../docs/agents/issue-tracker.md) — How to create, read, comment on, and label GitHub issues via `gh` CLI. Use alongside session parsing when cross-referencing maestro verdicts with issue state.

## 📚 Library Reference
The underlying logic is in `shared/lib/session-parser.ts`. It exports:
*   `parseSessionLog(filePath): SessionSummary` - Returns `{ markdown, json }`.
