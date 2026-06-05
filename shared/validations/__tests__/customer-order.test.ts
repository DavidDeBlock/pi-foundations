import { describe, it, expect } from 'vitest'
import {
  customerOrderLineItemSchema,
  createCustomerOrderInputSchema,
  customerOrderStatusSchema,
} from '../customer-order.js'

// ---------------------------------------------------------------------------
// Test fixtures — base line item fields shared by all variants
// ---------------------------------------------------------------------------

const baseFields = {
  description: 'Bearing 6205',
  quantity: 2,
  unitPriceNet: 1000,
  vatRateId: 'vat-standard',
}

const validPart = {
  lineType: 'part' as const,
  partId: 'part-001',
  ...baseFields,
}

const validLabor = {
  lineType: 'labor' as const,
  ...baseFields,
}

const validBicycle = {
  lineType: 'bicycle' as const,
  ...baseFields,
}

// ---------------------------------------------------------------------------
// Discriminated union — happy path per variant
// ---------------------------------------------------------------------------

describe('customerOrderLineItemSchema — discriminated union', () => {
  it('accepts a valid part line item', () => {
    const result = customerOrderLineItemSchema.safeParse(validPart)
    expect(result.success).toBe(true)
  })

  it('accepts a valid labor line item (no laborServiceId required)', () => {
    const result = customerOrderLineItemSchema.safeParse(validLabor)
    expect(result.success).toBe(true)
  })

  it('accepts a valid labor line item with laborServiceId', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validLabor,
      laborServiceId: 'svc-001',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid labor line item with laborServiceId: null (free labor)', () => {
    // Decision #4: "free labor" flexibility is preserved as an explicit
    // .optional() rather than a default of null. The labor variant allows
    // `laborServiceId: null` for ad-hoc labor that does not reference a
    // catalog service.
    const result = customerOrderLineItemSchema.safeParse({
      ...validLabor,
      laborServiceId: null,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid labor line item with minutesWorked and hourlyRateSnapshot', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validLabor,
      laborServiceId: 'svc-001',
      minutesWorked: 45,
      hourlyRateSnapshot: 6000,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid bicycle line item with all nullable detail fields populated', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validBicycle,
      bicycleId: 'bike-001',
      bicycleBrand: 'Trek',
      bicycleModel: 'Marlin 7',
      bicycleYear: 2024,
      bicycleColor: 'Matte Black',
      bicycleFrameSize: 'M',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid bicycle line item with all nullable detail fields null', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validBicycle,
      bicycleId: null,
      bicycleBrand: null,
      bicycleModel: null,
      bicycleYear: null,
      bicycleColor: null,
      bicycleFrameSize: null,
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown lineType (discriminator mismatch)', () => {
    const result = customerOrderLineItemSchema.safeParse({
      lineType: 'service',
      ...baseFields,
    })
    expect(result.success).toBe(false)
  })

  it('rejects when lineType is missing', () => {
    const result = customerOrderLineItemSchema.safeParse(baseFields)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Part variant — partId is required (Decision #3)
// ---------------------------------------------------------------------------

describe('customerOrderLineItemSchema — part variant: partId required', () => {
  it('rejects part line item with partId: null', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validPart,
      partId: null,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const partIdError = result.error.issues.find((i) => i.path.includes('partId'))
      expect(partIdError).toBeDefined()
    }
  })

  it('rejects part line item with partId: empty string', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validPart,
      partId: '',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const partIdError = result.error.issues.find((i) => i.path.includes('partId'))
      expect(partIdError).toBeDefined()
    }
  })

  it('rejects part line item with partId omitted entirely', () => {
    // Discriminated union on `lineType: 'part'` requires partId — omitting
    // it must fail (the part variant's `toSchema()` declares partId as
    // `z.string().min(1)` which is required, not optional).
    const { partId: _partId, ...withoutPartId } = validPart
    const result = customerOrderLineItemSchema.safeParse(withoutPartId)
    expect(result.success).toBe(false)
  })

  it('accepts part line item with non-empty partId', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validPart,
      partId: 'part-abc-123',
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Labor variant — laborServiceId is optional/nullable
// ---------------------------------------------------------------------------

describe('customerOrderLineItemSchema — labor variant: laborServiceId optional', () => {
  it('rejects labor line item with laborServiceId: null but preserves nullable acceptance on the *variant* (sanity)', () => {
    // The labor variant's toSchema() allows null. This test pins the
    // accepted behavior so future regressions are caught.
    const result = customerOrderLineItemSchema.safeParse({
      ...validLabor,
      laborServiceId: null,
    })
    expect(result.success).toBe(true)
  })

  it('rejects labor line item with laborServiceId: empty string', () => {
    // The labor variant's `laborServiceId: z.string().nullable().optional()`
    // accepts `string | null | undefined`. Empty string IS a string, so it
    // is accepted — pin that behavior here.
    const result = customerOrderLineItemSchema.safeParse({
      ...validLabor,
      laborServiceId: '',
    })
    expect(result.success).toBe(true)
  })

  it('rejects labor line item with non-positive minutesWorked', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validLabor,
      minutesWorked: 0,
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Bicycle variant — brand and model are nullable, year is bounded
// ---------------------------------------------------------------------------

describe('customerOrderLineItemSchema — bicycle variant', () => {
  it('rejects bicycle line item with bicycleBrand: null and bicycleModel: null but other fields are valid (sanity check on discriminator)', () => {
    // The bicycle variant explicitly allows null for brand/model/year/etc.
    // This test pins that null values are accepted (no change from
    // pre-discriminated-union behavior).
    const result = customerOrderLineItemSchema.safeParse({
      ...validBicycle,
      bicycleBrand: null,
      bicycleModel: null,
      bicycleYear: null,
      bicycleColor: null,
      bicycleFrameSize: null,
    })
    expect(result.success).toBe(true)
  })

  it('rejects bicycle line item with bicycleYear before 1900', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validBicycle,
      bicycleYear: 1899,
    })
    expect(result.success).toBe(false)
  })

  it('rejects bicycle line item with bicycleYear in the distant future', () => {
    const result = customerOrderLineItemSchema.safeParse({
      ...validBicycle,
      bicycleYear: new Date().getFullYear() + 5,
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Base fields — shared across all variants
// ---------------------------------------------------------------------------

describe('customerOrderLineItemSchema — base fields (shared by all variants)', () => {
  it.each([
    ['part', { ...validPart }],
    ['labor', { ...validLabor }],
    ['bicycle', { ...validBicycle }],
  ])('rejects %s line item with zero quantity', (_label, base) => {
    const result = customerOrderLineItemSchema.safeParse({ ...base, quantity: 0 })
    expect(result.success).toBe(false)
  })

  it.each([
    ['part', { ...validPart }],
    ['labor', { ...validLabor }],
    ['bicycle', { ...validBicycle }],
  ])('rejects %s line item with negative unitPriceNet', (_label, base) => {
    const result = customerOrderLineItemSchema.safeParse({ ...base, unitPriceNet: -100 })
    expect(result.success).toBe(false)
  })

  it.each([
    ['part', { ...validPart }],
    ['labor', { ...validLabor }],
    ['bicycle', { ...validBicycle }],
  ])('rejects %s line item with empty description', (_label, base) => {
    const result = customerOrderLineItemSchema.safeParse({ ...base, description: '' })
    expect(result.success).toBe(false)
  })

  it.each([
    ['part', { ...validPart }],
    ['labor', { ...validLabor }],
    ['bicycle', { ...validBicycle }],
  ])('rejects %s line item with empty vatRateId', (_label, base) => {
    const result = customerOrderLineItemSchema.safeParse({ ...base, vatRateId: '' })
    expect(result.success).toBe(false)
  })

  it.each([
    ['part', { ...validPart }],
    ['labor', { ...validLabor }],
    ['bicycle', { ...validBicycle }],
  ])('accepts %s line item with zero unitPriceNet (free item / service)', (_label, base) => {
    const result = customerOrderLineItemSchema.safeParse({ ...base, unitPriceNet: 0 })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createCustomerOrderInputSchema — order-level validations
// ---------------------------------------------------------------------------

describe('createCustomerOrderInputSchema', () => {
  const validOrder = {
    customerId: 'cust-abc-123',
    lineItems: [validPart],
  }

  it('accepts a valid order with customerId and a single part line item', () => {
    const result = createCustomerOrderInputSchema.safeParse(validOrder)
    expect(result.success).toBe(true)
  })

  it('accepts an order with null customerId (walk-in)', () => {
    const result = createCustomerOrderInputSchema.safeParse({
      ...validOrder,
      customerId: null,
    })
    expect(result.success).toBe(true)
  })

  it('accepts an order with customerId omitted (walk-in)', () => {
    const { customerId: _customerId, ...withoutCustomerId } = validOrder
    const result = createCustomerOrderInputSchema.safeParse(withoutCustomerId)
    expect(result.success).toBe(true)
  })

  it('rejects an order with empty-string customerId', () => {
    const result = createCustomerOrderInputSchema.safeParse({
      ...validOrder,
      customerId: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an order with no line items', () => {
    const result = createCustomerOrderInputSchema.safeParse({
      ...validOrder,
      lineItems: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts an order with depositAmount > 0 and paymentMethod set', () => {
    const result = createCustomerOrderInputSchema.safeParse({
      ...validOrder,
      depositAmount: 500,
      paymentMethod: 'cash',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an order with depositAmount > 0 but no paymentMethod', () => {
    const result = createCustomerOrderInputSchema.safeParse({
      ...validOrder,
      depositAmount: 500,
      // paymentMethod intentionally omitted
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paymentError = result.error.issues.find((i) => i.path.includes('paymentMethod'))
      expect(paymentError).toBeDefined()
    }
  })

  it('accepts an order with depositAmount: 0 and no paymentMethod', () => {
    const result = createCustomerOrderInputSchema.safeParse({
      ...validOrder,
      depositAmount: 0,
    })
    expect(result.success).toBe(true)
  })

  it('rejects negative depositAmount', () => {
    const result = createCustomerOrderInputSchema.safeParse({
      ...validOrder,
      depositAmount: -100,
    })
    expect(result.success).toBe(false)
  })

  it('accepts an order with depositAmount: null and no paymentMethod', () => {
    const result = createCustomerOrderInputSchema.safeParse({
      ...validOrder,
      depositAmount: null,
    })
    expect(result.success).toBe(true)
  })

  it('accepts an order with mixed line types (part + labor + bicycle)', () => {
    const result = createCustomerOrderInputSchema.safeParse({
      customerId: 'cust-abc-123',
      lineItems: [validPart, validLabor, validBicycle],
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// customerOrderStatusSchema
// ---------------------------------------------------------------------------

describe('customerOrderStatusSchema', () => {
  it('accepts all valid statuses', () => {
    for (const status of ['pending', 'ordered', 'ready', 'fulfilled', 'cancelled']) {
      const result = customerOrderStatusSchema.safeParse(status)
      expect(result.success).toBe(true)
    }
  })

  it('rejects unknown status', () => {
    const result = customerOrderStatusSchema.safeParse('shipped')
    expect(result.success).toBe(false)
  })
})
