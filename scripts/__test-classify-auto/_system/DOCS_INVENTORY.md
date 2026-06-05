# DOCS_INVENTORY.md — File Inventory

**Purpose:** Central state file containing YAML blocks per file with stable IDs. Source of truth for all reorganization state.
**Updated By:** Phase 1 scan script, then classify-inventory.ts during classification
**Last Scan:** 2026-06-01T06:00:18.996Z

---

## Folder Summary

| Folder | Total Files | Total Size (KB) |
|--------|-------------|-----------------|
| docs/00-current | 4 | 35.38 |
| docs/10-domain | 6 | 67.83 |
| docs/20-architecture | 1 | 0.14 |
| docs/25-system-specs | 3 | 6.61 |
| docs/30-vertical-flows | 1 | 0.22 |
| docs/31-planning-notes | 6 | 26.18 |
| docs/35-prds | 13 | 77.85 |
| docs/40-decisions | 7 | 40.86 |
| docs/50-agent-workflows | 1 | 0.16 |
| docs/90-archive | 1 | 0.15 |
| docs/90-archive/02-architecture | 1 | 16.04 |
| docs/90-archive/04-operations | 3 | 43.52 |
| docs/90-archive/07-examples/integration | 1 | 13.91 |
| docs/90-archive/docs | 7 | 63.77 |
| docs/90-archive/docs/02-architecture | 1 | 28.18 |
| docs/90-archive/docs/03-features | 1 | 3.49 |
| docs/90-archive/docs/04-operations | 2 | 15.21 |
| docs/90-archive/docs/05-apis/contracts | 1 | 4.68 |
| docs/90-archive/docs/06-templates | 3 | 15.21 |
| docs/90-archive/docs/07-examples | 1 | 2.64 |
| docs/90-archive/docs/08-reference | 3 | 10.86 |
| docs/90-archive/docs/issues | 4 | 7.45 |
| docs/90-archive/docs/plans | 1 | 3.45 |
| docs/90-archive/docs/react-guides | 5 | 45.38 |
| docs/90-archive/issues | 2 | 3.03 |
| docs/90-archive/plans | 1 | 15.18 |
| docs/90-archive/react-guides | 1 | 24.33 |
| docs/90-archive/react-router-tutorials | 3 | 32.51 |
| docs/90-archive/review | 1 | 5.02 |
| docs/90-archive/review/foundation | 4 | 18.3 |
| docs/90-archive/roadmaps | 1 | 17.55 |
| docs/90-archive/slices | 1 | 1.71 |
| docs/agents | 4 | 5.03 |

## File Entries

### docs/00-current

```yaml
id: F0001
path: docs/00-current/_index.md
folder: docs/00-current
size_kb: 0.15
lines: 10
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0002
path: docs/00-current/bugs.md
folder: docs/00-current
size_kb: 3.56
lines: 76
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0003
path: docs/00-current/temp.md
folder: docs/00-current
size_kb: 3.08
lines: 74
status: classified
class: experiment
confidence: high
proposed_action: archive
approval: null
risk: low
reason: Filename matches draft/temp/tmp/scratch/wip/todo pattern — experiment or scratch content per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0004
path: docs/00-current/todo.md
folder: docs/00-current
size_kb: 28.59
lines: 564
status: classified
class: experiment
confidence: high
proposed_action: archive
approval: null
risk: low
reason: Filename matches draft/temp/tmp/scratch/wip/todo pattern — experiment or scratch content per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

### docs/10-domain

```yaml
id: F0005
path: docs/10-domain/_index.md
folder: docs/10-domain
size_kb: 0.42
lines: 12
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0006
path: docs/10-domain/functionality-tracking-plan.md
folder: docs/10-domain
size_kb: 7.2
lines: 136
status: classified
class: stale
confidence: medium
proposed_action: archive
approval: null
risk: low
reason: Filename matches plan pattern — likely old planning content per DOCS_RULES.md no-old-plans rule
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0007
path: docs/10-domain/glossary.md
folder: docs/10-domain
size_kb: 5.93
lines: 149
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: null
risk: none
reason: "\"\\"\\\"\\\\"\\\\\"\\\\\\"\\\\\\\"\\\\\\\\"\\\\\\\\\"Comprehensive project glossary (1138 words) defining terminology, acronyms, and concepts — ADRs, APIs, domain map, Drizzle ORM, features, state management, testing strategy, tech stack. Actively maintained (Status: Current, last updated 2026-04-18). Domain language documentation that belongs in 10-domain/ per DOCS_RULES.md target structure.\\\\\\\\\"\\\\\\\\"\\\\\\\"\\\\\\"\\\\\"\\\\"\\\"\\"\""
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0008
path: docs/10-domain/product-finder-overview.md
folder: docs/10-domain
size_kb: 14.41
lines: 268
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0009
path: docs/10-domain/repairs-route-dependencies.md
folder: docs/10-domain
size_kb: 12.15
lines: 178
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0010
path: docs/10-domain/schema-analysis.md
folder: docs/10-domain
size_kb: 27.72
lines: 545
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

