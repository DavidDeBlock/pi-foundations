# 🚀 React Advanced Patterns & Best Practices

**Estimated Time:** 8-12 hours (with implementation)  
**Goal:** Master advanced patterns, performance optimization, and scalable architecture

---

## 📚 Table of Contents

1. [Advanced State Management](#1-advanced-state-management)
2. [Context API Deep Dive](#2-context-api-deep-dive)
3. [Performance Optimization](#3-performance-optimization)
4. [Custom Hooks Patterns](#4-custom-hooks-patterns)
5. [Component Composition Patterns](#5-component-composition-patterns)
6. [Error Boundaries & Error Handling](#6-error-boundaries--error-handling)
7. [Code Splitting & Lazy Loading](#7-code-splitting--lazy-loading)
8. [Server-Side Rendering (SSR)](#8-server-side-rendering-ssr)
9. [Testing Strategies](#9-testing-strategies)
10. [Architecture & Scalability](#10-architecture--scalability)

---

## 1. Advanced State Management

### useReducer for Complex State

When state logic becomes complex, `useReducer` provides better organization:

```tsx
import { useReducer } from 'react'

type Action = 
  | { type: 'ADD_TODO'; payload: string }
  | { type: 'TOGGLE_TODO'; payload: number }
  | { type: 'DELETE_TODO'; payload: number }
  | { type: 'CLEAR_COMPLETED' }

interface State {
  todos: Array<{ id: number; text: string; completed: boolean }>
  filter: 'all' | 'active' | 'completed'
}

const initialState: State = {
  todos: [],
  filter: 'all'
}

function todoReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ADD_TODO':
      return {
        ...state,
        todos: [
          ...state.todos,
          { id: Date.now(), text: action.payload, completed: false }
        ]
      }
    
    case 'TOGGLE_TODO':
      return {
        ...state,
        todos: state.todos.map(todo =>
          todo.id === action.payload
            ? { ...todo, completed: !todo.completed }
            : todo
        )
      }
    
    case 'DELETE_TODO':
      return {
        ...state,
        todos: state.todos.filter(todo => todo.id !== action.payload)
      }
    
    case 'CLEAR_COMPLETED':
      return {
        ...state,
        todos: state.todos.filter(todo => !todo.completed)
      }
    
    default:
      return state
  }
}

function TodoApp() {
  const [state, dispatch] = useReducer(todoReducer, initialState)

  return (
    <div>
      {/* Add todo form */}
      
      {/* Filter buttons */}
      <button onClick={() => dispatch({ type: 'CLEAR_COMPLETED' })}>
        Clear Completed
      </button>
      
      {/* Todo list */}
      {state.todos.map(todo => (
        <TodoItem 
          key={todo.id} 
          todo={todo} 
          onToggle={() => dispatch({ type: 'TOGGLE_TODO', payload: todo.id })}
          onDelete={() => dispatch({ type: 'DELETE_TODO', payload: todo.id })}
        />
      ))}
    </div>
  )
}
```

### State Management Libraries

**Redux Toolkit (Recommended):**
```tsx
// store/todoSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

interface TodoState {
  todos: Array<{ id: number; text: string }>
  status: 'idle' | 'loading' | 'succeeded' | 'failed'
}

const initialState: TodoState = {
  todos: [],
  status: 'idle'
}

export const todoSlice = createSlice({
  name: 'todos',
  initialState,
  reducers: {
    addTodo: (state, action: PayloadAction<string>) => {
      state.todos.push({ id: Date.now(), text: action.payload })
    },
    removeTodo: (state, action: PayloadAction<number>) => {
      state.todos = state.todos.filter(t => t.id !== action.payload)
    }
  }
})

export const { addTodo, removeTodo } = todoSlice.actions
```

**Zustand (Lightweight Alternative):**
```tsx
// store/todoStore.ts
import { create } from 'zustand'

interface TodoStore {
  todos: Array<{ id: number; text: string }>
  addTodo: (text: string) => void
  removeTodo: (id: number) => void
}

export const useTodoStore = create<TodoStore>((set) => ({
  todos: [],
  addTodo: (text) => set((state) => ({
    todos: [...state.todos, { id: Date.now(), text }]
  })),
  removeTodo: (id) => set((state) => ({
    todos: state.todos.filter(t => t.id !== id)
  }))
}))
```

### State Normalization

For complex data structures, normalize your state:

```tsx
interface State {
  users: Record<number, User>  // Indexed by ID
  userIds: number[]            // Array of IDs for ordering
}

const initialState: State = {
  users: {},
  userIds: []
}

function usersReducer(state: State, action: any): State {
  switch (action.type) {
    case 'FETCH_USERS_SUCCESS':
      return {
        ...state,
        users: action.payload.reduce((acc: any, user: User) => ({
          ...acc,
          [user.id]: user
        }), {}),
        userIds: action.payload.map((user: User) => user.id)
      }
    
    case 'UPDATE_USER':
      return {
        ...state,
        users: {
          ...state.users,
          [action.payload.id]: action.payload
        }
      }
  }
}
```

---

## 2. Context API Deep Dive

### Basic Context Usage

```tsx
// ThemeContext.tsx
import { createContext, useContext, useState, ReactNode } from 'react'

interface ThemeContextType {
  theme: 'light' | 'dark'
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light')
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
```

### Performance Optimization with Context

**Problem:** Context updates cause all consumers to re-render.

**Solution 1: Split contexts by concern**
```tsx
// UserContext.tsx
const UserContext = createContext<User | null>(null)

// SettingsContext.tsx  
const SettingsContext = createContext<Settings | null>(null)

// Don't combine them into one big context!
```

**Solution 2: Memoize context values**
```tsx
function App() {
  const [count, setCount] = useState(0)
  const [user, setUser] = useState<User>({ name: 'John' })

  return (
    <UserContext.Provider value={user}>
      <Counter count={count} setCount={setCount}>
        {/* Only Counter re-renders when count changes */}
      </Counter>
    </UserContext.Provider>
  )
}
```

**Solution 3: Use selector pattern (like Redux)**
```tsx
function useThemeColor() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('Missing ThemeProvider')
  
  // Only re-render when theme changes, not other context updates
  return context.theme === 'dark' ? '#000' : '#fff'
}
```

### Advanced Context Patterns

**Composition with Multiple Providers:**
```tsx
function App() {
  return (
    <ThemeProvider>
      <QueryProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </QueryProvider>
    </ThemeProvider>
  )
}
```

**Context with Hooks:**
```tsx
function useThemeWithAnimation() {
  const theme = useTheme()
  
  useEffect(() => {
    document.body.className = `theme-${theme}`
  }, [theme])
}
```

---

## 3. Performance Optimization

### React.memo for Component Memoization

Prevent unnecessary re-renders:

```tsx
import { memo, useMemo } from 'react'

interface UserListProps {
  users: User[]
  onSelect: (user: User) => void
}

// Only re-renders when users or onSelect changes
const UserList = memo<UserListProps>(({ users, onSelect }) => {
  console.log('Rendering UserList')
  
  return (
    <ul>
      {users.map(user => (
        <UserItem key={user.id} user={user} onSelect={onSelect} />
      ))}
    </ul>
  )
})

export default UserList
```

### useMemo for Expensive Calculations

```tsx
function ExpenseTracker({ expenses }: { expenses: Expense[] }) {
  // Expensive calculation - only re-computed when expenses change
  const total = useMemo(() => {
    console.log('Calculating total...')
    return expenses.reduce((sum, exp) => sum + exp.amount, 0)
  }, [expenses])

  const filteredExpenses = useMemo(() => {
    return expenses.filter(exp => exp.category === 'food')
  }, [expenses])

  return (
    <div>
      <p>Total: ${total}</p>
      <ExpenseList expenses={filteredExpenses} />
    </div>
  )
}
```

### useCallback for Function Memoization

Prevent function recreation on every render:

```tsx
function Parent() {
  const [count, setCount] = useState(0)

  // Without useCallback, this creates a new function each render
  // causing Child to re-render unnecessarily
  const handleClick = () => {
    console.log('Clicked!', count)
  }

  return <Child onClick={handleClick} />
}

// Better with useCallback
function Parent() {
  const [count, setCount] = useState(0)

  const handleClick = useCallback(() => {
    console.log('Clicked!', count)
  }, [count])  // Only recreates when count changes

  return <Child onClick={handleClick} />
}
```

### Code Splitting with React.lazy & Suspense

```tsx
import { lazy, Suspense } from 'react'

// Lazy load components
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Settings = lazy(() => import('./pages/Settings'))

function App() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Suspense>
  )
}
```

### Virtualization for Large Lists

Use `react-window` or `react-virtual` for long lists:

```tsx
import { FixedSizeList } from 'react-window'

function VirtualizedList({ items }: { items: string[] }) {
  const Row = ({ index, style }: any) => (
    <div style={style}>Item {index}: {items[index]}</div>
  )

  return (
    <FixedSizeList
      height={400}
      itemCount={items.length}
      itemSize={35}
      width="100%"
    >
      {Row}
    </FixedSizeList>
  )
}
```

### Profiling Performance

Use React DevTools Profiler:

```tsx
import { Profiler, ProfilerOnRenderCallback } from 'react'

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
  console.log(`${id} took ${actualDuration}ms`)
}

<Profiler id="App" onRender={onRender}>
  <App />
</Profiler>
```

---

## 4. Custom Hooks Patterns

### useDebounce

Delay function execution:

```tsx
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => clearTimeout(timer)
  }, [value, delay])

  return debouncedValue
}

// Usage
function Search() {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounce(query, 500)

  useEffect(() => {
    // API call only after user stops typing for 500ms
    fetchSearchResults(debouncedQuery)
  }, [debouncedQuery])

  return <input value={query} onChange={(e) => setQuery(e.target.value)} />
}
```

### usePrevious

Track previous values:

```tsx
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>()

  useEffect(() => {
    ref.current = value
  }, [value])

  return ref.current
}

// Usage - detect direction of change
function Counter() {
  const [count, setCount] = useState(0)
  const prevCount = usePrevious(count)

  if (prevCount !== undefined) {
    console.log(`Changed from ${prevCount} to ${count}`)
  }

  return <button onClick={() => setCount(c => c + 1)}>{count}</button>
}
```

### useIntersectionObserver

Track when elements enter viewport:

```tsx
function useInView(options?: IntersectionObserverInit) {
  const [isInView, setIsInView] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const observer = new IntersectionObserver(([entry]) => {
      setIsInView(entry.isIntersecting)
    }, options)

    observer.observe(element)
    return () => observer.disconnect()
  }, [options])

  return { ref, isInView }
}

// Usage - lazy load images or trigger animations
function ImageGallery() {
  const { ref, isInView } = useInView({ threshold: 0.1 })

  return (
    <div ref={ref}>
      {isInView && <LazyImage src="image.jpg" />}
    </div>
  )
}
```

### useFetch with Cancellation

Handle async operations properly:

```tsx
function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    abortControllerRef.current = new AbortController()

    const fetchData = async () => {
      try {
        setLoading(true)
        const response = await fetch(url, {
          signal: abortControllerRef.current.signal
        })
        
        if (!response.ok) throw new Error('Network response was not ok')
        
        const json = await response.json()
        setData(json)
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err as Error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()

    return () => abortControllerRef.current?.abort()
  }, [url])

  return { data, loading, error }
}
```

---

## 5. Component Composition Patterns

### Render Props Pattern

```tsx
interface MouseTrackerProps {
  render: (position: { x: number; y: number }) => React.ReactNode
}

function MouseTracker({ render }: MouseTrackerProps) {
  const [position, setPosition] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      setPosition({ x: e.clientX, y: e.clientY })
    }

    window.addEventListener('mousemove', handleMove)
    return () => window.removeEventListener('mousemove', handleMove)
  }, [])

  return <>{render(position)}</>
}

// Usage
<MouseTracker render={({ x, y }) => (
  <div>Mouse at: {x}, {y}</div>
)} />
```

### Children as Functions

```tsx
interface LayoutProps {
  children: (actions: { toggle: () => void }) => React.ReactNode
}

function Sidebar({ children }: LayoutProps) {
  const [isOpen, setIsOpen] = useState(true)

  return (
    <aside>
      {children({ toggle: () => setIsOpen(!isOpen) })}
    </aside>
  )
}

// Usage
<Sidebar>
  {(actions) => (
    <>
      <button onClick={actions.toggle}>Toggle</button>
      {isOpen && <SidebarContent />}
    </>
  )}
</Sidebar>
```

### Compound Components

```tsx
interface SelectProps {
  children: React.ReactNode
}

const SelectContext = createContext<any>(null)

function Select({ children }: SelectProps) {
  const [value, setValue] = useState('')
  
  return (
    <SelectContext.Provider value={{ value, setValue }}>
      <select value={value} onChange={(e) => setValue(e.target.value)}>
        {children}
      </select>
    </SelectContext.Provider>
  )
}

function Option({ value }: { value: string }) {
  const context = useContext(SelectContext)
  
  return (
    <option value={value}>
      {context?.value === value && '✓ '}
      {value}
    </option>
  )
}

// Usage
<Select>
  <Option value="a">A</Option>
  <Option value="b">B</Option>
</Select>
```

### Higher-Order Components (HOCs)

```tsx
function withLoading<P extends object>(
  Component: React.ComponentType<P>,
  promiseFactory: () => Promise<any>
): React.FC<P> {
  return function WithLoading(props: P) {
    const [loading, setLoading] = useState(true)
    
    useEffect(() => {
      promiseFactory().finally(() => setLoading(false))
    }, [])

    if (loading) return <LoadingSpinner />
    
    return <Component {...props} />
  }
}

// Usage
const Dashboard = withLoading(
  ({ userId }: { userId: number }) => <UserDashboard id={userId} />,
  () => fetch(`/api/users/${userId}`)
)
```

---

## 6. Error Boundaries & Error Handling

### Class-Based Error Boundaries

React error boundaries must be class components:

```tsx
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error caught:', error, errorInfo)
    // Send to error reporting service
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback
    }

    return this.props.children
  }
}

// Usage
<ErrorBoundary fallback={<ErrorMessage />}>
  <UserProfile userId={123} />
</ErrorBoundary>
```

### Error Handling with try/catch in Async Operations

```tsx
async function fetchData() {
  try {
    const response = await fetch('/api/data')
    
    if (!response.ok) {
      throw new HttpError(response.status, response.statusText)
    }
    
    return await response.json()
  } catch (error) {
    // Handle specific error types
    if (error instanceof HttpError) {
      showErrorToast(error.message)
    } else if (error.name === 'AbortError') {
      console.log('Request cancelled')
    } else {
      logErrorToService(error)
      throw error  // Re-throw for component to handle
    }
  }
}
```

### Global Error Handling

```tsx
// src/error-handler.ts
export function setupGlobalErrorHandling() {
  window.addEventListener('error', (event) => {
    logToSentry({
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    logToSentry({
      message: 'Unhandled promise rejection',
      reason: event.reason
    })
  })
}
```

---

## 7. Code Splitting & Lazy Loading

### Route-Based Code Spliting

```tsx
import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'

const Home = lazy(() => import('./pages/Home'))
const About = lazy(() => import('./pages/About'))
const Dashboard = lazy(() => import('./pages/Dashboard'))

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/dashboard/*" element={<Dashboard />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
```

### Dynamic Imports with Conditions

```tsx
function ComponentFactory({ type }: { type: 'light' | 'heavy' }) {
  const [Component, setComponent] = useState<React.ComponentType | null>(null)

  useEffect(() => {
    if (type === 'light') {
      import('./components/LightComponent').then(m => setComponent(m.default))
    } else {
      import('./components/HeavyComponent').then(m => setComponent(m.default))
    }
  }, [type])

  return Component ? <Component /> : <LoadingSpinner />
}
```

### Chunk Optimization with Vite

Configure `vite.config.ts`:

```tsx
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          ui: ['@mui/material', '@emotion/react']
        }
      }
    }
  }
})
```

---

## 8. Server-Side Rendering (SSR)

### Next.js Example

```tsx
// pages/posts/[id].tsx
import { GetServerSideProps } from 'next'

interface PostProps {
  post: Post
}

export const getServerSideProps: GetServerSideProps = async ({ params }) => {
  const res = await fetch(`https://api.example.com/posts/${params?.id}`)
  const post = await res.json()

  return { props: { post } }
}

function PostPage({ post }: PostProps) {
  return <div>{post.title}</div>
}

export default PostPage
```

### Remix Example

```tsx
// app/routes/posts.$id.tsx
import { useLoaderData, Link } from 'react-router-dom'

export async function loader({ params }: any) {
  const res = await fetch(`https://api.example.com/posts/${params.id}`)
  return res.json()
}

export default function PostRoute() {
  const post = useLoaderData() as Post
  
  return (
    <div>
      <Link to="/posts">← Back</Link>
      <h1>{post.title}</h1>
      <p>{post.content}</p>
    </div>
  )
}
```

---

## 9. Testing Strategies

### Unit Tests with Vitest

```tsx
// src/components/Button.test.tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import Button from './Button'

describe('Button', () => {
  it('renders with correct text', () => {
    render(<Button label="Click me" />)
    expect(screen.getByRole('button')).toHaveTextContent('Click me')
  })

  it('calls onClick when clicked', () => {
    const handleClick = vi.fn()
    render(<Button label="Click" onClick={handleClick} />)
    
    fireEvent.click(screen.getByRole('button'))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })
})
```

### Integration Tests with React Testing Library

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import App from './App'

describe('App', () => {
  it('fetches and displays data', async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => [{ id: 1, name: 'Test' }]
    } as Response)

    render(<App />)
    
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    
    await waitFor(() => {
      expect(screen.getByText('Test')).toBeInTheDocument()
    })
  })
})
```

### E2E Tests with Playwright

```tsx
// tests/example.spec.ts
import { test, expect } from '@playwright/test'

test('homepage loads', async ({ page }) => {
  await page.goto('/')
  
  await expect(page).toHaveTitle(/React App/)
  await expect(page.getByRole('button')).toBeVisible()
})

test('counter works', async ({ page }) => {
  await page.goto('/')
  
  const button = page.getByRole('button')
  await button.click()
  
  await expect(page.locator('.count')).toHaveText('1')
})
```

---

## 10. Architecture & Scalability

### Feature-Based Folder Structure

```
src/
├── features/
│   ├── auth/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── services/
│   │   └── index.ts
│   ├── todos/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── services/
│   │   └── index.ts
│   └── dashboard/
├── shared/
│   ├── components/
│   ├── hooks/
│   ├── utils/
│   └── types/
├── app/
│   ├── providers/
│   ├── routes/
│   └── store/
```

### Dependency Injection Pattern

```tsx
interface ApiService {
  get: <T>(url: string) => Promise<T>
  post: <T>(url: string, data: any) => Promise<T>
}

class HttpApiService implements ApiService {
  async get<T>(url: string): Promise<T> {
    const res = await fetch(url)
    return res.json()
  }
  
  async post<T>(url: string, data: any): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(data)
    })
    return res.json()
  }
}

// Inject service into component
function useTodos(apiService: ApiService = new HttpApiService()) {
  const [todos, setTodos] = useState<Todo[]>([])
  
  useEffect(() => {
    apiService.get<Todo[]>('/api/todos').then(setTodos)
  }, [apiService])
  
  return { todos }
}
```

### State Machine with XState

```tsx
import { createMachine, interpret } from 'xstate'

const todoMachine = createMachine({
  id: 'todo',
  initial: 'idle',
  states: {
    idle: {
      on: { ADD_TODO: 'adding' }
    },
    adding: {
      on: { SUBMIT: 'submitting', CANCEL: 'idle' }
    },
    submitting: {
      invoke: {
        src: (context, event) => addTodoApi(event.todo),
        onDone: [{ target: 'idle', actions: 'addTodo' }]
      }
    }
  }
})

const service = interpret(todoMachine).start()
```

---

## 🎯 Advanced Exercises

1. **Build a Real-Time Dashboard** with WebSockets, virtualized lists, and optimistic updates
2. **Create a Design System** with compound components and theming
3. **Implement Offline-First App** with service workers and IndexedDB
4. **Migrate to TypeScript** with strict mode and advanced types

---

## 📚 Resources

- **React Performance:** https://react.dev/learn/render-and-commit
- **State Management:** https://redux.js.org/tutorials/fundamentals/introduction
- **Testing:** https://testing-library.com/docs/react-testing-library/intro
- **SSR Patterns:** https://nextjs.org/docs/app/building-your-application/rendering

---

**🎉 You're now ready to build enterprise-scale React applications!**
