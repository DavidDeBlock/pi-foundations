# Todo Feature Integration Example

**Last Updated:** 2026-04-18  
**Maintained By:** Development Team  
**Status:** ✅ Production pattern  

---

## Purpose

This example shows a complete CRUD feature implementation from start to finish, demonstrating all layers working together.

---

## Complete Feature Structure

```
features/todo/
├── components/
│   ├── TodoList.tsx           # Main list component
│   ├── TodoItem.tsx           # Individual todo item
│   └── TodoForm.tsx           # Create/edit form
├── hooks/
│   └── useTodos.ts            # Custom hook for data fetching
├── services/
│   └── todo.service.ts        # API calls to backend
├── validations/
│   └── todo.schema.ts         # Zod validation schemas
├── store.ts                   # Zustand state slice (optional)
├── routes.tsx                 # React Router route definition
└── __tests__/
    ├── services/todo.service.test.ts
    └── components/TodoForm.test.tsx
```

---

## 1. Type Definitions

**Location**: `shared/types/todo.ts`

```typescript
export interface Todo {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateTodoInput = Omit<Todo, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateTodoInput = Partial<Omit<Todo, 'id' | 'createdAt' | 'updatedAt'>>;
```

---

## 2. Validation Schema

**Location**: `shared/validations/todo.schema.ts`

```typescript
import { z } from 'zod';

export const createTodoSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
});

export const updateTodoSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  completed: z.boolean().optional(),
});

// Infer types for TypeScript
export type CreateTodoInput = z.infer<typeof createTodoSchema>;
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;
```

---

## 3. Backend Repository

**Location**: `server/src/repositories/todo.repo.ts`

```typescript
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { todos, type Todo, type NewTodo } from '../../db/schema';

export function createTodoRepository() {
  return {
    async findAll(): Promise<Todo[]> {
      return db.select().from(todos);
    },
    
    async findById(id: string): Promise<Todo | null> {
      const [result] = await db.select().from(todos).where(eq(todos.id, id));
      return result || null;
    },
    
    async create(data: NewTodo): Promise<Todo> {
      const [result] = await db.insert(todos).values(data).returning();
      return result;
    },
    
    async update(id: string, data: Partial<NewTodo>): Promise<Todo> {
      const [result] = await db
        .update(todos)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(todos.id, id))
        .returning();
      return result;
    },
    
    async delete(id: string): Promise<void> {
      await db.delete(todos).where(eq(todos.id, id));
    },
  };
}

export const todoRepository = createTodoRepository();
```

---

## 4. Backend Service

**Location**: `server/src/services/todo.service.ts`

```typescript
import { todoRepository } from '../repositories/todo.repo';
import type { CreateTodoInput, UpdateTodoInput } from '@/shared/validations/todo.schema';

export function createTodoService() {
  return {
    async list(): Promise<Todo[]> {
      return todoRepository.findAll();
    },
    
    async get(id: string): Promise<Todo> {
      const todo = await todoRepository.findById(id);
      if (!todo) throw new Error('Todo not found');
      return todo;
    },
    
    async create(data: CreateTodoInput): Promise<Todo> {
      // Add any business logic here
      const todo = await todoRepository.create({
        title: data.title,
        description: data.description,
        completed: false,
      });
      return todo;
    },
    
    async update(id: string, data: UpdateTodoInput): Promise<Todo> {
      // Verify todo exists before updating
      await this.get(id);
      
      const todo = await todoRepository.update(id, data);
      return todo;
    },
    
    async delete(id: string): Promise<void> {
      await todoRepository.delete(id);
    },
  };
}

export const todoService = createTodoService();
```

---

## 5. Backend Route Handler

**Location**: `server/src/routes/todos.ts`

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { todoService } from '../services/todo.service';
import { createTodoSchema, updateTodoSchema } from '@/shared/validations/todo.schema';
import { authMiddleware } from '../middleware/auth';

const app = new Hono();

// Apply authentication to all routes in this file
app.use('*', authMiddleware);

// GET /api/todos - List all todos
app.get('/', async (c) => {
  const todos = await todoService.list();
  return c.json(todos);
});

