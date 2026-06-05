/**
 * Pure functions for line item price calculations.
 *
 * All amounts in cents (integer). Discount and VAT rates are in basis points
 * (100 = 1%, 2100 = 21%). No framework dependencies — importable from both
 * client and server.
 *
 * This is the single source of truth for line math, replacing duplicated
 * implementations in client store and server service.
 */

// ============================================================================
// Line Item Math
// ============================================================================

/**
 * Compute line item totals from quantity, unit price, discount, and VAT rate.
 *
 * Formula: discountedNetPerUnit = unitPriceNet × (1 - discountBps / 10000)
 *          lineNetTotal = discountedNetPerUnit × quantity
 *          lineVatTotal = round(lineNetTotal × vatRateBps / 10000)
 *          lineGrossTotal = lineNetTotal + lineVatTotal
 *
 * @param unitPriceNet — Ex-tax price per unit in cents (integer)
 * @param quantity — Number of units (integer, >= 1)
 * @param discountPercentBps — Discount in basis points (null or 0 = no discount). e.g. 1000 = 10%
 * @param vatRateBps — VAT rate in basis points. e.g. 2100 = 21%, 600 = 6%
 * @returns Object with net, vat, and gross totals in cents (integer)
 */
export function computeLineTotals(
  unitPriceNet: number,
  quantity: number,
  discountPercentBps: number | null | undefined,
  vatRateBps: number
): { net: number; vat: number; gross: number } {
  // Apply discount (basis points → fraction)
  const discountFactor = discountPercentBps ? 1 - discountPercentBps / 10000 : 1
  const discountedNetPerUnit = Math.round(unitPriceNet * discountFactor)
  const lineNetTotal = discountedNetPerUnit * quantity

  // Compute VAT (round to nearest cent)
  const lineVatTotal = Math.round(lineNetTotal * vatRateBps / 10000)

  return {
    net: lineNetTotal,
    vat: lineVatTotal,
    gross: lineNetTotal + lineVatTotal
  }
}
