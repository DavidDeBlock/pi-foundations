# [PRD] Unified period selector for Dashboard & Trends

## Problem Statement

Today the Cozy Ledger app has **two unrelated notions of "time range"**:

- The Dashboard uses `Router.monthKey` — a single calendar month — and every widget on the dashboard is filtered with `Fmt.inMonth(x.date, monthKey)`. There is no way to look at "the last 3 months" or "the last year" on the dashboard without doing it mentally.
- The Trends view uses `Router.trendRange` with `1y / 2y / 3y / all` preset buttons, hard-coded to feed only the two trend charts. It cannot pick a custom range, and the dashboard cannot use the same selector.

The result is that:

1. The user cannot see "total income, total expenses, total savings over a chosen period" on the dashboard, which is what they actually want.
2. The Trends view shows a "Top categories this month" card that duplicates the dashboard's top-categories card for the same month. The user explicitly flagged this as redundant.
3. The two selectors have different shapes and vocabularies, so they feel like two unrelated features rather than one mental model.

## Solution

Introduce **one shared period concept** used by both views.

A reusable `PeriodSelector` component offers:

- **Preset pills**: `1m / 3m / 6m / 1y / 2y / all`
- **Manual from-to**: two native `<input type="date">` inputs (wrapped in app chrome)
- **Reset link**: returns to the view's default preset

The period is `{ preset, from, to }` state owned by `Router` (next to the other view state) and persisted to `localStorage` so it survives reloads.

The Dashboard and Trends views **both** mount the selector and **both** have all of their widgets (summary cards, donut, recent, top categories, monthly-flow chart, balance-trajectory chart) consume the same `Router.periodRange()` helper.

The Trends view drops its old `range-buttons` element and its hard-coded `1y / 2y / 3y / all` vocabulary, replacing it with the shared selector. It also drops the redundant "Top categories this month" card.

The Transactions page is **not** affected — its own filter bar (including its month picker) is independent of this work.

## User Stories

1. As a user, I want a preset selector on the dashboard (`1m / 3m / 6m / 1y / 2y / all`) so that I can see my income, expenses, and net savings for any of these periods at a glance.
2. As a user, I want the dashboard default to be `1m` (the current month) so that opening the app gives me the same "monthly overview" I have today.
3. As a user, I want every widget on the dashboard (summary cards, donut, recent transactions, top categories) to follow the selected period so that I get a coherent picture rather than a monthly view glued to a multi-month summary.
4. As a user, I want a manual from-to picker (two date inputs) so that I can pick a precise range that doesn't match any preset.
5. As a user, I want to be able to reset back to the view's default so that I can quickly return to the "this month" or "last year" overview.
6. As a user, I want the Trends view to use the same selector with the same presets so that I don't have to learn two different controls.
7. As a user, I want the Trends view default to be `1y` so that the charts have enough history to be meaningful without flooding the screen.
8. As a user, I want the top-categories card to live only on the dashboard so that Trends isn't redundant.
9. As a user, I want the selected period to persist across page reloads so that I don't have to re-pick it every time I come back.
10. As a user, I want preset semantics that match my mental model: `3m` means "the last 3 calendar months ending today" (rolling, not "current month + 2 previous").

## Implementation Decisions

### State shape

A single object on `Router`:

```js
period = {
  preset: '1m' | '3m' | '6m' | '1y' | '2y' | 'all' | 'custom',
  from:   'YYYY-MM-DD',  // ISO date, inclusive
  to:     'YYYY-MM-DD',  // ISO date, inclusive
}
```

- When `preset` is one of `1m / 3m / 6m / 1y / 2y / all`, `from` and `to` are **derived** from the preset and the current date (rolling).
- When `preset === 'custom'`, `from` and `to` are **user-set** and not auto-derived.
- Editing a date input switches `preset` to `'custom'`.
- The "reset" affordance sets `preset` to the view default (`1m` for dashboard, `1y` for trends) and re-derives `from` / `to`.

### Defaults per view

- **Dashboard**: default `preset = '1m'`, which resolves to `[first of current month, today]`.
- **Trends**: default `preset = '1y'`, which resolves to `[today minus 12 months (first-of-month), today]`.

A per-view default map lives in `Router` so the same selector component can ask "what's my default?".

