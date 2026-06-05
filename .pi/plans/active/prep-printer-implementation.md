
````md
# Receipt & Printing Preparation Plan — Phase 1

## Goal

Prepare the POS system for future receipt printing without implementing real ticket printer support yet.

For now, the system should only generate and display receipt-style views after sales, repairs, and backorder payments. Actual printing can be added later.

The main goal is to structure the code in a way that future browser printing, QZ Tray, or ESC/POS ticket printer support can be added without rewriting the sales or repair flows.

---

## Phase 1 Scope

### Included in this phase

- Create receipt data models/types.
- Create receipt preview screens or components.
- Show receipt after completed payments.
- Keep receipt generation separate from UI.
- Prepare a simple printing abstraction.
- Add basic print-related settings, but do not implement real printing yet.

### Not included in this phase

- No QZ Tray integration yet.
- No ESC/POS commands yet.
- No silent printing.
- No direct USB printer support.
- No cash drawer support.
- No barcode/QR printing yet.

---

## 1. Receipt Data Structure

Create a shared receipt data type that can be reused for different workflows.

Example:

```ts
export type ReceiptData = {
  id: string;
  type: "sale" | "repair" | "backorder_deposit" | "backorder_balance";

  documentNumber?: string;

  shop: {
    name: string;
    address?: string;
    phone?: string;
    email?: string;
    vatNumber?: string;
  };

  customer?: {
    name?: string;
    phone?: string;
  };

  createdAt: string;

  lines: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;

  payments: Array<{
    method: "card" | "cash" | "bank_transfer";
    amount: number;
  }>;

  subtotal: number;
  total: number;
  paid: number;
  changeDue?: number;

  footerText?: string;
};
````

The receipt should be generated from existing sales, repairs, and backorders.
The UI should not manually build receipt data.

---

## 2. Receipt Service

Create a central receipt service.

Example:

```ts
ReceiptService.createSaleReceipt(saleId)
ReceiptService.createRepairReceipt(repairId)
ReceiptService.createBackorderDepositReceipt(backorderId)
ReceiptService.createBackorderBalanceReceipt(backorderId)
```

The service is responsible for:

* loading the correct data
* formatting line items
* adding shop information
* adding payment information
* calculating totals
* returning a clean `ReceiptData` object

This keeps receipt logic out of React components.

---

## 3. Receipt Preview Component

Create a reusable receipt preview component.

Example:

```tsx
<ReceiptPreview receipt={receipt} />
```

The component should display:

* shop name
* shop address/contact info
* date/time
* customer name if available
* receipt/document number
* line items
* subtotal
* total
* payment summary
* change due if cash payment was used
* footer text

Keep the design simple and receipt-like.

Target width:

```txt
80mm receipt style
```

But it can still be displayed nicely inside the app.

---

## 4. Where Receipt Preview Appears

Show the receipt preview after successful completion of these flows:

### In-store sale

```txt
Complete payment
→ Sale saved
→ Show receipt preview
```

### Repair completion

```txt
Complete repair payment
→ Repair marked completed
→ Show receipt preview
```

### Backorder deposit

```txt
Create backorder
→ Deposit sale saved
→ Show receipt preview
```

### Backorder balance payment

```txt
Customer pays remaining balance
→ Backorder marked completed
→ Show receipt preview
```

---

## 5. Print Button Placeholder

Add a print button, but keep the behavior simple.

For now:

```ts
window.print();
```

Or even:

```txt
Print button visible but marked as basic/browser print
```

This is enough for Phase 1.

The important part is that the app already has a dedicated receipt screen/component.

---

## 6. Print Abstraction

Create a small printer abstraction now, even if only one basic implementation exists.

Example:

```ts
export interface ReceiptPrinter {
  print(receipt: ReceiptData): Promise<void>;
}
```

Initial implementation:

```ts
export class BrowserReceiptPrinter implements ReceiptPrinter {
  async print(receipt: ReceiptData): Promise<void> {
    window.print();
  }
}
```

This allows future printer support without changing sales, repairs, or backorders.

The app should call:

```ts
ReceiptPrinterService.print(receipt);
```

Not:

```ts
window.print();
```

directly inside random components.

---

## 7. Settings Preparation

Add basic receipt/printing settings to the settings system.

Example:

```json
{
  "receipt": {
    "width": "80mm",
    "showShopAddress": true,
    "showVatNumber": true,
    "showPaymentSummary": true,
    "footerText": "Thank you for your purchase!"
  },
  "printing": {
    "mode": "browser_print",
    "autoPrint": false
  }
}
```

Do not add advanced printer settings yet.

Keep it simple.

---

## 8. Suggested File Structure

Example frontend structure:

```txt
src/
  features/
    receipts/
      receipt.types.ts
      receipt.service.ts
      receipt-printer.service.ts
      receipt-settings.ts
      components/
        ReceiptPreview.tsx
        ReceiptActions.tsx
```

If receipt generation happens on the backend:

```txt
server/
  modules/
    receipts/
      receipt.types.ts
      receipt.service.ts
      receipt.routes.ts
```

Recommended API endpoints:

```txt
GET /receipts/sale/:saleId
GET /receipts/repair/:repairId
GET /receipts/backorder/:backorderId/deposit
GET /receipts/backorder/:backorderId/balance
```

---

# Later Phase — QZ Tray Overview

QZ Tray can be added later if the POS needs more direct ticket printer support from the browser.

## Why QZ Tray?

QZ Tray acts as a local print bridge between the web app and local printers.

Future flow:

```txt
React POS app
→ QZ Tray JavaScript API
→ Local QZ Tray app
→ USB or network ticket printer
```

## What QZ Tray could support later

* More direct printing from the browser
* Raw ESC/POS printing
* USB ticket printers
* Network ticket printers
* Fewer browser print dialogs
* More POS-like receipt printing

## Future QZ Tray settings

Later, the printing settings could be expanded:

```json
{
  "printing": {
    "mode": "qz_tray",
    "printerName": "EPSON TM-T20",
    "receiptWidth": "80mm",
    "autoPrint": true,
    "cutPaper": true,
    "openCashDrawer": false
  }
}
```

## Future adapter

Add a new printer implementation:

```ts
export class QzTrayReceiptPrinter implements ReceiptPrinter {
  async print(receipt: ReceiptData): Promise<void> {
    // Convert ReceiptData to printable text or ESC/POS commands
    // Send it to QZ Tray
  }
}
```

The rest of the POS should not care whether printing uses:

```txt
browser_print
qz_tray
escpos_network
```

Only the printer adapter changes.

---

# Important Rule

Do not mix receipt generation with payment logic.

Payment flow should only complete the sale, repair, or backorder.

After that, receipt generation should happen separately:

```txt
Payment completed
→ Record saved
→ Receipt generated
→ Receipt preview shown
→ Optional print action
```

This keeps the POS clean and makes real ticket printer support easier to add later.

```
