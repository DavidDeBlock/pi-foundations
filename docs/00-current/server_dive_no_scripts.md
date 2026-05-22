# Backend Structure Map (`pi-pos-v1/server`)

High-level map of the Pi POS v1 Server backend.

---

## 📍 Entry Points

| File | Purpose |
|------|---------|
| `src/server.ts` | Bootstraps the app — loads `.env`, initializes DB, starts Hono/Node server with graceful shutdown |
| `src/app.ts` | Hono application core — middleware (logger, CORS), global error handler, mounts all routes at `/api` |

---

## 🛣️ Route Files (all under `src/routes/`)

Routes follow a **flat barrel** pattern — aggregated in `routes/index.ts`:

| File | Prefix | Endpoints |
|------|--------|-----------|
| `products.ts` | `/parts` | GET browse/search, GET by id, POST create, PATCH update, PATCH deactivate |
| `customers.ts` | `/customers` | GET list (compact selector shape) |
| `sales.ts` | `/sales` | POST create direct sale, GET list/detail, PATCH void |
| `dst-auth.ts` | `/dst/auth` | POST login to DST Keycloak, GET auth status |
| `product-finder.ts` | `/product-finder` | Search (EAN/keyword per supplier + combined), sync suppliers, import product, auth/status, detail endpoints per supplier |

**Pattern**: Each route file creates a Hono instance → registers handlers → exports default. The barrel (`index.ts`) mounts them all under `/api`.

---

## 🔧 Service Layer (`src/services/`)

Business logic lives in flat service files:

| File | Responsibility |
|------|----------------|
| `product.service.ts` | Parts CRUD — browse, lookup by id/barcode, create/update/deactivate. Uses Drizzle ORM + shared types for DTO mapping. |
| `customer.service.ts` | Customer list for dropdown selectors — computes display names from DB rows. |
| `sale.service.ts` | Sale creation (multi-step transaction: validate → stock check → sequence number → inserts), voiding, listing/detail queries. Uses raw SQL transactions via better-sqlite3 directly. |

**Note**: Services use a **repository pattern** — public functions on top, private DB-access functions below. DTOs are mapped via helper functions (`toCatalogItem`, `toPartDetail`).

---

## 🗄️ Database / Schema Layer (`src/db/`)

| File | Purpose |
|------|---------|
| `db/index.ts` | SQLite connection (better-sqlite3) — in-memory for tests, file-based otherwise. **Explicit CREATE TABLE statements** (not Drizzle migrations). Exports `db` (Drizzle instance) and `sqliteDb`. |
| `db/schema.ts` | **Canonical schema definition** — all 25+ tables defined with Drizzle ORM column types, enums, indexes, CHECK constraints. Composable column primitives (`lineItemColumns`, `bicycleLineColumns`) shared across line-item tables. Types exported via `$inferSelect` / `$inferInsert`. |
| `db/schema/index.ts` | Barrel re-exports all tables and TypeScript types from schema.ts |

**Key design**: Drizzle defines the schema in code, but table creation uses explicit SQL strings (not `drizzle-kit migrate`). This keeps test/prod DBs aligned.

---

## ✅ Validation Layer (`src/validations/`)

| File | Purpose |
|------|---------|
| `parts-validation.ts` | Zod schemas for part create/update — used by both routes and services |

**Shared validation**: The sales route/service uses shared Zod schemas from the **monorepo `shared` package** (`@pi-skeleton/shared/validations/sales`). This is a cross-package dependency.

---

## 📦 Shared Types (Monorepo Package)

Located at `/home/david/projects/pi-pos-v1/shared/`:

| File | Exports |
|------|---------|
| `types/product.ts` | Product domain type |
| `types/customer.ts` | Customer domain type |
| `types/sale.ts` | Sale domain type |
| `types/stock.ts` | Stock/inventory types |
| `lib/pricing.ts` | Pricing computation (`computeLineTotals`) |
| `validations/sales.ts` | Zod schema for sale input validation |

Imported via `@shared/...` alias in the server package.

---

## 🔬 Feature Modules (`src/features/`)

Two feature folders with their own sub-routes and services:

### `features/dst-auth/`
| File | Purpose |
|------|---------|
| `services/auth-service.ts` | DST Keycloak authentication flow |
| `services/token-cache.ts` | Token caching / expiry tracking |
| `routes/index.ts` | Barrel for dst-auth routes (mounted at `/dst`) |

### `features/product-finder/`
| File | Purpose |
|------|---------|
| `types.ts` | Supplier offer types, search request/response shapes |
| `services/search-service.ts` | EAN + keyword search per supplier and combined |
| `services/import-service.ts` | Import product from supplier into local catalog |
| `services/sync-status-service.ts` | Track sync progress per supplier |
| `services/suppliers/base.ts` | Base supplier adapter interface |
| `services/suppliers/dst/` | DST supplier adapter, auth, detail service |
| `services/suppliers/kruitbosch/` | Kruitbosch supplier adapter, detail + sync services |
| `services/suppliers/gransier/` | Gransier supplier adapter, detail + sync services |
| `routes/index.ts` | Barrel for product-finder routes (mounted at `/product-finder`) |

---

## 🧪 Test Structure

Tests use **Vitest** with in-memory SQLite. Setup sets `NODE_ENV=test`.

| Location | Coverage |
|----------|----------|
| `src/routes/__tests__/` | Route-level: products, customers, sales |
| `src/services/__tests__/` | Service-level: product-service, customer-service |
| `src/features/dst-auth/services/__tests__/` | Auth service + token cache |
| `src/features/product-finder/services/__tests__/` | Deduplication, import, sync-status |
| `src/features/product-finder/services/suppliers/*/__tests__/` | Per-supplier detail and sync services |
| `src/features/product-finder/routes/__tests__/` | Product finder routes + per-supplier detail routes |

Test files live **next to their source** in `__tests__/` subdirectories, not a flat top-level folder.

---

## 🔑 Other Notable Files

| File | Purpose |
|------|---------|
| `src/lib/errors.ts` | Unified error response format — Hono context extensions (`c.jsonError`, `c.jsonNotFound`, etc.), Zod error formatter, DB error classifier |

---

## Architecture Summary

```text
server/src/
├── server.ts              ← entry: boot + start
├── app.ts                 ← Hono core: middleware, error handler, route mount
├── routes/                ← HTTP handlers (flat barrel)
│   ├── index.ts           ← mounts all at /api
│   └── {products,sales,customers,dst-auth,product-finder}.ts
├── services/              ← business logic (repository pattern)
│   ├── product.service.ts
│   ├── customer.service.ts
│   └── sale.service.ts
├── features/              ← self-contained feature modules
│   ├── dst-auth/          ← Keycloak auth
│   └── product-finder/    ← supplier search/sync/import (3 suppliers)
├── validations/           ← Zod schemas (local)
├── lib/errors.ts          ← error helpers + context extensions
├── db/                    ← database layer
│   ├── index.ts           ← SQLite connection + table init
│   └── schema.ts          ← Drizzle table definitions (25+ tables)
└── seed-*.ts              ← seeding scripts
```

**Tech stack**: Hono (HTTP framework), better-sqlite3 (DB), Drizzle ORM (schema/query builder), Zod (validation), Vitest (testing).
