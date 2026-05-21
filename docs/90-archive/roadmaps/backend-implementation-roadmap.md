# Backend Implementation Roadmap

**Source:** `docs/02-architecture/backend-review.md`  
**Generated:** 2026-05-08  
**Status:** Draft — for agent assignment  

---

## Overview

This roadmap translates the architecture review findings into phased, independently assignable slices. Each slice has a clear scope, acceptance criteria, and explicit dependencies. Slices within a phase can be executed in parallel unless noted otherwise.

### Phase Summary

| Phase | Theme | Risk | Effort | Dependencies |
|-------|-------|------|--------|-------------|
| 1 | Cleanup & Hygiene | Low | Small | None |
| 2 | Validation Standardization | Low | Medium | Phase 1 (optional) |
| 3 | Bicycle CRUD Completion | Medium | Medium | Phase 2 patterns established |
| 4 | Sales Detail & Response Format | Low | Medium | Independent of Phase 3 |
| 5 | Transaction Safety | Medium | Large | Phases 2-3 complete |
| 6 | Conventions & Polish | Low | Large | All prior phases |

---

## Phase 1: Cleanup & Hygiene

**Goal:** Remove dead code and reduce maintenance surface. Zero risk, immediate value.  
**Duration estimate:** 1 day total (parallelizable)

### Slice 1.1 — Remove Todos API

- **Scope:** Delete all todos-related files and references
- **Files to modify/remove:**
  - `server/src/api/todos.ts` → delete
  - `shared/types/todo.ts` → delete
  - `shared/validations/todo.ts`, `shared/validations/todo.test.ts` → delete
  - Remove todos route registration from `server/src/app.ts`
  - Consider dropping the `todos` table via migration (or leave as no-op for now)
- **Acceptance criteria:**
  - [ ] Server starts without errors after removal
  - [ ] No references to `todos` remain in source code (grep clean)
  - [ ] All existing API routes still function correctly

### Slice 1.2 — Add Zod Validation to Products PUT

- **Scope:** Apply `updateProductSchema` via `zValidator` middleware on `PUT /api/products/:id`
- **Files to modify:**
  - `server/src/api/products.ts` (PUT handler)
- **Acceptance criteria:**
  - [ ] PUT endpoint uses `zValidator('json', updateProductSchema)` middleware
  - [ ] Invalid request body returns structured 400 with Zod error details
  - [ ] Valid requests behave identically to current behavior
  - [ ] No raw `.safeParse()` or manual validation in the handler

### Slice 1.3 — Add Zod Validation to Bicycles POST

- **Scope:** Create a bicycle creation schema and apply it via `zValidator` middleware on `POST /api/bicycles`
- **Files to modify:**
  - `shared/validations/bicycle.ts` (create file with `createBicycleSchema`)
  - `server/src/api/bicycles.ts` (POST handler)
- **Acceptance criteria:**
  - [ ] Schema validates required bicycle fields (brand, model, color, frameNumber, etc.)
  - [ ] POST endpoint uses `zValidator('json', createBicycleSchema)` middleware
  - [ ] Invalid request body returns structured 400 with Zod error details
  - [ ] Valid requests behave identically to current behavior

---

## Phase 2: Validation Standardization

**Goal:** Replace all manual `.safeParse()` patterns with `zValidator` middleware for consistent error formatting and type inference.  
**Duration estimate:** 2-3 days total (parallelizable per domain)

### Slice 2.1 — Standardize Customers Validation

- **Scope:** Replace inline `.safeParse()` with `zValidator` on customers POST and PUT
- **Files to modify:**
  - `server/src/api/customers.ts` (POST and PUT handlers)
- **Acceptance criteria:**
  - [ ] Both endpoints use `zValidator('json', ...)` middleware
  - [ ] Phone uniqueness checks remain functional
  - [ ] Error responses match the standardized format from `lib/errors.ts`

### Slice 2.2 — Standardize Sales Validation

- **Scope:** Replace inline `.safeParse()` with `zValidator` on sales POST
- **Files to modify:**
  - `server/src/api/sales.ts` (POST handler)
- **Acceptance criteria:**
  - [ ] POST endpoint uses `zValidator('json', createSaleSchema)` middleware
  - [ ] Stock validation and transaction logic remain unchanged
  - [ ] Error responses match the standardized format

### Slice 2.3 — Standardize Workers Validation

- **Scope:** Replace inline `.safeParse()` with `zValidator` on workers POST and PUT
- **Files to modify:**
  - `server/src/api/workers.ts` (POST and PUT handlers)
