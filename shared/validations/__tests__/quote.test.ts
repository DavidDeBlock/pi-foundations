import { describe, it, expect } from 'vitest'
import {
  createQuoteSchema,
  updateQuoteSchema,
  createQuoteLineItemSchema,
  updateQuoteLineItemSchema,
  quoteStatusSchema,
  quoteLineItemTypeSchema,
} from '../quote.js'

// ---------------------------------------------------------------------------
// Quote Status
// ---------------------------------------------------------------------------

describe('quoteStatusSchema', () => {
  it('should accept all valid statuses', () => {
    for (const status of ['draft', 'sent', 'converted', 'rejected']) {
      const result = quoteStatusSchema.safeParse(status)
      expect(result.success).toBe(true)
    }
  })

  it('should reject invalid status', () => {
    const result = quoteStatusSchema.safeParse('cancelled')
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Line Item Type
// ---------------------------------------------------------------------------

describe('quoteLineItemTypeSchema', () => {
  it('should accept part, labor, and bicycle types', () => {
    for (const type of ['part', 'labor', 'bicycle']) {
      const result = quoteLineItemTypeSchema.safeParse(type)
      expect(result.success).toBe(true)
    }
  })

  it('should reject invalid line item type', () => {
    const result = quoteLineItemTypeSchema.safeParse('service')
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Create Quote Schema
// ---------------------------------------------------------------------------

describe('createQuoteSchema', () => {
  it('should accept valid input with customerId and notes', () => {
    const result = createQuoteSchema.safeParse({
      customerId: '550e8400-e29b-41d4-a716-446655440000',
      notes: 'Customer requested expedited delivery',
    })
    expect(result.success).toBe(true)
  })

  it('should accept input with only customerId', () => {
    const result = createQuoteSchema.safeParse({
      customerId: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(true)
  })

  it('should accept input with only notes', () => {
    const result = createQuoteSchema.safeParse({
      notes: 'Internal note',
    })
    expect(result.success).toBe(true)
  })

  it('should accept empty object (all fields optional)', () => {
    const result = createQuoteSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should accept null values', () => {
    const result = createQuoteSchema.safeParse({
      customerId: null,
      notes: null,
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid UUID for customerId', () => {
    const result = createQuoteSchema.safeParse({
      customerId: 'not-a-uuid',
    })
    expect(result.success).toBe(false)
  })

  it('should reject notes exceeding max length', () => {
    const longNotes = 'a'.repeat(2001)
    const result = createQuoteSchema.safeParse({
      notes: longNotes,
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Update Quote Schema
// ---------------------------------------------------------------------------

describe('updateQuoteSchema', () => {
  it('should accept valid update with customerId', () => {
    const result = updateQuoteSchema.safeParse({
      customerId: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(true)
  })

  it('should accept valid update with notes only', () => {
    const result = updateQuoteSchema.safeParse({
      notes: 'Updated note',
    })
    expect(result.success).toBe(true)
  })

  it('should accept empty object for partial updates', () => {
    const result = updateQuoteSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Create Quote Line Item Schema — Part type
// ---------------------------------------------------------------------------

describe('createQuoteLineItemSchema — part type', () => {
  it('should accept valid part line item with all fields', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'part',
      partId: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Bearing 6205',
      quantity: 2,
      unitPriceNet: 1000,
      vatRateId: 'vat-standard',
      discountPercent: null,
    })
    expect(result.success).toBe(true)
  })

  it('should accept part line item without optional fields', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'part',
      description: 'Chain Ring',
      quantity: 1,
      unitPriceNet: 3000,
      vatRateId: 'vat-reduced',
    })
    expect(result.success).toBe(true)
  })

  it('should accept part line item with discount (500 = 5%)', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'part',
      description: 'Premium Bearing',
      quantity: 4,
      unitPriceNet: 2500,
      vatRateId: 'vat-standard',
      discountPercent: 500,
    })
    expect(result.success).toBe(true)
  })

  it('should reject part line item missing description', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'part',
      quantity: 1,
      unitPriceNet: 1000,
      vatRateId: 'vat-standard',
    })
    expect(result.success).toBe(false)
  })

  it('should reject part line item with zero quantity', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'part',
      description: 'Bearing',
      quantity: 0,
      unitPriceNet: 1000,
      vatRateId: 'vat-standard',
    })
    expect(result.success).toBe(false)
  })

  it('should reject part line item with negative unit price', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'part',
      description: 'Bearing',
      quantity: 1,
      unitPriceNet: -100,
      vatRateId: 'vat-standard',
    })
    expect(result.success).toBe(false)
  })

  it('should reject part line item with discount exceeding 100%', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'part',
      description: 'Bearing',
      quantity: 1,
      unitPriceNet: 1000,
      vatRateId: 'vat-standard',
      discountPercent: 10001,
    })
    expect(result.success).toBe(false)
  })


})

// ---------------------------------------------------------------------------
// Create Quote Line Item Schema — Labor type
// ---------------------------------------------------------------------------

describe('createQuoteLineItemSchema — labor type', () => {
  it('should accept valid labor line item with all fields', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'labor',
      laborServiceId: '550e8400-e29b-41d4-a716-446655440001',
      description: 'Full service overhaul',
      quantity: 1,
      unitPriceNet: 7500,
      vatRateId: 'vat-standard',
    })
    expect(result.success).toBe(true)
  })

  it('should accept labor line item without optional fields', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'labor',
      description: 'Tune-up',
      quantity: 1,
      unitPriceNet: 4500,
      vatRateId: 'vat-standard',
    })
    expect(result.success).toBe(true)
  })


})

