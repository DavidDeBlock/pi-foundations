# PRD: Eliminate Client/Server Business Logic Divergence

## Problem Statement

The client-side Zustand stores (`client/src/features/repairs/store.ts`, `client/src/features/pos/store.ts`) duplicate server-side business logic. Specifically, the repairs store enforces status transition rules and field editability guards locally using a copy of `VALID_STATUS_TRANSITIONS`. This creates a correctness risk: if server validation rules change, the client silently allows invalid operations until the API rejects them at runtime. The duplication means two places must be maintained in sync, and they inevitably drift.

## Solution

Remove local business rule enforcement from client stores. Store actions become thin async wrappers around API calls for server-enforced rules (status transitions, field updates). Client-only logic (cart merging, quick-sell ID generation) is extracted into dedicated pure modules with small interfaces. The store becomes a predictable state manager that only applies changes confirmed by the server or computed by pure functions.

## User Stories

1. As a mechanic, I want repair status transitions to be validated on the server so that I never see invalid states in the UI
2. As a POS operator, I want cart item merging and quick-sell ID generation to be handled by dedicated modules so that the logic is testable and predictable
3. As a developer, I want business rules to live in a single source of truth so that I don't have to maintain duplicate validation logic across client and server
4. As a QA engineer, I want store actions to wait for API confirmation before updating state so that invalid transitions are caught immediately without complex rollback flows
5. As a maintainer, I want the Zustand stores to contain only state shape and async dispatch logic so that new developers can understand the data flow without tracing hidden validation rules

## Implementation Decisions

- **Server-Enforced Rules → Async Store Actions**: All store actions that touch server-authoritative data (repairs status, field edits) will be made `async`. They call the corresponding API service first, and only update local state after receiving a successful response. No local validation or rollback logic is needed because invalid changes are never applied.
- **Client-Only Logic → Pure Modules**: Cart merging (`mergeItems`) and quick-sell ID generation (`generateQuickSellId`) will be extracted from `client/src/features/pos/store.ts` into a dedicated pure module at `client/src/features/pos/lib/cart.ts`. The store will delegate to these functions, keeping it thin and predictable.
- **Zustand Remains the State Manager**: Per ADR-003, we continue using Zustand with one store per feature. We are not changing the state management library or introducing global monolith stores.
- **Shared Types as Documentation Only**: `VALID_STATUS_TRANSITIONS` remains in shared types for type safety and documentation, but is no longer used for runtime validation on the client side. The server is the single source of truth.
- **Optimistic UX Trade-off**: Store actions will be synchronous from the caller's perspective (they dispatch async operations), but UI updates only happen after API confirmation. This means slightly slower feedback than "true optimistic" updates, but eliminates the risk of showing invalid states or requiring complex snapshot/restore rollback logic.

## Testing Decisions

- **Pure Module Tests**: The extracted `cart.ts` module will be tested as pure functions with no React/Zustand dependencies. Tests will verify merge behavior, quantity increments, and quick-sell ID uniqueness.
- **Async Store Action Tests**: Store actions will be tested by mocking the API service layer. Tests will verify that state is only updated when the API returns success, and that errors are properly surfaced to callers.
- **Integration Coverage**: Existing integration tests for repairs status transitions and POS checkout flows will continue to work but will now rely on server-side validation rather than client-side guards.
- **No Snapshot/Rollback Tests Needed**: Because we use server-confirmed updates (Option A), there is no rollback logic to test, reducing test surface area and maintenance cost.

## Out of Scope

- Sales store changes (`client/src/features/sales/store.ts`) — already has basic rollback patterns for void operations
- Other feature stores not affected by business rule duplication
- Changes to server-side services or API contracts
- Real-time optimistic updates with background reconciliation (deferred if UX becomes a bottleneck)

## Further Notes

This refactor aligns with the project's layer boundary rules and reduces architectural friction. By removing local validation from stores, we eliminate a class of bugs that only surface in production when client and server drift apart. The pattern established here can be applied to other features as they grow.
