# ISSUE-011 — Split `app.js` by view

## Parent

[PRD-003] Refactor for maintainability — `docs/PRD/PRD-003-refactor-for-maintainability.md`

## What to build

After ISSUE-009 and ISSUE-010 land, `app.js` is still 1 800+ lines holding eight view renderers, six modal openers, two SVG chart builders, the shell, the router, and the state. Move each surface into its own file.

### 1. New file layout

```
cozy-ledger/
├── app.js                      # state, router, init only — under 600 lines
├── router.js                   # goTo, renderView, nav state
├── shell.js                    # renderSidebar, renderTopbar, scope pills, month picker
├── views/
│   ├── dashboard.js
│   ├── trends.js
│   ├── transactions.js
│   ├── categories.js
│   ├── sources.js
│   ├── users.js
│   ├── payees.js
│   └── settings.js
├── modals/                     # already created in ISSUE-009
│   ├── _helper.js
│   ├── transaction.js
│   ├── category.js
│   ├── group.js
│   ├── source.js
│   ├── user.js
│   └── import.js
├── charts/
│   ├── monthly-flow.js
│   └── balance-trajectory.js
└── ...                         # existing files unchanged
```

### 2. Module shape

Each view file follows the same shape:

```js
// views/dashboard.js
const Dashboard = (() => {
  function render() { /* ... */ }
  return { render };
})();
window.Dashboard = Dashboard;
```

No imports — modules share globals, matching the existing pattern (`Store`, `Selectors`, `Fmt`, `Icons`, `t`, `$`, `el` are all globals today).

The chart files are pure SVG-builders; they take pre-computed data and a host element and return nothing. Views call them.

The shell, router, and modals follow the same `(() => { ... })()` IIFE pattern.

### 3. `app.js` becomes the bootstrap

```js
const App = (() => {
  function init() {
    Shell.render();
    Router.go(currentView);
    bindGlobal();
  }
  function bindGlobal() {
    window.addEventListener('store:changed', () => {
      state = Store.load();
      Router.renderView();
    });
  }
  return { init };
})();
window.App = App;
```

### 4. `index.html` script tags

The existing `<script>` chain in `index.html` is extended. Loading order matters — pure modules first, then shell, then views, then modals, then `app.js`:

```html
<script src="data.js"></script>
<script src="utils.js"></script>
<script src="icons.js"></script>
<script src="selectors.js"></script>
<script src="i18n.js"></script>
<script src="csv.js"></script>
<script src="backup.js"></script>
<script src="router.js"></script>
<script src="shell.js"></script>
<script src="views/dashboard.js"></script>
<script src="views/trends.js"></script>
<script src="views/transactions.js"></script>
<script src="views/categories.js"></script>
<script src="views/sources.js"></script>
<script src="views/users.js"></script>
<script src="views/payees.js"></script>
<script src="views/settings.js"></script>
<script src="modals/_helper.js"></script>
<script src="modals/transaction.js"></script>
<script src="modals/category.js"></script>
<script src="modals/group.js"></script>
<script src="modals/source.js"></script>
<script src="modals/user.js"></script>
<script src="modals/import.js"></script>
<script src="app.js"></script>
```

A comment in `index.html` documents the order: pure → shell → views → modals → app.

## Acceptance criteria

- [x] `app.js` is under **600 lines** and contains only state, routing, shell mounting, init, and the `store:changed` listener.
- [x] Each view file is under **400 lines**.
- [x] Each modal file is under **80 lines** (modulo `Modal.create` itself).
- [x] Each chart file is under **250 lines**.
- [x] All eight views still render correctly (manual smoke test).
- [x] All six modals still open, save, cancel, and delete (where applicable).
- [x] `index.html` `<script>` tags are in dependency order, with a comment explaining the order.
- [x] `_test_boot.js` and `_test_selectors.js` still pass.
- [x] `npm run lint` still passes.
- [x] `python3 -m http.server` opens the app with no console errors.

## Blocked by

- [ISSUE-009](../ISSUES/ISSUE-009-modal-helper-extraction.md) — the modal helper must be extracted first so each modal file is a self-contained config.
- [ISSUE-010](../ISSUES/ISSUE-010-fix-re-render-storm.md) — the re-render fix must land first so the views are self-contained re-render units, not part of a re-render-storm chain.