// ---------------------------------------------------------------------------
// Create Quote Line Item Schema — Bicycle type
// ---------------------------------------------------------------------------

describe('createQuoteLineItemSchema — bicycle type', () => {
  it('should accept valid bicycle line item with all fields', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'bicycle',
      bicycleId: '550e8400-e29b-41d4-a716-446655440002',
      description: 'Trek Marlin 7',
      quantity: 1,
      unitPriceNet: 85000,
      vatRateId: 'vat-standard',
      bicycleBrand: 'Trek',
      bicycleModel: 'Marlin 7',
      bicycleYear: 2024,
      bicycleColor: 'Matte Black',
      bicycleFrameSize: 'M',
    })
    expect(result.success).toBe(true)
  })

  it('should accept bicycle line item without optional fields', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'bicycle',
      description: 'Used bike sale',
      quantity: 1,
      unitPriceNet: 45000,
      vatRateId: 'vat-standard',
    })
    expect(result.success).toBe(true)
  })

  it('should reject bicycle line item with future year', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'bicycle',
      description: 'Future bike',
      quantity: 1,
      unitPriceNet: 90000,
      vatRateId: 'vat-standard',
      bicycleYear: new Date().getFullYear() + 5,
    })
    expect(result.success).toBe(false)
  })

  it('should reject bicycle line item with year before 1900', () => {
    const result = createQuoteLineItemSchema.safeParse({
      lineType: 'bicycle',
      description: 'Old bike',
      quantity: 1,
      unitPriceNet: 5000,
      vatRateId: 'vat-standard',
      bicycleYear: 1899,
    })
    expect(result.success).toBe(false)
  })


})

// ---------------------------------------------------------------------------
// Update Quote Line Item Schema — Part type
// ---------------------------------------------------------------------------

describe('updateQuoteLineItemSchema — part type', () => {
  it('should accept valid partial update for part line item', () => {
    const result = updateQuoteLineItemSchema.safeParse({
      lineType: 'part',
      description: 'Updated bearing description',
      quantity: 3,
    })
    expect(result.success).toBe(true)
  })

  it('should accept part line item with discountPercent set to null (remove discount)', () => {
    const result = updateQuoteLineItemSchema.safeParse({
      lineType: 'part',
      discountPercent: null,
    })
    expect(result.success).toBe(true)
  })

  it('should accept part line item with new discount value', () => {
    const result = updateQuoteLineItemSchema.safeParse({
      lineType: 'part',
      discountPercent: 1000, // 10%
    })
    expect(result.success).toBe(true)
  })

  it('should reject part line item with invalid quantity (zero)', () => {
    const result = updateQuoteLineItemSchema.safeParse({
      lineType: 'part',
      quantity: 0,
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Update Quote Line Item Schema — Labor type
// ---------------------------------------------------------------------------

describe('updateQuoteLineItemSchema — labor type', () => {
  it('should accept valid partial update for labor line item', () => {
    const result = updateQuoteLineItemSchema.safeParse({
      lineType: 'labor',
      unitPriceNet: 8000,
    })
    expect(result.success).toBe(true)
  })

  it('should accept labor line item with new laborServiceId', () => {
    const result = updateQuoteLineItemSchema.safeParse({
      lineType: 'labor',
      laborServiceId: '550e8400-e29b-41d4-a716-446655440003',
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Update Quote Line Item Schema — Bicycle type
// ---------------------------------------------------------------------------

describe('updateQuoteLineItemSchema — bicycle type', () => {
  it('should accept valid partial update for bicycle line item', () => {
    const result = updateQuoteLineItemSchema.safeParse({
      lineType: 'bicycle',
      description: 'Updated bike description',
      unitPriceNet: 90000,
    })
    expect(result.success).toBe(true)
  })

  it('should accept bicycle line item with updated brand/model', () => {
    const result = updateQuoteLineItemSchema.safeParse({
      lineType: 'bicycle',
      bicycleBrand: 'Specialized',
      bicycleModel: 'Allez',
    })
    expect(result.success).toBe(true)
  })


})
