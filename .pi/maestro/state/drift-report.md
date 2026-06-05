# Drift Report — Issue #67 (Event Listeners Deepening)
Audited: 2026-05-18 | Sections checked: 8

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 3 |
| 🟡 Medium | 4 |
| 🟢 Low | 2 |
| ✅ Verified | 9 |

**Total findings: 18** (across codebase, docs, and ADRs)

---

## Critical (🔴)

### 1. `removed-but-documented`: ADR-004 referenced but file missing on disk
- **Docs**: `docs/40-decisions/index.md` contains inline content for ADR-004 and references `./ADR-004-app-event-system.md` for full details.
- **Code evidence**: No file exists at `docs/40-decisions/ADR-004-app-event-system.md`. The archive log (`DOCS_ARCHIVE_LOG.md`) says it was moved there during Phase 4, but the migration appears incomplete — only ADR-006 exists as a physical file in that directory.
- **Impact**: Any agent or developer following the ADR index will hit a dead link when seeking full event system details.

### 2. `stale-description`: CONTEXT.md constraint "No `as` type assertions" violated by listener code
- **Docs**: `CONTEXT.md` states: *"No `as` type assertions in production code — use proper narrowing or shoehorn for partial data."*
- **Code evidence**: Every listener handler uses unsafe casts:
  - `client/src/features/todos/listeners/index.ts`: `payload as { title: string } | undefined` (line ~24), `payload as { id: string } | undefined` (lines ~31, ~38, ~45)
  - `client/src/app/crossCuttingListeners.ts`: `payload as { customerId: string; total: number } | undefined`, `payload as { message: string } | undefined`
- **Impact**: The event registry was supposed to "eliminate unsafe casts" (per PRD), but the implementation still uses them. Either the code needs fixing or the CONTEXT.md constraint needs updating/exception documented.

### 3. `stale-description`: CONTEXT.md app directory description is outdated
- **Docs**: `CONTEXT.md` describes `src/app/` as: *"App configuration: router, stores, event listeners, toast provider"*
- **Code evidence**: The actual contents are now: `App.tsx`, `registerAppListeners.ts`, `eventRegistry.ts`, `crossCuttingListeners.ts`, `store.ts`, `router.tsx`, `ToastProvider.tsx`. The generic "event listeners" description doesn't reflect the new feature-scoped registration pattern.
- **Impact**: New developers reading CONTEXT.md will expect a monolithic event listener file, not a registry + collector architecture.

---

## Medium (🟡)

### 4. `undocumented-feature`: Features README omits `listeners/` subdirectory from standard structure
- **Docs**: `client/src/features/README.md` lists feature subdirectories as: routes, components, store, services, hooks, tests. No mention of `listeners/`.
- **Code evidence**: `client/src/features/todos/listeners/index.ts` exists and is actively used by App.tsx. The PRD explicitly proposes this folder pattern.
- **Impact**: Onboarding developers following the features README won't know where to put event handler code for new features.

### 5. `stale-description`: Partial implementation of gamification point scoping decision
- **Docs**: `docs/31-planning-notes/event-listeners-deepening.md` states: *"Based on constraint #2, we'll move it to the feature scope."* (referring to gamification points)
- **Code evidence**: `crossCuttingListeners.ts` still contains the orderCompleted handler with gamification points (`addGamificationPoints(10)`). Only todo-created points moved to feature scope. The decision was partially implemented — some stayed cross-cutting, some moved to features.
- **Impact**: Inconsistent pattern makes it unclear whether gamification should be feature-scoped or cross-cutting going forward.

### 6. `undocumented-feature`: No ADR created for the listener deepening architectural change
- **Code evidence**: The shift from centralized `eventListeners.ts` to feature-scoped registration via `registerAppListeners()` + `eventRegistry/` is a significant architectural decision but no ADR exists in `docs/40-decisions/`.
- **Impact**: Future architects reviewing structural decisions won't find the rationale for this pattern.

### 7. `renamed-moved`: Old file `eventListeners.ts` removed — no migration note in docs
- **Docs**: No documentation references that `eventListeners.ts` was replaced by `registerAppListeners.ts`. The planning doc mentions the rename but it's a planning artifact, not formal documentation.
- **Code evidence**: `client/src/app/eventListeners.ts` does not exist on disk. `client/src/app/registerAppListeners.ts` is the replacement.
- **Impact**: Anyone searching for "eventListeners" in docs or code comments will find dead references.

---

## Low (🟢)

### 8. `undocumented-feature`: No standalone documentation for eventRegistry, registerAppListeners, crossCuttingListeners modules
- **Code evidence**: These three new files have inline JSDoc but no corresponding markdown documentation in the docs folder explaining their role, usage patterns, or design rationale.
- **Impact**: Agents and developers must read source code to understand these modules — no high-level docs exist.

### 9. `stale-description`: Planning doc redundancy with PRD
- **Docs**: `docs/31-planning-notes/event-listeners-deepening.md` is nearly identical in content to this PRD (issue #67). Both describe the same problem, solution, folder structure, and implementation steps.
- **Impact**: Redundant documentation creates confusion about which document is authoritative. The planning note should be archived or consolidated once the PRD is approved.

---

## Verified (✅) — Accurate Claims

1. ✅ `eventRegistry.ts` exists with `EventPayloadMap` interface + `validateEvents()` utility
2. ✅ `registerAppListeners.ts` exists as collector accepting `FeatureRegistrationFunction[]`, returns combined cleanup
3. ✅ `crossCuttingListeners.ts` exists with orderCompleted and apiError handlers, returns unsubscribe function
4. ✅ `features/todos/listeners/index.ts` exports `EVENTS` const array + `registerTodoListeners()` returning cleanup
5. ✅ `features/todos/__tests__/listeners.test.ts` exists with 10+ tests covering registration, side effects, cleanup, payload validation
6. ✅ Tests exist for new modules: `app/__tests__/eventRegistry.test.ts`, `app/__tests__/registerAppListeners.test.ts`, `app/__tests__/crossCuttingListeners.test.ts`
7. ✅ Old `client/src/app/eventListeners.ts` has been removed from disk (no longer exists)
8. ✅ `App.tsx` correctly uses the new pattern: imports `registerAppListeners`, passes `[registerTodoListeners, registerCrossCuttingListeners]`, returns cleanup in useEffect
9. ✅ `shared/lib/events.ts` (the emitter singleton) is unchanged — only handlers moved, not the emitter itself