### docs/20-architecture

```yaml
id: F0011
path: docs/20-architecture/_index.md
folder: docs/20-architecture
size_kb: 0.14
lines: 9
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

### docs/25-system-specs

```yaml
id: F0012
path: docs/25-system-specs/_index.md
folder: docs/25-system-specs
size_kb: 0.27
lines: 11
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0013
path: docs/25-system-specs/01-meta-workflow.md
folder: docs/25-system-specs
size_kb: 2.29
lines: 55
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0014
path: docs/25-system-specs/maestro-orchestrator-plan.md
folder: docs/25-system-specs
size_kb: 4.05
lines: 79
status: classified
class: stale
confidence: medium
proposed_action: archive
approval: null
risk: low
reason: Filename matches plan pattern — likely old planning content per DOCS_RULES.md no-old-plans rule
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

### docs/30-vertical-flows

```yaml
id: F0015
path: docs/30-vertical-flows/_index.md
folder: docs/30-vertical-flows
size_kb: 0.22
lines: 9
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

### docs/31-planning-notes

```yaml
id: F0016
path: docs/31-planning-notes/_index.md
folder: docs/31-planning-notes
size_kb: 0.31
lines: 11
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0017
path: docs/31-planning-notes/clean-structure-decision.md
folder: docs/31-planning-notes
size_kb: 6.74
lines: 155
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0018
path: docs/31-planning-notes/event-listeners-deepening.md
folder: docs/31-planning-notes
size_kb: 4.55
lines: 72
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0019
path: docs/31-planning-notes/gransier-ftp-integration.md
folder: docs/31-planning-notes
size_kb: 2.11
lines: 44
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0020
path: docs/31-planning-notes/maestro-output-redesign.md
folder: docs/31-planning-notes
size_kb: 9.07
lines: 166
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0021
path: docs/31-planning-notes/refactor-agent-brief.md
folder: docs/31-planning-notes
size_kb: 3.4
lines: 46
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

### docs/35-prds

```yaml
id: F0022
path: docs/35-prds/_index.md
folder: docs/35-prds
size_kb: 1.07
lines: 20
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.992Z
```

