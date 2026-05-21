# Schema Domain Analysis — Bicycle Shop POS

**Source:** `server/src/db/schema.ts`  
**Last Updated:** 2026-05-19  

Domain contract derived from the Drizzle/SQLite schema. Every agent should read this before working on features that touch multiple domain areas.

---

## 1. Domain Entities

### Customers & Staff

| Entity | Table | Purpose |
|--------|-------|---------|
| **Customer** | `customers` | Who we serve — private individuals or companies. Walk-ins have no row (anonymous). |
| **User** | `users` | Shop staff — mechanics and managers with hourly rates for labor billing. |

### Catalog

| Entity | Table | Purpose |
|--------|-------|---------|
| **Part** | `parts` | Physical products with barcode, price, cost, and stock quantity. The shop's parts inventory. |
| **Labor Service** | `labor_services` | Named work types (e.g., "brake adjustment") billed hourly or at a fixed rate. |
| **Bicycle Template** | `bicycle_templates` | Catalog definitions of bicycle models — become real bicycles when sold or taken in. |
| **VAT Rate** | `vat_rates` | Tax rate lookup table (e.g., 21% standard, 6% reduced). Referenced by every line item. |

### Bicycles

| Entity | Table | Purpose |
|--------|-------|---------|
| **Bicycle** | `bicycles` | Real physical bicycle instances — either shop inventory or customer-owned (in for repair). A bicycle can have multiple repairs over its lifetime. |

### Repairs

| Entity | Table | Purpose |
|--------|-------|---------|
| **Repair** | `repairs` | Work tracking record linking a bicycle to assigned staff, status, and timeline. |
| **Repair Line Item** | `repair_line_items` | Parts used and labor logged on a repair. Billing-specific (may differ from actual time). |
| **Work Log** | `work_logs` | Timer sessions — source of truth for *actual* time worked (payroll), separate from billing minutes. |
| **Repair Status History** | `repair_status_history` | Audit trail of every status transition on a repair. |

### Working Documents (pre-sale)

| Entity | Table | Purpose |
|--------|-------|---------|
| **Quote** | `quotes` + `quote_line_items` | Estimates/proposals sent to customers. Immutable once sent. Copied to Order or Repair on approval — never both simultaneously. |
| **Customer Order** | `customer_orders` + `customer_order_line_items` | Non-instant fulfillment requests (parts or bicycles). Customer places order, shop sources it. Can be paid fully upfront. |
| **Backorder** | `backorders` + `backorder_line_items` | Parts not in stock — customer pays deposit, part is ordered, arrives later. Creates a Sale with `sourceType='backorder'` on completion. |
| **Backorder Status History** | `backorder_status_history` | Audit trail of every status transition on a backorder. |

### Sales & Invoices (final documents)

| Entity | Table | Purpose |
|--------|-------|---------|
| **Sale** | `sales` + `sale_line_items` | Paid transactions / receipts. Immutable once created. Source of truth for completed commerce. One invoice per sale (DB-enforced). |
| **Invoice** | `invoices` + `invoice_line_items` | Optional legal/financial snapshot from a Sale. Immutable copy of line items. Unique constraint on `saleId`. |

### Payments

| Entity | Table | Purpose |
|--------|-------|---------|
| **Payment** | `payments` | A payment event (cash, card, bank transfer). One payment can settle multiple documents. |
| **Payment Allocation** | `payment_allocations` | Junction table — splits one payment across multiple document targets polymorphically. Over-allocation prevented at application level only. |

### Supplier & Inventory

| Entity | Table | Purpose |
|--------|-------|---------|
| **Supplier Product** | `supplier_products` | Cache of external supplier product data (raw JSON). Not inventory source of truth. |
| **Supplier Order** | `supplier_orders` + `supplier_order_lines` | Internal procurement — shop ordering parts from suppliers. Tracks ordered vs received quantities. |
| **Stock Movement** | `stock_movements` | Audit trail for all inventory changes. Every stock change is a row with reason and reference. Source of truth for quantity on hand. |

### Notifications

