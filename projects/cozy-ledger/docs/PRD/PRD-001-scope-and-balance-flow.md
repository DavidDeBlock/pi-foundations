# [PRD] Scope-aware dashboard + balance flow chart

## Problem Statement

Today the Cozy Ledger dashboard mixes every account together — David's private, Isabelle's private, the joint account, cash, savings — into a single "this month" view. The user owns two kinds of accounts they think about differently: their private bank account, and the household's shared account. They want to look at one or the other without switching data or mentally filtering.

They also have no way to see how the balance on an account has moved over time. The current "Balance" card on the dashboard is a monthly delta (income minus expense), not a real account balance. To answer "what was my balance in March?" or "is my bank number consistent with what I've logged?" they have to do it in their head, by hand.

## Solution

Introduce a **scope** at the top of the dashboard — `Private`, `Shared`, `All` — that filters every aggregation on the page to a coherent slice of accounts. Default to `Private` so the dashboard continues to behave as a personal overview. The user's own accounts are recognised from a small `currentUserId` setting (defaulted to the first user, no UI yet).

Add a new **balance flow** chart as a full-width card at the bottom of the dashboard. The user types their current bank-app balance for each account once. The chart walks backwards through every transaction on that source, drawing the historical balance as a step line. A toggle switches between per-source lines and a single net-worth line that sums them.

Existing dashboard cards (monthly income, expenses, "balance" delta, shared-vs-private, top categories, donut, recent) all stay — they now respect the active scope.

## User Stories

1. As a user with both a private and a shared account, I want to switch the dashboard between `Private`, `Shared`, and `All` views, so that I can focus on what matters to me in each context.
2. As a user, I want the `Private` view to default to my own accounts only, so that the dashboard opens to my personal overview without setup.
3. As a user, I want the scope I selected to persist across page reloads, so that I don't have to re-pick it every time.
4. As a user, I want the transactions list page to respect the same scope, so that results stay consistent across screens.
5. As a user, I want the month picker to keep working inside the selected scope, so that I can drill into a specific month.
6. As a user, I want the spending-share donut to feel less squeezed, so that it gets visual room to breathe.
7. As a user, I want a new balance-over-time chart on the dashboard, so that I can see how my account balance has evolved over months.
8. As a user, I want to type my current bank-app balance for each account once, so that the chart anchors to a trusted, real value.
9. As a user, I want the chart to compute historical balances backwards from my typed current balance, so that I don't have to dig out an old statement to anchor the past.
10. As a user, I want the chart's time axis to run left-to-right with the oldest data on the left and today on the right, so that the line reads in the natural direction.
11. As a user, I want each source's balance to be drawn as its own line in the per-source view, so that I can compare accounts visually.
12. As a user, I want a net-worth view that aggregates all sources into one line, so that I can see my overall financial trajectory at a glance.
13. As a user, I want a toggle between the per-source view and the net-worth view, so that I can switch between detail and summary without losing context.
14. As a user, I want to hover/tap a point on the chart to see the date and the balance at that point, so that I can read precise values.
15. As a user, I want my typed current balance to be saved per source, so that I only type it once per account.
16. As a user, I want the chart to use a step-line style, so that balances only change at transaction dates — not on idle days.
17. As a user, I want the dashboard's existing monthly "Balance" card (income minus expense) to stay unchanged, so that I keep my current overview exactly as it is.
18. As a user, I want the scope filter to apply to the trend chart, donut, and recent transactions, so that all aggregations stay consistent.
19. As a user, I want the balance flow chart to respect the active scope, so that switching to `Shared` shows only the shared accounts' lines.
20. As a user, I want all the new logic (scope, balances, chart) to live alongside the existing app, with no build step and no new dependencies, so that the project keeps its single-folder simplicity.

## Implementation Decisions

