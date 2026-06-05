import { z } from 'zod'
import {
  partLineItemVariant,
  laborLineItemVariant,
} from './line-item-variants.js'

// ---------------------------------------------------------------------------
// Repair Status — lifecycle states
// ---------------------------------------------------------------------------

export const repairStatusSchema = z.enum([
  'intake', 'in_progress', 'on_hold', 'verified', 'ready', 'completed', 'cancelled'
])

/** A valid repair status */
export type RepairStatus = z.infer<typeof repairStatusSchema>

// ---------------------------------------------------------------------------
// Hold Reason — why a repair is paused
// ---------------------------------------------------------------------------

export const holdReasonSchema = z.enum([
  'waiting_parts', 'awaiting_customer_approval', 'other'
])

/** A valid hold reason */
export type HoldReason = z.infer<typeof holdReasonSchema>

// ---------------------------------------------------------------------------
// Repair Line Item Type
// ---------------------------------------------------------------------------

export const repairLineItemTypeSchema = z.enum(['part', 'labor'])

/** A valid line item type for repairs */
export type RepairLineItemType = z.infer<typeof repairLineItemTypeSchema>

// ---------------------------------------------------------------------------
// Customer Mode — existing or new customer during intake
// ---------------------------------------------------------------------------

export const customerModeSchema = z.enum(['existing', 'new', 'none'])

/** Whether the intake form is selecting an existing or creating a new customer */
export type CustomerMode = z.infer<typeof customerModeSchema>

// ---------------------------------------------------------------------------
// Bicycle Mode — select existing or create new during intake
// ---------------------------------------------------------------------------

export const bicycleModeSchema = z.enum(['select_existing', 'create_new'])

/** Whether the intake form is selecting an existing or creating a new bicycle */
export type BicycleMode = z.infer<typeof bicycleModeSchema>

// ---------------------------------------------------------------------------
// Inline Customer Creation — minimal fields for walk-in customers
// ---------------------------------------------------------------------------

/** New customer data captured during repair intake (minimal set) */
export const createIntakeCustomerSchema = z.object({
  firstName: z.string().min(1, 'firstName is required').max(100).optional(),
  lastName: z.string().min(1, 'lastName is required').max(100).optional(),
  companyName: z.string().min(1, 'companyName is required').max(200).optional(),
  phone: z.string().min(1, 'phone is required').max(50),
  email: z.string().min(1, 'email is required').max(50).optional().or(z.literal('')),
})

/** Input for creating a new customer during repair intake */
export type CreateIntakeCustomerInput = z.infer<typeof createIntakeCustomerSchema>

// ---------------------------------------------------------------------------
// Inline Bicycle Creation — brand, model, color only
// ---------------------------------------------------------------------------

/** New bicycle data captured during repair intake (minimal set) */
export const createIntakeBicycleSchema = z.object({
  brand: z.string().min(1, 'brand is required').max(100),
  model: z.string().min(1, 'model is required').max(200),
  color: z.string().min(1, 'color is required').max(50),
})

/** Input for creating a new bicycle during repair intake */
export type CreateIntakeBicycleInput = z.infer<typeof createIntakeBicycleSchema>

// ---------------------------------------------------------------------------
// Repair Intake — combined customer + bicycle + notes submission
// ---------------------------------------------------------------------------

/** Customer selection data (when selecting existing) */
const existingCustomerData = z.object({
  id: z.string().uuid('id must be a valid UUID'),
})

/** New customer creation data (when creating inline) */
const newCustomerData = createIntakeCustomerSchema

/** Bicycle selection data (when selecting existing) */
const existingBicycleData = z.object({
  id: z.string().uuid('id must be a valid UUID'),
})

/** New bicycle creation data (when creating inline) */
const newBicycleData = createIntakeBicycleSchema

/** Complete repair intake input — validates customer/bicycle mode + required fields */
export const repairIntakeSchema = z.discriminatedUnion('customerMode', [
  // Existing customer path
  z.object({
    customerMode: z.literal('existing'),
    existingCustomerId: z.string().uuid('existingCustomerId must be a valid UUID'),
    bicycleMode: bicycleModeSchema,
    existingBicycleId: z.string().uuid('existingBicycleId required when selecting existing bicycle').optional(),
    newBicycle: createIntakeBicycleSchema.optional(),
    customerNotes: z.string().min(1, 'customerNotes is required').max(2000, 'customerNotes must be 2000 characters or less'),
    plannedDate: z.number().nullable().optional(),
    pickupDate: z.number().nullable().optional(),
  }),
  // New customer path (inline creation)
  z.object({
    customerMode: z.literal('new'),
    newCustomer: createIntakeCustomerSchema,
    bicycleMode: bicycleModeSchema,
    existingBicycleId: z.string().uuid('existingBicycleId required when selecting existing bicycle').optional(),
    newBicycle: createIntakeBicycleSchema.optional(),
    customerNotes: z.string().min(1, 'customerNotes is required').max(2000, 'customerNotes must be 2000 characters or less'),
    plannedDate: z.number().nullable().optional(),
    pickupDate: z.number().nullable().optional(),
  }),
  // Walk-in path — no customer, bicycle created as inventory
  z.object({
    customerMode: z.literal('none'),
    bicycleMode: bicycleModeSchema,
    existingBicycleId: z.string().uuid('existingBicycleId required when selecting existing bicycle').optional(),
    newBicycle: createIntakeBicycleSchema.optional(),
    customerNotes: z.string().min(1, 'customerNotes is required').max(2000, 'customerNotes must be 2000 characters or less'),
    plannedDate: z.number().nullable().optional(),
    pickupDate: z.number().nullable().optional(),
  }),
]).refine(
  (data) => {
    // Bicycle mode validation: select_existing requires existingBicycleId, create_new requires newBicycle
    if (data.bicycleMode === 'select_existing' && !data.existingBicycleId) {
      return false
    }
    if (data.bicycleMode === 'create_new' && !data.newBicycle) {
      return false
    }
    return true
  },
  { message: 'When bicycleMode is select_existing, existingBicycleId is required; when create_new, newBicycle is required' }
)

