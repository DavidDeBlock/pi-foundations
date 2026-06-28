// theme.ts — issue #011
//
// Pure theme logic, deliberately DOM-free so it can be tested in node
// (vitest runs with `environment: 'node'`). The actual DOM wiring lives
// in `static/theme.js` (served as a static asset) and the FOUC-
// prevention script emitted into the page <head> via `view-shared.ts`.
//
// Why split: the same logic appears in three places
//   1. The inline <head> script (must run before stylesheet loads, no
//      module imports available)
//   2. The theme.js click handler (runs after page load)
//   3. Tests (verify the contract without a browser)
//
// Centralising the rules in this file means there's a single source of
// truth for "what is a valid stored theme" and "what does toggling do".

/** The two themes the dashboard supports. */
export type Theme = 'light' | 'dark'

/** localStorage key under which the user's preference is persisted. */
export const THEME_STORAGE_KEY = 'theme'

/** Default theme for first-time visitors (per the styling pass: dark). */
export const DEFAULT_THEME: Theme = 'dark'

const VALID_THEMES: ReadonlySet<Theme> = new Set<Theme>(['light', 'dark'])

/**
 * Resolve the initial theme from a raw localStorage value.
 *
 * Treats null (no value stored), undefined-ish values, or any other
 * string as "no preference" and falls back to {@link DEFAULT_THEME}.
 * This matches the inline <head> script's behaviour and is the only
 * place that decides what counts as a valid stored theme.
 */
export function getInitialTheme(stored: string | null | undefined): Theme {
  if (stored && VALID_THEMES.has(stored as Theme)) {
    return stored as Theme
  }
  return DEFAULT_THEME
}

/** Flip from one theme to the other. Pure: same input → same output. */
export function toggleTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark'
}

/**
 * The exact IIFE that runs synchronously in the page <head> to set
 * `data-theme` on <html> before the stylesheet loads. Kept as a string
 * here (not a function) because it must be embedded in the HTML
 * response, not executed server-side.
 *
 * The body is intentionally defensive: any localStorage failure (e.g.
 * disabled storage in private browsing) still results in a valid theme
 * being set, so the page never renders without a `data-theme`.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");document.documentElement.setAttribute("data-theme",t==="light"||t==="dark"?t:"${DEFAULT_THEME}")}catch(e){document.documentElement.setAttribute("data-theme","${DEFAULT_THEME}")}})();`
