# Issue 4: Verification Script — `verify-structure.ts` + Index Generator

**Labels:** `needs-triage` `docs-reorganization` `vertical-slice-4`  
**Parent PRD:** [Docs Reorganization System](../prd/docs-reorganization-system.md)  

## User Story

As a developer, I want an audit log of every file move/merge/delete with timestamps and reasons, so that I can trace what changed and why. I also want the system to validate the final structure against rules after migration completes.

## Acceptance Criteria

- [ ] Script validates `docs/` structure against content ownership rules from DOCS_RULES.md
- [ ] Script detects orphaned files (files not in inventory or outside numbered folders)
- [ ] Script checks for empty folders and reports them
- [ ] Script verifies folder constraints: `00-current/` has max 3-5 files, no old plans in living state folders
- [ ] Script generates `DOCS_INDEX.md` from current structure with file counts and status summaries per folder
- [ ] Script is runnable via `npx tsx scripts/verify-structure.ts docs/`
- [ ] Output includes: validation pass/fail status, list of violations, orphaned files, empty folders, generated index

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `scripts/verify-structure.ts` | Create | Structure validator: rule checking, orphan detection, empty folder check, DOCS_INDEX.md generation |

## Blocked by

None — can start immediately. Independent validation tool that reads the current docs/ structure and DOCS_RULES.md.
