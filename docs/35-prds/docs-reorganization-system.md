# PRD: Controlled Documentation Reorganization System

## Problem Statement

The `docs/` folder contains mixed project information: current context, old notes, experiments, agent outputs, architecture ideas, implementation notes, and stale or duplicate files. Asking an AI agent to "clean up the docs" directly is unsafe because it will want to read everything at once, exceed context limits, and may create more chaos by making uninformed structural changes.

There is no controlled workflow for agents to discover, classify, and migrate documentation incrementally across sessions while preserving user control over canonical truth. The result is information overload, lost knowledge, and documentation that drifts out of sync with the actual codebase.

## Solution

A phased reorganization system where AI agents work from indexes, inventories, and progress files instead of reading the full docs folder directly. The system provides:

- **Script-based inventory scanning** — deterministic metadata collection without context window pressure
- **Agent-driven classification** — bulk analysis with confidence levels and proposed actions
- **User-controlled escalation** — questions raised only when project/domain truth is affected
- **Phased execution** — low-risk actions batched, high-risk work deferred to focused micro-sessions
- **Persistent progress tracking** — state survives across sessions, enabling manual multi-session workflows today and shell-script automation later

The system produces a clean, numbered folder structure with strict content ownership rules that prevents future chaos.

## User Stories

1. As a developer using AI agents, I want the agent to scan my docs folder without reading every file's full content, so that it can build an inventory efficiently without blowing context limits
2. As a developer, I want the agent to classify each doc file with a confidence level and reason, so that I can trust or challenge its judgment before any changes happen
3. As a developer, I want proposed actions (move/archive/delete/merge) separated from classification, so that I can review what will change before anything moves
4. As a developer, I want the agent to escalate ambiguous cases to a questions file instead of guessing, so that project/domain truth is never compromised by automated decisions
5. As a developer, I want low-risk actions (keep/move/archive) batched together, so that simple reorganization completes quickly without manual oversight for each file
6. As a developer, I want high-risk actions (merge/rewrite/canonical restructuring) deferred to focused micro-sessions, so that complex content work gets the attention it deserves
7. As a developer, I want progress tracked in files between sessions, so that I can pause and resume reorganization across multiple agent sessions without losing state
8. As a developer, I want an audit log of every file move/merge/delete with timestamps and reasons, so that I can trace what changed and why
9. As a developer, I want folder-level content ownership rules defined upfront, so that agents know where each type of document belongs and don't place things arbitrarily
10. As a developer, I want the inventory to use YAML blocks per file with stable IDs, so that future automation scripts can parse it reliably without fragile markdown table parsing
11. As a developer, I want the rules file (DOCS_RULES.md) to be human-owned and agent-read-only, so that the operating rules of the documentation system don't drift during reorganization
12. As a developer, I want folder summary tables in the inventory showing progress per folder, so that I can see at a glance which areas are done and which need attention
13. As a developer, I want large files (>50KB) handled with sampling strategies instead of full reads during inventory, so that massive agent output dumps don't consume the entire context window
14. As a developer, I want archive to be preferred over delete for uncertain cases, so that knowledge is preserved even when its current relevance is unclear
15. As a developer, I want work-session files created only for complex content operations (merge/rewrite/conflict resolution), so that normal file tracking stays simple in the inventory while complex work gets dedicated space
16. As a developer, I want the system to support manual multi-session workflows today with shell-script automation as a future goal, so that I can validate the process before automating it

## Implementation Decisions

### Modules and Components

