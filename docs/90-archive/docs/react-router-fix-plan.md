# React Router Fixes — Pi Skeleton Project

**Purpose:** Align the skeleton project with React Router best practices from the guide.  
**Status:** Action Plan  
**React Router Version:** v6.21.1 (compatible with data APIs)

---

## 🔴 Critical Issues to Fix

### Issue 1: Double Router Setup

**Problem:** Router defined in both `main.tsx` and `App.tsx` creates conflicts.

```tsx
// ❌ BROKEN - main.tsx uses BrowserRouter
<BrowserRouter>
  <App />
</BrowserRouter>

// ❌ ALSO defines createBrowserRouter inside App
const router = createBrowserRouter([...])
export default function App() {
  return <RouterProvider router={router} />
}
```

**Fix:** Remove `<BrowserRouter>` from `main.tsx`, keep only `createBrowserRouter` in `App.tsx`.

---

### Issue 2: Feature Routes Not Integrated

**Problem:** Todo feature routes exist but are commented out and unused.

```tsx
// ❌ app/router.tsx has TODO comments, not implemented
// features/todo/routes.tsx exists but never imported

// ✅ Should be integrated like this:
{
  path: 'todos',
  children: todoRoutes // Import and connect here
}
```

**Fix:** Uncomment and properly integrate feature routes.

---

### Issue 3: No Server-State Pattern

**Problem:** Todo store is client-only Zustand, no connection to backend API.

```tsx
// ❌ Current - Client only
export const useTodoStore = create<TodoStore>((set) => ({
  addTodo: (todo) => set(...), // Disappears on refresh
}))

// ✅ Should be - Loaders + Actions
{
  path: 'todos',
  loader: async () => fetch('/api/todos').then(r => r.json()),
  action: async ({ request }) => {
    const formData = await request.formData()
    await fetch('/api/todos', { method: 'POST', body: formData })
    return redirect('/todos')
  }
}
```

**Fix:** Add API layer and convert to React Router data APIs.

---

## 📋 Implementation Plan

### Phase 1: Fix Router Setup (Priority: CRITICAL)

#### Step 1.1: Remove BrowserRouter from main.tsx

**File:** `client/src/main.tsx`

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
// ❌ REMOVE: import { BrowserRouter } from 'react-router-dom'
import App from './app/App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* ❌ REMOVE: <BrowserRouter> */}
    <App />
    {/* ❌ REMOVE: </BrowserRouter> */}
  </React.StrictMode>,
)
```

#### Step 1.2: Consolidate Router in App.tsx

**File:** `client/src/app/App.tsx`

```tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { Header } from '@/components/layout/Header'
import { SidePanel } from '@/components/layout/SidePanel'
import { ContentArea } from '@/components/layout/ContentArea'
import { Dashboard } from '@/pages/Dashboard'
import { Settings } from '@/pages/Settings'

