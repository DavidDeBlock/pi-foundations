# Architecture Decision Records (ADRs)

**Status:** Foundation Phase - Active  
**Last Updated:** 2026-04-18  
**Maintained By:** Architect  

---

## How to Use This Document

This directory contains records of significant architectural decisions made for this project.

### Reading ADRs

- **Read first** before making architectural changes
- **Search by number** (ADR-001, ADR-002, etc.)
- **Check status**: [Accepted](#accepted), [Superseded](#superseded), [Rejected](#rejected)

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ Accepted | Active decision, follow this pattern |
| ⏭️ Superseded | Replaced by newer ADR (see reference) |
| ❌ Rejected | Considered but not chosen |
| 🚧 Proposed | Under discussion, not yet accepted |

---

## Decision Categories

| Category | Description | Example ADRs |
|----------|-------------|--------------|
| **Architecture** | System structure & boundaries | ADR-001, ADR-003, ADR-004 |
| **Technology** | Tool/framework selection | ADR-002, ADR-005 |
| **Data** | Database & data patterns | ADR-006 |
| **APIs** | Interface contracts | ADR-007 |
| **Security** | Security decisions | ADR-008 |

---

## Accepted Decisions

### ADR-001: Feature-based folder structure (SUPERSEDED)

**Status**: ❌ **Superseded by ADR-008**  
**Date**: 2026-04-18 → Superseded 2026-05-21  

**Summary**: ~~Use feature folders for all business logic instead of type-based organization.~~ Replaced by flow-first architecture.

**Why Superseded**: Feature-per-domain scatters transaction logic across 5+ directories (`sales`, `stock-validator`, `sequences`, etc.). The sale flow is a single atomic operation that should live in one place — not be coordinated through cross-imports between features. See ADR-008 for the replacement.

**References**:
- Superseded by [ADR-008: Flow-first architecture](./ADR-008-flow-first-architecture.md)

---

### ADR-002: React Router data API pattern

**Status**: ✅ Accepted  
**Date**: 2026-04-18  
**Authors**: Development Team  

**Summary**: Use React Router's loader/action pattern for all data operations instead of useEffect fetching.

**Key Points**:
- Loaders handle GET requests (data fetching)
- Actions handle mutations (POST, PUT, DELETE)
- Automatic loading/error states
- Optimistic updates built-in

**References**:
- See [Client API Guide](../../05-apis/client-api.md) for patterns
- React Router v7 documentation

---

### ADR-003: Zustand for state management

**Status**: ✅ Accepted  
**Date**: 2026-04-18  
**Authors**: Development Team  

**Summary**: Use Zustand with one store per feature, not a global monolith.

**Key Points**:
- Minimal boilerplate compared to Redux
- Per-feature isolation prevents coupling
- Great TypeScript inference
- Avoid Context API for data state (use only for theme)

**References**:
- See [State Management Patterns](../patterns/state-management.md) documentation
- See [Minimal Zustand Example](../../07-examples/minimal/zustand-store.ts)

---

### ADR-004: App-level event system and notification infrastructure

**Status**: ✅ Accepted  
**Date**: 2026-04-20  
**Authors**: Development Team  

**Summary**: Lightweight cross-cutting communication between app shell and features using a custom event emitter, flat global Zustand store, and notification service.

**Key Points**:
- Event emitter in `shared/lib/events.ts` — framework-agnostic pub/sub
- Flat global store for user, theme, gamification points (cross-cutting only)
- Notification service (`showNotification()`) hides toast UI from features
- Domain-level event names (e.g., `orderCompleted`, not `showSuccessToast`)
- No notification IDs in store — toast library manages its own lifecycle

**References**:
- See [ADR-004](./ADR-004-app-event-system.md) for full details
- Implementation: [`app/store.ts`](../../src/app/store.ts), [`shared/lib/events.ts`](../../src/shared/lib/events.ts), [`shared/lib/notifications.ts`](../../src/shared/lib/notifications.ts)

---

### ADR-008: Flow-first architecture — Consolidate transaction logic

**Status**: ✅ Accepted  
**Date**: 2026-05-21  
**Authors**: David De Block  

**Summary**: Move from feature-per-domain scattering to flow-first consolidation. Transaction orchestration lives in flat services (`sale.service.ts`); features own only UI, routes, and stores.

**Key Points**:
- `sale.service.ts` owns the complete sale flow (validate → number → create + stock deduction)
- Routes thin out — HTTP handling only, business logic in services
- Shared domain types in `shared/types/` decouple client from server implementation
- Feature folders preserved for UI boundaries but no longer own orchestration
- Event-driven side effects (notifications, gamification) preserved via `appEvents`

**Supersedes**: [ADR-001](./ADR-001-feature-folder-structure.md)

**References**:
- See [Clean Structure Decision](../31-planning-notes/clean-structure-decision.md) for migration plan

---

## Superseded Decisions

| Old ADR | Title | Superseded By | Reason |
|---------|-------|---------------|--------|
| **ADR-001** | Feature-based folder structure | [ADR-008](./ADR-008-flow-first-architecture.md) | Scattered transaction logic across 5+ directories; sale flow needs to live in one place |
| **ADR-006** | Golden Copy pattern | [ADR-008](./ADR-008-flow-first-architecture.md) | Golden copy was based on `features/todos/` which doesn't exist in this POS project. Pattern abandoned with flow-first refactor. |

---

## Rejected Decisions

No decisions rejected yet.

---

## Proposed Decisions

No proposals under discussion currently.

---

## Writing an ADR

### When to Write an ADR

Write an ADR when you're making a decision that:
- Has significant impact on the architecture
- Could be difficult to reverse later
- Involves choosing between multiple viable options
- Establishes a pattern others should follow

**Don't write an ADR for**:
- Minor implementation details
- Bug fixes
- Routine refactoring
- Decisions that are easily reversible

### How to Create an ADR

1. **Create the file**: `docs/40-decisions/[NNNN-slug].md`
   - Number sequentially with zero-padded 4-digit prefix (check existing files first!)
   - Use kebab-case for slug (e.g., `feature-folder-structure`)

2. **Fill out all sections** using the template:
   - Context (what problem)
   - Decision Drivers (constraints)
   - Options Considered (alternatives with pros/cons)
   - Decision Outcome (chosen option + justification)
   - References (links to related work)

3. **Update this index** with your decision in the "Accepted Decisions" table

4. **Link from relevant code/docs**: Add references where the decision is used

### ADR Numbering

- Start at ADR-001
- Check existing files before creating new one
- If you need to insert an ADR between existing numbers, use decimal (ADR-001a)
- Never renumber existing ADRs

---

## Template

See [`templates/adr-template.md`](templates/adr-template.md) for the standard format.

### Quick Reference: ADR Structure

```markdown
# ADR-NNN: [Short Title]

**Status**: [Proposed | Accepted | Superseded | Rejected]  
**Date**: YYYY-MM-DD  
**Authors**: [Your Name], [Other Contributors]  

## Context
*What problem are we solving?*

## Decision Drivers
*What constraints influenced this decision?*

## Options Considered
### Option A: [Title]
Pros/Cons...

### Option B: [Title]
Pros/Cons...

## Decision Outcome
*Chosen option and justification*

## References
- [Links to related docs, PRs, research]
```

---

## Review Process

| Step | Action | Who |
|------|--------|-----|
| 1. Draft | Create ADR with all sections | Decision Maker |
| 2. Review | Team reviews and provides feedback | All Developers |
| 3. Accept/Reject | Team consensus on decision | Project Lead + Team |
| 4. Implement | Code changes based on decision | Feature Developer |
| 5. Link | Reference ADR in code/docs | Implementation Owner |

---

## Maintenance Rules

### Updating ADRs

- **Never edit accepted ADRs** - If a decision changes, write a new ADR that supersedes it
- **Add superseded section** - Document when and why an old decision was replaced
- **Keep append-only** - ADRs are historical records, not living documents

### Review Cadence

| Frequency | Action | Who |
|-----------|--------|-----|
| Quarterly | Review all active ADRs for relevance | Architect/Lead |
| Per Release | Check if any decisions need documentation updates | Documentation Owner |
| As Needed | Update when related code changes significantly | Feature Developer |

---

## Current ADR List (Files)

```
docs/40-decisions/
├── index.md                          # This file - registry of all ADRs
├── _index.md                         # Folder index for navigation
├── adr-template.md                   # Template for new ADRs
└── [NNNN-slug].md                    # Individual decision records (e.g., 0001-invoices-and-quotes.md)
```

---

## Related Documentation

- [Architecture Overview](../overview.md) - System design document
- [Tech Stack](../../08-reference/tech-stack.md) - Technology choices and rationale
- [Patterns](../patterns/state-management.md) - Architectural patterns

---

**Last Updated:** 2026-04-18  
**Review Status:** Active  
**Next Review Date:** 2026-05-18
