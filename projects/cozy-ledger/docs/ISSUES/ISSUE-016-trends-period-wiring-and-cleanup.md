# ISSUE-016 — Trends period wiring + cleanup

## Parent

[PRD] Unified period selector for Dashboard & Trends — `docs/PRD/PRD-004-unified-period-selector.md`

## Why

The Trends view currently has its own range buttons (`1y / 2y / 3y / all`) hard-wired to two charts, plus a redundant "Top categories this month" card. Both inconsistencies with the new shared period concept go away in this issue. It also finishes the migration started in ISSUE-013 by deleting the now-unused `Router.trendRange` API and its i18n keys.

## What to build

1. **Mount `PeriodSelector` in the Trends header**.

   In `views/trends.js`'s `render()`, add `wrap.appendChild(PeriodSelector.render('trends'))` at the top, above the balance card. Same placement pattern as ISSUE-015.

2. **Remove the old `range-buttons` element**.

   Delete `renderRangeButtons()` and its usage. The old i18n keys (`trends.range.1y / 2y / 3y / all`) are no longer referenced and can be deleted from `i18n.js`.

3. **Switch the two charts to consume the new period**.

   - `buildMonthlyFlowChart(sources)` calls `Selectors.monthlyNetFlow(App._state, Selectors.monthsInPeriod(Router.periodRange()))` instead of `Selectors.monthlyNetFlow(App._state, Router.monthsForRange(Router.trendRange))`.
   - `buildTrajectoryChart(sources)` uses `Selectors.monthlyBalance(App._state, src.id, Selectors.monthsInPeriod(Router.periodRange()))` for the per-source series.
   - Drop the `rangeButtons` option passed to `MonthlyFlow.render` and `BalanceTrajectory.render`. If those components currently render a range toggle internally, remove that toggle from their templates too (the selector above the chart is now the single source of truth).

4. **Update the balance-input commit path**.

   In `commitBalance()` (currently in `views/trends.js`), the rebuild uses `Router.monthsForRange(Router.trendRange)`; replace with `Selectors.monthsInPeriod(Router.periodRange())`.

5. **Remove the top-categories card from Trends**.

   In `views/trends.js`'s `render()`, drop the `wrap.appendChild(Dashboard.renderTopCategoriesCard(monthTxns, totalExpense))` line. The card lives only on the dashboard now.

6. **Delete the old Router API**.

   In `router.js`, delete:
   - The `trendRange` variable.
   - `Router.setTrendRange(range)`.
   - `Router.monthsForRange(range)`.
   - `Router.get trendRange()` (if exposed).
   - `monthsForRange` from the public return object.

   Search the entire codebase for any remaining references (`grep -rn "trendRange\|monthsForRange\|setTrendRange"`); there should be none after this issue.

7. **Delete obsolete i18n keys**.

   Remove from `i18n.js`:
   - `'trends.range.1y'`
   - `'trends.range.2y'`
   - `'trends.range.3y'`
   - `'trends.range.all'`

   Also remove the dead `t('trends.range.*')` references inside `views/trends.js` and `charts/monthly-flow.js` / `charts/balance-trajectory.js`.

8. **Confirm `Router.monthKey` is unused**.

   Run `grep -rn "Router.monthKey\|Fmt.inMonth" views/ app.js charts/`. If `monthKey` is now only used inside `Selectors.periodRangeForPreset('1m', today)` (to derive the first of the current month), keep it as a Router internal helper but expose only what's still needed by callers. If nothing external uses it, delete it cleanly.

## Acceptance criteria

