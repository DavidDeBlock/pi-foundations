# PRD: Quotes & Invoices (Excluding PDF Generation)

## Problem Statement

The shop needs official B2B invoices for completed sales and insurance/B2B quotes that can be sent to customers before work begins. Currently, there is no way to produce formal estimates or attach invoice documents to sales. Additionally, customer records lack business fields (company name, address, VAT ID) needed for invoicing.

## Solution

Add a **quotes** entity with full lifecycle management (`draft` → `sent` → `converted` / `rejected`), snapshotted pricing, and single-conversion to Repair/Sale/Backorder. Add optional invoice columns to the existing `sales` table so invoices are generated on-demand from completed sales. Extend customer records with business fields. Add discount support across all line-item tables (quotes, sales, repairs, backorders).

**PDF generation is out of scope for this PRD** — covered separately by ADR 0002 and a dedicated PDF implementation session.

## User Stories

### Quote Management

1. As a shop operator, I want to create a quote without selecting a customer (anonymous draft), so that I can quickly produce estimates for walk-in inquiries.
2. As a shop operator, I want to add line items of three types — parts, labor, and bicycles — with snapshotted prices, so that the estimate reflects current pricing regardless of future product changes.
3. As a shop operator, I want to apply discounts at both the line-item level (`discountPercent`) and quote-total level (`totalDiscountPercent` / `totalDiscountAmount`), so that I can offer flexible pricing on estimates.
4. As a shop operator, I want to edit quotes freely while they are in `draft` state (add/remove lines, change customer, adjust discounts), so that I can refine the estimate before sending it.
5. As a shop operator, I want to mark a draft quote as `sent`, after which it becomes immutable and receives its official number (`QT-YYYY-NNN`), so that the customer has a fixed reference document.
6. As a shop operator, I want to delete quotes while they are still in `draft` state, so that abandoned estimates don't clutter the system.
7. As a shop operator, I want to convert a sent quote exactly once into a Repair, Sale, or Backorder, copying all line items with snapshotted prices and discounts, so that approved estimates become real work orders without re-entry.
8. As a shop operator, I want conversion to be blocked if the quote has no customer linked, forcing me to assign one first, so that every converted entity has an accountable owner.
9. As a shop operator, I want to see subtle inline warnings (⚠️ icon) on line items with low/zero stock when converting a quote, so that I'm nudged to check availability without being blocked.
10. As a shop operator, I want to mark a sent quote as `rejected` if the customer declines or goes elsewhere, so that the quote list doesn't fill with dead ends and conversion-rate stats are accurate.

### Invoice Generation (Non-PDF)

11. As a shop operator, I want to generate an invoice number (`INV-YYYY-NNN`) on completed sales when requested, so that B2B customers receive official documentation.
12. As a shop operator, I want to regenerate an invoice with the same number if customer details (name, address, company name) were wrong, overwriting the previous version without changing financial data, so that corrections don't create duplicate invoice numbers.

### Customer Business Fields

13. As a shop operator, I want to add optional business fields (`companyName`, `address`, `vatId`) to existing customers, so that B2B invoices can include proper billing information.
14. As a shop operator, I want these fields to be optional on customer creation/edit, so that regular (non-business) customers aren't affected.

### Discount Support Across Entities

15. As a shop operator, I want discounts applied on quotes to copy to the target entity's line items upon conversion, so that pricing is consistent from estimate through completion.
16. As a shop operator, I want all existing line-item tables (`sale_items`, `repair_items`, `backorder_part_lines`, `backorder_bicycle_lines`) to support `discountPercent`, so that discounts are available across the system, not just on quotes.

## Implementation Decisions

### Database Schema (Drizzle Migrations)

