# Cozy Ledger — Personal & household budget notebook

A small, warm, friendly budget-tracking web app for tracking private and shared household finances **manually** (no bank integrations). Inspired by the soft, handcrafted feel of WAKOSTA?! and built to feel like a personal finance notebook rather than a cold banking dashboard.

## What's in v1 (Phase 1)

- **Transactions** — full CRUD with type, amount, date, description, category, user, source, private/shared scope, notes.
- **Categories** — CRUD with type (income / expense), color, icon, active flag.
- **Sources / wallets** — CRUD with type (bank / cash / savings / other), owner, active flag.
- **Users** — CRUD with display color and active flag.
- **Dashboard** — monthly summary cards (income, expenses, balance, shared vs private), 6-month bar chart, top categories, donut, recent transactions.
- **Transactions list** — readable table (desktop) / cards (mobile) with filters for month, type, category, user, source, scope.
- **Add transaction** — fast modal flow with all fields, validation, instant feedback.
- **Filters** — month picker, reset button, and full filter bar on the transactions page.
- **Responsive** — sidebar collapses to a slide-in drawer on mobile, table becomes cards, floating "+" button.
- **CSV import (ING Belgium)** — pick a statement file, preview parsed rows with auto-classified type & category, edit categories inline, dedupes against already-imported transactions, batch-imports with one click. Imported rows get an `importedKey` marker so re-imports skip duplicates.
- **Persistent** — all data lives in `localStorage` (no backend needed).

## Visual style

- Warm off-white / cream background, subtle paper texture.
- Deep green, sage, wood tones, beige, charcoal, muted blue-gray, soft accent palette.
- Rounded cards, soft shadows, friendly typography (Fraunces serif for headings, DM Sans for body).
- Subtle decorative SVGs (leaves, coins, receipts, house, dots) anchored behind the content.

## Project layout

```
cozy-ledger/
├── index.html      Entry point. Loads the 5 scripts below.
├── styles.css      Design system, layout, components, responsive rules.
├── data.js         Store: localStorage persistence + seed data + CRUD.
├── utils.js        Formatters (money/date), DOM helpers ($, el, toast).
├── icons.js        Inline SVG icon set + decorative illustrations.
├── csv.js          ING Belgium CSV import — pure parser, classifier, dedup.
├── app.js          Router, screens, modals — the main app logic.
├── _test_csv.js    Node test for csv.js (21 assertions, no jsdom).
├── _test_boot.js   Boot smoke test: loads all scripts, runs import flow.
├── package.json    Marks this subdir as CommonJS so the Node tests run.
└── statements/     Real ING Belgium bank statements used as fixtures.
```

No build step. No dependencies. Open `index.html` in a browser or serve the folder with any static server.

## Run it

```bash
cd cozy-ledger
python3 -m http.server 8001
# then open http://localhost:8001/
```

(Or just open `index.html` directly with `file://` — works because there are no fetch calls.)

## Test it (optional, dev only)

The Node test suite covers the CSV import pipeline (parsing, classification, dedup, mapping) plus a stubbed-DOM boot smoke test that walks the full import flow against the real statement files. No jsdom required.

```bash
cd cozy-ledger
node _test_csv.js   # 21 assertions: parser + classifier + dedup + mapper
node _test_boot.js  # 9 assertions: globals exposed, App.init, end-to-end import
```

Tests are not required to run the app — they're a development aid.

## Extending the app

- **New screen**: add a `render*` function in `app.js`, a new `navItem(...)` in the sidebar, and a new entry in the `titles` map in `renderView()`.
- **New field on a transaction**: add it to the seed in `data.js`, the modal form in `openTransactionModal`, the table row in `renderTxnRow`, and the `addTransaction` defaults.
- **Recurring transactions (Phase 2)**: add a `recurrence` object to the transaction model (`{freq, until, anchor}`) and a scheduler that materialises upcoming transactions on load.
- **Budgets per category (Phase 2)**: add a `budgets` collection keyed by `(categoryId, month)`, show a progress bar next to each category in the dashboard.
- **CSV import / export (Phase 2)**: add `Export.toCSV()` and `Import.fromCSV(file)` helpers in `data.js`; wire to a button in the transactions page header.
- **Split shared expenses (Phase 2)**: add a `splits` array on transactions (e.g. `[{userId, share}]`) and aggregate per-user "owes" on the dashboard.
- **Replacing localStorage with a real backend**: swap the `Store` methods to call `fetch` instead of writing to `localStorage`. The rest of the app is already event-driven via `store:changed`.

## Design tokens

The design system lives in `:root` in `styles.css`. The full palette, shadows and radii are defined there — adjust a single value to retheme the whole app.

## Data model

