/**
 * PosPage — Page Object for the Point-of-Sale checkout surface.
 *
 * Inherits shell (header, side panel, toasts) from BasePage.
 *
 * Phase 1 (this commit): the POM is scaffolded with method signatures and
 * action methods, but the selectors are PLACEHOLDERS that throw on use.
 * Phase 2 (separate PR) will add `data-testid` attributes to
 * `client/src/features/pos/components/**` and the selectors below will be
 * filled in. Phase 3 will write the first spec using this POM.
 *
 * Happy path the first spec will exercise:
 *   searchPart → addToCart → (selectCustomer | skipCustomer) → checkout →
 *   completePayment → expectSuccess
 *
 * See ADR-010 and `.pi/skills/e2e-testing/SKILL.md` for conventions.
 */

import type { Locator } from '@playwright/test'
import { BasePage } from './base.page.js'

export class PosPage extends BasePage {
  // -------------------------------------------------------------------------
  // Selectors (PLACEHOLDERS — wired up in Phase 2 with data-testid additions)
  // -------------------------------------------------------------------------

  /** Search input in the parts search panel. Needs `data-testid="pos-parts-search"`. */
  get partsSearchInput(): Locator {
    return this.page.getByTestId('pos-parts-search')
  }

  /** Result row in the parts dropdown. Needs `data-testid="pos-part-row"`. */
  get partRow(): Locator {
    return this.page.getByTestId('pos-part-row')
  }

  /** Cart line item. Needs `data-testid="pos-cart-line"`. */
  get cartLine(): Locator {
    return this.page.getByTestId('pos-cart-line')
  }

  /** Customer search input. Needs `data-testid="pos-customer-search"`. */
  get customerSearchInput(): Locator {
    return this.page.getByTestId('pos-customer-search')
  }

  /** Customer search result row. Needs `data-testid="pos-customer-row"`. */
  get customerRow(): Locator {
    return this.page.getByTestId('pos-customer-row')
  }

  /** "Walk-in / no customer" button. Needs `data-testid="pos-customer-skip"`. */
  get skipCustomerButton(): Locator {
    return this.page.getByTestId('pos-customer-skip')
  }

  /** "Checkout" button (opens payment dialog). Needs `data-testid="pos-checkout-btn"`. */
  get checkoutButton(): Locator {
    return this.page.getByTestId('pos-checkout-btn')
  }

  /** Cash payment method button. Needs `data-testid="pos-pay-cash"`. */
  get payCashButton(): Locator {
    return this.page.getByTestId('pos-pay-cash')
  }

  /** Card payment method button. Needs `data-testid="pos-pay-card"`. */
  get payCardButton(): Locator {
    return this.page.getByTestId('pos-pay-card')
  }

  /** "Submit payment" confirmation button. Needs `data-testid="pos-pay-submit"`. */
  get submitPaymentButton(): Locator {
    return this.page.getByTestId('pos-pay-submit')
  }

  // -------------------------------------------------------------------------
  // Actions — read like user actions, compose selectors above
  // -------------------------------------------------------------------------

  async open(): Promise<void> {
    await this.goto('/pos')
    // Wait for the page's primary action to be ready before considering
    // navigation complete. (Phase 2 will confirm which selector is the
    // canonical "page ready" signal — for now use a stable text query.)
    await this.page.getByRole('heading', { name: /pos|cashier|checkout/i })
      .or(this.partsSearchInput)
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
  }

  async searchPart(query: string): Promise<void> {
    await this.partsSearchInput.fill(query)
  }

  async addFirstPartToCart(): Promise<void> {
    await this.partRow.first().click()
  }

  async selectCustomer(query: string): Promise<void> {
    await this.customerSearchInput.fill(query)
    await this.customerRow.first().click()
  }

  async skipCustomer(): Promise<void> {
    await this.skipCustomerButton.click()
  }

  async openCheckout(): Promise<void> {
    await this.checkoutButton.click()
  }

  async completePayment(method: 'cash' | 'card'): Promise<void> {
    const methodButton = method === 'cash' ? this.payCashButton : this.payCardButton
    await methodButton.click()
    await this.submitPaymentButton.click()
  }

  async expectSuccess(): Promise<void> {
    // Success confirmation: a success toast naming the sale or the next
    // "start a new sale" affordance. The exact selector is decided when
    // the data-testids land in Phase 2.
    await this.page
      .getByText(/sale complete|success|new sale/i)
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
  }
}
