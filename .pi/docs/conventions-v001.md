# Pi Skeleton — Conventions v0.0.1

## Overview

This document defines coding conventions for the Pi Skeleton project. Follow these patterns consistently to maintain code quality and readability.

---

## 1. Naming Patterns

### File Names

| Type | Pattern | Example |
|------|---------|---------|
| **Components** | `PascalCase.tsx` | `TodoItem.tsx`, `Button.tsx` |
| **Feature modules** | `kebab-case/` directory | `/features/todo/` |
| **Feature files** | `kebab-case.ts` or `.tsx` | `todo-store.ts`, `todo-routes.tsx` |
| **Shared utilities** | `kebab-case.ts` | `utils.ts`, `format-date.ts` |
| **Types** | `PascalCase.ts` | `types/todo.ts`, `validations/auth.ts` |

**Examples:**

```typescript
// ✅ Good
src/features/todo/components/TodoList.tsx
src/features/todo/store.ts
src/shared/lib/utils.ts
src/types/todo.ts

// ❌ Bad
src/features/todo/TodoList.tsx          // Missing components/ subdirectory
src/features/todo/todolist.tsx         // Wrong case
src/features/todo/todo-store.ts        // Inconsistent naming
```

### Variable Names

| Type | Pattern | Example |
|------|---------|---------|
| **Values** | `camelCase` | `todoTitle`, `userCount` |
| **Constants** | `UPPER_CASE` | `MAX_TODO_LENGTH`, `API_BASE_URL` |
| **Booleans** | `is/has/can` prefix | `isLoading`, `hasError`, `canDelete` |
| **Functions** | `camelCase` verb + noun | `fetchTodos`, `handleSubmit`, `formatDate` |

**Examples:**

```typescript
// ✅ Good
const todoTitle = 'Buy milk';
const MAX_TODO_LENGTH = 200;
const isLoading = true;
const fetchTodos = async () => { ... };

// ❌ Bad
const TodoTitle = 'Buy milk';         // Should be camelCase for values
const maxTodoLength = 200;            // Constants should be UPPER_CASE
let loading = true;                   // Booleans should use is/has/can prefix
```

### Type Names

| Type | Pattern | Example |
|------|---------|---------|
| **Interfaces** | `PascalCase` + domain concept | `Todo`, `User`, `ApiResponse` |
| **Type aliases** | `PascalCase` for unions | `TodoStatus = 'pending' \| 'completed'` |
| **Props interfaces** | Component name + `Props` | `ButtonProps`, `TodoItemProps` |

**Examples:**

```typescript
// ✅ Good
interface Todo {
  id: string;
  title: string;
}

type TodoStatus = 'pending' | 'completed';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'destructive';
}

// ❌ Bad
interface todo { ... }                // Should be PascalCase
type todo_status = ...               // Should use camelCase for type aliases
interface ButtonProps { ... }        // Missing Props suffix if not obvious
```

---

## 2. State Management Guidelines

### Three-Level Distinction

#### Level 1: Local Component State (useState)

**Use when:** UI state that only affects a single component

```typescript
// ✅ Good - TodoForm uses local state for form input
function TodoForm() {
  const [title, setTitle] = useState('');  // Only affects this component
  
  return (
    <input 
      value={title} 
      onChange={(e) => setTitle(e.target.value)} 
    />
  );
}

// ❌ Bad - Lifting state unnecessarily
function App() {
  const [formTitle, setFormTitle] = useState('');  // Only used by TodoForm
  
  return <TodoForm title={formTitle} onChange={setFormTitle} />;
}
```

#### Level 2: UI State (Feature Store - Zustand)

**Use when:** State shared across multiple components within a feature

```typescript
// ✅ Good - TodoStore manages state for all todo components
interface TodoStoreState {
  todos: Todo[];
  selectedId: string | null;
}

interface TodoStoreActions {
  addTodo: (todo: Omit<Todo, 'id'>) => void;
  selectTodo: (id: string | null) => void;
}

export const useTodoStore = create<TodoStoreState & TodoStoreActions>((set) => ({
  todos: [],
  selectedId: null,
  addTodo: (todo) => set((state) => ({ 
    todos: [...state.todos, { ...todo, id: crypto.randomUUID() }] 
  })),
  selectTodo: (id) => set({ selectedId: id })
}));

// Usage in components
function TodoList() {
  const todos = useTodoStore((state) => state.todos);  // Subscribe to specific slice
  
  return <ul>{todos.map(todo => <TodoItem key={todo.id} todo={todo} />)}</ul>;
}

function TodoItem({ todo }: { todo: Todo }) {
  const selectTodo = useTodoStore((state) => state.selectTodo);  // Only subscribe to action
  
  return (
    <li onClick={() => selectTodo(todo.id)}>
      {todo.title}
    </li>
  );
}

// ❌ Bad - Using global store for feature-specific state
const appStore = create((set) => ({
  todos: [],  // Should be in todo-store.ts, not global store
  selectedTodoId: null,
  ...
}));
```

