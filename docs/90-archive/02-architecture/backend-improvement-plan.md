# Backend Improvement Plan — POS System

**Source:** `docs/02-architecture/backend-review.md`  
**Date:** 2026-05-10  
**Status:** Planning — ready for implementation sequencing  
**Execution model:** Sequential phases (no parallel workstreams)

---

## Scope Summary

### In Scope
All gaps and improvement opportunities identified in the backend architecture review, mapped to phased slices with explicit dependencies.

### Out of Scope
- Frontend changes
- Database schema migrations beyond what's required for stock movement tracking
- New business features not present in the review document (e.g., authentication, rate limiting)
- Code implementation — this plan defines scope only

---

## Phase 1 — Cleanup & Standardize (Foundations)

**Goal:** Remove dead code, standardize validation and error handling across all routes. Low-risk changes that improve consistency for everything downstream.

### Slice 1.1 — Remove Dead API Surface

| | |
|--|--|
| **Scope** | Delete `/api/todos` route file (`server/src/api/todos.ts`) and remove from `app.ts` router registration. Remove redundant `PATCH /api/backorders/:id/notes` endpoint (duplicate of `PATCH /:id`). |
| **Acceptance criteria** | - `todos.ts` removed from codebase, no references in `app.ts` or other files<br>- Backorder notes endpoint removed; all notes editing routes through `PATCH /:id`<br>- No runtime errors on startup<br>- Existing backorder edit flow still works via `PATCH /:id` |
| **Dependencies** | None |
| **Complexity** | Small |

### Slice 1.2a — Standardize Validation (Customers + Workers)

| | |
|--|--|
| **Scope** | Replace manual `.safeParse()` with `zValidator` middleware on: `POST /api/customers`, `PUT /api/customers/:id`, `POST /api/workers`, `PUT /api/workers/:id`. Uses existing schemas from `shared/validations/`. |
| **Acceptance criteria** | - All 4 endpoints use `zValidator('json', schema)` middleware<br>- Manual `.safeParse()` calls removed from route handlers<br>- Validation errors return consistent 400 responses with Zod error details<br>- Existing business logic (phone uniqueness, etc.) preserved in service layer |
| **Dependencies** | None |
| **Complexity** | Small–Medium |

### Slice 1.2b — Standardize Validation (Sales + Backorders + Products PUT + Bicycles POST)

| | |
|--|--|
| **Scope** | Replace manual `.safeParse()` with `zValidator` middleware on: `POST /api/sales`, `POST /api/backorders`. Add Zod schema to `PUT /api/products/:id` (currently has no validation — apply existing `updateProductSchema`). Create and apply Zod schema for `POST /api/bicycles` (currently accepts any JSON). |
| **Acceptance criteria** | - All endpoints use `zValidator('json', schema)` middleware<br>- Products PUT validates against `updateProductSchema`<br>- Bicycles POST has a new schema in `shared/validations/` covering required fields<br>- Manual `.safeParse()` calls removed from route handlers<br>- Existing business logic preserved |
| **Dependencies** | Slice 1.2a (same pattern, but not blocking — can be done independently) |
| **Complexity** | Medium |

### Slice 1.3 — Centralize Currency Conversion Utility

| | |
|--|--|
| **Scope** | Create a utility module in `server/src/lib/` for cents↔dollars conversion (e.g., `centsToDollars(n)`, `dollarsToCents(n)`). Replace scattered inline division/multiplication across route handlers. |
| **Acceptance criteria** | - Utility module exists with exported functions<br>- All route handlers use the utility instead of inline math<br>- No change in output values (rounding behavior preserved)<br>- Unit tests for edge cases (0, negative, odd cents) |
| **Dependencies** | None |
| **Complexity** | Small |

### Slice 1.4 — Shared Error Code Constants

| | |
|--|--|
| **Scope** | Move error code strings from route-level to `shared/types/` as a typed enum or const object. Update all routes and services to reference shared codes instead of inline strings. |
| **Acceptance criteria** | - Error codes defined in shared types with TypeScript type safety<br>- All routes/services use shared constants<br>- No new error codes introduced — only relocation |
| **Dependencies** | None |
| **Complexity** | Small |

