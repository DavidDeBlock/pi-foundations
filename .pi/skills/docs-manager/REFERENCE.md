# Docs Manager — Reference

Detailed documentation for each script, its internals, and output formats.

---

## Script: `scan-inventory.ts`

### Purpose

Phase 1 of the docs reorganization pipeline. Scans all `.md` files under a directory, assigns stable sequential IDs (`F0001`, `F0002`, ...), applies heuristic flags, and writes structured YAML blocks to `DOCS_INVENTORY.md`.

### Usage

```bash
npx tsx scripts/scan-inventory.ts [docs-dir]
# Default docs-dir: ./docs (resolved from project root)
```

### Heuristic Flags

| Flag | Condition | Example |
|------|-----------|---------|
| `largeFile` | File size > 50KB | A 62KB architecture doc |
| `isDraftOrTemp` | Basename starts with `draft`, `temp`, `tmp`, `scratch`, `wip`, `todo` (case-insensitive) | `draft-plan.md` |
| `isDuplicateBasename` | Same filename appears in multiple folders | `README.md` in 3 different subfolders |

### Output Format: `DOCS_INVENTORY.md`

```markdown
# DOCS_INVENTORY.md — File Inventory

## Folder Summary
| Folder | Total Files | Total Size (KB) |
|--------|-------------|-----------------|

## File Entries

### docs/01-onboarding
```yaml
id: F0001
path: docs/01-onboarding/setup-guide.md
folder: docs/01-onboarding
size_kb: 4.23
lines: 142
status: scanned
class: null
confidence: null
proposed_action: null
approval: null
risk: null
reason: null
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-05-15T...
```

### Key fields for Phase 2 (classification)

| Field | Set By | Meaning |
|-------|--------|---------|
| `status` | Script → Agent | `scanned` initially; agent updates during classification |
| `class` | Agent | One of: canonical, stale, duplicate, archive, experiment, decision |
| `confidence` | Agent | high / medium / low — determines if escalation needed |
| `proposed_action` | Agent | keep, move, archive, delete, merge-into, rewrite |
| `approval` | Human | approved / rejected (for destructive actions) |
| `questions` | Agent | Array of Q### references to DOCS_QUESTIONS.md |

---

## Script: `classify-inventory.ts`

### Purpose

Phase 2 of the docs reorganization pipeline. Parses DOCS_INVENTORY.md, applies deterministic classification rules from DOCS_RULES.md, and either writes results back (`--auto`) or outputs uncertain entries as JSONL for agent batch review (`--uncertain`).

### Usage

```bash
# Auto-classify obvious files (writes back to inventory)
npx tsx scripts/classify-inventory.ts docs --auto