#### Level 3: Application State (Global Store - Zustand)

**Use when:** Cross-cutting concerns that affect multiple features

```typescript
// ✅ Good - Global store only contains truly app-level state
interface AppStoreState {
  sidebarOpen: boolean;
  theme: 'light' | 'dark';
  user: User | null;
}

export const useAppStore = create<AppStoreState>((set) => ({
  sidebarOpen: true,
  theme: 'light',
  user: null
}));

// Usage
function Header() {
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  
  return <button onClick={toggleSidebar}>Toggle Sidebar</button>;
}

// ❌ Bad - Putting feature-specific data in global store
const appStore = create((set) => ({
  todos: [],           // Should be in todo-store.ts
  sidebarOpen: true,   // ✅ OK - cross-cutting concern
  theme: 'light',      // ✅ OK - cross-cutting concern
}));
```

### Decision Tree

```
Is state used by only one component?
├─ YES → useState (local)
└─ NO → Is it shared across components in the same feature?
    ├─ YES → Feature store (useTodoStore, useAuthStore)
    └─ NO → Is it cross-cutting across features?
        ├─ YES → Global store (useAppStore)
        └─ NO → Reconsider architecture
```

---

## 3. Component Composition Patterns

### Feature Module Structure

Each feature should be self-contained:

```typescript
// ✅ Good - Complete feature module structure
src/features/todo/
├── components/
│   ├── TodoForm.tsx       # Form for creating todos
│   ├── TodoList.tsx       # List of todos
│   ├── TodoItem.tsx       # Individual todo item
│   └── TodoFeature.tsx    # Feature container (route element)
├── store.ts               # Zustand slice for this feature
├── routes.tsx             # Route configuration
└── index.ts               # Barrel export

// ❌ Bad - Scattered components across directories
src/features/
  todo-form.tsx            # Form in root
  todo-list.tsx            # List in root
components/
  TodoItem.tsx            # Item shared incorrectly
```

### Component Props Patterns

**Presentational Components:**

```typescript
// ✅ Good - Explicit props interface, no business logic
interface TodoItemProps {
  todo: Todo;
  onSelect?: (todo: Todo) => void;
  onDelete?: (id: string) => void;
}

function TodoItem({ todo, onSelect, onDelete }: TodoItemProps) {
  // Pure presentational logic only
  
  return (
    <li className="flex justify-between">
      <span>{todo.title}</span>
      {onDelete && (
        <button onClick={() => onDelete(todo.id)}>Delete</button>
      )}
    </li>
  );
}

// ❌ Bad - Business logic in presentational component
function TodoItem({ todo }: { todo: Todo }) {
  // ❌ Bad - Direct store access in component
  const deleteTodo = useTodoStore((state) => state.deleteTodo);
  
  return (
    <li>
      {todo.title}
      <button onClick={() => deleteTodo(todo.id)}>Delete</button>
    </li>
  );
}
```

**Container Components:**

```typescript
// ✅ Good - Container handles data fetching and state management
function TodoList() {
  const todos = useTodoStore((state) => state.todos);
  
  return (
    <ul>
      {todos.map(todo => (
        <TodoItem 
          key={todo.id} 
          todo={todo} 
          onDelete={(id) => useTodoStore.getState().deleteTodo(id)}
        />
      ))}
    </ul>
  );
}

// ❌ Bad - Component trying to do everything
function TodoList() {
  const todos = useTodoStore((state) => state.todos);
  const deleteTodo = useTodoStore((state) => state.deleteTodo);
  const [filter, setFilter] = useState('all');
  
  // ❌ Too many responsibilities in one component
  
  return (
    <>
      <select onChange={(e) => setFilter(e.target.value)}>...</select>
      {todos.filter(t => filter === 'all' || t.status === filter).map(...)}
    </>
  );
}
```