| Entity | Table | Purpose |
|--------|-------|---------|
| **Notification** | `notifications` | Customer messages (SMS/email). Created manually for now — not event-driven. |

---

## 2. Relationships

### Parent-Child (1:N)

```
customers ──→ bicycles (customer-owned)
customers ──→ quotes
customers ──→ customer_orders
customers ──→ backorders
customers ──→ sales (nullable — walk-ins have no customer)
customers ──→ invoices (denormalized from sale)
customers ──→ notifications

users ──→ repairs (assignedTo, nullable)
users ──→ work_logs

bicycle_templates ──→ bicycles (templateId, nullable for customer-owned)
bicycles ──→ repairs (1 bicycle → many repairs over time)

quotes ──→ quote_line_items
repairs ──→ repair_line_items
repairs ──→ work_logs
repairs ──→ repair_status_history
customer_orders ──→ customer_order_line_items
backorders ──→ backorder_line_items
backorders ──→ backorder_status_history
sales ──→ sale_line_items
invoices ──→ invoice_line_items (1:1 with source sale — unique on saleId)

payments ──→ payment_allocations
supplier_orders ──→ supplier_order_lines

parts ──→ stock_movements
vat_rates ──→ *every line item table*
labor_services ──→ repair_line_items (via laborServiceId)
```

### Polymorphic Relationships

| Junction | Source | Targets | Purpose |
|----------|--------|---------|---------|
| `payment_allocations` | `payments` | `sale`, `customer_order`, `backorder`, `repair`, `invoice` | One payment can partially or fully settle any document type. Uses `(targetType, targetId)` composite key pattern. |
| `sales.sourceType/sourceId` | — | `direct_sale` (no source), `repair`, `customer_order`, `backorder` | Tracks where a sale originated. Enables tracing commerce back to its working document. |

### Shared Line Item Pattern

All line item tables share the same column structure via `lineItemColumns`:
- **3 line types**: `part`, `labor`, `bicycle`
- Pricing: `unitPriceNet` → discount → `lineTotalNet` + `lineTotalVat` = `lineTotalGross`
- VAT rate referenced per-line (different items can have different tax rates)

Bicycle-specific line items (`quote_line_items`, `customer_order_line_items`, `sale_line_items`, `invoice_line_items`) additionally include `bicycleLineColumns` for snapshotted bicycle details.

---

## 3. Explicit Database Constraints

### Required Fields (non-nullable, no default)

| Table | Field(s) |
|-------|----------|
| `customers` | `id`, `type` |
| `users` | `id`, `name`, `role`, `hourlyRate`, `isActive` |
| `vat_rates` | `id`, `rate`, `description` |
| `parts` | `id`, `barcode`, `name`, `priceNet`, `quantityOnHand`, `isActive` |
| `labor_services` | `id`, `name`, `billingType`, `defaultRate`, `isActive` |
| `bicycle_templates` | `id`, `brand`, `model`, `isActive` |
| `bicycles` | `id`, `source`, `brand`, `model`, `status` |
| `quotes` | `id`, `quoteNumber` |
| `repairs` | `id`, `bicycleId`, `status` |
| `customer_orders` | `id`, `orderNumber`, `customerId`, `status`, `totalPriceNet` |
| `backorders` | `id`, `customerId`, `totalPriceNet`, `status` |
| `sales` | `id`, `saleNumber`, `sourceType`, `status`, `subtotalNet`, `vatTotal`, `totalGross` |
| `invoices` | `id`, `invoiceNumber`, `saleId`, `customerId`, `status`, `subtotalNet`, `vatTotal`, `totalGross` |
| `payments` | `id`, `method`, `amount` |
| `payment_allocations` | `id`, `paymentId`, `targetType`, `targetId`, `allocatedAmount` |
| `supplier_orders` | `id`, `supplierName`, `status` |
| `stock_movements` | `id`, `partId`, `quantityDelta`, `reason` |
| `notifications` | `id`, `channel`, `message`, `status` |

### Nullable Fields and Their Meaning

