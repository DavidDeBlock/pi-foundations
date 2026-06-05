# Repairs Route — Dependency Graph

Generated from codebase analysis. Maps the full dependency chain from HTTP routes through service layer, shared types/validation, and database schema.

---

## Architecture Overview

```
┌──────────────────┐     ┌──────────────────────┐     ┌──────────────────────────┐
│ routes/index.ts  │────▶│ repairs.ts (Hono)    │────▶│ repair.service.ts        │
│                  │     │                      │     │                          │
│ mounts at        │     │ GET    /             │     │ getRepairsList()         │
│ /repairs         │     │ POST   /             │     │ createRepairIntake()     │
│                  │     │ GET    /:id          │     │ transitionRepairStatus() │
│ imports          │     │ PATCH  /:id/status   │     │ updateRepairNotes()      │
│ repairsRoutes    │     │ PATCH  /:id/transition│    │ getRepairById()          │
└──────────────────┘     │ PATCH  /:id/notes    │     │ createRepairLineItem()   │
                           │ GET    /customers/:c │     │ updateRepairLineItem()   │
                           │ POST   /:id/items    │     │ deleteRepairLineItem()   │
                           │ PATCH  /:id/items/i  │     │ listLaborServices()      │
                           │ PATCH  /:id/assign   │     │ assignWorkerToRepair()   │
                           │ POST   /:id/timer/s  │     │ startWorkTimer()         │
                           │ POST   /:id/timer/st │     │ stopWorkTimer()          │
                           │ POST   /:id/complete │     │ completeRepairPayment()  │
                           │ GET    /labor-serv.  │     └──────────┬───────────────┘
                           └──────────────────────┘                │
                                                                   ▼

┌─────────────────────────────────────────────────────────────────────────────┐
│                              SHARED LAYER                                   │
│                                                                             │
│  shared/validations/repair.ts                          shared/types/repair.ts│
│  ──────────────────────────                          ───────────────────────│
│  Zod schemas:                                        TypeScript types & consts:│
│  • repairStatusSchema                                • RepairStatus (7 states)│
│  • holdReasonSchema                                  • HoldReason            │
│  • customerModeSchema                                • RepairLineItemType    │
│  • bicycleModeSchema                                 • VALID_TRANSITIONS map  │
│  • createIntakeCustomerSchema                        • CANCEL_TARGETS         │
│  • createIntakeBicycleSchema                         • Interfaces:            │
│  • repairIntakeSchema                                - Repair, WorkLog        │
│  • transitionRepairStatusSchema                      - LaborService           │
│  • updateRepairSchema                                - RepairDetail           │
│  • createRepairLineItemSchema                        - CompleteRepairResult   │
│  • updateRepairLineItemSchema                        - IntakeCustomer/Bicycle │
│  • assignWorkerSchema                                • RepairPaymentMethod    │
│  • completeRepairPaymentSchema                       ────────────────────────│
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              DB LAYER                                       │
│                                                                             │
│  repairs              FK     workLogs               stockMovements          │
│  ├── bicycleId → bicycles.id  repairId → repairs.id   sales                  │
│  └── assignedTo → users.id    userId → users.id       saleLineItems          │
│                                 startedAt / endedAt    payments               │
│                                                                             │
│  repairLineItems        repairStatusHistory      paymentAllocations         │
│  ├── repairId → repairs.id   repairId → repairs.id                        │
│  └── partId → parts.id       status enum (7 states)                       │
│                                 transitionedAt                                │
│                                                                             │
│  customers (joined via bicycle)                                             │
│  bicycles (via repairs.bicycleId)                                           │
│  users (FK on assignedTo + workLogs.userId)                                 │
│  vatRates (line item pricing)                                               │
│  sequences (repair numbering)                                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         ERROR HANDLING                                       │
│                                                                             │
│  Custom error classes:                                                      │
│  • RepairNotFoundError              (404)                                   │
│  • InvalidStatusTransitionError     (400)                                   │
│  • MissingHoldReasonNoteError       (400)                                   │
│  • RepairLineItemNotFoundError      (404)                                   │
│  • RepairCompletedError             (400/404)                               │
│  • LaborServiceNotFoundError        (500)                                   │
│  • WorkLogNotFoundError             (404)                                   │
│  • RepairNotReadyError              (409)                                   │
│  • PaymentMismatchError             (422)                                   │
│  • InsufficientStockForRepairError(422)                                     │
└─────────────────────────────────────────────────────────────────────────────┘

```

