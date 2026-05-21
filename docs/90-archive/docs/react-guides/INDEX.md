# ⚡ React Quickstart Guide

**Estimated Time:** 30-45 minutes  
**Goal:** Get a working React app running in under an hour

---

## 🎯 What You'll Build

A simple interactive counter application that demonstrates:
- ✅ Component structure
- ✅ State management with `useState`
- ✅ Event handling
- ✅ Conditional rendering
- ✅ List rendering

---

## 🚀 Step 1: Setup Your Environment (5 min)

### Prerequisites
```bash
# Check Node.js version (v18+ recommended)
node --version

# Check npm version
npm --version
```

### Create Project with Vite ⚡
> **Note:** Create React App is deprecated! Use Vite instead.

```bash
# Create new React project with TypeScript template
npm create vite@latest my-react-app -- --template react-ts

# Navigate into project
cd my-react-app

# Install dependencies
npm install

# Start development server
npm run dev
```

**Expected Output:**
```
  VITE v5.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

Open `http://localhost:5173/` in your browser 🎉

---

## 📁 Step 2: Project Structure (2 min)

```
my-react-app/
├── src/
│   ├── App.tsx          # Main application component
│   ├── main.tsx         # Entry point
│   └── index.css        # Global styles
├── index.html           # HTML template
├── package.json         # Dependencies & scripts
└── vite.config.ts       # Vite configuration
```

---

## 💻 Step 3: Build Your First Component (10 min)

### Create a Counter Component

Replace `src/App.tsx` with:

```tsx
import { useState } from 'react'

function App() {
  // State management with useState hook
  const [count, setCount] = useState<number>(0)

  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h1>🚀 React Quickstart</h1>
      
      <div style={{ fontSize: '3rem', margin: '1rem 0' }}>
        {count}
      </div>

      <button 
        onClick={() => setCount(count - 1)}
        style={{ marginRight: '1rem', padding: '0.5rem 1rem' }}
      >
        - Decrease
      </button>

      <button 
        onClick={() => setCount(count + 1)}
        style={{ padding: '0.5rem 1rem' }}
      >
        + Increase
      </button>
    </div>
  )
}

export default App
```

**What's happening:**
- `useState(0)` creates a state variable initialized to 0
- `count` holds the current value
- `setCount()` updates the state and re-renders the component
- Arrow functions handle click events

---

## 🎨 Step 4: Add Conditional Rendering (5 min)

Update your App component:

```tsx
import { useState } from 'react'

function App() {
  const [count, setCount] = useState<number>(0)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  // Conditional rendering based on state
  const message = count > 10 
    ? "🎉 Wow! High number!" 
    : count < -10 
      ? "😱 That's a lot negative!" 
      : "👆 Click the buttons"

  return (
    <div style={{ 
      padding: '2rem', 
      textAlign: 'center',
      backgroundColor: theme === 'dark' ? '#1a1a2e' : '#f5f5f5',
      color: theme === 'dark' ? '#ffffff' : '#333333',
      minHeight: '100vh'
    }}>
      <h1>🚀 React Quickstart</h1>
      
      {/* Theme toggle */}
      <button 
        onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        style={{ marginBottom: '2rem', padding: '0.5rem 1rem' }}
      >
        Switch to {theme === 'light' ? 'Dark' : 'Light'} Mode
      </button>

      <div style={{ fontSize: '3rem', margin: '1rem 0' }}>
        {count}
      </div>

      <p style={{ fontSize: '1.2rem', marginBottom: '1.5rem' }}>
        {message}
      </p>

      <button 
        onClick={() => setCount(count - 1)}
        disabled={count <= -10}
        style={{ marginRight: '1rem', padding: '0.5rem 1rem' }}
      >
        - Decrease
      </button>

      <button 
        onClick={() => setCount(count + 1)}
        disabled={count >= 10}
        style={{ padding: '0.5rem 1rem' }}
      >
        + Increase
      </button>
    </div>
  )
}

export default App
```

**Key Concepts:**
- Ternary operators for conditional rendering
- Disabled buttons based on state
- Dynamic styling with inline styles

---

## 📝 Step 5: Add a Todo List (10 min)

Let's add list rendering and more complex state:

