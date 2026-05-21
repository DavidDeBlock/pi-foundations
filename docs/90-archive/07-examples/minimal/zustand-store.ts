// File: docs/07-examples/minimal/zustand-store.ts

/**
 * Minimal Zustand Store Example
 * 
 * Status: ✅ Production pattern
 * Source: client/src/features/todo/store.ts (simplified)
 * 
 * This example shows the basic pattern for creating a feature-level
 * Zustand store. Each feature should have its own store, not a global monolith.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Define state interface
interface TodoState {
  todos: Array<{ id: string; title: string; completed: boolean }>;
  loading: boolean;
}

// Define actions interface
interface TodoActions {
  addTodo: (title: string) => void;
  toggleTodo: (id: string) => void;
  deleteTodo: (id: string) => void;
  setLoading: (loading: boolean) => void;
}

// Create store with TypeScript inference
export const useTodoStore = create<TodoState & TodoActions>()(
  persist(
    (set) => ({
      todos: [],
      loading: false,
      
      addTodo: (title) =>
        set((state) => ({
          todos: [
            ...state.todos,
            { id: Date.now().toString(), title, completed: false },
          ],
        })),
      
      toggleTodo: (id) =>
        set((state) => ({
          todos: state.todos.map((todo) =>
            todo.id === id ? { ...todo, completed: !todo.completed } : todo
          ),
        })),
      
      deleteTodo: (id) =>
        set((state) => ({
          todos: state.todos.filter((todo) => todo.id !== id),
        })),
      
      setLoading: (loading) => set({ loading }),
    }),
    {
      name: 'todo-storage', // localStorage key
    }
  )
);

/**
 * Usage Example:
 * 
 * import { useTodoStore } from './store';
 * 
 * function TodoList() {
 *   const todos = useTodoStore((state) => state.todos);
 *   const addTodo = useTodoStore((state) => state.addTodo);
 *   
 *   return (
 *     <div>
 *       {todos.map(todo => (
 *         <div key={todo.id}>{todo.title}</div>
 *       ))}
 *       <button onClick={() => addTodo('New Todo')}>Add</button>
 *     </div>
 *   );
 * }
 */

/**
 * Key Patterns:
 * 
 * 1. One store per feature (not global monolith)
 * 2. Explicit state and actions interfaces for type safety
 * 3. Use selectors to subscribe to specific state slices
 * 4. Persist to localStorage with middleware (optional)
 * 5. Actions are functions that call set() with new state
 */
