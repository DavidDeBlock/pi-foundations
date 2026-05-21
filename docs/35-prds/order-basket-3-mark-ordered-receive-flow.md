# Issue 3: Mark as Ordered + Receive Flow with Stock Update

**Labels:** `needs-triage` `feature` `vertical-slice-3`  
**Parent PRD:** [Order Basket](../../.pi/plans/active/order-basket-prd.md)  

## User Story

As a shop owner, I want to mark supplier groups as ordered and receive parts with editable quantities so that stock levels update automatically and received lines are archived from my active basket.

## Acceptance Criteria

- [ ] "Mark as Ordered" button per supplier group — transitions all pending lines for that supplier to `ordered` status
- [ ] Ordered items visually distinct in basket (greyed out) but still visible until received
- [ ] Receive flow: modal/dialog with editable quantity field per line item (allows discrepancy tracking vs ordered amount)
- [ ] On receive: `quantityReceived` set from user input; `quantityOrdered` remains immutable for comparison
- [ ] Stock level auto-updates: `products.quantityOnHand += quantityReceived`
- [ ] Received lines archived immediately — removed from active basket view (DB retains records, no V1 history UI)
- [ ] Status lifecycle enforced: `pending` → `ordered` → `received` (no skipping states)
- [ ] `PATCH /api/order-lines/mark-ordered?supplierCode=XXX` marks all pending lines for supplier as ordered
- [ ] `PATCH /api/order-lines/receive/:id` receives specific line with adjusted quantity, updates stock, archives line

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `server/src/db/schema.ts` | Modify | Add `quantityReceived`, `orderedAt`, `receivedAt` columns to `order_lines` |
| `drizzle/migrations/` | Create | Migration for new columns on `order_lines` |
| `shared/types/order.ts` | Modify | Add receive-related types: `ReceiveLineRequest` |
| `shared/validations/order.ts` | Modify | Add Zod schema for receive endpoint validation |
| `server/src/services/order-basket-service.ts` | Modify | Mark-as-ordered (per supplier group); receive flow with stock update; archive received lines |
| `server/src/api/order-lines.ts` | Modify | Add mark-ordered and receive endpoints |
| `client/src/features/orders/components/ReceiveModal.tsx` | Create | Modal for receiving parts with editable quantity field |
| `client/src/features/orders/components/OrderBasketView.tsx` | Modify | Mark as Ordered button per group; visual distinction for ordered items; remove received lines from view |

## Dependencies

- **Blocked by:** Issue 2 (requires basket view, supplier grouping, and order-lines API foundation)

## Testing Strategy

- **Service unit tests:** Lifecycle state transitions (`pending` → `ordered` → `received`); stock level updates during receive flow; quantity discrepancy tracking
- **API integration tests:** Mark-as-ordered for supplier group; receive with adjusted quantity; received lines excluded from active basket query
