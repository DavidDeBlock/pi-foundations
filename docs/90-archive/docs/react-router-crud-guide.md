# React Router — Pi Skeleton Project Fixes & Guide

**Purpose:** Fix router issues in Pi Skeleton and align with React Router best practices.  
**Date:** April 2026  
**React Router Version:** v6.21.1 (data APIs compatible)

---

## ✅ Fixes Applied to Pi Skeleton (April 2026)

The following issues were identified and fixed:

### Fixed Issues

| Issue | Status | Description |
|-------|--------|-------------|
| Double router setup | ✅ FIXED | Removed `<BrowserRouter>` from `main.tsx` |
| Feature routes not integrated | ✅ FIXED | Todo routes now connected via `featureRoutes` |
| No API layer | ✅ ADDED | Created `client/src/api/todos.ts` |
| Client-only state | ⚠️ PARTIAL | Converted to loaders/actions (backend integration pending) |
| Missing 404 page | ✅ ADDED | Added `NotFound` component |

### Files Modified

- ✅ `client/src/main.tsx` - Removed `<BrowserRouter>` wrapper
- ✅ `client/src/app/App.tsx` - Consolidated router, added feature routes
- ✅ `client/src/app/router.tsx` - Repurposed as feature route registry
- ✅ `client/src/pages/NotFound.tsx` - New 404 page component
- ✅ `client/src/api/todos.ts` - New API client functions
- ✅ `client/.env.example` - Added environment variable template
- ✅ `client/src/features/todo/routes.tsx` - Added loaders/actions
- ✅ `client/src/features/todo/components/TodoFeature.tsx` - Uses loader data
- ✅ `client/src/features/todo/components/TodoForm.tsx` - Uses `<Form>` component
- ✅ `client/src/features/todo/components/TodoList.tsx` - Accepts todos as props

---

## 🎯 Decision: `createBrowserRouter` vs `BrowserRouter`

### **Use `createBrowserRouter` (Data Routing)** ✅

**Justification for CRUD apps:**

| Feature | `BrowserRouter` (Library Mode) | `createBrowserRouter` (Framework Mode) |
|---------|-------------------------------|----------------------------------------|
| Data fetching | Manual (`useEffect`) | Built-in loaders |
| Loading states | Manual | Automatic |
| Error handling | Manual try/catch | Built-in error boundaries |
| Race conditions | Possible with useEffect | Impossible (loader runs first) |
| Type safety | Basic | Full types for params, data, actions |
| Form submissions | Manual POST calls | Built-in actions |

**For a CRUD app, `createBrowserRouter` saves you:**
- 30-50% less boilerplate code
- No useEffect race conditions when navigating back to edited items
- Automatic loading/error states for every fetch
- Cleaner form submission handling with actions

---

## 🗺️ Practical Beginner Roadmap

### 1. Setup

**Install dependencies:**
```bash
npm create vite@latest my-crud-app -- --template react-ts
cd my-crud-app
npm install react-router-dom
```

**`src/main.tsx`:**
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App.tsx'
import './index.css'

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
```

**Where it lives:** `src/main.tsx` (entry point)  
**Pitfall:** Don't use `<BrowserRouter>` wrapper inside App - the router is now configured at app level.

---

### 2. Basic Routes

**`src/routes.tsx`:**
```tsx
import { createBrowserRouter, RouteObject } from 'react-router-dom'
import App from './App'
import Home from './pages/Home'
import Users from './pages/Users'
import UserDetail from './pages/UserDetail'

export const router: RouteObject[] = [
  { path: '/', element: <App />, children: [
    { index: true, element: <Home /> },
    { path: 'users', element: <Users /> },
    { path: 'users/:id', element: <UserDetail /> },
  ]},
]
```

**Where it lives:** `src/routes.tsx` (central route config)  
**Pitfall:** Don't nest router configs - keep one root array and use `children`.

---

### 3. Nested Layouts + Outlet

**`src/App.tsx`:**
```tsx
import { Outlet, Link } from 'react-router-dom'

export default function App() {
  return (
    <div className="app">
      <nav>
        <Link to="/">Home</Link>
        <Link to="/users">Users</Link>
      </nav>
      <main>
        {/* Outlet renders child routes here */}
        <Outlet />
      </main>
    </div>
  )
}
```

**Where it lives:** `src/App.tsx` (parent layout)  
**Pitfall:** If you forget `<Outlet />`, child routes won't render - you'll just see the parent.

---

### 4. Link/NavLink

**`src/pages/Users.tsx`:**
```tsx
import { NavLink } from 'react-router-dom'

