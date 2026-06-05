---
name: e2e-testing
description: Write, run, and debug end-to-end tests for the Pi POS frontend using Playwright with the Page Object Model pattern, against a per-worker in-memory SQLite backend. Use when adding a new E2E test, debugging a flaky test, extending the page object library, or running the suite locally. Governed by ADR-010.
---

# E2E Testing Skill

## Mission
End-to-end testing of the Pi POS frontend using Playwright + Page Object Model, against a per-worker in-memory SQLite backend. Governed by [ADR-010](../../docs/40-decisions/ADR-010-e2e-test-strategy.md).

---

## Quick start

```bash
# Run the full suite
pnpm e2e

# Run a single spec
pnpm e2e pos/checkout-happy-path.spec.ts

# Debug a failing test (headed + Inspector)
pnpm e2e debug pos/checkout-happy-path.spec.ts

# Open the trace viewer from the last run
pnpm e2e trace
```

If `pnpm e2e` does not exist yet, see [Bootstrap](#bootstrap) below.

---

## Architecture (locked in by ADR-010)

```
e2e/                              # Workspace at repo root
├── playwright.config.ts          # Spawns server with NODE_ENV=test
├── fixtures/
│   ├── db-fixture.ts             # Worker-scoped: fresh :memory: SQLite + schema + seed
│   ├── api-fixture.ts            # Per-test: truncate + reseed, server on worker DB
│   └── seed-data.ts              # Factories: oneStaff, oneCustomer, onePart, oneVatRate
├── pages/
│   ├── base.page.ts              # Header, side panel, toasts (shared shell)
│   ├── pos.page.ts               # POS-specific selectors + actions
│   └── index.ts                  # Barrel export
├── pos/
│   ├── checkout-happy-path.spec.ts
│   └── insufficient-stock.spec.ts
└── README.md                     # How to run, how to add a new test
```

**Why a new `e2e/` workspace at the root, not inside `client/` or `server/`:** E2E tests need the dev server running in a known state. They are a third concern with different deps (`@playwright/test`), different run config, different CI step. Mixing into `client/` confuses `pnpm test`.

**Why per-worker `:memory:` SQLite is free:** `server/src/db/index.ts` detects `NODE_ENV=test` and uses `:memory:`. Per-test isolation is one env var away — no DB plumbing needed.

---

## Conventions (enforced by PR review)

| Rule | Why |
|---|---|
| `data-testid` on every interactive element in `client/src/features/**` | Stable, refactor-safe selectors |
| POM method per user action; no raw `page.locator()` in test files | Centralized selectors; UI change → one file to fix |
| `data-testid` primary; `getByRole` / `getByText` for user-visible strings | Role queries catch a11y issues; data-testid is the reliable escape hatch for Radix components |
| No `page.waitForTimeout()` or `sleep()` | Use `waitForSelector`, `waitForResponse`, or auto-waiting assertions. Flaky waits are a smell, not a fix. |
| Test names read like user stories | `test('cashier can complete checkout with a walk-in customer', ...)` |
| No `expect(page).toHaveScreenshot()` in v1 | Visual regression is deferred to a future iteration |

---

## Workflows

### Adding a new E2E test

1. **Confirm `data-testid`s exist** in the components the test will touch. If not, add them first in a separate PR — never mix selector additions with test additions.
2. **Add selectors + actions to the relevant POM** (`e2e/pages/<surface>.page.ts`). If a new surface, create a new POM class extending `BasePage`.
3. **Create the spec** at `e2e/<feature>/<flow>.spec.ts`.
4. **Use the fixture from `fixtures/api-fixture.ts`** to get a clean DB + server. The fixture handles truncate + reseed + server spawn.
5. **Run locally until green**: `pnpm e2e <spec>`.
6. **Run the full suite** to check for cross-test interactions: `pnpm e2e`.

### Debugging a flaky test

1. Launch Playwright Inspector: `pnpm e2e debug <spec>`.
2. Re-run 5× to confirm flakiness (or stability). If it passes 5/5, it was probably environmental.
3. Common causes — fix the wait, never add a sleep:
   - Missing `await` on a Promise-returning call
   - Race on Radix dialog mount (use `waitForSelector` for the dialog container)
   - Network call completes after assertion (use `waitForResponse`)
   - Animation in transition (use `waitFor` on a state change, not on time)
4. If the test is fundamentally timing-dependent, it is a code smell. Either the application has a race condition (fix in app) or the test should assert on a different signal.

### Adding a new page object

1. Create `e2e/pages/<surface>.page.ts` extending `BasePage`.
2. Add selectors as getters:
   ```ts
   get checkoutButton() { return this.page.getByTestId('cart-checkout-btn') }
   ```
3. Add actions as methods that compose selectors:
   ```ts
   async checkout() { await this.checkoutButton.click() }
   ```
4. Export from `e2e/pages/index.ts` for ergonomic imports.
5. Methods should read like user actions, not implementation details. Prefer `posPage.completeSale()` over `posPage.clickCheckoutThenWaitForSuccessToast()`.

### Adding new test data

1. Add a factory function to `e2e/fixtures/seed-data.ts` (e.g., `oneRepairedBicycle()`).
2. Add it to `seedMinimalDataset()` if it should run by default.
3. Parameterless defaults preferred — tests override only when they need to.

---

## Bootstrap

If `e2e/` does not yet exist in the repo, this is the implementation order:

1. `pnpm add -D @playwright/test` at the repo root
2. `pnpm exec playwright install` (downloads Chromium)
3. Create `e2e/playwright.config.ts` with `webServer.command` that runs the server with `NODE_ENV=test`
4. Create `e2e/fixtures/db-fixture.ts` (worker-scoped `:memory:` + `initializeTables()` + seed)
5. Create `e2e/fixtures/seed-data.ts` with the minimal factories
6. Create `e2e/pages/base.page.ts` with shared shell selectors (header, side panel, toasts)
7. Create `e2e/pages/pos.page.ts` with POS-specific selectors + actions
8. Create `e2e/pos/checkout-happy-path.spec.ts` as the first test
9. Add `pnpm e2e` and `pnpm e2e debug` scripts to root `package.json`
10. Write `e2e/README.md` documenting the conventions above
11. Add `data-testid` attributes to POS components as needed (separate PR from the test itself)

---

## Anti-patterns (read these once, internalise them)

- ❌ `await page.locator('.btn-primary').click()` in a test file — always go through a POM
- ❌ `await page.waitForTimeout(500)` — use a real wait condition
- ❌ `page.locator('text=Checkout')` for a click target — use `data-testid`; text queries break with i18n or copy changes
- ❌ Sharing state between tests (one test creates a customer, the next test edits it) — use fixtures for per-test isolation
- ❌ Asserting on internal implementation (DOM structure, class names) — assert on user-visible behavior (toasts, navigation, displayed values)
- ❌ `expect(page).toHaveScreenshot()` in v1 — visual regression is deferred

---

## Integration with other skills

- **`browser-automation`** — Same Playwright engine, different intent. `browser-automation` is for ad-hoc browsing and research; `e2e-testing` is for reproducible regression checks. If you find yourself taking screenshots for a one-off investigation, that's `browser-automation`. If you find yourself checking the same flow before every release, that's `e2e-testing`.
- **`debugger`** — When an E2E test fails on a specific page and you need to inspect console logs, network requests, or DOM state, the `debugger` skill can be pointed at the dev server with a session ID for deeper inspection.
- **`diagnose`** — When an E2E test is *intermittently* failing and the cause is not obvious, use the `diagnose` skill to build a feedback loop: reproduce → minimise → hypothesise → instrument → fix → regression-test.

---

## Reference

See [REFERENCE.md](REFERENCE.md) for:
- Full `playwright.config.ts` options and why each is set
- Fixture lifecycle (worker vs test scope) in detail
- How to test against a non-default branch of the server
- Migration path to v2 visual regression
- CI integration checklist (when ready)
