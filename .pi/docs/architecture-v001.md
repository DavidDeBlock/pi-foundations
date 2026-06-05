# Pi Skeleton — Architecture v0.0.1

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT (React)                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    App Shell                          │  │
│  │  ┌──────────┐  ┌─────────────────────────────────┐   │  │
│  │  │ Header   │  │         Content Area            │   │  │
│  │  │ (fixed)  │  │  ┌───────────────────────────┐  │   │  │
│  │  └──────────┘  │  │      Feature Module       │  │   │  │
│  │                │  │    (dynamic content)      │  │   │  │
│  │                │  └───────────────────────────┘  │   │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Side Panel                           │  │
│  │              (collapsible/hideable)                   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                    HTTP/REST API
                            │
┌─────────────────────────────────────────────────────────────┐
│                      SERVER (Node.js)                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   API Layer                           │  │
│  │         (Express routes, request validation)          │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Service Layer                        │  │
│  │        (business logic, use cases)                    │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                 Repository Layer                      │  │
│  │          (Drizzle ORM, database access)               │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   Database                            │  │
│  │                  (SQLite)                             │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Layer Responsibilities

### Frontend Layers

| Layer | Responsibility | State Type |
|-------|---------------|------------|
| **Shell** | Layout composition, routing container, global UI state | App-level UI state |
| **Feature Modules** | Self-contained domain logic, local component state | Local + feature-specific UI state |
| **Shared Components** | Presentational only, no business logic | Props-driven |

### Backend Layers

| Layer | Responsibility | Pattern |
|-------|---------------|---------|
| **API Routes** | HTTP handling, input validation, response formatting | RESTful endpoints |
| **Services** | Business logic, transaction coordination, domain rules | Use case objects |
| **Repositories** | Data access, query building, ORM usage | Repository pattern with Drizzle |

---

## State Management Strategy

### Three-Level Distinction

```typescript
// Level 1: Local Component State (useState)
// For UI interactions that don't affect other components
const [isOpen, setIsOpen] = useState(false);

// Level 2: UI State (Zustand store slices)
// For UI concerns shared across components in a feature
interface FeatureStore {
  selectedId: string | null;
  setSelectedId: (id: string) => void;
}

// Level 3: Application State (Zustand root store)
// For global app state that crosses feature boundaries
interface AppStore {
  user: User | null;
  theme: Theme;
  sidebarOpen: boolean;
}
```

### Rules

1. **Local state first** — only lift when multiple components need it
2. **Feature stores are isolated** — each feature has its own Zustand slice
3. **Global store is minimal** — only truly cross-cutting concerns go here
4. **No Redux-style complexity** — simple actions, no reducers needed

---

## Feature Module Architecture

### Structure

```typescript
// Each feature lives in /features/<feature-name>/
// and exports itself as a module that can be mounted in the content area

interface FeatureModule {
  name: string;
  routes: RouteConfig[];
  components: Record<string, React.ComponentType>;
  store?: ZustandSlice;
  dependencies?: string[]; // other features it depends on
}
```

### Communication Between Features

| Pattern | Use Case | Mechanism |
|---------|----------|-----------|
| **Shared Store** | Global app state | Zustand root store |
| **Event Bus** | Loose coupling, decoupled events | Custom `window.dispatchEvent` or signal pattern |
| **Props via Router** | Parent-child feature communication | URL params, search params |
| **Direct Import** | Shared building blocks only | `/shared/components/`, `/shared/utils/` |

### Forbidden Patterns

- ❌ Features importing each other's internal state
- ❌ Global store containing feature-specific logic
- ❌ Direct DOM manipulation across features
- ❌ Hidden assumptions about feature order

---

## Backend API Structure

### RESTful Convention

```typescript
// CRUD endpoints follow standard REST naming
GET    /api/todos          // list all
GET    /api/todos/:id      // get one
POST   /api/todos          // create
PUT    /api/todos/:id      // update
DELETE /api/todos/:id      // delete

// Validation happens at API layer
// Business logic lives in services
```