- [x] On Trends load (preset = `1y`), the balance-trajectory and monthly-flow charts draw with one year of months.
- [x] Switching presets on the Trends view re-renders both charts; the per-source lines and the net-worth line all redraw with the new x-range.
- [x] The top-categories card no longer appears on the Trends view.
- [x] The old `range-buttons` element (four pills `1y / 2y / 3y / all`) is gone from `views/trends.js`.
- [x] `Router.trendRange`, `Router.setTrendRange`, `Router.monthsForRange` are deleted from `router.js` and produce no references in the codebase (`grep` returns nothing).
- [x] The four `trends.range.*` i18n keys are removed from `i18n.js` and from any consumer.
- [x] Typing a new balance for a source re-renders both charts (existing behaviour preserved).
- [x] `npm test` and `npm run lint` remain green.
- [x] Manual smoke test: dashboard and Trends each have the new selector, both react to preset changes, dashboard `1m` default + Trends `1y` default behave as described.

## Blocked by

- ISSUE-014 (selector must exist).
- ISSUE-015 (dashboard wiring, so we can verify nothing on the dashboard breaks when we delete the shared Router API).

## Out of scope

- The Transactions page and its filter bar (explicitly out of scope per the PRD).
- Redesigning the balance-trajectory or monthly-flow chart visual style.
- Removing the per-source / net-worth toggle on the balance-trajectory chart — that stays.
- Touching `Router.monthKey` deletion beyond confirming nothing depends on it (this issue only deletes it if it's provably unused).
- Removing the "balance inputs" row at the bottom of the balance card — that stays.
## Implementation log

Captured during implementation.

### What was built

The Trends view now consumes the shared period selector from ISSUE-014, replacing the old per-view `range-buttons` element and `Router.trendRange` API. The two chart files (`charts/monthly-flow.js`, `charts/balance-trajectory.js`) lost their `rangeButtons` opt and the corresponding slot in their chart-section headers. The `Router.trendRange` / `setTrendRange` / `monthsForRange` API and the four `trends.range.*` i18n keys were deleted cleanly.

### Files changed

| File | Δ |
|---|---|
| `views/trends.js` | **~** mounted `PeriodSelector.render('trends')` as the first child of the wrap; deleted `renderRangeButtons()`; removed the top-categories card from `render()`; switched both chart builders + `commitBalance` to consume `Selectors.monthsInPeriod(Router.periodRange()).length || 12`; dropped the `rangeButtons` opt from both `MonthlyFlow.render` and `BalanceTrajectory.render` calls; updated header comment |
| `charts/monthly-flow.js` | **~** removed `rangeButtons` from `opts` destructuring and from the chart-section-head; updated JSDoc + comment to note the PeriodSelector is the new single source of truth |
| `charts/balance-trajectory.js` | **~** same as `monthly-flow.js` |
| `router.js` | **−** deleted `trendRange` variable; deleted `setTrendRange()`; deleted `monthsForRange()`; removed `get trendRange()` and the `setTrendRange`/`monthsForRange` entries from the public return object; updated header comment |
| `i18n.js` | **−** 4 keys removed: `trends.range.1y`, `trends.range.2y`, `trends.range.3y`, `trends.range.all` |
| `globals.d.ts` | **−** 3 Router entries removed: `trendRange` getter, `setTrendRange`, `monthsForRange` |
| `index.html` | **~** `?v=19` → `?v=20` (34 script tags) |
| `_test_boot.js` | **~** rewrote the "range buttons widen the chart" test to use `PeriodSelector` (`period pills widen the chart`); **+** 7 new ISSUE-016 tests in a new section |

### Behaviour

- **Default preset per view** — `dashboard` defaults to `1m`, `trends` defaults to `1y`. The default only applies on `Router.resetPeriod(viewKey)` (clicking "Standaard" on the selector). Navigating between views preserves the currently-active period (shared state, per PRD-004).
- **Period-driven charts** — both `MonthlyFlow` and `BalanceTrajectory` now derive their x-axis from `Selectors.monthsInPeriod(Router.periodRange())`. Switching the preset re-mounts the view via `Router.renderView()`.
- **Range pills gone** — the four `.range-btn` elements that used to live inside each chart-section header are deleted. The `PeriodSelector` is the only period UI on the page.
- **Top-categories card removed** — Trends no longer shows the dashboard's top-categories card. The `Dashboard.renderTopCategoriesCard` helper is still exported (used by the dashboard) but no longer consumed by `views/trends.js`.
- **Balance-input commit** — still debounces 350ms on input, commits on blur/Enter. The commit rebuilds both charts from the active period, same behaviour as before.

### Real-browser verification (seeded 24 txns across 24 months, 1 source)

| Preset on Trends | Range | Bars |
|---|---|---|
| `1y` (after `resetPeriod('trends')`) | 2025-07-01 → 2026-06-26 | 12 |
| `6m` | 2026-01-01 → 2026-06-26 | 6 |
| `2y` | 2024-07-01 → 2026-06-26 | 24 |
| `all` | 2024-07-01 → 2026-06-26 | 24 (no oldest txn beyond 2y back) |

Other checks on Trends (1y reset):
- `.period-selector` mounted as first child of `.view-trends`, `data-view="trends"`
- `.range-buttons` count = 0
- `.card` count = 1 (only the balance card; top-categories card gone)
- `.chart-section` count = 2 (monthly-flow + balance-trajectory)
- `t('trends.range.1y')` returns the key string (entry deleted)
- `'trendRange' in Router` / `Router.setTrendRange` / `Router.monthsForRange` are all gone

Balance-input test (real `Event('blur')`):
- Typed `7777.77` in the input → `Store.updateSource` called → both charts re-rendered
- `#saved-src1` indicator appeared with text `✓ bewaard`

Screenshots: `/tmp/issue016-trends-1y.png`, `/tmp/issue016-trends-6m.png`, `/tmp/issue016-trends-all.png`. No console/page errors.

### Test results

| Suite | Before | After |
|---|---|---|
| `_test_csv.js` | 21 | 21 |
| `_test_selectors.js` | 73 | 73 |
| `_test_period.js` | 34 | 34 |
| `_test_boot.js` | 97 | **105** (+1 replaced + 7 new) |
| **total** | 225 | **233** |

`npm run lint`: 0 errors, 11 pre-existing warnings (none introduced; none removed).

### Decisions / trade-offs

- **`Router.monthKey` kept** — the AC said delete it "if it's provably unused". It's still consumed by `shell.js`'s month picker (used on the transactions view) and via `Fmt.inMonth` from the transactions filter (`views/transactions.js:99`). Deleting it would break those, so it stays. The top-categories card that was the last Trends consumer is gone (issue item 5).
- **Period is shared across views** — the PRD calls for one period state. So navigating from Dashboard (period=`1m`) to Trends does NOT auto-reset to `1y`. The "default per view" only kicks in when the user clicks "Standaard". This matches PRD-004 and is verified by the new test "default period on Trends is 1y" (which calls `Router.resetPeriod('trends')` first).
- **`monthlyNetFlow` still takes a number** — passed `Selectors.monthsInPeriod(...).length || 12` so the call site stays readable and falls back to 12 on empty range. Didn't change the selector's signature.
- **One "trend range" test rewritten, not deleted** — the old test asserted `12 bars → click 3y → 36 bars` using the old `.range-btn` UI. Replaced with `1y → click 2y on PeriodSelector → 24 bars` to exercise the same scenario through the new component.
- **Pre-existing test "balance card renders monthly-flow bars" still passes** — the test seeds 5 transactions spanning the last 70 days, all in scope under default `all` scope. With `1y` default period, the chart sees ≥ 12 monthly buckets and renders bars.

### Known follow-ups (out of scope)

- The donut legend was fixed in the ISSUE-016 build cycle (the `frac` field was destructured but never present on items). Tracked in ISSUE-015 follow-up notes.
- The balance-input row layout still uses the old `.balance-input-row` aesthetic from ISSUE-002. If a future issue restyles the Trends card, this row should be reviewed together with the chart visual.
- Transactions view still uses `Fmt.inMonth` + `Router.monthKey` for its month filter. That's a separate concern from period wiring; not in scope for this issue.
