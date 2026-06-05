import { describe, it, expect } from 'vitest'
import { createStaffMemberSchema, updateStaffMemberSchema } from '../staff.js'

describe('createStaffMemberSchema', () => {
  it('should accept valid staff member with name, role, and hourlyRate', () => {
    const result = createStaffMemberSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Jan Kowalski',
      role: 'mechanic',
      hourlyRate: 4500, // €45.00/h in cents
    })

    expect(result.success).toBe(true)
  })

  it('should accept valid staff member with manager role', () => {
    const result = createStaffMemberSchema.safeParse({
      name: 'Anna Nowak',
      role: 'manager',
      hourlyRate: 6000, // €60.00/h in cents
    })

    expect(result.success).toBe(true)
  })

  it('should default role to mechanic when not provided', () => {
    const result = createStaffMemberSchema.safeParse({
      name: 'Piotr Wiśniewski',
      hourlyRate: 5000,
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.role).toBe('mechanic')
    }
  })

  it('should accept isActive as optional boolean', () => {
    const result = createStaffMemberSchema.safeParse({
      name: 'Test User',
      role: 'mechanic',
      hourlyRate: 4000,
      isActive: false,
    })

    expect(result.success).toBe(true)
  })

  it('should reject missing name', () => {
    const result = createStaffMemberSchema.safeParse({
      role: 'mechanic',
      hourlyRate: 4500,
    })

    expect(result.success).toBe(false)
  })

  it('should reject empty string for name', () => {
    const result = createStaffMemberSchema.safeParse({
      name: '',
      role: 'mechanic',
      hourlyRate: 4500,
    })

    expect(result.success).toBe(false)
  })

  it('should reject invalid role enum value', () => {
    const result = createStaffMemberSchema.safeParse({
      name: 'Jan Kowalski',
      role: 'intern' as string,
      hourlyRate: 4500,
    })

    expect(result.success).toBe(false)
  })

  it('should reject negative hourlyRate', () => {
    const result = createStaffMemberSchema.safeParse({
      name: 'Jan Kowalski',
      role: 'mechanic',
      hourlyRate: -100,
    })

    expect(result.success).toBe(false)
  })

  it('should reject zero hourlyRate', () => {
    const result = createStaffMemberSchema.safeParse({
      name: 'Jan Kowalski',
      role: 'mechanic',
      hourlyRate: 0,
    })

    expect(result.success).toBe(false)
  })

  it('should reject non-integer hourlyRate (float)', () => {
    const result = createStaffMemberSchema.safeParse({
      name: 'Jan Kowalski',
      role: 'mechanic',
      hourlyRate: 45.50,
    })

    expect(result.success).toBe(false)
  })

  it('should accept creation without id (let server generate)', () => {
    const result = createStaffMemberSchema.safeParse({
      name: 'Jan Kowalski',
      role: 'mechanic',
      hourlyRate: 4500,
    })

    expect(result.success).toBe(true)
  })

  it('should accept a valid UUID as id', () => {
    const result = createStaffMemberSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Jan Kowalski',
      role: 'mechanic',
      hourlyRate: 4500,
    })

    expect(result.success).toBe(true)
  })
})

describe('updateStaffMemberSchema', () => {
  it('should accept partial update with name only', () => {
    const result = updateStaffMemberSchema.safeParse({
      name: 'New Name',
    })

    expect(result.success).toBe(true)
  })

  it('should accept partial update with role only', () => {
    const result = updateStaffMemberSchema.safeParse({
      role: 'manager',
    })

    expect(result.success).toBe(true)
  })

  it('should accept partial update with hourlyRate only', () => {
    const result = updateStaffMemberSchema.safeParse({
      hourlyRate: 5000,
    })

    expect(result.success).toBe(true)
  })

  it('should accept partial update with isActive only', () => {
    const result = updateStaffMemberSchema.safeParse({
      isActive: false,
    })

    expect(result.success).toBe(true)
  })

  it('should accept partial update with multiple fields', () => {
    const result = updateStaffMemberSchema.safeParse({
      name: 'Updated Name',
      role: 'manager',
      hourlyRate: 5500,
    })

    expect(result.success).toBe(true)
  })

  it('should reject empty update payload', () => {
    const result = updateStaffMemberSchema.safeParse({})

    expect(result.success).toBe(false)
  })

  it('should reject empty string for name in update', () => {
    const result = updateStaffMemberSchema.safeParse({
      name: '',
    })

    expect(result.success).toBe(false)
  })

  it('should reject invalid role enum value in update', () => {
    const result = updateStaffMemberSchema.safeParse({
      role: 'intern' as string,
    })

    expect(result.success).toBe(false)
  })

  it('should reject negative hourlyRate in update', () => {
    const result = updateStaffMemberSchema.safeParse({
      hourlyRate: -100,
    })

    expect(result.success).toBe(false)
  })

  it('should reject non-integer hourlyRate (float) in update', () => {
    const result = updateStaffMemberSchema.safeParse({
      hourlyRate: 45.50,
    })

    expect(result.success).toBe(false)
  })
})
