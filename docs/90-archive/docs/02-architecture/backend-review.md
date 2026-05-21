# Backend Architecture Review — POS System

**Date:** 2026-05-10  
**Scope:** Server layer only (`server/src/`)  
**Status:** Analysis complete, no changes made

---

## Executive Summary

The backend is **functionally mature** for the core POS flows (sales, repairs, backorders) but has several structural inconsistencies that will compound as features grow. The service layer exists and handles business logic well, but route handlers vary in their use of validation middleware, error formatting, and response shapes. Several important endpoints are missing (stock movements, bicycle CRUD), and the todos API is leftover scaffolding from the skeleton project.

**Key findings:**
- ✅ Core flows (sales, repairs, backorders) have proper service-layer logic with transactions where needed
- ⚠️ Validation strategy is inconsistent — some routes use `zValidator`, others call `.safeParse()` inline
- ❌ Missing endpoints: stock movements/corrections, bicycle detail/update/delete, quote/invoice generation
- ⚠️ Layer violations: `customer-detail.ts` queries multiple tables directly instead of delegating through services
- ✅ Good: shared types and Zod schemas in `shared/` are well-maintained and consistent

---

## 1. Current API Inventory

### Products (`/api/products`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/products` | GET | ✅ Complete | Pagination, search by name/barcode, active-only default |
| `/api/products/:id` | PUT | ⚠️ Partial | No `zValidator` — builds update object manually from raw body; schema not applied |
| `/api/products` | POST | ✅ Complete | Zod validation, barcode uniqueness check, price conversion |
| `/api/products/import-from-dst` | POST | ✅ Complete | DST import with create/update logic |

**Issues:** PUT endpoint bypasses `updateProductSchema` — no validation on the request body. The schema exists in shared but is never used here.

---

### Customers (`/api/customers`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/customers` | GET | ✅ Complete | Pagination, search by name/phone |
| `/api/customers` | POST | ⚠️ Partial | Manual `.safeParse()` — no `zValidator`; phone uniqueness check present |
| `/api/customers/:id` | PUT | ⚠️ Partial | Manual `.safeParse()`; phone uniqueness excludes current customer ✅ |
| `/api/customers/:id` | DELETE | ✅ Complete | Guards against deletion if sales exist |
| `/api/customers/:id/detail` | GET | ✅ Complete | Enriched detail with sales, bicycles, backorders, repairs |

**Issues:** Inconsistent validation approach — manual `.safeParse()` instead of `zValidator` middleware. The schema is defined in shared but route handlers don't use the middleware pattern.

---

### Sales (`/api/sales`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/sales` | GET | ✅ Complete | Pagination, date filtering, enriched with items + payments |
| `/api/sales` | POST | ⚠️ Partial | Manual `.safeParse()` — no `zValidator`; good stock validation and atomic transaction via `createSaleRecord` |
| `/api/sales/:id` | PATCH (void) | ✅ Complete | Atomic: restores stock + updates status in single transaction |

**Issues:** No GET by ID endpoint. No search/filter beyond date range. Manual `.safeParse()` instead of middleware.

---

### Workers (`/api/workers`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/workers` | GET | ✅ Complete | Active-only filter, pagination |
| `/api/workers` | POST | ⚠️ Partial | Manual `.safeParse()` — no `zValidator` |
| `/api/workers/:id` | PUT | ⚠️ Partial | Manual `.safeParse()` — no `zValidator` |
| `/api/workers/:id` | DELETE | ✅ Complete | No guards (worker can be deleted even if assigned to repairs) |

**Issues:** Manual validation. No guard preventing deletion of workers with active assignments.

---

### Bicycles (`/api/bicycles`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/bicycles` | GET | ✅ Complete | Search by brand/model/color, status filter, pagination |
| `/api/bicycles` | POST | ⚠️ Partial | No validation schema — accepts any JSON with loose typing; no `zValidator` |