| Field | Implies |
|-------|---------|
| `customers.firstName/lastName` | Required when `type='private'` (enforced at app level, not DB) |
| `customers.companyName/vatId` | Required when `type='company'` (app-level enforcement) |
| `bicycles.templateId` | Null when bicycle is customer-owned and no template matches |
| `bicycles.customerId` | Required when `source='customer_owned'`, must be null when `source='inventory'` — **enforced by CHECK** |
| `sales.customerId` | Null = anonymous walk-in sale |
| `quotes.customerId` | Null allowed during draft; required once sent — **enforced by CHECK** |
| `repairLineItems.minutesWorked/hourlyRateSnapshot` | Present only for labor line items (null for parts/bicycles) |
| `workLogs.endedAt` | Null = timer still running |
| `supplierOrderLines.partId` | Null until supplier product is imported into local catalog |

### Enum Values

| Field | Values | Meaning |
|-------|--------|---------|
| `customers.type` | `private`, `company` | Customer classification |
| `users.role` | `mechanic`, `manager` | Staff role |
| `bicycles.source` | `inventory`, `customer_owned` | Ownership type |
| `bicycles.status` | `inventory`, `in_shop`, `ready_for_pickup`, `returned`, `sold` | Physical bicycle state (decoupled from repair status) |
| `laborServices.billingType` | `hourly`, `fixed` | How labor is priced |
| `quotes.status` | `draft`, `sent`, `converted`, `rejected` | Quote lifecycle |
| `repairs.status` | `intake`, `in_progress`, `on_hold`, `ready`, `completed`, `cancelled` | Repair lifecycle |
| `repairs.holdReason` | `waiting_parts`, `awaiting_customer_approval`, `other` | Why repair is paused |
| `customerOrders.status` | `pending`, `ordered`, `ready`, `fulfilled`, `cancelled` | Customer order lifecycle |
| `backorders.status` | `requested`, `ordered`, `arrived`, `completed`, `cancelled` | Backorder lifecycle |
| `sales.sourceType` | `direct_sale`, `repair`, `customer_order`, `backorder` | Where the sale came from |
| `sales.status` | `completed`, `voided` | Sale finality |
| `invoices.status` | `issued`, `sent` | Invoice delivery state |
| `payments.method` | `cash`, `card`, `bank_transfer` | Payment channel |
| `paymentAllocations.targetType` | `sale`, `customer_order`, `backorder`, `repair`, `invoice` | What the payment settles |
| `supplierOrders.status` | `pending`, `ordered`, `received` | Supplier order lifecycle |
| `stockMovements.reason` | `sale`, `void`, `order_receive`, `manual_correction`, `backorder_receive`, `repair_use`, `return`, `waste` | Why stock changed |
| `notifications.channel` | `sms`, `email` | Delivery method |
| `notifications.status` | `pending`, `sent`, `failed` | Notification delivery state |

### Unique Constraints

| Field | Purpose |
|-------|---------|
| `vat_rates.rate` | No duplicate tax rates |
| `parts.barcode` | Each part has one unique barcode (scan-to-find) |
| `quotes.quoteNumber` | Sequential quote numbering |
| `customer_orders.orderNumber` | Sequential order numbering |
| `sales.saleNumber` | Sequential sale/receipt numbering |
| `invoices.invoiceNumber` | Sequential invoice numbering |
| `invoices.saleId` | **One invoice per sale** — prevents duplicate invoicing |
| `supplier_products.eanUpc` | One supplier product per EAN/UPC |

### CHECK Constraints (DB-enforced)

| Constraint | Rule |
|------------|------|
| `bicycles_source_customer_check` | `source='customer_owned'` → `customerId IS NOT NULL`; `source='inventory'` → `customerId IS NULL` |
| `quotes_customer_required_check` | Non-draft quotes must have a customer |
| `repairs_hold_reason_note_check` | If `holdReason` is set, `holdReasonNote` must be provided |
| `line_totals_non_negative` (on all line item tables) | All three totals (`net`, `vat`, `gross`) ≥ 0 |