```yaml
id: F0023
path: docs/35-prds/backend-improvement.md
folder: docs/35-prds
size_kb: 11.81
lines: 213
status: classified
class: canonical
confidence: medium
proposed_action: keep
approval: null
risk: none
reason: "\"\\"\\\"\\\\"\\\\\"\\\\\\"\\\\\\\"\\\\\\\\"\\\\\\\\\"PRD for backend improvement plan covering 3 phases (cleanup/standardize, critical gaps/API surface, transaction safety/stock audit). Phase 1 items (todos removal, validation standardization) appear partially implemented based on server-api.md breaking change notes. Phase 3 items (stock movements table, transaction safety) are NOT yet implemented — this PRD is still active work-in-progress. Per DOCS_RULES.md: PRDs stay in 35-prds/ until fully implemented and accepted, then move to 40-decisions/. Currently canonical as an active plan document. Cross-reference to archive copy (F0043) exists but does not make this file a duplicate — F0021 is the current working version while F0043 is the archived original.\\\\\\\\\"\\\\\\\\"\\\\\\\"\\\\\\"\\\\\"\\\\"\\\"\\"\""
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0024
path: docs/35-prds/client-server-divergence-fix.md
folder: docs/35-prds
size_kb: 4.8
lines: 44
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: auto
risk: none
reason: "Active PRD for unimplemented feature — standard PRD structure (Problem Statement, Solution, User Stories, Implementation Decisions). No evidence of implementation. Correctly placed in 35-prds/."
questions: []
related_files: []
target_path: null
current_step: classified
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0025
path: docs/35-prds/docs-reorganization-system.md
folder: docs/35-prds
size_kb: 13.64
lines: 148
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: auto
risk: none
reason: "Meta-PRD defining the active documentation reorganization system currently in use (scripts exist and are running). Standard PRD structure with full pipeline definition. Correctly placed in 35-prds/."
questions: []
related_files: []
target_path: null
current_step: classified
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0026
path: docs/35-prds/order-basket-1-add-from-dst-search.md
folder: docs/35-prds
size_kb: 2.81
lines: 44
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: auto
risk: none
reason: "Vertical slice 1/3 of active order basket feature — unimplemented (no code evidence). Standard PRD/slice structure with labels, parent PRD reference, acceptance criteria. Correctly placed in 35-prds/."
questions: []
related_files: []
target_path: null
current_step: classified
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0027
path: docs/35-prds/order-basket-2-basket-view-supplier-groups.md
folder: docs/35-prds
size_kb: 2.16
lines: 40
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: auto
risk: none
reason: "Vertical slice 2/3 of active order basket feature — unimplemented, blocked by slice 1. Standard PRD/slice structure with labels, parent PRD reference, acceptance criteria. Correctly placed in 35-prds/."
questions: []
related_files: []
target_path: null
current_step: classified
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0028
path: docs/35-prds/order-basket-3-mark-ordered-receive-flow.md
folder: docs/35-prds
size_kb: 2.79
lines: 43
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: auto
risk: none
reason: "Vertical slice 3/3 of active order basket feature — unimplemented, blocked by slice 2. Standard PRD/slice structure with labels, parent PRD reference, acceptance criteria. Correctly placed in 35-prds/."
questions: []
related_files: []
target_path: null
current_step: classified
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0029
path: docs/35-prds/quotes-and-invoices.md
folder: docs/35-prds
size_kb: 13.22
lines: 154
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: null
risk: none
reason: "Full PRD for quotes & invoices feature (Problem Statement, Solution, User Stories, DB schema migrations 0012-0014, API endpoints, UI components). No implementation evidence found in codebase — no quote tables, no quote service, no invoice columns. Active planned feature correctly placed in 35-prds/ per DOCS_RULES.md (PRDs stay until fully implemented and accepted, then move to 40-decisions/). Related archive copy exists as F0063 in 90-archive/docs/plans/."
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0030
path: docs/35-prds/repair-bugs-fixes.md
folder: docs/35-prds
size_kb: 4.93
lines: 47
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: null
risk: none
reason: "Full PRD for repair flow bug fixes (Problem Statement, Solution, User Stories, Implementation Decisions). Consolidates 4 related bugs into single session. No implementation evidence found — no RepairPaymentForm changes, no minutesWorked schema updates, no LaborConfirmDialog removal. Active planned feature correctly placed in 35-prds/ per DOCS_RULES.md. Related archive copy exists as F0087 (repair-bugs-slices.md) in 90-archive/slices/."
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0031
path: docs/35-prds/repair-calendar-1-week-view.md
folder: docs/35-prds
size_kb: 1.71
lines: 41
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: null
risk: none
reason: "\"\\"\\\"\\\\"\\\\\"\\\\\\"\\\\\\\"\\\\\\\\"\\\\\\\\\"Vertical slice 1/3 of repair calendar feature (labels: vertical-slice-1, parent PRD reference to repair-calendar.md). Defines CalendarView and CalendarCell components with acceptance criteria. No implementation evidence found — no CalendarView.tsx or CalendarCell.tsx in codebase. Active planned slice correctly placed in 35-prds/ per DOCS_RULES.md. Related files: F0030 (parent PRD), F0074/F0075 (related archive issues).\\\\\\\\\"\\\\\\\\"\\\\\\\"\\\\\\"\\\\\"\\\\"\\\"\\"\""
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0032
path: docs/35-prds/repair-calendar.md
folder: docs/35-prds
size_kb: 3.67
lines: 56
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: null
risk: none
reason: "\"\\"\\\"\\\\"\\\\\"\\\\\\"\\\\\\\"\\\\\\\\"\\\\\\\\\"Parent PRD for repair calendar view feature (Status: Draft, created 2026-05-05). Full PRD structure with Problem Statement, Solution, User Stories, Implementation Decisions, Modules to Build, Testing Decisions. No implementation evidence found — no CalendarView or CalendarToolbar in codebase. Active planned feature correctly placed in 35-prds/ per DOCS_RULES.md. Has vertical slices: F0029 (slice 1), and related archive issues F0074/F0075 for slices 2-3.\\\\\\\\\"\\\\\\\\"\\\\\\\"\\\\\\"\\\\\"\\\\"\\\"\\"\""
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0033
path: docs/35-prds/repair-flow-end-to-end.md
folder: docs/35-prds
size_kb: 9.44
lines: 119
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0034
path: docs/35-prds/repair-module-extraction.md
folder: docs/35-prds
size_kb: 5.8
lines: 96
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: null
risk: none
reason: "Full refactoring PRD for extracting repair business logic into a dedicated service layer (Problem Statement, Solution, Service Interface, Technical Decisions). No implementation evidence found — no server/src/services/repairs.ts exists. Active planned refactoring correctly placed in 35-prds/ per DOCS_RULES.md. Zero-downtime migration approach documented."
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

### docs/40-decisions

```yaml
id: F0035
path: docs/40-decisions/_index.md
folder: docs/40-decisions
size_kb: 0.61
lines: 15
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0036
path: docs/40-decisions/ADR-006-golden-copy-pattern.md
folder: docs/40-decisions
size_kb: 11.82
lines: 245
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0037
path: docs/40-decisions/ADR-007-sequence-table-for-document-numbering.md
folder: docs/40-decisions
size_kb: 1.97
lines: 53
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0038
path: docs/40-decisions/ADR-008-flow-first-architecture.md
folder: docs/40-decisions
size_kb: 5.73
lines: 106
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0039
path: docs/40-decisions/ADR-009-issue-interaction-contract.md
folder: docs/40-decisions
size_kb: 9.97
lines: 257
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0040
path: docs/40-decisions/adr-template.md
folder: docs/40-decisions
size_kb: 1.7
lines: 104
status: classified
class: decision
confidence: high
proposed_action: keep
approval: auto
risk: none
reason: "ADR template file — infrastructure for creating new ADRs, not a decision itself but supporting reference material. Contains all required sections (Context, Decision Drivers, Options Considered, Decision Outcome, Consequences, References, History) as placeholders. Belongs in 40-decisions/ alongside actual ADRs as a creation guide. Already in correct folder."
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