export default function Users() {
  return (
    <ul>
      <li>
        <NavLink to="/users/1" className={({ isActive }) => 
          isActive ? 'active' : ''}>User 1</NavLink>
      </li>
    </ul>
  )
}
```

**Where it lives:** Anywhere you need navigation  
**Pitfall:** `Link` doesn't provide active state - use `NavLink` for styling active routes.

---

### 5. useNavigate

**`src/pages/UserDetail.tsx`:**
```tsx
import { useNavigate, useParams } from 'react-router-dom'

export default function UserDetail() {
  const navigate = useNavigate()
  const { id } = useParams()

  return (
    <div>
      <p>User ID: {id}</p>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate('/users')}>Go to Users</button>
    </div>
  )
}
```

**Where it lives:** Components that need programmatic navigation  
**Pitfall:** Don't use `navigate` inside loaders/actions - they run before components mount.

---

### 6. useParams

Extracts URL parameters like `/users/:id`. Returns `string | undefined`.

**Where it lives:** Route component matching the pattern  
**Pitfall:** TypeScript will warn if you don't handle undefined.

---

### 7. useSearchParams

**`src/pages/Home.tsx`:**
```tsx
import { useSearchParams } from 'react-router-dom'

export default function Home() {
  const [params, setParams] = useSearchParams()
  
  const searchTerm = params.get('q') || ''
  
  return (
    <div>
      <input 
        value={searchTerm}
        onChange={(e) => setParams({ q: e.target.value })}
        placeholder="Search..."
      />
      <p>Searching for: {searchTerm}</p>
    </div>
  )
}
```

**Where it lives:** Components that need query string state  
**Pitfall:** `setParams` merges with existing params - use `prev => ({ ...prev, key: value })` pattern.

---

### 8. Route Guards / Auth Pattern

**Option A: Loader-based redirect (Recommended for CRUD):**
```tsx
// src/routes.tsx
import { authenticate } from './auth'

export const router: RouteObject[] = [
  { path: 'users/:id', element: <UserDetail />, 
    loader: async ({ params }) => {
      if (!authenticate()) {
        throw new Response('', { status: 401, headers: { 'X-Redirect': '/login' } })
      }
      return fetch(`/api/users/${params.id}`).then(r => r.json())
    } 
  },
]

// src/pages/UserDetail.tsx
import { useRouteError, isRouteErrorResponse, Navigate } from 'react-router-dom'

export default function UserDetail() {
  const error = useRouteError()
  
  if (isRouteErrorResponse(error) && error.status === 401) {
    return <Navigate to="/login" />
  }
  
  // ... render user data
}
```

**Option B: Component-based guard:**
```tsx
// src/components/ProtectedRoute.tsx
import { Navigate, useLocation } from 'react-router-dom'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = authenticate()
  const location = useLocation()
  
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  
  return <>{children}</>
}

// In routes.tsx:
{ path: 'users/:id', element: (
  <ProtectedRoute><UserDetail /></ProtectedRoute>
)}
```

**Where it lives:** Route config for loader-based, component wrapper for component-based  
**Pitfall:** Don't check auth in `useEffect` - use loaders or guards to prevent flash of unprotected content.

---

### 9. 404 Page

**`src/routes.tsx`:**
```tsx
export const router: RouteObject[] = [
  // ... your routes
  { path: '*', element: <NotFound /> },
]

// src/pages/NotFound.tsx
import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <div>
      <h1>404 - Page Not Found</h1>
      <Link to="/">Go Home</Link>
    </div>
  )
}
```

**Where it lives:** Last route in config array  
**Pitfall:** Must be at the end of the routes array, or it will match everything.

---

### 10. Lazy Routes (Code Splitting)

**`src/routes.tsx`:**
```tsx
const AdminPanel = lazy(() => import('./pages/AdminPanel'))
const Settings = lazy(() => import('./pages/Settings'))

export const router: RouteObject[] = [
  { path: '/', element: <App />, children: [
    { index: true, element: <Home /> },
    { 
      path: 'admin', 
      lazy: async () => ({ 
        component: (await import('./pages/AdminPanel')).default 
      }) 
    },
  ]},
]
```

**Where it lives:** Route config `lazy` property  
**Pitfall:** Don't use React.lazy inside components - use the route-level `lazy` property instead.

---

### 11. Loaders/Actions (Worth It for CRUD?) ✅ YES

#### Why loaders/actions are worth it:

| Problem with useEffect | Solution with Loader |
|------------------------|---------------------|
| Race conditions on fast navigation | Loader runs before render |
| Manual loading state management | Automatic `useLoaderData()` + built-in states |
| Error boundaries needed manually | Built-in error handling |
| Form POST needs manual fetch | Action handles submission automatically |

**`src/routes.tsx`:**
```tsx
// GET request (loader)
{ 
  path: 'users/:id', 
  element: <UserDetail />,
  loader: async ({ params }) => {
    const res = await fetch(`/api/users/${params.id}`)
    if (!res.ok) throw new Response('Not found', { status: 404 })
    return res.json() // automatically becomes component data
  }
}

