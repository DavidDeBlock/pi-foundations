# Agent Brief: Structural Refactor — Flow-First Architecture

## The Point
Move from a **"feature-per-domain"** architecture (which scatters transaction logic across 5+ directories like `sales`, `stock-validator`, and `sequences`) to a **flow-first** architecture centered on the primary business process (`sale/`). 

This refactoring consolidates complexity into deep modules, establishes consistent structural templates for both client and server, and creates explicit shared domain types so code doesn't rely on database inference.

---

## Current State vs. Target State

| Aspect | Current (Scattered) | Target (Flow-First) |
| :--- | :--- | :--- |
| **Transaction Logic** | Split across `sales/`, `stock-validator/`, `sequences/` | Consolidated in a single deep module: `sale/` |
| **Backend Structure** | Nested feature folders (`features/sales/routes/index.ts`) | Flat services & routes (`services/sale.service.ts`, `routes/sales.ts`) |
| **Domain Types** | Implicit (Drizzle inference) or duplicated locally | Explicit in `shared/types/` — single source of truth |
| **Client Structure** | Inconsistent across features (flat vs nested) | Standardized feature template (`types`, `api`, `hooks`, `components`) |
| **Shared Logic** | Duplicated (e.g., line math exists on client & server) | Deep shared modules (`shared/lib/pricing.ts`) used by both |

---

## What Needs To Be Done (Key Shifts)

### 1. Foundation: Shared Domain Types
*   **Action:** Create explicit TypeScript interfaces in `shared/types/` for core entities (`Sale`, `Product`, `Customer`).
*   **Why:** Code currently relies on Drizzle `$inferSelect`. Explicit types decouple the business logic from database implementation details and allow the client to use these types without importing server code.

### 2. Backend: Flatten Services & Routes
*   **Action:** Migrate away from the `features/<name>/` nesting pattern for core logic. Adopt a flat structure:
    *   `server/src/services/sale.service.ts` (Transaction orchestration)
    *   `server/src/routes/sales.ts` (HTTP handlers)
*   **Why:** The current nested structure makes it hard to see the full scope of a feature's logic at a glance. A flat layout creates clear boundaries between "what we do" (services) and "how we expose it" (routes).

### 3. Core Flow: Consolidate `sale/` Module
*   **Action:** Move validation, stock checks, and sequence generation into the primary sale module. Remove the standalone `stock-validator` feature folder (fold logic back or move to `lib`).
*   **Why:** A sale is a single transaction flow. Splitting it across features forces callers to manage cross-imports for what should be an atomic operation.

### 4. Frontend: Standardize Feature Templates
*   **Action:** Define and enforce a consistent layout for all client features (e.g., `types.ts`, `api.ts`, `hooks/`, `components/`). Migrate existing features (`pos`, `sales-history`) to match.
*   **Why:** Currently, every feature folder has a unique structure. Standardization reduces "navigation friction" for both humans and AI agents scanning the codebase.

---

## Scope & Risk Note
**This is a big refactor.** It touches almost every directory in the project. The goal is to preserve all existing functionality while fundamentally changing *how* that functionality is organized. Tests must remain green throughout, ideally by treating this as a structural lift with no behavioral changes until new features are added on top of the clean structure.
