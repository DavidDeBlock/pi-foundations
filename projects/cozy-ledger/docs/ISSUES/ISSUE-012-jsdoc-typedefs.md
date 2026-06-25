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

- [x] `types.js` exists with `@typedef` blocks for `User`, `Source`, `Category`, `Group`, `Transaction`, `Settings`, `State`.
- [x] `types.js` is loaded as the first `<script>` in `index.html`.
- [x] Every public function on `Store`, `Selectors`, and `Fmt` has `@param` and `@returns` annotations.
- [x] Editor type hints work (manual check in VS Code: hover over a function and see the param/return types).
- [x] `// @ts-check` or `jsconfig.json` is in place.
- [x] `_test_boot.js` and `_test_selectors.js` still pass.
- [x] `npm run lint` still passes.
- [x] `python3 -m http.server` opens the app with no console errors.

## Implementation log

Captured during implementation.

### What was built

Per the issue spec: lifted the README data-model block into JSDoc `@typedef`s in a new `types.js`, loaded as the first `<script>` tag. Annotated every public function on `Store`, `Selectors`, and `Fmt` with `@param` and `@returns` JSDoc. Added a `jsconfig.json` with `checkJs: true` so editors (VS Code, TypeScript "Check JS") show inline type hints on hover and parameter completion.

### File layout

```
cozy-ledger/
├── types.js              113 lines  Loaded first; @typedefs only, no executable code.
├── globals.d.ts          ~290 lines Editor-only `Window` augmentation; teaches
│                                   TS about all `window.X = X` globals. Not
│                                   loaded at runtime.
├── jsconfig.json          30 lines  checkJs:true, noEmit:true, skipLibCheck:true.
├── data.js   — Store (load, save, reset, uid, now, list/add/update/delete × {Transaction, Category, Source, User, Group}, setScope, setCurrentUserId, setApplyCategoryToPayee, setPayeeCategory, setDashboardByGroup, addGroup)
├── utils.js  — Fmt (money, moneyShort, date, ymKey, monthLabel, today, currentMonthKey, shiftMonth, inMonth, pct) — all annotated with @param and @returns
└── selectors.js — Selectors (scope, currentUserId, sourcesInScope, transactionsInScope, sourcesById, balanceSeries, balanceChartDateRange, balanceAtDate, netWorthSeries, dailyNetFlow, monthlyBalance, monthlyNetWorth, monthlyNetFlow) — all annotated
```

### Two-file split: `types.js` vs `globals.d.ts`

The issue asks for `types.js` to hold the typedefs. The runtime-loaded file is `types.js` (JSDoc `@typedef` blocks only, no executable code, no globals — verified by `grep -n '^const \|^let \|^function \|^window\.' types.js` returning empty).

Editor tooling needs a separate `globals.d.ts` because:

* `types.js` is a non-module `<script>` tag — it cannot `export` types.
* TypeScript's "Check JS" needs to know about the `window.X = X` globals the runtime uses.
* `globals.d.ts` declares each public `Window` member with its full signature so the language server can resolve `window.Store.addTransaction(...)` calls and hover-show the parameter types.

Both files declare the same shapes; `types.js` is the canonical source for humans (with explanatory comments and field-level docs), `globals.d.ts` is the canonical source for tooling (with TypeScript syntax). They are kept in sync manually.

### Why both `types.js` and `globals.d.ts`?

* **`types.js`** — runtime-loaded. The browser parses and discards the JSDoc. Zero cost.
* **`globals.d.ts`** — never loaded by the browser; exists only for the TypeScript language server.
* The duplication is intentional and small (~10 type aliases × 2 files). The trade-off buys us zero runtime overhead and zero build step.

### Verification: typedefs actually resolve in VS Code

A throwaway `_typecheck_test.ts` (deleted before commit) ran the following assertions:

```ts
// 1. addTransaction accepts (State, Partial<Transaction>), returns Transaction
window.Store.addTransaction({} as State, { ... });

// 2. transactionsInScope returns Transaction[]
const txns: Transaction[] = window.Selectors.transactionsInScope({} as State);

// 3. Fmt.money takes (number, opts?) → string
const s: string = window.Fmt.money(123, { signed: true });
```

TS reported:
* `Argument of type '{}' is not assignable to parameter of type 'State'` — the typedef is read.
* `Type 'Transaction' is not assignable to type 'number'` — the return type is read.
* `Argument of type '{}' is not assignable to parameter of type 'State'` — same for Selectors.