| Migration | Change |
|-----------|--------|
| 0012 | Add `invoiceNumber` (text, nullable), `invoiceGeneratedAt` (integer, nullable), `subtotalNet` (integer, cents), `vatTotal` (integer, cents) to `sales`. Keep existing `subtotal` as gross for backward compatibility |
| 0013 | Add `companyName` (text, nullable), `address` (text, nullable), `vatId` (text, nullable) to `customers` |
| **0014** | Create `vatRates` table: `id`, `rate` (integer, basis points e.g. 2100/600), `description` (text). Seed with Belgian rates: 21% standard, 6% reduced |
| 0015 | Create `quotes` table: `id`, `quoteNumber` (text), `status` (`draft` \| `sent` \| `converted` \| `rejected`), `customerId` (text, nullable during draft), `notes` (text, nullable), `totalDiscountPercent` (integer, nullable, basis points), `totalDiscountAmount` (integer, nullable, cents), `createdAt`, `updatedAt` |
| 0016 | Create `quoteLineItems` table: `id`, `quoteId` (FK → quotes), `type` (`part` \| `labor` \| `bicycle`), `unitPriceNet` (integer, cents — snapshotted net price), `vatRate` (integer, basis points e.g. 2100/600), `lineTotalGross` (integer, cents — final incl. tax), `productName` (text, nullable — snapshotted at creation), `productId` (text, nullable FK → products), `description` (text, nullable — for labor lines), `quantity` (integer, default 1), `discountPercent` (integer, nullable, basis points), `bicycleDetails` (JSON, nullable — for bicycle lines) |
| **0017** | Add `unitPriceNet` (integer, cents), `vatRate` (integer, basis points), `lineTotalGross` (integer, cents), `quantity` (integer, default 1), `discountPercent` (integer, nullable, basis points) to `sale_items`. Keep existing `price`, `line_total` for backward compatibility |
| **0018** | Add `unitPriceNet` (integer, cents), `vatRate` (integer, basis points), `lineTotalGross` (integer, cents), `quantity` (integer, default 1), `discountPercent` (integer, nullable, basis points) to `repair_items`. Keep existing `unit_price`, `line_total` for backward compatibility |
| **0019** | Add `unitPriceNet` (integer, cents), `vatRate` (integer, basis points), `lineTotalGross` (integer, cents), `discountPercent` (integer, nullable, basis points) to `backorder_part_lines`. Keep existing `unit_price`, `line_total` for backward compatibility (`quantity` already exists) |
| **0020** | Add `unitPriceNet` (integer, cents), `vatRate` (integer, basis points), `lineTotalGross` (integer, cents), `quantity` (integer, default 1), `discountPercent` (integer, nullable, basis points) to `backorder_bicycle_lines`. Keep existing `unit_price`, `line_total` for backward compatibility |

### Quote Numbering

- Format: `QT-YYYY-NNN`, yearly reset sequence
- Assigned at creation time (permanent — gaps from deleted drafts are acceptable)
- Shared numbering service with invoice numbering (`INV-YYYY-NNN`) or separate? → **Separate sequences** to keep concerns isolated. Both use same pattern logic but independent counters.

### Quote Service Layer

- CRUD operations: `createQuote`, `updateQuote` (draft only), `deleteQuote` (draft only)
- Status transitions: `markSent(quoteId)`, `rejectQuote(quoteId)`
- Conversion: `convertQuote(quoteId, targetType: 'repair' | 'sale' | 'backorder')` — copies all line items with snapshotted prices and discounts to target entity. Sets quote status to `converted`. Idempotent guard prevents double-conversion.

### Discount Model

- **Storage:** `discountPercent` as integer basis points (e.g., `1000` = 10%). Nullable — null means no discount.
- **Application order:** Line-level discount applied first, then quote-total discount on the remaining balance. VAT recalculated proportionally after discounts.
- **On conversion:** Discounts copy verbatim to target entity's line items and header (if applicable).

### VAT Model

- **Storage per line item:**
  - `unitPriceNet` — base price excluding tax (integer, cents)
  - `vatRate` — basis points (`2100` = 21% standard, `600` = 6% reduced)
  - `lineTotalGross` — final price including tax (`unitPriceNet × (1 + vatRate / 10000)`) calculated and stored
- **`vatRates` table:** Lookup table seeded with Belgian rates. Not versioned; historical accuracy maintained because rate is stamped on each line item.
- **Belgian Combined Service Rule:** Evaluated at invoice generation time (PDF session), not at quote creation. If `Sum(Labor) > Sum(Parts)` on a repair, all part lines switch from 21% to 6%. This is applied by the caller, not stored as logic in quotes.
- **Additive columns:** New VAT/discount/quantity columns added alongside existing price columns. No renames — old columns (`price`, `unit_price`, `line_total`) remain for backward compatibility until a follow-up session migrates all layers.
- **Entity-level totals:**
  - `sales` stores `subtotalNet` + `vatTotal` (computed at sale completion, used for invoices)
  - `repairs` and `backorders` compute totals on-the-fly from line items (no stored VAT fields needed)