- **Acceptance criteria:**
  - [ ] Both endpoints use `zValidator('json', ...)` middleware
  - [ ] Existing behavior preserved

### Slice 2.4 — Standardize Backorders Validation

- **Scope:** Replace inline `.safeParse()` with `zValidator` on backorders POST and complete endpoints
- **Files to modify:**
  - `server/src/api/backorders.ts` (POST handler, complete endpoint)
- **Acceptance criteria:**
  - [ ] POST uses `zValidator('json', createBackorderSchema)` middleware
  - [ ] Complete endpoint payment lines validated via `zValidator`
  - [ ] Atomic transaction behavior preserved

### Slice 2.5 — Remove Redundant Backorders Notes Endpoint

- **Scope:** Deprecate or remove `PATCH /api/backorders/:id/notes` since it duplicates `PATCH /api/backorders/:id`
- **Files to modify:**
  - `server/src/api/backorders.ts` (remove notes endpoint)
- **Acceptance criteria:**
  - [ ] Notes endpoint removed from route registration
  - [ ] `PATCH /:id` still handles note updates via the service layer
  - [ ] API surface is no longer confusing for frontend developers

---

## Phase 3: Bicycle CRUD Completion

**Goal:** Fill critical gaps in bicycle management needed by repair intake and customer detail flows.  
**Duration estimate:** 2-3 days total (sequential within phase)

### Slice 3.1 — Complete BicycleService

- **Scope:** Move all bicycle logic from route handlers into `BicycleService`. The service currently only has `createBicycleFromBackorder()`.
- **Files to modify:**
  - `server/src/services/bicycle-service.ts` (add: `getById`, `update`, `deleteWithGuards`)
  - `shared/types/bicycle.ts` (if needed — create file)
- **Acceptance criteria:**
  - [ ] Service provides `getById(id)`, `update(id, data)`, `deleteWithGuards(id)` methods
  - [ ] Route handlers delegate to service instead of querying DB directly
  - [ ] Existing POST endpoint refactored through the service

### Slice 3.2 — Add GET /api/bicycles/:id

- **Scope:** Single bicycle lookup endpoint using BicycleService
- **Files to modify:**
  - `server/src/api/bicycles.ts` (add GET/:id route)
- **Acceptance criteria:**
  - [ ] Returns full bicycle object including customer reference if applicable
  - [ ] Returns 404 for non-existent bicycles
  - [ ] Response format matches detail endpoint convention

### Slice 3.3 — Add PUT /api/bicycles/:id

- **Scope:** Update bicycle details with Zod validation and service delegation
- **Files to modify:**
  - `shared/validations/bicycle.ts` (add `updateBicycleSchema`)
  - `server/src/api/bicycles.ts` (add PUT/:id route)
- **Acceptance criteria:**
  - [ ] Uses `zValidator('json', updateBicycleSchema)` middleware
  - [ ] Delegates to `BicycleService.update()`
  - [ ] Returns updated bicycle object

### Slice 3.4 — Add DELETE /api/bicycles/:id with Guards

- **Scope:** Delete bicycle with guard against active repairs
- **Files to modify:**
  - `server/src/api/bicycles.ts` (add DELETE/:id route)
- **Acceptance criteria:**
  - [ ] Returns 409 Conflict if bicycle has active or in-progress repairs
  - [ ] Deletes bicycle and returns success response
  - [ ] Returns 404 for non-existent bicycles

---

## Phase 4: Sales Detail & Response Format Standardization

**Goal:** Add missing sale detail endpoint and standardize list response format across all endpoints.  
**Duration estimate:** 2-3 days total (parallelizable)

### Slice 4.1 — Add GET /api/sales/:id

- **Scope:** Full sale detail with items, payments, customer info
- **Files to modify:**
  - `server/src/api/sales.ts` (add GET/:id route)
  - `server/src/services/sales.ts` or `sale-record.ts` (add `getSaleDetail(id)` method)
- **Acceptance criteria:**
  - [ ] Returns sale record with joined items, payments, and customer info
  - [ ] Suitable for receipt/invoice generation
  - [ ] Returns 404 for non-existent sales

### Slice 4.2 — Standardize List Response Format (Products)

- **Scope:** Change products list from raw array to `{ data, pagination }` format
- **Files to modify:**
  - `server/src/api/products.ts` (GET handler)
- **Acceptance criteria:**
  - [ ] Returns `{ data: [...], pagination: { page, limit, totalCount, totalPages } }`
  - [ ] Pagination params (`page`, `limit`) work correctly
  - [ ] ⚠️ Breaking change — frontend must be updated to consume new format

