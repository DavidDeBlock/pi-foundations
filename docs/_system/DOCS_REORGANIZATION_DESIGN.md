# Docs Reorganization System — Design Document

**Created:** 2026-05-15  
**Status:** Approved / Ready to implement  
**Purpose:** Captures all design decisions for the controlled documentation reorganization workflow

---

## Problem Statement

The `docs/` folder contains mixed project information: current context, old notes, experiments, agent outputs, architecture ideas, implementation notes, and probably stale or duplicate files. Asking an agent to "clean up the docs" directly is unsafe because it will want to read everything and may create more chaos.

## Goal

Design a system where agents first work from indexes, inventories, and progress files instead of reading the full docs folder. The workflow should support:
- Soft research: map folders/files, line counts, large files, rough summaries
- Macro progress tracking: which folders/files are inventoried, reviewed, migrated, archived, or blocked
- Micro progress tracking: what is happening inside a selected file
- File classification: current, canonical, stale, duplicate, archive, decision, workflow, etc.
- User questions only when a real project/domain decision is needed
- Every action updating the relevant index/progress/context files

## Design Decisions

### Q1 — Primary Consumer
**Decision:** AI agents only (humans rarely browse `docs/` directly)  
**Rationale:** Index files optimized for token efficiency, structured data, minimal prose

### Q2 — One-time vs Ongoing
**Decision:** Cleanup pipeline that runs once but could be used regularly to 'update' documentation  
**Future goal:** Automatable flows like the existing GitHub issues loop (`run-slices.sh`)

### Q3 — Orchestration Model
**Decision:** Manual multi-session workflow first, shell script automation later  
**Rationale:** Each phase is a self-contained session with its own skill/prompt; progress persists in files between sessions; user picks up where they left off by loading the progress file

### Q4 — Classification Categories
| Category | Meaning | Example |
|----------|---------|---------|
| **canonical** | Current source of truth, actively maintained | `01-onboarding/`, `02-architecture/overview.md` |
| **stale** | Was relevant, now outdated or superseded | `react-router-fix-plan.md` (if already implemented) |
| **duplicate** | Same content exists elsewhere | `docs/prds/repair-calendar.md` vs `docs/prd/...` |
| **archive** | Keep for reference but not active | Completed PRDs, old roadmaps |
| **experiment** | Research/exploration, may or may not ship | `react-guides/`, `temp.md` |
| **decision** | ADRs, architectural choices | `docs/40-decisions/0001-invoices-and-quotes.md` |

### Q5 — Pipeline Phases
```
Phase 1: INVENTORY   → Agent scans docs/, populates DOCS_INVENTORY.md 
                       (path, size, line-count, folder, rough one-line summary)
                       No reading full content yet. Just metadata + first 5 lines.

Phase 2: CLASSIFY+PROPOSE → Agent reads inventory, classifies each file into target bucket
                       Updates DOCS_INVENTORY.md with classification tags
                       Flags ambiguities in DOCS_QUESTIONS.md for user review

Phase 3: REVIEW      → You (the human) answer questions from DOCS_QUESTIONS.md
                       Agent updates classifications based on your answers

Phase 4: MIGRATE     → Agent moves/renames files into target structure
                       Logs every action in DOCS_ARCHIVE_LOG.md
                       Updates DOCS_INDEX.md to reflect new state

Phase 5: VERIFY      → Agent validates final structure matches rules
                       Checks for orphans, broken references, empty folders
```

### Q6 — Inventory Scan Depth & Large File Handling
**Decision:** Scripts do I/O-heavy work; agents consume structured output  
**Pattern:** Similar to `session-parser` skill (list-sessions.ts + parse-session.ts)  
**Scripts needed:**
- `scan-inventory.ts` — Phase 1: metadata + shallow read for ALL files
- `parse-doc-file.ts` — On-demand deep analysis of ONE file when classification is ambiguous

### Q7 — Script Intelligence Level
**Decision:** Raw metadata + heuristic flags (combination approach)  
**Script handles:** Deterministic patterns (file size, name patterns, obvious duplicates)  
**Agent handles:** Semantic judgment, content understanding, domain decisions

### Q8a — Auto-Classification Approach
**Decision:** Agent auto-classifies files as **proposed classification** in inventory/progress files only  
**Rules:**
- Write classification to DOCS_INVENTORY.md ✅
- Update DOCS_PROGRESS.md status to classified ✅
- Add confidence level: high / medium / low ✅
- Add reason for classification ✅
- **Must NOT** automatically move, merge, delete, rewrite, or mark something as canonical truth ❌