# Output uncertain entries as JSONL for agent review
npx tsx scripts/classify-inventory.ts docs --uncertain --batch-size=5
```

### Classification Rules (evaluated in order, first match wins)

| Rule Name | Condition | Class | Confidence | Action |
|-----------|-----------|-------|------------|--------|
| `draft-or-temp-name` | Flag: isDraftOrTemp | experiment | high | archive |
| `empty-or-near-empty-file` | lines < 3 AND size_kb < 0.1 | stale | high | archive |
| `adr-folder` | folder matches `/adr/` | decision | high | move → 40-decisions/ |
| `patterns-folder-in-architecture` | folder matches architecture/patterns | canonical | high | move → 20-architecture/patterns/ |
| `prd-folder-active` | folder matches /prd or /prds | canonical | high | move → 35-prds/ |
| `contracts-folder` | folder matches /contracts | canonical | high | move → 20-architecture/ |
| `agent-workflows-folder` | folder is 50-agent-workflows | canonical | high | keep |
| `archive-folder` | folder is 90-archive | archive | high | keep |
| `plan-file-name` | basename starts with plan or ends with -plan.md | stale | medium | archive |
| `fix-or-todo-file-name` | basename starts with fix- or todo | stale | medium | archive |
| `root-docs-file` | folder is docs root | null (uncertain) | low | — |
| `non-canonical-folder` | folder not in canonical list | null (uncertain) | low | — |

### --auto Mode Output

- **Writes:** Updated DOCS_INVENTORY.md with classified entries
- **Console:** Summary counts (total, auto-classified, uncertain)
- **Side effects:** None other than inventory file update

### --uncertain Mode Output (JSONL)

Each line is a JSON object containing:

```json
{
  "id": "F0048",
  "path": "docs/flows.md",
  "folder": "docs",
  "size_kb": 7.33,
  "lines": 103,
  "status": "scanned",
  "class": null,
  "confidence": "low",
  "proposed_action": null,
  "docAnalysis": {
    "sections": [{"heading": "Direct Sale Flow", "level": 2, "summary": "..."}],
    "crossReferences": [],
    "wordCount": 450
  },
  "suggestedClasses": ["canonical", "stale"],
  "ruleMatches": ["root-docs-file"]
}
```

### Agent Workflow for Uncertain Entries

1. Run `--uncertain --batch-size=5` → read N JSONL lines from stdout
2. For each entry: decide class, reason, proposed_action based on docAnalysis content
3. Edit the entry's YAML block in-place in DOCS_INVENTORY.md
4. Write escalation questions to DOCS_QUESTIONS.md if confidence is low or action affects project truth
5. Repeat until `--uncertain` outputs 0 entries (all classified)

---

## Script: `verify-structure.ts`

### Purpose

Phase 5 validation. Checks the docs directory against canonical folder rules from `DOCS_RULES.md`. Detects structural problems and generates a status index.

### Usage

```bash
npx tsx scripts/verify-structure.ts [docs-dir]
# Default docs-dir: ./docs (resolved from project root)
```

### Canonical Folders

| Folder | Type | Constraints |
|--------|------|-------------|
| `00-current/` | living state | Max 3–5 files. No old plans or deep implementation notes. |
| `10-domain/` | living state | Business/domain language only. No technical details. |
| `20-architecture/` | living state | Technical system design. Not temporary tasks. |
| `30-flows/` | living state | Vertical user flows. End-to-end behavior. |
| `40-decisions/` | living state | ADRs and accepted decisions. One per file. |
| `50-agent-workflows/` | living state | AI/agent workflows, prompts, processes. |
| `90-archive/` | archive | Historical reference only. Not canonical. |

### Violations Detected

| Rule | Condition | Example |
|------|-----------|---------|
| `max-files` | `00-current/` has > 5 files | Folder with 7 plan documents |
| `no-old-plans` | File matching old-plan pattern in living state folder | `fix-todo-plan.md` in `10-domain/` |

Old-plan patterns: `^plan`, `^fix[-_]`, `^todo`, `^draft`, `^wip`, `-plan.`, `-fix.` (case-insensitive)

### Output Format: `DOCS_INDEX.md`

```markdown
# DOCS_INDEX.md — Documentation Structure Index

## Folder Summary
| Status | Folder | Files | Type |
|--------|--------|-------|------|
| ✅ | `10-domain/` | 3 | canonical |
| ⚠️ | `00-current/` | 0 | canonical |
| ❌ | `50-agent-workflows/` | 6 | canonical |

## Root-Level Files ⚠️
- `README.md`
- `temp.md`

