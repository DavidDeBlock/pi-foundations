import { z } from 'zod'
import {
  partLineItemVariant,
  laborLineItemVariant,
  bicycleLineItemVariant,
} from './line-item-variants.js'

// ---------------------------------------------------------------------------
// Quote Status — lifecycle states
// ---------------------------------------------------------------------------

export const quoteStatusSchema = z.enum([
  'draft', 'sent', 'converted', 'rejected'
])

/** A valid quote status */
export type QuoteStatus = z.infer<typeof quoteStatusSchema>

// ---------------------------------------------------------------------------
// Line Item Type
// ---------------------------------------------------------------------------

export const quoteLineItemTypeSchema = z.enum(['part', 'labor', 'bicycle'])

/** A valid line item type for quotes */
export type QuoteLineItemType = z.infer<typeof quoteLineItemTypeSchema>

// ---------------------------------------------------------------------------
// Create Quote Input
// ---------------------------------------------------------------------------

export const createQuoteSchema = z.object({
  customerId: z.string().uuid('customerId must be a valid UUID').optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

/** Input for creating a new quote */
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>

// ---------------------------------------------------------------------------
// Update Quote Input — draft fields only
// ---------------------------------------------------------------------------

export const updateQuoteSchema = z.object({
  customerId: z.string().uuid('customerId must be a valid UUID').optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

/** Input for updating an existing quote (draft fields only) */
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>

// ---------------------------------------------------------------------------
// Create Quote Line Item — composed from shared variants
// ---------------------------------------------------------------------------

/** Part line item schema for quotes — allows nullable partId for ad-hoc items */
export const createQuoteLineItemPartSchema = z.object({
  ...partLineItemVariant.toSchema().shape,
  partId: z.string().uuid('partId must be a valid UUID').optional().nullable(),
})

/** Labor line item schema for quotes — uses shared labor variant */
export const createQuoteLineItemLaborSchema = laborLineItemVariant.toSchema()

/** Bicycle line item schema for quotes — uses shared bicycle variant */
export const createQuoteLineItemBicycleSchema = bicycleLineItemVariant.toSchema()

/** Discriminated union for creating a quote line item */
export const createQuoteLineItemSchema = z.discriminatedUnion('lineType', [
  createQuoteLineItemPartSchema,
  createQuoteLineItemLaborSchema,
  createQuoteLineItemBicycleSchema,
])

/** Input for creating a new quote line item */
export type CreateQuoteLineItemInput = z.infer<typeof createQuoteLineItemSchema>

// ---------------------------------------------------------------------------
// Update Quote Line Item — composed from shared variants (partial fields)
// ---------------------------------------------------------------------------

const baseUpdateLineItemFields = {
  description: z.string().min(1, 'description is required').max(500).optional(),
  quantity: z.number().int().positive('quantity must be a positive integer').optional(),
  unitPriceNet: z.number().int().nonnegative('unitPriceNet must be a non-negative integer (cents)').optional(),
  vatRateId: z.string().min(1, 'vatRateId is required').max(50).optional(),
  discountPercent: z.number().int().min(0).max(10000).nullable().optional(), // basis points
}

export const updateQuoteLineItemPartSchema = z.object({
  ...baseUpdateLineItemFields,
  lineType: z.literal('part'),
  partId: z.string().uuid('partId must be a valid UUID').optional().nullable(),
})

export const updateQuoteLineItemLaborSchema = z.object({
  ...baseUpdateLineItemFields,
  lineType: z.literal('labor'),
  laborServiceId: z.string().uuid('laborServiceId must be a valid UUID').optional().nullable(),
})

export const updateQuoteLineItemBicycleSchema = z.object({
  ...baseUpdateLineItemFields,
  lineType: z.literal('bicycle'),
  bicycleId: z.string().uuid('bicycleId must be a valid UUID').optional().nullable(),
  bicycleBrand: z.string().max(100).optional().nullable(),
  bicycleModel: z.string().max(200).optional().nullable(),
  bicycleYear: z.number().int().min(1900).max(new Date().getFullYear() + 1).optional().nullable(),
  bicycleColor: z.string().max(50).optional().nullable(),
  bicycleFrameSize: z.string().max(20).optional().nullable(),
})

/** Discriminated union for updating a quote line item */
export const updateQuoteLineItemSchema = z.discriminatedUnion('lineType', [
  updateQuoteLineItemPartSchema,
  updateQuoteLineItemLaborSchema,
  updateQuoteLineItemBicycleSchema,
])

/** Input for updating an existing quote line item */
export type UpdateQuoteLineItemInput = z.infer<typeof updateQuoteLineItemSchema>
