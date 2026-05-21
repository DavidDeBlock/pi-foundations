# Plan: Quotes & Invoices Feature

## Scope
1. **Database Schema**: Add invoice columns to `sales`, business fields to `customers`, new `quotes` and `quoteLineItems` tables.
2. **Quote Management UI**: Create/Edit/Delete quotes (draft state), mark as sent, convert to Repair/Sale/Backorder.
3. **Invoice Generation**: Manual "Generate Invoice" button on completed sales → PDF output.
4. **Customer Form Update**: Add optional business fields (`companyName`, `address`, `vatId`).

## Implementation Phases

### Phase 1: Database Schema (Drizzle)
- [ ] Migration 0012: Add `invoiceNumber` and `invoiceGeneratedAt` to `sales`.
- [ ] Migration 0013: Add `companyName`, `address`, `vatId` to `customers`.
- [ ] Migration 0014: Create `quotes` table (`id`, `quoteNumber`, `status`, `customerId`, `notes`).
- [ ] Migration 0015: Create `quoteLineItems` table (`id`, `quoteId`, `type`, `snapshotPrice`, `productId` (nullable), `description` (for labor), `bicycleDetails` (JSON)).

### Phase 2: Quote Backend & API
- [ ] Service layer for quotes: CRUD, status transitions (`draft` → `sent` → `converted`).
- [ ] Conversion logic: Copy quote data to target entity (Repair/Sale/Backorder) with snapshot prices.
- [ ] Numbering service: Yearly reset sequence for `QT-YYYY-NNN`.

### Phase 3: Quote UI
- [ ] List view: Filter by status (`draft`, `sent`, `converted`).
- [ ] Edit form: Add/remove line items (parts, labor, bicycles), apply discounts.
- [ ] Conversion modal: Select target type → confirm copy → lock quote as `converted`.

### Phase 4: Invoice Generation
- [ ] PDF generator service: Render sale data + business customer info into official invoice format.
- [ ] UI trigger: "Generate Invoice" button on completed sales (if not already generated).
- [ ] Display: Show invoice number and download link in sales history.

### Phase 5: Customer Form Update
- [ ] Add optional fields to existing customer creation/edit form.
- [ ] Conditional logic: If business fields are filled, enable invoice generation for that customer's sales.

## Key Constraints (from ADR)
- Invoices are **optional** and **manual**.
- Quotes are **immutable** once sent; conversion is **all-or-nothing**.
- Prices on quotes are **snapshotted** at creation.
- No inventory impact from quotes.

---

## Tax Strategy (Draft)

### Storage Model
All line item tables (`sale_items`, `repairItems`, `quoteLineItems`) store three fields:
1.  **`unitPriceNet`**: Base price excluding tax (integer, cents).
2.  **`vatRate`**: Tax rate as an integer percentage * 100 (e.g., `2100` for 21%).
3.  **`lineTotalGross`**: Final price including tax (`unitPriceNet × (1 + vatRate)`).

### Configuration
- A new **`vatRates`** table stores active rates (`id`, `rate`, `description`).
- Rates are not versioned; historical invoices remain accurate because the rate is stamped on each line item.

### Belgian "Combined Service" Rule (6% vs 21%)
- **Trigger:** When a repair is marked as `completed`.
- **Logic:** If `Sum(Labor) > Sum(Parts)` for that repair, update all part lines' `vatRate` from `2100` to `600`.
- **Preview:** A read-only tax breakdown is shown on the "Ready" screen (UI only), but the actual DB write happens at completion.

### Backorders & Quotes
- Tax rates are **locked** at creation time. No dynamic updates if government rates change later.
- Edge cases requiring manual intervention will be handled outside the system.

### Future Reporting
- A dedicated `tax-report.ts` service will calculate totals by rate for any date range (deferred to V2).
