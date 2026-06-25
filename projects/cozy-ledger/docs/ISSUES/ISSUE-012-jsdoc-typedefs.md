# ISSUE-012 — JSDoc typedefs for the data model

## Parent

[PRD-003] Refactor for maintainability — `docs/PRD/PRD-003-refactor-for-maintainability.md`

## What to build

The data model (`Transaction`, `Category`, `Source`, `User`, `Group`, `Settings`, `State`) is documented in the README as a TypeScript-shaped block. Lift that into JSDoc `@typedef`s so editors give inline type hints — zero runtime cost, no build step.

### 1. New file `types.js` (loaded first in `index.html`)

Contains only `@typedef` blocks — no executable code:

```js
/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} name
 * @property {string} color        Hex colour
 * @property {boolean} active
 */

/**
 * @typedef {Object} Source
 * @property {string} id
 * @property {string} name
 * @property {'bank'|'cash'|'savings'|'other'} type
 * @property {string|null} ownerId  null = shared
 * @property {boolean} active
 * @property {number} balance
 */

/**
 * @typedef {Object} Category
 * @property {string} id
 * @property {string} name
 * @property {'income'|'expense'} type
 * @property {string} color
 * @property {string} icon         Emoji or short label
 * @property {boolean} active
 * @property {string|null} [groupId]
 */

/**
 * @typedef {Object} Group
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} icon
 * @property {number} order
 * @property {boolean} active
 */

/**
 * @typedef {Object} Transaction
 * @property {string} id
 * @property {'income'|'expense'} type
 * @property {number} amount
 * @property {string} date          ISO YYYY-MM-DD
 * @property {string} description
 * @property {string} categoryId
 * @property {string} paidByUserId
 * @property {string} sourceId
 * @property {'private'|'shared'} scope
 * @property {string} notes
 * @property {string} createdAt     ISO 8601
 * @property {string} updatedAt     ISO 8601
 * @property {string} [importedKey] Set by CSV import for dedup
 */

/**
 * @typedef {Object} Settings
 * @property {string} currentUserId
 * @property {'private'|'shared'|'all'} scope
 * @property {boolean} applyCategoryToPayee
 * @property {boolean} dashboardByGroup
 */

/**
 * @typedef {Object} State
 * @property {User[]} users
 * @property {Source[]} sources
 * @property {Category[]} categories
 * @property {Group[]} groups
 * @property {Transaction[]} transactions
 * @property {Object<string,string>} payeeCategories
 * @property {Settings} settings
 */
```

`types.js` is loaded as the **first** script in `index.html`, before `data.js`. Its only effect is providing typedefs — no globals, no executable code.

### 2. Annotate public functions

Add `@param` and `@returns` to every public function on `Store`, `Selectors`, and `Fmt`:

- `Store.load() → State`
- `Store.addTransaction(state: State, t: Partial<Transaction>) → Transaction`
- `Store.updateTransaction(state: State, id: string, patch: Partial<Transaction>) → Transaction | null`
- `Selectors.transactionsInScope(state: State) → Transaction[]`
- `Selectors.balanceSeries(state: State, sourceId: string) → { date: string, balance: number }[]`
- `Fmt.money(n: number, opts?: { signed?: boolean }) → string`
- …and so on for every entry in their public surface.

### 3. Editor hint

Add a `jsconfig.json` (or `// @ts-check` at the top of each annotated file) so editors run JSDoc-based type checking. Choose one — the issue proposes `// @ts-check` per file as the lighter touch; `jsconfig.json` is fine if preferred.

## Acceptance criteria

- [ ] `types.js` exists with `@typedef` blocks for `User`, `Source`, `Category`, `Group`, `Transaction`, `Settings`, `State`.
- [ ] `types.js` is loaded as the first `<script>` in `index.html`.
- [ ] Every public function on `Store`, `Selectors`, and `Fmt` has `@param` and `@returns` annotations.
- [ ] Editor type hints work (manual check in VS Code: hover over a function and see the param/return types).
- [ ] `// @ts-check` or `jsconfig.json` is in place.
- [ ] `_test_boot.js` and `_test_selectors.js` still pass.
- [ ] `npm run lint` still passes.
- [ ] `python3 -m http.server` opens the app with no console errors.

## Blocked by

- [ISSUE-008](../ISSUES/ISSUE-008-dev-tooling-and-pure-layer-tests.md) — ESLint must be configured to understand JSDoc (the recommended config from ISSUE-008 already does).
- [ISSUE-011](../ISSUES/ISSUE-011-split-app-js-by-view.md) — file structure must be stable so the typedef references resolve cleanly across files.

## Out of scope

- Migrating to TypeScript proper.
- Running `tsc` in CI. The type hints are editor-only.
- Adding a runtime type-checking library.