---

## 4. Confirmed Business Rules

> **Rules confirmed by domain owner on 2026-05-19.** These replace the earlier "inferred" rules.

| # | Rule | Enforcement Level |
|---|------|-------------------|
| R1 | When a repair reaches `completed`, the customer is notified but **no Sale is auto-created**. The cashier manually creates a Sale + optional Invoice at payment time. | Application logic |
| R2 | A Quote, once `sent`, becomes immutable. On approval (`converted`), its line items are copied to either a Repair OR a Customer Order — **never both simultaneously**. | Application logic |
| R3 | An Invoice is an optional legal snapshot of a Sale — not every sale gets one. **One invoice per sale** (DB-enforced unique on `saleId`). | DB + application logic |
| R4 | `depositPaid` on backorders is **derived** from `payment_allocations`, never stored as a column. Query at read time. | Schema design (explicit NOTE) |
| R5 | When a Sale completes, stock movements are created with reason=`sale` for each part line item. | Application logic |
| R6 | Work Logs (timer) track actual time; Repair Line Items track billable minutes — they can differ. Labor lines are **manually created** by mechanic/manager, pre-filled from work log times. | Schema design + application logic |
| R7 | Supplier Orders, when received, create stock movements with reason=`order_receive`. | Application logic |
| R8 | A Customer Order, when fulfilled, creates a Sale with `sourceType='customer_order'`. Can be paid fully upfront via payment allocations. | Application logic |
| R9 | Backorders can receive partial payments (deposits) before the part arrives. On completion, creates a Sale with `sourceType='backorder'`. | Schema design + application logic |
| R10 | Anonymous walk-ins can make direct sales without a customer record (`sales.customerId` is nullable). | Schema design |
| R11 | One payment can split across multiple documents. Over-allocation (`SUM(allocatedAmount) > payment.amount`) prevented at **application level only** — not DB-enforced (SQLite cannot CHECK cross-row sums). | Application logic |
| R12 | `parts.quantityOnHand` is a denormalized convenience column. The source of truth is always `SUM(quantityDelta) FROM stock_movements WHERE partId=X`. Compute from movements, never trust the stored value blindly. | Application logic |
| R13 | Voiding a Sale only marks it as `voided` — no stock reversal, no payment unallocation. Used to fix errors. **Manager-only** (authorization not yet in schema). | Application logic |
| R14 | Notifications are created and sent **manually** for now — not event-driven. | Application logic |

---

## 5. Lifecycle / Status Flows

### Quotes
```
draft → sent → converted (approved) 
              ↘ rejected
```
- **Draft**: customerId can be null. Editable.
- **Sent**: customerId required. Immutable. Awaiting customer decision.
- **Converted/Rejected**: Terminal states. Converted = copied to Repair OR Customer Order (never both).

### Repairs
```
intake → in_progress → on_hold (optional loop) → ready → completed
   ↘ cancelled (from any state)
```
- **on_hold** requires a `holdReason` + `holdReasonNote` (DB-enforced).
- Every transition is recorded in `repair_status_history`.
- When `completed`: customer notified, cashier manually creates Sale at payment time.

### Bicycles (physical instances — decoupled from repair status)
```
inventory → in_shop → ready_for_pickup → returned
   ↘ sold (for inventory bicycles)
```
- **`inventory`**: Shop-owned bicycle available for sale.
- **`in_shop`**: Customer-owned bicycle is at the shop (one or more repairs active).
- **`ready_for_pickup`**: At least one repair is ready; waiting for customer collection.
- **`returned`**: Bicycle returned to owner — all repairs done.
- **`sold`**: Shop inventory bicycle was sold.

A bicycle can have multiple repairs over its lifetime. Its status tracks physical presence, not any single repair's state.

### Customer Orders
```
pending → ordered → ready → fulfilled → [Sale created with sourceType='customer_order']
   ↘ cancelled (from any state)
```
- Can be paid fully upfront via payment allocations to `customer_order`.

