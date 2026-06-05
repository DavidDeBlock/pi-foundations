# Pi Pos V1 — Domain Map

## Overview
Pi POS is a point-of-sale system for bicycle shops, split across three packages: frontend client (React), backend server (Hono), and shared types/validations. The primary business flow is in-store sales (parts checkout).

---

## Core Directories

### `/client` — Frontend Application
**Technology:** React 18 + TypeScript 5 + Vite + Tailwind CSS 3 + Zustand + React Router 7.x data API

| Directory | Purpose |
|-----------|---------|
| `src/features/pos/` | **Primary POS flow** — cart, checkout, payment UI |
| `src/features/catalog/` | Product reference screens (parts, bicycle-templates, labor-services) |
| `src/features/product-finder/` | Search + barcode scan for cart building |
| `src/features/sales-history/` | View past sales and receipts |
| `src/components/ui/` | Atomic UI components (Button, Input, Dialog, etc.) |
| `src/components/layout/` | Shell components (Header, SidePanel) |
| `src/app/` | App configuration: router, stores, event listeners, toast provider |
| `src/shared/lib/` | Cross-cutting utilities: API client, event bus, notifications |

### `/server` — Backend Services
**Technology:** Hono 4 + Drizzle ORM + better-sqlite3

| Directory | Purpose |
|-----------|---------|
| `src/features/sales/` | **Primary sale flow** — routes, services (createDirectSale), repositories |
| `src/features/parts/` | Product CRUD + stock management |
| `src/features/customers/` | Customer CRUD |
| `src/features/sequences/` | Document numbering service (SA-0001, INV-0001) |
| `src/features/stock-validator/` | Stock availability checks for sale flow |
| `src/features/bicycle-templates/` | Bicycle template management |
| `src/features/labor-services/` | Labor/service line item management |
| `src/features/dst-auth/` | Authentication routes and services |
| `src/db/schema/` | Drizzle schema (all tables) |
| `src/lib/` | Shared server utilities (currency, errors, etc.) |

### `/shared` — Types & Validations
**Technology:** TypeScript + Zod schemas shared between client and server

| Directory | Purpose |
|-----------|---------|
| `validations/` | Zod schemas for sales, products, customers, constants |
| `types/` | TypeScript interfaces used by both layers (if any) |

---

## Domain Entities

### Sale
**Purpose:** Core POS transaction. Represents a customer purchasing parts from stock.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID primary key |
| `sequenceNumber` | string | Human-readable doc number (`SA-0001`) |
| `customerId` | string \| NULL | Walk-in sales have NULL |
| `status` | string | `'active'`, `'voided'` |
| `sourceType` | string | `'direct_sale'` for POS transactions |
| `totalNetCents` | number | Sum of line items before tax |
| `totalTaxCents` | number | Total VAT |
| `totalGrossCents` | number | Final amount paid |
| `createdAt` | Date | Auto-generated on insert |

**Rules:**
- Created atomically: validate stock → generate sequence → create sale + lines + payment + allocation + stock movements in one transaction.
- Voiding does NOT reverse stock or payments (accepts error risk per domain rule).

### Sale Line Item
**Purpose:** Individual part on a sale.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID primary key |
| `saleId` | string | FK to sales |
| `partId` | string | FK to parts (always parts in V0) |
| `quantity` | number | Always 1 for V0 |
| `unitPriceNetCents` | number | Price at time of sale |
| `vatRateId` | number | VAT rate applied |

### Customer
**Purpose:** Shop customer. Can be NULL on a Sale (walk-in).

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID primary key |
| `firstName` | string | Required |
| `lastName` | string | Required |
| `email` | string \| NULL | Optional contact |
| `phone` | string \| NULL | Optional contact |

### Part (Product)
**Purpose:** Sellable inventory item.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID primary key |
| `name` | string | Display name |
| `sku` | string \| NULL | Optional SKU |
| `barcode` | string \| NULL | For scanner lookup |
| `unitPriceNetCents` | number | Selling price |
| `costPriceCents` | number | Shop cost (for margin tracking) |
| `quantityOnHand` | number | Denormalized — compute from stock movements |

### Stock Movement
**Purpose:** Immutable audit trail for every inventory change.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID primary key |
| `partId` | string | FK to parts |
| `quantityDelta` | number | Positive = in, negative = out |
| `reason` | string | `'sale'`, `'purchase'`, `'adjustment'`, etc. |
| `referenceId` | string \| NULL | FK to sale/purchase/etc. |
| `createdAt` | Date | Auto-generated |