### Request Flow

```
Client → API Route (validate input) → Service (business logic) → Repository (DB query) → Response
```

---

## Folder Structure Proposal

```
pi-skeleton/
├── frontend/                      # Frontend React app
│   ├── src/
│   │   ├── components/          # Shared building blocks (presentational only)
│   │   │   ├── ui/             # Atomic UI components (Button, Input, etc.)
│   │   │   └── layout/         # Shell components (Header, SidePanel)
│   │   ├── features/           # Feature modules (self-contained)
│   │   │   ├── todo/           # Example CRUD feature
│   │   │   │   ├── components/ # Feature-specific components
│   │   │   │   ├── store.ts    # Zustand slice for this feature
│   │   │   │   ├── routes.tsx  # Feature routes
│   │   │   │   └── index.ts    # Feature module export
│   │   │   └── ...             # More features
│   │   ├── shared/             # Cross-cutting concerns
│   │   │   ├── lib/            # Utilities, helpers
│   │   │   ├── hooks/          # Reusable custom hooks
│   │   │   └── types/          # Shared TypeScript types
│   │   ├── app/                # App-level configuration
│   │   │   ├── store.ts        # Global Zustand root store
│   │   │   ├── router.tsx      # React Router setup
│   │   │   └── App.tsx         # Shell layout
│   │   └── main.tsx            # Entry point
│   ├── package.json
│   └── ...
│
├── backend/                      # Backend Node.js app
│   ├── src/
│   │   ├── routes/             # API route handlers
│   │   │   └── todos.ts        # REST endpoints for todos
│   │   ├── services/           # Business logic layer
│   │   │   └── todoService.ts  # CRUD operations
│   │   ├── repositories/       # Data access layer (Drizzle)
│   │   │   └── todoRepo.ts     # Database queries
│   │   ├── db/                 # Database configuration
│   │   │   ├── index.ts        # Drizzle client setup
│   │   │   └── schema.ts       # Drizzle schema definitions
│   │   ├── middleware/         # Express middleware
│   │   │   └── validation.ts   # Request validation helpers
│   │   └── app.ts              # Express app setup
│   ├── package.json
│   └── ...
│
├── shared/                      # Code shared between client and server
│   ├── types/                  # TypeScript type definitions
│   └── validations/            # Zod schemas for input validation
│
├── .pi/                        # Pi agent configuration
│   ├── skills/                 # Skill definitions
│   └── plans/                  # Generated task plans
│
└── README.md                   # Project documentation
```

### Rationale

| Directory | Why This Structure? |
|-----------|---------------------|
| `features/` | Self-contained modules enable independent development and testing |
| `shared/components/ui/` | Atomic components follow composition pattern |
| `shared/components/layout/` | Shell is app-level, not feature-specific |
| `backend/services/` | Business logic separated from HTTP handling |
| `backend/repositories/` | Data access isolated for testability and ORM swaps |
| `shared/types/` | Single source of truth for data contracts |

---

## Conventions

### Naming

- **Files**: `kebab-case` for modules (`todo-feature.ts`), `PascalCase` for components (`TodoItem.tsx`)
- **Variables**: `camelCase` for values, `UPPER_CASE` for constants
- **Types/Interfaces**: `PascalCase`, prefixed with domain concept when relevant (`TodoItem`, not `Item`)

### Component Library

**Selected: Radix UI**

Rationale:
- Lightweight primitives (no opinionated styling)
- Headless by default, full control over appearance
- Easy theming via CSS variables in single file
- Accessibility built-in (ARIA, keyboard navigation)
- Works well with Tailwind CSS

Theming approach:
```css
/* src/shared/lib/theme.css — one file for all colors */
:root {
  --primary: #3b82f6;
  --primary-foreground: #ffffff;
  /* ... other tokens */
}
```