---

## 4. API Response Structure

### Standard Response Format

All API responses should follow this structure:

```typescript
// ✅ Good - Consistent response format
interface ApiResponse<T = unknown> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, string[]>;  // For validation errors
  };
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
  };
}

// Success response
{
  "data": [
    { "id": "1", "title": "Buy milk", "completed": false }
  ],
  "meta": { "total": 25 }
}

// Error response (server error)
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Todo not found"
  }
}

// Validation error response
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": {
      "title": ["Title is required"]
    }
  }
}
```

### Hono Route Examples

```typescript
// ✅ Good - Consistent response handling in routes
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

const createTodoSchema = z.object({
  title: z.string().min(1).max(200)
});

app.post('/api/todos', 
  zValidator('json', createTodoSchema),
  async (c) => {
    const { title } = c.req.valid('json');
    
    try {
      const todo = await todoService.create({ title });
      return c.json<ApiResponse<Todo>>({ data: todo }, 201);
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json<ApiResponse>(
          { 
            error: { 
              code: 'VALIDATION_ERROR',
              message: 'Invalid input',
              details: error.flatten().fieldErrors 
            } 
          }, 
          400
        );
      }
      
      return c.json<ApiResponse>(
        { error: { code: 'INTERNAL_ERROR', message: 'Server error' } },
        500
      );
    }
  }
);

// ❌ Bad - Inconsistent response formats
app.get('/api/todos', async (c) => {
  const todos = await todoService.list();
  
  // ❌ Returns array directly, not wrapped in object
  return c.json(todos);
});

app.post('/api/todos', async (c) => {
  try {
    const todo = await todoService.create(c.req.json());
    return c.json(todo);  // ❌ No wrapper, inconsistent with GET
  } catch {
    return c.text('Error');  // ❌ Not JSON, no structure
  }
});
```

---

## 5. Error Handling Patterns

### Server-Side Errors

```typescript
// ✅ Good - Structured error handling in services
class TodoService {
  async create(data: NewTodo): Promise<Todo> {
    try {
      // Validate input
      if (!data.title || data.title.trim().length === 0) {
        throw new ValidationError('Title is required');
      }
      
      if (data.title.length > 200) {
        throw new ValidationError('Title must be less than 200 characters');
      }
      
      // Database operation
      const todo = await todoRepo.create(data);
      return todo;
    } catch (error) {
      // Re-throw known errors, wrap unknown errors
      if (error instanceof ValidationError) {
        throw error;
      }
      
      console.error('Error creating todo:', error);
      throw new Error('Failed to create todo');
    }
  }
}

// ❌ Bad - Swallowing errors or not validating
class TodoService {
  async create(data: NewTodo): Promise<Todo> {
    // ❌ No validation
    return await todoRepo.create(data);  // ❌ Errors might be swallowed
  }
}
```

### Client-Side Error Handling

```typescript
// ✅ Good - Handle errors at component level with user feedback
function TodoForm() {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const addTodo = useTodoStore((state) => state.addTodo);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    try {
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 100));
      
      addTodo({ title, completed: false });
      setTitle('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create todo';
      setError(message);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {error && (
        <div className="text-destructive text-sm mb-2">
          {error}
        </div>
      )}
      
      <input 
        value={title} 
        onChange={(e) => setTitle(e.target.value)} 
        placeholder="What needs to be done?"
      />
      <Button type="submit" disabled={!title.trim()}>Add Todo</Button>
    </form>
  );
}

// ❌ Bad - Not handling errors or showing them to user
function TodoForm() {
  const [title, setTitle] = useState('');
  const addTodo = useTodoStore((state) => state.addTodo);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // ❌ No error handling
    addTodo({ title, completed: false });
    setTitle('');
  };

  return <form onSubmit={handleSubmit}>...</form>;
}
```

### Error Types

Define custom error types for better type safety:

```typescript
// ✅ Good - Custom error classes
class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'AppError';
  }
}

class ValidationError extends AppError {
  constructor(message: string, public fieldErrors?: Record<string, string[]>) {
    super('VALIDATION_ERROR', message, 400);
    this.name = 'ValidationError';
  }
}

class NotFoundError extends AppError {
  constructor(resource: string) {
    super('NOT_FOUND', `${resource} not found`, 404);
    this.name = 'NotFoundError';
  }
}

// Usage
async function getTodo(id: string): Promise<Todo> {
  const todo = await todoRepo.findById(id);
  
  if (!todo) {
    throw new NotFoundError('Todo');
  }
  
  return todo;
}
```