// ✅ Single source of truth - no duplicate router
const router = createBrowserRouter([
  {
    element: (
      <div className="flex flex-col h-screen bg-background">
        <Header />
        <div className="flex flex-1 overflow-hidden">
          <SidePanel />
          <ContentArea />
        </div>
      </div>
    ),
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'settings', element: <Settings /> },
      // TODO: Add feature routes here
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
```

#### Step 1.3: Clean up unused router.tsx

**File:** `client/src/app/router.tsx` - **DELETE THIS FILE** (duplicate)

Or keep it as a feature route registry:

```tsx
// ✅ Keep as feature route definitions only
import { TodoFeature } from '@/features/todo'

export const todoRoutes = [
  { path: 'todos', element: <TodoFeature /> }
]
```

---

### Phase 2: Add API Layer (Priority: HIGH)

#### Step 2.1: Create API Client

**File:** `client/src/api/todos.ts`

```tsx
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000'

export async function getTodos() {
  const res = await fetch(`${API_BASE}/api/todos`)
  if (!res.ok) throw new Error('Failed to fetch todos')
  return res.json() as Promise<Todo[]>
}

export async function createTodo(data: Omit<Todo, 'id' | 'createdAt' | 'updatedAt'>) {
  const res = await fetch(`${API_BASE}/api/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to create todo')
  return res.json() as Promise<Todo>
}

export async function updateTodo(id: string, data: Partial<Omit<Todo, 'id' | 'createdAt' | 'updatedAt'>>) {
  const res = await fetch(`${API_BASE}/api/todos/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update todo')
  return res.json() as Promise<Todo>
}

export async function deleteTodo(id: string) {
  const res = await fetch(`${API_BASE}/api/todos/${id}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to delete todo')
}
```

#### Step 2.2: Add Environment Variable

**File:** `client/.env.example` (create new file)

```bash
VITE_API_URL=http://localhost:3000
```

---

### Phase 3: Convert to Loaders/Actions (Priority: HIGH)

#### Step 3.1: Update TodoFeature Component

**File:** `client/src/features/todo/components/TodoFeature.tsx`

```tsx
import { useLoaderData, Form, redirect } from 'react-router-dom'
import { TodoForm } from './TodoForm'
import { TodoList } from './TodoList'
import type { Todo } from '@shared/types/todo'

// ✅ Loader function for data fetching
export async function todoLoader() {
  const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3000'}/api/todos`)
  if (!res.ok) throw new Error('Failed to load todos')
  return res.json() as Promise<Todo[]>
}

// ✅ Action function for mutations
export async function todoAction({ request }: { request: Request }) {
  const formData = await request.formData()
  const title = formData.get('title') as string
  
  if (request.method === 'POST') {
    await createTodo({ title, completed: false })
    return redirect('/todos')
  }
  
  return null
}

export function TodoFeature() {
  const todos = useLoaderData() as Todo[]
  
  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Todo List</h2>
      <TodoForm />
      <TodoList todos={todos} />
    </div>
  )
}

// Export for route integration
export const TodoFeature = {
  loader: todoLoader,
  action: todoAction,
  component: TodoFeatureComponent,
}
```

#### Step 3.2: Update TodoForm to Use React Router Form

**File:** `client/src/features/todo/components/TodoForm.tsx`

```tsx
import { Form } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function TodoForm() {
  return (
    <Form method="post" className="flex gap-2 mb-6">
      <input
        name="title"
        type="text"
        placeholder="What needs to be done?"
        className="flex-1 px-3 py-2 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        required
      />
      <Button type="submit">Add Todo</Button>
    </Form>
  )
}
```

#### Step 3.3: Update TodoList to Use Loader Data

**File:** `client/src/features/todo/components/TodoList.tsx`

```tsx
import { Form } from 'react-router-dom'
import type { Todo } from '@shared/types/todo'

interface TodoListProps {
  todos: Todo[]
}

export function TodoList({ todos }: TodoListProps) {
  return (
    <ul className="space-y-2">
      {todos.map((todo) => (
        <li key={todo.id} className="flex items-center justify-between p-3 border rounded">
          <span>{todo.title}</span>
          <Form method="post" className="inline">
            <input type="hidden" name="_method" value="DELETE" />
            <button type="submit" className="text-red-500 hover:underline">
              Delete
            </button>
          </Form>
        </li>
      ))}
    </ul>
  )
}
```

#### Step 3.4: Update Routes to Use Data APIs

**File:** `client/src/app/App.tsx` (or keep in separate router file)

```tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { Header } from '@/components/layout/Header'
import { SidePanel } from '@/components/layout/SidePanel'
import { ContentArea } from '@/components/layout/ContentArea'
import { Dashboard } from '@/pages/Dashboard'
import { Settings } from '@/pages/Settings'
import { todoRoutes, todoLoader, todoAction } from '@/features/todo/routes'

const router = createBrowserRouter([
  {
    element: (
      <div className="flex flex-col h-screen bg-background">
        <Header />
        <div className="flex flex-1 overflow-hidden">
          <SidePanel />
          <ContentArea />
        </div>
      </div>
    ),
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'settings', element: <Settings /> },
      
      // ✅ Feature routes with loaders/actions
      ...todoRoutes.map(route => ({
        ...route,
        loader: todoLoader,
        action: todoAction,
      })),
      
      // ✅ 404 fallback
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

// Simple 404 page component
function NotFoundPage() {
  return (
    <div className="flex items-center justify-center h-full">
      <h1>404 - Page Not Found</h1>
    </div>
  )
}

export default function App() {
  return <RouterProvider router={router} />
}
```

---

### Phase 4: Clean Up (Priority: MEDIUM)

#### Step 4.1: Remove Deprecated Zustand Store for Todos

**File:** `client/src/features/todo/store.ts` - **OPTIONAL DELETE**

Keep only if you need client-side UI state (e.g., selected item, filters). For server-state, use loaders instead.

If keeping, document the distinction:

```tsx
// ✅ Keep for UI state only
export const useTodoStore = create<TodoStore>((set) => ({
  selectedId: null, // UI state - doesn't need to sync with server
}))

// ❌ Remove from here: todos array (use loader instead)
```

#### Step 4.2: Add Auth Guard Pattern (Optional)

**File:** `client/src/components/ProtectedRoute.tsx`

```tsx
import { Navigate, useLocation } from 'react-router-dom'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = localStorage.getItem('authToken') !== null
  const location = useLocation()
  
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  
  return <>{children}</>
}

// Usage in routes:
{
  path: 'admin',
  element: <ProtectedRoute><AdminPage /></ProtectedRoute>,
}
```

---

## 📊 Migration Checklist

- [ ] Remove `<BrowserRouter>` from `main.tsx`
- [ ] Consolidate router into single file (`App.tsx`)
- [ ] Delete or clean up duplicate `router.tsx`
- [ ] Create `client/src/api/todos.ts` with API functions
- [ ] Add `.env.example` with `VITE_API_URL`
- [ ] Convert TodoFeature to use loaders/actions
- [ ] Update TodoForm to use `<Form>` component
- [ ] Update TodoList to accept loader data as props
- [ ] Integrate todoRoutes into main router
- [ ] Add 404 fallback route
- [ ] Remove or document Zustand store usage
- [ ] Test: refresh page, todos should persist

---

## ✅ Expected Outcome

After these fixes:

1. **Single router source of truth** - No more double-router conflicts
2. **Server-state persistence** - Todos survive page refreshes
3. **Feature-based routing** - Easy to add new features
4. **Cleaner code** - Less boilerplate with loaders/actions
5. **Better error handling** - Built-in React Router error boundaries

---

## 🔄 Version Compatibility Note

This plan works with **React Router v6.21.1** (current skeleton version). The data APIs (`createBrowserRouter`, `loader`, `action`) are available in v6 and work the same way as v7 for client-side apps.

If you upgrade to React Router v7 later, minimal changes will be needed:
- `useParams()` returns `string | undefined` (TypeScript warning)
- Route-level `lazy` loading preferred over component-level