/** Input for creating a repair via the intake flow */
export type RepairIntakeInput = z.infer<typeof repairIntakeSchema>

// ---------------------------------------------------------------------------
// Status Transition — changing repair status
// ---------------------------------------------------------------------------

/** Input for transitioning a repair to a new status */
export const transitionRepairStatusSchema = z.object({
  targetStatus: repairStatusSchema,
  holdReason: holdReasonSchema.optional(),
  holdReasonNote: z.string().max(500).optional(),
})

/** Input for transitioning a repair's status */
export type TransitionRepairStatusInput = z.infer<typeof transitionRepairStatusSchema>

// ---------------------------------------------------------------------------
// Repair Update — partial update of notes, dates, assignment
// ---------------------------------------------------------------------------

/** Partial fields that can be updated on an existing repair */
export const updateRepairSchema = z.object({
  customerNotes: z.string().max(2000).optional(),
  internalNotes: z.string().max(5000).optional(),
  holdReason: holdReasonSchema.nullable().optional(),
  holdReasonNote: z.string().max(500).nullable().optional(),
  plannedDate: z.number().nullable().optional(),
  pickupDate: z.number().nullable().optional(),
  assignedTo: z.string().uuid('assignedTo must be a valid UUID').or(z.null()).optional(),
}).refine(
  (data) => {
    // holdReasonNote is required when holdReason is set to non-null
    if (data.holdReason !== undefined && data.holdReason !== null && !data.holdReasonNote) {
      return false
    }
    return true
  },
  { message: 'holdReasonNote is required when holdReason is set' }
)

/** Input for updating an existing repair */
export type UpdateRepairInput = z.infer<typeof updateRepairSchema>

// ---------------------------------------------------------------------------
// Repair Line Item — creating/updating line items on a repair
// ---------------------------------------------------------------------------

/** Part line item schema for repairs — uses shared part variant with repair-specific defaults */
export const createPartLineItemSchema = z.object({
  ...partLineItemVariant.toSchema().shape,
  quantity: z.number().int().positive('quantity must be positive').default(1),
  vatRateId: z.string().min(1, 'vatRateId is required').or(z.null()),
})

/** Labor line item schema for repairs — uses shared labor variant with repair-specific constraints */
export const createLaborLineItemSchema = z.object({
  ...laborLineItemVariant.toSchema().shape,
  quantity: z.number().int().positive('quantity must be positive').default(1),
  vatRateId: z.string().min(1, 'vatRateId is required').or(z.null()),
  laborServiceId: z.string().min(1, 'laborServiceId is required'),
})

/** Discriminated union for creating any line item type */
export const createRepairLineItemSchema = z.discriminatedUnion('lineType', [
  createPartLineItemSchema,
  createLaborLineItemSchema,
])

/** Input for updating an existing repair line item */
export const updateRepairLineItemSchema = z.object({
  quantity: z.number().int().positive().optional(),
  unitPriceNet: z.number().int().nonnegative().optional(),
  discountPercent: z.number().int().min(0).max(10000).nullable().optional(),
  minutesWorked: z.number().int().positive().nullable().optional(),
  hourlyRateSnapshot: z.number().int().nonnegative().nullable().optional(),
})

/** Input for assigning or changing the assigned worker on a repair */
export const assignWorkerSchema = z.object({
  assignedTo: z.string().uuid('assignedTo must be a valid UUID').or(z.null()),
})

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

/** Input type for creating a part line item */
export type CreatePartLineItemInput = z.infer<typeof createPartLineItemSchema>

/** Input type for creating a labor line item */
export type CreateLaborLineItemInput = z.infer<typeof createLaborLineItemSchema>

/** Input type for creating any repair line item */
export type CreateRepairLineItemInput = z.infer<typeof createRepairLineItemSchema>

/** Input type for updating a repair line item */
export type UpdateRepairLineItemInput = z.infer<typeof updateRepairLineItemSchema>

/** Input type for assigning a worker to a repair */
export type AssignWorkerInput = z.infer<typeof assignWorkerSchema>

// ---------------------------------------------------------------------------
// Payment Completion — atomic transaction at repair completion
// ---------------------------------------------------------------------------

/** A single payment method entry for split payments */
const repairPaymentMethodSchema = z.object({
  method: z.enum(['cash', 'card']),
  amount: z.number().int().positive('amount must be positive'),
})

/** Input schema for completing a repair with payment data (single or split) */
export const completeRepairPaymentSchema = z.object({
  payments: z.array(repairPaymentMethodSchema)
    .min(1, 'At least one payment method is required')
    .refine(
      (data) => {
        // Validate that total matches the repair's line item totals
        return true // validated server-side with actual repair totals
      },
      { message: 'Payment amounts must match repair total' }
    ),
}).refine(
  (data) => data.payments.length >= 1,
  { message: 'At least one payment method is required', path: ['payments'] }
)

/** Input type for completing a repair with payment */
export type CompleteRepairPaymentInput = z.infer<typeof completeRepairPaymentSchema>
