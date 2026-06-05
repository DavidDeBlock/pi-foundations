import { z } from 'zod'
import { describe, it, expect } from 'vitest'
import {
  partLineItemVariant,
  laborLineItemVariant,
  bicycleLineItemVariant,
} from '../line-item-variants.js'

// ---------------------------------------------------------------------------
// Part Variant — base fields for part-type line items
// ---------------------------------------------------------------------------

describe('partLineItemVariant', () => {
  const validPart = {
    lineType: 'part' as const,
    partId: 'part-001',
    description: 'Bearing 6205',
    quantity: 2,
    unitPriceNet: 1000,
    vatRateId: 'vat-standard',
  }

  it('accepts valid part with all required fields', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse(validPart)
    expect(result.success).toBe(true)
  })

  it('accepts part without optional discountPercent', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validPart, discountPercent: undefined })
    expect(result.success).toBe(true)
  })

  it('accepts part with null discountPercent (no discount)', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validPart, discountPercent: null })
    expect(result.success).toBe(true)
  })

  it('accepts part with positive discountPercent', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validPart, discountPercent: 500 })
    expect(result.success).toBe(true)
  })

  // ── Required field rejections ────────────────────────────────────

  it('rejects missing partId', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validPart, partId: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('rejects missing description', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validPart, description: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('rejects zero quantity', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validPart, quantity: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects negative unitPriceNet', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validPart, unitPriceNet: -100 })
    expect(result.success).toBe(false)
  })

  it('accepts zero unitPriceNet (free item)', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validPart, unitPriceNet: 0 })
    expect(result.success).toBe(true)
  })

  it('rejects missing vatRateId', () => {
    const schema = partLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validPart, vatRateId: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('has lineType discriminator set to "part"', () => {
    expect(partLineItemVariant.lineType).toBe('part')
  })
})

// ---------------------------------------------------------------------------
// Labor Variant — base fields for labor-type line items
// ---------------------------------------------------------------------------

describe('laborLineItemVariant', () => {
  const validLabor = {
    lineType: 'labor' as const,
    description: 'Brake adjustment',
    quantity: 1,
    unitPriceNet: 7500,
    vatRateId: 'vat-standard',
  }

  it('accepts valid labor with only required fields', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse(validLabor)
    expect(result.success).toBe(true)
  })

  // ── Nullable field acceptance ────────────────────────────────────

  it('accepts labor with null laborServiceId', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, laborServiceId: null })
    expect(result.success).toBe(true)
  })

  it('accepts labor with string laborServiceId', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, laborServiceId: 'svc-001' })
    expect(result.success).toBe(true)
  })

  it('accepts labor with null minutesWorked', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, minutesWorked: null })
    expect(result.success).toBe(true)
  })

  it('accepts labor with positive minutesWorked', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, minutesWorked: 45 })
    expect(result.success).toBe(true)
  })

  it('accepts labor with null hourlyRateSnapshot', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, hourlyRateSnapshot: null })
    expect(result.success).toBe(true)
  })

  it('accepts labor with positive hourlyRateSnapshot', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, hourlyRateSnapshot: 6000 })
    expect(result.success).toBe(true)
  })

  // ── Required field rejections ────────────────────────────────────

  it('rejects missing description', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, description: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('rejects zero quantity', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, quantity: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects negative unitPriceNet', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, unitPriceNet: -100 })
    expect(result.success).toBe(false)
  })

  it('accepts zero unitPriceNet (free service)', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, unitPriceNet: 0 })
    expect(result.success).toBe(true)
  })

  it('rejects missing vatRateId', () => {
    const schema = laborLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validLabor, vatRateId: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('has lineType discriminator set to "labor"', () => {
    expect(laborLineItemVariant.lineType).toBe('labor')
  })
})

// ---------------------------------------------------------------------------
// Bicycle Variant — base fields for bicycle-type line items
// ---------------------------------------------------------------------------

