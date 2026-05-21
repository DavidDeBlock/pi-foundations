# Project Glossary

**Last Updated:** 2026-05-21  
**Maintained By:** Development Team  
**Status:** ✅ Current  

---

## Purpose

This glossary defines project-specific terminology to ensure consistent understanding across the team and AI agents. Terms here reflect the **POS domain**, not template scaffolding.

---

## A

### App Event / Domain Event
A named signal fired via `appEvents.emit()` to communicate cross-cutting side effects (notifications, gamification points) from features to the app shell. Events are decoupled — features don't know who listens. Payloads are typed via an event registry.

---

## C

### Customer
Shop customer with contact information (`firstName`, `lastName`, optional `email`/`phone`). Can be unattached to a sale (walk-in). Stored in the `customers` table.

### Direct Sale
The core POS transaction: customer selects parts from stock, pays via single method, sale is created atomically with stock deduction. `sourceType='direct_sale'`. This is V0's only supported sale type.

---

## E

### Event Listener
A function registered in a feature's `listeners/` directory that responds to domain events fired by other features or the app shell. The app shell collects and calls all listener registration functions on mount.

---

## F

### Feature
A self-contained unit of functionality spanning types, validations (Zod schemas), UI components, routes, stores, and services. Features own their code but share a common structural template. Examples: `pos/`, `catalog/`, `product-finder/`.

**Note:** The current architecture uses feature-based folder organization (`features/<name>/`), but the target state is **flow-first consolidation** where core transaction logic moves into deep modules (e.g., `sale.service.ts`) rather than scattered across multiple features. See `clean-structure-decision.md` in planning notes.

### Feature Contract
A document specifying a feature's scope, requirements, architecture, and acceptance criteria before implementation begins. Created via the `to-prd` skill and published as a GitHub Issue.

---

## G

### Golden Copy Pattern
The practice of using one existing feature module as a structural reference template for new features, ensuring consistent patterns across modules. Currently based on the sales feature structure.

---

## L

### Layer
A logical separation of concerns in the codebase:
- **Presentation Layer**: UI components (React)
- **Business Logic Layer**: Services and route handlers
- **Data Access Layer**: Repositories (Drizzle queries)

**Rule:** Request flow is Routes → Services → Repositories. No layer skips.

### Line Item
A single part on a sale with `partId`, `quantity` (always 1 in V0), `unitPriceNetCents`, and `vatRateId`. Stored in the `saleLineItems` table.

---

## P

### Part (Product)
Sellable inventory item stored in the `parts` table. Has a name, optional SKU/barcode, selling price (`unitPriceNetCents`), cost price (`costPriceCents`), and denormalized stock count (`quantityOnHand`). The domain term is "part"; some code uses "product" interchangeably.

### Sale
Core POS transaction record. Contains `sequenceNumber`, optional `customerId`, `status` (active/voided), financial totals, and a list of line items. Created atomically in one database transaction.

### Sale Cart
Client-side Zustand store holding part line items (`partId`, `quantity`, `unitPriceNetCents`, `vatRateId`) awaiting checkout. Lives entirely in the browser until submitted via POST to `/api/sales`.

---

## S

### Sequence Number
Human-readable document numbers (`SA-0001`, `INV-0001`) generated via a dedicated `sequences` table with atomic increment. One sequence per document type (`sale`, `invoice`). Avoids race conditions vs MAX+1 approach.

### Slice
A vertical slice of work: one complete user story touching all layers (types → DB → API → UI). Used by the planner and to-issues skills to break down features into independently shippable units.

### Stock Movement
Immutable audit row recording every inventory change in the `stockMovements` table. Fields: `partId`, `quantityDelta` (+/-), `reason` (`sale`, `purchase`, `adjustment`), optional `referenceId`. 

**Rule:** `quantityOnHand` on parts is denormalized — always compute as `SUM(quantityDelta)` for accuracy. Stock movements are the source of truth.

### Store
Zustand store. Global stores are cross-cutting only (sidebar, theme). Feature stores live within their feature directory and manage feature-specific state.

---

## V

### Validation Schema
Zod schemas that define expected input shapes and provide runtime type checking. Shared between frontend (form validation) and backend (request validation) via the `shared/validations/` package. Server re-exports them as a "golden copy" to prevent schema drift.

### Voided Sale
A sale marked `status='voided'`. No stock reversal, no payment unallocation. Used to fix cashier errors. Manager-only in production (authorization deferred for V0). Implemented via one PATCH endpoint with zero schema changes.

---

## W

### Walk-in Sale
A sale with no customer attached (`sales.customerId` is NULL). Anonymous transaction. Supported alongside named-customer sales in V0.

---

## Acronyms & Abbreviations

| Term | Meaning |
|------|---------|
| **ADR** | Architecture Decision Record |
| **API** | Application Programming Interface |
| **CI/CD** | Continuous Integration / Continuous Deployment |
| **CRUD** | Create, Read, Update, Delete |
| **E2E** | End-to-End (testing) |
| **MVP** | Minimum Viable Product |
| **ORM** | Object-Relational Mapping |
| **P0/P1/P2** | Priority levels (Critical/Important/Nice-to-have) |
| **POS** | Point of Sale |
| **PR** | Pull Request |
| **UI** | User Interface |

---

## Related Documentation

- [Architecture Overview](../20-architecture/_index.md) — System design concepts
- [CONTEXT.md](../../CONTEXT.md) — Living domain model and key principles
- [docs/40-decisions/index.md](../40-decisions/index.md) — Historical architectural decisions

---

**Last Updated:** 2026-05-21  
**Review Status:** Active
