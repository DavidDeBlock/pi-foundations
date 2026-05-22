# Pi POS V1 Server Backend Structure Map

## 1. Entry Points

| File | Purpose |
|------|---------|
| `src/app.ts` | **Main Hono app** — sets up middleware (logger, CORS), global error handler, mounts all routes under `/api`, health check at `/health` |
| `src/server.ts` | HTTP server bootstrap — listens on port, starts the app |

## 2. Route Layer (`src/routes/`)

Flat barrel structure — one file per resource domain:

| File | Purpose |
|------|---------|
| `routes/index.ts` | Barrel that re-exports all route modules |
| `routes/customers.ts` | Customer CRUD routes |
| `routes/products.ts` | Product CRUD routes |
| `routes/sales.ts` | Sale/transaction routes |
| `routes/dst-auth.ts` | DST supplier auth proxy routes |
| `routes/product-finder.ts` | Product finder API routes (supplier search/import) |

Each route file handles HTTP methods → calls into the service layer.

## 3. Service Layer (`src/services/`)

Business logic, separate from HTTP concerns:

| File | Purpose |
|------|---------|
| `services/customer.service.ts` | Customer business operations |
| `services/product.service.ts` | Product business operations |
| `services/sale.service.ts` | Sale/transaction business logic |

## 4. Feature Modules (`src/features/`)

Domain-driven feature folders with their own sub-layers:

### `features/dst-auth/` — DST Supplier Authentication
```text
dst-auth/
├── index.ts              # Module entry point
├── routes/index.ts       # Auth routes (login, token refresh)
├── services/
│   ├── auth-service.ts   # Auth logic (credentials, tokens)
│   └── token-cache.ts    # Cached DST session tokens
```

### `features/product-finder/` — Supplier Product Discovery
```text
product-finder/
├── index.ts              # Module entry point
├── types.ts              # Feature-specific types
├── routes/index.ts       # Search, import, sync-status routes
├── services/
│   ├── search-service.ts     # Supplier search orchestration
│   ├── import-service.ts     # Product import into DB
│   └── sync-status-service.ts# Sync progress tracking
│   └── suppliers/            # Per-supplier adapter pattern
│       ├── base.ts           # Abstract supplier interface
│       ├── index.ts          # Supplier registry barrel
│       ├── dst/              # DST supplier (auth + detail scraping)
│       ├── gransier/         # Gransier supplier (sync + detail)
│       └── kruitbosch/       # Kruitbosch supplier (sync + detail)
```

## 5. Database / Schema Layer (`src/db/`)

| File | Purpose |
|------|---------|
| `db/index.ts` | Drizzle **DB instance** — creates the typed DB client from env vars |
| `db/schema/index.ts` | All **table definitions** (Drizzle schema) — customers, products, sales, etc. |
| `db/seed.ts` | Production seed script |

## 6. Validation Layer (`src/validations/`)

| File | Purpose |
|------|---------|
| `validations/parts-validation.ts` | Zod schemas for request body/query validation (e.g., parts/product inputs) |

**Note:** Only one validation file exists — not every route has its own validation schema yet.

## 7. Shared / Utilities (`src/lib/`)

| File | Purpose |
|------|---------|
| `lib/errors.ts` | Custom error types and error-throwing helpers used across services |

## 8. Seed Scripts (root of `src/`)

| File | Purpose |
|------|---------|
| `seed-simple.ts` | Minimal seed script |
| `seed-debug.ts` | Debug-oriented seed with verbose output |
| `seed-verbose.ts` | Full verbose seed script |

## 9. Test Structure

Tests live **co-located** with source files in `__tests__/` subdirectories:

```text
server/
├── test/setup.ts              # Global test setup (vitest)
├── src/routes/__tests__/      # Route-level tests
│   ├── customers.test.ts
│   ├── products.test.ts
│   └── sales.test.ts
├── src/services/__tests__/    # Service-level tests
│   ├── customer-service.test.ts
│   └── product-service.test.ts
└── src/features/*/services/__tests__/  # Feature service tests
    └── src/features/*/routes/__tests__/ # Feature route tests
```

Also standalone test seed files at `server/` root: `test-seed.ts`, `test-seed2.ts`, `test-seed3.ts`.

## Summary Diagram

```text
src/
├── app.ts                    ← Hono app (middleware, error handling)
├── server.ts                 ← HTTP listen bootstrap
├── routes/                   ← HTTP handlers (flat per-resource)
│   ├── index.ts              ← barrel
│   ├── customers.ts          ← GET/POST /api/customers
│   ├── products.ts           ← GET/POST /api/products
│   ├── sales.ts              ← sale endpoints
│   ├── dst-auth.ts           ← DST auth proxy
│   └── product-finder.ts     ← finder API
├── services/                 ← business logic (flat)
│   ├── customer.service.ts
│   ├── product.service.ts
│   └── sale.service.ts
├── features/                  ← domain-driven modules with nested layers
│   ├── dst-auth/             ← auth feature (routes + services)
│   └── product-finder/       ← supplier discovery (routes + services + suppliers/)
├── db/                       ← database layer
│   ├── index.ts              ← Drizzle client
│   ├── schema/index.ts       ← table definitions
│   └── seed.ts               ← seed data
├── validations/              ← Zod schemas
│   └── parts-validation.ts
├── lib/                      ← shared utilities
│   └── errors.ts
├── test/setup.ts             ← vitest globals
└── *seed*.ts                 ← standalone seed scripts
```

## Key Architectural Notes

- **Two routing styles**: flat `routes/` for core CRUD, feature folders (`features/`) for complex domains with their own nested layers.
- **Supplier adapters**: product-finder uses a strategy pattern — each supplier (DST, Gransier, Kruitbosch) implements the same interface via `suppliers/base.ts`.
- **Validation is thin**: only one Zod file exists; not all routes have request validation yet.