| Module | Purpose | Layer |
|--------|---------|-------|
| `scan-inventory.ts` | Script that scans docs/ folder, collects metadata (path, size, line count, headers), applies heuristic flags (large file, temp/draft name, obvious duplicate pattern), outputs structured data to DOCS_INVENTORY.md | Infrastructure / Phase 1 |
| `parse-doc-file.ts` | Script for on-demand deep analysis of a single file: extracts section headers, content summary, cross-references. Used during classification when shallow scan is insufficient or during work-sessions | Infrastructure / On-demand |
| DOCS_RULES.md | Human-owned rulebook defining classification categories, action types, escalation thresholds, execution rules, target structure, and naming conventions. Agent-read-only. | Configuration |
| DOCS_INVENTORY.md | Central state file containing YAML blocks per file with stable IDs (F0001, F0002...), grouped by current folder. Tracks status, classification, confidence, proposed action, risk, approval, reason, questions, related files, target path, and timestamps. Source of truth for all reorganization state. | State / Phase 1-5 |
| DOCS_PROGRESS.md | Macro tracker showing pipeline phase status (inventory/classify/review/execute/verify), folder-level progress summaries, and session history log | State / All phases |
| DOCS_QUESTIONS.md | Escalation file where agents record decisions that require human judgment. Batched questions, not asked one-by-one during scanning. Blocks execution of affected files until answered. | Coordination / Phase 2-3 |
| DOCS_ARCHIVE_LOG.md | Audit trail recording every file action (move/archive/delete/merge) with timestamp, source path, target path, reason, and agent/session reference | State / Phase 4 |
| `work-sessions/WS*.md` | Dedicated files for high-risk focused work (merge-into, rewrite, canonical restructuring, conflict resolution). One per topic/file pair. Contains goal, source files, assumptions, sections reviewed, conflicts found, user questions, proposed action, execution checklist, verification checklist. | State / Phase 4 (deferred) |
| DOCS_INDEX.md | Auto-generated folder-level map with file counts and status summaries. Derived from DOCS_INVENTORY.md. Agent-readable quick reference for current docs structure. | Output / Phase 5 |

### Pipeline Phases

1. **Phase 1 — Inventory:** Script scans all files, outputs metadata + heuristics to DOCS_INVENTORY.md. No agent involvement. Deterministic and fast.
2. **Phase 2 — Classify + Propose:** Agent reads inventory YAML blocks, classifies each file with confidence/reason, proposes action inline. Escalates ambiguities to DOCS_QUESTIONS.md. No files moved.
3. **Phase 3 — Review:** Human reviews questions and proposed actions. Approves/rejects/modifies in inventory. Updates approval field.
4. **Phase 4 — Execute:** Agent executes approved low-risk actions (keep/move/archive) in batch. Logs every action to DOCS_ARCHIVE_LOG.md. High-risk actions (merge/rewrite) deferred to work-sessions.
5. **Phase 5 — Verify:** Agent validates final structure against rules, checks for orphans/broken references/empty folders, regenerates DOCS_INDEX.md.

### Classification Categories

| Category | Meaning | Auto-classify triggers | Escalate when |
|----------|---------|----------------------|---------------|
| **canonical** | Current source of truth, actively maintained | Lives in numbered folder AND referenced by other docs | Conflicts with another file that also looks canonical |
| **stale** | Was relevant, now outdated or superseded | References implemented feature; TODO markers >3 months old | Mixed current and stale content in same file |
| **duplicate** | Same content exists elsewhere | Same basename in different folders; 90%+ content similarity | Two similar files both look important |
| **archive** | Keep for reference but not active | Filename contains temp/draft/scratch; >6 months old with no edits | Could be either archive or experiment |
| **experiment** | Research/exploration, may or may not ship | In react-guides/tutorials folders; framework-specific root files | Could be experiment OR reference material |
| **decision** | ADRs, architectural choices | Filename is NNNN-slug.md; lives in docs/40-decisions/ folder | ADR-like content but not in standard format |

### Action Types

| Action | Risk | Execution rule | Approval required |
|--------|------|----------------|-------------------|
| `keep` | None | Batched automatically | No (auto) |
| `move` | Low | Batched with other low-risk actions | Yes, if target is canonical folder |
| `archive` | Low | Batched automatically | No (auto), unless file contains domain rules |
| `delete` | High | Only for exact duplicates or empty files | Yes, explicit approval required |
| `merge-into` | High | One target file per session; deferred to work-session | Yes, always |
| `rewrite` | High | One file per session; deferred to work-session | Yes, always. Never in bulk operations. |

