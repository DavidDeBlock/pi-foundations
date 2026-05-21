# Issue 1: Foundation — Rules, Target Structure & State Files

**Labels:** `needs-triage` `docs-reorganization` `vertical-slice-1`  
**Parent PRD:** [Docs Reorganization System](../prd/docs-reorganization-system.md)  

## User Story

As a developer using AI agents, I want the documentation reorganization system to have its rules defined upfront and target folder structure in place, so that agents know where each type of document belongs and don't place things arbitrarily.

## Acceptance Criteria

- [x] `docs/_system/DOCS_RULES.md` written with all classification categories, action types, escalation thresholds, execution rules, target structure, and naming conventions
- [x] Target folders created: `00-current/`, `10-domain/`, `20-architecture/`, `30-flows/`, `40-decisions/`, `50-agent-workflows/`, `90-archive/`
- [x] `docs/_system/work-sessions/` directory created for high-risk focused work
- [x] Empty state files initialized with proper headers: `DOCS_INVENTORY.md`, `DOCS_QUESTIONS.md`, `DOCS_ARCHIVE_LOG.md`
- [x] `DOCS_PROGRESS.md` updated to reflect Phase 0 (foundation) complete and pipeline ready
- [x] `DOCS_INDEX.md` contains initial folder-level map of target structure

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `docs/_system/DOCS_RULES.md` | Write | Human-owned rulebook: classification categories, action types, escalation thresholds, execution rules, content ownership per folder, naming conventions |
| `docs/00-current/` | Create dir | Living project state (max 3-5 files) |
| `docs/10-domain/` | Create dir | Business/domain language only |
| `docs/20-architecture/` | Create dir | Technical system design |
| `docs/30-flows/` | Create dir | Vertical user flows |
| `docs/40-decisions/` | Create dir | ADRs and accepted decisions |
| `docs/50-agent-workflows/` | Create dir | AI/agent workflows, prompts, loops |
| `docs/90-archive/` | Create dir | Historical reference only |
| `docs/_system/work-sessions/` | Create dir | High-risk focused work (created on-demand) |
| `docs/_system/DOCS_INVENTORY.md` | Write header | Empty inventory with YAML block schema example |
| `docs/_system/DOCS_QUESTIONS.md` | Write header | Empty questions file ready for Phase 2 escalation |
| `docs/_system/DOCS_ARCHIVE_LOG.md` | Write header | Empty audit log ready for Phase 4 actions |
| `docs/_system/DOCS_PROGRESS.md` | Update | Mark foundation complete, pipeline phases listed |

## Notes

- This is a **HITL** slice — DOCS_RULES.md content needs human approval before agents can use it
- Rules are derived from the design document (`docs/_system/DOCS_REORGANIZATION_DESIGN.md`) and PRD
- Target structure follows numbered folder convention with strict content ownership rules