---

## Phase 2 — Fill Critical Gaps & Standardize API Surface

**Goal:** Add missing bicycle CRUD endpoints, complete BicycleService, standardize response formats. These are required for existing business flows (repair intake, customer detail).

### Slice 2.1 — Complete BicycleService + Bicycle CRUD Endpoints

| | |
|--|--|
| **Scope** | Move all bicycle logic from route handlers into `BicycleService`. Add: `GET /api/bicycles/:id`, `PUT /api/bicycles/:id`, `DELETE /api/bicycles/:id` with guards (prevent deletion if bicycle has active repairs). Route handlers delegate to service. |
| **Acceptance criteria** | - `BicycleService` has methods: `getById`, `update`, `deleteWithGuards`<br>- GET returns single bicycle or 404<br>- PUT validates via `zValidator`, delegates to service<br>- DELETE checks for active repairs, returns 409 if blocked<br>- Route handlers contain only HTTP concerns (validation, response formatting) |
| **Dependencies** | Slice 1.2b (bicycles POST schema created in this slice) |
| **Complexity** | Medium |

### Slice 2.2 — Add Sale Detail Endpoint

| | |
|--|--|
| **Scope** | Create `GET /api/sales/:id` returning full sale detail: items, payments, customer info. Uses existing service layer or adds method to `SalesService`. |
| **Acceptance criteria** | - Returns single sale with enriched data (items + payments + customer)<br>- Returns 404 if not found<br>- Response format matches Phase 2.3 standardization (single object for detail) |
| **Dependencies** | None (can be done in parallel with 2.1, but sequenced after for ordering) |
| **Complexity** | Medium |

### Slice 2.3 — Standardize List Response Format

| | |
|--|--|
| **Scope** | Convert all list endpoints that return raw arrays to `{ data: [...], pagination: { page, limit, totalCount, totalPages } }`. Affected endpoints: products list, workers list, bicycles list (and any others returning raw arrays). Detail endpoints already use single-object format — no change needed. |
| **Acceptance criteria** | - All list endpoints return `{ data, pagination }` structure<br>- Pagination metadata is accurate (`totalCount`, `totalPages`)<br>- Existing paginated endpoints (sales, backorders) remain unchanged<br>- Breaking change documented for frontend consumers |
| **Dependencies** | Slice 2.1 (bicycles list format updated alongside new bicycle endpoints) |
| **Complexity** | Medium |

---

## Phase 3 — Transaction Safety & Stock Audit Trail

**Goal:** Ensure atomic state changes across related mutations and add explicit stock movement tracking for inventory auditability.

### Slice 3.1 — Repair Completion Transaction Safety

| | |
|--|--|
| **Scope** | Move bicycle status update and repair status update into the shared transaction in `completePayment`. Currently these happen post-transaction, creating a consistency gap if either fails. |
| **Acceptance criteria** | - All state changes (sale creation + bicycle status + repair status) occur within a single `db.transaction()`<br>- If any mutation fails, all are rolled back<br>- Existing behavior preserved — no change in success path output |
| **Dependencies** | Slice 2.1 (BicycleService completed; service methods used within transaction) |
| **Complexity** | Medium |

### Slice 3.2 — Backorder & Repair Status Transition Transactions

| | |
|--|--|
| **Scope** | Wrap `transitionStatus` and `updateBackorder` in transactions. Also wrap repair status transitions (repair table update + notification creation) in a single transaction for consistency. |
| **Acceptance criteria** | - Backorder status transitions are atomic with any side effects (notification creation)<br>- Repair status transitions are atomic with notification creation<br>- Consistent pattern with other transactional operations in the codebase |
| **Dependencies** | None |
| **Complexity** | Small |

### Slice 3.3 — Stock Movement Tracking Table + API