**Missing:**
- ❌ `GET /api/bicycles/:id` — single bicycle lookup (needed for repair intake flow)
- ❌ `PUT /api/bicycles/:id` — update bicycle details
- ❌ `DELETE /api/bicycles/:id` — delete bicycle with guards

**Issues:** POST endpoint has no Zod validation. Accepts raw `{}` typed as an inline interface. The `BicycleService` exists but only has `createBicycleFromBackorder()` — it's not a full service.

---

### Repairs (`/api/repairs`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/repairs/intake` | POST | ✅ Complete | Atomic: customer lookup/create + bicycle + repair in single transaction |
| `/api/repairs` | GET | ⚠️ Partial | Manual query param parsing; no search across customer/bike fields |
| `/api/repairs/:id` | GET | ✅ Complete | Returns repair + items + total (in cents) |
| `/api/repairs/:id/status` | PATCH | ✅ Complete | Status transitions with validation, hold reason enforcement, notification creation |
| `/api/repairs/:id` | PATCH | ⚠️ Partial | No Zod schema — accepts any JSON and lets service handle validation; no field-level validation at route level |
| `/api/repairs/:id/timer/start` | POST | ✅ Complete | Handles running timer accumulation |
| `/api/repairs/:id/timer/stop` | POST | ✅ Complete | Calculates session elapsed, updates cumulative total |
| `/api/repairs/:id/complete-payment` | POST | ✅ Complete | Atomic: sale creation + repair completion + bicycle status update (note: post-transaction bicycle update is outside the shared transaction) |

**Issues:** PATCH endpoint has no route-level validation. The `updateRepairSchema` exists in shared but isn't used at the route level — service handles it, which means 400 errors come from error message parsing rather than structured validation responses.

---

### Repair Items (`/api/repairs/:repairId/items`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/repairs/:repairId/items` | POST | ✅ Complete | Zod validation, product lookup for parts, hourly rate calculation |
| `/api/repairs/:repairId/items/:itemId` | DELETE | ⚠️ Partial | No Zod schema needed (path params), but no guard against removing items from completed repairs at route level — service handles it |

---

### DST Integration (`/api/dst/*`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/dst/auth/login` | POST | ✅ Complete | OAuth2 password grant, token caching with auto-refresh |
| `/api/dst/auth/status` | GET | ✅ Complete | Returns auth status and expiry |
| `/api/dst/products/search` | GET | ✅ Complete | EAN or keyword search with deduplication (NL preference) |

**Issues:** DST auth state is module-level (`cachedToken` variable). Not injectable, not testable without `resetTokenCache()`. No token refresh endpoint.

---

### Order Lines / Basket (`/api/order-lines`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/order-lines/add` | POST | ✅ Complete | Merges duplicates, ensures product exists locally |
| `/api/order-lines` | GET | ✅ Complete | Filter by status, pagination |
| `/api/order-lines/mark-ordered` | PATCH | ✅ Complete | Per-supplier batch transition |
| `/api/order-lines/:id/status` | PATCH | ✅ Complete | Status transition with validation |
| `/api/order-lines/:id` | PATCH | ✅ Complete | Quantity adjustment by delta |
| `/api/order-lines/receive/:id` | PATCH | ✅ Complete | Transaction: update line + stock + reactive backorder matching |

**Issues:** `receiveOrderLine` calls `matchArrivedStock()` outside the transaction. If matching fails, the order line is already received but backorders aren't updated (silently ignored). This is intentional per comments but worth noting as a consistency gap.

---

