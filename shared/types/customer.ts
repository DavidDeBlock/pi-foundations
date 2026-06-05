/**
 * Explicit TypeScript interface for customers.
 * Mirrors the DB schema's `customers` table but is decoupled from Drizzle inference.
 */

export interface Customer {
  id: string
  type: 'private' | 'company'
  firstName: string | null // required for private customers
  lastName: string | null // required for private customers
  companyName: string | null // required for company customers
  vatId: string | null
  phone: string | null
  email: string | null
  street: string | null
  number: string | null
  bus: string | null
  postalCode: string | null
  city: string | null
  country: string // defaults to 'BE' (Belgium)
  notificationPreference: 'sms' | 'email' | null
}
