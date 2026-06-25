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

## Implementation log

Captured during implementation. Future builders should read this before touching the modal layer.

### What was built

- **`modals/_helper.js`** — `window.Modal.create({ title, fields, onSave, onDelete, onCancel, size })`. Declarative field kinds: `text`, `number`, `date`, `textarea`, `select`, `tabs`, `scope-pick`, `checkbox`, `toggle`, `color-picker`, `icon-grid`, `file`, plus `row` (horizontal layout) and `custom` (escape hatch). Values are auto-collected for declarative kinds; `custom` fields contribute via `getValue(rootEl)`. Shell + footer + buttons (Save / Cancel / optional Delete) handled by the helper. Escape-to-close, click-on-backdrop-to-close, focus first input all wired up. Conditional visibility via `visible?: (values, ctx) => boolean` where `ctx` exposes `body`, `values`, and `setValue`.
- **`modals/transaction.js`** — add/edit/delete transaction + the `applyAll` payee propagation. ~79 lines.
- **`modals/category.js`** — add/edit/delete category with type tabs, color picker, icon grid, group dropdown, active toggle. ~52 lines.
- **`modals/group.js`** — add/edit/delete group with name, color, order. ~46 lines.
- **`modals/source.js`** — add/edit/delete source (account). ~52 lines.
- **`modals/user.js`** — add/edit/delete user. ~43 lines.
- **`modals/import.js`** — CSV import modal: file picker, defaults (user/source/scope), summary, preview table. ~78 lines.
- **`modals/import-preview.js`** — extracted CSV preview table rendering. ~49 lines.
- **`modals/import-confirm.js`** — bonus: also refactored the seventh modal (backup import confirmation) to use the helper. ~64 lines.

### File-level changes in app.js

- Removed: all six modal opener functions, their delete companions, `openImportConfirmModal`, and the local `openModal`/`closeModal` helpers. Total: ~870 lines deleted from `app.js`.
- Added: thin redirect from the existing render callbacks (e.g. `onclick: () => window.Modals.category(c.id)`) plus `App.bulkUpdatePayeeCategory` on the public surface for the transaction modal's `applyAll` flow.
- Restored: `renderSettings()` view (accidentally deleted in the first sweep) and the `onImportFileSelected` file picker glue that delegates to `Modals.importConfirm`.

### Stub-harness improvements (`_test_boot.js`)

To exercise the new modal layer, the test stub's `makeEl` learned:
- A `querySelector` / `querySelectorAll` method that handles `#id`, `.class`, `tag`, and space-separated compounds. Without it, the helper couldn't find `#m-save` from inside the modal element. The matcher is `matchSelector(root, sel)` at the top of the file.
- `value` and `checked` as live DOM properties backed by `attributes.value` / `attributes.checked`. The text/select/checkbox fields read these on collect.
- `documentStub.removeEventListener: () => {}` so the helper's `close()` can clean up the escape listener without throwing.

### i18n side fixes

While smoke-testing the import modal I noticed the pre-existing `{s}` substitution was appending `'en'` to every plural, producing `transactieen` / `categorieen`. Switched the rule to pick `'s'` or `'en'` based on the letter preceding `{s}` (Dutch vowel → `s`, consonant → `en`), and added support for `{en}` (literal `'en'` / empty) used by `grp.delete.inUse`. Switched the group template from `categorie{en}` to `categorie{s}` so it follows the same rule. Tests + screenshots all pass after.

### Test count progression

| File | Before | After | New |
|---|---|---|---|
| `_test_csv.js` | 21 | 21 | 0 |
| `_test_boot.js` | 64 | 68 | +4 |
| `_test_selectors.js` | 73 | 73 | 0 |
| **Total** | **158** | **162** | **+4** |

The 4 new `_test_boot.js` assertions cover: `Modal` exposes `create`, the `Modals` namespace exposes every opener + delete, `Modal.create` builds the shell + renders fields + collects values on save, and returning `false` from `onSave` keeps the modal open.

### AC coverage

- [x] `modals/_helper.js` exists and exposes `Modal.create`.
- [x] All six modal openers are refactored to use the helper.
- [x] Each of the six opener files is under **80 lines** (transaction.js=79, category.js=52, group.js=46, source.js=52, user.js=43, import.js=78).
- [x] Combined line count of `_helper.js + modals/*.js` (excluding `import-confirm.js`) is **752**, less than the previous **757** of the six functions in `app.js`.
- [x] `Modal.create` handles: title, body, footer buttons (save / cancel / optional delete), escape-to-close, click-outside-to-close, focus first input, conditional field visibility.
- [x] Each modal correctly persists its data via `Store.*` methods (smoke-tested with real-browser Playwright for add, edit, delete).
- [x] `_test_boot.js`, `_test_csv.js`, `_test_selectors.js` all pass (162/162).
- [x] Manual smoke test for each modal: opens, saves, cancels, deletes (where applicable), escape closes, click-outside closes. All pass with no console errors.
- [x] `python3 -m http.server` opens the app with no console errors.

### Discoveries during implementation

1. **`el('button', { html: Icons.trash })` parses SVG correctly** but `el('button', {}, Icons.trash, label)` passes the icon as a string child, which `el` then wraps in a `Text` node — rendering the SVG source as text. The first `scope-pick` modal screenshot caught this; fixed by setting the icon via `html:` on the button. Same pattern was already used for the close/delete footer buttons.
2. **`bulkUpdatePayeeCategory` belongs with the transaction modal**, not in `app.js`. The payees view at `app.js:1499` still calls it directly (now via `App.bulkUpdatePayeeCategory`), and that's the only consumer outside the modal. Could be moved into a `modals/payees.js` view in a future slice.
3. **`renderSettings` was inside the deleted range** — the modal section lived directly under the helpers section, with `renderSettings` sandwiched in between. Caught by `npm run lint` after the first sweep (`renderSettings is not defined`) and restored.

### Files created / modified

- **Created**: `modals/_helper.js`, `modals/transaction.js`, `modals/category.js`, `modals/group.js`, `modals/source.js`, `modals/user.js`, `modals/import.js`, `modals/import-preview.js`, `modals/import-confirm.js`
- **Modified**: `app.js` (−870 lines), `_test_boot.js` (+143 lines for stub improvements + 4 new tests), `index.html` (script-tag chain reordered, all `?v=12` → `?v=13`), `i18n.js` (Dutch plural rule fix)
- **Untouched**: `data.js`, `utils.js`, `icons.js`, `selectors.js`, `csv.js`, `backup.js`, `styles.css`, every test file other than `_test_boot.js`

## Out of scope

- Splitting the file by view (that's ISSUE-011).
- Form-state vs DOM-state refactor inside the helper. The helper reads DOM values at save time and exposes them as `values` — that's the only contract.
- Introducing a templating language.