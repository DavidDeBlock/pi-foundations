# ISSUE-013 — Period state + pure helpers + tests

## Parent

[PRD] Unified period selector for Dashboard & Trends — `docs/PRD/PRD-004-unified-period-selector.md`

## Why

The dashboard and Trends view need a single shared notion of "what time range am I looking at" before any UI work makes sense. Putting this state and its pure helpers in place first means ISSUE-014 (the selector component) and ISSUE-015/016 (wiring) can each consume a stable, tested API instead of inventing one along the way.

## What to build

1. **Period state on `Router`** (`router.js`).

   Add a private `period` object next to the existing `monthKey` / `trendRange` state:

   ```js
   let period = {
     preset: '1m',                  // '1m' | '3m' | '6m' | '1y' | '2y' | 'all' | 'custom'
     from:   'YYYY-MM-DD',          // ISO date, inclusive, snapped to first-of-month for non-custom
     to:     'YYYY-MM-DD',          // ISO date, inclusive (today)
   };
   ```

   Expose read/write helpers:

   - `Router.periodRange()` → `{ from, to }` (ISO strings).
   - `Router.setPeriodPreset(preset)` → re-derives `from`/`to` from the preset using today, calls `renderView()`.
   - `Router.setPeriodRange({ from, to })` → switches to `preset = 'custom'`, validates `from <= to`, clamps `to` to today, calls `renderView()`.
   - `Router.resetPeriod(viewKey)` → sets `preset` to the default for that view (`1m` for `'dashboard'`, `1y` for `'trends'`) and re-derives.
   - `Router.defaultPresetFor(viewKey)` → returns `'1m'` or `'1y'`.

   Keep an internal `periodDefaultsByView` map so future views can be added without changing call sites.

   Replace `Router.monthsForRange(range)` with a thin wrapper that calls `Selectors.monthsInPeriod(Router.periodRange())`. Keep the wrapper for the duration of ISSUE-016 to ease the migration, then it goes away.

2. **Persistence**.

   - Storage key: `'cozy.ledger.period'`.
   - On `Router` boot (after `Store.load()`), read the key. If present and well-formed (`preset` is a known value, `from`/`to` parse as ISO dates, `from <= to`, `to` is not in the future), restore it. Otherwise fall back to the dashboard default.
   - On every successful `setPeriodPreset` / `setPeriodRange` / `resetPeriod`, write the full `{ preset, from, to }` to `localStorage`.
   - Wrap reads/writes in a try/catch — localStorage may be disabled (private mode); if so, the period still works in-memory for the session.

3. **Pure helpers in `selectors.js`**.

   Add three new exported functions:

   - `Selectors.periodRangeForPreset(preset, today = new Date())` → `{ from, to }` of ISO strings, rolling semantics per the PRD table. `all` requires a `state` argument (or a separate helper `Selectors.periodRangeForAll(state, today)`); for `1m / 3m / 6m / 1y / 2y`, no state is needed.
   - `Selectors.txnsInPeriod(state, { from, to })` → array of in-scope transactions whose `date` is in `[from, to]` inclusive. In-scope means `Selectors.transactionsInScope(state)` and the date string compares lexicographically.
   - `Selectors.monthsInPeriod({ from, to })` → array of `YYYY-MM` strings from `from`'s month to `to`'s month inclusive, capped at 240. Returns `[]` if `from > to`.

4. **Tests in `_test_selectors.js`** (or a new `_test_period.js` if the existing file grows too long — preferred: new file).

   Cover at least:
   - Each preset's `from`/`to` for at least three `today` values: 1st of month (e.g. `2026-06-01`), 15th (`2026-06-15`), last day (`2026-06-30`).
   - `all` returns `from` = earliest in-scope transaction date and `to` = today, given a controlled state.
   - `txnsInPeriod`: boundary transactions on `from` and `to` are included; transactions outside the range are excluded; transactions outside scope are excluded.
   - `monthsInPeriod`: produces the expected ordered list, handles `from > to` (returns `[]`), respects the 240-month cap.
   - Persistence round-trip: write period, simulate a fresh `Router` boot, verify restore. (Mock `localStorage` if not already in the test harness — check `_test_boot.js` for the existing pattern.)

5. **No UI yet**. This issue is data + helpers only. No component, no DOM, no i18n key changes.

## Acceptance criteria

- [ ] `Router.periodRange()` returns a `{ from, to }` object whose values are ISO date strings.
- [ ] `Router.setPeriodPreset('3m')` re-derives `from`/`to` rolling from today, writes to localStorage, and triggers a re-render.
- [ ] `Router.setPeriodRange({ from: '2026-01-15', to: '2026-03-10' })` sets `preset = 'custom'`, persists, re-renders.
- [ ] `Router.resetPeriod('dashboard')` resets to `1m` preset; `Router.resetPeriod('trends')` resets to `1y`.
- [ ] `Selectors.periodRangeForPreset` matches the PRD table for each preset.
- [ ] `Selectors.txnsInPeriod` boundary dates are inclusive on both ends.
- [ ] `Selectors.monthsInPeriod` is ordered, capped at 240, and returns `[]` on `from > to`.
- [ ] Persistence: writing and reading back round-trips correctly; a malformed stored value falls back to the dashboard default without throwing.
- [ ] At least 12 assertions across the new tests; all existing tests still pass (`npm test`).
- [ ] `npm run lint` is clean.

## Blocked by

None.

## Out of scope

- The selector component (ISSUE-014).
- Wiring the dashboard or Trends view (ISSUE-015, ISSUE-016).
- Removing `Router.monthKey` — leave it; only delete once ISSUE-016 confirms no remaining references.
- Removing `Router.trendRange` and `Router.monthsForRange` — leave them; ISSUE-016 deletes them.
- i18n changes.