import { z } from 'zod'

// ---------------------------------------------------------------------------
// Shared Line Item Variant Definitions
//
// Each variant is a composable building block that modules import and use to
// construct their own discriminated union schemas. This eliminates duplication
// of base fields (description, quantity, unitPriceNet, vatRateId, discountPercent)
// across repair, quote, customer-order, and sales validation schemas.
// ---------------------------------------------------------------------------

/** Base fields shared by all line item types */
const baseLineItemFields = {
  description: z.string().min(1, 'description is required').max(500),
  quantity: z.number().int().positive('quantity must be a positive integer'),
  unitPriceNet: z.number().int().nonnegative('unitPriceNet must be non-negative'),
  vatRateId: z.string().min(1, 'vatRateId is required'),
  discountPercent: z.number().int().min(0).max(10000).nullable().optional(),
}

// ---------------------------------------------------------------------------
// Part Variant
// ---------------------------------------------------------------------------

/**
 * A reusable part line item variant definition.
 * Modules compose this into their own discriminated union schemas.
 */
export const partLineItemVariant = {
  /** Discriminator value for the `lineType` field */
  lineType: 'part' as const,

  /** Build a Zod schema object for use in a discriminated union */
  toSchema() {
    return z.object({
      ...baseLineItemFields,
      lineType: z.literal('part'),
      partId: z.string().min(1, 'partId is required'),
    })
  },
}

/** Input type for a part line item */
export type PartLineItemInput = z.infer<ReturnType<typeof partLineItemVariant.toSchema>>

// ---------------------------------------------------------------------------
// Labor Variant
// ---------------------------------------------------------------------------

/**
 * A reusable labor line item variant definition.
 * Modules compose this into their own discriminated union schemas.
 * All labor-specific fields are nullable — modules may add refinements
 * to enforce stricter requirements (e.g., requiring laborServiceId).
 */
export const laborLineItemVariant = {
  /** Discriminator value for the `lineType` field */
  lineType: 'labor' as const,

  /** Build a Zod schema object for use in a discriminated union */
  toSchema() {
    return z.object({
      ...baseLineItemFields,
      lineType: z.literal('labor'),
      laborServiceId: z.string().nullable().optional(),
      minutesWorked: z.number().int().positive().nullable().optional(),
      hourlyRateSnapshot: z.number().int().nonnegative().nullable().optional(),
    })
  },
}

/** Input type for a labor line item */
export type LaborLineItemInput = z.infer<ReturnType<typeof laborLineItemVariant.toSchema>>

// ---------------------------------------------------------------------------
// Bicycle Variant
// ---------------------------------------------------------------------------

/**
 * A reusable bicycle line item variant definition.
 * Modules compose this into their own discriminated union schemas.
 * All bicycle-specific fields are nullable — modules may add refinements
 * to enforce stricter requirements as needed.
 */
export const bicycleLineItemVariant = {
  /** Discriminator value for the `lineType` field */
  lineType: 'bicycle' as const,

  /** Build a Zod schema object for use in a discriminated union */
  toSchema() {
    return z.object({
      ...baseLineItemFields,
      lineType: z.literal('bicycle'),
      bicycleId: z.string().nullable().optional(),
      bicycleBrand: z.string().max(100).nullable().optional(),
      bicycleModel: z.string().max(200).nullable().optional(),
      bicycleYear: z.number().int().min(1900).max(new Date().getFullYear() + 1).nullable().optional(),
      bicycleColor: z.string().max(50).nullable().optional(),
      bicycleFrameSize: z.string().max(20).nullable().optional(),
    })
  },
}

/** Input type for a bicycle line item */
export type BicycleLineItemInput = z.infer<ReturnType<typeof bicycleLineItemVariant.toSchema>>
