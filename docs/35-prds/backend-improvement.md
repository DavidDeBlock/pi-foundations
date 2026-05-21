# Backend Improvement Plan — Phases 1-3 PRD

## Problem Statement

The POS system backend has functional core flows (sales, repairs, backorders) but suffers from structural inconsistencies that will compound as features grow:

- **Inconsistent validation**: Some routes use `zValidator` middleware while others manually call `.safeParse()` or have no validation at all
- **Missing critical endpoints**: Bicycle CRUD operations are incomplete; sale detail endpoint doesn't exist
- **Transaction safety gaps**: Repair completion and backorder transitions perform post-transaction updates that create consistency risks
- **No stock audit trail**: Inventory changes happen implicitly without tracking why stock changed
- **Dead code**: Skeleton project leftovers (todos API) remain in the codebase
- **Scattered utilities**: Currency conversion and error codes are duplicated across route handlers

These issues make the codebase harder to maintain, test, and extend. They also create confusion for frontend developers consuming inconsistent API contracts.

## Solution

A three-phase sequential improvement plan that:

1. **Phase 1 (Cleanup & Standardize)**: Remove dead code, standardize validation middleware across all routes, centralize currency conversion and error codes
2. **Phase 2 (Critical Gaps & API Surface)**: Complete bicycle CRUD endpoints with service layer, add sale detail endpoint, standardize list response formats
3. **Phase 3 (Transaction Safety & Stock Audit)**: Ensure atomic state changes for repair completion and backorder transitions, add explicit stock movement tracking table and API

Each phase builds on the previous one, with clear dependencies between slices. The result is a more consistent, testable, and maintainable backend that supports all current business flows properly.

## User Stories

### Phase 1 — Cleanup & Standardize

1. As a developer, I want to remove the todos API endpoints so that dead code doesn't confuse new team members
2. As a frontend developer, I want consistent validation error responses across all routes so that I can handle errors uniformly in the UI
3. As a backend developer, I want all route handlers to use zValidator middleware so that validation logic is standardized and easier to audit
4. As a developer, I want currency conversion centralized in a utility module so that rounding inconsistencies don't appear across endpoints
5. As a developer, I want error codes defined as shared constants so that they're type-safe and consistent across the codebase
6. As a frontend developer, I want the redundant backorder notes endpoint removed so that there's no confusion about which endpoint to use for editing notes

### Phase 2 — Critical Gaps & API Surface

7. As a shop employee, I want to view details of a specific bicycle by ID so that I can edit its information during repair intake
8. As a shop employee, I want to update bicycle details after intake so that corrections can be made before repair work begins
9. As a shop employee, I want to delete orphaned bicycles with guards so that incorrectly registered bikes can be cleaned up without risking active repairs
10. As a developer, I want all bicycle logic in BicycleService so that the service layer is complete and testable like other domains
11. As a shop employee, I want to view full sale details including items and payments so that receipts and invoices can be generated
12. As a frontend developer, I want consistent list response formats with pagination metadata so that API client code is simpler and more predictable

### Phase 3 — Transaction Safety & Stock Audit

13. As a system administrator, I want repair completion to be fully atomic so that bicycle status and repair status are always consistent with the sale record
14. As a system administrator, I want backorder status transitions wrapped in transactions so that notifications are created atomically with state changes
15. As an inventory manager, I want to see why stock levels changed for each product so that audit trails exist for all inventory movements
16. As a shop employee, I want to manually correct stock counts after physical inventory so that discrepancies can be fixed without voiding sales
17. As a developer, I want stock movement records emitted alongside existing mutations so that the audit trail is automatically maintained

## Implementation Decisions

### Module Architecture

**New Deep Modules:**

- **Currency Utility**: Pure function module for cents↔dollars conversion with consistent rounding behavior. No external dependencies.
- **Error Code Constants**: Typed enum/const object in shared types defining all error codes used across routes and services. Provides type safety and prevents typos.
- **Response Format Utility**: Helper functions for constructing standardized list responses (`{ data, pagination }`) and detail responses. Ensures consistent API contracts.
- **StockMovementService**: New service module handling stock movement creation with reason enum (sale, void, order_receive, manual_correction), reference tracking to source operations, and validation of delta constraints.

**Extended Existing Modules:**

- **BicycleService**: Extended from single-method (`createBicycleFromBackorder`) to full CRUD service with `getById`, `update`, `deleteWithGuards` methods
- **SalesService**: Added `getSaleDetail` method returning enriched sale data with items, payments, and customer information
- **RepairService**: Modified `completePayment` to include bicycle status update and repair status update within the shared transaction boundary
- **BackorderService**: Wrapped status transitions and note updates in database transactions for consistency

**Route Handler Changes:**

- Removed: todos API routes entirely
- Standardized: All route handlers using manual `.safeParse()` converted to zValidator middleware pattern
- Added: Bicycle GET/:id, PUT/:id, DELETE/:id endpoints delegating to BicycleService
- Added: Sales GET/:id detail endpoint
- Updated: List endpoints returning raw arrays now return standardized `{ data, pagination }` format

### API Contracts

