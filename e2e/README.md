# Pi POS — E2E Tests

End-to-end tests for the Pi POS frontend using **Playwright** + **Page Object Model**, against a per-worker in-memory SQLite backend. Governed by [ADR-010](../docs/40-decisions/ADR-010-e2e-test-strategy.md) and [`.pi/skills/e2e-testing/SKILL.md`](../.pi/skills/e2e-testing/SKILL.md).

> **Status (2026-06-02):** Phase 1 (scaffolding) is in place. The first spec lands in Phase 3 after Phase 2 (`data-testid` additions to POS components) lands.

---

## Layout

```
e2e/
├── playwright.config.ts          # Two webServers (Hono + Vite); NODE_ENV=test
├── fixtures/
│   ├── db-fixture.ts             # Worker-scope (currently a no-op token)
│   ├── api-fixture.ts            # Per-test reset hook — import `test` from here
│   └── seed-data.ts              # HTTP wrapper factories: oneStaff, oneCustomer, …
├── pages/
│   ├── base.page.ts              # Shared shell: header, side panel, toasts
│   ├── pos.page.ts               # POS surface (Phase 3 will fill in selectors)
│   └── index.ts                  # Barrel export
├── pos/
│   └── checkout-happy-path.spec.ts   # Phase 3 — the first spec
└── README.md                     # This file
```

The first spec (`pos/checkout-happy-path.spec.ts`) lives in `e2e/pos/` because each feature gets its own folder matching the client structure (`client/src/features/pos/`).

---

## Quick start

```bash
# One-time: install Playwright browser binaries (Chromium)
pnpm exec playwright install chromium

# Run the full suite
pnpm e2e

# Run a single spec
pnpm e2e pos/checkout-happy-path.spec.ts

# Headed mode (watch the browser)
pnpm e2e:headed

# Inspector (step through, inspect state)
pnpm e2e:debug pos/checkout-happy-path.spec.ts

# Open the last HTML report
pnpm e2e:trace
```

> **Heads up:** the first run is slow (Vite dev server warm-up + Chromium launch). Subsequent runs are ~5–10s per spec.

---

## Conventions

Enforced by PR review (see ADR-010):

| Rule | Why |
|---|---|
| `data-testid` on every interactive element in `client/src/features/**` | Stable, refactor-safe selectors |
| POM method per user action; no raw `page.locator()` in test files | Centralized selectors — one place to fix on UI change |
| `data-testid` primary; `getByRole` / `getByText` for user-visible strings | Role queries catch a11y issues; data-testid is the reliable escape hatch for Radix components |
| No `page.waitForTimeout()` or `sleep()` | Use `waitForSelector`, `waitForResponse`, or auto-waiting assertions |
| Test names read like user stories | `test('cashier can complete checkout with a walk-in customer', ...)` |
| No `expect(page).toHaveScreenshot()` in v1 | Visual regression is deferred to a future iteration |

---

## How test isolation works

1. **`playwright.config.ts`** spins up two servers with `NODE_ENV=test`:
   - **Hono backend** on port `3000` — `server/src/db/index.ts` switches to `:memory:` SQLite when this env var is set.
   - **Vite dev server** on port `5173` — proxies `/api/*` to the backend.
2. **`server/src/app.ts`** conditionally mounts the test router at `/api/test/*` when `NODE_ENV=test`. **These routes do not exist in production.**
3. **`fixtures/api-fixture.ts`** calls `POST /api/test/reset` before every test, wiping all data and re-seeding the minimal dataset (1 staff, 1 customer, 1 part, 1 VAT rate).
4. **Tests** import `test` from `api-fixture.ts` to inherit the reset hook. Tests that import from `@playwright/test` directly will skip the reset.

```
Test starts
  └─ beforeEach: POST /api/test/reset
  └─ body: search → cart → customer → payment → success
  └─ teardown: nothing (server holds no test state)
Test ends → next test starts → reset again
```

---

## Adding a new test

1. **Confirm `data-testid`s exist** in the components the test will touch. If not, add them first in a separate PR — never mix selector additions with test additions.
2. **Add selectors + actions to the relevant POM** (`pages/<surface>.page.ts`). If a new surface, create a new POM class extending `BasePage`.
3. **Create the spec** at `e2e/<feature>/<flow>.spec.ts`:
   ```ts
   import { test, expect } from '../fixtures/api-fixture'
   import { PosPage } from '../pages'

   test('cashier can complete checkout with a walk-in customer', async ({ page }) => {
     const pos = new PosPage(page)
     await pos.open()
     await pos.searchPart('Bearing')
     // ...
   })
   ```
4. **Use the seed factories** if you need entities beyond the minimal dataset:
   ```ts
   import { test, expect } from '../fixtures/api-fixture'
   import { oneCustomer } from '../fixtures/seed-data'

   test('cashier can search by customer name', async ({ page, request }) => {
     await oneCustomer(request, { firstName: 'Marie' })
     // ...
   })
   ```
5. **Run locally until green** with `pnpm e2e <spec>`, then run the full suite to check for cross-test interactions.

---

## Debugging a flaky test

1. Launch Playwright Inspector: `pnpm e2e:debug <spec>`.
2. Re-run 5× to confirm flakiness (or stability). If it passes 5/5, it was probably environmental.
3. Common causes — **fix the wait, never add a sleep**:
   - Missing `await` on a Promise-returning call
   - Race on Radix dialog mount (use `waitForSelector` for the dialog container)
   - Network call completes after assertion (use `waitForResponse`)
   - Animation in transition (use `waitFor` on a state change, not on time)
4. If the test is fundamentally timing-dependent, it is a code smell. Either the application has a race condition (fix in app) or the test should assert on a different signal.

---

## Adding a new page object

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

---

## Adding new test data

1. Add a server-side seed handler in `server/src/routes/test.ts` (e.g. `POST /api/test/seed/repair`).
2. Add a wrapper factory in `e2e/fixtures/seed-data.ts` (e.g. `oneRepairedBicycle()`).
3. Add it to `seedMinimalDataset()` if it should run by default; otherwise call it explicitly from the test that needs it.

---

## Architecture notes

- **Why a separate `e2e/` workspace at the root, not inside `client/` or `server/`?** E2E tests need the dev server running in a known state. They are a third concern with different deps (`@playwright/test`), different run config, different CI step. Mixing into `client/` confuses `pnpm test`.
- **Why per-worker `:memory:` SQLite is free:** `server/src/db/index.ts` already detects `NODE_ENV=test` and uses `:memory:`. Per-test isolation requires no new env var plumbing beyond the Playwright config setting `NODE_ENV=test` for the spawned server.
- **Why HTTP-based reset:** the test process cannot share the server's in-memory SQLite connection, so reset happens over the test-only API.

---

## Reference

- [ADR-010 — E2E Test Strategy](../docs/40-decisions/ADR-010-e2e-test-strategy.md)
- [`.pi/skills/e2e-testing/SKILL.md`](../.pi/skills/e2e-testing/SKILL.md) — operational guide
- [`.pi/skills/e2e-testing/REFERENCE.md`](../.pi/skills/e2e-testing/REFERENCE.md) — full config options, fixture lifecycle details
- [Playwright Test documentation](https://playwright.dev/docs/intro)
- [Page Object Model pattern](https://playwright.dev/docs/pom)
