import { describe, it, expect } from 'vitest'
import {
  paymentMethodSchema,
  cartLineItemSchema,
  createDirectSaleInputSchema,
} from './sales.js'

// ── Payment Method ────────────────────────────────────────────────

describe('paymentMethodSchema', () => {
  it('accepts "cash"', () => {
    const result = paymentMethodSchema.safeParse('cash')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe('cash')
  })

  it('accepts "card"', () => {
    const result = paymentMethodSchema.safeParse('card')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe('card')
  })

  it('rejects invalid payment method', () => {
    const result = paymentMethodSchema.safeParse('bank_transfer')
    expect(result.success).toBe(false)
  })

  it('rejects empty string', () => {
    const result = paymentMethodSchema.safeParse('')
    expect(result.success).toBe(false)
  })

  it('rejects null', () => {
    const result = paymentMethodSchema.safeParse(null as unknown as 'cash' | 'card')
    expect(result.success).toBe(false)
  })
})

// ── Cart Line Item (discriminated union: part / labor / bicycle) ──

describe('cartLineItemSchema', () => {
  const validPart = {
    lineType: 'part' as const,
    partId: 'part-001',
    quantity: 2,
    unitPriceNet: 5000, // 50.00 in cents
    vatRateId: 'vat-standard',
    description: 'Bolt M6 x 20mm',
  }

  const validLabor = {
    lineType: 'labor' as const,
    quantity: 1,
    unitPriceNet: 7500,
    vatRateId: 'vat-standard',
    description: 'Brake adjustment',
  }

  const validBicycle = {
    lineType: 'bicycle' as const,
    quantity: 1,
    unitPriceNet: 85000,
    vatRateId: 'vat-standard',
    description: 'Trek Marlin 7',
  }

  // ── Part variant acceptance ────────────────────────────────────────

  it('accepts a valid part line item with all fields', () => {
    const result = cartLineItemSchema.safeParse(validPart)
    expect(result.success).toBe(true)
  })

  it('accepts a valid part without optional discountPercent', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, discountPercent: undefined })
    expect(result.success).toBe(true)
  })

  it('accepts a valid part with null discountPercent (no discount)', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, discountPercent: null })
    expect(result.success).toBe(true)
  })

  it('accepts a valid part with positive discountPercent', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, discountPercent: 10 })
    expect(result.success).toBe(true)
  })

  // ── Labor variant acceptance ────────────────────────────────────────

  it('accepts a valid labor line item with only required fields', () => {
    const result = cartLineItemSchema.safeParse(validLabor)
    expect(result.success).toBe(true)
  })

  it('accepts labor with laborServiceId', () => {
    const result = cartLineItemSchema.safeParse({ ...validLabor, laborServiceId: 'svc-001' })
    expect(result.success).toBe(true)
  })

  it('accepts labor with minutesWorked and hourlyRateSnapshot', () => {
    const result = cartLineItemSchema.safeParse({
      ...validLabor,
      minutesWorked: 45,
      hourlyRateSnapshot: 6000,
    })
    expect(result.success).toBe(true)
  })

  // ── Bicycle variant acceptance ────────────────────────────────────────

  it('accepts a valid bicycle line item with only required fields', () => {
    const result = cartLineItemSchema.safeParse(validBicycle)
    expect(result.success).toBe(true)
  })

  it('accepts bicycle with all detail fields populated', () => {
    const result = cartLineItemSchema.safeParse({
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

  // ── Rejection cases (shared across types) ────────────────────────

  it('rejects missing lineType discriminator', () => {
    const result = cartLineItemSchema.safeParse({
      partId: 'part-001',
      quantity: 2,
      unitPriceNet: 5000,
      vatRateId: 'vat-standard',
      description: 'Bolt M6 x 20mm',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid lineType discriminator', () => {
    const result = cartLineItemSchema.safeParse({
      lineType: 'service' as const,
      quantity: 1,
      unitPriceNet: 5000,
      vatRateId: 'vat-standard',
      description: 'Test',
    })
    expect(result.success).toBe(false)
  })

  it('rejects part with missing partId', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, partId: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('rejects negative quantity', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, quantity: -1 })
    expect(result.success).toBe(false)
  })

  it('rejects zero quantity', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, quantity: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer quantity (float)', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, quantity: 1.5 })
    expect(result.success).toBe(false)
  })

  it('rejects negative unitPriceNet', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, unitPriceNet: -100 })
    expect(result.success).toBe(false)
  })

  it('accepts zero unitPriceNet (free item)', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, unitPriceNet: 0 })
    expect(result.success).toBe(true)
  })

  it('rejects non-integer unitPriceNet', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, unitPriceNet: 123.45 })
    expect(result.success).toBe(false)
  })

  it('rejects missing vatRateId', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, vatRateId: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('rejects missing description', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, description: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('rejects description exceeding max length (501 chars)', () => {
    const longDesc = 'x'.repeat(501)
    const result = cartLineItemSchema.safeParse({ ...validPart, description: longDesc })
    expect(result.success).toBe(false)
  })

  it('accepts description at max length (500 chars)', () => {
    const maxDesc = 'x'.repeat(500)
    const result = cartLineItemSchema.safeParse({ ...validPart, description: maxDesc })
    expect(result.success).toBe(true)
  })

  it('rejects negative discountPercent', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, discountPercent: -5 as unknown as number })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer discountPercent', () => {
    const result = cartLineItemSchema.safeParse({ ...validPart, discountPercent: 10.5 })
    expect(result.success).toBe(false)
  })
})