## Violations ❌
- **50-agent-workflows/** [max-files]: ...

## Empty Folders ⚠️
- `30-flows/` (0 files)

## Non-Canonical Folders ⚠️
- `react-guides/` (6 files)
```

Status indicators: ✅ = clean, ⚠️ = warning (empty/orphan), ❌ = violation

---

## Script: `parse-doc-file.ts`

### Purpose

Analyzes a single markdown file. Extracts section structure, cross-references (markdown links), and word count. Outputs structured JSON for agent consumption.

### Usage

```bash
npx tsx scripts/parse-doc-file.ts <path-to-md>
# Exits with code 1 if file not found or no path given
```

### Output Format (JSON)

```json
{
  "filePath": "/absolute/path/to/file.md",
  "fileType": "markdown",
  "wordCount": 1234,
  "flags": {
    "largeFile": false
  },
  "sections": [
    {
      "heading": "Installation",
      "level": 2,
      "lineNumber": 5,
      "summary": "Step-by-step guide to setting up...\nRun the following command..."
    }
  ],
  "crossReferences": [
    {
      "text": "architecture overview",
      "target": "./02-architecture/overview.md",
      "lineNumber": 42,
      "isExternal": false
    },
    {
      "text": "React docs",
      "target": "https://react.dev/docs",
      "lineNumber": 87,
      "isExternal": true
    }
  ]
}
```

### Processing Limits

| Parameter | Value | Notes |
|-----------|-------|-------|
| Large file threshold | 50KB | Files above this get `largeFile: true` flag |
| Max processing lines | 2000 | For large files, only first 2000 lines are analyzed |
| Summary lines per section | 5 | First 5 non-empty, non-heading lines after each heading |

---

## Script: `generate-questions.ts`

### Purpose

Phase 3 of the docs reorganization pipeline. Generates structured questions for human review from medium-confidence inventory entries. Two modes to keep context small:
1. **Overview** — compact summary table (fits in one message)
2. **Batch** — loopable question generation, appends incrementally to `DOCS_QUESTIONS.md`

### Usage

```bash
# Overview: see what needs review (small output)
npx tsx scripts/generate-questions.ts docs --overview

# Batch: generate questions for first N entries
npx tsx scripts/generate-questions.ts docs --batch --size=5

# Resume from offset
npx tsx scripts/generate-questions.ts docs --batch --size=5 --start=5
```

### --overview Mode Output

Compact summary table to console:

```
📋 Phase 3 Overview — 25 entries need human review

| # | Group | Files | Classes | Actions |
|---|-------|-------|---------|---------|
|  1 | `docs/02-architecture/` | F0013, F0014 | stale | archive |
|  2 | `docs/04-operations/` | F0024, F0025, ... | stale | archive |
...
```

### --batch Mode Output

Appends questions to `DOCS_QUESTIONS.md`. Console shows:

```
📝 Batch 1–3 of 25
   Generated 2 question(s): Q2–Q3
   Written to: /path/to/DOCS_QUESTIONS.md

📊 Remaining: 22 entries in 8 more batch(es)
   Next: npx tsx scripts/generate-questions.ts docs --batch --size=3 --start=3
```

### Question Generation Logic

1. Parses `DOCS_INVENTORY.md` → filters medium-confidence or null-class entries
2. Groups entries by folder pattern (reduces question count)
3. Derives question text from classification context:
   - Archive-only groups: "Should these files be archived?"
   - Move groups: Shows source → target paths
   - Mixed/unknown: Open-ended handling question
4. Appends to `DOCS_QUESTIONS.md` under "Active Questions" section
5. Auto-increments Q number from existing questions in file

### Loop Pattern

```bash
# Step 1: See overview
npx tsx scripts/generate-questions.ts docs --overview

# Step 2: Generate first batch
npx tsx scripts/generate-questions.ts docs --batch --size=3
# → outputs "Next: ... --start=3"

# Step 3: Continue with next batch
npx tsx scripts/generate-questions.ts docs --batch --size=3 --start=3
# → outputs "Next: ... --start=6"

# Repeat until "All entries processed — no remaining batches."
```

### Question Format (appended to DOCS_QUESTIONS.md)

```markdown
## Q002 — Review: docs/04-operations/

**Related Files:** F0024, F0025, F0028  
**Context:** Classification reasoning: [reasons from inventory]  
**Question:** Should these 3 file(s) be archived? They are classified as "stale" with proposed action: archive.  

- [ ] Answered  
- **Answer:** _(fill during Phase 3)_
```

---

## Pipeline Phases Overview

```
Phase 0: FOUNDATION   → Rules, target structure, state files in place (DOCS_RULES.md)
Phase 1: INVENTORY    → scan-inventory.ts populates DOCS_INVENTORY.md
Phase 2a: AUTO-CLASSIFY → classify-inventory.ts --auto applies deterministic rules
Phase 2b: AGENT REVIEW   → classify-inventory.ts --uncertain outputs JSONL batches for agent review
Phase 3: REVIEW       → Human answers questions from DOCS_QUESTIONS.md
Phase 4: MIGRATE      → Agent moves/renames files into target structure
Phase 5: VERIFY       → verify-structure.ts validates final structure
```

## Files in `docs/_system/`

| File | Owner | Updated By | Purpose |
|------|-------|------------|---------|
| `DOCS_RULES.md` | Human (read-only) | Human only | Classification categories, action types, escalation rules, folder map |
| `DOCS_INVENTORY.md` | System | scan-inventory.ts → Agent | YAML blocks per file with stable IDs. Source of truth for reorganization state. |
| `DOCS_INDEX.md` | System | verify-structure.ts | Auto-generated structure index with status indicators |
| `DOCS_PROGRESS.md` | System | Agent | Tracks current pipeline phase and completion status |
| `DOCS_QUESTIONS.md` | Human | Agent (proposes), Human (answers) | Escalation questions requiring human decision |
| `DOCS_ARCHIVE_LOG.md` | System | Agent | Log of archived files with original paths |
| `work-sessions/` | System | Agent | Individual work session files (`WS####.md`) for high-risk operations |
