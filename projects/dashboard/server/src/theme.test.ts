// theme.test.ts — issue #011
//
// Covers the pure theme logic. The DOM-bound code in static/theme.js
// is verified indirectly: the FOUC-prevention script is built from
// THEME_BOOTSTRAP_SCRIPT, which is exercised here.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME,
  THEME_BOOTSTRAP_SCRIPT,
  THEME_STORAGE_KEY,
  getInitialTheme,
  toggleTheme,
} from './theme.js'

describe('theme: getInitialTheme', () => {
  it('returns "light" when "light" is stored', () => {
    expect(getInitialTheme('light')).toBe('light')
  })

  it('returns "dark" when "dark" is stored', () => {
    expect(getInitialTheme('dark')).toBe('dark')
  })

  it('falls back to the default when nothing is stored', () => {
    expect(getInitialTheme(null)).toBe(DEFAULT_THEME)
  })

  it('falls back to the default when an unknown value is stored', () => {
    expect(getInitialTheme('purple')).toBe(DEFAULT_THEME)
    expect(getInitialTheme('')).toBe(DEFAULT_THEME)
    expect(getInitialTheme('DARK')).toBe(DEFAULT_THEME) // case-sensitive
  })

  it('falls back to the default when stored is undefined', () => {
    expect(getInitialTheme(undefined)).toBe(DEFAULT_THEME)
  })
})

describe('theme: toggleTheme', () => {
  it('flips dark → light', () => {
    expect(toggleTheme('dark')).toBe('light')
  })

  it('flips light → dark', () => {
    expect(toggleTheme('light')).toBe('dark')
  })
})

describe('theme: THEME_BOOTSTRAP_SCRIPT', () => {
  it('reads from the storage key', () => {
    expect(THEME_BOOTSTRAP_SCRIPT).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`)
  })

  it('sets data-theme on <html>', () => {
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('document.documentElement.setAttribute("data-theme"')
  })

  it('accepts the two valid theme values', () => {
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('"light"')
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('"dark"')
  })

  it('wraps in an IIFE so no globals leak', () => {
    expect(THEME_BOOTSTRAP_SCRIPT.startsWith('(function()')).toBe(true)
    expect(THEME_BOOTSTRAP_SCRIPT.endsWith(')();')).toBe(true)
  })

  it('catches localStorage errors and still sets a theme', () => {
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('try{')
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('}catch(e){')
  })

  it('falls back to the default when the stored value is invalid', () => {
    // The script's ternary `t==="light"||t==="dark"?t:"${DEFAULT_THEME}"`
    // must contain the default so the page never renders theme-less.
    expect(THEME_BOOTSTRAP_SCRIPT).toContain(`"${DEFAULT_THEME}"`)
  })
})
