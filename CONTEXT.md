# Pi Pos V1 — Context

## Domain Overview

Pi POS is a reusable starter platform for AI-assisted projects using controlled, step-by-step engineering. It implements a point-of-sale system split across three packages: frontend client, backend server, and shared types/validations.

## Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18 + TypeScript 5 + Vite + Tailwind CSS 3 + Radix UI + Zustand + React Router 6.x (v7 data API) + react-hot-toast |
| **Backend** | Hono 4 + Drizzle ORM + better-sqlite3 |
| **Validation** | Zod (shared between frontend and backend) |
| **Testing** | Vitest (unit, integration, E2E) |
| **Package Manager** | pnpm |

## Architecture

```
client/          # React frontend app
server/          # Node.js API server
shared/          # Types and Zod schemas used by both
```

### Key Principles

1. **Flow-first architecture (target)** — Core transaction logic lives in deep modules (`sale.service.ts`) rather than scattered across feature folders. Features own their UI and routes; services own the business orchestration.
2. **Event-driven communication** — Components fire domain events via `appEvents.emit()`; the app shell maps events to side effects (notifications, store updates).
3. **Flat global state** — Only cross-cutting concerns live in global Zustand stores (sidebar, theme). Features keep their own stores scoped to themselves.
4. **Clean layer boundaries** — Request flow: Routes → Services → Repositories. Mutations use `useFetcher` on the frontend.
5. **Explicit theming** — CSS variables defined in a single file (`client/src/index.css`). Change once, update everywhere.

## Project Structure

### Frontend (`client/`)

**Current State:**

| Path | Purpose |
|------|---------|
| `src/components/ui/` | Atomic UI components (Button, Input, etc.) |
| `src/components/layout/` | Shell components (Header, SidePanel) |
| `src/features/pos/` | Primary POS flow — cart, checkout, payment |
| `src/features/catalog/` | Product reference screens (parts, templates) |
| `src/features/product-finder/` | Search + barcode scan for cart building |
| `src/features/sales-history/` | View past sales and receipts |
| `src/shared/lib/` | Cross-cutting utilities: API client, event bus |
| `src/app/` | App configuration: router, stores, listeners |
| `src/main.tsx` | Entry point |

**Target State (in progress — see `clean-structure-decision.md`):**
- Services moved to flat `server/src/services/`
- Client features standardized with consistent templates (`types`, `api`, `hooks`, `components`)
- Shared domain types in `shared/types/` as single source of truth

### Backend (`server/`)

**Current State:**

| Path | Purpose |
|------|---------|
| `src/features/<name>/routes/index.ts` | Feature-scoped Hono route handlers |
| `src/features/<name>/services/` | Business logic per feature |
| `src/features/<name>/repositories/` | Data access per feature |
| `src/db/schema/` | Drizzle schema (all tables) |
| `src/lib/` | Shared utilities (currency, errors) |

**Target State:**
- Flat services: `server/src/services/sale.service.ts`, `product.service.ts`, etc.
- Flat routes: `server/src/routes/sales.ts`, `products.ts`
- Core transaction logic consolidated in deep modules (`sale/`)

### Shared (`shared/`)

| Path | Purpose |
|------|---------|
| `validations/` | Zod schemas shared between frontend and backend (golden copy) |
| `types/` | TypeScript interfaces used by both layers |
| `index.ts` | Barrel export for all types + validations |

## Key Terminology