| | |
|--|--|
| **Scope** | Create `stock_movements` table (id, productId, quantityDelta, reason, referenceId, referenceType, createdAt). Add `POST /api/stock/movements` endpoint for manual corrections and `PATCH /api/products/:id/adjust-stock`. Wire existing stock mutations (sale creation, voiding, order receive) to emit movement records alongside their primary operations. |
| **Acceptance criteria** | - New table created with migration<br>- POST endpoint creates a movement record with validation<br>- PATCH adjust-stock updates `quantityOnHand` and emits a movement record<br>- Existing stock mutations (sales, voids, receives) emit movement records in the same transaction as their primary operation<br>- Movement records include reason enum: `sale`, `void`, `order_receive`, `manual_correction` |
| **Dependencies** | Slice 3.1 (understanding of existing transaction patterns needed) |
| **Complexity** | Large |

---

## Phase 4 — Repository Layer & Dependency Injection

**Goal:** Separate query logic from business logic for improved testability and future-proofing.

### Slice 4.1 — Repository Abstraction Layer

| | |
|--|--|
| **Scope** | Create `server/src/repositories/` directory with repository classes per domain (ProductRepository, CustomerRepository, SaleRepository, RepairRepository, BackorderRepository, BicycleRepository, WorkerRepository). Move all direct database queries from services and route handlers into repositories. Services depend on repositories via constructor injection. |
| **Acceptance criteria** | - Repository interface or base class defined<br>- All DB queries routed through repository layer<br>- Services accept repositories via constructor (not direct import of db instance)<br>- Existing functionality preserved — no behavioral changes<br>- Simple CRUD endpoints that previously called DB directly now go through service → repository |
| **Dependencies** | Phase 1–3 complete (all existing code stabilized before refactoring) |
| **Complexity** | Large |

### Slice 4.2 — DST Auth Dependency Injection

| | |
|--|--|
| **Scope** | Replace module-level `cachedToken` variable in DST auth service with injectable token storage. Create a `TokenStore` interface/implementation that can be mocked for testing and swapped for multi-worker environments later. |
| **Acceptance criteria** | - No module-level mutable state in DST auth service<br>- Token store injected via constructor or factory function<br>- Existing caching behavior preserved (auto-refresh, expiry check)<br>- `resetTokenCache()` replaced with test-friendly mechanism |
| **Dependencies** | Slice 4.1 (repository pattern established; same DI approach) |
| **Complexity** | Small–Medium |

---

## Phase 5 — Future Features (Not Yet Prioritized for Implementation)

**Goal:** Document identified gaps that are new features rather than improvements to existing flows. These are in scope per the review but deferred until Phases 1–4 stabilize the codebase.

### Slice 5.1 — Quote Workflow

| | |
|--|--|
| **Scope** | `POST /api/documents/quote` — Create temporary pricing documents without deposit or commitment. Distinct from backorders (no inventory reservation, no payment). |
| **Acceptance criteria** | TBD — requires product requirements before scoping |
| **Dependencies** | Phase 1–4 complete |
| **Complexity** | Medium–Large |

### Slice 5.2 — Reporting Endpoints

| | |
|--|--|
| **Scope** | `GET /api/reports/*` — Sales reports, inventory valuation, worker productivity metrics. |
| **Acceptance criteria** | TBD — requires product requirements before scoping |
| **Dependencies** | Phase 1–4 complete (stock movement tracking from Phase 3 needed for accurate reporting) |
| **Complexity** | Medium–Large |

### Slice 5.3 — Invoice & Delivery Note Generation

| | |
|--|--|
| **Scope** | `POST /api/documents/invoice` and `GET /api/documents/delivery-note` — Formal document generation with PDF output for completed sales, repairs, and backorder pickups. |
| **Acceptance criteria** | TBD — requires product requirements before scoping |
| **Dependencies** | Phase 1–4 complete |
| **Complexity** | Medium |

### Slice 5.4 — Repair Deposit Endpoint

| | |
|--|--|
| **Scope** | `PATCH /api/repairs/:id/deposit` — Dedicated endpoint for recording repair deposits, distinct from regular POS sales referencing a repair. |
| **Acceptance criteria** | TBD — requires product requirements before scoping |
| **Dependencies** | Phase 1–4 complete |
| **Complexity** | Small–Medium |

---

## Dependency Graph

