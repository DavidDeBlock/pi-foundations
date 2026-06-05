# Handoff: E2E Test Strategy — Implementation Phase

**Created:** 2026-06-02
**Status:** Design approved (ADR-010 accepted), implementation not started
**Source conversation:** Planning session for adding Playwright + POM E2E testing to Pi POS

---

## Context

The Pi POS project has comprehensive Vitest unit/integration coverage but **no E2E tests** for the React frontend. `CONTEXT.md` previously claimed Vitest covered "E2E" — that line was aspirational. Multi-step user flows (especially POS checkout) have no regression net, and the "money flow" bugs that surface in production are exactly what unit tests on services cannot catch.

User has no prior E2E testing experience and explicitly deferred to recommendations throughout the grill session. All design decisions are locked and documented. **This handoff is for the implementation phase — a Builder picking up where the design left off.**

---

## Decisions Locked (User Approved)

The full rationale and trade-offs are in the ADR. Summary:

| # | Decision | Choice |
|---|---|---|
| 1 | v1 scope | **POS checkout happy path only** (search → cart → customer → payment → success) |
| 2 | Test pattern | **Page Object Model** in a new `e2e/` workspace at repo root |
| 3 | Selector strategy | `data-testid` primary, `getByRole` / `getByText` secondary for user-visible strings |
| 4 | Test data strategy | Per-worker `:memory:` SQLite, seed once per worker, truncate between tests |
| 5 | Visual regression | **Deferred** to a future iteration (v1 is flow correctness only) |
| 6a | CI integration | TBD / not blocking v1 |
| 6b | Skill shape | Thin `e2e-testing` skill pointing at the workspace |
| 6c | v1 "done" = | POS happy-path green locally + working fixture/reset infrastructure + README in `e2e/` |

### Key infrastructure insight

`server/src/db/index.ts` **already** supports `:memory:` SQLite when `NODE_ENV=test`. Per-test isolation is one env var away — no DB plumbing needed. The `initializeTables()` function handles schema setup via raw `CREATE TABLE` statements.

---

## Artifacts Created This Session (Reference, Don't Duplicate)

| # | Path | Purpose |
|---|---|---|
| 1 | `docs/40-decisions/ADR-010-e2e-test-strategy.md` | Full ADR — context, drivers, options, outcome, conventions, consequences. **Read this first.** |
| 2 | `docs/40-decisions/_index.md` | Updated file table with ADR-010 |
| 3 | `docs/40-decisions/index.md` | Updated Accepted Decisions section + new "Testing" category |
| 4 | `CONTEXT.md` (lines 14, 192-204) | Stack table corrected + new "Testing Strategy" section with conventions |
| 5 | `.pi/skills/e2e-testing/SKILL.md` | The skill that operationalises ADR-010 — has the full `Bootstrap` section with 11-step implementation order |

The skill's **Bootstrap** section at `.pi/skills/e2e-testing/SKILL.md` is the implementation checklist. Re-read it before starting work.

---

## Approved Plan Summary

### Architecture

A new top-level `e2e/` workspace, separate from `client/` and `server/`, because:
- Different deps (`@playwright/test`)
- Different run config
- Different CI step (when added)
- Mixing into `client/` confuses `pnpm test`

The workspace has its own `playwright.config.ts`. The config's `webServer.command` must set `NODE_ENV=test` so the spawned Hono server uses `:memory:` SQLite.

### Conventions Enforced by PR Review

These are non-negotiable per the ADR and CONTEXT.md:
1. `data-testid` on every interactive element in `client/src/features/**`
2. POM methods in tests; no raw `page.locator()` in test files
3. No `page.waitForTimeout()` or `sleep()` — use real wait conditions
4. Test names read like user stories
5. No `expect(page).toHaveScreenshot()` in v1

### Files to Create (during bootstrap)

| File | Purpose |
|---|---|
| `e2e/playwright.config.ts` | Playwright config; `webServer` spawns server with `NODE_ENV=test` |
| `e2e/fixtures/db-fixture.ts` | Worker-scoped fixture: fresh `:memory:` + `initializeTables()` + seed |
| `e2e/fixtures/api-fixture.ts` | Per-test fixture: truncate + reseed + start server on worker DB |
| `e2e/fixtures/seed-data.ts` | Factory functions: `oneStaff`, `oneCustomer`, `onePart`, `oneVatRate` |
| `e2e/pages/base.page.ts` | Shared shell (Header, SidePanel, toasts) |
| `e2e/pages/pos.page.ts` | POS-specific selectors + actions |
| `e2e/pages/index.ts` | Barrel export |
| `e2e/pos/checkout-happy-path.spec.ts` | First test — POS happy path |
| `e2e/README.md` | How to run, how to add a new test |

### Files to Modify

| File | Change |
|---|---|
| `package.json` (root) | Add `@playwright/test` devDependency; add `pnpm e2e`, `pnpm e2e debug`, `pnpm e2e trace` scripts |
| `client/src/features/pos/**` | Add `data-testid` attributes to interactive elements (separate PR from the test) |

### Minimal Seed Dataset (for the first test)

`e2e/fixtures/seed-data.ts` must produce:
- 1 staff member (`mechanic` role, `isActive=true`)
- 1 customer (private, full name)
- 1 part (with stock ≥ 1, with VAT rate assigned)
- 1 VAT rate