| Term | Definition |
|------|-----------|
| **Customer** | Shop customer with contact info (`firstName`, `lastName`, optional `email`/`phone`). Can be unattached to a sale (walk-in). |
| **Direct Sale** | The core POS transaction: customer selects parts from stock, pays via single method, sale is created atomically with stock deduction. `sourceType='direct_sale'`. |
| **Part / Product** | Sellable inventory item stored in the `parts` table. Domain term is "part"; code sometimes uses "product" interchangeably. Has name, optional SKU/barcode, price, and denormalized stock count. |
| **Sale Cart** | Client-side Zustand store holding part line items (partId, quantity, unitPriceNet, vatRateId) awaiting checkout. Lives entirely in the browser until submitted. |
| **Walk-in Sale** | A sale with no customer attached (`sales.customerId` is NULL). Anonymous transaction. |
| **Stock Movement** | Immutable audit row recording every inventory change. `quantityOnHand` on parts is denormalized — always compute from `SUM(quantityDelta)`. Reason=`sale` for POS deductions. |
| **Sequence Number** | Human-readable document numbers (`SA-0001`, `INV-0001`) generated via a dedicated `sequences` table with atomic increment. One sequence per document type. |
| **Voided Sale** | A sale marked `status='voided'`. No stock reversal, no payment unallocation. Used to fix cashier errors. Manager-only (authorization deferred). |

## Sales Flow — Resolved Decisions (2026-05-19)

Scope for the basic sales flow ("customer buys a part from stock"):<br>
Parts-only line items. Walk-in + select existing customer. Single payment method, full amount.<br>
Stock validated and deducted atomically at sale creation. Search + barcode scan for cart building.<br>
No invoicing in this slice. Basic void included (no auth guard yet).

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Parts only** — no labor or bicycle lines yet | `lineItemColumns` already supports all types; narrow scope reduces UI complexity |
| 2 | **Walk-in + existing customer** — no new customer creation | Regulars matter for history; new customer forms add validation complexity deferred to Slice 2 |
| 3 | **Single payment method, full amount** | Covers 95% of transactions; multi-method split deferred (schema already supports it) |
| 4 | **Stock deducted at sale creation** — one atomic transaction | No reservation state in domain; voiding accepts error risk per Rule R13 |
| 5 | **Search + barcode scan** for cart input | Scanners are fast path; search is fallback for missing/damaged barcodes |
| 6 | **No invoicing** — sale = receipt | Invoices require company validation, PDF/print view — belongs in Slice 2 |
| 7 | **Hard block at checkout** for insufficient stock | Server-side atomic validation only; cart accepts anything |
| 8 | **Dedicated sequence table** for document numbers | Atomic increment avoids race conditions vs MAX+1; human-readable numbers expected by staff |
| 9 | **Single service function** `createDirectSale()` | One ACID transaction: validate → number → sale + lines + payment + allocation + stock movements |
| 10 | **Basic void included** — no authorization yet | One PATCH endpoint, zero schema changes; auth guard added later |
| 11 | **Single-page POS layout** — split panels | Catalog/cart left, checkout controls right. Sale history on separate route. |

## Development Workflow

1. **Grill & Define** — Start with an idea prompt via `grill-with-docs` to refine requirements and update context. 
2. **Plan & Scope** — Create a PRD from the conversation, then break it into GitHub issues (`to-prd`, `to-issues`).
5. **Review & Test** — Validate against architecture and conventions before committing.

## Documentation Strategy

*   **Source of Truth:** `CONTEXT.md` is the living map. It defines what we *want* to build. The codebase is reality; if they diverge, drift detection flags it.
*   **Immutable History:** ADRs (`docs/40-decisions/`) are for permanent decisions. They are not auto-updated by the system. You only update them when officially overturning a decision.


## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| Dev | `pnpm dev` | Start client + server simultaneously |
| Build | `pnpm build` | Build both client and server |
| Test | `pnpm test` | Run all tests |
| Lint | `pnpm lint` | Lint all code |

## Constraints & Conventions

- **No `as` type assertions** in production code — use proper narrowing or shoehorn for partial data.
- **Features own their types** — shared types are only for cross-cutting concerns or things genuinely needed by both layers.
- **One source of truth per concept** — if a type or schema changes, update it in one place and propagate via shared package.
- **CSS variables for theming** — never inline color values; always reference the design tokens.