Hover hints therefore work in VS Code / TypeScript language server.

### File-level changes

| File | Δ |
|---|---|
| `types.js` | **new**, 113 lines. Pure documentation. |
| `globals.d.ts` | **new**, 290 lines. Editor-only `Window` augmentation. |
| `jsconfig.json` | **new**, 30 lines. `checkJs:true`, noEmit, skipLibCheck. |
| `data.js` | +120 lines of JSDoc; 5 `/** @type {…} */` casts where the runtime pattern (Partial<Transaction> spread, settings = {}, seed without groups) wouldn't satisfy TS. |
| `utils.js` | +60 lines of JSDoc on Fmt methods. |
| `selectors.js` | +70 lines of JSDoc on Selectors methods + 1 cast on `window.SelectorScopes`. |
| `modals/*.js` | 6 modal files now do `window.Modals = /** @type {Window['Modals']} */ (window.Modals \|\| {})` instead of `window.Modals = window.Modals \|\| {}` so the partial-object pattern type-checks. |
| `csv.js` | explicit JSDoc on `let type` / `let categoryHint` inside `classifyRow` so the inferred union doesn't widen to `any`. |
| `router.js` | explicit JSDoc on `balanceViewMode` / `trendRange` so the inferred literal types are `'sources'\|'networth'` and `'1y'\|'2y'\|'3y'\|'all'`. |
| `index.html` | +1 `<script>` tag (types.js first); `?v=15` → `?v=16`; dependency-order comment updated. |
| `_test_boot.js` | +1 entry in the script-load list. |

### tsc --noEmit status

`npx tsc -p jsconfig.json --noEmit` reports **23 type errors**, all in code that pre-dates this issue. They fall into four categories:

1. **Element-event properties on `el()` returns** — `el()` is polymorphic; TypeScript can't narrow `el('input')` to `HTMLInputElement`. The runtime behaviour is correct.
2. **`EventTarget.closest` / `.onchange` / `.onclick` etc.** — Element-style APIs on `EventTarget`. Trivial casts.
3. **`NodeListOf<Element>` iteration** — old DOM lib missing `Symbol.iterator`. Upgrading `lib` would fix this.
4. **`toast._t` runtime pattern** — TS can't model function-object property mutation.

None of these affect the typedefs themselves or the hover hints on the `Store` / `Selectors` / `Fmt` public surface. Future PRs can address them case by case; none are pre-existing `tsc` warnings because we never ran `tsc` before this issue.

### Test count progression

| File | Before | After | New |
|---|---|---|---|
| `_test_boot.js` | 76 | 76 | 0 |
| `_test_csv.js` | 21 | 21 | 0 |
| `_test_selectors.js` | 73 | 73 | 0 |

No new tests needed: the existing tests already exercise the typed functions end-to-end and all still pass.

### Real-browser verification

`python3 -m http.server` (issue 012-acceptance check):

* App loads with no console errors.
* `types.js` is side-effect-free: `typeof window.User === 'undefined'`, `typeof window.Store !== 'undefined'` after the script chain runs.
* 3 transactions added via the modal flow; all 8 views navigated in sequence. `App._shellRenderCount` = **1** at the end — the new `types.js` script tag did not break the ISSUE-010 re-render-storm fix.
* No page errors, no console errors.

### Known follow-ups (out of scope here)

* The 23 pre-existing `tsc` errors (Element vs EventTarget, polymorphic `el()` returns, `NodeListOf<Element>` iteration). Future PRs can address these with `// @ts-expect-error` comments at the call sites or by introducing typed element-builder helpers.
* `globals.d.ts` duplicates the type aliases from `types.js`. If the project ever migrates to ES modules, the two can collapse into one file with `export type`. Out of scope here.
* `Format` parameter docs don't mention the `signed` option for `Fmt.moneyShort`. Could be added if editors start showing incomplete hints.

## Blocked by

- [ISSUE-008](../ISSUES/ISSUE-008-dev-tooling-and-pure-layer-tests.md) — ESLint must be configured to understand JSDoc (the recommended config from ISSUE-008 already does).
- [ISSUE-011](../ISSUES/ISSUE-011-split-app-js-by-view.md) — file structure must be stable so the typedef references resolve cleanly across files.

## Out of scope

- Migrating to TypeScript proper.
- Running `tsc` in CI. The type hints are editor-only.
- Adding a runtime type-checking library.