# ISSUE-024 — Slice D: Payee detail view

## Parent

[PRD] Category & Payee deep-dives — `docs/PRD/PRD-006-category-and-payee-deep-dives.md`

## Why

The category detail view (ISSUE-021) shows top payees in a category. Users want to click those payees and land on a payee-specific detail page — "how much do we actually spend at Café Bombala, and what categories does it fall into?". This slice reuses the shared detail component from ISSUE-021 with payee data.

## What to build

1. **Pure helpers in `selectors.js`**:

   - `Selectors.payeeTotals(state, payeeName, today = new Date())` → `{ thisMonth, thisYear, count, percentOfExpenses }`. In-scope only. Match is `extractPayee(txn.description) === payeeName`.
   - `Selectors.payeeMonthlyTrend(state, payeeName, months)` → `[{ month: 'YYYY-MM', amount }]` ordered asc, length = `months.length`.
   - `Selectors.topCategoriesForPayee(state, payeeName, today, limit = 5)` → `[{ category, total, count }]`. Sorted by `total` desc.
   - `Selectors.recentTransactionsForPayee(state, payeeName, limit = 25)` → array of in-scope txns matching the payee, sorted desc.
   - `Selectors.payeeList(state)` → `[{ name, thisMonth }]` — every distinct payee in scope with this-month total. Used by the optional browse list (optional for v1; document as a possible follow-up).

2. **New view `views/payee-detail.js`**.

   Exposes `PayeeDetail.render({ payeeId })`:
   - Payee id is the slugified payee name (matching how `ViewHelpers.distinctPayees()` and `extractPayee` work — payee is currently a free-text field, not an entity with an id). Reverse the slug back to a name to look up transactions.
   - Empty state if no in-scope transactions match.
   - Calls `Selectors.*` helpers above.
   - Calls `EntityDetail.render({ kind: 'payee', entity: { name: payeeName }, totals, trend, topList: { title: t('payeeDetail.topCategories'), rows: topCategories.map(r => ({ name: r.category.name, total: r.total, count: r.count, id: 'category-' + r.category.id })) }, recent })`.
   - Top-list rows in the payee detail are clickable and navigate to `category-{id}` (reusing the clickable pattern from ISSUE-022).

3. **Route**: `payee/:id` registered in `renderView()` titles map and `Router.parseDetailRoute`. `Router.goTo('payee-{slug}')`.

4. **Reachability**:

   - Inside the category detail (ISSUE-021), the top-payees list rows become clickable → `Router.goTo('payee-{slug}')`.
   - On the Transactions page, the payee column becomes clickable (each payee name in the table renders as a button that navigates). Implementation note: extend `Transactions.renderRow` to wrap the payee cell's text in a clickable button.

5. **No "Set envelope for this payee" CTA**. Per the PRD, this CTA is category-only for v1.

6. **i18n keys**:

   ```
   'payeeDetail.title':           'Begunstigde: {name}'
   'payeeDetail.thisMonth':       'Deze maand'
   'payeeDetail.thisYear':        'Dit jaar'
   'payeeDetail.trend':           'Maandelijks verloop (12 maanden)'
   'payeeDetail.topCategories':   'Top categorieën voor deze begunstigde'
   'payeeDetail.recent':          'Recente transacties'
   'payeeDetail.viewAll':         'Alle transacties bekijken'
   'payeeDetail.back':            'Terug'
   'payeeDetail.notFound':        'Begunstigde niet gevonden'
   ```

7. **CSS**: reuse `.entity-detail*` from ISSUE-021. Add `.payee-cell-link` for the transactions-table payee-cell button.

8. **Tests**:

   - In `_test_selectors.js` (or `_test_payees.js`):
     - `payeeTotals`: empty payee, single-txn payee, multi-month payee.
     - `payeeMonthlyTrend`: returns 12 entries in order, fills 0 for empty months.
     - `topCategoriesForPayee`: returns right categories sorted by total desc.
     - `recentTransactionsForPayee`: returns in-scope txns matching, sorted desc.
   - In `_test_boot.js`:
     - Route `payee-{slug}` mounts the payee detail.
     - Clicking a top-payee row in category detail navigates to `payee-{slug}`.
     - Clicking a payee cell in the transactions table navigates to `payee-{slug}`.

## Acceptance criteria

- [ ] Route `payee/:id` mounts the payee detail view.
- [ ] Header shows: payee name, this-month total, this-year total, txn count, percent of expenses.
- [ ] Monthly trend chart shows 12 months of bars with the right totals.
- [ ] Top 5 categories for the payee render with name + total + count, sorted desc.
- [ ] Recent transactions table shows last 25 in-scope txns for the payee, sorted desc.
- [ ] "View all transactions" link navigates to `/transactions` with the payee filter pre-applied.
- [ ] Inside category detail, top-payees rows are clickable and navigate to `payee-{slug}`.
- [ ] On the transactions table, payee cells are clickable and navigate to `payee-{slug}`.
- [ ] Back button returns to the previous view.
- [ ] All 9 new i18n keys resolve to Dutch strings.
- [ ] At least 10 new test assertions across the test files.
- [ ] `npm test` and `npm run lint` clean.

## Blocked by

- ISSUE-021 (the shared `EntityDetail` helper must exist).

## Out of scope

- A "Set envelope for this payee" CTA.
- A payee list page (browse all payees with totals).
- Editing the payee name retroactively across all transactions.
- Merging two payees that are slightly differently spelled ("Café Bombala" vs "Cafe Bombala").
- A payee as a first-class entity (currently it's a string extracted from `txn.description`).
- Per-user drill-down (everything is scope-aware via `Selectors.transactionsInScope`).
- Yearly trend chart (monthly only for v1).