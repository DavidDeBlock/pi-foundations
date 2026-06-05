import { z } from 'zod'

// ---------------------------------------------------------------------------
// Postal code search — optional search param for postcode lookup
// ---------------------------------------------------------------------------

/** Query parameters for searching postal codes by partial match. */
export const postalCodeSearchSchema = z.object({
  search: z.string().optional(),
})

/** Inferred type for postal code search query params. */
export type PostalCodeSearchParams = z.infer<typeof postalCodeSearchSchema>

// ---------------------------------------------------------------------------
// Street search — required postalCode + optional street name search
// ---------------------------------------------------------------------------

/** Query parameters for searching streets within a postcode area. */
export const streetSearchSchema = z.object({
  postalCode: z.string(),
  search: z.string().optional(),
})

/** Inferred type for street search query params. */
export type StreetSearchParams = z.infer<typeof streetSearchSchema>