### Conversion Logic by Target Type

| Target | What Gets Created | Quote Lines Map To |
|--------|-------------------|---------------------|
| Repair | New `repair` + `repair_items` | Parts → repair part lines, Labor → repair labor lines. Bicycles: use existing bicycle or create new one linked to repair's bicycle record |
| Sale | New `sale` + `sale_items` | All quote lines copied as sale items with snapshotted prices |
| Backorder | New `backorder` + part/bicycle lines | Parts → `backorder_part_lines`, Bicycles → `backorder_bicycle_lines` |

### API Endpoints (New)

- `POST /api/quotes` — Create quote (draft, anonymous allowed)
- `GET /api/quotes?status=draft|sent|converted|rejected` — List quotes with filter
- `GET /api/quotes/:id` — Get single quote with line items
- `PATCH /api/quotes/:id` — Update draft quote (lines, customer, discounts)
- `DELETE /api/quotes/:id` — Delete draft-only quote
- `POST /api/quotes/:id/send` — Mark as sent (immutable lock)
- `POST /api/quotes/:id/reject` — Mark as rejected
- `POST /api/quotes/:id/convert` — Convert to Repair/Sale/Backorder (`{ targetType }`)
- `PATCH /api/sales/:id/invoice` — Generate invoice number on completed sale (non-PDF)

### API Endpoints (Modified)

- Customer create/edit endpoints: accept optional `companyName`, `address`, `vatId`
- Sales list endpoint: include `invoiceNumber` and `invoiceGeneratedAt` in response

### UI Components (New)

- **Quote List View** — Table with filters by status, search by quote number/customer
- **Quote Editor** — Form for creating/editing draft quotes: line item add/remove (parts/labor/bicycles), discount fields, customer selector
- **Conversion Modal** — Select target type → preview stock warnings → confirm conversion
- **Customer Business Fields** — Optional section on customer create/edit form

### UI Components (Modified)

- Sales detail view: show invoice number if generated, "Generate Invoice" button for completed sales

## Testing Decisions

- Test quote creation as anonymous draft → verify `customerId` is null and `quoteNumber` assigned
- Test conversion blocked without customer → verify error response when converting anonymous sent quote
- Test immutability after `sent` → verify PATCH/DELETE rejected on sent quotes
- Test single-conversion guard → verify second conversion attempt fails with clear error
- Test discount copying on conversion → verify line-level and total discounts transfer to target entity
- Test stock warning at conversion → verify inline ⚠️ indicator shown when product quantity is low/zero
- Test invoice regeneration → verify same `invoiceNumber` reused, only customer fields updated, financial data unchanged
- Test `rejected` state transition → verify only reachable from `sent`, not from `draft` or `converted`

## Out of Scope

- **PDF generation** — covered by ADR 0002 and a separate implementation session (Playwright + Mustache templates)
- **Quote PDFs** — manual generation via `/documents/generate` endpoint deferred to PDF session
- **Tax/VAT calculation logic** — Belgian Combined Service Rule evaluation is upstream of this PRD; quotes store snapshotted prices, VAT rates are applied at invoice generation time (PDF session)
- **Email/SMS delivery of quotes or invoices** — placeholder notification system only
- **Document storage cleanup** — `./data/documents/` accumulation management deferred to V2
- **Quote expiration dates** — not tracked in V1
- **Partial quote conversion** — all-or-nothing; operator creates new quote if partial needed

## Further Notes

This PRD covers the data model, API layer, and UI for quotes and invoices. PDF rendering is intentionally excluded — it has its own ADR (0002) and will be implemented as a separate session with template design and Playwright integration.

**Additive schema only:** New VAT/discount/quantity columns are added alongside existing price columns (`price`, `unit_price`, `line_total`). Existing code continues to work unchanged. A follow-up session will migrate all layers to use the new columns and drop the old ones.

**Discount defaults:** New `discountPercent` columns are nullable — null means no discount (safe default for existing data).