// POST /api/todos - Create todo
app.post('/',
  zValidator('json', createTodoSchema),
  async (c) => {
    const data = c.req.valid('json');
    const todo = await todoService.create(data);
    return c.json(todo, 201);
  }
);

// GET /api/todos/:id - Get single todo
app.get('/:id', async (c) => {
  const id = c.req.param('id');
  const todo = await todoService.get(id);
  return c.json(todo);
});

// PUT /api/todos/:id - Update todo
app.put('/:id',
  zValidator('json', updateTodoSchema),
  async (c) => {
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const todo = await todoService.update(id, data);
    return c.json(todo);
  }
);

// DELETE /api/todos/:id - Delete todo
app.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await todoService.delete(id);
  return c.body(null, 204);
});

export default app;
```

---

## 6. Frontend Service

**Location**: `client/src/features/todo/services/todo.service.ts`

```typescript
import { apiClient } from '@/shared/lib/api-client';
import type { Todo, CreateTodoInput, UpdateTodoInput } from '@/shared/types/todo';

export function createTodoService() {
  return {
    async list(): Promise<Todo[]> {
      const response = await apiClient.get<Todo[]>('/api/todos');
      return response;
    },
    
    async get(id: string): Promise<Todo> {
      const response = await apiClient.get<Todo>(`/api/todos/${id}`);
      return response;
    },
    
    async create(data: CreateTodoInput): Promise<Todo> {
      const response = await apiClient.post<Todo>('/api/todos', data);
      return response;
    },
    
    async update(id: string, data: UpdateTodoInput): Promise<Todo> {
      const response = await apiClient.put<Todo>(`/api/todos/${id}`, data);
      return response;
    },
    
    async delete(id: string): Promise<void> {
      await apiClient.delete(`/api/todos/${id}`);
    },
  };
}

export const todoService = createTodoService();
```

---

## 7. Frontend Store (Optional)

**Location**: `client/src/features/todo/store.ts`

```typescript
import { create } from 'zustand';
import { todoService } from './services/todo.service';

interface TodoState {
  todos: Todo[];
  loading: boolean;
  error: string | null;
}

interface TodoActions {
  fetchTodos: () => Promise<void>;
  addTodo: (data: CreateTodoInput) => Promise<void>;
  updateTodo: (id: string, data: UpdateTodoInput) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;
}

export const useTodoStore = create<TodoState & TodoActions>()((set) => ({
  todos: [],
  loading: false,
  error: null,
  
  fetchTodos: async () => {
    set({ loading: true, error: null });
    try {
      const todos = await todoService.list();
      set({ todos, loading: false });
    } catch (error) {
      set({ error: 'Failed to load todos', loading: false });
      throw error;
    }
  },
  
  addTodo: async (data) => {
    const newTodo = await todoService.create(data);
    set((state) => ({ todos: [...state.todos, newTodo] }));
  },
  
  updateTodo: async (id, data) => {
    const updatedTodo = await todoService.update(id, data);
    set((state) => ({
      todos: state.todos.map((todo) => 
        todo.id === id ? updatedTodo : todo
      ),
    }));
  },
  
  deleteTodo: async (id) => {
    await todoService.delete(id);
    set((state) => ({
      todos: state.todos.filter((todo) => todo.id !== id),
    }));
  },
}));
```

---

## 8. Frontend Components

### TodoList Component

**Location**: `client/src/features/todo/components/TodoList.tsx`

```typescript
import { useEffect } from 'react';
import { useTodoStore } from '../store';
import { TodoItem } from './TodoItem';

export function TodoList() {
  const todos = useTodoStore((state) => state.todos);
  const loading = useTodoStore((state) => state.loading);
  const fetchTodos = useTodoStore((state) => state.fetchTodos);
  
  useEffect(() => {
    fetchTodos();
  }, [fetchTodos]);
  
  if (loading) return <div>Loading...</div>;
  if (!todos.length) return <div>No todos yet. Add one below!</div>;
  
  return (
    <div className="todo-list">
      {todos.map(todo => (
        <TodoItem key={todo.id} todo={todo} />
      ))}
    </div>
  );
}
```

### TodoItem Component

**Location**: `client/src/features/todo/components/TodoItem.tsx`

```typescript
import { useTodoStore } from '../store';

interface TodoItemProps {
  todo: Todo;
}

