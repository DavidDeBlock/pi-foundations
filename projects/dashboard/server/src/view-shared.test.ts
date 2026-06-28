// view-shared.test.ts — issue #011
//
// The shared <head> fragment is interpolated into every page's HTML,
// so we lock its contents down with a test. If anyone removes a link
// tag or the bootstrap script by accident, the test catches it
// before the visual regression lands in a browser.

import { describe, expect, it } from 'vitest'
import {
  CLIPBOARD_SCRIPT_TAG,
  COMMON_HEAD,
  HAMBURGER_SCRIPT_TAG,
  THEME_SCRIPT_TAG,
  renderEmptyState,
  renderHeader,
  renderThemeToggle,
} from './view-shared.js'

describe('view-shared: COMMON_HEAD', () => {
  it('declares utf-8 as the charset', () => {
    expect(COMMON_HEAD).toContain('<meta charset="utf-8">')
  })

  it('declares the viewport for mobile sizing', () => {
    expect(COMMON_HEAD).toContain('<meta name="viewport"')
  })

  it('preloads all three fonts as woff2', () => {
    expect(COMMON_HEAD).toContain('href="/static/fonts/Inter-Regular.woff2"')
    expect(COMMON_HEAD).toContain('href="/static/fonts/Inter-SemiBold.woff2"')
    expect(COMMON_HEAD).toContain('href="/static/fonts/JetBrainsMono-Regular.woff2"')
    expect(COMMON_HEAD).toContain('as="font"')
    expect(COMMON_HEAD).toContain('type="font/woff2"')
    expect(COMMON_HEAD).toContain('crossorigin')
  })

  it('loads the bootstrap script before the stylesheet', () => {
    const scriptIdx = COMMON_HEAD.indexOf('<script>')
    const linkIdx = COMMON_HEAD.indexOf('<link rel="stylesheet"')
    expect(scriptIdx).toBeGreaterThan(-1)
    expect(linkIdx).toBeGreaterThan(-1)
    expect(scriptIdx).toBeLessThan(linkIdx)
  })

  it('the bootstrap script contains the FOUC-prevention logic', () => {
    expect(COMMON_HEAD).toContain('document.documentElement.setAttribute("data-theme"')
    expect(COMMON_HEAD).toContain('localStorage.getItem("theme")')
  })

  it('links the main stylesheet', () => {
    expect(COMMON_HEAD).toContain('href="/static/styles.css"')
  })
})

describe('view-shared: renderThemeToggle', () => {
  it('renders a button with the data-theme-toggle attribute', () => {
    const html = renderThemeToggle()
    expect(html).toContain('data-theme-toggle')
  })

  it('uses the plain class (no floating — slice #013 puts it inside the header)', () => {
    const html = renderThemeToggle()
    expect(html).toContain('theme-toggle')
    // The header (renderHeader) styles the button; the standalone
    // placeholder no longer needs the `-floating` modifier.
    expect(html).not.toContain('theme-toggle-floating')
  })

  it('has an aria-label and title for accessibility', () => {
    const html = renderThemeToggle()
    expect(html).toContain('aria-label=')
    expect(html).toContain('title=')
  })

  it('is a <button> with type="button" (so it does not submit a form)', () => {
    const html = renderThemeToggle()
    expect(html).toContain('<button type="button"')
  })
})

describe('view-shared: THEME_SCRIPT_TAG', () => {
  it('loads theme.js from /static/', () => {
    expect(THEME_SCRIPT_TAG).toContain('src="/static/theme.js"')
  })

  it('uses a <script> tag', () => {
    expect(THEME_SCRIPT_TAG.startsWith('<script')).toBe(true)
    expect(THEME_SCRIPT_TAG.endsWith('</script>')).toBe(true)
  })
})

describe('view-shared: CLIPBOARD_SCRIPT_TAG', () => {
  it('loads clipboard.js from /static/', () => {
    expect(CLIPBOARD_SCRIPT_TAG).toContain('src="/static/clipboard.js"')
  })

  it('uses a <script> tag', () => {
    expect(CLIPBOARD_SCRIPT_TAG.startsWith('<script')).toBe(true)
    expect(CLIPBOARD_SCRIPT_TAG.endsWith('</script>')).toBe(true)
  })
})

