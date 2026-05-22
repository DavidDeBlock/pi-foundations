// Test fixture: File with NO Hono routes (should produce empty results)
export function calculateTotal(items: Array<{ price: number; qty: number }>): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0)
}

export interface SaleItem {
  id: string
  name: string
  price: number
}
