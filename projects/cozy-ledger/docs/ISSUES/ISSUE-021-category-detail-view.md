# ISSUE-021 — Slice A: Category detail view

## Parent

[PRD] Category & Payee deep-dives — `docs/PRD/PRD-006-category-and-payee-deep-dives.md`

## Why

The dashboard's top-categories card shows the top 6 categories for the active period, but clicking does nothing. The user wants a canonical place to drill into a category and answer "how much have we spent on restaurants over time, where does that money go, and what did we just buy?". This slice delivers the detail view as a reusable component, with the route, helpers, and tests. Subsequent slices (dashboard click, list page, payee variant) all depend on it.

## What to build

1. **Route**.

   - `category/:id` — encoded as a single `view` string (e.g. `'category-abc123'`). `Router.goTo('category-abc123')` switches the view; `renderView()` parses the id and dispatches to `CategoryDetail.render({ categoryId })`.
   - Add to the `titles` map in `renderView()` → `t('categoryDetail.title', { name })`.

2. **Pure helpers in `selectors.js`**:

   - `Selectors.categoryTotals(state, categoryId, today = new Date())` → `{ thisMonth, thisYear, count, percentOfExpenses }`. In-scope only. `percentOfExpenses` = `thisMonth / totalExpenseThisMonth * 100` (returns 0 when there are no expenses at all).
   - `Selectors.categoryMonthlyTrend(state, categoryId, months)` → `[{ month: 'YYYY-MM', amount }]` ordered asc, length = `months.length`. Months with no in-scope txns render with `amount = 0`.
   - `Selectors.topPayeesInCategory(state, categoryId, today, limit = 5)` → `[{ payeeName, total, count }]`. Sorted by `total` desc. In-scope only.
   - `Selectors.recentTransactionsForCategory(state, categoryId, limit = 25)` → array of in-scope txns with `categoryId` matching, sorted by `date desc` then `createdAt desc`.

3. **New shared helper file `views/_entity-detail.js`**.

   Exposes `EntityDetail.render({ kind, entity, totals, trend, topList, recent, extraActions })`. Renders the shared chrome:
   - Header (name + swatch + totals + this-month bar).
   - Monthly trend chart (small SVG, 12 months, monthly bars).
   - Top related entities list (5 rows).
   - Recent transactions table (last 25).
   - "View all transactions" link.
   - Back button (calls `history.back()` if available, else `Router.goTo('categories')`).

   The chart is a small SVG — extract or reimplement the bar logic from `charts/monthly-flow.js`. Aim for ~80 lines of inline SVG; no library.

4. **New view `views/category-detail.js`**.

   Exposes `CategoryDetail.render({ categoryId })`:
   - Parses id, fetches category from `state.categories`.
   - Empty state if not found.
   - Calls `Selectors.*` helpers above.
   - Calls `EntityDetail.render({ kind: 'category', entity: category, totals, trend, topList: { title: t('categoryDetail.topPayees'), rows: topPayees }, recent, extraActions: [setEnvelopeButton] })`.
   - The `setEnvelopeButton` navigates to `Router.goTo('envelopes')` and triggers the envelope modal pre-filled with `categoryIds: [id]`. To support "pre-fill on route entry", extend the route mechanism with an optional `Router.pendingEnvelopeInit = { categoryIds: [id] }` consumed by `views/envelopes.js render()`.

5. **Router support for detail routes**.

   - `Router.parseDetailRoute(view)` → `{ kind: 'category' | 'payee', id } | null`. Splits on `-` (since category and payee ids are slug-style). If parsing fails, returns null and the renderer shows an empty state.
   - `Router.goTo('envelopes')` should preserve any pending-init payload (`Router.pendingEnvelopeInit`) for the next `envelopes` render.

6. **i18n keys**:

   ```
   'categoryDetail.title':         'Categorie: {name}'
   'categoryDetail.thisMonth':     'Deze maand'
   'categoryDetail.thisYear':      'Dit jaar'
   'categoryDetail.trend':         'Maandelijks verloop (12 maanden)'
   'categoryDetail.topPayees':     'Top begunstigden in deze categorie'
   'categoryDetail.recent':        'Recente transacties'
   'categoryDetail.viewAll':       'Alle transacties bekijken'
   'categoryDetail.setEnvelope':   'Envelop instellen voor deze categorie'
   'categoryDetail.back':          'Terug'
   'categoryDetail.notFound':      'Categorie niet gevonden'
   ```

7. **CSS** for the detail page:

   - `.entity-detail` — vertical stack of cards.
   - `.entity-detail-header` — flex row, swatch + name + totals.
   - `.entity-detail-trend` — small chart card.
   - `.entity-detail-top-list` — list of 5 rows.
   - `.entity-detail-recent` — recent transactions table.
   - `.entity-detail-actions` — back button + set-envelope CTA.

8. **Tests**:

   - In `_test_selectors.js` (or new `_test_categories.js`):
     - `categoryTotals`: empty category, single-txn category, multi-month category. Assert `thisMonth`, `thisYear`, `count`, `percentOfExpenses`.
     - `categoryMonthlyTrend`: returns 12 entries in order, fills 0 for empty months.
     - `topPayeesInCategory`: returns right payees sorted by total desc, capped at limit.
     - `recentTransactionsForCategory`: returns in-scope txns with matching categoryId, sorted desc.
   - In `_test_boot.js`: route `/category-{id}` mounts the detail view; navigating from dashboard (or any seed) renders header, trend, top payees, recent; back button returns to previous view; set-envelope CTA navigates to envelopes route.

## Acceptance criteria

- [ ] Route `category/:id` mounts the detail view with the right category.
- [ ] Header shows: name + swatch + icon, this-month total, this-year total, txn count, percent of expenses.
- [ ] Monthly trend chart shows 12 months of bars with the right totals.
- [ ] Top 5 payees in the category render with name + total + count, sorted desc.
- [ ] Recent transactions table shows last 25 in-scope txns for the category, sorted desc.
- [ ] "View all transactions" link navigates to `/transactions` with the category filter pre-applied.
- [ ] "Set envelope for this category" CTA navigates to `/envelopes` and opens the envelope modal pre-filled with this category.
- [ ] Back button returns to the previous view.
- [ ] All 9 new i18n keys resolve to Dutch strings.
- [ ] At least 10 new test assertions across the test files.
- [ ] `npm test` and `npm run lint` clean.

## Blocked by

None.

## Out of scope

- Dashboard click (ISSUE-022) — this slice delivers the route and view only.
- Categories list page (ISSUE-023).
- Payee detail view (ISSUE-024).
- Transactions stats strip (ISSUE-025).
- Editing the category from the detail page.
- A yearly trend chart (monthly only for v1).
- Clicking a month in the trend chart to drill into that month's transactions.
- A "share" or "export" button on the detail page.
- Per-user drill-down (everything is scope-aware via `Selectors.transactionsInScope`).
- The envelope "pre-fill on route entry" mechanism is introduced here in a minimal form; richer "open modal with prefilled data" UX is ISSUE-022/023's concern.