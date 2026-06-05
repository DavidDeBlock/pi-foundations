# ADR-010: E2E Test Strategy — Playwright + Page Object Model

**Status**: ✅ Accepted
**Date**: 2026-06-02
**Authors**: David De Block

---

## Context

The Pi POS project has comprehensive unit and integration test coverage via Vitest (see `server/src/services/__tests__/`), but **no end-to-end (E2E) test coverage** exists for the React frontend flows. `CONTEXT.md` claims Vitest covers "unit, integration, E2E" — this is aspirational; there is no E2E infrastructure today (no Playwright config, no Playwright dependency, no `e2e/` directory, no frontend E2E specs).

This gap matters most for **money-critical user flows** (POS checkout, repair lifecycle) where state-machine bugs — *"the cart shows 2 items but the sale only persisted 1"* — are exactly what unit tests on the service layer cannot catch. The frontend uses Radix UI dialogs, multi-step Zustand stores, and React Router navigation that only an E2E test exercises end-to-end.

The decision needed: which tool, which pattern, which conventions, which scope for v1.

---

## Decision Drivers

1. **Coverage of multi-step user flows** — POS checkout is search → cart → customer → payment → success. Cannot be tested as a unit; needs real browser, real navigation, real server.
2. **Pattern fit with existing culture** — The project values explicit, contract-based identifiers (typed error classes, shared Zod schemas, sequence numbers for human-readable IDs). E2E conventions should follow the same instinct: one canonical place per concern, explicit naming.
3. **Stack compatibility** — Vite + React 18 + Hono + Drizzle + better-sqlite3. The server already supports `:memory:` SQLite when `NODE_ENV=test` is set (`server/src/db/index.ts`), so per-test isolation is one env var away.
4. **Scalability** — The first test sets the pattern for tests 2–10. We pay the indirection cost or benefit from it for every future test.
5. **Deferability of cost-heavy features** — Visual regression (screenshot diffs) carries real costs (baseline storage, threshold tuning, review workflow) that should not be paid on day one.

---

## Options Considered

### Option A: Vitest Browser Mode

**Description**: Use Vitest's experimental browser mode to run component + flow tests in a real browser via Playwright under the hood.

**Pros:**
- Single test runner; no new dependency
- Familiar Vitest config
- Reuses existing test infrastructure

**Cons:**
- Browser mode is experimental and the API has changed across minor versions
- Designed primarily for component testing, not full multi-page SPA flows
- Weaker cross-page navigation ergonomics than Playwright Test
- Debugging and tracing tooling is less mature than Playwright's

### Option B: Playwright Test with Page Object Model *(chosen)*

**Description**: Standalone Playwright workspace at the repo root (`e2e/`), with Page Object Model (POM) classes per major surface, fixtures for per-worker `:memory:` SQLite + seed/reset, and a `data-testid` selector convention enforced project-wide.

**Pros:**
- Industry-standard E2E runner; mature API and tooling (Inspector, trace viewer, codegen)
- Multi-page flow support is first-class (the POS flow is a multi-page state machine)
- POM centralizes selectors — a UI change fixes in one place, not 20 test files
- Per-worker `:memory:` SQLite is already supported by the server (`NODE_ENV=test` detection in `server/src/db/index.ts`)
- Unifies three existing skills: the new `e2e-testing`, the existing `browser-automation`, and the existing `debugger` all use Playwright under the hood — one engine to maintain
- Scales to 50+ tests with stable conventions

**Cons:**
- New workspace + new dependency (`@playwright/test`)
- POM adds indirection (one more file per surface to maintain)
- `data-testid` becomes a project-wide convention that must be enforced in PR review

### Option C: Cypress

**Description**: Cypress E2E runner.

**Pros:**
- Excellent DX for component tests
- Time-travel debugger is well-regarded

**Cons:**
- Different runtime architecture (runs inside the app via injected script) makes server-spawn integration harder
- Less mature multi-tab / cross-origin support than Playwright
- Weaker TypeScript story (TS support improved but still second-class)
- Lock-in to Cypress's runner means we cannot reuse Playwright's browser for the existing `browser-automation` and `debugger` skills — three engines to maintain instead of one

---

## Decision Outcome

**Selected**: Option B — Playwright Test with Page Object Model

### Justification