### Preset semantics (rolling)

For each preset, given "today" = `2026-06-25`:

- `1m` → `from = 2026-06-01`, `to = 2026-06-25`
- `3m` → `from = 2026-04-01`, `to = 2026-06-25`
- `6m` → `from = 2026-01-01`, `to = 2026-06-25`
- `1y` → `from = 2025-07-01`, `to = 2026-06-25`
- `2y` → `from = 2024-07-01`, `to = 2026-06-25`
- `all` → `from = earliest transaction date in scope`, `to = today`

All `from` values snap to the first of the month to keep the chart x-axis tidy.

### Persistence

- Storage key: `cozy.ledger.period`.
- Stored shape: `{ preset, from, to }` (the full resolved range, not just the preset). On load, the preset is re-derived from `from`/`to` so a stale preset doesn't override a freshly-snapped range.
- If the stored `to` is in the future or `from > to`, fall back to the view default — don't crash.

### Ownership

`Router` owns the state. `Selectors` (in `selectors.js`) owns the pure helpers:

- `Selectors.periodRange(state)` → `{ from, to }` (returns `Router.periodRange()` today; reserved for testability).
- `Selectors.txnsInPeriod(state, { from, to })` → filters in-scope transactions by date range.
- `Selectors.monthsInPeriod({ from, to })` → ordered list of `YYYY-MM` strings covered by the range, capped at 240 (20 years) for chart safety.

### Component

`views/_period-selector.js` exposes `PeriodSelector.render(viewKey)` returning a DOM element suitable for mounting in a view header. It owns:

- The pill buttons (one per preset).
- The two date inputs.
- The "reset" link.

It reads/writes `Router.period` and calls `Router.renderView()` on any change.

### What goes away

- `Router.trendRange` (string).
- `Router.setTrendRange(range)`.
- `Router.monthsForRange(range)` (replaced by `Selectors.monthsInPeriod`).
- `Router.monthKey` stays (used by the dashboard's month picker on transactions page, and as a fallback inside `1m` derivation if needed — not removed unless shown to be unused).
- The `range-buttons` element on `views/trends.js`.
- The top-categories card on `views/trends.js` (it duplicates the dashboard's card).
- i18n keys: `trends.range.1y`, `trends.range.2y`, `trends.range.3y`, `trends.range.all`.

### New i18n keys (Dutch)

```
period.label       'Periode'
period.preset.1m   '1 maand'
period.preset.3m   '3 maanden'
period.preset.6m   '6 maanden'
period.preset.1y   '1 jaar'
period.preset.2y   '2 jaar'
period.preset.all  'Alles'
period.from        'Van'
period.to          'Tot'
period.reset       'Standaard'
```

## Testing Decisions

- **What makes a good test**: pure helpers in `selectors.js` are tested at the function level using the existing Node test pattern (`_test_*.js`, no jsdom). Boot smoke tests in `_test_boot.js` cover the selector mounting and event wiring.
- **Pure functions to test**:
  - Each preset's `from`/`to` derivation for at least 3 "today" dates (1st of month, 15th, last day).
  - `all` resolves to earliest in-scope transaction.
  - `Selectors.txnsInPeriod` boundary cases (`from` inclusive, `to` inclusive, txns on the boundary date).
  - `Selectors.monthsInPeriod` length and ordering, including the 240-month cap.
  - Persistence: write to `localStorage`, read back, verify state.
- **Boot smoke**: selector renders on both views; clicking each preset updates `Router.period` and re-renders; editing a date input switches `preset` to `'custom'`.
- **Out of test scope**: pixel-perfect pill styling, native date-picker locale formatting.

## Children

- `ISSUE-013` — Period state + pure helpers + tests
- `ISSUE-014` — Period selector component
- `ISSUE-015` — Dashboard period wiring
- `ISSUE-016` — Trends period wiring + cleanup

## Out of Scope

- Translating user-entered content (transaction descriptions, notes, payee names).
- Per-user periods, per-source periods, or any scope other than "the current view's default".
- A standalone "Reports" page with its own date picker.
- Changing how the Transactions page filters by month — its existing filter bar stays untouched.
- Anything about category groups, sources, or other entities.
- A "fiscal year" or "quarter" preset.
- Keyboard shortcuts for switching presets.