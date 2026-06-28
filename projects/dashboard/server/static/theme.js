// theme.js — issue #011
//
// Click handler for the theme toggle button. The bootstrap script (in
// the page <head>, see view-shared.ts) has already set the initial
// [data-theme] attribute on <html> before this file loads; we only
// own the toggle interaction here.
//
// Kept tiny on purpose: no module imports, no dependencies. Runs in
// every modern browser without transpilation. The matching pure logic
// (toggle rule, storage key, default) lives in server/src/theme.ts so
// it can be unit-tested in node.

(function () {
  var STORAGE_KEY = 'theme'
  var DARK = 'dark'
  var LIGHT = 'light'

  function readTheme() {
    var attr = document.documentElement.getAttribute('data-theme')
    return attr === LIGHT ? LIGHT : DARK
  }

  function writeTheme(next) {
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch (e) {
      // localStorage may be disabled (private mode, etc.). The toggle
      // still works for the current page; we just can't persist.
    }
  }

  function syncIcon(button, theme) {
    // ☀ in light mode (click to go dark), 🌙 in dark mode (click to go light).
    // Slice 1 uses emoji for portability; the icon set is replaced in
    // issue #013 alongside the header.
    button.textContent = theme === DARK ? '\u2600' : '\u{1F319}'
    button.setAttribute('aria-label',
      theme === DARK ? 'Switch to light theme' : 'Switch to dark theme')
    button.setAttribute('title',
      theme === DARK ? 'Switch to light theme' : 'Switch to dark theme')
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-theme-toggle]')
    if (!btn) return
    var next = readTheme() === DARK ? LIGHT : DARK
    writeTheme(next)
    syncIcon(btn, next)
  })

  // Sync the icon of any toggle button that already exists in the DOM
  // (the page render inserts it). Runs at parse-end via DOMContentLoaded.
  document.addEventListener('DOMContentLoaded', function () {
    var btns = document.querySelectorAll('[data-theme-toggle]')
    var theme = readTheme()
    for (var i = 0; i < btns.length; i++) {
      syncIcon(btns[i], theme)
    }
  })
})()