```yaml
id: F0041
path: docs/40-decisions/index.md
folder: docs/40-decisions
size_kb: 9.06
lines: 294
status: classified
class: decision
confidence: high
proposed_action: keep
approval: auto
risk: none
reason: "Directory index/landing page for ADRs — lists all accepted, superseded, rejected, and proposed decisions with summaries. Includes reading instructions, status legend, and decision categories. Useful navigational aid that belongs in 40-decisions/ alongside actual ADR files. Already in correct folder."
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T05:59:25.098Z
```

### docs/50-agent-workflows

```yaml
id: F0042
path: docs/50-agent-workflows/_index.md
folder: docs/50-agent-workflows
size_kb: 0.16
lines: 9
status: classified
class: canonical
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in correct canonical folder (50-agent-workflows/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive

```yaml
id: F0043
path: docs/90-archive/_index.md
folder: docs/90-archive
size_kb: 0.15
lines: 9
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/02-architecture

```yaml
id: F0044
path: docs/90-archive/02-architecture/backend-improvement-plan.md
folder: docs/90-archive/02-architecture
size_kb: 16.04
lines: 281
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/04-operations

```yaml
id: F0045
path: docs/90-archive/04-operations/agent-workflow-analysis.md
folder: docs/90-archive/04-operations
size_kb: 9.38
lines: 76
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0046
path: docs/90-archive/04-operations/context-loading-audit.md
folder: docs/90-archive/04-operations
size_kb: 13.42
lines: 373
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0047
path: docs/90-archive/04-operations/info-waterfall.md
folder: docs/90-archive/04-operations
size_kb: 20.72
lines: 343
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/07-examples/integration

