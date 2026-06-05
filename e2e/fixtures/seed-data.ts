/**
 * E2E seed factories.
 *
 * Each factory POSTs a spec to `/api/test/seed/<entity>` (server-side route
 * mounted only when NODE_ENV=test) and returns the persisted entity.
 *
 * Conventions:
 *   - Factories accept an `APIRequestContext` and a partial spec.
 *   - All factories return the full created entity so tests can assert on
 *     server-assigned fields (e.g. generated IDs).
 *   - `seedMinimalDataset()` re-uses `POST /api/test/reset` so the API
 *     contract is the single source of truth for what "minimal" means.
 *
 * Usage in a test:
 *   test.beforeEach(async ({ request }) => {
 *     await seedMinimalDataset(request)
 *   })
 *
 *   test('cashier adds a second customer', async ({ request }) => {
 *     const extra = await oneCustomer(request, { firstName: 'Marie' })
 *     expect(extra.firstName).toBe('Marie')
 *   })
 */

import type { APIRequestContext } from '@playwright/test'

// ---------------------------------------------------------------------------
// Spec types — match the server's `routes/test.ts` payload shapes
// ---------------------------------------------------------------------------

export interface StaffSpec {
  id: string
  name: string
  role: 'mechanic' | 'manager'
  hourlyRate: number
  isActive?: boolean
}

export interface CustomerSpec {
  id: string
  type: 'private' | 'company'
  firstName?: string | null
  lastName?: string | null
  companyName?: string | null
  phone?: string | null
  email?: string | null
}

export interface PartSpec {
  id: string
  barcode: string
  name: string
  description?: string | null
  priceNet: number
  costPrice?: number | null
  quantityOnHand?: number
  isActive?: boolean
}

export interface VatRateSpec {
  id: string
  /** Basis points: 2100 = 21%, 600 = 6% */
  rate: number
  description: string
}

// ---------------------------------------------------------------------------
// Minimal seed — matches ADR-010 conventions
// ---------------------------------------------------------------------------

/**
 * Reset the DB to the minimal seed (1 staff, 1 customer, 1 part, 1 VAT rate).
 * The POS happy-path test depends on this exact shape.
 */
export async function seedMinimalDataset(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/test/reset')
  if (!response.ok()) {
    throw new Error(
      `seedMinimalDataset failed: ${response.status()} ${await response.text()}`
    )
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Add a single staff member on top of the existing seed.
 * Returns the persisted staff record.
 */
export async function oneStaff(
  request: APIRequestContext,
  overrides: Partial<StaffSpec> = {}
): Promise<StaffSpec> {
  const spec: StaffSpec = {
    id: overrides.id ?? `user-test-${crypto.randomUUID()}`,
    name: overrides.name ?? 'Test Staff',
    role: overrides.role ?? 'mechanic',
    hourlyRate: overrides.hourlyRate ?? 3500,
    isActive: overrides.isActive ?? true,
  }
  const response = await request.post('/api/test/seed/staff', { data: spec })
  if (!response.ok()) {
    throw new Error(
      `oneStaff failed: ${response.status()} ${await response.text()}`
    )
  }
  return response.json()
}

/**
 * Add a single customer on top of the existing seed.
 * Returns the persisted customer record.
 */
export async function oneCustomer(
  request: APIRequestContext,
  overrides: Partial<CustomerSpec> = {}
): Promise<CustomerSpec> {
  const spec: CustomerSpec = {
    id: overrides.id ?? `cust-test-${crypto.randomUUID()}`,
    type: overrides.type ?? 'private',
    firstName: overrides.firstName ?? null,
    lastName: overrides.lastName ?? null,
    companyName: overrides.companyName ?? null,
    phone: overrides.phone ?? null,
    email: overrides.email ?? null,
  }
  const response = await request.post('/api/test/seed/customer', { data: spec })
  if (!response.ok()) {
    throw new Error(
      `oneCustomer failed: ${response.status()} ${await response.text()}`
    )
  }
  return response.json()
}

/**
 * Add a single VAT rate on top of the existing seed.
 * Returns the persisted VAT rate record.
 */
export async function oneVatRate(
  request: APIRequestContext,
  overrides: Partial<VatRateSpec> = {}
): Promise<VatRateSpec> {
  const spec: VatRateSpec = {
    id: overrides.id ?? `vat-test-${crypto.randomUUID()}`,
    rate: overrides.rate ?? 2100,
    description: overrides.description ?? 'Standard 21%',
  }
  const response = await request.post('/api/test/seed/vat-rate', { data: spec })
  if (!response.ok()) {
    throw new Error(
      `oneVatRate failed: ${response.status()} ${await response.text()}`
    )
  }
  return response.json()
}

/**
 * Add a single part on top of the existing seed.
 * Returns the persisted part record.
 */
export async function onePart(
  request: APIRequestContext,
  overrides: Partial<PartSpec> = {}
): Promise<PartSpec> {
  const spec: PartSpec = {
    id: overrides.id ?? `part-test-${crypto.randomUUID()}`,
    barcode: overrides.barcode ?? `BAR-TEST-${crypto.randomUUID().slice(0, 8)}`,
    name: overrides.name ?? 'Test Part',
    description: overrides.description ?? null,
    priceNet: overrides.priceNet ?? 1000,
    costPrice: overrides.costPrice ?? null,
    quantityOnHand: overrides.quantityOnHand ?? 1,
    isActive: overrides.isActive ?? true,
  }
  const response = await request.post('/api/test/seed/part', { data: spec })
  if (!response.ok()) {
    throw new Error(
      `onePart failed: ${response.status()} ${await response.text()}`
    )
  }
  return response.json()
}
