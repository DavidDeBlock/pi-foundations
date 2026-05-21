# Clean Structure Decision — POS V0

**Date:** 2026-05-18  
**Status:** Implemented (Slice #131)

---

## Context

The codebase was structured around "features" using `todos` as a demo template. The question: does feature-per-domain make sense for a POS where the primary flow (sale) touches products, customers, payments, documents, and stock simultaneously?

**Answer:** No. Feature-per-domain scatters the sale flow across 5+ directories communicating via events or cross-imports. The complexity of coordinating a transaction leaks into every boundary instead of living in one place.

---

## V0 Scope — In-Store Sales

| Scenario | Description |
|----------|-------------|
| 1 | Anonymous sale of an in-stock part |
| 2 | Anonymous quick sell (unknown in-stock part) |
| 3 | Named customer sale of an in-stock part |
| 4 | Named customer quick sell (unknown in-stock part) |
| 5 | Named customer sale → backorder (not in stock) |

---

## Chosen Direction

**Flow-first slices with shared domain models.** `sale/` is the primary feature; catalog and customers are reference screens. Backend services handle transaction orchestration synchronously. No event bus for core logic.

---

## Proposed Structure

### Frontend (`client/src/`)

```
client/src/
├── main.tsx                    # Entry: providers + <AppShell />
├── app/
│   ├── App.tsx                 # Layout shell only (Header, SidePanel, Outlet)
│   ├── router.ts               # Route aggregation
│   └── stores/
│       ├── sidebar.ts          # Sidebar state
│       └── theme.ts            # Theme + localStorage persistence
├── features/
│   ├── sale/                   # ⭐ Primary flow — checkout end-to-end
│   │   ├── components/         # Cart, PaymentForm, ReceiptView
│   │   ├── store.ts            # Cart state, payment orchestration
│   │   ├── service.ts          # POST /api/sales, GET /api/products (lookup)
│   │   └── routes/index.tsx    # /sale route with loader + action
│   ├── catalog/                # Product reference screen
│   │   ├── components/         # ProductList, ProductForm, SearchBar
│   │   ├── store.ts            # Local filter/search state
│   │   ├── service.ts          # CRUD /api/products
│   │   └── routes/index.tsx    # /catalog route
│   ├── customers/              # Customer reference screen
│   │   ├── components/         # CustomerList, CustomerForm
│   │   ├── store.ts            # Local filter/search state
│   │   ├── service.ts          # CRUD /api/customers
│   │   └── routes/index.tsx    # /customers route
│   └── backorders/             # Future — scenario 5
├── shared/
│   ├── lib/
│   │   ├── apiClient.ts        # Typed HTTP client (envelope parsing)
│   │   ├── notifications.ts    # Toast wrapper
│   │   └── utils.ts            # cn(), generateId()
│   └── components/             # Shared UI primitives if needed
└── components/ui/              # Radix wrappers (Button, Input, Dialog...)
```

### Backend (`server/src/`)

```
server/src/
├── app.ts                      # Hono app + middleware
├── db/
│   ├── schema.ts               # Drizzle schema (all tables)
│   └── index.ts                # Database connection
├── routes/
│   ├── sales.ts                # POST /api/sales, GET /api/sales/:id
│   ├── products.ts             # CRUD /api/products
│   ├── customers.ts            # CRUD /api/customers
│   └── index.ts                # Route aggregation (app.route('/api', ...))
├── services/
│   ├── sale.service.ts         # Transaction: create sale → deduct stock → create document
│   ├── product.service.ts      # Product CRUD + stock management
│   └── customer.service.ts     # Customer CRUD
└── validations/                # Re-exports from @shared (golden copy pattern)
```

### Shared (`shared/`)

```
shared/
├── types/
│   ├── product.ts              # Product, NewProduct, UpdateProduct
│   ├── customer.ts             # Customer, NewCustomer
│   ├── sale.ts                 # Sale, SaleLine, CartItem, Payment
│   ├── document.ts             # Document (receipt/invoice), DocumentLine
│   └── stock.ts                # StockEntry, StockMovement
├── validations/
│   ├── product.schema.ts       # Zod schemas for products
│   ├── customer.schema.ts      # Zod schemas for customers
│   ├── sale.schema.ts          # Zod schemas for sales/cart
│   └── index.ts                # Barrel export
└── index.ts                    # Re-export all types + validations
```

---

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Domain models in `shared/types/` | Owned by nobody, used by everyone. Prevents "sale needs to reach into products feature" problem. |
| No event bus for core transaction logic | Sale is synchronous orchestration in `sale.service.ts`. If it fails, whole thing rolls back. Events only for cross-cutting side effects (gamification, analytics). |
| Split global stores from day one | `sidebar.ts` and `theme.ts` separate. No flat bag of unrelated slices. |
| Delete `todos` demo | First real slice is `sale/`. Don't build conventions around a demo that teaches the wrong pattern for POS. |
| Backend services handle orchestration | `sale.service.ts` coordinates products, stock, documents, payments in one transaction. One place to test the whole flow. |

---

## What Stays (Good Patterns)

- **Golden copy** for validations (`shared/validations/` → server re-export) ✅
- **Feature self-containment** (UI + routes + store + service in one directory) ✅
- **React Router data API** (loaders/actions, no useEffect fetching) ✅
- **Zustand for client state** ✅

---

## Not In Scope (V0)

- Backorders beyond basic reservation (scenario 5 — park until base flow works)
- Bicycles/repairs domain
- Advanced stock (FIFO, batches)
- Auth/RBAC (single user for V0)
- Supplier integrations
- Accounting automation

---

## Open Questions

1. Should `catalog/` and `customers/` be features or just pages under a shared "reference" module? (Keep as features for consistency — doesn't matter much for V0.)
2. Does the sale flow need its own database transaction boundary, or is better-sqlite3's single-writer model sufficient? (Likely sufficient for V0.)

---

## Next Safe Step

Define `shared/types/sale.ts` and `shared/types/product.ts` — the models that everything depends on. Then build scenario 1 (anonymous sale of in-stock part) end-to-end through `features/sale/`. This validates the structure before adding complexity.
