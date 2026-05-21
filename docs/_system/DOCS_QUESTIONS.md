# DOCS_QUESTIONS.md — Pending User Decisions

**Purpose:** Escalation file where agents record decisions that require human judgment. Blocks execution of affected files until answered.  
**Updated By:** Agent during Phase 2 (classification), Human during Phase 3 (review)  

---

## Active Questions

### Q002 — Domain table summary placement in 10-domain/

**Related Files:** F0061  
**Context:** `docs/plans/domain-tables-summary.md` is a comprehensive domain document describing actual DB schemas (sales, backorders, repairs, quotes), business rules, and cross-cutting patterns. It contains genuine domain knowledge about the POS system but currently lives in non-canonical `docs/plans/`.
  
**Question:** Should this file be moved to `10-domain/domain-tables-summary.md` as canonical domain documentation?
- A) Yes — move to `10-domain/` as current truth
- B) No — keep in archive, it's too implementation-heavy for the domain folder
- C) Split — extract pure domain concepts to 10-domain/, move schema details to 20-architecture/

- [x] Answered
- **Answer:** A — Move to 10-domain/ as current truth

## Q003 — Review: Root docs/

**Related Files:** F0049, F0075, F0076, F0077, F0078  
**Context:** Classification reasoning: "Legacy documentation index referencing old folder structure (01-onboarding, 02-architecture, etc.) that does not match new target structure in DOCS_RULES.md. Superseded by actual docs in canonical folders."; "React Router v6/v7 tutorial and guide with fixes already applied to Pi Skeleton. Research/tutorial content, not active project documentation. Fixes marked as FIXED."  
**Question:** Should these 5 file(s) be archived? They are classified as "stale, experiment" with proposed action: archive.  

- [x] Answered  
- **Answer:** Yes — archive all 5 root doc files

## Q004 — Review: docs/04-operations/

**Related Files:** F0028  
**Context:** Classification reasoning: "Active folder-level index for operations documentation. Covers development workflow, branch naming, env vars, and quick reference commands. Folder '04-operations' not in target structure — content is workflow/ops docs best placed in 50-agent-workflows/."  
**Question:** Should these files be moved? Classified as "canonical". Proposed moves:
- docs/04-operations/README.md → 50-agent-workflows/ops-readme.md  

- [x] Answered  
- **Answer:** ok — move to 50-agent-workflows/ops-readme.md

## Q005 — Review: docs/plans/

**Related Files:** F0062  
**Context:** Classification reasoning: Filename matches plan pattern — likely old planning content per DOCS_RULES.md no-old-plans rule  
**Question:** Should these 1 file(s) be archived? They are classified as "stale" with proposed action: archive.  

- [x] Answered  
- **Answer:** ok — archive stale plan

## Q006 — Review: docs/prd/

**Related Files:** F0063  
**Context:** Classification reasoning: "Implementation plan for quotes & invoices feature with phased checkboxes (Phase 1-5). Superseded by PRD F0065 (docs/prd/quotes-and-invoices.md) which is already classified as canonical and moved to 35-prds/. Planning precursor document."  
**Question:** Should these 1 file(s) be archived? They are classified as "stale" with proposed action: archive.  

- [x] Answered  
- **Answer:** ok — archive superseded PRD plan

## Q007 — Review: docs/prds/

**Related Files:** F0059, F0060  
**Context:** Classification reasoning: "Vertical slice issue plan for repair calendar feature (Issue 2). Supporting artifact tied to PRD F0068, not current truth. Parent PRD already classified as canonical."; "Vertical slice issue plan for repair calendar feature (Issue 3). Supporting artifact tied to PRD F0068, not current truth. Parent PRD already classified as canonical."  
**Question:** Should these 2 file(s) be archived? They are classified as "archive" with proposed action: archive.  

- [x] Answered  
- **Answer:** ok — archive issue plans (supporting artifacts)

## Q008 — Review: docs/roadmaps/

**Related Files:** F0088  
**Context:** Classification reasoning: Nearly identical to F0013 (backend-improvement-plan.md) — same source (backend-review.md), similar phased slices. Dated May 8 vs May 10 for F0013. Superseded by canonical version in docs/02-architecture/.  
**Question:** Should these 1 file(s) be archived? They are classified as "duplicate" with proposed action: archive.  

- [x] Answered  
- **Answer:** ok — archive duplicate roadmap

## Q009 — Review: docs/02-architecture/

**Related Files:** F0013  
**Context:** Classification reasoning: Filename matches plan pattern — likely old planning content per DOCS_RULES.md no-old-plans rule  
**Question:** Should these 1 file(s) be archived? They are classified as "stale" with proposed action: archive.  

- [x] Answered  
- **Answer:** ok — archive stale plan

## Q010 — Review: docs/04-operations/

