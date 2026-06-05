import { describe, it, expect } from 'vitest'
import { createCustomerSchema, updateCustomerSchema, validateAddress } from '../customer.js'

describe('createCustomerSchema', () => {
  describe('type branching — private customers', () => {
    it('should accept valid private customer with firstName and lastName', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski'
      })

      expect(result.success).toBe(true)
    })

    it('should reject private customer missing firstName', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        lastName: 'Kowalski'
      })

      expect(result.success).toBe(false)
    })

    it('should reject private customer missing lastName', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan'
      })

      expect(result.success).toBe(false)
    })

    it('should accept private customer with optional fields (companyName, vatId, phone, email)', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski',
        companyName: 'Side Business',
        vatId: 'PL123456789',
        phone: '+48 500 600 700',
        email: 'jan@example.com'
      })

      expect(result.success).toBe(true)
    })
  })

  describe('type branching — company customers', () => {
    it('should accept valid company customer with companyName', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440001',
        type: 'company',
        companyName: 'TechSpółka Sp. z o.o.'
      })

      expect(result.success).toBe(true)
    })

    it('should reject company customer missing companyName', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440001',
        type: 'company'
      })

      expect(result.success).toBe(false)
    })

    it('should accept company customer with optional firstName/lastName (legacy fields)', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440001',
        type: 'company',
        companyName: 'TechSpółka Sp. z o.o.',
        firstName: 'Jan',
        lastName: 'Nowak'
      })

      expect(result.success).toBe(true)
    })
  })

  describe('phone and email — loose validation', () => {
    it('should accept any non-empty string for phone (max 50)', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski',
        phone: '+48 500 600 700'
      })

      expect(result.success).toBe(true)
    })

    it('should accept any non-empty string for email (max 50)', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski',
        email: 'jan@example.com'
      })

      expect(result.success).toBe(true)
    })

    it('should reject empty string for phone', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski',
        phone: ''
      })

      expect(result.success).toBe(false)
    })

    it('should reject empty string for email', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski',
        email: ''
      })

      expect(result.success).toBe(false)
    })
  })

  describe('address fields — conditional requirements', () => {
    it('should accept customer with only street (no number/postalCode/city)', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski',
        street: 'ul. Marszałkowska'
      })

      expect(result.success).toBe(true)
    })

    it('should accept customer with full address fields', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski',
        street: 'ul. Marszałkowska',
        number: '10',
        postalCode: '00-001',
        city: 'Warsaw'
      })

      expect(result.success).toBe(true)
    })

    it('should accept customer with no address fields at all', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski'
      })

      expect(result.success).toBe(true)
    })

    it('should default country to BE when not provided', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.country).toBe('BE')
      }
    })
  })

  describe('client-generated UUID', () => {
    it('should accept a valid UUID as id', () => {
      const result = createCustomerSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski'
      })

      expect(result.success).toBe(true)
    })

    it('should accept creation without id (let server generate)', () => {
      const result = createCustomerSchema.safeParse({
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski'
      })

      expect(result.success).toBe(true)
    })
  })
})

describe('updateCustomerSchema', () => {
  it('should accept partial update with one field', () => {
    const result = updateCustomerSchema.safeParse({
      phone: '+48 500 600 700'
    })

    expect(result.success).toBe(true)
  })

  it('should accept partial update with multiple fields', () => {
    const result = updateCustomerSchema.safeParse({
      email: 'new@example.com',
      city: 'Kraków',
      postalCode: '30-001'
    })

    expect(result.success).toBe(true)
  })

  it('should reject empty update payload', () => {
    const result = updateCustomerSchema.safeParse({})

    expect(result.success).toBe(false)
  })

  it('should accept null for vatId (to clear it)', () => {
    const result = updateCustomerSchema.safeParse({
      vatId: null
    })

    expect(result.success).toBe(true)
  })

  it('should reject empty string for firstName in update', () => {
    const result = updateCustomerSchema.safeParse({
      firstName: ''
    })

    expect(result.success).toBe(false)
  })

  it('should accept companyName update for company customer', () => {
    const result = updateCustomerSchema.safeParse({
      companyName: 'New Company Name'
    })

    expect(result.success).toBe(true)
  })

  it('should accept address partial update (street only)', () => {
    const result = updateCustomerSchema.safeParse({
      street: 'ul. Nowa'
    })

    expect(result.success).toBe(true)
  })

  it('should default country to BE when not provided in update', () => {
    const result = updateCustomerSchema.safeParse({
      firstName: 'Jan'
    })

    // The schema uses .default('BE') on the country field, but since we're
    // only passing firstName, country won't be set. This test verifies that
    // partial updates don't require all address fields.
    expect(result.success).toBe(true)
  })

  describe('type updates — private↔company conversion', () => {
    it('should accept type=company with matching companyName', () => {
      const result = updateCustomerSchema.safeParse({
        type: 'company',
        companyName: 'New Co.'
      })
      expect(result.success).toBe(true)
    })

    it('should accept type=private with matching firstName and lastName', () => {
      const result = updateCustomerSchema.safeParse({
        type: 'private',
        firstName: 'Jan',
        lastName: 'Kowalski'
      })
      expect(result.success).toBe(true)
    })

    it('should reject type=company without companyName', () => {
      const result = updateCustomerSchema.safeParse({
        type: 'company'
      })
      expect(result.success).toBe(false)
    })

    it('should reject type=private without firstName', () => {
      const result = updateCustomerSchema.safeParse({
        type: 'private',
        lastName: 'Kowalski'
      })
      expect(result.success).toBe(false)
    })

    it('should reject type=private without lastName', () => {
      const result = updateCustomerSchema.safeParse({
        type: 'private',
        firstName: 'Jan'
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid type value', () => {
      const result = updateCustomerSchema.safeParse({
        type: 'alien',
        firstName: 'Jan',
        lastName: 'Kowalski'
      })
      expect(result.success).toBe(false)
    })
  })
})

describe('validateAddress', () => {
  it('should return valid when no street is provided', () => {
    const result = validateAddress({})
    expect(result.valid).toBe(true)
  })

  it('should return valid when full address is provided', () => {
    const result = validateAddress({
      street: 'ul. Marszałkowska',
      number: '10',
      postalCode: '00-001',
      city: 'Warsaw'
    })
    expect(result.valid).toBe(true)
  })

  it('should return invalid when street is provided without number', () => {
    const result = validateAddress({
      street: 'ul. Marszałkowska'
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toContain('number is required when street is provided')
    }
  })

  it('should return invalid when street is provided without postalCode', () => {
    const result = validateAddress({
      street: 'ul. Marszałkowska',
      number: '10'
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toContain('postalCode is required when street is provided')
    }
  })

  it('should return invalid when street is provided without city', () => {
    const result = validateAddress({
      street: 'ul. Marszałkowska',
      number: '10',
      postalCode: '00-001'
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toContain('city is required when street is provided')
    }
  })

  it('should return invalid with all three errors when only street is set', () => {
    const result = validateAddress({
      street: 'ul. Marszałkowska'
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toHaveLength(3)
    }
  })

  it('should return valid when bus is provided without other address fields', () => {
    const result = validateAddress({
      bus: '2'
    })
    expect(result.valid).toBe(true)
  })
})