### Backorders (`/api/backorders`)

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/backorders` | GET | ✅ Complete | List with status filter, customer name enrichment |
| `/api/backorders/:id` | GET | ✅ Complete | Detail with part lines + bicycle lines |
| `/api/backorders` | POST | ⚠️ Partial | Manual `.safeParse()` — no `zValidator`; atomic: backorder + lines + deposit sale in single transaction |
| `/api/backorders/:id/transition` | PATCH | ✅ Complete | Status transitions with validation, notification creation on arrived |
| `/api/backorders/:id` | PATCH | ⚠️ Partial | No Zod schema at route level; service handles editability guards |
| `/api/backorders/:id/history` | GET | ✅ Complete | Status transition timeline |
| `/api/backorders/:id/complete` | POST | ⚠️ Partial | Manual validation of payment lines (not using `zValidator`); atomic: balance sale + status transition in single transaction; bicycle creation outside transaction |
| `/api/backorders/:id/cancel` | PATCH | ✅ Complete | Refund rules: void deposit at requested, non-refundable after |
| `/api/backorders/:id/notes` | PATCH | ⚠️ Partial | Duplicate of `PATCH /:id` — same logic via service; confusing API surface |

**Issues:** Manual validation on POST and complete endpoints. The `PATCH /:id/notes` endpoint is redundant with `PATCH /:id` (both call the same service function). This creates confusion for frontend developers.

---

### Todos (`/api/todos`) — ⚠️ SKELETON LEFTOVER

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| Full CRUD | GET/POST/PUT/DELETE | ✅ Complete (but irrelevant) | **Should be removed** — not part of POS domain |

---

## 2. Missing API Overview

### Critical Gaps (block business flows)

| Missing Endpoint | Needed For | Why |
|-----------------|------------|-----|
| `GET /api/bicycles/:id` | Repair intake, customer detail | Intake flow needs to look up a bicycle by ID when editing; customer detail shows bicycles but can't fetch single bike for edit |
| `PUT /api/bicycles/:id` | Bicycle management | Bicycles created during intake may need correction before repair starts |
| `DELETE /api/bicycles/:id` | Bicycle cleanup | Remove orphaned or incorrectly registered bikes (with guards) |

### Important Gaps (needed for complete flows)

| Missing Endpoint | Needed For | Why |
|-----------------|------------|-----|
| `POST /api/stock/movements` | Inventory tracking | No explicit stock movement history. Sales and repairs deduct stock implicitly, but there's no audit trail of WHY stock changed |
| `PATCH /api/products/:id/adjust-stock` | Manual corrections | Stock counts may be wrong after physical inventory count. Currently no way to correct without voiding/recreating sales |
| `GET /api/sales/:id` | Sale detail view | List returns summary; need full detail with items, payments, customer info for receipt/invoice generation |
| `POST /api/documents/quote` | Quote workflow | No quote concept exists. Backorders serve as quotes but lack the flexibility (temporary pricing, no deposit) |
| `GET /api/reports/*` | Business intelligence | No sales reports, inventory valuation, worker productivity metrics |

### Nice-to-Have Gaps

| Missing Endpoint | Needed For | Why |
|-----------------|------------|-----|
| `POST /api/documents/invoice` | Invoice generation | Sales create records but no formal invoice document with PDF output |
| `GET /api/documents/delivery-note` | Delivery documentation | No delivery note generation for completed repairs or backorder pickups |
| `PATCH /api/repairs/:id/deposit` | Repair deposits | Deposits are recorded as regular POS sales referencing the repair, but there's no dedicated endpoint |

---

## 3. Architecture Review

### 3.1 Layer Boundaries — Mostly Clean with Exceptions

The intended layer flow is: **Route → Service → Repository → Database**

In practice:
- ✅ Most routes properly delegate to services (`SalesService`, `RepairService`, `BackorderService`)
- ⚠️ Some routes call the database directly without a service layer:
  - `/api/products` GET — queries DB directly, no service
  - `/api/products/:id` PUT — queries DB directly, no service
  - `/api/customers` GET — uses `searchCustomers()` helper from db/index.ts (not a service)
  - `/api/bicycles` GET/POST — queries DB directly, no service
  - `/api/workers` GET/POST/PUT/DELETE — queries DB directly, no service
  - `/api/dst/products/search` — calls DST search service directly

**Assessment:** The simpler endpoints (products list, workers CRUD) don't have business logic that warrants a service layer. However, for consistency and testability, they should at minimum go through thin service wrappers. This is especially important because the `BicycleService` exists but only has one method — it suggests the intent was to have full services per domain.

### 3.2 Transaction Usage — Good Where It Matters

| Operation | Uses Transaction? | Correct? |
|-----------|------------------|----------|
| Sale creation (`createSaleRecord`) | ✅ Yes | ✅ Deduct stock + insert sale/items/payments atomically |
| Repair intake (`createIntake`) | ✅ Yes | ✅ Create customer (if new) + bicycle + repair atomically |
| Backorder creation (`createBackorder`) | ✅ Yes | ✅ Create backorder + lines + deposit sale atomically |
| Sale voiding (`voidSale`) | ✅ Yes | ✅ Restore stock + update status atomically |
| Repair completion (`completePayment`) | ⚠️ Partial | ⚠️ `createSaleRecord` is transactional, but bicycle status update and repair status update happen AFTER the transaction — if either fails, sale record exists without corresponding state updates |
| Backorder complete (`complete`) | ⚠️ Partial | ⚠️ Balance sale + status transition in transaction, but bicycle creation happens after |
| Repair status transitions | ❌ No | ⚠️ Updates repair table AND optionally creates notification — should be in a transaction for consistency (low risk since SQLite is single-writer) |
| Order line receive (`receiveOrderLine`) | ✅ Yes (partial) | ✅ Line update + stock update in transaction; backorder matching outside (intentional, silently ignored on failure) |

**Key concern:** The `completePayment` and `complete` functions perform post-transaction updates. In SQLite with single-writer model, these are unlikely to fail, but they represent a consistency gap if the application ever moves to a multi-writer database.

### 3.3 Validation Strategy — Inconsistent

Three different patterns exist across routes:

1. **`zValidator` middleware** (cleanest):
   - `/api/products/import-from-dst` ✅
   - `/api/order-lines/*` ✅
   - `/api/dst/auth/login` ✅

2. **Manual `.safeParse()` inline**:
   - `/api/customers` POST/PUT ⚠️
   - `/api/sales` POST ⚠️
   - `/api/workers` POST/PUT ⚠️
   - `/api/backorders` POST ⚠️

3. **No validation at route level** (service handles it):
   - `/api/products/:id` PUT ❌ — no schema applied at all
   - `/api/bicycles` POST ❌ — accepts any JSON
   - `/api/repairs/:id` PATCH ⚠️ — service validates but 400 errors come from error message parsing

**Recommendation:** Standardize on `zValidator` middleware for all endpoints that accept request bodies. This gives consistent error formatting, automatic type inference, and cleaner route handlers.

### 3.4 Error Handling — Structured But Inconsistent

The `jsonError`, `jsonBadRequest`, `jsonNotFound`, etc. helpers are well-designed and used consistently in most routes. However:

- Some routes parse error messages from service exceptions to determine HTTP status (e.g., checking if error message contains "not found" → 404). This is fragile — it depends on exact error message strings.
- The `classifyDbError` function maps SQLite errors to codes, which is good.
- No rate limiting or authentication middleware (though this may be intentional for a local POS system).

### 3.5 Response Format — Inconsistent

Three different response patterns:

1. **Object with metadata:** `{ data: [...], pagination: {...} }` (used by sales list, backorders list)
2. **Array directly:** `[...]` (used by products list, workers list, bicycles list)
3. **Single object:** `{ repair: {...}, items: [...], total: 12345 }` (used by single-item lookups)

**Recommendation:** Standardize on pattern 1 for all list endpoints (`{ data, pagination }`) and pattern 3 for detail endpoints. This makes the frontend API client simpler to write.

### 3.6 Monetary Amounts — Consistent ✅

All monetary amounts are stored as integer cents in the database. The service layer works exclusively in cents. The API layer converts between cents and dollars where needed:
- Sales/repairs return raw cents (frontend converts)
- Some endpoints convert to dollars before returning

**Issue:** The conversion logic is scattered across route handlers rather than centralized. This creates risk of inconsistency (e.g., forgetting to divide by 100 on one field).

### 3.7 Shared Types — Well Maintained ✅

The `shared/types/` and `shared/validations/` directories are well-organized:
- Zod schemas match TypeScript interfaces
- Payment method enum is shared between sales and repairs domains
- Status transition maps (`VALID_STATUS_TRANSITIONS`, `VALID_BACKORDER_TRANSITIONS`) are centralized
- Discriminated unions for backorder line items (part vs bicycle)

### 3.8 DST Authentication — Module-Level State ⚠️

The DST auth service uses a module-level `cachedToken` variable:
```typescript
let cachedToken: CachedToken | null = null
```

This works for a single-process SQLite backend but is not testable without `resetTokenCache()` and won't work if the server runs in a multi-worker environment. Consider injecting token storage as a dependency.

---

## 4. Improvement Plan (Prioritized)

### Priority 1: Clean Up & Standardize (Low Risk, High Impact)

| # | Change | Effort | Why |
|---|--------|--------|-----|
| 1.1 | Remove `/api/todos` routes and `todos` table references | Small | Dead code — not part of POS domain; reduces maintenance burden |
| 1.2 | Standardize validation: replace manual `.safeParse()` with `zValidator` middleware on all route handlers | Medium | Consistent error formatting, cleaner code, easier to audit |
| 1.3 | Add Zod schema to `/api/products/:id` PUT endpoint | Small | Currently no validation — security and data integrity risk |
| 1.4 | Add Zod schema to `/api/bicycles` POST endpoint | Small | Currently accepts any JSON — should validate required fields |

### Priority 2: Fill Critical Gaps (Medium Risk, Required for Flows)

| # | Change | Effort | Why |
|---|--------|--------|-----|
| 2.1 | Add `GET /api/bicycles/:id` endpoint with service layer | Small | Needed by repair intake and customer detail flows |
| 2.2 | Add `PUT /api/bicycles/:id` endpoint | Small | Bicycle correction before repair starts |
| 2.3 | Add `DELETE /api/bicycles/:id` with guards (check for active repairs) | Small | Cleanup of orphaned bikes |
| 2.4 | Add `GET /api/sales/:id` detail endpoint | Medium | Need full sale detail for receipt/invoice generation |
| 2.5 | Complete the `BicycleService` — move all bicycle logic from routes into service | Medium | Consistency with other domains; testability |

### Priority 3: Improve Transaction Safety (Medium Risk, Important)

| # | Change | Effort | Why |
|---|--------|--------|-----|
| 3.1 | Wrap `completePayment` post-transaction updates in a retry-safe pattern or move bicycle/repair status into the shared transaction | Medium | Ensures atomicity across all state changes on repair completion |
| 3.2 | Wrap backorder `transitionStatus` and `updateBackorder` in transactions (even though SQLite is single-writer) | Small | Consistency with other operations; future-proofing for multi-writer DB |
| 3.3 | Add explicit stock movement tracking table + API endpoint | Large | Current implicit stock changes have no audit trail |

### Priority 4: Documentation & Conventions (Low Risk, Long-term Value)

| # | Change | Effort | Why |
|---|--------|--------|-----|
| 4.1 | Create `server/src/repositories/` layer for all DB queries | Large | Separates query logic from business logic; improves testability |
| 4.2 | Standardize response format: `{ data, pagination }` for lists, single object for details | Medium | Makes frontend API client simpler and more predictable |
| 4.3 | Centralize cents↔dollars conversion in a utility module | Small | Prevents inconsistent rounding across endpoints |
| 4.4 | Add error code constants to shared types (not just route-level) | Small | Consistent error codes across all services |

---

## 5. Recommended Backend Conventions

### Route Naming

```
# Use resource-oriented REST paths
GET    /api/products          → list products
POST   /api/products          → create product
GET    /api/products/:id      → get single product
PUT    /api/products/:id      → update product
DELETE /api/products/:id      → delete product

# Use action-oriented sub-paths for non-CRUD operations
POST   /api/repairs/intake           → create repair intake (composite operation)
PATCH  /api/repairs/:id/status       → transition status
POST   /api/repairs/:id/timer/start  → start work timer
POST   /api/repairs/:id/complete-payment → complete with payment

# Use collection-level actions for batch operations
PATCH  /api/order-lines/mark-ordered     → mark all pending as ordered (query param: supplierCode)
```

### Request/Response Format

**List endpoints:**
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 150,
    "totalPages": 8
  }
}
```

**Detail endpoints:**
```json
{
  "id": "...",
  "name": "...",
  // ... fields
}
```

**Create responses (201):**
```json
{
  "id": "...",
  // ... created resource fields
}
```

### Error Format

All errors follow the unified format from `server/src/lib/errors.ts`:
```json
{
  "error": "Human-readable message",
  "code": "ERROR_CODE"
}
```

Where `ERROR_CODE` is one of: `INTERNAL_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VALIDATION_ERROR`, `DATABASE_ERROR`, `SERVICE_UNAVAILABLE`.

### Validation Strategy

**All routes MUST use `zValidator` middleware:**
```typescript
import { zValidator } from '@hono/zod-validator'
import { createProductSchema } from '@shared'

app.post('/', zValidator('json', createProductSchema), async (c) => {
  const body = c.req.valid('json') // already validated, typed
  // ...
})
```

**Never parse raw JSON and call `.safeParse()` inline.** The middleware approach:
- Returns proper 400 with Zod error details automatically
- Provides typed `body` via `c.req.valid('json')`
- Is consistent across all routes
- Reduces boilerplate in route handlers

### Service/Database Separation

```
Route Handler (HTTP concerns only)
    ↓
Service (business logic, orchestration)
    ↓
Repository (database queries — optional for simple CRUD)
    ↓
Database
```

**Current state:** Services exist for complex operations (sales, repairs, backorders). Simple endpoints (products list, workers CRUD) call DB directly.

**Recommendation:** Add thin service wrappers even for simple endpoints. This:
- Makes testing easier (mock the service, not the DB)
- Provides a single place to add caching, logging, or metrics later
- Keeps the codebase consistent as complexity grows

### Transaction Boundaries

```typescript
// GOOD: All related mutations in one transaction
await db.transaction((tx) => {
  tx.update(productsTable).set({ quantityOnHand: ... }).execute()
  tx.insert(salesTable).values({...}).execute()
  tx.insert(saleItemsTable).values([...]).execute()
})

// BAD: Related mutations split across transactions
await db.update(productsTable).set({ quantityOnHand: ... }).execute() // first transaction
await db.insert(salesTable).values({...}).execute()                   // second transaction — if this fails, stock is already deducted!
```

**Rule:** If two or more tables must change together for a single business operation, they MUST be in the same transaction. Post-transaction updates are acceptable only when:
1. The post-operation is independent (can be retried)
2. There's a compensating action if it fails
3. The risk of failure is known and documented

---

## 6. Prioritized TODO List

### Immediate (do first — no risk, high value)

- [ ] **Remove todos API** — delete `server/src/api/todos.ts`, remove from `app.ts` routes, consider removing `todos` table
- [ ] **Add Zod validation to products PUT** — apply `updateProductSchema` via `zValidator` middleware
- [ ] **Add Zod validation to bicycles POST** — create and apply a schema for bicycle creation
- [ ] **Standardize validation across all routes** — replace manual `.safeParse()` with `zValidator` on customers, sales, workers, backorders

### Short-term (2-3 sprints)

- [ ] **Add bicycle CRUD endpoints** — GET/:id, PUT/:id, DELETE/:id with appropriate guards
- [ ] **Add sale detail endpoint** — GET /api/sales/:id with items + payments + customer info
- [ ] **Complete BicycleService** — move all bicycle logic from routes into the service layer
- [ ] **Standardize response format** — ensure all list endpoints return `{ data, pagination }`

### Medium-term (planned for next quarter)

- [ ] **Add stock movement tracking** — new table + API endpoint for manual corrections and audit trail
- [ ] **Improve transaction safety on repair completion** — move bicycle/repair status updates into the shared transaction or add compensating actions
- [ ] **Wrap backorder transitions in transactions** — consistency with other operations
- [ ] **Add repository layer** — separate query logic from service logic for better testability

### Long-term (when complexity warrants)

- [ ] **Documented API contracts** — formalize request/response shapes per endpoint
- [ ] **Centralized currency conversion** — single utility for cents↔dollars to prevent rounding inconsistencies
- [ ] **DST auth dependency injection** — replace module-level token cache with injectable storage
- [ ] **Error code standardization** — move error codes from route-level to shared types

---

## Appendix A: File Reference

| Category | Files |
|----------|-------|
| Routes | `server/src/api/{products,customers,sales,workers,bicycles,repairs,repair-items,dst,dst-products,order-lines,backorders,todos}.ts` |
| Services | `server/src/services/{sales,repairs,customer-detail,backorders,product-import,bicycle,dst-auth,dst-search,order-basket,sale-record}.ts` |
| Schema | `server/src/db/schema.ts` |
| DB Config | `server/src/db/index.ts` |
| Errors | `server/src/lib/errors.ts` |
| App Entry | `server/src/app.ts`, `server/src/server.ts` |
| Shared Types | `shared/types/{product,customer,sale,repair,backorder,worker,order,dst,session-parser,todo}.ts` |
| Shared Validations | `shared/validations/{product,customer,sale,repair,backorder,worker,order,dst-product,constants}.ts` |

## Appendix B: Business Flow Coverage Matrix

| Flow | Covered? | Gaps |
|------|----------|------|
| Direct shop sale (anonymous/named) | ✅ Yes | No GET by ID for receipt generation |
| Add products to cart | ⚠️ Partial | No cart/basket API — items sent directly in sale request |
| Register payment method | ✅ Yes | Split payments supported via `payments` array |
| Reduce stock | ✅ Yes | Implicit during sale creation; no explicit movement tracking |
| Create final immutable sale | ✅ Yes | Sale record is created atomically with items and payments |
| Repair intake (register customer) | ✅ Yes | Customer lookup by phone or inline creation |
| Select/create bicycle | ⚠️ Partial | No GET/PUT/DELETE for bicycles; POST has no validation |
| Create repair order | ✅ Yes | Atomic: customer + bicycle + repair in single transaction |
| Add notes, tasks, parts, dates | ✅ Yes | Line items (parts/labor), timer, editable fields with guards |
| Convert/complete to sale | ✅ Yes | `complete-payment` creates sale record atomically |
| Product CRUD | ⚠️ Partial | PUT has no validation; no stock movement API |
| Stock movements/corrections | ❌ No | Implicit only (via sales/repairs); no explicit tracking |
| DST product import | ✅ Yes | Create or update without touching stock fields |
| Order basket management | ✅ Yes | Add, merge, adjust quantity, mark ordered, receive |
| Backorder lifecycle | ✅ Yes | Full CRUD with status transitions and deposit/balance payments |
| Customer CRUD + history | ✅ Yes | Full CRUD; detail endpoint aggregates all related data |
| Bicycle CRUD + history | ❌ Partial | Only list + create; no single lookup, update, delete |