**Related Files:** F0022, F0023, F0027  
**Context:** Classification reasoning: "Agent workflow information flow analysis dated 2026-05-10, status 'Diagnostic (not yet redesigned)'. Maps data loss/degradation at each handoff stage and identifies critical gaps (no CONTEXT.md access for Builder/Reviewer, PRD not fetched at execution time). This is a diagnostic audit document — it documents problems found but does not prescribe implemented solutions. The workflow redesign referenced has not been completed. Preserve as background reference for understanding the evolution of the agent workflow system."; "Context loading audit of run-slices.sh dated 2026-05-10, scoped to 'Fix context delivery within existing slice execution loop only. No architectural redesign.' Maps findings from F0022 against actual code behavior with concrete fix plans (inject CONTEXT.md into prompts, fetch PRD parent content). This is a diagnostic audit document with proposed fixes — not an implemented solution or canonical reference. The audit itself is historical record of what was analyzed and what changes were planned. Preserve as background reference for understanding the context loading evolution."  
**Question:** Should these files be moved? Classified as "archive, experiment". Proposed moves:
- docs/04-operations/agent-workflow-analysis.md → docs/90-archive/docs/04-operations/agent-workflow-analysis.md
- docs/04-operations/context-loading-audit.md → docs/90-archive/docs/04-operations/context-loading-audit.md
- docs/04-operations/info-waterfall.md → 90-archive/04-operations/info-waterfall.md  

- [x] Answered  
- **Answer:** ok — move to 90-archive preserving structure

## Q011 — Review: Root docs/

**Related Files:** F0082  
**Context:** Classification reasoning: "Legacy documentation index referencing old folder structure (01-onboarding, 02-architecture, etc.) that does not match new target structure in DOCS_RULES.md. Superseded by docs/index.md (F0049) which serves the same role and is also classified as stale/archive."  
**Question:** Should these 1 file(s) be archived? They are classified as "stale" with proposed action: archive.  

- [x] Answered  
- **Answer:** ok — archive legacy index

## Q012 — Review: docs/react-guides/

**Related Files:** F0069  
**Context:** Classification reasoning: "Generic React tutorial covering advanced patterns (state management, Context API, performance optimization) with generic examples (todo apps, theme contexts). Not specific to this project's codebase or architecture. Educational/research content per DOCS_RULES.md experiment category."  
**Question:** Should these 1 file(s) be archived? They are classified as "experiment" with proposed action: archive.  

- [x] Answered  
- **Answer:** ok — archive generic React tutorial

## Q013 — Review: docs/35-prds/

**Related Files:** F0021  
**Context:** Classification reasoning: "PRD for backend improvement plan covering 3 phases (cleanup/standardize, critical gaps/API surface, transaction safety/stock audit). Phase 1 items (todos removal, validation standardization) appear partially implemented based on server-api.md breaking change notes. Phase 3 items (stock movements table, transaction safety) are NOT yet implemented — this PRD is still active work-in-progress. Per DOCS_RULES.md: PRDs stay in 35-prds/ until fully implemented and accepted, then move to 40-decisions/. Currently canonical as an active plan document. Cross-reference to archive copy (F0043) exists but does not make this file a duplicate — F0021 is the current working version while F0043 is the archived original."  
**Question:** How should these 1 file(s) be handled? Currently classified as "canonical" with actions: keep.  

- [ ] Answered  
- **Answer:** _(fill during Phase 3)_

## Q014 — Review: docs/35-prds/

**Related Files:** F0020  
**Context:** Classification reasoning: "\"\\"\\\"\\\\"PRD for backend improvement plan covering 3 phases (cleanup/standardize, critical gaps/API surface, transaction safety/stock audit). Phase 1 items (todos removal, validation standardization) appear partially implemented based on server-api.md breaking change notes. Phase 3 items (stock movements table, transaction safety) are NOT yet implemented — this PRD is still active work-in-progress. Per DOCS_RULES.md: PRDs stay in 35-prds/ until fully implemented and accepted, then move to 40-decisions/. Currently canonical as an active plan document. Cross-reference to archive copy (F0043) exists but does not make this file a duplicate — F0021 is the current working version while F0043 is the archived original.\\\\"\\\"\\"\""  
**Question:** How should these 1 file(s) be handled? Currently classified as "canonical" with actions: keep.  

- [ ] Answered  
- **Answer:** _(fill during Phase 3)_

---

## Answered Questions

### Q001 — Active PRD placement in target structure (ANSWERED)

**Related Files:** F0067, F0068  
**Context:** Target structure (DOCS_RULES.md) has no `prd/` folder. Two active PRDs exist: `docs/prd/repair-module-extraction.md` (backend service extraction) and `docs/prds/repair-calendar.md` (UI calendar feature). Both are still pending implementation.
  
**Question:** Where should active PRDs live?
- A) `20-architecture/` — treat as technical design docs
- B) New `35-prds/` folder between flows and decisions
- C) Split into relevant folders (backend → 20-arch, UI → 30-flows)

- [x] Answered  
- **Answer:** B — New `35-prds/` folder between flows and decisions. Added to DOCS_RULES.md target structure.
