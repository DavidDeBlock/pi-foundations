/**
 * Explicit TypeScript interface for products (parts catalog).
 * Mirrors the DB schema's `parts` table but is decoupled from Drizzle inference.
 */

export interface Product {
  id: string
  barcode: string
  name: string
  description: string | null
  priceNet: number // ex-tax cents
  costPrice: number | null // in cents
  quantityOnHand: number
  isActive: boolean
}