```yaml
id: F0048
path: docs/90-archive/07-examples/integration/todo-feature-example.md
folder: docs/90-archive/07-examples/integration
size_kb: 13.91
lines: 572
status: classified
class: experiment
confidence: high
proposed_action: archive
approval: null
risk: low
reason: Filename matches draft/temp/tmp/scratch/wip/todo pattern — experiment or scratch content per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs

```yaml
id: F0061
path: docs/90-archive/docs/flows.md
folder: docs/90-archive/docs
size_kb: 7.33
lines: 103
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0062
path: docs/90-archive/docs/index.md
folder: docs/90-archive/docs
size_kb: 7.52
lines: 184
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0073
path: docs/90-archive/docs/react-router-crud-guide.md
folder: docs/90-archive/docs
size_kb: 19.16
lines: 733
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0074
path: docs/90-archive/docs/react-router-fix-plan.md
folder: docs/90-archive/docs
size_kb: 11.73
lines: 454
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0075
path: docs/90-archive/docs/react-router-fix-summary.md
folder: docs/90-archive/docs
size_kb: 6.26
lines: 196
status: classified
class: archive
confidence: high
proposed_action: keep
approval: approved
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0076
path: docs/90-archive/docs/react-router-todo-crud.md
folder: docs/90-archive/docs
size_kb: 5.95
lines: 211
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0077
path: docs/90-archive/docs/README.md
folder: docs/90-archive/docs
size_kb: 5.82
lines: 136
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/02-architecture

```yaml
id: F0049
path: docs/90-archive/docs/02-architecture/backend-review.md
folder: docs/90-archive/docs/02-architecture
size_kb: 28.18
lines: 533
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/03-features

```yaml
id: F0050
path: docs/90-archive/docs/03-features/README.md
folder: docs/90-archive/docs/03-features
size_kb: 3.49
lines: 138
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/04-operations

```yaml
id: F0051
path: docs/90-archive/docs/04-operations/agent-workflow-analysis.md
folder: docs/90-archive/docs/04-operations
size_kb: 8.41
lines: 417
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0052
path: docs/90-archive/docs/04-operations/context-loading-audit.md
folder: docs/90-archive/docs/04-operations
size_kb: 6.8
lines: 112
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/05-apis/contracts

```yaml
id: F0053
path: docs/90-archive/docs/05-apis/contracts/todo-api-contract.md
folder: docs/90-archive/docs/05-apis/contracts
size_kb: 4.68
lines: 253
status: classified
class: experiment
confidence: high
proposed_action: archive
approval: approved
risk: low
reason: Filename matches draft/temp/tmp/scratch/wip/todo pattern — experiment or scratch content per DOCS_RULES.md
questions: []
related_files: []
target_path: docs/90-archive/docs/05-apis/contracts/todo-api-contract.md
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/06-templates

```yaml
id: F0054
path: docs/90-archive/docs/06-templates/app-contract-template.md
folder: docs/90-archive/docs/06-templates
size_kb: 7.43
lines: 272
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0055
path: docs/90-archive/docs/06-templates/feature-contract-template.md
folder: docs/90-archive/docs/06-templates
size_kb: 4.16
lines: 167
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0056
path: docs/90-archive/docs/06-templates/handover-checklist.md
folder: docs/90-archive/docs/06-templates
size_kb: 3.62
lines: 141
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/07-examples

```yaml
id: F0057
path: docs/90-archive/docs/07-examples/README.md
folder: docs/90-archive/docs/07-examples
size_kb: 2.64
lines: 118
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/08-reference

```yaml
id: F0058
path: docs/90-archive/docs/08-reference/changelog.md
folder: docs/90-archive/docs/08-reference
size_kb: 2.58
lines: 140
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0059
path: docs/90-archive/docs/08-reference/migration-guide.md
folder: docs/90-archive/docs/08-reference
size_kb: 4.27
lines: 237
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0060
path: docs/90-archive/docs/08-reference/tmux-cheatsheet.md
folder: docs/90-archive/docs/08-reference
size_kb: 4.01
lines: 143
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/issues

```yaml
id: F0063
path: docs/90-archive/docs/issues/docs-reorg-01-foundation-rules-structure.md
folder: docs/90-archive/docs/issues
size_kb: 2.68
lines: 42
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0064
path: docs/90-archive/docs/issues/docs-reorg-02-inventory-script.md
folder: docs/90-archive/docs/issues
size_kb: 1.73
lines: 30
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0065
path: docs/90-archive/docs/issues/docs-reorg-03-deep-analysis-script.md
folder: docs/90-archive/docs/issues
size_kb: 1.56
lines: 29
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0066
path: docs/90-archive/docs/issues/docs-reorg-04-verification-index-script.md
folder: docs/90-archive/docs/issues
size_kb: 1.48
lines: 29
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/plans