The POS happy path is: scan/search part → add to cart → select (or skip) customer → checkout → assert success toast + sale persisted + stock decremented.

---

## What Next Session Should Do

### Phase 1: Bootstrap the workspace (steps 1-7 of the skill's Bootstrap section)

1. `pnpm add -D @playwright/test` at repo root
2. `pnpm exec playwright install` (Chromium download)
3. Create `e2e/playwright.config.ts` per skill spec
4. Create `e2e/fixtures/db-fixture.ts`, `api-fixture.ts`, `seed-data.ts`
5. Create `e2e/pages/base.page.ts` and `pos.page.ts`
6. Add `pnpm e2e*` scripts to root `package.json`
7. Write `e2e/README.md`

### Phase 2: Add `data-testid` to POS components (separate PR)

This is **its own PR** — don't mix selector additions with the test bootstrap. Inspect `client/src/features/pos/components/**` and add stable `data-testid` attributes on:
- Cart line items
- Quantity controls
- Add-to-cart buttons
- Customer search input + results
- Checkout button
- Payment method selector
- Submit payment button
- Success toast / confirmation

### Phase 3: Write the first test

`e2e/pos/checkout-happy-path.spec.ts` — POS happy path. Use the fixtures from Phase 1. Test name: `cashier can complete checkout with a walk-in customer` (or similar user-story phrasing).

### Phase 4: Verify and document

- Run the suite locally until green
- Run 5× to confirm stability (no flakiness)
- Update `e2e/README.md` with anything discovered during implementation
- Hand back to user for review

### Out of scope for this implementation

- Visual regression (deferred per ADR-010)
- Other user flows (repairs, customers, orders) — added incrementally
- CI integration — needs a CI provider decision first
- Updating existing components outside the POS flow

---

## Suggested Skills

| Skill | When to Use |
|---|---|
| `typescript-implementer` | Primary skill for the Playwright TypeScript code, fixture design, and POM scaffolding. Use throughout Phase 1 and Phase 3. |
| `vertical-slice-builder` | The POS happy path is itself a vertical slice (UI → server → DB). Consider this skill for the end-to-end implementation flow if the project conventions warrant it. |
| `tdd` | Optional — could write the failing test first, then make it pass. Reasonable approach for the first test. |
| `reviewer` | After implementation, to verify the code respects ADR-010 conventions (POM method per user action, no raw locators, no sleeps, `data-testid` usage). |
| `prd-auditor` | If a PRD is created for this work, audit the implementation against the PRD's acceptance criteria before declaring v1 done. |
| `diagnose` | If the first test is intermittently failing and the cause is unclear. Build a feedback loop (run 100×, narrow timing, etc.) per the skill's discipline. |
| `debugger` | If a test fails on a specific page and console/network inspection is needed. The same Playwright engine powers the `debugger` skill. |
| `architect` | Only if a structural question emerges during implementation (e.g., "where do shared page objects for the shell live when a second test surface is added?"). Likely not needed for the first test. |

---

## Key Paths (Absolute)

- ADR (read first): `/home/david/projects/pi-pos-v1/docs/40-decisions/ADR-010-e2e-test-strategy.md`
- Skill (implementation guide): `/home/david/projects/pi-pos-v1/.pi/skills/e2e-testing/SKILL.md`
- Updated CONTEXT: `/home/david/projects/pi-pos-v1/CONTEXT.md` (lines 14, 192-204)
- Server DB entry (already supports `:memory:`): `/home/david/projects/pi-pos-v1/server/src/db/index.ts`
- POS feature (where `data-testid` will be added): `/home/david/projects/pi-pos-v1/client/src/features/pos/`
- Router (for understanding routes): `/home/david/projects/pi-pos-v1/client/src/app/App.tsx`
- Root package.json (where `pnpm e2e*` scripts go): `/home/david/projects/pi-pos-v1/package.json`
- Drizzle migrations: `/home/david/projects/pi-pos-v1/drizzle/`

---

## Sensitive Information

- `SERPER_API_KEY` was visible in `/home/david/projects/pi-pos-v1/.env` during the grill session. **Not relevant to E2E testing** — that key is used by the `web-searcher` and `browser-automation` skills. Not needed for this work.
- No other secrets, PII, or sensitive data touched in this conversation.

---

## Open Questions for User (if implementation hits them)

If the next session encounters these, they should be flagged back to the user rather than guessed:

1. **Script names** — assumed `pnpm e2e`, `pnpm e2e debug`, `pnpm e2e trace`. If the user prefers different names, change before first commit.
2. **Headless mode default** — Playwright defaults to headless. If the user wants headed-by-default for local dev, that's a one-line config change.
3. **Trace retention** — Playwright traces can fill disk fast. Default `trace: 'on-first-retry'` is fine; user can change if they want.
4. **Vitest config quirk** — root `vitest.config.ts` only runs `.pi/**/*.test.{ts,tsx}` and excludes `**/client/**`, `**/server/**`, `**/shared/**`. The E2E suite is outside this config, so no conflict, but worth knowing that unit tests for the POS flow currently live in `server/src/services/__tests__/`, not in the e2e workspace.
