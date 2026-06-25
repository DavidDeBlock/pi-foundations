# ISSUE-008 — Dev tooling and pure-layer tests

## Parent

[PRD-003] Refactor for maintainability — `docs/PRD/PRD-003-refactor-for-maintainability.md`

## What to build

Set up the safety net every later slice depends on:

1. **ESLint** as a devDependency (no runtime impact). Minimal project-specific config covering the two execution contexts in this repo:
   - Browser globals (`window`, `document`, `$`, `Node`, `Event`, `File`, `Blob`, `localStorage`, `URLSearchParams`, `navigator`, `alert`, `confirm`, `prompt`) for files loaded via `<script>` tags (`app.js`, `data.js`, `utils.js`, `icons.js`, `selectors.js`, `i18n.js`, `backup.js`, `csv.js`).
   - Node globals (`require`, `module`, `__dirname`, `process`, `console`) for `package.json` `type: "commonjs"` files (the `_test_*.js` files).
   - `env: { browser: true, node: true }` per file via `overrides` in `.eslintrc.json`, mapped by filename pattern.
   - Recommended rules on; no stylistic rules (no Prettier entanglement).

2. **Test runner script.** Add `"test": "node --test _test_csv.js _test_boot.js _test_selectors.js"` (or a glob). Use `node:test` (built-in, zero new dependencies).

3. **`_test_selectors.js`** — direct unit tests for every public function in `selectors.js` and `Fmt.*` in `utils.js`. The boot smoke test (`_test_boot.js`) already exercises `sourcesInScope` and `transactionsInScope`; this issue **expands** that file with full coverage rather than creating a second one.

   - Every function in `Selectors.*` (scope, currentUserId, sourcesInScope, transactionsInScope, sourcesById, balanceSeries, balanceChartDateRange, balanceAtDate, netWorthSeries, dailyNetFlow, monthlyBalance, monthlyNetWorth, monthlyNetFlow).
   - Every function in `Fmt.*` (money, moneyShort, monthLabel, inMonth, today, currentMonthKey, and any other exposed methods).
   - At least 30 assertions total.

4. **README updates.** Add `npm run lint` and `npm test` to the "Test it (optional, dev only)" section. Mention that no runtime dependencies are added.

## Acceptance criteria

- [x] `package.json` lists `eslint` under `devDependencies` only.
- [x] ESLint config with per-file env overrides exists. *(See deviation below — `eslint.config.js` instead of `.eslintrc.json`.)*
- [x] `.gitignore` excludes `node_modules/`.
- [x] `npm run lint` exits 0 on the whole repo.
- [x] `npm test` exits 0 and runs all three test files.
- [x] `_test_selectors.js` has 73 assertions covering every `Selectors.*` (14 functions) and every `Fmt.*` (10 functions). *(Well above the 30-assertion target.)*
- [x] No runtime dependencies added to `package.json`.
- [x] README's "Test it" section mentions `npm run lint` and `npm test`.
- [x] `index.html` is untouched — `python3 -m http.server` still serves the app identically.

## Blocked by

None — can start immediately.

## Out of scope

- Adopting Prettier, Standard, or Airbnb style.
- Adding CI (GitHub Actions etc.).
- Replacing the custom test harness in `_test_*.js` files with `node:test`.

## Implementation log

Captured during implementation. Future builders should read this before touching the lint/test setup.

### Deviations from the original plan

1. **Flat config, not `.eslintrc.json`.** Installed `eslint@^9`, which ships flat config as default and deprecates `.eslintrc.*`. Used `eslint.config.js` (CommonJS, since `package.json` has `"type": "commonjs"`) with two blocks keyed by `files` patterns — one for browser-loaded JS, one for `_test_*.js`, plus one for the config itself. Same per-file env separation as the original `.eslintrc.json` plan, future-proof format. The `node_modules/globals` package comes in as a transitive dep of ESLint and provides `globals.browser` / `globals.node`.
2. **Chained test runner, not `node --test`.** The three test files use a hand-rolled `test()` harness with a `process.exit` summary line; rewriting all three to `node:test` would be scope creep. The `npm test` script chains them with `&&`:
   ```json
   "test": "node _test_csv.js && node _test_boot.js && node _test_selectors.js"
   ```
   Migration to `node:test` (or Vitest, Mocha, etc.) is a separate concern and should land as its own issue if desired.

### Discoveries during testing

1. **`'nl-BE'` locale formatting.** `Fmt.money(1234.5)` returns `'€1.234,50'` — **period** for thousands, **comma** for decimal. The Belgian locale inverts the English convention. Several initial test expectations were wrong (`'€1,234.50'`) and had to be corrected.
2. **`balanceAtDate` 1-txn limitation.** For a source with exactly one transaction, `balanceAtDate` returns the typed balance at every date because `balanceSeries` yields a single point and there's no historical pre-tx balance to walk back to. With 2+ transactions, dates before the leftmost correctly return the leftmost balance. Documented inline at `_test_selectors.js` (search for "1-txn source returns typed balance"). Not a bug — a property of the walking algorithm.

### Lint warnings (14, all pre-existing dead code)

ESLint exits 0 with 14 `no-unused-vars` warnings. All are pre-existing in app source files and were not introduced or fixed in this issue:

- `data.js:13–15` — `ym`, `yr`, `mo` declared in `seed()` but never called.
- `utils.js:100` — `svg()` function defined but never called from outside the file.
- `app.js:112` — `scopeTitle()` defined but never called.
- `app.js:143` — local `main` variable assigned but never read.
- `backup.js:108, 171, 193` — unused params (`e`, `_`) in error-handling blocks.
- `_test_boot.js:925` — `state` assigned but never read.

Cleanup is a 5-minute PR but outside ISSUE-008's scope. Worth a follow-up issue if the noise gets irritating.

### Test count progression

| File | Before | After | New |
|---|---|---|---|
| `_test_csv.js` | 21 | 21 | 0 |
| `_test_boot.js` | 64 | 64 | 0 |
| `_test_selectors.js` | 36 | 73 | +37 |
| **Total** | **121** | **158** | **+37** |

The 37 new `_test_selectors.js` assertions cover the four `Selectors.*` functions that had no test (`scope`, `currentUserId`, `sourcesById`, `balanceAtDate`) plus all 10 `Fmt.*` functions (`money`, `moneyShort`, `date`, `ymKey`, `monthLabel`, `today`, `currentMonthKey`, `shiftMonth`, `inMonth`, `pct`).

### node_modules

`npm install` produced 86 packages (~6 MB) under `cozy-ledger/node_modules/`. `.gitignore` excludes it. The lockfile (`package-lock.json`) is committed so any clone can reproduce the exact dependency tree with `npm ci`.

### Files created / modified

- **Created**: `eslint.config.js`, `.gitignore`
- **Modified**: `package.json`, `_test_selectors.js`, `README.md`
- **Untouched**: every app source file (`app.js`, `data.js`, `utils.js`, `icons.js`, `selectors.js`, `i18n.js`, `backup.js`, `csv.js`, `index.html`, `styles.css`), plus `_test_csv.js` and `_test_boot.js`