```yaml
id: F0067
path: docs/90-archive/docs/plans/quotes-and-invoices.md
folder: docs/90-archive/docs/plans
size_kb: 3.45
lines: 67
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/docs/react-guides

```yaml
id: F0068
path: docs/90-archive/docs/react-guides/BEGINNER-GUIDE.md
folder: docs/90-archive/docs/react-guides
size_kb: 9.08
lines: 96
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0069
path: docs/90-archive/docs/react-guides/CREATION-SUMMARY.md
folder: docs/90-archive/docs/react-guides
size_kb: 6.07
lines: 220
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0070
path: docs/90-archive/docs/react-guides/INDEX.md
folder: docs/90-archive/docs/react-guides
size_kb: 9.25
lines: 371
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0071
path: docs/90-archive/docs/react-guides/QUICKSTART.md
folder: docs/90-archive/docs/react-guides
size_kb: 15.42
lines: 765
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0072
path: docs/90-archive/docs/react-guides/README.md
folder: docs/90-archive/docs/react-guides
size_kb: 5.56
lines: 200
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: docs/90-archive/docs/react-guides/README.md
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/issues

```yaml
id: F0078
path: docs/90-archive/issues/repair-calendar-2-worker-filter-pickupdates.md
folder: docs/90-archive/issues
size_kb: 1.46
lines: 34
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0079
path: docs/90-archive/issues/repair-calendar-3-detail-drawer-view-toggle.md
folder: docs/90-archive/issues
size_kb: 1.57
lines: 35
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/plans

```yaml
id: F0080
path: docs/90-archive/plans/line-items-standardization-plan.md
folder: docs/90-archive/plans
size_kb: 15.18
lines: 330
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/react-guides

```yaml
id: F0081
path: docs/90-archive/react-guides/ADVANCED-GUIDE.md
folder: docs/90-archive/react-guides
size_kb: 24.33
lines: 1137
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/react-router-tutorials

```yaml
id: F0082
path: docs/90-archive/react-router-tutorials/address-book.md
folder: docs/90-archive/react-router-tutorials
size_kb: 21.57
lines: 976
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0083
path: docs/90-archive/react-router-tutorials/quickstart.md
folder: docs/90-archive/react-router-tutorials
size_kb: 5.54
lines: 269
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0084
path: docs/90-archive/react-router-tutorials/README.md
folder: docs/90-archive/react-router-tutorials
size_kb: 5.4
lines: 176
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/review

```yaml
id: F0089
path: docs/90-archive/review/README.md
folder: docs/90-archive/review
size_kb: 5.02
lines: 177
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/review/foundation

```yaml
id: F0085
path: docs/90-archive/review/foundation/adr-template.md
folder: docs/90-archive/review/foundation
size_kb: 1.85
lines: 97
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0086
path: docs/90-archive/review/foundation/handover-checklist.md
folder: docs/90-archive/review/foundation
size_kb: 4.89
lines: 157
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0087
path: docs/90-archive/review/foundation/README.md
folder: docs/90-archive/review/foundation
size_kb: 5.63
lines: 164
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0088
path: docs/90-archive/review/foundation/SUMMARY.md
folder: docs/90-archive/review/foundation
size_kb: 5.93
lines: 194
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/roadmaps

```yaml
id: F0090
path: docs/90-archive/roadmaps/backend-implementation-roadmap.md
folder: docs/90-archive/roadmaps
size_kb: 17.55
lines: 397
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/90-archive/slices

```yaml
id: F0091
path: docs/90-archive/slices/repair-bugs-slices.md
folder: docs/90-archive/slices
size_kb: 1.71
lines: 43
status: classified
class: archive
confidence: high
proposed_action: keep
approval: null
risk: none
reason: Already in archive folder (90-archive/) per DOCS_RULES.md
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

### docs/agents

```yaml
id: F0092
path: docs/agents/_index.md
folder: docs/agents
size_kb: 0.27
lines: 12
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0093
path: docs/agents/domain.md
folder: docs/agents
size_kb: 0.89
lines: 17
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0094
path: docs/agents/issue-tracker.md
folder: docs/agents
size_kb: 1.04
lines: 23
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

```yaml
id: F0095
path: docs/agents/triage-labels.md
folder: docs/agents
size_kb: 2.83
lines: 58
status: classified
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: "Uncertain — needs agent review. Suggested classes: canonical, archive, experiment"
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-06-01T06:00:18.996Z
```