## Out of scope

- Introducing ES modules (`<script type="module">`). The `<script>` tag chain stays for the no-build-step guarantee.
- A bundler.
- Renaming any globals.
- Lifting the chart math into pure helpers. Charts stay where they are; the test coverage from ISSUE-008 covers their inputs.

## Implementation log

Captured during implementation.

### What was built

After ISSUE-009 and ISSUE-010, `app.js` was still ~1 800 lines holding eight view renderers, six modal openers, two SVG chart builders, the shell, the router, and the state. ISSUE-011 splits that into the layout the issue spec asks for, with each view as a self-contained file under `views/`, the two SVG charts under `charts/`, the chrome under `shell.js`, and the route/dispatch under `router.js`. `app.js` is now the bootstrap.

### File layout

```
cozy-ledger/
├── app.js               75 lines — init, bindGlobal, public API
├── router.js           137 lines — view, month, filters, range; renderView()
├── shell.js            211 lines — sidebar, topbar, month picker, scope pills, in-place updaters
├── views/
│   ├── _helpers.js     115 lines — sum/emptyState/escape/field/option/extractPayee/distinctPayees/bulkUpdatePayeeCategory
│   ├── dashboard.js    228 lines — summary cards + donut + recent + top cats
│   ├── trends.js       221 lines — balance-flow card chrome (range toggle + balance inputs + chart mounts)
│   ├── transactions.js 195 lines — filter toolbar + table + row rendering
│   ├── categories.js   156 lines — groups card + expense section + income section
│   ├── sources.js       48 lines — sources grid
│   ├── users.js         46 lines — users grid
│   ├── payees.js        94 lines — payees table + bulk-assign dropdown
│   └── settings.js      74 lines — backup / restore card
└── charts/
    ├── _helpers.js      42 lines — dimensions, palette, colorForSource
    ├── monthly-flow.js 162 lines — heartbeat bars (per-month net flow)
    └── balance-trajectory.js 198 lines — per-source / net-worth trajectory line
```

All AC size limits met: `app.js` 75/600, every view < 400, every chart < 250, every modal opener still < 80 (unchanged from ISSUE-009).

### Module shape

Each view / chart file follows the same IIFE + `window.X = X` shape:

```js
const Dashboard = (() => {
  function render() { /* returns DOM element */ }
  return { render };
})();
window.Dashboard = Dashboard;
```

No imports — modules share globals, matching the pattern already in use for `Store`, `Selectors`, `Fmt`, `Icons`, `t`, `$`, `el`. The dependency graph is documented in a comment in `index.html` directly above the script chain.

### State hand-off

Closures over module-local `state`/`view`/`monthKey`/`txnFilters`/`balanceViewMode`/`trendRange` are gone. The state lives where it belongs:

- **`App._state`** (existing public getter) — the domain state object.
- **`Router.view`**, **`Router.monthKey`**, **`Router.txnFilters`**, **`Router.balanceViewMode`**, **`Router.trendRange`** (public getters) — the route state.
- **`Router.goTo(id)`**, **`Router.shiftMonth(±1)`**, **`Router.setTxnFilter(k,v)`**, **`Router.resetTxnFilters()`**, **`Router.setBalanceViewMode(mode)`**, **`Router.setTrendRange(range)`** — explicit mutators that always end with `renderView()`.

The mutator-only API keeps the route changes auditable: every state change goes through one of these functions, and each ends with a re-render.

### Chart decoupling

The two SVG charts (`renderMonthlyFlowChart`, `renderBalanceTrajectoryChart`) used to read `Router.balanceViewMode` directly and call `renderRangeButtons()` inline. They now live in their own files and take a pre-computed `opts` object: pre-resolved `months`/`series`, an `i18n` string bundle, and a pre-built `rangeButtons` DOM node. The trends view is responsible for the i18n, the data fetching, and the range buttons — the chart files just render the SVG and wire the tooltip.