**Rule:** `quantityOnHand` on parts is denormalized — always compute as `SUM(quantityDelta)` for accuracy. Stock movements are the source of truth.

### Sequence Number
**Purpose:** Human-readable document numbering (`SA-0001`, `INV-0001`).

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID primary key |
| `docType` | string | `'sale'`, `'invoice'`, etc. |
| `nextNumber` | number | Atomic counter for next document |

**Rule:** One sequence per doc type. Atomic increment avoids race conditions vs MAX+1 approach.

---

## Layer Boundaries

### Data Flow (One Direction Only)
```
Route → Service → Repository → Database
   ↑        ↑           ↑            ↑
Response ← Response ← Response ← Result
```

**Rules:**
- Routes only handle HTTP concerns (status codes, headers, validation middleware)
- Services contain business logic and orchestration (e.g., `createDirectSale()`)
- Repositories only do database operations (Drizzle queries)
- No layer skips (route can't call repository directly)

### State Management Hierarchy
| Level | Scope | Technology |
|-------|-------|------------|
| Local | Single component | React `useState` |
| Feature | One feature module | Zustand store per feature |
| Global | Entire app | Sidebar + theme stores only (cross-cutting) |

**Rule:** Prefer local → feature → global. Avoid global monolith stores.

---

## Architecture Decision Records (ADRs)

**Location:** `docs/40-decisions/`  
**Purpose:** Historical record of significant architectural decisions.

### Current Accepted Decisions

| ADR | Title | Status | Summary |
|-----|-------|--------|---------|
| **ADR-002** | React Router data API pattern | ✅ Accepted | Use loaders/actions for all data operations, not useEffect |
| **ADR-003** | Zustand for state management | ✅ Accepted | One store per feature, avoid global monolith stores |
| **ADR-004** | App-level event system | ✅ Accepted | Lightweight pub/sub for cross-cutting side effects (notifications, gamification) |
| **ADR-007** | Sequence table for document numbering | ✅ Accepted | Dedicated sequences table with atomic increment for human-readable doc numbers |
| **ADR-008** | Flow-first architecture — Consolidate transaction logic | ✅ Accepted | Move from feature-per-domain scattering to flow-first consolidation. Transaction orchestration in flat services (`sale.service.ts`). |

### Superseded Decisions

| Old ADR | Title | Superseded By | Reason |
|---------|-------|---------------|--------|
| **ADR-001** | Feature-based folder structure | Flow-first consolidation (in progress) | Scattered transaction logic across 5+ directories; sale flow needs to live in one place |

### ADR Rules for AI Agents

1. **Always check ADRs first** before making architectural decisions
2. **Never edit accepted ADRs** — create a new superseding ADR instead
3. **Reference relevant ADRs** in implementation notes when applicable
4. **Suggest new ADR** if decision has significant long-term impact

---

## Testing Strategy

**Tool:** Vitest (unit/integration), Playwright (E2E)

### Test File Organization
```
client/src/
├── features/<name>/__tests__/      # Feature-specific tests
│   ├── services/                   # Service unit tests
│   └── components/                 # Component unit tests
├── app/__tests__/                  # App-level tests (router, stores)
├── __tests__/                      # Shared tests
└── e2e/                            # End-to-end tests

server/src/features/<name>/__tests__/  # Server feature tests
```

### Coverage Requirements
| Component Type | Minimum | Critical Paths |
|----------------|---------|----------------|
| Services | 80% | All public methods |
| Components | 70% | User interaction flows |
| Utilities | 90% | Edge cases included |
| Hooks | 75% | State transitions tested |

---

## Technology Stack Summary

| Category | Technology | Purpose |
|----------|-----------|---------|
| Frontend Framework | React 18 + TypeScript 5 | UI and type safety |
| Styling | Tailwind CSS 3 + Radix UI | Utility-first styling, accessible primitives |
| State Management | Zustand 0.3.x | Feature-level state |
| Routing | React Router 7.x data API | Loaders/actions pattern |
| Backend Framework | Hono 4.x | Lightweight API server |
| ORM | Drizzle ORM | Type-safe queries |
| Database | better-sqlite3 | File-based storage (dev) / sql.js (browser tests) |
| Validation | Zod 1.x | Runtime + compile-time checks, shared between layers |
| Testing | Vitest 1.x + Playwright | Unit/integration and E2E testing |
