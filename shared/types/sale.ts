/**
 * Explicit TypeScript interfaces for sale-related entities.
 * Mirrors the DB schema but is decoupled from Drizzle inference.
 * Both client and server import these as single source of truth.
 */

// ============================================================================
// Sale Header
// ============================================================================

export interface Sale {
  id: string
  saleNumber: string // e.g. "SA-0001"
  customerId: string | null // nullable for walk-in customers
  sourceType: 'direct_sale' | 'repair' | 'customer_order' | 'backorder'
  sourceId: string | null // ID of source document (nullable for direct_sale)
  status: 'completed' | 'voided'
  subtotalNet: number // ex-tax cents
  vatTotal: number // VAT in cents
  totalGross: number // incl-tax cents
  createdAt: number // epoch ms timestamp
}

// ============================================================================
// Sale Line Item — mirrors lineItemColumns + bicycleLineColumns
// ============================================================================

export interface SaleLineItem {
  id: string
  saleId: string
  lineType: 'part' | 'labor' | 'bicycle'
  partId: string | null
  laborServiceId: string | null
  description: string
  quantity: number
  unitPriceNet: number // ex-tax cents per unit
  vatRateId: string // FK to vatRates lookup
  discountPercent: number | null // basis points (100 = 1%), nullable = no discount
  lineTotalNet: number // discounted net total in cents
  lineTotalVat: number // VAT amount in cents
  lineTotalGross: number // incl-tax total in cents
  bicycleId: string | null
  bicycleBrand: string | null
  bicycleModel: string | null
  bicycleYear: number | null
  bicycleColor: string | null
  bicycleFrameSize: string | null
  createdAt: number // epoch ms timestamp
}

// ============================================================================
// Payment — polymorphic, allocated to any document type via paymentAllocations
// ============================================================================

export interface Payment {
  id: string
  method: 'cash' | 'card' | 'bank_transfer'
  amount: number // total payment amount in cents
  referenceNumber: string | null // e.g. POS receipt number
  createdAt: number // epoch ms timestamp
}