describe('view-shared: renderHeader (issue #013 slice 5)', () => {
  it('emits a <header class="site-header"> wrapper', () => {
    const html = renderHeader()
    expect(html).toContain('<header class="site-header">')
  })

  it('puts the brand on the left (links to /)', () => {
    const html = renderHeader()
    expect(html).toMatch(/<a class="brand" href="\/">[\s\S]*?Dashboard[\s\S]*?<\/a>/)
  })

  it('includes the theme-toggle button', () => {
    const html = renderHeader()
    expect(html).toContain('data-theme-toggle')
    expect(html).toContain('class="theme-toggle"')
  })

  it('includes the logout link', () => {
    const html = renderHeader()
    expect(html).toContain('href="/api/logout"')
    expect(html).toContain('>Logout</a>')
  })

  it('renders the search form by default', () => {
    const html = renderHeader()
    expect(html).toContain('class="search-form"')
    expect(html).toContain('action="/search"')
    expect(html).toContain('name="q"')
  })

  it('pre-fills the search input with initialQuery', () => {
    const html = renderHeader({ initialQuery: 'rust lang' })
    expect(html).toContain('value="rust lang"')
  })

  it('escapes HTML in initialQuery (XSS guard)', () => {
    const html = renderHeader({ initialQuery: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('omits the search form when showSearch: false', () => {
    const html = renderHeader({ showSearch: false })
    expect(html).not.toContain('class="search-form"')
  })

  it('keeps the theme toggle and logout when showSearch: false', () => {
    const html = renderHeader({ showSearch: false })
    expect(html).toContain('data-theme-toggle')
    expect(html).toContain('href="/api/logout"')
  })

  it('emits a hamburger button (issue #015, mobile nav)', () => {
    const html = renderHeader()
    expect(html).toContain('class="hamburger"')
    expect(html).toContain('data-hamburger')
    expect(html).toContain('aria-label="Toggle navigation"')
  })

  it('places the hamburger before the brand (leftmost in header)', () => {
    const html = renderHeader()
    const hamburgerIdx = html.indexOf('class="hamburger"')
    const brandIdx = html.indexOf('class="brand"')
    expect(hamburgerIdx).toBeGreaterThan(-1)
    expect(brandIdx).toBeGreaterThan(-1)
    expect(hamburgerIdx).toBeLessThan(brandIdx)
  })
})

describe('view-shared: renderEmptyState (issue #015)', () => {
  it('emits a no-bookmarks state with a setup-guide CTA', () => {
    const html = renderEmptyState({ kind: 'no-bookmarks' })
    expect(html).toContain('class="empty-state"')
    expect(html).toContain('class="empty-icon"')
    expect(html).toContain('class="empty-message"')
    expect(html).toContain('No bookmarks synced yet')
    expect(html).toContain('href="/settings"')
    expect(html).toContain('View setup guide')
  })

  it('emits an empty-folder state that names the folder', () => {
    const html = renderEmptyState({ kind: 'empty-folder', folderPath: 'Tech > Rust' })
    expect(html).toContain('No bookmarks in <strong>Tech &gt; Rust</strong>')
    expect(html).toContain('Show all bookmarks')
  })

  it('escapes folder paths containing HTML in the empty-folder message', () => {
    const html = renderEmptyState({ kind: 'empty-folder', folderPath: '<img src=x>' })
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).not.toContain('<img src=x>')
  })

  it('emits a no-results state that quotes the search query', () => {
    const html = renderEmptyState({ kind: 'no-results', query: 'rust async' })
    expect(html).toContain('No bookmarks match <strong>rust async</strong>')
  })

  it('escapes search queries containing HTML in the no-results message', () => {
    const html = renderEmptyState({ kind: 'no-results', query: '<script>alert(1)</script>' })
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('emits an empty-tag state with the tag name', () => {
    const html = renderEmptyState({ kind: 'empty-tag', tag: 'rust' })
    expect(html).toContain('No bookmarks tagged <strong>rust</strong>')
  })

  it('emits role="status" on the empty-state for screen readers', () => {
    const html = renderEmptyState({ kind: 'no-bookmarks' })
    expect(html).toContain('role="status"')
  })
})

describe('view-shared: HAMBURGER_SCRIPT_TAG (issue #015)', () => {
  it('is a <script> tag', () => {
    expect(HAMBURGER_SCRIPT_TAG).toMatch(/^<script>/)
    expect(HAMBURGER_SCRIPT_TAG).toMatch(/<\/script>$/)
  })

  it('wires clicks on [data-hamburger] to .sidebar data-open toggling', () => {
    // The handler must query the sidebar element and toggle its
    // data-open attribute — that's the contract the mobile CSS uses
    // to translate the sidebar in/out.
    expect(HAMBURGER_SCRIPT_TAG).toContain('[data-hamburger]')
    expect(HAMBURGER_SCRIPT_TAG).toContain('data-open')
    expect(HAMBURGER_SCRIPT_TAG).toContain('.sidebar')
  })

  it('updates aria-expanded on the button (a11y feedback)', () => {
    expect(HAMBURGER_SCRIPT_TAG).toContain('aria-expanded')
  })
})
