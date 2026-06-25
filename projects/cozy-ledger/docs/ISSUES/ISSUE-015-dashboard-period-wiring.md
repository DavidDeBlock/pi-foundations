# ISSUE-015 — Dashboard period wiring

## Parent

[PRD] Unified period selector for Dashboard & Trends — `docs/PRD/PRD-004-unified-period-selector.md`

## Why

The dashboard currently shows one month of data on every widget, scoped via `Fmt.inMonth(x.date, Router.monthKey)`. To deliver the user-facing feature ("set a period, see totals for that period"), every dashboard widget must consume the new period. This is the biggest behaviour change for users, so it gets its own issue with explicit widget-by-widget acceptance criteria.

## What to build

1. **Mount `PeriodSelector` in the dashboard header**.

   In `views/dashboard.js`'s `render()`, before any cards, build the wrap with the selector at the top:

   ```js
   const wrap = el('div', { class: 'view-dashboard' });
   wrap.appendChild(PeriodSelector.render('dashboard'));
   ```

   The selector should sit above the summary grid, full width, in a thin row.

2. **Replace month-scoped filtering with period-scoped filtering**.

   Today (lines around `monthKey` in `views/dashboard.js`):

   ```js
   const inScopeTxns = Selectors.transactionsInScope(state);
   const txns = inScopeTxns.filter(x => Fmt.inMonth(x.date, monthKey));
   ```

   Replace with:

   ```js
   const range = Router.periodRange();
   const inScopeTxns = Selectors.transactionsInScope(state);
   const txns = Selectors.txnsInPeriod(state, range);
   ```

   This affects:
   - Summary card totals (income, expense, balance, shared/private).
   - The donut (categories / groups rolled up over the full period).
   - The "recent transactions" list (sort all txns in the period desc by date then `createdAt`).
   - The top-categories card (`topCategories(txns, totalExpense)` and `topGroups(txns)`).
   - `donutRows` derivation.

3. **"Recent transactions" semantics**.

   Change the dashboard's recent-transactions card to show **all transactions in the period** (sorted descending), not "the last 10 of this month". If a period yields more than ~20 transactions, the table remains compact — the existing `.recent-list` + `Transactions.renderTable(..., { compact: true })` handles this.

4. **Remove the month picker from the dashboard** (if it exists there).

   Check `app.js` / `index.html` for any dashboard-specific month picker. The PRD scopes the Transactions page's month picker to the transactions view only; the dashboard should not have its own.

   Note: do **not** delete `Router.monthKey` or its helpers in this issue. ISSUE-016 will confirm whether they're still needed anywhere and delete them then.

5. **No selector UI changes**. The selector was built in ISSUE-014; this issue just mounts it.

## Acceptance criteria

- [ ] On dashboard load (preset = `1m`), the dashboard looks and behaves identically to before (visual smoke test, equivalent widget content for the current month).
- [ ] Clicking each preset (`3m / 6m / 1y / 2y / all`) updates every widget consistently:
  - Summary cards' income / expense / balance match `Selectors.txnsInPeriod(state, range)` sums.
  - Donut's centre total equals `totalExpense` for the period.
  - Top-categories card's totals equal the donut's totals.
  - Recent transactions table contains all transactions whose date is in `[from, to]` inclusive, sorted desc.
- [ ] Editing the from-to inputs switches `preset` to `'custom'` (no pill highlighted) and the dashboard updates.
- [ ] "Standaard" link returns to `1m` preset and the dashboard reverts to current-month data.
- [ ] The dashboard's `render()` no longer references `Router.monthKey` (search the file to confirm).
- [ ] The donut + top-categories "toon per groep" toggle (`Store.setDashboardByGroup`) still works and respects the period.
- [ ] `npm test` and `npm run lint` remain green.

## Blocked by

- ISSUE-014 (the `PeriodSelector` component must exist to be mounted).

## Out of scope

- Removing `Router.monthKey` from the codebase (deferred to ISSUE-016, which checks for any remaining references).
- Changing the donut's visual layout, colour palette, or category-group toggle semantics.
- Sorting, filtering, or grouping changes inside the recent-transactions table beyond "all in period, desc".
- Trends view wiring (ISSUE-016).
- Transactions page wiring (explicitly out of scope per the PRD).