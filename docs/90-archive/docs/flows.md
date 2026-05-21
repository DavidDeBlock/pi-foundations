# POS Flows — Complete Reference

### 1. In-store sale

- Anonymous sale of an in-stock part: ok
- Anonymous sale of an unknown in-stock part (quick sell): ok
- Named customer sale of an in-stock part: ok
- Named customer sale of an unknown in-stock part (quick sell): ok
- Named customer sale of a part not in stock → **handled by Backorders flow**

### 2. Payments

- Paying with card is default option, amount auto-fills to subtotal — ok
- Paying cash, entering amount given by customer shows change due — ok
- Split payments (e.g., €30 cash + €57 card): **ok — supported via "Add Payment Method" button**
- Bank transfer: **ok — listed as a payment method option**
- Current payment methods: `card` (default), `cash`, `bank_transfer`

### 3. Repair lifecycle

- **Intake**: Create repair with customer info, bicycle details, assigned worker, and customer-reported notes. Customer can be searched by name/phone or created new. Bicycle brand+model required; year+color optional.
- **Status transitions**: `intake → in_progress ↔ on_hold → ready → completed (payment)`
  - `ready → in_progress` ("Back to Work"): customer requests additional work after repair was marked ready
  - `on_hold → in_progress`: resume work (part arrived, customer approved)
- **Put on Hold**: requires selecting a structured reason (`waiting_parts`, `awaiting_customer_approval`, `other`) with optional free-text notes. Timer auto-pauses.
- **Line items** (parts + labor): editable through `ready` status; locked once completed/cancelled
  - Add part: search existing products, set quantity → deducts from inventory on sale completion
  - Add labor: uses work timer (start/stop clock) — elapsed time × worker's hourly rate auto-calculates; mechanic can adjust before confirming
- **Work Timer**: manual start during `in_progress`; auto-pauses on `on_hold` or status change. Shows live HH:MM display. On stop, presents confirmation dialog with calculated labor cost.
- **Internal notes**: editable through `in_progress` and `on_hold`; locked at `ready`, `completed`, `cancelled`
- **Customer notes**: immutable after intake — preserves original complaint
- **Bicycle details**: immutable after intake — wrong bike means cancel & re-intake
- **Dates**: planned date set at intake (editable through `in_progress`/`on_hold`); pickup date set when marked `ready` (editable until completed)
- **Worker assignment**: editable through `in_progress`; locked at `ready`, `completed`, `cancelled`
- **Deposit on repair**: recorded as a regular POS sale with note referencing the repair (#ABC123). Multiple deposits possible. No separate payment ledger.
- **Repair completion**: opens split-payment modal (same as POS), then shows receipt display before closing panel

### 4. Repair cancellation

- Cancellable at every status (`intake`, `in_progress`, `on_hold`, `ready`)
- No automated refund flow — if money was already received, operator handles it manually through the sales list (void the sale)
- Repair record stays in history with `cancelled` status

### 5. Backorders

- **Creation**: select customer → add items (parts from inventory or bicycles as custom entries) → set deposit amount (with % suggestion buttons: 10/25/50/75/100%) → choose payment method for deposit
- **Deposit sale**: created atomically with the backorder. Same mechanism as repair deposits — appears in sales history. Price locks at this point.
- **Status lifecycle**: `requested → ordered → arrived → completed` (cancellable at every stage)
  - `requested → ordered`: set optional expected delivery date
  - `ordered → arrived`: items have been received from supplier
  - `arrived → completed`: customer pays balance, takes possession
- **Balance collection** (`arrived` status): opens split-payment modal for remaining amount. Backorder transitions to `completed`.
- **Cancellation refund rules**:
  - Cancel at `requested`: full deposit refund (deposit sale voided)
  - Cancel at `ordered` or `arrived`: deposit is non-refundable — handle externally if needed
- **Parts vs Bicycles in backorders**: parts link to existing products; bicycles store details directly (`brand`, `model`, `year`, `color`, `frameSize`) and become `bicycle` entities on completion via shared service for future repair history.
- **Internal notes**: editable through `arrived`; locked at `completed`
- **Sales ↔ Backorders**: sales table extended with optional `backorderId` FK (mutually exclusive with existing `repairId`). A backorder has two associated sales: deposit sale and balance sale.

### 6. Orders / Purchasing (supplier ordering)

- **Product search**: DST supplier catalog via barcode scan or keyword search
- **Import vs Order** distinction:
  - **Import**: digitizes existing physical stock into inventory without creating an order. Review modal before confirming.
  - **Order**: creates/updates product record in inventory (at `quantityOnHand: 0`) and adds a line to the purchase basket for purchasing.
- **Basket management**: flat list of purchase lines grouped by supplier. Duplicate `(eanUpc + supplierCode)` pairs merge into single line with summed quantity. +/- buttons adjust quantities before generating JSON.
- **Mark as Ordered**: per-supplier group button. Generates JSON payload (simple array: `[{"ean": "...", "qty": 3}]`) copied to clipboard for manual paste into supplier portal.
- **Receive flow**: lightweight confirmation after parts arrive. Tracks `quantityOrdered` (immutable) and `quantityReceived` (set on receive). Allows discrepancy tracking before updating `quantityOnHand`.
- **Auto-match on receive**: when stock arrives, system auto-marks matching backorders as `arrived` if received quantity ≥ total backorder quantity for that product. Excess goes to general inventory.
- **Order history** (V1): no history view in UI. Received lines archive immediately. DB retains records for safety.

### 7. Sales history

- **List sales**: paginated, date-range filtered display showing date/time, status, customer name, subtotal
- **Expanded details**: shows payment summary (e.g., "Card $45.00 + Cash $15.00"), total paid, item count, line items table with product/price/qty/total
- **Void sale**: available for completed (non-voided) sales. Opens confirmation dialog before voiding. Voided sales remain in history with reduced opacity and `voided` status badge.

### 8. Product management

- **Product list**: browse all products in inventory
- **Product form modal**: create/edit product details
- **DST integration**: barcode scan or keyword search against supplier catalog for importing new products or adding to purchase basket

### 9. Customer management

- **Customer search/type-ahead**: search by name or phone (300ms debounce)
- **Customer list**: browse all customers
- **Customer form modal**: create/edit customer details
- **Auto-fill on intake**: selecting an existing customer during repair intake auto-fills first name, last name, and phone fields

### 10. Repair calendar / scheduling

- **Three view modes**: day, week, month
- **Worker filter**: filter repairs by assigned worker
- **Visual indicators**: color-coded status blocks on calendar days; planned date (scheduled) vs pickup date (collection) shown with different icons
- **Click to open**: clicking a repair block opens the detail drawer

### 11. Dashboard & settings

- **Dashboard**: overview page (home screen)
- **Settings**: system configuration page
- **Todo list**: simple task management feature