### Target Structure with Content Ownership

| Folder | Purpose | Constraints | Authority level |
|--------|---------|-------------|-----------------|
| `00-current/` | Living project state only | Max 3-5 files. No old plans or deep implementation notes. | Current truth |
| `10-domain/` | Business/domain language only | POS concepts, terminology. No technical details. | Current truth |
| `20-architecture/` | Technical system design | Backend, frontend, database, API contracts. Not temporary tasks. | Current truth |
| `30-flows/` | Vertical user flows | End-to-end behavior: direct sale, repair intake, etc. | Current truth |
| `40-decisions/` | ADRs and accepted decisions | One decision per file. Context, decision, consequences, date. | Current truth |
| `50-agent-workflows/` | AI/agent workflows | Prompts, loops, implementation process, review process. | Current truth |
| `90-archive/` | Historical reference only | Not canonical. Preserve original path where possible. | Background reference only |

**Core rule:** Content determines placement, but placement determines authority. Files in 00-current through 40-decisions are current truth. Files in 90-archive are background reference only. Mixed-ownership files get split/rewrite proposals, not forced placement.

### Core Principles

| Principle | Detail |
|-----------|--------|
| **Auto-classify freely** | Classification + action proposal happens in bulk during Phase 2 |
| **Auto-act cautiously** | No file moves/deletes without approval |
| **Ask before canonical changes** | Escalate to DOCS_QUESTIONS.md when project/domain truth is affected |
| **Archive > delete** | Preserve knowledge unless exact duplicate or empty |
| **One merge/rewrite per session** | High-risk work gets dedicated work-session files |
| **DOCS_RULES.md human-owned** | Agents read-only; propose changes via questions file |
| **Placement = authority** | Numbered folders are current truth; 90-archive is reference only |

## Testing Decisions

### What makes a good test for this system

- Test that the inventory script produces valid, parseable YAML blocks with all required fields
- Test that heuristic flags (large file, temp name, duplicate pattern) fire correctly on known inputs
- Test that classification confidence levels are assigned consistently (high for clear signals, low/medium for ambiguity)
- Test that escalation rules trigger DOCS_QUESTIONS.md entries when thresholds are met
- Test that the archive log captures every action with correct source/target paths and timestamps

### Modules to test

| Module | Test focus | Priority |
|--------|-----------|----------|
| `scan-inventory.ts` | Output format validity, heuristic accuracy, large file handling | High |
| `parse-doc-file.ts` | Section extraction accuracy, content summary quality | Medium (used on-demand) |
| Classification logic | Confidence assignment consistency, escalation threshold correctness | High |

### Prior art

The `session-parser` skill provides a reference pattern for script-based I/O with structured output consumed by agents. Its `list-sessions.ts` and `parse-session.ts` scripts demonstrate the same separation of concerns (script handles file system work, agent handles semantic interpretation).

## Out of Scope

- Shell-script automation (`run-docs-reorg.sh`) — this is a future goal after manual workflow is validated
- Automatic content merging or rewriting — always deferred to focused micro-sessions with human oversight
- DOCS_RULES.md modification by agents — rules are human-owned; agents can only propose changes
- Cross-project documentation synchronization — this system manages one project's docs folder
- Real-time monitoring of doc drift after reorganization — that would be a separate ongoing maintenance feature

## Further Notes

- The current `docs/` folder (91 files, 25 directories) serves as the test case for validating the entire pipeline before it's applied more broadly
- The `_system/` directory already exists with empty skeleton files; this PRD defines what goes into each one
- Future automation will follow the same pattern as `run-slices.sh`: shell orchestrator reads inventory → loops through phases → calls agent via RPC → tracks state in JSON/progress files → resumes on interrupt with `--resume`
- The system is designed to be re-runnable: running Phase 1 again after new docs are created will produce an updated inventory that can flow through the remaining phases