### Backorders
```
requested → ordered → arrived → completed → [Sale created with sourceType='backorder']
   ↘ cancelled (from any state)
```
- Deposits tracked via `payment_allocations WHERE targetType='backorder'`.
- On completion: Sale created for the final transaction.

### Sales
```
completed → voided (manager-only, no reversal)
```
- Only two states. Immutable once created (except voiding).
- Void only marks status — no stock or payment reversal.

### Invoices
```
issued → sent
```
- Simple delivery tracking. Once issued, immutable. One per sale (DB-enforced).

### Supplier Orders
```
pending → ordered → received
```
- `quantityReceived` on lines tracks partial receipts (not all-or-nothing).

### Notifications
```
pending → sent / failed
```
- Created manually for now. Status tracks delivery outcome.

---

## 6. Document Flows

### Flow A: Direct Sale (walk-in or known customer)
```
Customer selects parts/bicycles/labor
    ↓
Sale created with sourceType='direct_sale', sourceId=NULL
    ↓
Payment(s) allocated to the sale via payment_allocations
    ↓
(Optional) Invoice issued from the sale — copies line items immutably
    ↓
Stock movements created for part line items (reason='sale')
```

### Flow B: Quote → Repair → Sale
```
Quote created (draft) with line items
    ↓
Quote sent to customer (immutable)
    ↓
Customer approves → quote status='converted'
    ↓
Repair created from quote line items + bicycle intake
    ↓
Work performed (work_logs timer + repair_line_items billing entries, manually added by mechanic/manager)
    ↓
Repair completed → customer notified
    ↓
Cashier creates Sale with sourceType='repair', sourceId=repair.id
    ↓
Payment allocated to sale
    ↓
(Optional) Invoice issued
```

### Flow C: Quote → Customer Order → Sale
```
Quote created with bicycle/part line items
    ↓
Customer approves → converted
    ↓
Customer Order created (parts or bicycles to be sourced) — can be paid upfront
    ↓
Shop sources items → status progresses pending → ordered → ready → fulfilled
    ↓
Sale created with sourceType='customer_order'
    ↓
Payment allocated (if not already paid upfront)
```

### Flow D: Backorder → Sale
```
Customer requests part not in stock
    ↓
Backorder created (status='requested')
    ↓
(Optional) Customer pays deposit via payment_allocations(targetType='backorder')
    ↓
Shop orders from supplier → status='ordered'
    ↓
Part arrives → status='arrived', stock_movement(reason='backorder_receive')
    ↓
Customer picks up, pays balance → status='completed'
    ↓
Sale created with sourceType='backorder', sourceId=backorder.id
```

### Flow E: Supplier Order → Stock
```
Supplier product searched/cached (supplier_products)
    ↓
Supplier order created with lines referencing eanUpc
    ↓
Order placed → status='ordered'
    ↓
Items received → quantityReceived updated per line
    ↓
Part imported into local catalog (partId set on supplier_order_line)
    ↓
Stock movement created (reason='order_receive')
```

---

## 7. Data Ownership & Immutability

### Working Documents (editable until finalized)

| Entity | Editable Until | Then Becomes | Rationale |
|--------|---------------|--------------|-----------|
| **Quote** | `status='draft'` | Immutable at `sent` | Comment: "immutable once sent" |
| **Repair** | `status != completed/cancelled` | Read-only when completed | Line items can be added during work; status history is append-only |
| **Customer Order** | `status != fulfilled/cancelled` | Read-only when fulfilled | totalPriceNet locked at creation (schema says "locked") |
| **Backorder** | `status != completed/cancelled` | Read-only when completed | totalPriceNet locked at creation |

### Final Documents (immutable after creation)

| Entity | Immutability | Rationale |
|--------|-------------|-----------|
| **Sale** | Immutable once created (except voiding by manager) | Comment: "immutable once created. Source of truth for completed commerce." |
| **Invoice** | Fully immutable | Legal/financial snapshot — never changed, only copied from sale |
| **Payment** | Immutable | Financial record — never edited, only allocated |
| **Stock Movement** | Immutable (append-only) | Audit trail — every change is a new row |

