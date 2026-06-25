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

- [x] `Router.periodRange()` returns a `{ from, to }` object whose values are ISO date strings.
- [x] `Router.setPeriodPreset('3m')` re-derives `from`/`to` rolling from today, writes to localStorage, and triggers a re-render.
- [x] `Router.setPeriodRange({ from: '2026-01-15', to: '2026-03-10' })` sets `preset = 'custom'`, persists, re-renders.
- [x] `Router.resetPeriod('dashboard')` resets to `1m` preset; `Router.resetPeriod('trends')` resets to `1y`.
- [x] `Selectors.periodRangeForPreset` matches the PRD table for each preset.
- [x] `Selectors.txnsInPeriod` boundary dates are inclusive on both ends.
- [x] `Selectors.monthsInPeriod` is ordered, capped at 240, and returns `[]` on `from > to`.
- [x] Persistence: writing and reading back round-trips correctly; a malformed stored value falls back to the dashboard default without throwing.
- [x] At least 12 assertions across the new tests; all existing tests still pass (`npm test`).
- [x] `npm run lint` is clean.

## Implementation log

Captured during implementation.

### What was built

A new shared period concept (`{ preset, from, to }`) owned by `Router` and consumed by `Selectors` helpers, with localStorage persistence under the key `cozy.ledger.period`. The component (ISSUE-014) and wiring (ISSUE-015/016) will consume this stable API.

### File layout

| File | Δ |
|---|---|
| `selectors.js` | **+** `periodRangeForPreset`, `periodRangeForAll`, `txnsInPeriod`, `monthsInPeriod` (+ JSDoc) |
| `router.js` | **+** period state, `periodRange()`, `setPeriodPreset()`, `setPeriodRange()`, `resetPeriod()`, `defaultPresetFor()`, `boot()`; **~** `monthsForRange()` now a thin wrapper over `Selectors.monthsInPeriod(Router.periodRange())` |
| `app.js` | **~** `init()` now calls `Router.boot()` to restore the persisted period before the first render |
| `types.js` | **+** `PeriodPreset` and `Period` typedefs |
| `globals.d.ts` | **+** `Period` + `PeriodPreset` + new methods on `Window.Router` and `Window.Selectors` |
| `_test_period.js` | **new** — 34 assertions across 5 sections |
| `package.json` | **~** `npm test` now runs `_test_period.js` too |
| `eslint.config.js` | **~** `caughtErrorsIgnorePattern: '^_'` so `catch (_)` lints clean |
| `index.html` | **~** `?v=16` → `?v=17` |

### Period state shape

```js
period = {
  preset: '1m'|'3m'|'6m'|'1y'|'2y'|'all'|'custom',
  from:   'YYYY-MM-DD',  // ISO date, inclusive, snapped to first-of-month
  to:     'YYYY-MM-DD',  // ISO date, inclusive (clamped to today)
}
```

When `preset ∈ {1m, 3m, 6m, 1y, 2y, all}`, `from` / `to` are derived. When `preset === 'custom'`, `from` / `to` are user-set.

### Preset semantics (rolling)

| preset | months back (snap to first of month) | example (today = 2026-06-25) |
|---|---|---|
| `1m` | 0  | from 2026-06-01, to 2026-06-25 |
| `3m` | 2  | from 2026-04-01, to 2026-06-25 |
| `6m` | 5  | from 2026-01-01, to 2026-06-25 |
| `1y` | 11 | from 2025-07-01, to 2026-06-25 |
| `2y` | 23 | from 2024-07-01, to 2026-06-25 |
| `all` | earliest in-scope tx (snapped to first of month) | depends on data |

### Defaults per view

- `dashboard` → `1m`
- `trends` → `1y`
- Unknown view key → `1m` (fallback to dashboard)

### Router API additions

```js
Router.boot()                          // Called once from App.init()
Router.period                          // Read-only view of { preset, from, to }
Router.periodRange()                   // → { from, to }
Router.setPeriodPreset(preset)         // re-derive, persist, re-render
Router.setPeriodRange({ from, to })    // switches to 'custom', clamps to today, persists, re-renders
Router.resetPeriod(viewKey)            // returns to view's default preset
Router.defaultPresetFor(viewKey)       // '1m' for dashboard, '1y' for trends
```

