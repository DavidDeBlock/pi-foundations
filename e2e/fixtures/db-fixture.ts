/**
 * Worker-scoped DB fixture.
 *
 * In the current design the Hono backend is started by Playwright's
 * `webServer` config with `NODE_ENV=test`, so a fresh `:memory:` SQLite
 * database is opened by `server/src/db/index.ts` before any test runs.
 * The reset endpoint (`POST /api/test/reset`) handles per-test isolation.
 *
 * This file exists as the canonical place to add worker-scope setup if the
 * suite later needs to share expensive state across tests in a single worker
 * (e.g. a warmed-up auth token, a pre-built PDF, etc.). For v1, the body
 * is a no-op: we yield control immediately.
 *
 * Fixture lifecycle:
 *   - `workerDb` is set up once per worker (Playwright process).
 *   - Anything in `use()` runs in every test that depends on it.
 *   - The teardown phase (after `use()`) runs once when the worker exits.
 *
 * See `.pi/skills/e2e-testing/SKILL.md` and ADR-010 for the rationale.
 */

import { test as base } from '@playwright/test'

export const test = base.extend<{}, {
  /**
   * Worker-scope token. Currently a no-op; the real DB is owned by the
   * spawned Hono server. Tests that need clean state call
   * `seedMinimalDataset(request)` from `api-fixture.ts` instead.
   */
  workerDb: void
}>({
  workerDb: [
    async ({}, use) => {
      // ── Worker setup ──────────────────────────────────────────────────
      // Intentionally empty for v1. The server's webServer config has
      // already opened a :memory: DB and run initializeTables().
      //
      // If you add worker-scope seed data here, remember:
      //   - :memory: is per-connection, so all tests in a worker share it.
      //   - Per-test isolation is the job of the `api-fixture.ts` reset.

      await use()

      // ── Worker teardown ───────────────────────────────────────────────
      // Nothing to clean up — the server process exits when Playwright does.
    },
    { scope: 'worker' },
  ],
})

export { expect } from '@playwright/test'
