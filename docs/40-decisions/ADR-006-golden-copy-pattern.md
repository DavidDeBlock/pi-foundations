# ADR-006: Golden Copy Pattern — Reference Implementation for New Features (SUPERSEDED)

> **Superseded by [ADR-008: Flow-first architecture](./ADR-008-flow-first-architecture.md)** — 2026-05-21

**Status**: ❌ Superseded  
**Date**: 2026-05-17 → Superseded 2026-05-21  
**Authors**: David De Block  

---

## Context

The **Golden Copy pattern** establishes `server/src/features/todos/` as a reference implementation that every new feature must mirror. The directory contains:

- A `GOLDEN_COPY.md` file documenting the exact structure, conventions, and patterns
- Complete layer implementations (schema → validations → repository → service → routes)
- Tests at every layer (integration for repo, unit for service, contract for routes)

This pattern was introduced in **PRD #1** ("Refactor Server Architecture — Establish Golden Copy Pattern") as the baseline operating procedure for all future feature development. The intent is that new features are created by copying this directory and adapting it, ensuring consistency across the codebase.

During implementation of PRD #1 (now tracked as parent issue [#11](https://github.com/DavidDeBlock/pi-pos-v1/issues/11)), several decisions emerged from hands-on experience that differ from the original PRD scope or require explicit documentation to prevent future architectural drift.

---

## Decision Drivers

- **AI-assisted feature generation**: The codebase is designed for AI agents to generate new features by reading `GOLDEN_COPY.md` as a single source of truth. Documentation must be accurate and complete.
- **Zero ambiguity onboarding**: New developers (human or agent) should not need to cross-reference implementation code to understand the pattern — everything they need is in the Golden Copy documentation.
- **Type safety across layers**: Error handling must use typed classes rather than string-matching, so changes to error messages cannot silently break service-layer behavior.
- **Shared schema consistency**: Zod validation schemas are used by both frontend and backend; defining them once prevents divergence between client and server validation logic.

---

## Options Considered

### Option A: Local Validation Schemas (Per-Feature)

**Description**: Each feature defines its own Zod schemas inside `features/<name>/validations.ts`, with no shared package dependency.

**Pros:**
- Maximum feature isolation — no cross-package dependencies
- Easier to understand a single feature in isolation
- No shared package versioning concerns

**Cons:**
- **Validation divergence**: Client and server could drift if schemas are maintained separately
- **Duplication**: Same validation logic must be duplicated for client-side form validation
- **Inconsistent UX**: Different features might validate differently (e.g., different max lengths)

### Option B: Shared Validation Schemas (Chosen)

**Description**: Zod schemas live in `shared/validations/` and are re-exported through each feature's local `validations.ts` barrel. Features import from the shared package, but the barrel provides a convenient local import path.

**Pros:**
- **Single source of truth**: Client and server always validate identically
- **Consistent UX**: Shared constants (`MAX_TITLE_LENGTH`, etc.) ensure uniform constraints across features
- **Golden Copy alignment**: The `validations.ts` barrel in each feature maintains the illusion of local ownership while actually delegating to shared definitions

**Cons:**
- Slightly more indirection (feature → shared → schema)
- Requires understanding that `shared/validations/` is the canonical location

### Option C: Hybrid — Core Local, Workflow Shared

**Description**: Keep validation schemas local but define "core" business rules in a separate shared module. Features would combine both.

**Pros:**
- Attempts to balance isolation with consistency
- Could allow per-feature customization of shared core rules

**Cons:**
- **Ambiguity**: Creates confusion about what is "core" vs "workflow" — developers waste time deciding on every feature
- **Complexity**: Adds another layer of indirection without clear benefit
- **Deferred decision**: This separation was considered but deferred because it introduced more questions than answers during PRD #1 implementation

---

## Decision Outcome

**Selected**: Option B — Shared Validation Schemas with Feature-Located Barrels

### Justification

The shared validation approach was chosen because:

1. **Validation consistency is non-negotiable** for a POS system where client and server must agree on input constraints
2. The barrel re-export pattern (`features/todos/validations.ts` → `shared/validations/todo.ts`) provides the best of both worlds — convenient local imports with centralized definitions
3. During PRD #1 implementation, attempts to keep schemas "local" (as GOLDEN_COPY.md originally claimed) created immediate confusion: developers couldn't tell if they should define new schemas locally or in shared

### Consequences

**Positive:**
- All features share identical validation rules and constants
- Client-side form components can import the same Zod schemas used by server routes
- New developers follow a single, unambiguous pattern documented in GOLDEN_COPY.md
- AI agents generating features from the Golden Copy template produce compilable code without manual fixes

**Negative:**
- Developers must understand that `shared/validations/` is the canonical location (not just any `validations.ts`)
- Adding a new schema requires updating two files: `shared/validations/<feature>.ts` and the barrel in `features/<name>/validations.ts`

---

## Client-Server Structural Divergence

### Observation

The **server** todo feature uses a flat, layer-based structure:

```
server/src/features/todos/
├── GOLDEN_COPY.md
├── index.ts                    # Barrel export
├── schema.ts                   # Drizzle table definition
├── validations.ts              # Validation barrel (re-exports from shared)
├── repositories/               # Data access layer
│   ├── repository.ts
│   └── __tests__/
├── services/                   # Business logic layer
│   ├── service.ts
│   └── __tests__/
└── routes/                     # HTTP handlers
    ├── index.ts
    └── __tests__/
```

