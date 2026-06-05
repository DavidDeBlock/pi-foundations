/**
 * Playwright configuration for Pi POS E2E tests.
 *
 * See ADR-010 and `.pi/skills/e2e-testing/SKILL.md` for the full rationale.
 *
 * Key design choices:
 *   - Two webServers (Hono backend + Vite dev server) so the browser talks
 *     to the real frontend and the real API.
 *   - The Hono server runs with NODE_ENV=test, which causes
 *     `server/src/db/index.ts` to use `:memory:` SQLite and
 *     `server/src/app.ts` to mount the test routes at /api/test.
 *   - `workers: 1` for v1 — the per-test reset endpoint gives us isolation
 *     without needing parallel workers. Bump when the suite reaches ~5+ tests.
 *   - `baseURL: http://localhost:5173` — the Vite dev server's port.
 *     The Vite proxy redirects /api/* to http://localhost:3000 (see
 *     `client/vite.config.ts`).
 */

import { defineConfig, devices } from '@playwright/test'

const PORT = 3000 // Hono backend port (must match vite.config.ts proxy)
const FRONTEND_PORT = 5173 // Vite dev server port

export default defineConfig({
  testDir: '.',
  // Spec files live under e2e/<feature>/*.spec.ts; fixtures and pages are not tests.
  testMatch: '**/*.spec.ts',

  // v1: single worker. The reset endpoint serialises DB state across tests.
  // When adding parallel-safe flows, bump this and verify isolation.
  workers: 1,

  // Default test timeout. Generous for the first suite; tighten as patterns stabilise.
  timeout: 30_000,

  // Reasonable default for CI/headless. Local devs can override via env.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../playwright-report' }],
  ],

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Spin up both servers. Playwright waits for each `url` to return 200 before running tests.
  webServer: [
    {
      command: 'pnpm --filter @pi-skeleton/server exec tsx src/server.ts',
      url: `http://localhost:${PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(PORT),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @pi-skeleton/client dev',
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
