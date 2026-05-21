# 🎓 React Beginner's Complete Guide

**Estimated Time:** 4-6 hours (with exercises)  
**Goal:** Understand core React concepts and build real applications

---

## 📚 Table of Contents

1. [Getting Started](#1-getting-started)
2. [Core Concepts](#2-core-concepts)
3. [Components & Props](#3-components--props)
4. [State Management](#4-state-management)
5. [Event Handling](#5-event-handling)
6. [Conditional Rendering](#6-conditional-rendering)
7. [Lists & Keys](#7-lists--keys)
8. [Effects & Lifecycle](#8-effects--lifecycle)
9. [Custom Hooks](#9-custom-hooks)
10. [Project Structure](#10-project-structure)

---

## 1. Getting Started

### 🛠️ Setup Modern React Project

```bash
# Create project with Vite (recommended over Create React App)
npm create vite@latest my-app -- --template react-ts

cd my-app

# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### 📁 Project Structure

```
my-app/
├── public/              # Static assets
├── src/
│   ├── assets/         # Images, fonts, etc.
│   ├── components/     # Reusable UI components
│   ├── hooks/          # Custom hooks
│   ├── types/          # TypeScript type definitions
│   ├── App.tsx         # Root component
│   ├── main.tsx        # Application entry point
│   └── index.css       # Global styles
├── index.html          # HTML template
├── package.json        # Dependencies & scripts
├── tsconfig.json       # TypeScript configuration
└── vite.config.ts      # Vite configuration
```

### 🎯 Your First Component

```tsx
// src/components/Greeting.tsx
function Greeting({ name }: { name: string }) {
  return <h1>Hello, {name}!</h1>
}

export default Greeting
```

**Usage:**
```tsx
// src/App.tsx
import Greeting from './components/Greeting'

function App() {
  return <Greeting name="React Beginner" />
}

export default App
```

---

## 2. Core Concepts

### What is React?

React is a **library** for building user interfaces, not a full framework. Key principles:

- **Component-Based:** Build encapsulated components that manage their own state
- **Declarative:** Describe what your UI should look like, React handles updates
- **Learn Once, Write Anywhere:** Use React for web, native (React Native), etc.

### JSX: JavaScript XML

JSX is a syntax extension that lets you write HTML-like code in JavaScript:

```tsx
// Valid JSX
const element = <h1 className="greeting">Hello, world!</h1>

// Equivalent to regular JavaScript
const element = React.createElement(
  'h1',
  { className: 'greeting' },
  'Hello, world!'
)
```

**JSX Rules:**
- ✅ Return a single parent element (or use fragments `<>...</>`)
- ✅ Close all elements (`<img />`, not `<img>`)
- ✅ Use camelCase for attributes (`className` not `class`)
- ✅ Embed JavaScript with `{}`

---

## 3. Components & Props

### Functional Components

Modern React uses functional components with hooks:

```tsx
function Button({ label, onClick }: { 
  label: string; 
  onClick?: () => void 
}) {
  return (
    <button onClick={onClick} style={{ padding: '10px 20px' }}>
      {label}
    </button>
  )
}

export default Button
```

### Props (Properties)

Props are read-only inputs to components:

```tsx
interface UserCardProps {
  name: string
  age: number
  isActive?: boolean  // Optional prop
  children?: React.ReactNode  // For content injection
}

function UserCard({ name, age, isActive = true, children }: UserCardProps) {
  return (
    <div className="card">
      <h2>{name}</h2>
      <p>Age: {age}</p>
      <span>Status: {isActive ? 'Active' : 'Inactive'}</span>
      {children}  {/* Content passed between tags */}
    </div>
  )
}

// Usage with children
<UserCard name="Alice" age={30}>
  <p>This is additional content</p>
</UserCard>
```

### Component Composition

Build complex UIs by composing smaller components:

```tsx
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="card-content">{children}</div>
    </div>
  )
}

function App() {
  return (
    <Card title="My Card">
      <p>Content goes here</p>
      <Button label="Click me" />
    </Card>
  )
}
```

---

## 4. State Management

### useState Hook

The most fundamental hook for managing local state:

```tsx
import { useState } from 'react'

function Counter() {
  // Declare a state variable called "count"
  const [count, setCount] = useState<number>(0)

  return (
    <div>
      <p>You clicked {count} times</p>
      <button onClick={() => setCount(count + 1)}>
        Click me
      </button>
    </div>
  )
}
```

### State Updates are Asynchronous & Batched

```tsx
function Counter() {
  const [count, setCount] = useState(0)

  const handleClick = () => {
    setCount(count + 1)
    setCount(count + 1)
    setCount(count + 1)
    
    // All three updates are batched!
    // count will be incremented by 3, not 1+1+1=3 separately
  }

  return <button onClick={handleClick}>Increment</button>
}
```

### State with Objects & Arrays

**Updating Objects:**
```tsx
function Form() {
  const [user, setUser] = useState({ name: '', email: '' })

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    
    // Create new object (immutable update)
    setUser({ ...user, [name]: value })
  }

  return (
    <form>
      <input 
        name="name" 
        value={user.name} 
        onChange={handleChange} 
      />
      <input 
        name="email" 
        type="email" 
        value={user.email} 
        onChange={handleChange} 
      />
    </form>
  )
}
```

**Updating Arrays:**
```tsx
function TodoList() {
  const [todos, setTodos] = useState<string[]>([])

  // Add todo
  const addTodo = (text: string) => {
    setTodos([...todos, text])
  }

  // Remove todo
  const removeTodo = (index: number) => {
    setTodos(todos.filter((_, i) => i !== index))
  }

  // Update specific item
  const updateTodo = (index: number, newText: string) => {
    setTodos(
      todos.map((todo, i) => 
        i === index ? newText : todo
      )
    )
  }

  return <ul>{todos.map((todo, i) => (
    <li key={i}>
      {todo}
      <button onClick={() => removeTodo(i)}>Delete</button>
    </li>
  ))}</ul>
}
```

### Multiple State Variables

```tsx
function Counter() {
  // Multiple state variables
  const [count, setCount] = useState(0)
  const [step, setStep] = useState(1)

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + step)}>Add</button>
      <button onClick={() => setStep(step + 1)}>Increase Step</button>
    </div>
  )
}
```

---

## 5. Event Handling

### Basic Events

React events are named using camelCase:

```tsx
function Button() {
  const handleClick = () => {
    console.log('Button clicked!')
  }

  return <button onClick={handleClick}>Click Me</button>
}
```

### Passing Arguments

```tsx
function TodoItem({ todo, onDelete }: { 
  todo: string; 
  onDelete: (text: string) => void 
}) {
  const handleClick = () => {
    onDelete(todo)
  }

  return <button onClick={handleClick}>Delete {todo}</button>
}

// Usage
<TodoItem todo="Learn React" onDelete={(text) => console.log(text)} />
```

### Synthetic Events

React wraps native browser events in **SyntheticEvent** for cross-browser compatibility:

```tsx
function Form() {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()  // Prevent page reload
    console.log('Form submitted')
  }

  return <form onSubmit={handleSubmit}>...</form>
}
```

### Event Propagation

```tsx
function Container() {
  const handleContainerClick = () => {
    console.log('Container clicked')
  }

  const handleChildClick = (e: React.MouseEvent) => {
    e.stopPropagation()  // Prevent bubbling to parent
    console.log('Child clicked')
  }

  return (
    <div onClick={handleContainerClick}>
      <button onClick={handleChildClick}>Click Me</button>
    </div>
  )
}
```

---

## 6. Conditional Rendering

### If Statements

```tsx
function UserGreeting({ isLoggedIn }: { isLoggedIn: boolean }) {
  let message

  if (isLoggedIn) {
    message = <WelcomeMessage />
  } else {
    message = <LoginPrompt />
  }

  return <div>{message}</div>
}
```

### Ternary Operator

```tsx
function LoadingScreen({ isLoading }: { isLoading: boolean }) {
  return (
    <div>
      {isLoading ? (
        <p>Loading...</p>
      ) : (
        <p>Welcome!</p>
      )}
    </div>
  )
}
```

### Logical AND (`&&`)

```tsx
function Mailbox({ unreadMessages }: { unreadMessages: number }) {
  return (
    <div>
      <h2>Inbox</h2>
      {/* Only renders if unreadMessages > 0 */}
      {unreadMessages > 0 && <p>You have {unreadMessages} messages!</p>}
    </div>
  )
}
```

### Early Return Pattern

```tsx
function AdminPanel({ isAdmin }: { isAdmin: boolean }) {
  // Early return for unauthorized users
  if (!isAdmin) {
    return <p>Access denied</p>
  }

  return (
    <div className="admin-panel">
      <h2>Admin Dashboard</h2>
      {/* Admin-only content */}
    </div>
  )
}
```

---

## 7. Lists & Keys

### Rendering Arrays

```tsx
function NumberList() {
  const numbers = [1, 2, 3, 4, 5]

  return (
    <ul>
      {numbers.map((number) => (
        <li key={number.toString()}>{number}</li>
      ))}
    </ul>
  )
}
```

### Why Keys Matter

Keys help React identify which items have changed:

```tsx
function TodoList({ todos }: { todos: Array<{ id: number; text: string }> }) {
  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>  {/* ✅ Use unique ID, not index! */}
          {todo.text}
        </li>
      ))}
    </ul>
  )
}
```

**⚠️ Don't use array indices as keys** unless the list is static:

```tsx
// ❌ Bad - causes performance issues and bugs
{items.map((item, index) => <li key={index}>{item}</li>)}

