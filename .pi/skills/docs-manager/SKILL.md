---
name: docs-manager
description: >-
  Manages project documentation lifecycle via scripts in `scripts/`. Scans inventory, validates structure against canonical rules, and parses individual doc files. Use when generating or updating DOCS_INVENTORY.md, verifying docs folder structure, checking for orphaned files, parsing a doc file for sections/cross-references, or running the documentation reorganization pipeline phases.
---

# Docs Manager

Operates scripts in `scripts/` that manage documentation state in `docs/_system/`.

## Quick start

```bash
npx tsx scripts/scan-inventory.ts docs          # Phase 1: writes DOCS_INVENTORY.md
npx tsx scripts/classify-inventory.ts docs --auto    # Phase 2a: auto-classifies obvious files
npx tsx scripts/classify-inventory.ts docs --uncertain --batch-size=5  # Phase 2b: outputs uncertain entries as JSONL
npx tsx scripts/generate-questions.ts docs --overview   # Phase 3a: summary of entries needing review
npx tsx scripts/generate-questions.ts docs --batch      # Phase 3b: generate questions in batches
npx tsx scripts/verify-structure.ts docs         # Phase 5: writes DOCS_INDEX.md, reports violations
npx tsx scripts/parse-doc-file.ts <path-to-md>   # → outputs JSON analysis to stdout
```

## Workflows

### Scan inventory (Phase 1)

Scan all `.md` files under `docs/`, exclude `_system/`, assign stable IDs and write YAML blocks.

```bash
npx tsx scripts/scan-inventory.ts docs
```

- Output: `docs/_system/DOCS_INVENTORY.md`
- Excludes: `_system/` directory (state files, not content)
- Flags: large files (>50KB), draft/temp names, duplicate basenames

### Verify structure (Phase 5)

Validate folder layout against canonical rules from `DOCS_RULES.md`. Detect orphans, empty folders, and constraint violations.

```bash
npx tsx scripts/verify-structure.ts docs
```

- Output: `docs/_system/DOCS_INDEX.md` + console report
- Checks: canonical folder presence, max files in `00-current/`, old-plan patterns in living state folders
- Returns exit 0 on pass, reports violations on fail

### Classify inventory (Phase 2)

Classifies each file in the inventory against rules from `DOCS_RULES.md`. Two modes:

#### Auto-classify obvious files (`--auto`)

Applies deterministic rules to classify files with high/medium confidence. Writes results directly back to `DOCS_INVENTORY.md`.

```bash
npx tsx scripts/classify-inventory.ts docs --auto
```

- **Input:** `docs/_system/DOCS_INVENTORY.md` (from Phase 1 scan)
- **Output:** Updated inventory with `class`, `confidence`, `proposed_action`, `target_path`, `reason` filled in
- **Rules applied:**
  - Flag-based: draft/temp names → experiment/archive, near-empty files → stale/archive
  - Folder-based: `adr/` → decision/40-decisions/, `prd/` → canonical/35-prds/, `patterns/` → canonical/20-architecture/patterns/
  - Already-correct folders (50-agent-workflows, 90-archive) → keep
  - Non-canonical folders and root files → marked uncertain (low confidence)
- **Console output:** counts of auto-classified vs uncertain entries

#### Output uncertain entries for batch review (`--uncertain`)

Outputs uncertain/low-confidence entries as JSONL to stdout, one per line. Each line includes the full block data plus parsed doc content from `parseDocFile()`.

```bash
npx tsx scripts/classify-inventory.ts docs --uncertain --batch-size=5
```

- **Output:** N lines of JSONL to stdout (each line is a complete entry with sections, cross-references, suggested classes)
- **Agent workflow after output:**
  1. Read the batch from stdout (small context — only N entries)
  2. Decide `class`, `reason`, `proposed_action` for each
  3. Edit their YAML blocks in-place in `DOCS_INVENTORY.md`
  4. Write escalation questions to `DOCS_QUESTIONS.md` if needed
  5. Repeat until no uncertain entries remain
- **Repeat** with same command — always outputs the next N unclassified entries

### Generate questions (Phase 3)

Two modes — overview first, then batch loop:

#### Overview (`--overview`)

Outputs a compact summary table of all entries needing human review. Small context footprint.

```bash
npx tsx scripts/generate-questions.ts docs --overview
```

- **Output:** Summary table to console (group, file IDs, classes, actions)
- **Use case:** See what needs decisions before generating questions
- **Context cost:** Minimal — just a summary table

#### Batch generate (`--batch`)

Generates structured questions for entries in batches. Loopable — each run processes the next batch and appends to `DOCS_QUESTIONS.md`.

```bash
# First batch (entries 1–5)
npx tsx scripts/generate-questions.ts docs --batch --size=5

# Resume from offset
npx tsx scripts/generate-questions.ts docs --batch --size=5 --start=5
```

- **Input:** `docs/_system/DOCS_INVENTORY.md` (medium-confidence entries)
- **Output:** Appends questions to `docs/_system/DOCS_QUESTIONS.md`
- **Console output:** Batch range, question numbers generated, remaining count, next command
- **Loop pattern:**
  1. Run with `--overview` → see groups needing review
  2. Run with `--batch --size=N` → generates questions for first N entries
  3. Repeat with `--start=K` until "All entries processed"
  4. Human reviews `DOCS_QUESTIONS.md`, fills answers
- **Question grouping:** Entries in same folder are grouped into single question (reduces question count)

### Parse a single doc file

Extract sections, cross-references, and word count from one markdown file.

```bash
npx tsx scripts/parse-doc-file.ts docs/path/to/file.md
```

- Output: JSON to stdout (sections with headings/summaries, cross-reference links, flags)
- Large files (>50KB): capped at 2000 lines processed

## Pipeline reference

See [REFERENCE.md](REFERENCE.md) for full pipeline phases, script internals, and output formats.