**Validation:**
- All routes accepting request bodies MUST use zValidator middleware
- Validation errors return consistent 400 responses with Zod error details
- Route handlers receive pre-validated, typed data via `c.req.valid('json')`

**Response Formats:**
- List endpoints: `{ data: [...], pagination: { page, limit, totalCount, totalPages } }`
- Detail endpoints: Single object with resource fields
- Create responses (201): Created resource object

**Stock Movements API:**
- `POST /api/stock/movements`: Create manual stock correction with reason and reference tracking
- `PATCH /api/products/:id/adjust-stock`: Convenience endpoint that updates quantityOnHand and emits movement record atomically
- Movement records include: productId, quantityDelta (positive/negative), reason enum, referenceId, referenceType, createdAt

### Transaction Boundaries

**Repair Completion:**
```
Transaction {
  - Create sale record with items and payments
  - Update bicycle status to completed
  - Update repair status to completed
}
// All or nothing — no post-transaction updates
```

**Backorder Transitions:**
```
Transaction {
  - Update backorder status
  - Create notification record (if applicable)
}
```

### Schema Changes

**New Table: stock_movements**
- id (UUID, primary key)
- productId (FK to products table)
- quantityDelta (integer, positive or negative)
- reason (enum: sale | void | order_receive | manual_correction)
- referenceId (string, ID of source operation — sale ID, backorder ID, etc.)
- referenceType (string, type of reference — "sale", "backorder", "manual")
- createdAt (timestamp)

**Indexes:**
- productId for querying movements by product
- reason for filtering by movement type
- createdAt for chronological queries

## Testing Decisions

### What Makes a Good Test

Tests should verify external behavior and contracts, not implementation details:
- **Service tests**: Mock the database layer, test business logic outcomes (what gets inserted/updated/deleted)
- **Validation tests**: Verify schemas accept valid data and reject invalid data with appropriate errors
- **Utility tests**: Pure function inputs → outputs verification
- **API contract tests**: Verify response shapes match documented formats

### Modules to Test

**New Deep Modules:**
1. **Currency Utility**: Edge cases (0, negative values, odd cents), rounding behavior, bidirectional conversion consistency
2. **Error Code Constants**: Type safety verification, completeness check against used codes in codebase
3. **Response Format Utility**: Pagination calculation accuracy, edge cases (empty results, single page)
4. **StockMovementService**: Movement creation with valid/invalid deltas, reason enum validation, reference tracking

**Extended Existing Modules:**
5. **BicycleService.getById**: Returns bicycle when exists, throws 404 when not found
6. **BicycleService.update**: Validates input via schema, updates correct fields, preserves unchanged fields
7. **BicycleService.deleteWithGuards**: Allows deletion when no active repairs, blocks with 409 when repair exists
8. **SalesService.getSaleDetail**: Returns enriched sale with items/payments/customer, throws 404 when not found

**Transaction Safety:**
9. **Repair completion atomicity**: Verify all three state changes (sale, bicycle status, repair status) succeed or fail together
10. **Backorder transition transactions**: Status update and notification creation are atomic

### Prior Art

Existing test patterns in the codebase:
- `server/__tests__/bicycle-service.test.ts` — DB-mocked service tests using Vitest with chainable Drizzle-style mock
- `server/__tests__/sales.service.test.ts` — Service layer testing pattern
- `shared/validations/*.test.ts` — Schema validation test patterns

New tests should follow these same patterns: Vitest framework, mocked database for service tests, pure function testing for utilities.

## Out of Scope

### Phase 4+ Items (Deferred)
- Repository abstraction layer separating query logic from business logic
- DST authentication dependency injection replacing module-level token cache
- Quote workflow endpoints (`POST /api/documents/quote`)
- Reporting endpoints (`GET /api/reports/*`)
- Invoice and delivery note generation with PDF output
- Repair deposit dedicated endpoint

### General Exclusions
- Frontend changes or API client updates
- Database migration tooling beyond what's needed for stock_movements table
- Authentication middleware, rate limiting, or security features not mentioned in the review
- Multi-worker database support (SQLite single-writer model remains)
- Performance optimization or caching layers

## Further Notes

### Execution Order

Phases must be executed sequentially:
1. Phase 1 stabilizes validation and removes dead code — foundation for everything else
2. Phase 2 fills critical gaps using the standardized patterns from Phase 1
3. Phase 3 improves transaction safety and adds audit trail, building on the complete service layer from Phase 2

### Risk Mitigation

- **Breaking changes**: Response format standardization in Phase 2 is a breaking change for frontend consumers. Coordinate with frontend team before deployment.
- **Data migration**: Stock movement tracking requires backfilling historical movements if audit trail completeness is needed (not included in this PRD).
- **Testing coverage**: All new and modified services should have tests following existing patterns before merging.

### Success Criteria

The improvement plan is complete when:
- All routes use zValidator middleware consistently
- Bicycle CRUD endpoints exist with proper service layer delegation
- Sale detail endpoint returns enriched data
- List responses follow standardized format
- Repair completion and backorder transitions are fully transactional
- Stock movement tracking table exists with API for manual corrections
- Existing stock mutations emit movement records automatically
- All new modules have tests following existing patterns