The **client** todo feature uses a component-based structure:

```
client/src/features/todos/
├── index.ts                    # Barrel export (Zustand store + components + routes)
├── service.ts                  # API client wrapper (flat, not in subdirectory)
├── store.ts                    # Zustand store (flat, not in subdirectory)
├── components/                 # UI component layer
│   ├── TodoFeature.tsx
│   ├── TodoForm.tsx
│   ├── TodoItem.tsx
│   └── TodoList.tsx
├── routes/                     # React Router route definitions
│   └── index.tsx
└── __tests__/                  # Tests (service + store)
    ├── service.test.ts
    └── store.test.ts
```

### Explanation

This divergence is **intentional and documented** — not a defect. The reasons:

1. **Different concerns**: Server features manage data persistence, validation, and HTTP contracts. Client features manage UI state, component composition, and router integration. Their natural boundaries differ.

2. **Zustand stores are flat by design**: Global Zustand stores live at the feature root (not in a `stores/` subdirectory) because they are accessed via named imports from anywhere in the client app. A subdirectory would add unnecessary path depth for a pattern that requires broad accessibility.

3. **Server services need layering; client services don't**: The server separates repository (DB access) and service (business logic) to enable testing isolation. The client's `service.ts` is an API client wrapper — it doesn't have the same multi-layer complexity, so a flat file is appropriate.

4. **No GOLDEN_COPY.md on the client side**: The Golden Copy pattern is server-only because it documents the data layer architecture. Client features are expected to follow React conventions (components in `components/`, routes in `routes/`) which are well-established and don't need a reference template.

### Recommendation for New Features

- **Server features**: Always copy from `server/src/features/todos/GOLDEN_COPY.md` — this is the single source of truth
- **Client features**: Follow established React conventions; no Golden Copy template needed because the patterns are standard and well-documented in the client codebase itself

---

## Error Handling Evolution

### From String-Matching to Typed Classes (Completed)

During PRD #1 implementation, the original string-matching error handling was replaced with typed classes:

**Before** (fragile):
```typescript
// Service layer — breaks if repository message changes
if (error.message === 'Failed to update todo') {
  throw new TodoNotFoundError(id)
}
```

**After** (robust):
```typescript
// Repository throws a typed error
throw new RepoNotFoundError('todos', id)

// Service catches specific type — immune to message changes
try {
  const result = await repo.findTodoById(id)
  if (!result) throw new RepoNotFoundError('todos', id)
  return formatTodo(result)
} catch (error) {
  if (error instanceof RepoNotFoundError) {
    throw new TodoNotFoundError(id)
  }
  throw error // Unexpected errors propagate unchanged
}
```

### Pattern Details

| Layer | Error Type | Purpose |
|-------|-----------|---------|
| Repository | `RepoNotFoundError` | Indicates a database operation found no matching row |
| Service | `TodoNotFoundError` | Domain-level error for route handlers (404 response) |
| Routes | Uses `c.jsonNotFound()` | Converts domain errors to HTTP responses via Hono helpers |

The barrel exports (`features/todos/index.ts`) include both error types so consumers can import them from the single entry point:

```typescript
import { RepoNotFoundError, TodoNotFoundError } from '@/features/todos/index.js'
```

### Testing Implications

Tests validate **external behavior** (correct HTTP status codes, correct envelope format) rather than internal string-matching logic. This means error handling refactors are safe as long as the typed class hierarchy is preserved.

---

## Deviations from PRD #1 Original Scope

The following items from PRD #1 were modified or deferred based on implementation experience:

| PRD #1 Item | Status in Implementation | Reason for Change/Deferral |
|-------------|-------------------------|---------------------------|
| **Local validation schemas** (GOLDEN_COPY.md claimed) | Changed to shared | Shared schemas prevent client/server divergence; documented as intentional decision |
| **Core vs workflow separation** | Deferred | Introduced more ambiguity than clarity during PRD #1; no clear criteria for what constitutes "core" rules |
| **Client-side structural alignment** | Documented divergence instead of aligning | Client and server have fundamentally different concerns; forcing identical structure would add complexity without benefit |
| **Docs Gate in run-slices.sh** | Deferred — Planned for Phase 2 (meta-workflow) | Docs Gate automation is specified in the meta-workflow spec but not yet coded into `run-slices.sh` |

---

## References

- [Parent Issue #11](https://github.com/DavidDeBlock/pi-pos-v1/issues/11) — Fix Golden Copy Pattern (original PRD and audit findings)
- [Issue #13](https://github.com/DavidDeBlock/pi-pos-v1/issues/13) — Replace String-Matching Error Handling with Typed Classes (completed, blocked by this ADR's context)
- [`server/src/features/todos/GOLDEN_COPY.md`](../../server/src/features/todos/GOLDEN_COPY.md) — Living pattern documentation
- [ADR-001](./ADR-001-feature-folder-structure.md) — Feature-based folder structure (related structural decision)

---

## History

| Date | Change | Author |
|------|--------|--------|
| 2026-05-17 | Created | David De Block |
| 2026-05-17 | Status changed to Accepted | David De Block |