### Q8b — Escalation Thresholds
**Auto-classify everything with clear signals, but escalate when classification affects project truth.**

**Escalate to DOCS_QUESTIONS.md when:**
- A file could be canonical but conflicts with another file
- A file may replace or invalidate another document
- A file contains domain/business rules
- A file affects DB/API/frontend naming
- A file has mixed current and stale content
- Two similar files both look important
- Agent confidence is low or medium for a destructive/structural action

**Do NOT escalate for obvious bookkeeping:**
- temp/scratch/draft files
- Exact duplicates
- Old agent outputs
- Clearly historical experiment notes
- Empty or near-empty files
- Files only being marked for later review

### Q9a — Classification + Action Timing
**Decision:** Inline approach (classification + proposed action in one pass)  
**Workflow:**
1. Inventory
2. Classify + propose action inline
3. Review action plan
4. Execute only approved low-risk batches
5. Defer risky actions to focused sessions

### Q9b — Merge/Rewrite Handling
**Decision:** Deferred to separate focused micro-sessions (one per file/topic)  
**Rules:**
- `keep` / `move` / `archive` can be batched when low-risk
- `delete` requires explicit approval unless empty or exact duplicate
- `merge-into` should be one target file or one topic per session
- `rewrite` should be one file per session
- Canonical documents should never be rewritten as part of a bulk operation

**Core principle:** Classify and propose actions in bulk. Execute simple actions in small batches. Handle merge/rewrite as focused micro-sessions.

### Q10a — Inventory Format
**Decision:** Hybrid structure with YAML blocks (not large markdown tables)  
**Structure:**
1. Human-readable header summary
2. Folder-level summary table
3. Machine-readable YAML block per file
4. Questions summary at the end

Each file entry has a stable ID (F0001, F0002, etc.)

### Q10b — Inventory Organization
**Decision:** Grouped sections for humans, flat IDs globally  
- IDs are flat: F0001, F0002, F0003...
- Entries grouped by current folder in markdown
- Folder summaries show progress per folder
- Scripts can parse every YAML block by ID/path

### Q11a — DOCS_RULES.md Ownership
**Decision:** Human-owned, agent-read-only  
**Rules:**
- Agents can read DOCS_RULES.md ✅
- Agents must follow it ✅
- Agents can propose rule changes in DOCS_QUESTIONS.md or DOCS_RULES_PROPOSALS.md ✅
- Only the user/human may approve and apply rule changes ❌

### Q11b — Content Ownership Rules
**Decision:** Yes, define strict content ownership per folder

| Folder | Purpose | Constraints |
|--------|---------|-------------|
| `00-current/` | Living project state only | Small, high-signal, frequently updated. Max 3-5 files. No old plans or deep implementation notes. |
| `10-domain/` | Business/domain language only | POS concepts, repair flow terminology, customer/product/sale/repair meanings. No technical implementation details. |
| `20-architecture/` | Technical structure and system design | Backend, frontend, database, API contracts, document model, stock ledger. Describes how the system is designed, not temporary tasks. |
| `30-flows/` | Vertical user flows | Direct sale, repair intake, repair completion, stock correction, invoicing. End-to-end behavior descriptions. |
| `40-decisions/` | ADRs and accepted decisions | One decision per file. Explains context, decision, consequences, and date. |
| `50-agent-workflows/` | AI/agent workflows | Prompts, loops, implementation process, review process, context update process. |
| `90-archive/` | Historical reference only | Not canonical. Preserve original path where possible. |

**Core rule:** Content determines placement, but placement determines authority.  
A file in 00-current through 40-decisions may be treated as current truth.  
A file in 90-archive may only be used as background reference.  
If a file contains mixed ownership, propose split or rewrite instead of placing it as-is.

### Q12 — Progress Tracking
**Decision:** Hybrid approach with three levels

| File | Purpose | Scope |
|------|---------|-------|
| `DOCS_PROGRESS.md` | Macro tracker | Overall pipeline status, folder progress, session history |
| `DOCS_INVENTORY.md` | Per-file micro tracker | YAML blocks contain: status, class, confidence, proposed_action, approval, risk, reason, questions, target_path, last_updated, current_step, blocker |
| `work-sessions/WS*.md` | High-risk focused work | Only for merge-into, rewrite, canonical restructuring, conflict resolution, file splitting |

