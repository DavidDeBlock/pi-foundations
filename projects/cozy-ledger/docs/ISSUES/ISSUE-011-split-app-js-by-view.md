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

- [ ] `app.js` is under **600 lines** and contains only state, routing, shell mounting, init, and the `store:changed` listener.
- [ ] Each view file is under **400 lines**.
- [ ] Each modal file is under **80 lines** (modulo `Modal.create` itself).
- [ ] Each chart file is under **250 lines**.
- [ ] All eight views still render correctly (manual smoke test).
- [ ] All six modals still open, save, cancel, and delete (where applicable).
- [ ] `index.html` `<script>` tags are in dependency order, with a comment explaining the order.
- [ ] `_test_boot.js` and `_test_selectors.js` still pass.
- [ ] `npm run lint` still passes.
- [ ] `python3 -m http.server` opens the app with no console errors.

## Blocked by

- [ISSUE-009](../ISSUES/ISSUE-009-modal-helper-extraction.md) — the modal helper must be extracted first so each modal file is a self-contained config.
- [ISSUE-010](../ISSUES/ISSUE-010-fix-re-render-storm.md) — the re-render fix must land first so the views are self-contained re-render units, not part of a re-render-storm chain.

## Out of scope

- Introducing ES modules (`<script type="module">`). The `<script>` tag chain stays for the no-build-step guarantee.
- A bundler.
- Renaming any globals.
- Lifting the chart math into pure helpers. Charts stay where they are; the test coverage from ISSUE-008 covers their inputs.