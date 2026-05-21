# DOCS_RULES.md — Documentation Reorganization Rules

**Owner:** Human (read-only for agents)  
**Last Updated:** 2026-05-15  
**Version:** 1.0  

Agents may **read** this file and must **follow** its rules. To propose changes, add entries to `DOCS_QUESTIONS.md` or create `DOCS_RULES_PROPOSALS.md`. Only the human owner may approve and apply rule changes.

---

## Classification Categories

Every document in `docs/` is classified into exactly one category:

| Category | Meaning | Example |
|----------|---------|---------|
| **canonical** | Current source of truth, actively maintained | `01-onboarding/`, `02-architecture/overview.md` |
| **stale** | Was relevant, now outdated or superseded | `react-router-fix-plan.md` (if already implemented) |
| **duplicate** | Same content exists elsewhere | `docs/prds/repair-calendar.md` vs `docs/prd/...` |
| **archive** | Keep for reference but not active | Completed PRDs, old roadmaps |
| **experiment** | Research/exploration, may or may not ship | `react-guides/`, `temp.md` |
| **decision** | ADRs, architectural choices | `docs/40-decisions/0001-invoices-and-quotes.md` |

---

## Action Types

Each classified file receives a proposed action:

| Action | Risk Level | Execution Rule | Approval Required |
|--------|-----------|----------------|-------------------|
| **keep** | None | Batched automatically | No (auto) |
| **move** | Low | Batched with other low-risk actions | Yes, if target is canonical folder |
| **archive** | Low | Batched automatically | No (auto), unless file contains domain rules |
| **delete** | High | Only for exact duplicates or empty files | Yes, explicit approval required |
| **merge-into** | High | One target file per session; deferred to work-session | Yes, always |
| **rewrite** | High | One file per session; deferred to work-session | Yes, always. Never in bulk operations. |

---

## Escalation Thresholds

Agents auto-classify everything with clear signals but **must escalate to `DOCS_QUESTIONS.md`** when classification affects project truth:

### Escalate When
- A file could be canonical but conflicts with another file
- A file may replace or invalidate another document
- A file contains domain/business rules
- A file affects DB/API/frontend naming
- A file has mixed current and stale content
- Two similar files both look important
- Agent confidence is low or medium for a destructive/structural action

### Do NOT Escalate For (Obvious Bookkeeping)
- temp/scratch/draft files
- Exact duplicates
- Old agent outputs
- Clearly historical experiment notes
- Empty or near-empty files
- Files only being marked for later review

---

## Execution Rules

1. **Auto-classify freely** — Classification + action proposal happens in bulk during Phase 2
2. **Auto-act cautiously** — No file moves/deletes without approval
3. **Ask before canonical changes** — Escalate to `DOCS_QUESTIONS.md` when project/domain truth is affected
4. **Archive > delete** — Preserve knowledge unless exact duplicate or empty
5. **One merge/rewrite per session** — High-risk work gets dedicated work-session files in `_system/work-sessions/`
6. **Placement = authority** — Numbered folders (00–50) are current truth; `90-archive/` is background reference only
7. **Content determines placement, placement determines authority** — Mixed-ownership files get split/rewrite proposals, not forced placement

---

## Target Structure & Content Ownership

### Folder Map

| Folder | Purpose | Constraints | Authority Level |
|--------|---------|-------------|-----------------|
| `10-domain/` | Business/domain language only | POS concepts, repair flow terminology, customer/product/sale/repair meanings. No technical implementation details. | Current truth |
| `20-architecture/` | Technical system design | Backend, frontend, database, API contracts, document model, stock ledger. Describes how the system is designed, not temporary tasks. | Current truth |
| `25-system-specs/` | Meta-workflows & system rules | Operational specs, docs gate logic, agent loop definitions. | Current truth |
| `30-vertical-flows/` | End-to-end user flows | Direct sale, repair intake, stock correction, invoicing. Vertical behavior descriptions. | Current truth |
| `31-planning-notes/` | Fluid planning & brainstorming | Rough ideas, pre-issue drafts, knowledge system setup. Not final PRDs. | Current truth |
| `35-prds/` | Product requirements documents | Active PRDs for features in progress or planned. One file per feature effort. Moved to 40-decisions/ when implemented and accepted. | Current truth |
| `40-decisions/` | ADRs and accepted decisions | One decision per file. Explains context, decision, consequences, and date. | Current truth |
| `50-agent-workflows/` | AI/agent workflows | Prompts, loops, implementation process, review process, context update process. | Current truth |
| `90-archive/` | Historical reference only | Not canonical. Preserve original path where possible. | Background reference only |

### Content Ownership Rules

- A file in `00-current/` through `40-decisions/` may be treated as **current truth**
- A file in `90-archive/` may only be used as **background reference**
- If a file contains mixed ownership, propose split or rewrite instead of placing it as-is

---

## Naming Conventions

### File IDs (Inventory)
- Flat sequential: `F0001`, `F0002`, `F0003`...
- Assigned during Phase 1 inventory scan
- Stable across sessions — never reassigned

### Work Session Files
- Pattern: `WS####.md` where #### is zero-padded sequential number
- Example: `_system/work-sessions/WS0001.md`
- Title format: `# WS0001 — [Action] [Topic]`

### Questions (Escalation)
- Pattern: `Q###` references in inventory YAML blocks
- Full text lives in `DOCS_QUESTIONS.md` with matching heading anchors (`## Q001`)

### ADR Files
- Pattern: `NNNN-short-title.md` where NNNN is zero-padded sequential number
- Example: `40-decisions/0001-invoices-and-quotes.md`

---

## Pipeline Phases (Reference)

```
Phase 0: FOUNDATION   → Rules, target structure, state files in place (this file)
Phase 1: INVENTORY    → Script scans docs/, populates DOCS_INVENTORY.md
Phase 2: CLASSIFY+PROPOSE → Agent classifies each file, proposes actions inline
Phase 3: REVIEW       → Human answers questions from DOCS_QUESTIONS.md
Phase 4: MIGRATE      → Agent moves/renames files into target structure
Phase 5: VERIFY       → Agent validates final structure matches rules
```

---

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
