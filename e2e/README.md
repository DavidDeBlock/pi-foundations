# E2E Tests — Template Skeleton

End-to-end test scaffolding for downstream projects using **Playwright** + **Page Object Model**, against a per-worker in-memory backend. This folder is a **template** — copy/adapt it into a new project and populate with feature-specific specs.

## When to use this template

- Frontend project with user-facing flows that need full-stack coverage
- State-machine bugs that unit tests on the service layer can't catch (e.g. multi-step forms, payment flows)
- Dialog-heavy UI (Radix UI / Headless UI / similar)

## Layout

```
e2e/
├── playwright.config.ts          # Project-specific: webServers, NODE_ENV=test
├── fixtures/                     # Test data + backend setup (per-worker)
├── pages/                        # Page Object Models
│   ├── base.page.ts              # Shared shell (header, side panel, toasts)
│   └── <feature>.page.ts         # One POM per feature
└── specs/                        # Test files (*.spec.ts)
```

## Conventions

- **Selectors prefer `data-testid`**; fall back to `getByRole` / `getByText` for user-visible strings (toasts, dialog titles, error messages).
- **Never use raw `page.locator()`** in test files — always go through POMs.
- **One worker = one backend instance** so DB state doesn't bleed between tests.
- **Page Objects expose selectors as getters** (returning `Locator`) and actions as methods that compose selectors.

## How to adopt in a new project

1. Copy this `e2e/` folder into the new project.
2. Update `playwright.config.ts` for the new project's dev server (port, command).
3. Replace `base.page.ts` with selectors that match the new app's shell.
4. Add feature-specific `<feature>.page.ts` files under `pages/`.
5. Add spec files in `specs/` (create the folder).

## Reference

- Playwright docs: https://playwright.dev/
- Page Object Model pattern: https://playwright.dev/docs/pom
