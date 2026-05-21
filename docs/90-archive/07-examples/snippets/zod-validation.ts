// File: docs/07-examples/snippets/zod-validation.ts

/**
 * Zod Validation Schema Pattern
 * 
 * Status: ✅ Production pattern
 * Source: shared/validations/todo.schema.ts (actual implementation)
 * 
 * This example shows how to use Zod for both client and server validation.
 * The same schema is used on both sides for consistency.
 */

import { z } from 'zod';

// Define the schema
export const createTodoSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().optional(),
  completed: z.boolean().default(false),
});

// Infer TypeScript type from schema
export type CreateTodoInput = z.infer<typeof createTodoSchema>;

/**
 * Client-Side Usage (React Form):
 * 
 * import { useForm } from 'react-hook-form';
 * import { zodResolver } from '@hookform/resolvers/zod';
 * 
 * const form = useForm<CreateTodoInput>({
 *   resolver: zodResolver(createTodoSchema),
 * });
 * 
 * function TodoForm() {
 *   const { register, handleSubmit, formState: { errors } } = form;
 *   
 *   return (
 *     <form onSubmit={handleSubmit(onSubmit)}>
 *       <input {...register('title')} placeholder="Title" />
 *       {errors.title && <span>{errors.title.message}</span>}
 *       
 *       <button type="submit">Create</button>
 *     </form>
 *   );
 * }
 */

/**
 * Server-Side Usage (Hono Route):
 * 
 * import { zValidator } from '@hono/zod-validator';
 * 
 * app.post('/api/todos',
 *   zValidator('json', createTodoSchema),
 *   async (c) => {
 *     const data = c.req.valid('json'); // Typed as CreateTodoInput
 *     
 *     await todoService.create(data);
 *     
 *     return c.json({ success: true });
 *   }
 * );
 */

/**
 * Manual Validation (if not using framework):
 * 
 * function createTodo(input: unknown): CreateTodoInput {
 *   const result = createTodoSchema.safeParse(input);
 *   
 *   if (!result.success) {
 *     throw new ValidationError(result.error.errors);
 *   }
 *   
 *   return result.data; // Type-safe!
 * }
 */

/**
 * Key Patterns:
 * 
 * 1. Define schema once, use on client and server
 * 2. Infer TypeScript types automatically with z.infer<>
 * 3. Use .optional() for nullable fields
 * 4. Use .default() for fields with fallback values
 * 5. Validate before any business logic runs
 */

/**
 * Advanced Schema Patterns:
 */

// Email validation with regex
export const userSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// Nested objects
export const addressSchema = z.object({
  street: z.string(),
  city: z.string(),
  zipCode: z.string().regex(/^\d{5}(-\d{4})?$/),
});

export const userWithAddressSchema = z.object({
  name: z.string(),
  address: addressSchema,
});

// Arrays
export const todoListSchema = z.array(createTodoSchema);

// Union types (one of several options)
export const statusSchema = z.enum(['pending', 'in-progress', 'completed']);

// Transform data on parse
export const dateSchema = z.string().transform((str) => new Date(str));