### Slice 4.3 — Standardize List Response Format (Workers)

- **Scope:** Change workers list from raw array to `{ data, pagination }` format
- **Files to modify:**
  - `server/src/api/workers.ts` (GET handler)
- **Acceptance criteria:**
  - [ ] Returns `{ data: [...], pagination: { page, limit, totalCount, totalPages } }`
  - [ ] ⚠️ Breaking change — frontend must be updated

### Slice 4.4 — Standardize List Response Format (Bicycles)

- **Scope:** Change bicycles list from raw array to `{ data, pagination }` format
- **Files to modify:**
  - `server/src/api/bicycles.ts` (GET handler)
- **Acceptance criteria:**
  - [ ] Returns `{ data: [...], pagination: { page, limit, totalCount, totalPages } }`
  - [ ] ⚠️ Breaking change — frontend must be updated

---

## Phase 5: Transaction Safety & Stock Tracking

**Goal:** Close transaction consistency gaps and add explicit stock movement tracking.  
**Duration estimate:** 3-5 days total (sequential within phase)

### Slice 5.1 — Improve Repair Completion Transaction

- **Scope:** Move bicycle status update and repair status update into the shared transaction in `completePayment`
- **Files to modify:**
  - `server/src/services/repairs.ts` (`completePayment` function)
- **Acceptance criteria:**
  - [ ] Sale creation, bicycle status update, and repair status update all within single transaction
  - [ ] If any step fails, none are applied (full rollback)
  - [ ] Existing behavior preserved for successful completions

### Slice 5.2 — Wrap Backorder Transitions in Transactions

- **Scope:** Add transaction wrapping to `transitionStatus` and `updateBackorder` operations
- **Files to modify:**
  - `server/src/services/backorders.ts` (transition and update functions)
- **Acceptance criteria:**
  - [ ] Status transitions + notification creation within single transaction
  - [ ] Backorder updates wrapped in transactions for consistency
  - [ ] Existing behavior preserved

### Slice 5.3 — Add Stock Movements Table & API

- **Scope:** New table `stock_movements` with columns: id, productId, quantity (signed delta), reason (enum: SALE, VOID, REPAIR_PART, MANUAL_CORRECTION, DST_IMPORT, BACKORDER_RECEIVE), referenceId (nullable FK to related record), createdAt
- **Files to create/modify:**
  - Migration file for `stock_movements` table
  - `shared/types/stock-movement.ts` (type definitions)
  - `shared/validations/stock-movement.ts` (Zod schemas)
  - `server/src/services/stock-movement-service.ts` (service layer)
  - `server/src/api/stock-movements.ts` (API routes: GET list, POST create, PATCH /:id/adjust-stock on products)
- **Acceptance criteria:**
  - [ ] Table created with proper constraints and indexes
  - [ ] `POST /api/stock/movements` creates a movement record within a transaction that also adjusts product stock
  - [ ] `GET /api/stock/movements?productId=X&reason=Y` filters correctly
  - [ ] Existing sale/repair flows updated to write stock movements alongside their stock changes (or deferred as Phase 6)

---

## Phase 6: Conventions & Polish

**Goal:** Structural improvements for long-term maintainability. Lower urgency, higher effort.  
**Duration estimate:** 5-7 days total (can be split across sprints)

### Slice 6.1 — Add Repository Layer

- **Scope:** Create `server/src/repositories/` with repository classes per domain that encapsulate all database queries
- **Files to create:**
  - `server/src/repositories/product-repository.ts`
  - `server/src/repositories/customer-repository.ts`
  - `server/src/repositories/sale-repository.ts`
  - `server/src/repositories/repair-repository.ts`
  - `server/src/repositories/backorder-repository.ts`
  - `server/src/repositories/bicycle-repository.ts`
  - `server/src/repositories/worker-repository.ts`
- **Acceptance criteria:**
  - [ ] Services depend on repositories, not raw DB calls
  - [ ] Repositories accept a database instance (or transaction) as constructor param
  - [ ] Existing functionality preserved — this is a refactor

### Slice 6.2 — Centralize Currency Conversion

- **Scope:** Create `server/src/lib/currency.ts` with `centsToDollars()` and `dollarsToCents()` utilities
- **Files to create/modify:**
  - `server/src/lib/currency.ts` (new utility module)
  - All route handlers that currently do inline conversion → use the utility
- **Acceptance criteria:**
  - [ ] Single source of truth for cents↔dollars conversion
  - [ ] No inline `/ 100` or `* 100` in route handlers
  - [ ] Rounding behavior is explicit and consistent

### Slice 6.3 — DST Auth Dependency Injection

