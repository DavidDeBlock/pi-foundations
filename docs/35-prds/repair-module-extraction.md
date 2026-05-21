# PRD: Repair Module Extraction & Service Layer

## Problem Statement

The `repairs` feature is the core business logic of the POS system, handling customer intake, bicycle tracking, status lifecycle management, work timers, line items, and payment completion. Currently, all this complex state machine logic lives directly inside Hono route handlers in `server/src/api/repairs.ts` (~400 lines) and `repair-items.ts`.

This violates the documented layer boundary (Route → Service → Repository → Database). Routes call the database directly with no service layer, meaning:
- Business rules are scattered across HTTP handling code
- No tests exist for repairs despite it being the most complex feature
- Callers learn implementation details (DB tables, Drizzle queries, cents conversion) instead of domain concepts
- Changing a rule requires touching route handlers that also handle HTTP concerns

## Solution

Extract all repair business logic into a **Repair Module** (`server/src/services/repairs.ts`) with a small, stable interface. Route handlers become thin adapters: parse request → call module → format response. The module encapsulates status transitions, editability rules, timer math, payment completion, and line item management.

## User Stories

1. As a shop manager, I want all repair business rules in one place so that I can change them without hunting through HTTP handlers
2. As a technician, I want the intake flow to atomically create customer + bicycle + repair so that data stays consistent
3. As a technician, I want status transitions validated server-side with proper side effects (notifications, pickup dates) so that repairs follow the correct lifecycle
4. As a shop manager, I want editability rules enforced per field/status so that completed repairs can't be accidentally modified
5. As a technician, I want work timer calculations handled consistently so that labor billing is accurate
6. As a cashier, I want payment completion to atomically deduct inventory, create a sale, and mark the repair complete so that stock levels and financial records stay in sync
7. As a developer, I want repair logic testable without HTTP mocking so that I can verify business rules quickly
8. As a future maintainer, I want route handlers to be thin adapters so that adding new endpoints doesn't require understanding complex state machine internals

## Implementation Decisions

### Module Structure
- **`server/src/services/repairs.ts`** — New Repair Service containing all business logic
- **`server/src/api/repairs.ts`** — Refactored to thin adapter layer (parse → call service → format)
- **`server/src/api/repair-items.ts`** — Merged into repair service for cohesion (items are tightly coupled to repairs)

### Service Interface
```typescript
interface RepairService {
  createIntake(data: NewIntake): Promise<IntakeResult>
  transitionStatus(repairId, status, holdReason?, holdReasonNote?): Promise<Repair>
  updateRepair(repairId, fields: UpdateRepairPayload): Promise<Repair>
  startTimer(repairId): Promise<Repair>
  stopTimer(repairId): Promise<TimerStopResponse>
  completePayment(repairId, payments): Promise<RepairPayment>
  addItem(repairId, item: NewRepairItem): Promise<RepairItem>
  removeItem(repairId, itemId): Promise<void>
}
```

### Technical Decisions
- **Service pattern**: Object with functions (easier to mock/test than a class)
- **DB access**: Service imports `db` directly for simplicity; tests can use in-memory SQLite if isolation is needed later
- **Shared types/validations**: Read-only references from `shared/types/repair.ts` and `shared/validations/repair.ts` — no changes needed to interfaces, just moved implementation
- **Transaction handling**: Atomic operations (payment completion) remain in the service using Drizzle transactions
- **Side effects**: Notifications, bicycle status propagation, inventory deduction all handled inside service methods

### Architecture Alignment
This matches the documented layer boundary: Route → Service → Repository → Database. Routes handle HTTP concerns only; services contain business rules.

## Testing Decisions

### What Makes a Good Test
- Test external behavior (inputs/outputs), not implementation details
- No HTTP mocking needed — pass data objects, assert results
- Cover happy paths and edge cases (invalid transitions, insufficient stock, missing records)
- Use existing test pattern: `server/__tests__/*.test.ts` with Vitest

### Modules to Test
1. **Repair Service** (`server/__tests__/repair-service.test.ts`) — All business logic tests
   - Status transition matrix (valid/invalid transitions)
   - Editability rules per field/status
   - Intake flow (customer lookup, inline creation)
   - Hold reason enforcement
   - Timer calculations (start/stop/cumulative)
   - Payment completion (atomic transaction, inventory deduction, split payments)
   - Line item CRUD with status guards

### Prior Art
- `server/__tests__/todos.test.ts` — Simple API tests using Hono's request/response pattern
- `server/__tests__/product-import-service.test.ts` — Service-level tests without HTTP concerns (template for repair service tests)

## Out of Scope

- Client-side refactoring (Zustand store, React components remain unchanged)
- Database schema changes (existing tables support current logic)
- Notification delivery implementation (placeholder remains placeholder)
- Worker assignment UI improvements
- Search/filter enhancements on repairs list
- Multi-worker labor tracking (single owner model preserved)

## Further Notes

- This is a refactoring PRD — no new user-facing features, just structural improvement
- Existing API contracts remain identical; only internal organization changes
- Zero-downtime migration: routes call service methods with same request/response shapes
- Future work: If service grows too large, consider splitting into sub-modules (intake-service, payment-service, etc.)
