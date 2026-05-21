---
name: vertical-slice-planner
description: Plans work into executable, end-to-end vertical slices. Each slice delivers a complete user story touching all layers (types → DB → API → UI). Use when breaking down features into phases, reorganizing horizontal plans vertically, or planning multi-layer work that should ship incrementally.
---

# Vertical Slice Planner

## Quick Start

Given a feature request, produce numbered slices where each slice is independently shippable:

```
Slice 1 — [User Story]
  1.1 shared/types: define types
  1.2 server/src/db/schema.ts: add tables/columns
  1.3 server/src/api/: create route(s)
  1.4 client/src/features/<name>/services/: API service
  1.5 client/src/features/<name>/store.ts: state management
  1.6 client/src/features/<name>/components/: UI components
```

## Workflows

### Workflow A — From Broad Feature Request

1. **Clarify scope** — identify the user journey end-to-end (e.g., "customer visits shop → buys product from stock → pays with cash")
2. **Identify slices by story** — each slice = one complete user-facing outcome, ordered by dependency
3. **For each slice, list tasks top-down:**
   - `1.N shared/types` + `shared/validations` (contracts needed)
   - `1.N server/src/db/schema.ts` (schema changes)
   - `1.N server/src/api/` (route handlers)
   - `1.N client/src/features/<name>/services/` (API client)
   - `1.N client/src/features/<name>/store.ts` (state/store)
   - `1.N client/src/features/<name>/components/` (UI components)
4. **Validate slice boundaries** — each slice must be independently testable and deployable

### Workflow B — Reorganize Existing Plan into Vertical Slices

1. **Load the existing plan** — read tasks grouped by layer or category
2. **Group horizontally-scattered tasks** into vertical slices by feature/story
3. **Re-number** using `Slice N → Task N.M` format
4. **Verify completeness** — no task is orphaned; every original item appears in a slice

## Rules

- **One user story per slice** — if it spans multiple stories, split it
- **Numbering: Slice N, Task N.M** — e.g., `2.3` = Slice 2, Task 3
- **Each task names the file or path** — never vague ("add types" → "shared/types/product.ts")
- **Order slices by dependency** — slice N must not depend on uncompleted work in slice N+1
- **Include tests if relevant** — add `N.M __tests__/` tasks where appropriate

## Output Format

First, output the plan in this format:

```markdown
## Slice 1 — [User Story Title]

> One-line description of the end-to-end outcome.

- [ ] 1.1 `shared/types/xxx.ts` — define types
- [ ] 1.2 `server/src/db/schema.ts` — add table/columns
- [ ] 1.3 `server/src/api/route.ts` — create endpoint(s)
- [ ] 1.4 `client/src/features/xxx/services/xxx.service.ts` — API client
- [ ] 1.5 `client/src/features/xxx/store.ts` — state management
- [ ] 1.6 `client/src/features/xxx/components/XxxComponent.tsx` — UI

## Slice 2 — [User Story Title]

> Depends on: Slice 1 (specifically task 1.X)

- [ ] 2.1 ...
```

---

### 📝 Mandatory Save Step

**Immediately after generating the plan, you MUST save it to disk.**

1. Create a file at `.pi/plans/active/{feature-name}.md` (e.g., `pos-checkout.md`).
2. If the folder does not exist, create it.
3. Write the full markdown content of the plan into that file.
4. Confirm to the user: "Plan saved to `.pi/plans/active/{feature-name}.md`."
