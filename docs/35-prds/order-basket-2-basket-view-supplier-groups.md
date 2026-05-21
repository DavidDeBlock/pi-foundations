# Issue 2: Order Basket View — Supplier Groups + JSON Export

**Labels:** `needs-triage` `feature` `vertical-slice-2`  
**Parent PRD:** [Order Basket](../../.pi/plans/active/order-basket-prd.md)  

## User Story

As a shop owner, I want to see my order basket grouped by supplier with +/- quantity controls so that I can easily prepare separate orders for each supplier and copy JSON payloads directly into supplier ordering systems.

## Acceptance Criteria

- [ ] New `features/orders/` feature module created with basket view component
- [ ] Basket items displayed grouped by `supplierCode` (dynamic grouping, no Supplier entity)
- [ ] +/- buttons per line item to adjust quantity before generating JSON
- [ ] "Copy JSON" button per supplier group — silent clipboard copy with toast notification
- [ ] JSON format: simple array `[{"ean": "8712345678901", "qty": 3}]` per supplier group
- [ ] Top-level "Orders" navigation item added to sidebar for quick daily access
- [ ] `PATCH /api/order-lines/:id` endpoint for quantity adjustment (increment/decrement)
- [ ] Basket view loads pending and ordered lines, visually distinct (ordered items greyed out — placeholder for Slice 3)

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `client/src/features/orders/index.ts` | Create | Feature module exports |
| `client/src/features/orders/store.ts` | Create | Zustand store for basket state, supplier grouping logic |
| `client/src/features/orders/services/order-basket.service.ts` | Create | API calls: fetch lines, adjust quantity, copy JSON |
| `client/src/features/orders/components/OrderBasketView.tsx` | Create | Main basket view with supplier groups, +/- controls, copy JSON |
| `client/src/features/orders/routes.tsx` | Create | Route definition for `/orders` page |
| `server/src/api/order-lines.ts` | Modify | Add PATCH endpoint for quantity adjustment |

## Dependencies

- **Blocked by:** Issue 1 (requires `order_lines` table, types, and GET/POST endpoints)

## Testing Strategy

- **API integration tests:** Quantity increment/decrement; boundary checks (quantity ≥ 1)
- **Component tests:** Supplier grouping logic; JSON payload format correctness per group
