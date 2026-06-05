import { z } from 'zod'
import { paymentMethodSchema } from './sales.js'
import {
  partLineItemVariant,
  laborLineItemVariant,
  bicycleLineItemVariant,
} from './line-item-variants.js'

// ---------------------------------------------------------------------------
// Customer Order Line Item — composed from shared variant definitions
// ---------------------------------------------------------------------------

/**
 * Line item for a customer order — supports parts, labor, and bicycles.
 *
 * Built as a discriminated union over `lineType` using the shared variant
 * definitions in `./line-item-variants.js`. This enforces Decision #3
 * ("`partId` required everywhere") at the validation layer (the part
 * variant's `toSchema()` requires `partId: z.string().min(1)`), and
 * preserves Decision #4's flexibility for "free labor" via the labor
 * variant's `laborServiceId: z.string().nullable().optional()`.
 *
 * Service-layer code that previously accessed fields without narrowing
 * (see `customer-order.service.ts`) still works: Zod's discriminated union
 * produces an object whose type is the union of all variant shapes, and
 * fields that are absent on a given variant are still accessed via the
 * service's `?? null` fallback (e.g. `item.partId ?? null`).
 */
export const customerOrderLineItemSchema = z.discriminatedUnion('lineType', [
  partLineItemVariant.toSchema(),
  laborLineItemVariant.toSchema(),
  bicycleLineItemVariant.toSchema(),
])

export type CustomerOrderLineItem = z.infer<typeof customerOrderLineItemSchema>

/** Input for creating a customer order with optional deposit */
export const createCustomerOrderInputSchema = z.object({
  // nullable for walk-in orders; rejects empty string (must be valid UUID or null/undefined)
  customerId: z.string().min(1, 'customerId must not be empty').nullable().optional(),
  lineItems: z.array(customerOrderLineItemSchema).min(1, 'At least one line item is required'),
  depositAmount: z.number().int().nonnegative('depositAmount must be non-negative').nullable().optional(),
  paymentMethod: paymentMethodSchema.nullable().optional(),
  expectedDeliveryDate: z.string().datetime().nullable().optional(),
  internalNotes: z.string().max(2000).nullable().optional(),
}).refine(
  (data) => {
    // If depositAmount > 0, paymentMethod must be provided
    if ((data.depositAmount ?? 0) > 0 && !data.paymentMethod) {
      return false
    }
    return true
  },
  { message: 'paymentMethod is required when depositAmount > 0', path: ['paymentMethod'] }
)

export type CreateCustomerOrderInput = z.infer<typeof createCustomerOrderInputSchema>

/** Customer order status */
export const customerOrderStatusSchema = z.enum(['pending', 'ordered', 'ready', 'fulfilled', 'cancelled'])
export type CustomerOrderStatus = z.infer<typeof customerOrderStatusSchema>