// ✅ Good - use unique ID
{items.map((item) => <li key={item.id}>{item}</li>)}
```

---

## 8. Effects & Lifecycle

### useEffect Hook

Use effects for side effects (API calls, subscriptions, DOM manipulation):

```tsx
import { useState, useEffect } from 'react'

function UserProfile({ userId }: { userId: number }) {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  // Effect runs after every render by default
  useEffect(() => {
    console.log('Component rendered')

    // Fetch user data
    fetch(`/api/users/${userId}`)
      .then(res => res.json())
      .then(data => {
        setUser(data)
        setLoading(false)
      })
  }, [userId])  // Dependency array - only re-run when userId changes

  if (loading) return <div>Loading...</div>

  return <div>{user.name}</div>
}
```

### Effect Variations

**Run once on mount:**
```tsx
useEffect(() => {
  console.log('Mounted')
}, [])  // Empty array = run only once
```

**Cleanup function (component unmount):**
```tsx
useEffect(() => {
  const subscription = api.subscribe((data) => console.log(data))

  return () => {
    // Cleanup on unmount
    subscription.unsubscribe()
  }
}, [])
```

### Common Patterns

**API Calls:**
```tsx
function SearchResults({ query }: { query: string }) {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!query) return

    setLoading(true)
    
    fetch(`/api/search?q=${query}`)
      .then(res => res.json())
      .then(data => {
        setResults(data)
        setLoading(false)
      })
  }, [query])

  return loading ? <div>Loading...</div> : <ul>{results.map(...)}</ul>
}
```

**Document Title Updates:**
```tsx
useEffect(() => {
  document.title = `Count: ${count}`
}, [count])
```

---

## 9. Custom Hooks

### Creating Your Own Hooks

Extract reusable stateful logic into custom hooks:

```tsx
// src/hooks/useLocalStorage.ts
import { useState, useEffect } from 'react'