```
Phase 1 (Cleanup & Standardize)
├── Slice 1.1 ────────────── No deps
├── Slice 1.2a ───────────── No deps
├── Slice 1.2b ───────────── Optional: after 1.2a (same pattern)
├── Slice 1.3 ────────────── No deps
└── Slice 1.4 ────────────── No deps

Phase 2 (Critical Gaps & API Surface)
├── Slice 2.1 ────────────── Depends on: 1.2b
├── Slice 2.2 ────────────── No hard deps
└── Slice 2.3 ────────────── Depends on: 2.1

Phase 3 (Transaction Safety & Stock Audit)
├── Slice 3.1 ────────────── Depends on: 2.1
├── Slice 3.2 ────────────── No hard deps
└── Slice 3.3 ────────────── Depends on: 3.1

Phase 4 (Repository Layer & DI)
├── Slice 4.1 ────────────── Depends on: Phase 1–3 complete
└── Slice 4.2 ────────────── Depends on: 4.1

Phase 5 (Future Features)
└── Slices 5.1–5.4 ───────── Depends on: Phase 1–4 complete
```

---

## Review Finding Coverage Matrix

| Review Finding | Mapped To | Status |
|---------------|-----------|--------|
| Remove todos API | Slice 1.1 | ✅ Assigned |
| Standardize validation (customers, workers) | Slice 1.2a | ✅ Assigned |
| Standardize validation (sales, backorders) | Slice 1.2b | ✅ Assigned |
| Add Zod to products PUT | Slice 1.2b | ✅ Assigned |
| Add Zod to bicycles POST | Slice 1.2b | ✅ Assigned |
| Remove redundant backorder notes endpoint | Slice 1.1 | ✅ Assigned |
| Centralize currency conversion | Slice 1.3 | ✅ Assigned |
| Shared error code constants | Slice 1.4 | ✅ Assigned |
| GET /api/bicycles/:id | Slice 2.1 | ✅ Assigned |
| PUT /api/bicycles/:id | Slice 2.1 | ✅ Assigned |
| DELETE /api/bicycles/:id with guards | Slice 2.1 | ✅ Assigned |
| Complete BicycleService | Slice 2.1 | ✅ Assigned |
| GET /api/sales/:id detail endpoint | Slice 2.2 | ✅ Assigned |
| Standardize list response format | Slice 2.3 | ✅ Assigned |
| Repair completion transaction safety | Slice 3.1 | ✅ Assigned |
| Backorder transition transactions | Slice 3.2 | ✅ Assigned |
| Repair status transition transactions | Slice 3.2 | ✅ Assigned |
| Stock movement tracking table + API | Slice 3.3 | ✅ Assigned |
| Repository abstraction layer | Slice 4.1 | ✅ Assigned |
| DST auth dependency injection | Slice 4.2 | ✅ Assigned |
| Quote workflow (nice-to-have) | Slice 5.1 | ✅ Assigned |
| Reporting endpoints (important gap) | Slice 5.2 | ✅ Assigned |
| Invoice generation (nice-to-have) | Slice 5.3 | ✅ Assigned |
| Delivery note generation (nice-to-have) | Slice 5.3 | ✅ Assigned |
| Repair deposit endpoint (nice-to-have) | Slice 5.4 | ✅ Assigned |

**All review findings mapped — no gaps unassigned.** ✅

---

## Effort Summary by Phase

| Phase | Slices | Total Complexity | Estimated Relative Size |
|-------|--------|-----------------|----------------------|
| 1 — Cleanup & Standardize | 5 slices | 2 Small, 2 Medium, 1 Small | ~3 days |
| 2 — Critical Gaps & API Surface | 3 slices | 3 Medium | ~4 days |
| 3 — Transaction Safety & Stock Audit | 3 slices | 1 Small, 2 Medium, 1 Large | ~5 days |
| 4 — Repository Layer & DI | 2 slices | 1 Large, 1 Small–Medium | ~5 days |
| 5 — Future Features | 4 slices | TBD (require PRD) | TBD |

*Estimates are relative and based on review effort labels. Actual duration depends on developer familiarity with the codebase.*
