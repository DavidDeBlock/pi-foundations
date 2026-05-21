# ADR-008: Flow-First Architecture — Consolidate Transaction Logic

**Status**: ✅ Accepted  
**Date**: 2026-05-21  
**Authors**: David De Block  

---

## Context

The codebase was structured around "features" using `todos` as a demo template (ADR-001). Each feature is self-contained with its own components, hooks, services, and routes in `features/[name]/` folders.

This works well for independent CRUD modules (products, customers) but **breaks down for the primary business flow** — the sale transaction. A sale touches products, stock, sequences, payments, and documents simultaneously. With feature-per-domain, this atomic operation is scattered across 5+ directories (`sales`, `stock-validator`, `sequences`), forcing callers to manage cross-imports and coordinate state between features.

The complexity of coordinating a transaction leaks into every boundary instead of living in one place. This makes the sale flow hard to test, hard to understand, and hard to modify safely.

---

## Decision Drivers

1. **Atomicity** — A sale is one ACID transaction. The code reflecting that should be co-located.
2. **Testability** — Testing a sale means exercising validation → numbering → creation → stock deduction → payment allocation in one function, not orchestrating across 5 feature imports.
3. **Navigability** — Developers (and AI agents) should find the complete sale flow by reading one module (`sale.service.ts`), not jumping between `features/sales/`, `features/stock-validator/`, and `features/sequences/`.
4. **Existing good patterns preserved** — Feature folders still work well for UI boundaries (POS screen, catalog screen). We keep features for presentation but move orchestration to flat services.

---

## Options Considered

### Option A: Keep feature-per-domain (current)
**Pros:** Familiar pattern from skeleton project. Each feature is independently deletable.  
**Cons:** Sale flow scattered across 5+ directories. Cross-feature coordination is implicit and hard to audit. Testing requires mocking multiple features.

### Option B: Flow-first with flat services + feature UIs
**Pros:** Transaction logic lives in one place (`sale.service.ts`). Services are independently testable. Features own only their UI/routes/stores (thin). Shared domain types decouple client from server implementation.  
**Cons:** Breaking change to existing codebase structure. Requires migration of all features. Some features become "thin" with minimal internal complexity.

### Option C: Pure type-based organization
Split everything by concern: `routes/`, `services/`, `repositories/` at the top level with no feature grouping.  
**Pros:** Maximum consistency.  
**Cons:** Loses natural feature boundaries for UI code. Harder to find all code related to "POS checkout" when it's split across 10 directories.

---

## Decision Outcome: Option B — Flow-First Architecture

Adopt a hybrid approach that preserves the best of both worlds:

### Backend Structure (Target)
```
server/src/
├── routes/
│   ├── sales.ts              # HTTP handlers only (thin wrappers)
│   ├── products.ts
│   └── customers.ts
├── services/
│   ├── sale.service.ts       # ⭐ Transaction orchestration — the full flow
│   ├── product.service.ts    # Product CRUD + stock management
│   └── customer.service.ts   # Customer CRUD
├── db/schema/                # Drizzle schema
└── lib/                      # Shared utilities (currency, errors)
```

### Frontend Structure (Target — standardized template)
```
client/src/features/<name>/
├── types.ts                  # Feature-specific types
├── api.ts                    # API call functions
├── hooks/                    # React hooks for data fetching/state
├── components/               # UI components specific to this feature
└── routes/index.tsx          # Route definition (loader + action)
```

### Shared Domain Types (NEW)
```
shared/types/
├── sale.ts                   # Sale, SaleLine, CartItem, Payment interfaces
├── product.ts                # Product, NewProduct interfaces
├── customer.ts               # Customer, NewCustomer interfaces
└── stock.ts                  # StockMovement interface
```

### What Changes
- **Services consolidate** — `sale.service.ts` owns the complete `createDirectSale()` flow (validate → number → create sale + lines + payment + allocation + stock movements). No cross-feature imports needed.
- **Routes thin out** — Route handlers only parse HTTP, call services, return responses. Business logic lives in services.
- **Shared types emerge** — Explicit TypeScript interfaces in `shared/types/` decouple business logic from Drizzle inference. Client can use these without importing server code.
- **Feature folders for UI only** — Features still own their routes and components, but the heavy lifting (transaction orchestration) moves to flat services.

### What Stays (Good Patterns Preserved)
- ✅ Feature self-containment for UI code (components + routes + stores in one directory)
- ✅ Golden copy pattern for validations (`shared/validations/` → server re-export)
- ✅ React Router data API (loaders/actions, no useEffect fetching)
- ✅ Zustand for client state (one store per feature)
- ✅ Event-driven cross-cutting side effects (notifications, gamification via `appEvents`)

---

## Supersedes
- **ADR-001** (Feature-based folder structure) — Feature folders remain useful for UI boundaries but no longer own transaction orchestration.

---

## References
- [Clean Structure Decision](../31-planning-notes/clean-structure-decision.md) — Detailed migration plan and target structures
- [Refactor Agent Brief](../31-planning-notes/refactor-agent-brief.md) — Implementation scope and risk assessment
