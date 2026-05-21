# Feature Documentation

**Last Updated:** 2026-04-18  
**Maintained By:** Development Team  
**Status:** ✅ Current  

---

## Purpose

This section contains documentation for individual features and cross-feature patterns.

---

## Structure

### Per-Feature Documentation

Each feature should have its own subfolder with:

```
features/[feature-name]/
├── contract.md          # Feature specification (if complex)
├── api.md              # API endpoints (if backend involved)
└── examples/           # Feature-specific code examples
```

### Pattern Documentation

Cross-feature patterns live in `patterns/`:

```
features/patterns/
├── crud-pattern.md     # Standard CRUD feature pattern
├── auth-pattern.md     # Authentication flow pattern
└── [other-patterns]    # Other reusable patterns
```

---

## Feature Contract Template

For complex features, create a contract document before implementation:

**Template**: [`../../06-templates/feature-contract-template.md`](../../06-templates/feature-contract-template.md)

### When to Create a Contract

- Multi-week feature development
- Cross-team dependencies
- Significant architectural impact
- Complex business logic

---

## Existing Features

| Feature | Status | Documentation |
|---------|--------|---------------|
| **Todo** | ✅ Active | `client/src/features/todo/` |
| **Auth** | 🚧 In Progress | TBD |

### Todo Feature Structure

```
features/todo/
├── components/
│   ├── TodoFeature.tsx   # Container + error boundary
│   ├── TodoList.tsx      # Main list component
│   ├── TodoItem.tsx      # Individual todo item (inline edit/delete/toggle)
│   └── TodoForm.tsx      # Create form
├── services/
│   └── todos.service.ts  # API calls to backend
├── store.ts              # Zustand state slice (optimistic updates)
├── routes.tsx            # React Router route definition (loader/action)
└── __tests__/            # Feature tests
```

> **Note:** Zod validation schemas live in `shared/validations/todo.ts`, not per-feature.

---

## Adding a New Feature

### Step 1: Define Contract (if needed)

Create `features/[name]/contract.md` using the template.

### Step 2: Create Folder Structure

```bash
mkdir -p features/[name]/{components,services,__tests__}
```

### Step 3: Implement Layers

1. **Types**: Add to `shared/types/` (e.g., `shared/types/todo.ts`)
2. **Validations**: Create Zod schemas in `shared/validations/` (e.g., `shared/validations/todo.ts`)
3. **Services**: API calls in `features/[name]/services/`
4. **Components**: UI in `features/[name]/components/`
5. **Routes**: Define routes in `features/[name]/routes.tsx`
6. **Tests**: Write tests in `features/__tests__/`

### Step 4: Document

Update this README with feature information and link to any documentation created.

---

## Pattern Documentation

When you identify a reusable pattern across features, document it in `patterns/`:

### Example: CRUD Pattern

**File**: `features/patterns/crud-pattern.md`

**Contents**:
- When to use this pattern
- Component structure
- Service layer organization
- State management approach
- Testing strategy

---

## Related Documentation

- [Feature Contract Template](../../06-templates/feature-contract-template.md) - Specification template
- [Architecture Overview](../02-architecture/overview.md) - System design
- [Conventions](../01-onboarding/conventions.md) - Coding standards

---

**Last Updated:** 2026-04-18  
**Review Status:** Active  
**Next Review Date:** 2026-05-18