---

## API Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/repairs` | Paginated list with filters (status, assignedTo, pickupDate) and sorting |
| `POST` | `/repairs` | Create repair via intake flow (customer + bicycle selection/creation) |
| `GET` | `/repairs/:id` | Single repair detail — enriched with customer, bicycle, line items, work logs |
| `PATCH` | `/repairs/:id/status` | Transition status — canonical endpoint, validates state machine |
| `PATCH` | `/repairs/:id/transition` | Legacy alias for backward compatibility |
| `PATCH` | `/repairs/:id/notes` | Update customer-facing and/or internal notes |
| `GET` | `/repairs/customers/:customerId` | Get customer with bicycles — used during intake lookup |
| `GET` | `/repairs/labor-services` | List labor services catalog (optional billingType filter) |
| `POST` | `/repairs/:id/items` | Create a line item (part or labor) on a repair |
| `PATCH` | `/repairs/:id/items/:itemId` | Update an existing line item |
| `DELETE` | `/repairs/:id/items/:itemId` | Delete a line item (guarded against completed repairs) |
| `PATCH` | `/repairs/:id/assign` | Assign or reassign a worker to a repair |
| `POST` | `/repairs/:id/timer/start` | Start manual work timer — creates work log entry |
| `POST` | `/repairs/:id/timer/stop` | Stop active work timer session — sets endedAt timestamp |
| `POST` | `/repairs/:id/complete` | Complete repair with payment (atomic transaction) |

---

## Status Machine

```
  intake ──▶ in_progress ──▶ on_hold ◄────────────────────┐
       ╲                      ▲                            │
        ╲                     │                             │
         ▼                    │                             │
      verified ──▶ ready ──▶ completed                      │
           ▲              ▲                                  │
           └──────────────┘                                  │
                                                              │
  ════════════════════                                         │
  cancelled (from any state) ◄─────────────────────────────────┘
```

### Transition Rules
- **intake → in_progress**: Start working on the repair
- **in_progress → on_hold / verified**: Put on hold or mark as verified
- **on_hold → in_progress**: Resume work
- **verified → ready**: Repair complete, awaiting customer collection
- **ready → completed**: Customer pays and collects (triggers sale creation)
- **any → cancelled**: Cancel the repair

### Hold Reasons
| Value | Meaning |
|-------|---------|
| `waiting_parts` | Awaiting parts delivery |
| `awaiting_customer_approval` | Waiting for customer to approve quote |
| `other` | Other reason (requires a note) |

---

## Complete Repair — Atomic Transaction Flow

The `completeRepairPayment()` endpoint performs an all-or-nothing SQLite transaction:

1. **Validate** repair status is `'ready'`
2. **Compute** total from line items and validate payment amounts match
3. **Check** stock availability for all parts used in the repair
4. **Create** linked `Sale` (sourceType=`repair`) with sale + saleLineItems
5. **Create** payment records and allocations (`payments`, `paymentAllocations`)
6. **Deduct** stock via movements (`stockMovements`, reason=`repair_use`)
7. **Mark** repair as completed with `completedAt` timestamp

Any failure at any step rolls back everything.

---

## Cross-Cutting Concerns

### Timestamp Handling
The service layer uses raw SQL executors to bypass Drizzle ORM's Date/number conversion issues with SQLite timestamps, avoiding serialization bugs in the `integer('...', { mode: 'timestamp' })` schema definitions.

### Dual Time Tracking
| Source | Purpose | Location |
|--------|---------|----------|
| `workLogs` table | Actual time worked (payroll) | Timer start/stop endpoints |
| `repairLineItems.minutesWorked` | Billing minutes (may differ from payroll) | Line item creation/update |

### Error Response Pattern
All route handlers follow a consistent error shape:
```json
{ "error": "message", "code": "ERROR_CODE" }
```
With HTTP status codes mapped via `err.name` string matching against custom error class names.
