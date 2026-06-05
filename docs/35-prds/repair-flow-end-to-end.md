[PRD] Repair Flow — End-to-End Implementation

## Problem Statement

The shop has no way to track, manage, or complete bicycle repair orders. The database schema for repairs exists (`repairs`, `repair_line_items`, `work_logs`, `repair_status_history`), but there are zero routes, services, shared types/validations, or frontend features. Technicians have no system to intake bikes, log work time, track parts used, calculate labor costs, notify customers when ready, and complete payment. The shop currently operates without any digital repair workflow.

## Solution

Build a complete repair management feature from scratch: intake flow (customer + bicycle selection/creation), status lifecycle tracking (intake → in_progress ↔ on_hold → verified → ready → completed), line item management (parts via product finder, labor from predefined catalog), manual work timers for payroll, payment completion with linked sale creation and stock deduction, pickup notifications, and a repair list/detail view for managers.

## User Stories

1. As a shop technician, I want to intake a new repair by selecting or creating a customer, so that the bike is logged in the system
2. As a shop technician, I want to select an existing bicycle from the customer's bikes during intake, so that I don't duplicate records
3. As a shop technician, I want to create a new bicycle inline during intake (brand, model, color), so that walk-in customers with no prior record can still be served quickly
4. As a shop technician, I want to add repair notes during intake, so that important details are captured for later reference
5. As a shop manager, I want to assign repairs to technicians after intake, so that work is dispatched based on availability and specialization
6. As a shop technician, I want to see all active repairs in a list view with status color-coding, customer name, bicycle info, assigned worker, and pickup date, so that I can quickly gauge shop workload
7. As a shop manager, I want to filter the repair list by status, assigned worker, and pickup date (today/this week), so that I can focus on urgent or relevant repairs
8. As a shop technician, I want to transition a repair from intake to in_progress when I start working on it, so that progress is tracked accurately
9. As a shop technician, I want to put a repair on hold (e.g., waiting for parts) and resume it later, so that work can be paused without losing context
10. As a shop manager, I want to verify a repair after inspecting the technician's work, so that the invoice is finalized before marking it ready for pickup
11. As a shop technician, I want to mark a repair as ready when the customer can pick it up, so that pickup notifications are triggered
12. As a shop manager, I want to complete payment for a repair (cash/card/split), so that stock is deducted and revenue is recorded
13. As a shop manager, I want to cancel a repair from any status, so that abandoned or rejected jobs can be cleaned up
14. As a shop technician, I want to add parts to a repair using the same product finder/barcode scan flow as POS sales, so that inventory tracking is consistent
15. As a shop technician, I want to add labor charges from predefined services (e.g., "Tune-up", "Brake Job"), so that pricing is standardized and accurate
16. As a shop technician, I want to track hours worked on a repair using manual start/stop timers, so that payroll calculations are based on actual time spent
17. As a shop manager, I want to view all line items (parts + labor) for a repair in the detail view, so that I can review costs before payment
18. As a shop technician, I want to add or edit customer notes at any point during the repair lifecycle, so that communication is maintained throughout
19. As a shop technician, I want to add or edit internal notes (technician observations) at any point until completion, so that technical details are preserved for future reference
20. As a shop manager, I want to reassign a repair to a different worker at any time, so that workload can be rebalanced dynamically
21. As a shop technician, I want to see a single scrollable page with collapsible sections (Details, Line Items, Work Logs, Notes) for each repair, so that all information is accessible without excessive navigation
22. As a shop manager, I want to receive notifications when repairs reach ready status, so that I know which customers are waiting for pickup
23. As a shop technician, I want the system to create a linked Sale record (sourceType='repair') when payment is completed, so that repair revenue appears in sales history and monthly reports automatically
24. As a shop manager, I want stock to be deducted only at payment completion (not when line items are added), so that parts can be returned or written off flexibly if a repair is cancelled before payment

## Implementation Decisions

### Shared Types & Validations
- Dedicated files in `shared/types/repair.ts` and `shared/validations/repair.ts` (not derived from Drizzle schema) to keep frontend decoupled from database internals, following the golden-copy pattern established by customer/sale domains.

### Status Lifecycle
- Six statuses: `intake`, `in_progress`, `on_hold`, `verified`, `ready`, `completed`
- Valid transitions: intake → in_progress; in_progress ↔ on_hold; in_progress → verified; verified → ready; ready → completed; any state → cancelled
- Verified status represents manager inspection and invoice finalization before marking ready for pickup.

### Line Items
- Unified line item model supporting both parts (from `parts` catalog) and labor (from `laborServices` catalog)
- Parts added via product finder (same barcode scan/search flow as POS sales)
- Labor selected from predefined services with billingType (hourly/fixed); hourly services auto-calculate cost from minutesWorked × defaultRate

### Intake Flow
- Single-form modal collects customer (search/create), bicycle (select/inline-create), notes, and submits atomically
- Inline customer creation: minimal fields (name, phone, email); full address/details added later on pickup
- Inline bicycle creation: brand, model, color only; no VIN/serial number tracking in this slice
- Worker assignment deferred until dispatch (repairs start unassigned)

### Payment Completion
- Atomic transaction: collect payments → deduct stock for parts used → create linked Sale record (sourceType='repair') → mark repair completed with completedAt timestamp
- Stock deduction happens only at payment completion, not when line items are added or status changes
- Repair revenue attributed via linked sale for sales history and monthly reporting

### Editability Rules
- Everything remains editable until `completed` — no intermediate locks at verified or ready states
- Customer notes: always editable
- Internal notes: always editable (no lock at verification)
- Line items: editable until completion (customer may add things when picking up)
- Assigned worker: reassignable anytime by managers

### Work Timers
- Manual start/stop buttons in the UI; not auto-captured from status transitions
- Records actual time worked per repair for payroll accuracy
- Stored in `work_logs` table with startedAt and endedAt timestamps

### Notifications
- Pickup notifications via existing `notifications` table when repairs reach ready status
- Manager can see "X customers waiting for pickup" at a glance
- SMS/email integration deferred to future work

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
   - Intake flow (customer lookup, inline creation, bicycle selection)
   - Hold reason enforcement
   - Timer calculations (start/stop/cumulative)
   - Payment completion (atomic transaction, inventory deduction, linked sale creation)
   - Line item CRUD with status guards

### Prior Art
- `server/__tests__/todos.test.ts` — Simple API tests using Hono's request/response pattern
- `server/__tests__/product-import-service.test.ts` — Service-level tests without HTTP concerns (template for repair service tests)

## Out of Scope

- Calendar view for repairs (separate feature, depends on core flow working)
- SMS/email notification delivery (placeholder only; notifications table records readiness)
- Multi-worker labor tracking per line item (single owner model preserved)
- Search/filter enhancements beyond worker/status/pickup date filters
- Mobile-responsive repair detail layout (assume desktop/tablet for now)
- Invoice PDF generation or printing
- Warranty/return management (separate feature if needed later)

## Further Notes

- This is a greenfield implementation on top of existing database schema — no legacy code to refactor
- The `repairs`, `repair_line_items`, `work_logs`, and `repair_status_history` tables already exist with full types exported from `server/src/db/schema.ts`
- Existing shared sale type references `'repair'` as a valid `sourceType`; stock movements support `'repair_use'` reason — these are aligned with the design decisions above
- The existing PRDs in `docs/35-prds/` (module extraction, calendar view) were written assuming refactoring; this PRD supersedes them for the actual implementation approach
