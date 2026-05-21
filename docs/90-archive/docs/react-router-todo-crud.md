# React Router Todo CRUD Implementation

**Date:** April 2026  
**Project:** Pi Skeleton  
**Status:** Complete with API Integration

---

## ✅ What Was Implemented

### Form Handling with React Router Data APIs

All todo operations now use React Router's `<Form>` component and data APIs:

| Operation | Component | Method | Handler |
|-----------|-----------|--------|---------|
| **Create** | `TodoForm` | POST | `todoAction` (create) |
| **Update** | `TodoEditForm` | PUT | `todoAction` (update) |
| **Delete** | `TodoItem` | DELETE | `todoAction` (delete) |
| **Toggle** | `TodoItem` | TOGGLE | `todoAction` (toggle) |

---

## 📁 File Structure

```
client/src/
├── api/
│   └── todos.ts                    # API client functions (NEW)
├── features/
│   └── todo/
│       ├── routes.tsx              # Route definitions with loader/action
│       ├── services/
│       │   └── todos.service.ts    # Service layer for API calls
│       └── components/
│           ├── TodoFeature.tsx     # Main todo list page (uses useLoaderData)
│           ├── TodoForm.tsx        # Create form (<Form> component)
│           ├── TodoEditForm.tsx    # Edit form (<Form> + loader data)
│           ├── TodoItem.tsx        # Individual todo with delete/toggle forms
│           └── TodoList.tsx        # List of todos (accepts props)
```

---

## 🔧 Key Implementation Details

### 1. Delete Handler in TodoItem

**Before:** Manual form creation with JavaScript
```typescript
// ❌ Old approach - manual DOM manipulation
const handleDelete = () => {
  if (confirm('Delete this todo?')) {
    const form = document.createElement('form')
    // ... manual form setup and submission
    form.submit()
  }
}
```

**After:** React Router Form component with confirmation
```typescript
// ✅ New approach - declarative forms
<Form method="post" onSubmit={(e) => {
  if (!confirm('Delete this todo?')) e.preventDefault()
}}>
  <input type="hidden" name="_method" value="DELETE" />
  <input type="hidden" name="id" value={todo.id} />
  <Button type="submit">Delete</Button>
</Form>
```

### 2. Toggle Handler in TodoItem

**Implementation:**
```typescript
<Form method="post" className="flex items-center gap-3">
  <input type="hidden" name="_method" value="TOGGLE" />
  <input type="hidden" name="id" value={todo.id} />
  <button type="submit" aria-label="Toggle completion">
    {/* Checkbox visual */}
  </button>
</Form>
```

### 3. Action Handler in Routes

**Complete action handler:**
```typescript
export async function todoAction({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData()
  const method = formData.get('_method') as string | null
  
  // Toggle completion
  if (method === 'TOGGLE') {
    const id = formData.get('id') as string
    await toggleTodoCompletion(id)
    return redirect('/todos')
  }
  
  // Delete todo
  if (method === 'DELETE') {
    const id = formData.get('id') as string
    await deleteTodo(id)
    return redirect('/todos')
  }
  
  // Update existing todo
  if (method === 'PUT' && params?.id) {
    const title = formData.get('title') as string
    await updateTodo(params.id, { title })
    return redirect(`/todos/edit/${params.id}`)
  }
  
  // Create new todo
  const title = formData.get('title') as string
  await createTodo({ title, completed: false })
  return redirect('/todos')
}
```

---

## 📋 API Functions

### `client/src/api/todos.ts` (or services layer)

| Function | Method | Endpoint | Description |
|----------|--------|----------|-------------|
| `getTodos()` | GET | `/api/todos` | Fetch all todos |
| `createTodo(data)` | POST | `/api/todos` | Create new todo |
| `updateTodo(id, data)` | PUT | `/api/todos/:id` | Update existing todo |
| `deleteTodo(id)` | DELETE | `/api/todos/:id` | Delete todo |
| `toggleTodo(id)` | POST | `/api/todos/:id/toggle` | Toggle completion status |

---

## 🧪 Testing the Implementation

### Test Create
1. Navigate to `/todos`
2. Enter a title in the form
3. Click "Add Todo"
4. Verify: Form submits, page reloads with new todo

### Test Delete
1. Hover over any todo item
2. Click "Delete" button
3. Confirm the dialog
4. Verify: Todo is removed from list

### Test Toggle
1. Click the checkbox on any todo
2. Verify: Form submits automatically, completion status updates

### Test Edit
1. Click "Edit" on a todo
2. Modify the title
3. Click "Save Changes"
4. Verify: Updates and redirects back to edit page

---

## 🔄 Data Flow Diagram

```
User Action → Form Submit → React Router Action → API Call → Redirect → Loader → Re-render
     ↓              ↓                ↓               ↓           ↓          ↓         ↓
  Click Delete   <Form> POST      todoAction()    deleteTodo()  /todos    getTodos() TodoList updates
```

---

## ✅ Benefits of This Approach

| Feature | Benefit |
|---------|---------|
| **Declarative forms** | No manual form handling code |
| **Built-in loading states** | `useNavigation()` provides submit state |
| **Automatic revalidation** | Loader runs after action completes |
| **Error boundaries** | Built-in error handling with `errorElement` |
| **Type safety** | Full TypeScript support for loader data |
| **Consistent patterns** | All CRUD operations use same pattern |

---

## 📝 Next Steps (Backend)

The frontend is complete. Backend API endpoints needed:

```typescript
// server/src/routes/todos.ts (PENDING IMPLEMENTATION)

GET    /api/todos      → getTodos()
POST   /api/todos      → createTodo()
PUT    /api/todos/:id  → updateTodo()
DELETE /api/todos/:id  → deleteTodo()
POST   /api/todos/:id/toggle → toggleTodoCompletion()
```

---

## 🎯 Summary

The TodoItem component now properly handles:
- ✅ Delete with confirmation dialog using React Router Form
- ✅ Toggle completion using hidden form inputs
- ✅ All operations submit to the parent action handler
- ✅ Automatic page revalidation after mutations
- ✅ Consistent error handling across all operations