### Backend Framework

**Selected: Hono**

Rationale:
- Lightweight (smaller bundle, faster startup)
- TypeScript-first with excellent DX
- Compatible with Express middleware if needed
- Built-in validation helpers
- Easy to deploy anywhere (Node.js, Deno, Cloudflare Workers)

Example route:
```typescript
import { Hono } from 'hono'
const app = new Hono()

app.get('/api/todos', async (c) => {
  const todos = await todoService.list()
  return c.json({ data: todos })
})
```

### TypeScript

- Strict mode enabled (`strict: true` in tsconfig)
- No `any` — use `unknown` + type guards if needed
- Explicit return types on public functions
- Interfaces for shapes, types for unions/aliases

### State

- Feature stores named after feature (`useTodoStore`, not `useFeatureStore`)
- Actions as verbs: `setSelectedId`, `createItem`, `deleteItem`
- Global store has minimal keys: `user`, `theme`, `sidebarOpen`

### API

- JSON responses with consistent structure: `{ data, error, meta }`
- HTTP status codes follow REST conventions (200, 201, 400, 404, 500)
- Error messages are user-friendly, logs contain technical details

---

## First Feature Proposal: Todo List

### Why This Feature?

| Criterion | How Todo Fits |
|-----------|---------------|
| **CRUD flow** | Create, Read, Update, Delete todos |
| **Realistic** | Common pattern, easy to understand |
| **Not trivial** | Has state management, validation, persistence |
| **Extensible** | Can add categories, priorities, due dates later |
| **No external deps** | Doesn't require auth, payments, or complex integrations |

### Feature Scope (MVP)

- List all todos
- Create new todo
- Toggle completion status
- Edit todo text
- Delete todo
- Basic validation (title required)

### Out of Scope for MVP

- User authentication
- Categories/tags
- Due dates
- Drag-and-drop reordering
- Search/filtering

---

## Risks and Anti-Patterns to Avoid

| Risk | Why It's Bad | How to Avoid |
|------|--------------|--------------|
| **Feature coupling** | Features import each other's internals | Enforce module boundaries, use shared types only |
| **State leakage** | Global store contains feature logic | Keep global store minimal, feature-specific state in feature stores |
| **Business logic in UI** | Components become hard to test | Keep components presentational, move logic to services/hooks |
| **Backend complexity creep** | Services become thin wrappers around DB queries | Define clear service responsibilities upfront |
| **Over-abstracting early** | Creating abstractions for problems you don't have yet | Follow YAGNI, refactor when duplication appears 2nd time |
| **TypeScript `any` usage** | Loses type safety benefits | Use `unknown` + type guards, strict mode enabled |

---

## Next Steps — Progress Tracker

### ✅ Step 1: Architecture Proposal (Complete)
- Documented in `.pi/docs/architecture-v001.md`
- Decisions: Radix UI + Hono selected

### ✅ Step 2: Folder Structure & Package Setup (Complete)
- Created full monorepo structure with pnpm workspaces
- All package.json files ready for installation
- TypeScript, Tailwind, Drizzle configured
- Todo feature skeleton implemented as example
- See `.pi/plans/step-002-summary.md` for details

### ⏭️ Step 3: Conventions Document (Next)
- Naming patterns with code examples
- State management guidelines
- Component composition patterns
- API response structure

### ⏭️ Step 4: First Feature Implementation
- Backend API routes (Hono endpoints)
- Service layer (business logic)
- Repository layer (Drizzle queries)
- Frontend integration (connect to real backend)

### ⏭️ Step 5: Testing
- Vitest setup for client and server
- Minimal tests for critical paths

---

## Questions for Review

1. ✅ Does the three-level state distinction feel clear?
2. ✅ Is the feature module communication strategy sufficient?
3. ✅ Component library: Radix UI selected
4. ✅ Backend framework: Hono selected