1. **Playwright unifies three concerns.** The new `e2e-testing` skill, the existing `browser-automation` skill, and the existing `debugger` skill all use Playwright under the hood. One engine, one set of bugs, one upgrade path.
2. **POM matches the project's "one canonical place" instinct.** A single `PosPage` module owns every selector for `/pos`. UI refactor → one file changes. New test → one import. This is the test-world equivalent of the `sale.service.ts` deep-module pattern from ADR-008.
3. **Per-worker `:memory:` SQLite is free.** `server/src/db/index.ts` already detects `NODE_ENV=test` and uses `:memory:`. Per-test isolation requires no new env var plumbing — only the Playwright config setting `NODE_ENV=test` for the spawned server.
4. **Defer visual regression.** Flow correctness is the v1 goal. A `screenshot()` helper on `BasePage` makes v2 visual diffs a 1-day add with no harness change.
5. **Conventions can be enforced cheaply.** `data-testid` is a one-line PR review rule, and the existing component review flow already touches every new component.

### v1 Scope

- **In scope**:
  - POS checkout happy path (search → cart → customer → payment → success) — one working test
  - Working fixture/reset infrastructure that supports ~10 future tests without refactor
  - POM scaffolding: `BasePage` (shared shell) + `PosPage` (POS-specific)
  - README in `e2e/` explaining how to add test #2
- **Out of scope (v1)**:
  - Visual regression (screenshot diffs)
  - Other user flows (repairs, customers, orders) — added incrementally as Tier 1 scope expands
  - CI integration — deferred until local suite is stable and a CI provider is chosen

### Conventions to Enforce

1. **`data-testid` on every interactive element** — Components in `client/src/features/**` MUST expose stable `data-testid` attributes on buttons, inputs, dialogs, and list items that are part of an E2E flow. Reviewed in PR. This is a project-wide convention, not just an E2E concern.
2. **POM per surface** — One class per major page (e.g., `PosPage`, `CustomersPage`). Methods on the class represent user actions (`checkout()`, `addToCart()`), not raw selectors. Tests never call `page.locator()` directly.
3. **Workspace location** — `e2e/` at the repo root, not inside `client/` or `server/`. Separate `playwright.config.ts`. Separate `pnpm` script: `pnpm e2e`. The workspace has its own `package.json` only if dependency isolation is required; otherwise scripts live in the root.
4. **Per-worker `:memory:` DB** — Playwright config sets `NODE_ENV=test` for the spawned Hono server. `server/src/db/index.ts` handles schema via `initializeTables()`. `e2e/fixtures/seed-data.ts` provides the minimal dataset (1 staff, 1 customer, 1 part, 1 VAT rate).
5. **Flow correctness only** — Tests assert DOM state, console errors, network responses, toasts. No `expect(page).toHaveScreenshot()` in v1.
6. **Selector strategy** — `data-testid` primary. `getByRole` / `getByText` secondary, for assertions on user-visible strings (toasts, dialog titles, error messages).

### Consequences

**Positive:**
- Money-critical POS flow has a regression net for the first time.
- `data-testid` convention improves test ergonomics for *all* future testing approaches (Storybook, Vitest component tests, manual QA, future E2E).
- New E2E tests follow a clear template — `e2e/<feature>/<flow>.spec.ts` + `e2e/pages/<surface>.page.ts`.
- Playwright is reusable across the `e2e-testing`, `browser-automation`, and `debugger` skills.
- The `:memory:` SQLite infrastructure for Vitest unit tests (already in place) is the same mechanism used for E2E — one mental model for "test database."

**Negative:**
- New `e2e/` workspace adds cognitive overhead (another top-level folder).
- `data-testid` convention is a project-wide change. Existing components need `data-testid` updates incrementally as their flows are tested — partial coverage until a sweep is done.
- One-time investment in POM scaffolding before the first test is meaningful (estimated ~half a day for `BasePage` + `PosPage` + fixtures).
- Visual regressions in shipped UI will not be caught automatically until v2.

---

## References

- [ADR-008: Flow-First Architecture](./ADR-008-flow-first-architecture.md) — establishes the deep-module service pattern that the POS flow test validates
- [CONTEXT.md § Testing Strategy](../../CONTEXT.md#testing-strategy) — test stack and conventions
- `.pi/skills/e2e-testing/SKILL.md` — the skill that operationalises this ADR
- [Playwright Test documentation](https://playwright.dev/docs/intro) — runner reference
- [Page Object Model pattern](https://playwright.dev/docs/pom) — POM reference

## History

| Date | Change | Author |
|------|--------|--------|
| 2026-06-02 | Created | David De Block |
