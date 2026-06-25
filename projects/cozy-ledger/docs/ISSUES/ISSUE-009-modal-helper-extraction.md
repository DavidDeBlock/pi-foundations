# ISSUE-009 — Modal helper extraction

## Parent

[PRD-003] Refactor for maintainability — `docs/PRD/PRD-003-refactor-for-maintainability.md`

## What to build

Extract the modal open/close/bind/save pattern into one helper, and refactor the six existing modal openers to use it.

### 1. New file `modals/_helper.js`

Exposes a global `Modal` object with one primary function:

```js
Modal.create({
  title: string,                    // shown in the modal head
  fields: FieldSpec[],               // declarative field list (see below)
  onSave: (values) => void | Promise, // receives collected form values
  onDelete?: () => void,             // optional; shows a delete button on the left
  onCancel?: () => void,             // optional; default closes the modal
  size?: 'sm' | 'md' | 'lg',         // default 'md'
});
```

`FieldSpec` covers the field shapes currently in use across the six modals:

```js
{
  id: 'f-amount',
  label: 'Amount',                   // optional; some fields have no label
  kind: 'number' | 'text' | 'date' | 'select' | 'textarea' | 'tabs' | 'scope-pick',
  value?: any,                       // initial value
  options?: [{ value, label }],      // for 'select'
  placeholder?: string,
  step?: string,                     // for 'number'
  rows?: [{                          // for 'form-row' layout
    fields: [FieldSpec, ...]
  }],
  visible?: (values) => boolean,     // optional conditional visibility
  onChange?: (value, values) => void,// optional side-effect (e.g. cascade re-populate)
}
```

The helper handles, with no caller code:

- Building the modal shell (`.modal > .modal-head > .modal-body > .modal-foot`).
- Escape-to-close.
- Click-on-backdrop-to-close.
- Focusing the first input on open.
- Save / Cancel / optional Delete buttons in the footer.
- Returning collected `values` to `onSave`.

### 2. Refactor the six modal openers

- `openTransactionModal(id)` → `modals/transaction.js` (new file). Body becomes a `fields: [...]` array plus an `onSave` that calls `Store.addTransaction` or `Store.updateTransaction`.
- `openCategoryModal(id)` → `modals/category.js`. Same pattern.
- `openGroupModal(id)` → `modals/group.js`.
- `openSourceModal(id)` → `modals/source.js`.
- `openUserModal(id)` → `modals/user.js`.
- `openImportModal()` → `modals/import.js`. Largest at 207 lines — split body construction (CSV preview rendering) from the modal config.

The `Modal` helper is loaded as a `<script>` tag in `index.html` *after* `utils.js` (which provides `$` and `el`) and *before* `app.js`.

### 3. App-level glue

In `app.js`, `openAddTransaction()`, `openEditTransaction(id)`, etc., become thin wrappers that look up the editing record and call `Modal.create({ ... })`. The `deleteTransaction(id)` and `Store.*` calls move into the modal files.

## Acceptance criteria

- [ ] `modals/_helper.js` exists and exposes `Modal.create`.
- [ ] All six modal openers are refactored to use the helper.
- [ ] Each of the six opener files is under **80 lines** (excluding `Modal.create` itself).
- [ ] Combined line count of `modals/_helper.js` + `modals/*.js` is **less than** the previous combined line count of the six functions in `app.js`.
- [ ] `Modal.create` handles: title, body, footer buttons (save / cancel / optional delete), escape-to-close, click-outside-to-close, focus first input, conditional field visibility.
- [ ] Each modal correctly persists its data via `Store.*` methods (no behavioural change).
- [ ] `_test_boot.js` and `_test_selectors.js` still pass.
- [ ] Manual smoke test for each modal: opens, saves, cancels, deletes (where applicable), escape closes, click-outside closes.
- [ ] `python3 -m http.server` opens the app with no console errors.

## Blocked by

[ISSUE-008](../ISSUES/ISSUE-008-dev-tooling-and-pure-layer-tests.md) — needs the test harness and lint guardrails before touching DOM-heavy code.

## Out of scope

- Splitting the file by view (that's ISSUE-011).
- Form-state vs DOM-state refactor inside the helper. The helper reads DOM values at save time and exposes them as `values` — that's the only contract.
- Introducing a templating language.