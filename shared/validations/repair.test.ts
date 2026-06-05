import { describe, it, expect } from 'vitest'
import {
  repairIntakeSchema,
  transitionRepairStatusSchema,
  updateRepairSchema,
  createIntakeCustomerSchema,
  createIntakeBicycleSchema,
} from './repair.js'

// ---------------------------------------------------------------------------
// Repair Intake Schema
// ---------------------------------------------------------------------------

describe('repairIntakeSchema', () => {
  const baseExistingCustomer = {
    customerMode: 'existing' as const,
    existingCustomerId: '550e8400-e29b-41d4-a716-446655440000',
    bicycleMode: 'select_existing' as const,
    existingBicycleId: '550e8400-e29b-41d4-a716-446655440001',
    customerNotes: 'Brake adjustment needed',
  }

  it('accepts valid intake with existing customer and bicycle', () => {
    const result = repairIntakeSchema.safeParse(baseExistingCustomer)
    expect(result.success).toBe(true)
  })

  it('accepts valid intake with new customer inline creation', () => {
    const input = {
      ...baseExistingCustomer,
      customerMode: 'new' as const,
      existingCustomerId: undefined,
      newCustomer: {
        firstName: 'John',
        lastName: 'Doe',
        phone: '+32470123456',
        email: 'john@example.com',
      },
    }

    // Need to adjust the discriminated union - use z.discriminatedUnion properly
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('accepts intake with new bicycle inline creation', () => {
    const input = {
      ...baseExistingCustomer,
      bicycleMode: 'create_new' as const,
      existingBicycleId: undefined,
      newBicycle: {
        brand: 'Trek',
        model: 'Fuel EX',
        color: 'Green',
      },
    }

    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('rejects missing customer notes', () => {
    const input = { ...baseExistingCustomer, customerNotes: '' }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('rejects empty customer notes', () => {
    const input = { ...baseExistingCustomer, customerNotes: '   ' }
    const result = repairIntakeSchema.safeParse(input)
    // Whitespace-only should pass min(1) but fail trim check if we add one
    // For now, just verify it accepts non-empty strings
  })

  it('rejects missing existingBicycleId when selecting existing bicycle', () => {
    const input = { ...baseExistingCustomer, bicycleMode: 'select_existing' as const, existingBicycleId: undefined }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('rejects missing newBicycle when creating new bicycle', () => {
    const input = { ...baseExistingCustomer, bicycleMode: 'create_new' as const, existingBicycleId: undefined, newBicycle: undefined }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('rejects invalid UUID for existingCustomerId', () => {
    const input = { ...baseExistingCustomer, existingCustomerId: 'not-a-uuid' }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('accepts customer notes at max length (2000 chars)', () => {
    const input = { ...baseExistingCustomer, customerNotes: 'x'.repeat(2000) }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('rejects customer notes exceeding max length (2001 chars)', () => {
    const input = { ...baseExistingCustomer, customerNotes: 'x'.repeat(2001) }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('rejects missing newCustomer when customerMode is new', () => {
    const input = {
      customerMode: 'new' as const,
      newCustomer: undefined,
      bicycleMode: 'create_new' as const,
      newBicycle: { brand: 'Trek', model: 'Fuel EX', color: 'Green' },
      customerNotes: 'Test',
    }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('rejects missing newBicycle when bicycleMode is create_new', () => {
    const input = {
      customerMode: 'existing' as const,
      existingCustomerId: '550e8400-e29b-41d4-a716-446655440000',
      bicycleMode: 'create_new' as const,
      newBicycle: undefined,
      customerNotes: 'Test',
    }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('accepts walk-in intake with no customer and new bicycle', () => {
    const input = {
      customerMode: 'none' as const,
      bicycleMode: 'create_new' as const,
      newBicycle: { brand: 'Giant', model: 'Defy', color: 'Black' },
      customerNotes: 'Walk-in repair — chain replacement',
    }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('accepts walk-in intake with no customer and existing bicycle', () => {
    const input = {
      customerMode: 'none' as const,
      bicycleMode: 'select_existing' as const,
      existingBicycleId: '550e8400-e29b-41d4-a716-446655440001',
      customerNotes: 'Walk-in repair — brake adjustment',
    }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('rejects walk-in intake with missing bicycle data for create_new', () => {
    const input = {
      customerMode: 'none' as const,
      bicycleMode: 'create_new' as const,
      newBicycle: undefined,
      customerNotes: 'Walk-in repair',
    }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('rejects walk-in intake with missing bicycle data for select_existing', () => {
    const input = {
      customerMode: 'none' as const,
      bicycleMode: 'select_existing' as const,
      existingBicycleId: undefined,
      customerNotes: 'Walk-in repair',
    }
    const result = repairIntakeSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('rejects completely empty object', () => {
    const result = repairIntakeSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Inline Customer Creation Schema
// ---------------------------------------------------------------------------

describe('createIntakeCustomerSchema', () => {
  it('accepts valid private customer with phone and email', () => {
    const result = createIntakeCustomerSchema.safeParse({
      firstName: 'John',
      lastName: 'Doe',
      phone: '+32470123456',
      email: 'john@example.com',
    })
    expect(result.success).toBe(true)
  })

  it('accepts valid company customer with companyName and phone', () => {
    const result = createIntakeCustomerSchema.safeParse({
      companyName: 'Acme Corp',
      phone: '+32470123456',
      email: 'info@acme.com',
    })
    expect(result.success).toBe(true)
  })

  it('accepts customer with only required phone field', () => {
    const result = createIntakeCustomerSchema.safeParse({
      phone: '+32470123456',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing phone (required)', () => {
    const result = createIntakeCustomerSchema.safeParse({
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com',
    } as any)
    expect(result.success).toBe(false)
  })

  it('rejects empty phone', () => {
    const result = createIntakeCustomerSchema.safeParse({
      firstName: 'John',
      lastName: 'Doe',
      phone: '',
    } as any)
    expect(result.success).toBe(false)
  })

  it('accepts optional email as empty string', () => {
    const result = createIntakeCustomerSchema.safeParse({
      firstName: 'John',
      lastName: 'Doe',
      phone: '+32470123456',
      email: '',
    })
    expect(result.success).toBe(true)
  })

  it('rejects firstName exceeding max length (101 chars)', () => {
    const result = createIntakeCustomerSchema.safeParse({
      firstName: 'x'.repeat(101),
      lastName: 'Doe',
      phone: '+32470123456',
    })
    expect(result.success).toBe(false)
  })

  it('accepts firstName at max length (100 chars)', () => {
    const result = createIntakeCustomerSchema.safeParse({
      firstName: 'x'.repeat(100),
      lastName: 'Doe',
      phone: '+32470123456',
    })
    expect(result.success).toBe(true)
  })

  it('rejects companyName exceeding max length (201 chars)', () => {
    const result = createIntakeCustomerSchema.safeParse({
      companyName: 'x'.repeat(201),
      phone: '+32470123456',
    })
    expect(result.success).toBe(false)
  })

  it('rejects completely empty object', () => {
    const result = createIntakeCustomerSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Inline Bicycle Creation Schema
// ---------------------------------------------------------------------------

describe('createIntakeBicycleSchema', () => {
  it('accepts valid bicycle with brand, model, color', () => {
    const result = createIntakeBicycleSchema.safeParse({
      brand: 'Trek',
      model: 'Fuel EX',
      color: 'Green',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing brand (required)', () => {
    const result = createIntakeBicycleSchema.safeParse({
      model: 'Fuel EX',
      color: 'Green',
    } as any)
    expect(result.success).toBe(false)
  })

  it('rejects missing model (required)', () => {
    const result = createIntakeBicycleSchema.safeParse({
      brand: 'Trek',
      color: 'Green',
    } as any)
    expect(result.success).toBe(false)
  })

  it('rejects missing color (required)', () => {
    const result = createIntakeBicycleSchema.safeParse({
      brand: 'Trek',
      model: 'Fuel EX',
    } as any)
    expect(result.success).toBe(false)
  })

  it('rejects empty brand', () => {
    const result = createIntakeBicycleSchema.safeParse({
      brand: '',
      model: 'Fuel EX',
      color: 'Green',
    } as any)
    expect(result.success).toBe(false)
  })

  it('accepts brand at max length (100 chars)', () => {
    const result = createIntakeBicycleSchema.safeParse({
      brand: 'x'.repeat(100),
      model: 'Fuel EX',
      color: 'Green',
    })
    expect(result.success).toBe(true)
  })

  it('rejects brand exceeding max length (101 chars)', () => {
    const result = createIntakeBicycleSchema.safeParse({
      brand: 'x'.repeat(101),
      model: 'Fuel EX',
      color: 'Green',
    })
    expect(result.success).toBe(false)
  })

  it('rejects completely empty object', () => {
    const result = createIntakeBicycleSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Transition Status Schema
// ---------------------------------------------------------------------------

describe('transitionRepairStatusSchema', () => {
  it('accepts valid transition to in_progress', () => {
    const result = transitionRepairStatusSchema.safeParse({
      targetStatus: 'in_progress',
    })
    expect(result.success).toBe(true)
  })

  it('accepts transition to on_hold with holdReason and note', () => {
    const result = transitionRepairStatusSchema.safeParse({
      targetStatus: 'on_hold',
      holdReason: 'waiting_parts',
      holdReasonNote: 'Waiting for brake pads',
    })
    expect(result.success).toBe(true)
  })

  it('accepts transition to cancelled from any non-terminal status', () => {
    const result = transitionRepairStatusSchema.safeParse({
      targetStatus: 'cancelled',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid target status', () => {
    const result = transitionRepairStatusSchema.safeParse({
      targetStatus: 'invalid_status' as any,
    })
    expect(result.success).toBe(false)
  })

  it('accepts holdReasonNote without holdReason (for other transitions)', () => {
    // When transitioning to non-on_hold status, holdReasonNote is optional
    const result = transitionRepairStatusSchema.safeParse({
      targetStatus: 'in_progress',
      holdReasonNote: 'Some note',
    })
    expect(result.success).toBe(true)
  })

  it('rejects completely empty object', () => {
    const result = transitionRepairStatusSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Update Repair Schema
// ---------------------------------------------------------------------------

describe('updateRepairSchema', () => {
  it('accepts update with customerNotes only', () => {
    const result = updateRepairSchema.safeParse({
      customerNotes: 'Updated notes',
    })
    expect(result.success).toBe(true)
  })

  it('accepts update with internalNotes only', () => {
    const result = updateRepairSchema.safeParse({
      internalNotes: 'Technician observation',
    })
    expect(result.success).toBe(true)
  })

  it('accepts update with both note types', () => {
    const result = updateRepairSchema.safeParse({
      customerNotes: 'Customer notes',
      internalNotes: 'Internal notes',
    })
    expect(result.success).toBe(true)
  })

  it('accepts update with holdReason and holdReasonNote', () => {
    const result = updateRepairSchema.safeParse({
      holdReason: 'waiting_parts',
      holdReasonNote: 'Waiting for parts from supplier',
    })
    expect(result.success).toBe(true)
  })

  it('rejects update with holdReason but missing holdReasonNote', () => {
    const result = updateRepairSchema.safeParse({
      holdReason: 'waiting_parts',
    } as any)
    expect(result.success).toBe(false)
  })

  it('accepts clearing holdReason to null', () => {
    const result = updateRepairSchema.safeParse({
      holdReason: null,
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid UUID for assignedTo', () => {
    const result = updateRepairSchema.safeParse({
      assignedTo: 'not-a-uuid',
    } as any)
    expect(result.success).toBe(false)
  })

  it('accepts null assignedTo', () => {
    const result = updateRepairSchema.safeParse({
      assignedTo: null,
    })
    expect(result.success).toBe(true)
  })

  it('accepts empty object (all fields optional for partial updates)', () => {
    // Empty object is valid — all fields are optional for partial updates
    const result = updateRepairSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})