The `colorForSource` helper that used to live inside `views/trends.js` moved to `charts/_helpers.js` (it's a chart concern, not a view concern) and is shared by both chart files.

### Modal load-order fix

`modals/transaction.js`, `modals/import.js`, and `modals/import-confirm.js` previously destructured `App` from `window` at module-load time:

```js
const { Store, Selectors, Modal, Icons, Fmt, CSVImport, App } = window;
```

That worked when `app.js` loaded first, but the new dependency order has modals loading before `app.js`, which left `App` bound to `undefined`. The destructures were replaced with `window.App` reads at call-time so the modules can load in any order.

### Stubs and tests

`_test_boot.js`'s script-load list is updated to match the new dependency order. All 76 boot tests pass unchanged. The `freshInit010` helper still works because `App._goTo`, `App._shellRenderCount`, `App._resetRenderCount`, and `App._state` all remain on the public surface. `App._resetRenderCount()` now delegates to `Shell.resetRenderCount()` (the counter lives on the Shell module that owns it).

### File-level changes

| File | Δ |
|---|---|
| `app.js` | **−1 644 lines** (1 719 → 75). Now bootstrap only. |
| `router.js` | **new**, 137 lines. |
| `shell.js` | **new**, 211 lines. |
| `views/_helpers.js` | **new**, 115 lines. |
| `views/dashboard.js` | **new**, 228 lines. |
| `views/trends.js` | **new**, 221 lines. |
| `views/transactions.js` | **new**, 195 lines. |
| `views/categories.js` | **new**, 156 lines. |
| `views/sources.js` | **new**, 48 lines. |
| `views/users.js` | **new**, 46 lines. |
| `views/payees.js` | **new**, 94 lines. |
| `views/settings.js` | **new**, 74 lines. |
| `charts/_helpers.js` | **new**, 42 lines. |
| `charts/monthly-flow.js` | **new**, 162 lines. |
| `charts/balance-trajectory.js` | **new**, 198 lines. |
| `index.html` | +12 script tags + a 32-line dependency-order comment; `?v=14` → `?v=15`. |
| `eslint.config.js` | +new files + new globals (`Router`, `Shell`, `Dashboard`, ..., `ChartHelpers`, `MonthlyFlow`, `BalanceTrajectory`). |
| `modals/transaction.js` | −3 lines (changed `App` destructure → `window.App._state` reads at call-time). |
| `modals/import.js` | same. |
| `modals/import-confirm.js` | same. |
| `_test_boot.js` | +3 entries in the script-load list. |

### Verification

- **Stub tests** (`_test_boot.js`): 76/76 pass (unchanged from ISSUE-010).
- **CSV tests**: 21/21.
- **Selectors tests**: 73/73.
- **`npm run lint`**: 0 errors, 14 pre-existing warnings (none introduced; the existing warnings live in `_test_boot.js`, `backup.js`, `data.js`, `utils.js`, and `modals/_helper.js`).
- **Real-browser Playwright** (viewport 1280×900, `?v=15`): navigated through all 8 views in sequence (dashboard → trends → transactions → categories → sources → users → payees → settings) with 5 transactions saved in between, plus 2 scope switches. `App._shellRenderCount` reads **1** at the end — the shell never re-renders. Both SVG charts render correctly with data (heartbeat bars + trajectory line). No page errors, no console errors.

### Test count progression

| File | Before (post-ISSUE-010) | After | New |
|---|---|---|---|
| `_test_csv.js` | 21 | 21 | 0 |
| `_test_boot.js` | 76 | 76 | 0 |
| `_test_selectors.js` | 73 | 73 | 0 |

No new tests needed: ISSUE-010's tests already exercise the split's public surface (`App.init`, `App._goTo`, `App._state`, `App._shellRenderCount`, `App._resetRenderCount`, `App.bulkUpdatePayeeCategory`), and all 76 still pass against the new file layout.

### Known follow-ups (out of scope here)

- **View-internal subscriptions.** Today `Router.renderView()` rebuilds the whole active view subtree on every `store:changed`. Each view could subscribe to `store:changed` directly and only re-render the affected slices (e.g. the transactions table without the filter bar). With the views already split into files, this is now a localised change rather than a refactor of one 1 800-line file.
- **Modal opener extraction from views.** `Sources` and `Users` and `Payees` open modals via `window.Modals.source(id)` etc. If the modals grew further (e.g. a multi-step user-onboarding flow), the call sites could move into shared helpers next to the bulk-assign flow. Today's `window.Modals.*` calls are short and read clearly at the use site, so the trade-off still favours inlining.