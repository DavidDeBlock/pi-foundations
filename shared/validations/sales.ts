import { z } from 'zod'
import { partLineItemVariant, laborLineItemVariant, bicycleLineItemVariant } from './line-item-variants.js'

/** Payment method accepted at checkout */
export const paymentMethodSchema = z.enum(['cash', 'card'])

export type PaymentMethod = z.infer<typeof paymentMethodSchema>

/** A single line item in a sale cart / creation request — discriminated union of part, labor, bicycle */
export const cartLineItemSchema = z.discriminatedUnion('lineType', [
  partLineItemVariant.toSchema(),
  laborLineItemVariant.toSchema(),
  bicycleLineItemVariant.toSchema(),
])

export type CartLineItem = z.infer<typeof cartLineItemSchema>

/** Full input for creating a direct sale at checkout */
export const createDirectSaleInputSchema = z.object({
  /** Optional customer ID — null/absent means walk-in */
  customerId: z.string().nullable().optional(),
  /** Payment method for the full amount */
  paymentMethod: paymentMethodSchema,
  /** Line items being purchased (part, labor, or bicycle) */
  lineItems: z.array(cartLineItemSchema).min(1, 'At least one line item is required'),
})

export type CreateDirectSaleInput = z.infer<typeof createDirectSaleInputSchema>