describe('bicycleLineItemVariant', () => {
  const validBicycle = {
    lineType: 'bicycle' as const,
    description: 'Trek Marlin 7',
    quantity: 1,
    unitPriceNet: 85000,
    vatRateId: 'vat-standard',
  }

  it('accepts valid bicycle with only required fields', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse(validBicycle)
    expect(result.success).toBe(true)
  })

  // ── Nullable field acceptance ────────────────────────────────────

  it('accepts bicycle with null bicycleId', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validBicycle, bicycleId: null })
    expect(result.success).toBe(true)
  })

  it('accepts bicycle with string bicycleId', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validBicycle, bicycleId: 'bike-001' })
    expect(result.success).toBe(true)
  })

  it('accepts bicycle with all nullable detail fields as null', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse({
      ...validBicycle,
      bicycleBrand: null,
      bicycleModel: null,
      bicycleYear: null,
      bicycleColor: null,
      bicycleFrameSize: null,
    })
    expect(result.success).toBe(true)
  })

  it('accepts bicycle with all nullable detail fields populated', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse({
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

  // ── Required field rejections ────────────────────────────────────

  it('rejects missing description', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validBicycle, description: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('rejects zero quantity', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validBicycle, quantity: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects negative unitPriceNet', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validBicycle, unitPriceNet: -100 })
    expect(result.success).toBe(false)
  })

  it('accepts zero unitPriceNet (free item)', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validBicycle, unitPriceNet: 0 })
    expect(result.success).toBe(true)
  })

  it('rejects missing vatRateId', () => {
    const schema = bicycleLineItemVariant.toSchema()
    const result = schema.safeParse({ ...validBicycle, vatRateId: '' as unknown as string })
    expect(result.success).toBe(false)
  })

  it('has lineType discriminator set to "bicycle"', () => {
    expect(bicycleLineItemVariant.lineType).toBe('bicycle')
  })
})

// ---------------------------------------------------------------------------
// Composition — building discriminated unions from variants
// ---------------------------------------------------------------------------

describe('variant composition', () => {
  it('can compose a discriminated union from all three variants', () => {
    const schema = z.discriminatedUnion('lineType', [
      partLineItemVariant.toSchema(),
      laborLineItemVariant.toSchema(),
      bicycleLineItemVariant.toSchema(),
    ])

    // Part passes through union
    expect(schema.safeParse({
      lineType: 'part' as const,
      partId: 'part-001',
      description: 'Bearing',
      quantity: 1,
      unitPriceNet: 1000,
      vatRateId: 'vat-standard',
    }).success).toBe(true)

    // Labor passes through union
    expect(schema.safeParse({
      lineType: 'labor' as const,
      description: 'Tune-up',
      quantity: 1,
      unitPriceNet: 5000,
      vatRateId: 'vat-standard',
    }).success).toBe(true)

    // Bicycle passes through union
    expect(schema.safeParse({
      lineType: 'bicycle' as const,
      description: 'Trek Marlin',
      quantity: 1,
      unitPriceNet: 85000,
      vatRateId: 'vat-standard',
    }).success).toBe(true)

    // Invalid type rejected
    expect(schema.safeParse({
      lineType: 'service' as const,
      description: 'Test',
      quantity: 1,
      unitPriceNet: 1000,
      vatRateId: 'vat-standard',
    }).success).toBe(false)
  })

  it('can compose a discriminated union from subset of variants (part + labor only)', () => {
    const schema = z.discriminatedUnion('lineType', [
      partLineItemVariant.toSchema(),
      laborLineItemVariant.toSchema(),
    ])

    // Part and labor pass
    expect(schema.safeParse({
      lineType: 'part' as const,
      partId: 'part-001',
      description: 'Bearing',
      quantity: 1,
      unitPriceNet: 1000,
      vatRateId: 'vat-standard',
    }).success).toBe(true)

    expect(schema.safeParse({
      lineType: 'labor' as const,
      description: 'Tune-up',
      quantity: 1,
      unitPriceNet: 5000,
      vatRateId: 'vat-standard',
    }).success).toBe(true)

    // Bicycle rejected (not in this union)
    expect(schema.safeParse({
      lineType: 'bicycle' as const,
      description: 'Trek Marlin',
      quantity: 1,
      unitPriceNet: 85000,
      vatRateId: 'vat-standard',
    }).success).toBe(false)
  })
})
