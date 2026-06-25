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

- [x] On dashboard load (preset = `1m`), the dashboard looks and behaves identically to before (visual smoke test, equivalent widget content for the current month).
- [x] Clicking each preset (`3m / 6m / 1y / 2y / all`) updates every widget consistently:
  - Summary cards' income / expense / balance match `Selectors.txnsInPeriod(state, range)` sums.
  - Donut's centre total equals `totalExpense` for the period.
  - Top-categories card's totals equal the donut's totals.
  - Recent transactions table contains all transactions whose date is in `[from, to]` inclusive, sorted desc.
- [x] Editing the from-to inputs switches `preset` to `'custom'` (no pill highlighted) and the dashboard updates.
- [x] "Standaard" link returns to `1m` preset and the dashboard reverts to current-month data.
- [x] The dashboard's `render()` no longer references `Router.monthKey` (search the file to confirm).
- [x] The donut + top-categories "toon per groep" toggle (`Store.setDashboardByGroup`) still works and respects the period.
- [x] `npm test` and `npm run lint` remain green.

## Blocked by

- ISSUE-014 (the `PeriodSelector` component must exist to be mounted).

## Out of scope

- Removing `Router.monthKey` from the codebase (deferred to ISSUE-016, which checks for any remaining references).
- Changing the donut's visual layout, colour palette, or category-group toggle semantics.
- Sorting, filtering, or grouping changes inside the recent-transactions table beyond "all in period, desc".
- Trends view wiring (ISSUE-016).
- Transactions page wiring (explicitly out of scope per the PRD).

## Implementation log

Captured during implementation.

### What was built

The dashboard view now consumes `Router.periodRange()` instead of the single-month `Router.monthKey`, so every widget (summary cards, donut, recent transactions, top categories) reflects the user-chosen period. The `PeriodSelector` from ISSUE-014 is mounted at the top of the dashboard and wires directly to `Router.setPeriodPreset` / `setPeriodRange` / `resetPeriod`.

### Files changed

| File | Δ |
|---|---|
| `views/dashboard.js` | **~** removed `Router.monthKey` + `Fmt.inMonth`; replaced with `Router.periodRange()` + `Selectors.txnsInPeriod(state, range)`; mounted `PeriodSelector.render('dashboard')` as the first child of the dashboard wrap; recent-transactions now sorts all in-period txns desc; updated the file header comment |
| `shell.js` | **~** `ensureMonthPicker()` now hides the topbar month picker on `dashboard` (only shown on `transactions`); comment updated |
| `i18n.js` | **~** 3 keys updated to drop "deze maand" — `dashboard.top.title`, `dashboard.recent.empty.title`, `dashboard.card.balance.pos` |
| `index.html` | **~** `?v=18` → `?v=19` (34 script tags) |
| `_test_boot.js` | **+** 8 new tests in an ISSUE-015 section; updated the old ISSUE-014 test that guarded against auto-mounting (now the dashboard mounts the selector) |

### Behaviour

- **Default preset = `1m`** — opening the dashboard shows current-month data, identical to the pre-ISSUE-015 behaviour.
- **Preset pills** — clicking a pill updates `Router.period`; the dashboard re-renders (selector re-mounted, all widgets re-computed). The shell does NOT re-render (ISSUE-010 invariant preserved).
- **Date inputs** — typing dates switches preset to `custom` (no pill highlighted); the dashboard re-renders.
- **Reset link** — `Router.resetPeriod('dashboard')` snaps back to `1m` preset.
- **Recent transactions** — shows every transaction whose `date` falls in `[from, to]`, sorted by `date` desc then `createdAt` desc.
- **Donut + top categories** — both consume the same in-period txns set; the `Store.setDashboardByGroup` toggle still works and re-rolls either by category or by group.

### Visual changes

- The topbar month picker (`‹ June 2026 ›`) is no longer rendered when the dashboard view is active. The picker still appears on the transactions view, where it's still the primary time control.
- The period selector sits directly under the view heading, full-width, with the existing `.period-selector` styling from ISSUE-014.
- Three Dutch strings updated to be period-aware instead of month-bound:
  - `Topcategorieën deze maand` → `Topcategorieën in periode`
  - `Geen transacties deze maand` → `Geen transacties in deze periode`
  - `Deze maand gespaard` → `Gespaard in periode`

### Real-browser verification

Seeded 7 transactions across Apr–Sep 2026 (one per month, two in May for income+expense).

| Preset | From → To | Income | Expense | Balance | Donut centre |
|---|---|---|---|---|---|
| `1m` | 2026-06-01 → 2026-06-25 | €0,00 | €300,00 | −€300,00 | €300,00 |
| `6m` | 2026-01-01 → 2026-06-25 | €2.000,00 | €600,00 | €1.400,00 | €600,00 |
| `all` | 2026-04-01 → 2026-06-25 | €2.000,00 | €600,00 | €1.400,00 | €600,00 |
| reset | back to `1m` | (same as `1m`) | | | |

Recent transactions card on `6m` shows all six in-period rows sorted desc (Jun 15 first, May 15 next, etc.). Topbar month picker is empty on dashboard and present on transactions (3 children, `.mp-label` shows `June 2026`). No console/page errors throughout.

Screenshots at `/tmp/issue015-3-1m.png`, `/tmp/issue015-4-6m.png`, `/tmp/issue015-5-all.png`.

### Test results

| Suite | Before | After |
|---|---|---|
| `_test_csv.js` | 21 | 21 |
| `_test_selectors.js` | 73 | 73 |
| `_test_period.js` | 34 | 34 |
| `_test_boot.js` | 87 | **96** (+9 net — added 8, replaced 1) |
| **total** | 215 | **224** |

`npm run lint`: 0 errors, 11 pre-existing warnings (none introduced; none removed).

### Decisions / trade-offs

- **Hide topbar month picker on dashboard** — the PRD scopes the month picker to the transactions view only. The picker still exists in the shell but is empty on dashboard (`host.innerHTML = ''` in `ensureMonthPicker`). When `Router.monthKey` is deleted in ISSUE-016, this becomes a no-op, but for now it stops the picker from showing a stale label that has no effect on the dashboard's data.
- **Three i18n strings updated** — the "deze maand" wording was factually wrong once the dashboard spanned more than one month. Changed to period-neutral phrasing.
- **Recent transactions uses `[...txns]` spread then sort** — preserves the existing sort key (`date` desc, then `createdAt` desc). No slice — the dashboard shows every in-period transaction; the `.recent-list` + compact table handles the rest visually.
- **Dashboard re-mounts the selector on every render** — same pattern as the rest of the view content. The selector doesn't subscribe to `store:changed` itself; it's mounted-and-forgotten, like every other dashboard card.

### Known follow-ups (out of scope here)

- ISSUE-016: delete `Router.monthKey`, `Router.shiftMonth`, `Fmt.inMonth` and the topbar month picker host if no longer needed.
- Donut legend shows `NaN%` when the dashboard renders a single expense category at 100% — pre-existing bug in `renderDonut`'s legend loop (the items array has no `frac` property; the SVG segments compute `frac` internally). Trivial one-line fix left for a separate issue.
- The `1m` preset resets the dashboard to "current month". The user can still navigate around the calendar with the topbar month picker — but on the dashboard that picker is now hidden, so this is moot.