export function TodoItem({ todo }: TodoItemProps) {
  const deleteTodo = useTodoStore((state) => state.deleteTodo);
  
  return (
    <div className={`todo-item ${todo.completed ? 'completed' : ''}`}>
      <input 
        type="checkbox" 
        checked={todo.completed}
        onChange={() => /* toggle logic */}
      />
      <span>{todo.title}</span>
      {todo.description && <p>{todo.description}</p>}
      <button onClick={() => deleteTodo(todo.id)}>Delete</button>
    </div>
  );
}
```

### TodoForm Component

**Location**: `client/src/features/todo/components/TodoForm.tsx`

```typescript
import { useState } from 'react';
import { useTodoStore } from '../store';

export function TodoForm() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const addTodo = useTodoStore((state) => state.addTodo);
  
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    if (!title.trim()) return;
    
    await addTodo({ 
      title: title.trim(),
      description: description.trim() || undefined,
    });
    
    setTitle('');
    setDescription('');
  }
  
  return (
    <form onSubmit={handleSubmit} className="todo-form">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs to be done?"
        required
      />
      
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
      />
      
      <button type="submit">Add Todo</button>
    </form>
  );
}
```

---

## 9. Frontend Route

**Location**: `client/src/features/todo/routes.tsx`

```typescript
import { createAsyncHandler } from 'hono-react/adapter';
import { todoService } from './services/todo.service';
import { TodoPage } from '../pages/TodoPage';

export const todoRoute = {
  path: '/todos',
  element: <TodoPage />,
  
  // Loader for data fetching
  loader: async () => {
    const todos = await todoService.list();
    return { todos };
  },
  
  // Action for mutations
  action: async ({ request }) => {
    const data = await request.json();
    const todo = await todoService.create(data);
    return { todo };
  },
};
```

---

## 10. Tests

### Service Test

**Location**: `client/src/features/__tests__/services/todo.service.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTodoService } from '../todo.service';
import { apiClient } from '@/shared/lib/api-client';

vi.mock('@/shared/lib/api-client');

describe('createTodoService', () => {
  let service: ReturnType<typeof createTodoService>;
  
  beforeEach(() => {
    vi.clearAllMocks();
    service = createTodoService();
  });
  
  it('should create a todo successfully', async () => {
    const mockInput = { title: 'Test Todo' };
    const mockResponse = { id: '1', ...mockInput, completed: false };
    vi.mocked(apiClient.post).mockResolvedValue(mockResponse);
    
    const result = await service.create(mockInput);
    
    expect(result).toEqual(mockResponse);
    expect(apiClient.post).toHaveBeenCalledWith('/api/todos', mockInput);
  });
});
```

### Component Test

**Location**: `client/src/features/__tests__/components/TodoForm.test.tsx`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TodoForm } from '../components/TodoForm';

vi.mock('../store', () => ({
  useTodoStore: () => ({
    addTodo: vi.fn(),
  }),
}));

describe('TodoForm', () => {
  it('should submit form with valid data', async () => {
    const mockAddTodo = vi.fn();
    
    // Mock the store hook
    (useTodoStore as any).mockReturnValue({ addTodo: mockAddTodo });
    
    render(<TodoForm />);
    
    const input = screen.getByPlaceholderText('What needs to be done?');
    const button = screen.getByRole('button', { name: /add todo/i });
    
    fireEvent.change(input, { target: { value: 'Test Todo' } });
    fireEvent.click(button);
    
    expect(mockAddTodo).toHaveBeenCalledWith({ title: 'Test Todo' });
  });
});
```

---

## Key Patterns Summary

1. **Type Safety**: Shared types between client and server
2. **Validation**: Zod schemas on both sides (client UX + server security)
3. **Layer Separation**: Routes → Services → Repositories
4. **Feature Isolation**: All code for a feature in one folder
5. **State Management**: Zustand per-feature, not global monolith
6. **Testing**: Unit tests for services, integration tests for components

---

## Related Documentation

- [CRUD Pattern](../../03-features/patterns/crud-pattern.md) - Complete pattern documentation
- [Architecture Overview](../../02-architecture/overview.md) - System design
- [Tech Stack](../../08-reference/tech-stack.md) - Technology choices
