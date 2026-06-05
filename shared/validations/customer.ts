import { z } from 'zod'

// ---------------------------------------------------------------------------
// Customer type enum
// ---------------------------------------------------------------------------

export const customerTypeSchema = z.enum(['private', 'company'])

/** A customer type discriminator */
export type CustomerType = z.infer<typeof customerTypeSchema>

// ---------------------------------------------------------------------------
// Address fields (shared between create and update)
// ---------------------------------------------------------------------------

const addressFields = {
  street: z.string().max(200).optional(),
  number: z.string().max(20).optional(),
  bus: z.string().max(10).optional(),
  postalCode: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  country: z.string().max(5).default('BE'),
}

// ---------------------------------------------------------------------------
// Create input schemas — type branching via discriminated union
// ---------------------------------------------------------------------------

/** Private customer creation input */
const createPrivateSchema = z.object({
  id: z.string().uuid('id must be a valid UUID').optional(),
  type: z.literal('private'),
  firstName: z.string().min(1, 'firstName is required for private customers').max(100),
  lastName: z.string().min(1, 'lastName is required for private customers').max(100),
  companyName: z.string().max(200).optional(),
  vatId: z.string().max(50).optional(),
  phone: z.string().min(1).max(50).optional(),
  email: z.string().min(1).max(50).optional(),
  ...addressFields,
})

/** Company customer creation input */
const createCompanySchema = z.object({
  id: z.string().uuid('id must be a valid UUID').optional(),
  type: z.literal('company'),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  companyName: z.string().min(1, 'companyName is required for company customers').max(200),
  vatId: z.string().max(50).optional(),
  phone: z.string().min(1).max(50).optional(),
  email: z.string().min(1).max(50).optional(),
  ...addressFields,
})

/** Union of create schemas — type branching at validation time */
export const createCustomerSchema = z.discriminatedUnion('type', [
  createPrivateSchema,
  createCompanySchema,
])

/** Input for creating a new customer.
 * Note: country is optional here (defaults to 'BE' at runtime via Zod).
 */
export type CreateCustomerInput = Omit<z.infer<typeof createCustomerSchema>, 'country'> & { country?: string }

// ---------------------------------------------------------------------------
// Update input schema — partial fields, at least one required
// ---------------------------------------------------------------------------

const updateBaseFields = {
  // type is updatable so private↔company conversion works. When set, the
  // matching required fields (firstName+lastName for private, companyName
  // for company) must be present in the same payload — see superRefine below.
  type: customerTypeSchema.optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  companyName: z.string().min(1).max(200).optional(),
  vatId: z.string().max(50).nullable().optional(),
  phone: z.string().min(1).max(50).optional(),
  email: z.string().min(1).max(50).optional(),
  ...addressFields,
}

/** Update input — at least one meaningful field must be provided.
 * Excludes country (has default) and optional fields that may auto-populate.
 */
const updatableFields = [
  'type', 'firstName', 'lastName', 'companyName', 'vatId',
  'phone', 'email', 'street', 'number', 'bus',
  'postalCode', 'city'
] as const

export const updateCustomerSchema = z.object(updateBaseFields).superRefine((data, ctx) => {
  // At least one field must be provided
  if (!updatableFields.some(key => data[key] !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one field must be provided for update',
    })
    return
  }

  // Type-specific validation: when type is explicitly set in the payload, the
  // matching required fields for that type must also be present. Mirrors the
  // discriminated-union rules on the create schema.
  if (data.type === 'private') {
    if (data.firstName === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['firstName'],
        message: 'firstName is required when type is private',
      })
    }
    if (data.lastName === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastName'],
        message: 'lastName is required when type is private',
      })
    }
  } else if (data.type === 'company') {
    if (data.companyName === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['companyName'],
        message: 'companyName is required when type is company',
      })
    }
  }
})

/** Input for updating an existing customer.
 * Note: country is optional here (defaults to 'BE' at runtime via Zod).
 */
export type UpdateCustomerInput = Omit<z.infer<typeof updateCustomerSchema>, 'country'> & { country?: string }

// ---------------------------------------------------------------------------
// Address conditional validation helper
// If street is provided, number/postalCode/city must also be present
// ---------------------------------------------------------------------------

/**
 * Validate address fields — if street is set, number, postalCode, and city are required.
 */
export function validateAddress(input: Record<string, unknown>): { valid: boolean; errors?: string[] } {
  const errors: string[] = []

  if (input.street && !input.number) {
    errors.push('number is required when street is provided')
  }
  if (input.street && !input.postalCode) {
    errors.push('postalCode is required when street is provided')
  }
  if (input.street && !input.city) {
    errors.push('city is required when street is provided')
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true }
}
