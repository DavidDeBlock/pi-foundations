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
All project sessions are stored in:
```bash
/home/david/.pi/agent/sessions/--home-david-projects-pi-pos-v1--/
```

Files are named with timestamps (e.g., `2026-05-07T15-28-33-649Z_...jsonl`).

---

## 🛠️ Usage

### 1. List Sessions
Browse available sessions sorted newest-first:

```bash
tsx .pi/skills/session-parser/scripts/list-sessions.ts [options] [session-dir]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--last N` | Show only the last N sessions (default: all) |
| `--today` | Show only today's sessions |
| `--path` | Print file paths only (machine-readable, pipe-friendly) |

**Examples:**
```bash
# List 5 most recent sessions
tsx .pi/skills/session-parser/scripts/list-sessions.ts --last 5

# List all of today's sessions
tsx .pi/skills/session-parser/scripts/list-sessions.ts --today

# Get paths only (for piping into parse-session.ts)
tsx .pi/skills/session-parser/scripts/list-sessions.ts --path --last 1
```

**Output:** Table with rank, timestamp, file size, event count, session ID, and a title extracted from the first user message.

---

### 2. Search Sessions
Search across all session logs for tool calls, file paths, errors, or text:

```bash
tsx .pi/skills/session-parser/scripts/search-sessions.ts <query> [options] [session-dir]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--tool-name` | Match against tool call names (e.g., "edit", "bash") |
| `--file-path` | Match against file paths in tool arguments |
| `--errors-only` | Only show sessions that contain errors |
| `--context N` | Show N lines of context around matches (default: 1) |
| `--json` | Output structured JSON instead of human-readable text |

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

---

## 📚 Library Reference
The underlying logic is in `shared/lib/session-parser.ts`. It exports:
*   `parseSessionLog(filePath): SessionSummary` - Returns `{ markdown, json }`.