// ── Create Direct Sale Input ──────────────────────────────────────

describe('createDirectSaleInputSchema', () => {
  const baseValid = {
    lineItems: [
      {
        lineType: 'part' as const,
        partId: 'part-001',
        quantity: 2,
        unitPriceNet: 5000,
        vatRateId: 'vat-standard',
        description: 'Bolt M6 x 20mm',
      },
    ],
    paymentMethod: 'cash' as const,
  }

  it('accepts valid input with cash payment and no customerId (walk-in)', () => {
    const result = createDirectSaleInputSchema.safeParse(baseValid)
    expect(result.success).toBe(true)
  })

  it('accepts valid input with card payment', () => {
    const result = createDirectSaleInputSchema.safeParse({ ...baseValid, paymentMethod: 'card' })
    expect(result.success).toBe(true)
  })

  it('accepts valid input with customerId set', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      customerId: 'cust-123',
    })
    expect(result.success).toBe(true)
  })

  it('accepts valid input with null customerId (explicit walk-in)', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      customerId: null,
    })
    expect(result.success).toBe(true)
  })

  // ── Labor-only sale acceptance ────────────────────────────────────────

  it('accepts labor-only line items', () => {
    const result = createDirectSaleInputSchema.safeParse({
      paymentMethod: 'cash',
      lineItems: [
        {
          lineType: 'labor' as const,
          description: 'Brake adjustment',
          quantity: 1,
          unitPriceNet: 7500,
          vatRateId: 'vat-standard',
          minutesWorked: 45,
          hourlyRateSnapshot: 6000,
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  // ── Bicycle-only sale acceptance ────────────────────────────────────────

  it('accepts bicycle-only line items', () => {
    const result = createDirectSaleInputSchema.safeParse({
      paymentMethod: 'card',
      lineItems: [
        {
          lineType: 'bicycle' as const,
          description: 'Trek Marlin 7',
          quantity: 1,
          unitPriceNet: 85000,
          vatRateId: 'vat-standard',
          bicycleBrand: 'Trek',
          bicycleModel: 'Marlin 7',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  // ── Mixed-type cart acceptance ────────────────────────────────────────

  it('accepts mixed part + labor + bicycle line items', () => {
    const result = createDirectSaleInputSchema.safeParse({
      paymentMethod: 'cash',
      lineItems: [
        {
          lineType: 'part' as const,
          partId: 'part-001',
          quantity: 2,
          unitPriceNet: 5000,
          vatRateId: 'vat-standard',
          description: 'Bolt M6 x 20mm',
        },
        {
          lineType: 'labor' as const,
          description: 'Brake adjustment',
          quantity: 1,
          unitPriceNet: 7500,
          vatRateId: 'vat-standard',
          minutesWorked: 30,
          hourlyRateSnapshot: 6000,
        },
        {
          lineType: 'bicycle' as const,
          description: 'Trek Marlin 7',
          quantity: 1,
          unitPriceNet: 85000,
          vatRateId: 'vat-standard',
          bicycleBrand: 'Trek',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  // ── Rejection cases ────────────────────────────────────────────

  it('rejects empty lineItems array', () => {
    const result = createDirectSaleInputSchema.safeParse({ ...baseValid, lineItems: [] })
    expect(result.success).toBe(false)
  })

  it('rejects missing paymentMethod', () => {
    const result = createDirectSaleInputSchema.safeParse({
      lineItems: [
        {
          lineType: 'part' as const,
          partId: 'part-001',
          quantity: 2,
          unitPriceNet: 5000,
          vatRateId: 'vat-standard',
          description: 'Bolt M6 x 20mm',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid payment method', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      paymentMethod: 'bitcoin' as 'cash' | 'card',
    })
    expect(result.success).toBe(false)
  })

  it('rejects line item with negative quantity', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      lineItems: [
        {
          lineType: 'part' as const,
          partId: 'part-001',
          quantity: -1,
          unitPriceNet: 5000,
          vatRateId: 'vat-standard',
          description: 'Bolt M6 x 20mm',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects line item with missing partId (part type)', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      lineItems: [
        {
          lineType: 'part' as const,
          partId: '',
          quantity: 1,
          unitPriceNet: 5000,
          vatRateId: 'vat-standard',
          description: 'Bolt M6 x 20mm',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects line item with negative unitPriceNet', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      lineItems: [
        {
          lineType: 'part' as const,
          partId: 'part-001',
          quantity: 1,
          unitPriceNet: -100,
          vatRateId: 'vat-standard',
          description: 'Bolt M6 x 20mm',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects line item with missing vatRateId', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      lineItems: [
        {
          lineType: 'part' as const,
          partId: 'part-001',
          quantity: 1,
          unitPriceNet: 5000,
          vatRateId: '',
          description: 'Bolt M6 x 20mm',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects line item with missing description', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      lineItems: [
        {
          lineType: 'part' as const,
          partId: 'part-001',
          quantity: 1,
          unitPriceNet: 5000,
          vatRateId: 'vat-standard',
          description: '',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects completely empty object', () => {
    const result = createDirectSaleInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects non-array lineItems', () => {
    const result = createDirectSaleInputSchema.safeParse(
      { ...baseValid, lineItems: 'not-an-array' as unknown as Array<unknown> },
    )
    expect(result.success).toBe(false)
  })

  it('accepts multiple valid part line items', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      lineItems: [
        {
          lineType: 'part' as const,
          partId: 'part-001',
          quantity: 2,
          unitPriceNet: 5000,
          vatRateId: 'vat-standard',
          description: 'Bolt M6 x 20mm',
        },
        {
          lineType: 'part' as const,
          partId: 'part-002',
          quantity: 1,
          unitPriceNet: 15000,
          vatRateId: 'vat-reduced',
          description: 'Wrench Set',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts line item with discountPercent included', () => {
    const result = createDirectSaleInputSchema.safeParse({
      ...baseValid,
      lineItems: [
        {
          lineType: 'part' as const,
          partId: 'part-001',
          quantity: 2,
          unitPriceNet: 5000,
          vatRateId: 'vat-standard',
          description: 'Bolt M6 x 20mm',
          discountPercent: 10,
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})
