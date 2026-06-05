import { z } from 'zod'

// ---------------------------------------------------------------------------
// Role enum
// ---------------------------------------------------------------------------

export const staffRoleSchema = z.enum(['mechanic', 'manager'])

/** A staff member role */
export type StaffRole = z.infer<typeof staffRoleSchema>

// ---------------------------------------------------------------------------
// Create input schema
// ---------------------------------------------------------------------------

/** Input for creating a new staff member. */
export const createStaffMemberSchema = z.object({
  id: z.string().uuid('id must be a valid UUID').optional(),
  name: z.string().min(1, 'name is required').max(200),
  role: staffRoleSchema.default('mechanic'),
  hourlyRate: z.number()
    .int('hourlyRate must be an integer (cents)')
    .positive('hourlyRate must be positive'),
  isActive: z.boolean().optional(),
})

/** Input for creating a new staff member. */
export type CreateStaffMemberInput = z.infer<typeof createStaffMemberSchema>

// ---------------------------------------------------------------------------
// Update input schema — partial fields, at least one required
// ---------------------------------------------------------------------------

const updatableFields = [
  'name', 'role', 'hourlyRate', 'isActive'
] as const

/** Input for updating an existing staff member (partial). */
export const updateStaffMemberSchema = z.object({
  name: z.string().min(1, 'name must not be empty').max(200).optional(),
  role: staffRoleSchema.optional(),
  hourlyRate: z.number()
    .int('hourlyRate must be an integer (cents)')
    .positive('hourlyRate must be positive')
    .optional(),
  isActive: z.boolean().optional(),
}).refine(
  data => updatableFields.some(key => data[key] !== undefined),
  { message: 'At least one field must be provided for update' }
)

/** Input for updating an existing staff member. */
export type UpdateStaffMemberInput = z.infer<typeof updateStaffMemberSchema>
