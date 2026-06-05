import { describe, it, expect } from 'vitest'
import {
  postalCodeSearchSchema,
  streetSearchSchema,
} from '../address.js'

// ---------------------------------------------------------------------------
// Postal code search schema
// ---------------------------------------------------------------------------

describe('postalCodeSearchSchema', () => {
  it('should accept an empty object (no search param)', () => {
    const result = postalCodeSearchSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should accept a valid search string for partial postcode', () => {
    const result = postalCodeSearchSchema.safeParse({
      search: '903'
    })
    expect(result.success).toBe(true)
  })

  it('should accept a full postcode as search term', () => {
    const result = postalCodeSearchSchema.safeParse({
      search: '2018 Antwerpen'
    })
    expect(result.success).toBe(true)
  })

  it('should accept an empty string for search (let backend handle)', () => {
    const result = postalCodeSearchSchema.safeParse({
      search: ''
    })
    expect(result.success).toBe(true)
  })

  it('should accept a numeric-looking postcode as string', () => {
    const result = postalCodeSearchSchema.safeParse({
      search: '1000'
    })
    expect(result.success).toBe(true)
  })

  it('should reject non-string search value (number)', () => {
    const result = postalCodeSearchSchema.safeParse({
      search: 903
    })
    expect(result.success).toBe(false)
  })

  it('should reject non-string search value (boolean)', () => {
    const result = postalCodeSearchSchema.safeParse({
      search: true
    })
    expect(result.success).toBe(false)
  })

  it('should accept additional unknown fields without error', () => {
    const result = postalCodeSearchSchema.safeParse({
      search: '903',
      extraField: 'ignored'
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Street search schema
// ---------------------------------------------------------------------------

describe('streetSearchSchema', () => {
  it('should accept valid postalCode with optional search term', () => {
    const result = streetSearchSchema.safeParse({
      postalCode: '1000'
    })
    expect(result.success).toBe(true)
  })

  it('should accept valid postalCode with street search term', () => {
    const result = streetSearchSchema.safeParse({
      postalCode: '1000',
      search: 'Rue'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing required postalCode', () => {
    const result = streetSearchSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('should reject missing postalCode with only search term', () => {
    const result = streetSearchSchema.safeParse({
      search: 'Rue de la Loi'
    })
    expect(result.success).toBe(false)
  })

  it('should reject non-string postalCode (number)', () => {
    const result = streetSearchSchema.safeParse({
      postalCode: 1000
    })
    expect(result.success).toBe(false)
  })

  it('should accept empty string for search term', () => {
    const result = streetSearchSchema.safeParse({
      postalCode: '2000',
      search: ''
    })
    expect(result.success).toBe(true)
  })

  it('should reject non-string postalCode (boolean)', () => {
    const result = streetSearchSchema.safeParse({
      postalCode: true
    })
    expect(result.success).toBe(false)
  })

  it('should accept both postalCode and search with special characters', () => {
    const result = streetSearchSchema.safeParse({
      postalCode: 'BE-VLG',
      search: "ul. "
    })
    expect(result.success).toBe(true)
  })

  it('should accept additional unknown fields without error', () => {
    const result = streetSearchSchema.safeParse({
      postalCode: '1000',
      extraField: 'ignored'
    })
    expect(result.success).toBe(true)
  })
})
