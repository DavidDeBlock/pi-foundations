/**
 * BasePage — shared shell (header, side panel, toasts).
 *
 * Every other page object extends this. Methods here describe actions
 * available from anywhere in the app, not actions specific to a feature.
 *
 * Conventions:
 *   - Selectors are exposed as `getters` returning locators.
 *   - Actions are methods that compose selectors.
 *   - Never use raw `page.locator()` in test files — always go through POMs.
 *   - Selectors prefer `data-testid`; fall back to `getByRole` / `getByText`
 *     for user-visible strings (toasts, dialog titles, error messages).
 */

import type { Page, Locator } from '@playwright/test'

export class BasePage {
  constructor(protected readonly page: Page) {}

  // -------------------------------------------------------------------------
  // Shared shell
  // -------------------------------------------------------------------------

  /** Top app header (logo, global search, user menu) */
  get header(): Locator {
    return this.page.locator('header')
  }

  /** Left-hand navigation panel */
  get sidePanel(): Locator {
    return this.page.getByRole('navigation')
  }

  /** Toast container (react-hot-toast renders into a region) */
  get toasts(): Locator {
    return this.page.locator('[role="status"], [role="alert"]')
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  async goto(path: string): Promise<void> {
    await this.page.goto(path)
  }

  // -------------------------------------------------------------------------
  // Toast assertions
  // -------------------------------------------------------------------------

  /**
   * Assert a toast with the given text is visible. Use for success/error
   * confirmations that the app shows to users.
   */
  async expectToast(text: string | RegExp): Promise<void> {
    const toast = this.toasts.filter({ hasText: text }).first()
    await toast.waitFor({ state: 'visible', timeout: 5_000 })
  }
}