### Append-Only Audit Trails

| Entity | Purpose |
|--------|---------|
| `repair_status_history` | Every repair status transition recorded with timestamp |
| `backorder_status_history` | Every backorder status transition recorded |
| `stock_movements` | Every inventory change — reason, quantity delta, reference |
| `work_logs` | Timer sessions — started/ended timestamps for payroll |

---

## 8. Derived Values

### Must NOT be manually edited (computed)

| Value | Source | Where Stored |
|-------|--------|--------------|
| **Line totals** (`lineTotalNet`, `lineTotalVat`, `lineTotalGross`) | `(unitPriceNet × quantity) - discount` → split into net + VAT based on vatRate | Every line item table |
| **Sale totals** (`subtotalNet`, `vatTotal`, `totalGross`) | `SUM(lineTotal*)` from sale_line_items | `sales` header |
| **Invoice totals** | Copied from sale — identical snapshot | `invoices` header |
| **Deposit paid on backorder** | `SUM(allocatedAmount) FROM payment_allocations WHERE targetType='backorder' AND targetId=X` | **NOT stored** — derived at query time (explicit NOTE in schema) |
| **Parts quantityOnHand** | Should equal `SUM(quantityDelta) FROM stock_movements WHERE partId=X`. Always compute from movements. | Stored as denormalized convenience in `parts` |

### Stored Snapshots (intentionally duplicated, not live-referenced)

| Snapshot | Why Stored | Risk if Stale |
|----------|-----------|---------------|
| Line item pricing (`unitPriceNet`, totals) on quote/order/sale/invoice lines | Price at time of transaction — must survive catalog price changes | Low — this is correct behavior (historical accuracy) |
| Bicycle details (`brand`, `model`, `year`, etc.) on bicycle line items | Survives template deletion/edit | Low — snapshot is the point |
| `hourlyRateSnapshot` on repair labor lines | Worker's rate at time of logging — survives rate changes | Low — correct behavior |
| `customerId` on invoices (denormalized from sale) | Lookup convenience without joining through sale | Medium — must stay in sync with source sale |

---

## 9. MVP Implementation Proposal

### Slice 1: Catalog Management + Direct Sale (Core POS)
The absolute minimum to run a register.

| Layer | What's Built |
|-------|-------------|
| **Frontend screens** | Parts list (CRUD), barcode scan/search, sale cart (add parts, see totals with VAT), checkout screen |
| **Backend endpoints** | `GET/POST/PATCH/DELETE /parts`, `GET /labor-services`, `GET /vat-rates`, `POST /sales` (create direct_sale), `POST /payments` + allocations |
| **Service logic** | Line total calculation, sale total aggregation, stock deduction on sale completion |
| **Tables involved** | `parts`, `vat_rates`, `labor_services`, `sales`, `sale_line_items`, `payments`, `payment_allocations`, `stock_movements` |
| **Tests** | Line total math (unit), sale creation with stock deduction (integration), payment allocation to sale (integration) |

### Slice 2: Customer Management + Invoice Generation
Add customer records and optional invoicing.

| Layer | What's Built |
|-------|-------------|
| **Frontend screens** | Customer list, customer form (private/company toggle), sale detail with "Issue Invoice" button, invoice preview |
| **Backend endpoints** | `GET/POST/PATCH /customers`, `POST /invoices` (from sale), `GET /invoices/:id` |
| **Service logic** | Copy line items from sale to invoice; validate company fields for VAT invoices |
| **Tables involved** | `customers`, `invoices`, `invoice_line_items` (+ reuses sales) |
| **Tests** | Invoice creation copies sale lines correctly (integration), customer type validation (unit), one-invoice-per-sale constraint (integration) |

### Slice 3: Repair Intake + Status Tracking
Track bicycle repairs from intake to completion.

