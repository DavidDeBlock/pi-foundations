/**
 * Explicit TypeScript interface for stock movements.
 * Mirrors the DB schema's `stock_movements` table but is decoupled from Drizzle inference.
 */

export interface StockMovement {
  id: string
  partId: string
  quantityDelta: number // positive or negative
  reason: 'sale' | 'void' | 'order_receive' | 'manual_correction' | 'backorder_receive' | 'repair_use' | 'return' | 'waste' | 'initial_stock' | 'adjustment'
  referenceType: string | null // e.g. 'sale', 'supplier_order_line'
  referenceId: string | null // ID of source operation
  createdAt: number // epoch ms timestamp
}