**Rules:**
- Normal file progress lives in DOCS_INVENTORY.md ✅
- Complex content work gets a dedicated work-session file ✅
- DOCS_PROGRESS.md only summarizes where the whole reorganization stands ✅
- Do NOT create separate micro-progress files for normal keep/move/archive/delete actions ❌

---

## Target File Structure

```
docs/
├── _system/                          # Agent working area (never moves)
│   ├── DOCS_RULES.md                 # Human-owned, agent-read-only rules
│   ├── DOCS_INDEX.md                 # Folder-level map + counts (auto-generated from inventory)
│   ├── DOCS_INVENTORY.md             # YAML blocks per file — source of truth for all state
│   ├── DOCS_PROGRESS.md              # Macro pipeline tracker + session log
│   ├── DOCS_QUESTIONS.md             # Pending user decisions blocking progress
│   ├── DOCS_ARCHIVE_LOG.md           # Audit trail: what moved/merged/deleted and when
│   └── work-sessions/                # High-risk focused work (created on-demand)
├── 00-current/                       # Living project state (max 3-5 files)
├── 10-domain/                        # Business/domain language only
├── 20-architecture/                  # Technical system design
├── 30-flows/                         # Vertical user flows
├── 40-decisions/                     # ADRs and accepted decisions
├── 50-agent-workflows/               # AI/agent workflows, prompts, loops
└── 90-archive/                       # Historical reference only (preserve original paths)
```

## YAML Block Schema

```yaml
id: F0001
path: docs/temp.md
folder: docs
size_kb: 92
lines: 3847
status: scanned          # unscanned | scanned | classified | approved | executed | blocked
class: null              # canonical | stale | duplicate | archive | experiment | decision
confidence: null         # high | medium | low
proposed_action: null    # keep | move | merge-into | archive | delete | rewrite
approval: null           # auto | pending | approved | rejected
risk: null               # none | low | medium | high
reason: null             # Short explanation for classification/action
questions: []            # References to DOCS_QUESTIONS.md entries (e.g., [Q001])
related_files: []        # Other file IDs with similar/overlapping content
target_path: null        # Where the file should end up after migration
current_step: null       # For work-sessions: which step is active
blocker: null            # What's blocking progress (if any)
last_updated: 2026-05-15T14:30:00Z
```

## Work-Session File Format

```markdown
# WS0001 — [Action] [Topic]

## Goal
[What this session aims to accomplish]

## Source Files
| ID | Path | Class | Notes |
|----|------|-------|-------|

## Target File
[path where result should live]

## Assumptions
- [List assumptions being made]

## Sections Reviewed
- [ ] Section 1
- [x] Section 2 (completed)

## Conflicts Found
1. [Description of conflict]

## User Questions
- [Q###] See DOCS_QUESTIONS.md#q### — [Question text]

## Proposed Final Action
[What will happen once all questions are answered]

## Execution Checklist
- [ ] User answered all questions
- [ ] Content drafted/merged
- [ ] Target file written
- [ ] Source files archived/moved
- [ ] DOCS_INVENTORY.md updated
- [ ] DOCS_ARCHIVE_LOG.md entry added

## Verification Checklist
- [ ] No orphaned references to old paths
- [ ] Content ownership matches folder rules
- [ ] File size within limits
```

## Core Principles Summary

| Principle | Detail |
|-----------|--------|
| **Auto-classify freely** | Classification + action proposal happens in bulk |
| **Auto-act cautiously** | No file moves/deletes without approval |
| **Ask before canonical changes** | Escalate to DOCS_QUESTIONS.md when truth is affected |
| **Archive > delete** | Preserve unless exact duplicate or empty |
| **One merge/rewrite per session** | High-risk work gets dedicated work-session files |
| **DOCS_RULES.md human-owned** | Agents read-only, propose changes via questions file |
| **Placement = authority** | Files in numbered folders are current truth; 90-archive is reference only |
| **Content determines placement, placement determines authority** | Mixed-ownership files get split/rewrite proposals, not forced placement |

---

## Next Steps

1. Create `DOCS_RULES.md` with all rules from this design
2. Build `scan-inventory.ts` script for Phase 1
3. Build `parse-doc-file.ts` script for on-demand deep analysis
4. Initialize empty `DOCS_INVENTORY.md`, `DOCS_PROGRESS.md`, `DOCS_QUESTIONS.md`, `DOCS_ARCHIVE_LOG.md`
5. Run Phase 1 (Inventory) manually
6. Begin Phase 2 (Classify + Propose) in agent session
