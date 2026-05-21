# Vertical Slice Patterns — Reference

Detailed slice templates for non-standard scenarios. Load when the default full-stack pattern doesn't fit.

---

## Pattern 1: Full-Stack Slice (Default)

End-to-end user story touching all layers. Use this as the baseline.

```markdown
## Slice N — [User Story]

> Customer-facing outcome from UI through DB.

- [ ] N.1 `shared/types/xxx.ts` — define types & DTOs
- [ ] N.2 `shared/validations/xxx.ts` — Zod schemas / validators
- [ ] N.3 `server/src/db/schema.ts` — tables, columns, relations
- [ ] N.4 `server/src/api/route.ts` — Hono endpoint(s)
- [ ] N.5 `client/src/features/xxx/services/xxx.service.ts` — API client
- [ ] N.6 `client/src/features/xxx/store.ts` — Zustand / state store
- [ ] N.7 `client/src/features/xxx/components/XxxComponent.tsx` — UI components
- [ ] N.8 `client/src/features/xxx/__tests__/xxx.test.ts` — tests (if applicable)
```

---

## Pattern 2: Server-Only Slice

Backend work with no immediate UI change. Examples: adding a background job, webhook handler, or internal API used by other slices.

```markdown
## Slice N — [Internal Capability]

> Backend-only; consumed later by Slice M.

- [ ] N.1 `shared/types/xxx.ts` — types shared with future client code
- [ ] N.2 `server/src/db/schema.ts` — schema changes
- [ ] N.3 `server/src/api/route.ts` — internal or public endpoint
- [ ] N.4 `server/__tests__/xxx.test.ts` — server tests
```

**When to use:**
- Preparing data for a future UI slice
- Adding webhooks, cron jobs, or background workers
- Internal APIs consumed by other backend services

---

## Pattern 3: Client-Only Slice

UI work that depends on already-existing API endpoints. Examples: redesigning an existing page, adding client-side filtering/sorting, or building a new view over existing data.

```markdown
## Slice N — [UI Enhancement]

> Frontend-only; API already exists from Slice M.

- [ ] N.1 `client/src/features/xxx/services/xxx.service.ts` — new or extended API calls
- [ ] N.2 `client/src/features/xxx/store.ts` — state management updates
- [ ] N.3 `client/src/features/xxx/components/XxxComponent.tsx` — UI components
- [ ] N.4 `client/src/features/xxx/__tests__/xxx.test.ts` — component tests (if applicable)
```

**When to use:**
- API is already built; only the view needs work
- Client-side logic (filters, sorting, caching) without server changes
- UI polish or accessibility improvements

---

## Pattern 4: Shared Contract Slice

Types and validations that multiple features depend on. Examples: shared enums, base DTOs, currency helpers, or validation schemas used across client and server.

```markdown
## Slice N — [Shared Foundation]

> Contracts consumed by Slices M, P, Q.

- [ ] N.1 `shared/types/xxx.ts` — shared type definitions
- [ ] N.2 `shared/validations/xxx.ts` — shared Zod schemas
- [ ] N.3 `shared/index.ts` — export barrel updates (if applicable)
```

**When to use:**
- Multiple upcoming slices need the same types first
- Extracting common patterns into shared code
- Setting up validation contracts before features

---

## Pattern 5: Database Migration Slice

Schema changes that are significant enough to be their own slice. Examples: adding indexes, splitting tables, or data migrations with seed scripts.

```markdown
## Slice N — [Data Layer Change]

> Schema migration; enables Slices M and P.

- [ ] N.1 `server/src/db/schema.ts` — schema definition updates
- [ ] N.2 Drizzle migration file — generate and apply migration
- [ ] N.3 `scripts/seed-xxx.ts` — seed data (if applicable)
- [ ] N.4 Verify migration — run up/down, check integrity
```

**When to use:**
- Migration is complex or risky enough to isolate
- Data seeding or backfilling required
- Multiple features depend on the schema change first

---

## Pattern 6: Multi-Feature Slice (Rare)

Two tightly coupled user stories that must ship together. Use sparingly — prefer splitting if possible.

```markdown
## Slice N — [Story A + Story B]

> Coupled outcomes; cannot be independently deployed.

### Story A tasks
- [ ] N.1 `shared/types/xxx.ts` — types for story A
- [ ] N.2 `server/src/db/schema.ts` — tables for story A
- [ ] N.3 ...

### Story B tasks (depends on N.1–N.X)
- [ ] N.M `shared/types/yyy.ts` — types for story B
- [ ] N.N ...
```

**When to use:**
- Stories share a single API call or DB transaction
- UI components are inseparable in the same view
- Splitting would create an incomplete user experience

---

## Decision Guide: Which Pattern?

| Question | Pattern |
|----------|---------|
| Does it touch client + server + DB? | **1 — Full-Stack** (default) |
| Is there no UI change yet? | **2 — Server-Only** |
| Is the API already built? | **3 — Client-Only** |
| Are multiple features waiting on types? | **4 — Shared Contract** |
| Is the migration complex or risky? | **5 — DB Migration** |
| Must two stories ship together? | **6 — Multi-Feature** (rare) |

---

## Anti-Patterns to Avoid

| ❌ Don't | ✅ Do Instead |
|----------|---------------|
| "All types for the whole feature" in one slice | Types per story, shipped with their slice |
| Slice that only adds DB columns with no consumer | Merge into the slice that uses them |
| 20+ tasks in a single slice | Split into smaller user stories |
| Slices ordered alphabetically | Order by dependency (foundations first) |