- **Scope:** Replace module-level `cachedToken` with injectable token storage
- **Files to modify:**
  - `server/src/services/dst-auth-service.ts` (refactor to accept TokenStorage interface)
- **Acceptance criteria:**
  - [ ] No module-level mutable state for auth tokens
  - [ ] Token storage is injectable (constructor or factory function)
  - [ ] Testability improved — can mock token storage without `resetTokenCache()`

### Slice 6.4 — Error Code Standardization

- **Scope:** Move error codes from route-level to shared types with consistent usage
- **Files to modify:**
  - `server/src/lib/errors.ts` (expand if needed)
  - Route handlers that parse error messages for status codes → use structured error objects instead
- **Acceptance criteria:**
  - [ ] No string-matching on error messages to determine HTTP status
  - [ ] Services throw typed errors with explicit status codes
  - [ ] Route handlers map error types to HTTP responses cleanly

---

## Dependency Graph

```
Phase 1 (Cleanup)
    │
    ├── Phase 2 (Validation Standardization) ───┐
    │                                            ├── Phase 3 (Bicycle CRUD)
    │                                            │       │
    └────────────────────────────────────────────┘       │
                                                         ├── Phase 5 (Transaction Safety)
Phase 4 (Sales Detail & Response Format)                  │       │
    (independent of Phases 2-3, but should ship           │       │
     after frontend is ready for breaking changes)        │       │
                                                          ▼       ▼
                                                       Phase 6 (Conventions & Polish)
```

### Parallel Execution Opportunities

| Can Run Together | Rationale |
|-----------------|-----------|
| Slices 1.1, 1.2, 1.3 | Independent cleanup tasks, no shared files |
| Slices 2.1, 2.2, 2.3, 2.4, 2.5 | Each touches a different domain's routes |
| Phase 3 + Phase 4 | Different domains (bicycles vs sales/responses) |
| Slices 6.2, 6.3, 6.4 | Independent convention improvements |

### Blocking Dependencies

| Blocked Slice | Requires Completion Of | Reason |
|--------------|----------------------|--------|
| Phase 3 slices | Slice 1.3 (bicycle schema) | Needs `createBicycleSchema` in shared validations |
| Slice 5.1 | Phase 2 complete | Transaction refactor is safer after validation is standardized |
| Slice 5.3 | Phase 2-3 complete | Stock movements integrate with existing sale/repair flows |
| Slice 6.1 (repositories) | All prior phases | Refactoring is safest when codebase is in stable state |

---

## Notes for Agent Assignment

### Slice Sizing Guidelines

- **Small slices** (1.1, 1.2, 1.3, 3.2, 3.3, 3.4): Single file changes, clear acceptance criteria. Assignable to one agent in a single session.
- **Medium slices** (2.x series, 4.1, 4.2-4.4, 5.1, 5.2): Touch multiple files or require understanding of existing patterns. May need 1-2 sessions.
- **Large slices** (3.1, 5.3, 6.1): Structural changes affecting multiple domains. Should be broken into sub-slices per domain before assignment.

### Large Slice Breakdowns

#### Slice 3.1 — BicycleService Completion (break down by method)
- Sub-slice A: `getById(id)` + route wiring
- Sub-slice B: `update(id, data)` + schema + route wiring  
- Sub-slice C: `deleteWithGuards(id)` + guard logic + route wiring

#### Slice 5.3 — Stock Movements (break down by layer)
- Sub-slice A: Database migration + shared types/validations
- Sub-slice B: Service layer (`StockMovementService`)
- Sub-slice C: API routes (GET list, POST create)
- Sub-slice D: Integrate into existing sale/repair flows (deferred or separate phase)

#### Slice 6.1 — Repository Layer (break down by domain)
- One sub-slice per repository (7 total), each independently assignable

### Risk Flags

| Risk | Mitigation |
|------|-----------|
| Phase 4 breaking changes affect frontend | Coordinate with frontend team; consider versioned endpoints or dual-response period |
| Slice 5.3 stock movement integration is large | Defer sub-slice D (retroactive tracking) to a follow-up phase; ship API first, integrate later |
| Repository layer refactor (6.1) touches all services | Do one domain at a time; verify tests pass after each before moving to next |

---

## Definition of Done (per slice)

A slice is complete when:
- [ ] Code changes are implemented and follow project conventions from the architecture review
- [ ] Acceptance criteria are met
- [ ] No new linting or type errors introduced
- [ ] Existing functionality preserved (no regressions)
- [ ] Changes reviewed against `docs/02-architecture/backend-review.md` recommendations