| Layer | What's Built |
|-------|-------------|
| **Frontend screens** | Bicycle intake form, repair list with status filter, repair detail (add line items, change status), work log timer start/stop |
| **Backend endpoints** | `POST /bicycles`, `GET/PATCH /repairs/:id`, `PATCH /repairs/:id/status`, `POST /repair-line-items`, `POST /work-logs` (start/stop) |
| **Service logic** | Status transition validation, status history recording, bicycle source/customer check |
| **Tables involved** | `bicycles`, `repairs`, `repair_line_items`, `work_logs`, `repair_status_history`, `users` |
| **Tests** | Status transitions (unit — e.g., can't go intake→completed), hold reason requires note (integration), status history appended on transition (integration) |

### Slice 4: Repair-to-Sale Completion Flow
Close the loop: completed repair → cashier creates sale → payment.

| Layer | What's Built |
|-------|-------------|
| **Frontend screens** | "Create Sale" button on completed repair, review screen showing repair line items as proposed sale lines, confirmation |
| **Backend endpoints** | `POST /sales?sourceType=repair&sourceId=:id` (creates sale from repair), reuses payment/invoice from slices 1-2 |
| **Service logic** | Copy repair_line_items → sale_line_items; create sale header; allocate existing payments or collect new payment |
| **Tables involved** | `sales`, `sale_line_items` (+ repairs, payments) |
| **Tests** | Create sale from repair copies lines correctly (integration), sale totals match sum of line items (unit), stock deducted for part lines (integration) |

### Deferred Beyond MVP

| Feature | Why Deferred |
|---------|--------------|
| Quotes | Requires approval workflow, immutability logic, copy-to-order/repair |
| Customer Orders | Non-instant fulfillment adds complexity; direct sale covers most cases |
| Backorders | Deposit tracking + supplier coordination is complex |
| Supplier Orders | Internal procurement; not customer-facing |
| Notifications | Manual creation only for now — no integration needed yet |

---

## 10. Resolved Decisions Log

> All questions from the initial analysis, resolved by domain owner on 2026-05-19.

### Business Decisions (Resolved)

| # | Question | Decision | Schema Change? |
|---|----------|----------|----------------|
| Q1 | Repair completed → auto-create Sale or manual? | **Manual** — cashier creates Sale at payment time after repair is complete and customer notified | No |
| Q2 | Backorder final transaction recorded how? | Add `'backorder'` to `sales.sourceType` enum | ✅ Yes — applied |
| Q3 | Customer Order paid upfront or on fulfillment? | **Can be fully paid upfront** via payment allocations | No (already supported) |
| Q4 | Who can void a Sale? | **Manager only** — needs authorization layer (not yet in schema) | No (future feature) |
| Q5 | `quantityOnHand` updated synchronously or computed? | **Always compute from movements** — stored value is convenience cache only | No |
| Q6 | Void sale → full reversal or just mark voided? | **Just mark as voided** — no stock/payment reversal. Used to fix errors | No |
| Q7 | Quote converted to repair AND order simultaneously? | **No** — quote converts to Repair OR Customer Order, never both | No |
| Q8 | Bicycle status mirror repair status or independent? | **Independent** — bicycle tracks physical state (`inventory`, `in_shop`, `ready_for_pickup`, `returned`, `sold`). Multiple repairs can exist per bicycle. | ✅ Yes — applied |
| Q9 | Labor lines auto-created from work logs? | **No** — manually created by mechanic/manager, pre-filled with time spent | No |
| Q10 | Notifications event-driven or manual? | **Manual for now** | No |

### Schema-Level Decisions (Resolved)

| # | Question | Decision | Schema Change? |
|---|----------|----------|----------------|
| Q11 | Unique constraint on `invoices.saleId`? | **Yes** — one invoice per sale, DB-enforced | ✅ Yes — applied |
| Q12 | Enforce `SUM(allocatedAmount) ≤ payment.amount` at DB level? | **No** — application-level validation only. SQLite cannot CHECK cross-row sums without triggers | No |
| Q13 | CHECK `totalPriceNet` against line items in DB? | **No** — totalPriceNet is a snapshot locked at creation. Application-level immutability on PATCH. SQLite cannot do cross-table CHECKs | No |
