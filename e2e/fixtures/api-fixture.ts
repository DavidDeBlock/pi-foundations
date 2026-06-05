/**
 * Per-test API fixture.
 *
 * Resets the DB to the minimal seed before every test, so each test starts
 * from a known baseline regardless of what previous tests did.
 *
 * The reset goes over HTTP (`POST /api/test/reset`) because the Hono server
 * holds the in-memory SQLite connection; the test process cannot share it.
 *
 * Tests should import `test` and `expect` from this file (not from
 * `@playwright/test` directly) to inherit the reset behaviour.
 *
 * Usage:
 *   import { test, expect } from '../fixtures/api-fixture'
 *
 *   test('cashier can complete checkout with a walk-in customer', async ({ page }) => {
 *     // DB already contains: 1 staff, 1 customer, 1 part, 1 VAT rate.
 *     // ...
 *   })
 */

import { test as base } from './db-fixture.js'
import { seedMinimalDataset } from './seed-data.js'

export const test = base.extend({
  // The `request` fixture is provided by Playwright out of the box.
  // We hook into it via `beforeEach` to call the reset endpoint before every test.
})

test.beforeEach(async ({ request }) => {
  await seedMinimalDataset(request)
})

export { expect } from './db-fixture.js'