- **`Store` extension**: three small, persisted changes.
  - `settings.currentUserId: string` — the "viewer" whose accounts make up `Private`. Defaulted to the first user on load if missing.
  - `settings.scope: 'private' | 'shared' | 'all'` — the active dashboard scope. Defaulted to `'private'` on load.
  - `source.balance: number` — the current bank-app balance for that source, typed by the user. Defaulted to `0` per source on load if missing.
  - Migration runs on `Store.load()` and is idempotent: any missing field is filled in with its default. Saves still go through the existing `store:changed` event.

- **Scope filter semantics**:
  - `private` → sources where `source.ownerId === settings.currentUserId`.
  - `shared` → sources where `source.ownerId === null`.
  - `all` → every source.
  - A transaction is "in scope" iff its `sourceId` belongs to a source that is in scope.
  - The `Transaction.scope` field (`'private' | 'shared'`) is a per-transaction tag used by the existing shared-vs-private card; it is **not** the primary scope filter.

- **New selector module** (`Selectors`, new file or grouped in `utils.js`): a small set of pure functions over state. `sourcesInScope(state)`, `transactionsInScope(state)`, `balanceSeries(state, sourceId)` (walks the source's transactions backwards from the latest date, anchoring the latest point at `source.balance`), and `netWorthSeries(state)` (aligns each in-scope source's balance series by date and sums them into a single combined series).

- **`BalanceChart` component** (`app.js` or new `balanceChart.js`): a vanilla SVG step-line chart, no charting library. Inputs: an array of `{ sourceId, points: [{ date, balance }] }` and a `viewMode` of `'per-source' | 'net-worth'`. Renders one line per source in per-source mode (thinner stroke) and one heavier line in net-worth mode. Includes hover/tap tooltips showing the date and balance. Includes an inline number input per source for the typed current balance, with a "saved" indicator after the value is persisted. Toggle UI to switch view mode.

- **App integration**: a `renderScopeSelector()` mounted in the topbar under or beside the month picker, wired to update `settings.scope` and re-render. The dashboard aggregations (summary cards, trend chart, donut, recent list, transactions list page) all read the in-scope data via the new selectors. The donut moves to a full-width row in the dashboard grid so it has visual room.

- **No new dependencies, no build step.** Charts are inline SVG. State is still in `localStorage`. The `<script>` tag loading order in `index.html` grows by one (the new selector module loads before `app.js`).

## Testing Decisions

- **What makes a good test here**: pure functions (scope filtering, balance computation, net-worth aggregation) are tested at the function level using the existing Node test pattern (`_test_*.js` files, no jsdom). The boot smoke test is extended with stubbed-DOM assertions that the scope selector mounts and the balance chart card renders.

- **Modules to test**:
  - **Selectors**: scope filter returns the right sources/transactions for each scope; missing/null `ownerId` is treated as shared.
  - **Balance math**: `balanceSeries` walks backwards from `source.balance` correctly. Zero-transaction source returns a single point. Net-worth series sums aligned dates correctly.
  - **Boot smoke**: scope selector present in DOM; balance flow card present; toggling scope updates `settings.scope` and triggers `store:changed`.

- **Out of test scope**: visual rendering of the SVG chart, tooltip interaction, CSS layout. These are reviewed manually.

- **Prior art**: the existing `_test_csv.js` (pure-function tests for the CSV pipeline) and `_test_boot.js` (stubbed-DOM boot smoke) define the testing pattern to follow.

## Out of Scope

- "Viewing as" UI to switch `currentUserId` between users. The setting exists; the UI does not.
- A dedicated `/reports` page (yearly summary, custom date range, category trends). Reported as a follow-up.
- PDF / print export of any chart.
- Automatic detection of missing transactions (e.g. "you probably forgot a €42 expense last Tuesday").
- Multi-currency balance reconciliation.
- Migrating the store to a real backend.

## Further Notes

- The decision to anchor the chart backwards from a typed current balance is the key insight — it removes the need for any historical anchor and keeps the math trivial.
- The "spending share gets more room" change is layout-only and lives next to the scope selector work because both touch the dashboard grid.
- The chart should keep the warm visual language of the rest of the app: muted line colors drawn from the existing palette in `styles.css`, no harsh axes, a soft horizontal grid, and the existing decorative SVGs available as optional background flourishes.