```tsx
import { useState } from 'react'

type Todo = {
  id: number
  text: string
  completed: boolean
}

function App() {
  const [count, setCount] = useState<number>(0)
  const [todos, setTodos] = useState<Todo[]>([])
  const [inputValue, setInputValue] = useState<string>('')

  // Add new todo
  const addTodo = () => {
    if (inputValue.trim()) {
      setTodos([
        ...todos,
        { id: Date.now(), text: inputValue, completed: false }
      ])
      setInputValue('')
    }
  }

  // Toggle todo completion
  const toggleTodo = (id: number) => {
    setTodos(todos.map(todo =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    ))
  }

  // Delete todo
  const deleteTodo = (id: number) => {
    setTodos(todos.filter(todo => todo.id !== id))
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <h1>🚀 React Quickstart</h1>
      
      {/* Counter Section */}
      <section style={{ marginBottom: '3rem', padding: '1rem', border: '1px solid #ddd', borderRadius: '8px' }}>
        <h2>Counter</h2>
        <div style={{ fontSize: '2.5rem', margin: '1rem 0' }}>{count}</div>
        <button onClick={() => setCount(count - 1)}>-</button>
        <button onClick={() => setCount(count + 1)}>+</button>
      </section>

      {/* Todo Section */}
      <section style={{ padding: '1rem', border: '1px solid #ddd', borderRadius: '8px' }}>
        <h2>Todo List</h2>
        
        {/* Input */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && addTodo()}
            placeholder="Add a new todo..."
            style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
          />
          <button onClick={addTodo} style={{ padding: '0.5rem 1rem' }}>Add</button>
        </div>

        {/* Todo List */}
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {todos.map(todo => (
            <li 
              key={todo.id} 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '0.5rem',
                padding: '0.5rem',
                backgroundColor: todo.completed ? '#e8f5e9' : 'transparent',
                textDecoration: todo.completed ? 'line-through' : 'none'
              }}
            >
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() => toggleTodo(todo.id)}
              />
              <span>{todo.text}</span>
              <button 
                onClick={() => deleteTodo(todo.id)}
                style={{ marginLeft: 'auto', color: 'red' }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        {todos.length === 0 && (
          <p style={{ textAlign: 'center', color: '#888' }}>No todos yet!</p>
        )}
      </section>
    </div>
  )
}

export default App
```

---

## 🎯 Step 6: Run & Test (5 min)

1. **Start the dev server** (if not already running):
   ```bash
   npm run dev
   ```

2. **Open browser:** `http://localhost:5173/`

3. **Test your app:**
   - ✅ Click buttons to increment/decrement counter
   - ✅ Add todos by typing and pressing Enter or clicking "Add"
   - ✅ Check/uncheck todos to mark as complete
   - ✅ Delete todos with the ✕ button

---

## 📚 Key Concepts Learned

| Concept | What It Does | Example |
|---------|-------------|---------|
| **Components** | Reusable UI building blocks | `<App />`, `<Todo />` |
| **JSX** | HTML-like syntax in JavaScript | `<div>Hello</div>` |
| **useState** | Manage component state | `const [count, setCount] = useState(0)` |
| **Event Handling** | Respond to user interactions | `onClick={() => ...}` |
| **Conditional Rendering** | Show/hide content based on state | `{condition ? <A /> : <B />}` |
| **List Rendering** | Render arrays as lists | `{items.map(item => <li>{item}</li>)}` |

---

## 🎓 Next Steps

Now that you have a working app, explore:

1. **📖 Official Tutorial:** https://react.dev/learn
2. **🔧 Component Extraction:** Split your code into separate components
3. **🎨 Styling:** Learn CSS modules or Tailwind CSS
4. **🌐 API Integration:** Fetch data from an API with `useEffect`

---

## 🆘 Troubleshooting

| Issue | Solution |
|-------|----------|
| Port 5173 already in use | Vite will automatically use next available port |
| Dependencies not installing | Run `npm cache clean --force` then reinstall |
| TypeScript errors | Check your IDE for type hints and fix accordingly |
| Changes not reflecting | Save files - Vite has hot module replacement (HMR) |

---

## 📖 Resources

- **React Docs:** https://react.dev/
- **Vite Docs:** https://vite.dev/
- **TypeScript Handbook:** https://www.typescriptlang.org/docs/
- **React GitHub:** https://github.com/reactjs/react.dev

---

**🎉 Congratulations!** You've built your first React application!