---

## 6. TypeScript Best Practices

### Strict Mode Configuration

```json
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

### Type Safety Examples

```typescript
// ✅ Good - Explicit types, no `any`
interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function createTodo(title: string): Todo {
  return {
    id: crypto.randomUUID(),
    title,
    completed: false,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

// ❌ Bad - Using `any` or missing types
function createTodo(title: any) {
  return {
    id: crypto.randomUUID(),
    title,
    // ❌ Missing required fields
  };
}
```

### Union Types for Status

```typescript
// ✅ Good - Explicit union types
type TodoStatus = 'pending' | 'completed';

function filterTodos(
  todos: Todo[], 
  status: TodoStatus | 'all'
): Todo[] {
  if (status === 'all') return todos;
  
  return todos.filter(todo => todo.completed === (status === 'completed'));
}

// ❌ Bad - Using strings directly
function filterTodos(todos: Todo[], status: string) {
  // ❌ No type safety, typos possible
  if (status === 'all') return todos;
  
  return todos.filter(todo => todo.completed === true);
}
```

---

## 7. Anti-Patterns to Avoid

### ❌ Business Logic in UI Components

```typescript
// ❌ Bad - Component has business logic
function TodoItem({ todo }: { todo: Todo }) {
  const deleteTodo = useTodoStore((state) => state.deleteTodo);
  
  // ❌ Component should be presentational only
  if (todo.completed) {
    setTimeout(() => {
      deleteTodo(todo.id);  // ❌ Auto-delete completed todos?
    }, 1000);
  }
  
  return <li>{todo.title}</li>;
}

// ✅ Good - Component is presentational only
function TodoItem({ todo, onDelete }: { todo: Todo; onDelete?: (id: string) => void }) {
  return <li onClick={() => onDelete?.(todo.id)}>{todo.title}</li>;
}
```

### ❌ Over-Abstraction Too Early

```typescript
// ❌ Bad - Premature abstraction
interface Repository<T> {
  find(id: string): Promise<T | null>;
  findAll(): Promise<T[]>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
}

class TodoRepository implements Repository<Todo> {
  // ❌ Over-engineered for simple use case
}

// ✅ Good - Simple implementation first
const todoRepo = {
  findById: (id: string) => db.select().from(todos).where(eq(todos.id, id)),
  create: (data: NewTodo) => db.insert(todos).values(data).returning(),
  // Add more methods as needed
};
```

### ❌ Hiding Errors

```typescript
// ❌ Bad - Swallowing errors
try {
  await api.createTodo({ title });
} catch (error) {
  console.error(error);  // ❌ Error is logged but not handled
  // User sees nothing, form appears to work
}

// ✅ Good - Handle errors appropriately
try {
  await api.createTodo({ title });
} catch (error) {
  setError(error instanceof Error ? error.message : 'Failed to create todo');
  // User sees error message and can retry
}
```

### ❌ Feature Coupling

```typescript
// ❌ Bad - Features importing each other's internals
import { useTodoStore } from '@/features/todo/store';
import { useAuthStore } from '@/features/auth/store';

function TodoFeature() {
  const todos = useTodoStore((state) => state.todos);
  const user = useAuthStore((state) => state.user);
  
  // ❌ Direct dependency on auth store
  
  return <div>{user?.name}'s todos: {todos.length}</div>;
}

// ✅ Good - Features communicate through shared types or events
function TodoFeature() {
  const todos = useTodoStore((state) => state.todos);
  
  return <div>All todos: {todos.length}</div>;
}
```

---

## Summary Checklist

Before finishing a feature, verify:

- [ ] **Naming**: Files follow `kebab-case` or `PascalCase` conventions
- [ ] **State**: Using correct level (local → UI → global)
- [ ] **Components**: Presentational components are pure, containers handle logic
- [ ] **API**: Responses follow `{ data, error, meta }` structure
- [ ] **Errors**: All errors are caught and handled appropriately
- [ ] **Types**: No `any`, explicit return types on public functions
- [ ] **Boundaries**: Features don't import each other's internals

---

## References

- Architecture: `.pi/docs/architecture-v001.md`
- Existing code examples: `client/src/features/todo/`, `server/src/db/schema.ts`
