# E2E Testing — Reference

Detailed reference for the Playwright + POM E2E suite. See [SKILL.md](SKILL.md) for the operational guide, [ADR-010](../../docs/40-decisions/ADR-010-e2e-test-strategy.md) for the strategy, and [`/e2e/README.md`](../../e2e/README.md) for project-specific run instructions.

---

## `playwright.config.ts` options

The full config is in [`/e2e/playwright.config.ts`](../../e2e/playwright.config.ts). Key choices:

| Option | Value | Why |
|---|---|---|
| `testDir` | `.` | The `e2e/` folder; Playwright looks for tests under it. |
| `testMatch` | `**/*.spec.ts` | Explicit extension. Disjoint from Vitest's `.test.ts`, so root-level vitest config doesn't pick up e2e specs. |
| `workers` | `1` (v1) | Single worker. The reset endpoint serialises DB state. Bump when the suite reaches ~5+ tests and you have a flow that doesn't touch the reset endpoint. |
| `timeout` | `30_000` | Generous for the first suite; tighten as patterns stabilise. |
| `fullyParallel` | `false` | v1 — single worker makes this moot. Flip to `true` when bumping workers. |
| `forbidOnly` | `true` in CI | Prevents accidentally committing `test.only`. |
| `retries` | `2` in CI, `0` locally | CI gets retries; local fails fast so we notice flakes. |
| `reporter` | `list` + `html` | Terminal output + HTML report in `playwright-report/`. |
| `use.baseURL` | `http://localhost:5173` | Vite dev server's port. The Vite proxy redirects `/api/*` to `http://localhost:3000`. |
| `use.trace` | `on-first-retry` | Traces are large; only keep them when retrying. |
| `use.screenshot` | `only-on-failure` | Captures screenshots on test failure for triage. |
| `use.video` | `retain-on-failure` | Videos are huge; only keep them on failure. |
| `webServer[0].command` | `pnpm --filter @pi-skeleton/server exec tsx src/server.ts` | Runs the Hono server with `tsx` (no watch, fast startup). The `--filter` flag scopes the workspace invocation. |
| `webServer[0].env` | `NODE_ENV=test, PORT=3000` | Triggers `:memory:` SQLite and mounts the test routes. `PORT=3000` is explicit. |
| `webServer[0].url` | `http://localhost:3000/health` | Playwright polls this URL until it returns 200. |
| `webServer[1].command` | `pnpm --filter @pi-skeleton/client dev` | Vite dev server on port 5173. |
| `webServer[1].url` | `http://localhost:5173` | Vite's default port. |
| `reuseExistingServer` | `!process.env.CI` | Locally, if a server is already running, reuse it. In CI, always start fresh. |
| `projects` | `chromium` only | v1. Add `webkit` and `firefox` when cross-browser becomes a requirement. |

---

## Fixture lifecycle

Playwright fixtures have two scopes:

- **Test scope** (default) — set up before every test, torn down after.
- **Worker scope** — set up once per worker process, torn down when the worker exits.

For v1 we use:

### `fixtures/db-fixture.ts` (worker scope)

- Exposes a no-op `workerDb` token.
- Why it exists: the handoff is explicit that this is the canonical place to add worker-scope setup. For v1, the server's webServer config has already done all the worker-scope work (open `:memory:` DB, run `initializeTables()`). Future: warm caches, pre-build auth tokens, etc.

### `fixtures/api-fixture.ts` (test scope)

- Registers a `beforeEach` hook that calls `seedMinimalDataset(request)`.
- Tests import `test` from this file. The hook runs before every test in the project that uses this `test` object.

### Why not open a second DB connection in the test process?

`:memory:` SQLite is per-connection. The test process cannot share the server's in-memory DB. The two viable alternatives are:

1. **HTTP-based reset (chosen)** — `POST /api/test/reset` over the same network the browser uses. Slower (~10ms per reset) but standard and obvious.
2. **In-process Hono** — start the Hono app inside the test process, share the `:memory:` connection. Faster but requires the test to manage server lifecycle and a free port, and complicates the Vite proxy configuration.

We chose (1) because the overhead is negligible and the test code reads the same way as production: HTTP request → HTTP response.

---

## How to test against a non-default branch of the server

The webServer command runs `pnpm --filter @pi-skeleton/server exec tsx src/server.ts`, which uses the **current** `server/src/` source. To test against a different branch:

1. Check out the branch in a worktree.
2. Run `pnpm install` in the worktree to update the workspace links.
3. From the worktree root, run `pnpm e2e` as normal.

Playwright will pick up the server code at the path the workspace resolves to. There is no need to override paths in the config.

If you want to run only a subset of the e2e suite while iterating on a server change:

```bash
pnpm e2e pos/checkout-happy-path.spec.ts
```

---

## Migration path to v2 visual regression

v1 is flow correctness only. To add visual regression later:

1. **Add a baseline folder** — `e2e/__screenshots__/<spec-name>/<test-name>.png` (gitignored for now; commit baselines on first review).
2. **Update the convention** — remove the "no `toHaveScreenshot`" rule from the skill.
3. **Update `playwright.config.ts`** — add `use.snapshotPathTemplate` if you want custom paths.
4. **First run** — Playwright will fail every visual assertion. Inspect each, accept or reject. Commit the baselines.
5. **CI** — the HTML reporter already shows diffs; you'll need a way to update baselines on intentional changes (e.g. `pnpm e2e --update-snapshots`).

Cost: ~half a day of setup + ongoing baseline-review burden on every visual change. Defer until v1 is stable.

---

## CI integration checklist (when ready)

When you decide to wire this into CI:

- [ ] Choose a CI provider (GitHub Actions, GitLab CI, …)
- [ ] Add a workflow file that:
  - Sets up Node + pnpm
  - Runs `pnpm install --frozen-lockfile`
  - Runs `pnpm exec playwright install --with-deps chromium`
  - Runs `pnpm build` (to ensure the client builds)
  - Runs `pnpm e2e`
  - Uploads `playwright-report/` and `test-results/` as artifacts
- [ ] Decide on failure policy: blocking on red? warning only?
- [ ] Decide on parallelism: GitHub Actions matrix per browser? Per spec shard?
- [ ] Set `CI=true` so Playwright uses the CI-tuned config (`reuseExistingServer: false`, `retries: 2`)

---

## Anti-patterns recap

(Repeated from the skill, because they're important enough to be cross-referenced.)

- ❌ Raw `page.locator()` in test files — always go through a POM
- ❌ `page.waitForTimeout(500)` — use a real wait condition
- ❌ `page.locator('text=Checkout')` for a click target — use `data-testid`
- ❌ Sharing state between tests — use the reset endpoint
- ❌ Asserting on internal implementation (DOM structure, class names) — assert on user-visible behavior
- ❌ `expect(page).toHaveScreenshot()` in v1

---

## See also

- [SKILL.md](SKILL.md) — operational guide (load this when working on a test)
- [ADR-010](../../docs/40-decisions/ADR-010-e2e-test-strategy.md) — strategy and rationale
- [`/e2e/README.md`](../../e2e/README.md) — project-specific run instructions
- [Playwright docs](https://playwright.dev/docs/intro)
- [POM pattern](https://playwright.dev/docs/pom)