### Persistence

- Storage key: `cozy.ledger.period`
- Stored shape: full `{ preset, from, to }` so a stale preset doesn't override the freshly-snapped range
- Read on `Router.boot()` (called from `App.init()`). Validated; falls back to dashboard default on any of:
  - Missing key
  - JSON parse error
  - `preset` not in known list
  - `from` / `to` not ISO dates
  - `from > to`
  - `to` in the future
- Wrapped in try/catch on both sides; localStorage being disabled (private mode) doesn't crash boot or break in-memory state.

### `monthsForRange` wrapper

Replaced with a thin wrapper that calls `Selectors.monthsInPeriod(Router.periodRange())`. Kept (not deleted) for ISSUE-016 to migrate the last `trendRange` callers without an interim regression. Will be deleted in ISSUE-016.

### Test results

| File | Before | After |
|---|---|---|
| `_test_csv.js` | 21 | 21 |
| `_test_selectors.js` | 73 | 73 |
| `_test_period.js` | — | **34** |
| `_test_boot.js` | 76 | 76 |
| **total** | 170 | **204** |

Lint: 0 errors, 11 pre-existing warnings (none introduced by this issue; the 2 new warnings were pre-empted by adding `caughtErrorsIgnorePattern: '^_'` to the ESLint config).

### Real-browser verification

```
Initial period:        { preset: '1m', from: '2026-06-01', to: '2026-06-25' }
After setPeriodPreset(3m):    { preset: '3m', from: '2026-04-01', to: '2026-06-25' }
After setPeriodRange(custom): { preset: 'custom', from: '2026-01-15', to: '2026-03-10' }
localStorage[cozy.ledger.period]: {"preset":"custom","from":"2026-01-15","to":"2026-03-10"}
After resetPeriod(trends):     { preset: '1y', from: '2025-07-01', to: '2026-06-25' }
After reload (persistence):    { preset: '1y', from: '2025-07-01', to: '2025-07-01' ✓
Shell render count after nav: 1   (ISSUE-010 invariant preserved)
Errors: none
```

### Known follow-ups (out of scope)

- ISSUE-014: build the `PeriodSelector` component that consumes this API.
- ISSUE-015: wire the dashboard to use `Selectors.txnsInPeriod(state, Router.periodRange())` everywhere.
- ISSUE-016: wire Trends, then delete `Router.monthKey`, `Router.trendRange`, `Router.monthsForRange`, and the `range-buttons` element.

### Decision log

- **`period` is a plain object, not a Map.** No nesting, no class — matches the existing `txnFilters` style and keeps editor intellisense simple.
- **`Router.boot()` is explicit, not auto-run at module load.** The pure `_test_period.js` loads `router.js` without booting it; the module-level body never touches localStorage, so the test harness stays clean.
- **`periodRangeForPreset` returns `null` for `all` / `custom` / unknown** rather than throwing. The Router wrapper interprets `null` as "this preset can't be derived here, skip the update" — which matches the existing pattern for invalid `setTrendRange` calls.
- **`setPeriodRange` clamps `to` to today silently** rather than rejecting the call. The user's intent ("the period ending today") is preserved; the chart will be self-correcting instead of leaving a future date in storage that would re-trigger the validation fallback on next boot.
- **Re-render on every mutation** so subscribers (Dashboard, Trends) stay in sync without us having to broadcast events. This matches the existing `setTrendRange` / `setBalanceViewMode` / `setTxnFilter` pattern.

## Blocked by

None.

## Out of scope

- The selector component (ISSUE-014).
- Wiring the dashboard or Trends view (ISSUE-015, ISSUE-016).
- Removing `Router.monthKey` — leave it; only delete once ISSUE-016 confirms no remaining references.
- Removing `Router.trendRange` and `Router.monthsForRange` — leave them; ISSUE-016 deletes them.
- i18n changes.