// POST/PUT/DELETE request (action)
{ 
  path: 'users', 
  element: <UsersList />,
  action: async ({ request }) => {
    const formData = await request.formData()
    await fetch('/api/users', {
      method: 'POST',
      body: formData,
    })
    return null // redirect to parent by default
  }
}
```

**`src/pages/UserDetail.tsx`:**
```tsx
import { useLoaderData, Form } from 'react-router-dom'

export default function UserDetail() {
  const user = useLoaderData() as User
  
  return (
    <div>
      <h1>{user.name}</h1>
      
      {/* Action form - auto-submits to parent action */}
      <Form method="post">
        <input name="name" defaultValue={user.name} />
        <button type="submit">Update</button>
      </Form>
    </div>
  )
}

// Handle errors automatically
import { useRouteError, isRouteErrorResponse } from 'react-router-dom'

function UserDetail() {
  const user = useLoaderData() as User
  const error = useRouteError()
  
  if (error) return <p>Error: {(error as Error).message}</p>
  
  // ... render user data
}
```

**Where it lives:** Route config for loaders/actions, components for `useLoaderData()`  
**Pitfall:** Actions run on parent routes too - use `action` on the right route level.

---

## 📦 Complete Example App: User CRUD

### Folder Structure
```
src/
├── main.tsx                 # Entry point with router setup
├── routes.tsx               # All route definitions
├── auth.ts                  # Simple auth helper
├── api/                     # API client
│   └── users.ts
├── pages/                   # Page components
│   ├── Home.tsx
│   ├── Users.tsx
│   ├── UserDetail.tsx
│   ├── UserForm.tsx
│   └── NotFound.tsx
├── components/              # Reusable UI
│   ├── Layout.tsx
│   └── ProtectedRoute.tsx
└── types/                   # TypeScript definitions
    └── user.ts
```

### `src/types/user.ts`
```tsx
export interface User {
  id: string
  name: string
  email: string
}
```

### `src/api/users.ts`
```tsx
const BASE = '/api/users'

export async function getUsers() {
  const res = await fetch(BASE)
  return res.json() as Promise<User[]>
}

export async function getUser(id: string) {
  const res = await fetch(`${BASE}/${id}`)
  if (!res.ok) throw new Error('Not found')
  return res.json() as Promise<User>
}

export async function createUser(data: FormData) {
  const res = await fetch(BASE, {
    method: 'POST',
    body: data,
  })
  return res.json() as Promise<User>
}

export async function updateUser(id: string, data: FormData) {
  const res = await fetch(`${BASE}/${id}`, {
    method: 'PUT',
    body: data,
  })
  return res.json() as Promise<User>
}
```

### `src/routes.tsx` (Complete Router Config)
```tsx
import { createBrowserRouter, RouteObject, redirect } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Users from './pages/Users'
import UserDetail from './pages/UserDetail'
import UserForm from './pages/UserForm'
import NotFound from './pages/NotFound'

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      
      // Users list with loader
      {
        path: 'users',
        element: <Users />,
        loader: async () => {
          const res = await fetch('/api/users')
          if (!res.ok) throw new Error('Failed to load users')
          return res.json() as Promise<User[]>
        },
      },
      
      // User detail with loader
      {
        path: 'users/:id',
        element: <UserDetail />,
        loader: async ({ params }) => {
          const res = await fetch(`/api/users/${params.id}`)
          if (!res.ok) throw new Error('User not found')
          return res.json() as Promise<User>
        },
      },
      
      // Create form with action
      {
        path: 'users/new',
        element: <UserForm />,
        action: async ({ request }) => {
          const formData = await request.formData()
          await createUser(formData)
          return redirect('/users')
        },
      },
      
      // Edit form with action
      {
        path: 'users/:id/edit',
        element: <UserForm />,
        loader: async ({ params }) => {
          const res = await fetch(`/api/users/${params.id}`)
          if (!res.ok) throw new Error('User not found')
          return res.json() as Promise<User>
        },
        action: async ({ request, params }) => {
          const formData = await request.formData()
          await updateUser(params.id, formData)
          return redirect(`/users/${params.id}`)
        },
      },
      
      // 404 fallback
      { path: '*', element: <NotFound /> },
    ],
  },
])
```

### `src/pages/Users.tsx`
```tsx
import { Link, useLoaderData } from 'react-router-dom'