export function useLocalStorage<T>(key: string, initialValue: T) {
  // State to store our value
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key)
      return item ? JSON.parse(item) : initialValue
    } catch (error) {
      console.error(error)
      return initialValue
    }
  })

  // Update localStorage when state changes
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(storedValue))
    } catch (error) {
      console.error(error)
    }
  }, [key, storedValue])

  return [storedValue, setStoredValue] as const
}

// Usage
function App() {
  const [name, setName] = useLocalStorage('username', 'Guest')
  
  return (
    <div>
      <p>Hello, {name}!</p>
      <input 
        value={name} 
        onChange={(e) => setName(e.target.value)} 
      />
    </div>
  )
}
```

### Building a Custom Fetch Hook

```tsx
// src/hooks/useFetch.ts
import { useState, useEffect } from 'react'

interface UseFetchResult<T> {
  data: T | null
  loading: boolean
  error: Error | null
}

export function useFetch<T>(url: string): UseFetchResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error('Network response was not ok')
        const json = await response.json()
        setData(json)
      } catch (err) {
        setError(err as Error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [url])

  return { data, loading, error }
}

// Usage
function UserList() {
  const { data: users, loading, error } = useFetch<User[]>('/api/users')

  if (loading) return <div>Loading...</div>
  if (error) return <div>Error: {error.message}</div>

  return (
    <ul>
      {users?.map(user => <li key={user.id}>{user.name}</li>)}
    </ul>
  )
}
```

---

## 10. Project Structure

### Recommended Folder Organization

```
src/
├── assets/           # Images, fonts, static files
│   ├── logo.svg
│   └── styles/
├── components/       # Reusable UI components
│   ├── common/       # Generic components (Button, Input)
│   ├── layout/       # Layout components (Header, Footer)
│   └── features/     # Feature-specific components
├── hooks/            # Custom hooks
│   ├── useLocalStorage.ts
│   └── useFetch.ts
├── pages/            # Page components
│   ├── Home.tsx
│   └── About.tsx
├── types/            # TypeScript type definitions
│   └── index.ts
├── utils/            # Helper functions
│   └── format.ts
├── App.tsx           # Root component
├── main.tsx          # Entry point
└── index.css         # Global styles
```

### Component File Naming

- **PascalCase** for components: `UserProfile.tsx`
- **camelCase** for utilities: `formatDate.ts`
- Include `.tsx` extension in imports (Vite requires it)

---

## 🎯 Practice Exercises

### Exercise 1: Build a Todo App
Implement a todo list with add, delete, and toggle completion.

### Exercise 2: Weather Dashboard
Fetch weather data from an API and display it conditionally.

### Exercise 3: Counter with History
Build a counter that tracks the history of all increments.

---

## 📚 Additional Resources

- **Official React Docs:** https://react.dev/learn
- **React TypeScript Cheatsheet:** https://github.com/typescript-cheatsheets/react
- **UI Libraries:** Material UI, Chakra UI, Tailwind CSS

---

**🎉 You're ready to build real React applications!**