```ts
Transaction {
  id, type: 'income' | 'expense', amount, date, description,
  categoryId, paidByUserId, sourceId,
  scope: 'private' | 'shared', notes,
  createdAt, updatedAt
}
Category   { id, name, type: 'income' | 'expense', color, icon, active }
Source     { id, name, type: 'bank' | 'cash' | 'savings' | 'other', ownerId, active }
User       { id, name, color, active }
```

`ownerId` on a source is optional — a `null` value means the source is shared (e.g. the joint account, cash, savings).

## CSV import — ING Belgium statement format

The `statements/` folder holds raw bank exports used as the source for importing historical transactions. The current format is **Belgian ING bank statements** with these properties:

- **Encoding**: UTF-8 with BOM (`EF BB BF`).
- **Delimiter**: semicolon (`;`) — fields are **not** quoted, even when they contain commas.
- **Decimal separator**: comma (e.g. `-4,80`).
- **Date format**: `DD/MM/YYYY`.

### Columns

| # | Header (NL) | Meaning | Notes |
|---|---|---|---|
| 1 | `Rekeningnummer` | Own IBAN | Same value across all rows |
| 2 | `Naam van de rekening` | Account holder name | |
| 3 | `Rekening tegenpartij` | Counterparty IBAN | Empty for card payments |
| 4 | `Omzetnummer` | Sequence number | Restarts at `1` each statement period |
| 5 | `Boekingsdatum` | Booking date | `DD/MM/YYYY` |
| 6 | `Valutadatum` | Value date | `DD/MM/YYYY`, may differ from booking date |
| 7 | `Bedrag` | Amount | Comma decimal; negative = debit / expense |
| 8 | `Munteenheid` | Currency | Always `EUR` in current exports |
| 9 | `Omschrijving` | Short description | One line, drives type detection |
| 10 | `Detail van de omzet` | Detail | Often includes merchant + city |
| 11 | `Bericht` | Free-form message | Often empty; can be very long |

### Transaction shapes

The `Omschrijving` field reliably identifies the transaction type, which makes a rule-based auto-categoriser possible:

| Pattern in `Omschrijving` | Type | Direction |
|---|---|---|
| `Betaling Bancontact …` | Expense | Debit-card payment (merchant + city in `Detail`) |
| `Betaling tankbeurt Bancontact …` | Expense | Fuel |
| `Domiciliëring in euro (SEPA) …` | Expense | Recurring direct debit (e.g. insurance) |
| `Overschrijving in euro (SEPA) Van: …` | Income | SEPA transfer **in** |
| `Overschrijving in euro (SEPA) Naar: …` | Expense | SEPA transfer **out** |
| `Instantoverschrijving … Naar: …` | Expense | Instant SEPA out |
| `Doorlopende betalingsopdracht …` | Either | Standing order (salary in, savings out, …) |
| `Terugbetaling ING CARD …` | Expense | Credit-card repayment |
| `Kostenafrekening nr. …` | Expense | Account management + card insurance premiums |
| `Intresten-Kosten …` | Expense | Tax on bank statements (tiny, ~€0.15) |
| `HYPOTHECAIR KREDIET …` | Expense | Mortgage payment |
| `You have received a message` | — | **Skip on import** (info-only, amount is `0,00`) |

The `Omschrijving` line itself is a good default `description`; `Detail van de omzet` is a good default `notes` once trimmed.

### Parsing gotchas

1. **Strip the BOM** (`EF BB BF`) before splitting on `;`, otherwise the first column header turns into `\uFEFFRekeningnummer`.
2. **Amount** is Belgian-formatted: replace `,` with `.` then `parseFloat`. Negative values are explicit (`-4,80`).
3. **Date** is `DD/MM/YYYY` — must be converted to ISO `YYYY-MM-DD` for sorting/filtering in the app.
4. **Field count is fixed** (11 columns). Long free-form text in `Omschrijving`/`Detail`/`Bericht` can contain `;` characters, so split into at most 11 fields and re-join the trailing tail into the last non-empty field instead of trusting naive `split(';')`.
5. **Counterparty IBAN** is the most reliable merchant key — use it (not the merchant name) when building dedup or auto-categorisation rules.

### Deduplication

Statements overlap across files (e.g. the year-end fee posting on `31/12` appears in both the 2025 and the 2026 file). `Omzetnummer` alone is **not unique across files** — it restarts at `1` per statement period. Use a composite key, e.g.:

```
key = Boekingsdatum + "|" + Bedrag + "|" + (Rekening tegenpartij || "—") + "|" + Omschrijving.slice(0, 40)
```

Skip rows whose key already exists in the store. Zero-amount rows (`Bedrag = 0,00`, e.g. `You have received a message`) are not real transactions and must be filtered out before insertion.