export default function Users() {
  const users = useLoaderData() as User[]
  
  return (
    <div>
      <h1>Users</h1>
      <Link to="/users/new">+ Add User</Link>
      
      <ul>
        {users.map(user => (
          <li key={user.id}>
            <Link to={`users/${user.id}`}>{user.name}</Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

### `src/pages/UserDetail.tsx`
```tsx
import { Link, useLoaderData, Form } from 'react-router-dom'

export default function UserDetail() {
  const user = useLoaderData() as User
  
  return (
    <div>
      <h1>{user.name}</h1>
      <p>Email: {user.email}</p>
      
      <Link to={`users/${user.id}/edit`}>Edit</Link>
      
      {/* Delete with confirmation */}
      <Form method="post" onSubmit={(e) => {
        if (!confirm('Delete this user?')) e.preventDefault()
      }}>
        <button type="submit">Delete</button>
      </Form>
    </div>
  )
}
```

### `src/pages/UserForm.tsx`
```tsx
import { useLoaderData, redirect, Form, useNavigate } from 'react-router-dom'

export default function UserForm() {
  const user = useLoaderData() as User | null
  const navigate = useNavigate()
  
  const isEditing = !!user
  
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const formData = new FormData(form)
    
    const method = isEditing ? 'PUT' : 'POST'
    const url = isEditing 
      ? `/api/users/${user.id}`
      : '/api/users'
    
    await fetch(url, { method, body: formData })
    navigate('/users')
  }
  
  return (
    <Form method="post" onSubmit={onSubmit}>
      <input name="name" defaultValue={user?.name} required />
      <input name="email" type="email" defaultValue={user?.email} required />
      <button type="submit">{isEditing ? 'Update' : 'Create'}</button>
    </Form>
  )
}
```

### `src/components/Layout.tsx`
```tsx
import { Outlet, Link } from 'react-router-dom'

export default function Layout() {
  return (
    <div className="layout">
      <nav>
        <Link to="/">Home</Link>
        <Link to="/users">Users</Link>
      </nav>
      
      <main>
        <Outlet />
      </main>
    </div>
  )
}
```

---

## 📋 Cheat Sheet: Most Important APIs

| API | Purpose | Example |
|-----|---------|---------|
| `createBrowserRouter(routes)` | Define app routes | See `routes.tsx` above |
| `<RouterProvider router={router} />` | Mount router in App | In `main.tsx` |
| `<Outlet />` | Render child routes in layouts | In parent layout components |
| `<Link to="...">` | Declarative navigation | `<Link to="/users">Users</Link>` |
| `<NavLink to="...">` | Link with active state | For highlighting current route |
| `useNavigate()` | Programmatic navigation | `navigate('/users')`, `navigate(-1)` |
| `useParams()` | Extract URL params | `const { id } = useParams()` |
| `useSearchParams()` | Read/query string params | `[params, set] = useSearchParams()` |
| `useLoaderData()` | Get loader data in component | `const users = useLoaderData() as User[]` |
| `<Form method="post">` | Auto-submits to action | Handles form without manual fetch |
| `redirect('/path')` | Redirect from loader/action | Return from action to redirect |
| `{ lazy: () => import(...) }` | Code-split route | Route-level lazy loading |

---

## 🔄 Migration Notes (v6 → v7)

### Breaking changes you need to know:

1. **No more `<BrowserRouter>` wrapper in App** - Router is now configured at app level with `createBrowserRouter()`
2. **`<Route>` component removed** - Routes are plain objects, not JSX elements
3. **`useParams()` returns `string | undefined`** - TypeScript will warn if you don't handle it
4. **`React.lazy` inside components is deprecated** - Use route-level `lazy: () => import(...)` instead
5. **`<Navigate>` requires `to` prop** - No more implicit navigation

### Migration pattern:

```tsx
// v6 (old)
<BrowserRouter>
  <Routes>
    <Route path="/users" element={<Users />} />
  </Routes>
</BrowserRouter>

// v7 (new)
createBrowserRouter([
  { path: '/users', element: <Users /> }
])
```

---

## ✅ Next Steps Checklist

- [ ] Set up Vite + React + TypeScript project
- [ ] Install `react-router-dom`
- [ ] Create `routes.tsx` with your base routes
- [ ] Implement layout with `<Outlet />`
- [ ] Add loaders for data fetching (start simple)
- [ ] Convert forms to use `<Form>` + actions
- [ ] Add 404 page as last route
- [ ] Consider lazy loading heavy pages

**Start simple:** Get basic routing working first, then add loaders/actions incrementally.

---

## 📚 References

- **Official Docs:** https://reactrouter.com/start/modes
- **createBrowserRouter API:** https://reactrouter.com/api/data-routers/createBrowserRouter
- **State Management:** https://reactrouter.com/explanation/state-management
- **Upgrading from v6:** https://reactrouter.com/upgrading/v6
