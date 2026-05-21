# Agent Brief: Deepen App Layer Event Listeners

## Context & Goal
The current `client/src/app/eventListeners.ts` is a centralized coordination point that requires editing the app shell for every new feature. This violates **locality** and makes the interface shallow (growing switch-like body). 

We are deepening this seam by moving event→side-effect mapping into features, introducing explicit declaration, type safety via a registry, and a function-based registration API.

## Constraints
1. **Explicit Declaration:** Features must explicitly declare which events they listen to. The app shell validates these against a central registry (warns on unknown events).
2. **Feature-Scoped Side Effects:** Move all side effects (gamification points, toasts, console logs) out of the app shell and into feature-specific modules. 
   - **Proposed Folder:** `client/src/features/<name>/listeners/` — mirrors the existing `routes/`, `store.ts`, `service.ts` structure.
3. **Central Event Registry:** Create a type registry (`AppEventRegistry`) to enforce payload types across features, eliminating `payload as { ... }` casts everywhere.
4. **Function-Based API:** Features export `registerFeatureListeners(): () => void`. The app shell collects and calls these functions once on mount.
5. **Testing Locality:** Event handler tests move into the respective feature's `__tests__/` directory (e.g., `client/src/features/todos/__tests__/listeners.test.ts`).

## Proposed Folder Structure
```text
client/src/
├── app/
│   ├── eventRegistry.ts       # Central type registry + validation utility
│   └── registerAppListeners.ts # Collects, validates, and calls all feature listeners
└── features/
    └── todos/
        ├── __tests__/
        │   └── listeners.test.ts  # Tests for todo event handlers
        ├── listeners/
        │   ├── index.ts         # Exports registerTodoListeners()
        │   └── gamification.ts  # (Optional) specific side effects like points/toasts
        ├── routes/index.tsx
        ├── store.ts
        └── service.ts
```

## Implementation Steps

### Phase 1: Core Infrastructure (`client/src/app/`)
1. **Create `eventRegistry.ts`:**
   - Define a central map type: `type AppEventRegistry = { [eventName: string]: unknown }` (or stricter with generics if preferred).
   - Export a validation utility that checks feature-declared events against known emitted events.
2. **Refactor `eventListeners.ts` → `registerAppListeners.ts`:**
   - Remove hardcoded event handlers.
   - Accept an array of registration functions from features.
   - Iterate over them, call each to get unsubscribe functions, and return a combined cleanup function.

### Phase 2: Feature Migration (`client/src/features/todos/`)
1. **Create `listeners/index.ts`:**
   - Export `registerTodoListeners(): () => void`.
   - Import event types from the central registry.
   - Re-implement current handlers (gamification points, toasts) inside this function.
2. **Update `appEvents.emit()` calls:**
   - Ensure components/services still emit events with typed payloads matching the registry.
3. **Move Tests:**
   - Move any listener-specific tests from shared locations into `todos/__tests__/listeners.test.ts`.

### Phase 3: Cleanup & Validation
1. Remove the old `eventListeners.ts` file.
2. Update `App.tsx` to import and call `registerAppListeners()` with feature registration functions.
3. Verify type safety: ensure mismatched event payloads are caught at compile time via the registry.

## Acceptance Criteria
- [ ] No hardcoded event handlers remain in the app shell.
- [ ] Features explicitly declare their listened events (explicit declaration).
- [ ] Central event registry enforces payload types (no `as` casts in listeners).
- [ ] Each feature has a `listeners/` folder with its own registration function.
- [ ] Tests for event handlers live inside the respective feature's `__tests__/` directory.
- [ ] App shell collects and calls all feature listeners on mount, returning a combined cleanup function.

## Notes for Implementer
- The `appEvents` singleton itself stays in `shared/lib/events.ts` — we are only moving the *handlers*, not the emitter.
- If gamification points should remain cross-cutting (e.g., awarded by multiple features), consider placing that specific listener in a shared `client/src/app/crossCuttingListeners.ts` or keep it feature-scoped if each feature knows its own point rules. Based on constraint #2, we'll move it to the feature scope.
- Keep the registration function signature consistent: `() => () => void` (subscribe → unsubscribe).
