# Issue 1: Add Product from DST Search to Order Basket

**Labels:** `needs-triage` `feature` `vertical-slice-1`  
**Parent PRD:** [Order Basket](../../.pi/plans/active/order-basket-prd.md)  

## User Story

As a shop owner, I want to add products directly to my order basket from DST search results so that I can quickly build orders without manual data entry. Products added should also exist in local inventory at `quantityOnHand: 0` so they're findable for customer repairs even before physical arrival.

## Acceptance Criteria

- [ ] New `order_lines` table created with fields: `id`, `eanUpc`, `supplierCode`, `supplierName`, `quantityOrdered`, `status` (`pending`/`ordered`/`received`), timestamps
- [ ] Shared types added in `shared/types/order.ts`: `OrderLine`, `AddToBasketRequest`
- [ ] Zod validation schemas in `shared/validations/order.ts` for basket operations
- [ ] `order-basket-service.ts` implements add-to-basket with merge logic: duplicate `(eanUpc + supplierCode)` pairs merge into single line with summed quantity
- [ ] Adding to basket ensures product exists locally (creates at `quantityOnHand: 0` if new, no-op if existing)
- [ ] `POST /api/order-lines/add` endpoint accepts DST product data and returns created/merged order line
- [ ] `GET /api/order-lines?status=pending|ordered` retrieves basket lines filtered by status
- [ ] "Order" button added to DST search results in Product Finder (alongside existing "Import") — clicking increments quantity by 1 or adds +1 if already pending
- [ ] Service tests cover: merge logic, lifecycle transitions, product creation side-effect

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `server/src/db/schema.ts` | Modify | Add `orderLines` table definition with Drizzle schema |
| `drizzle/migrations/` | Create | Migration for new `order_lines` table |
| `shared/types/order.ts` | Create | `OrderLine`, `AddToBasketRequest` type definitions |
| `shared/validations/order.ts` | Create | Zod schemas for basket API validation |
| `shared/index.ts` | Modify | Export order types and validations |
| `server/src/services/order-basket-service.ts` | Create | Core basket logic: add line with merge rules, product creation side-effect |
| `server/src/api/order-lines.ts` | Create | REST endpoints: POST add, GET list by status |
| `server/src/app.ts` | Modify | Register `/api/order-lines` route |
| `client/src/features/product-finder/` | Modify | Add "Order" button to DST search results (next to existing "Import") |

## Dependencies

- None — first slice, establishes the foundation

## Testing Strategy

- **Service unit tests:** Merge logic with duplicate EAN+supplier combinations; product creation when new EAN; no-op when product already exists
- **API integration tests:** POST add-to-basket creates line; GET filters by status; merge behavior verified end-to-end
