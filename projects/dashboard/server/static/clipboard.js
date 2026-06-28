// clipboard.js — issue #012 (card layout slice)
//
// Global click handler for the card's "copy URL" action button
// (`[data-action="copy"]`). Lives in its own file so it's available on
// every page (read-only and categorize mode alike) and is small enough
// to inline at the bottom of <body> without a network round-trip.
//
// Behaviour:
//   1. Resolve the URL: prefer the button's `data-url` attribute, fall
//      back to the closest `[data-bookmark-url]` ancestor (the card).
//   2. Call `navigator.clipboard.writeText(url)`. If the modern API
//      fails (insecure context, denied permission, etc.) fall back to
//      a hidden `<textarea>` + `document.execCommand('copy')`. This
//      keeps copy working on plain HTTP (LAN-only deployment).
//   3. Briefly flash a "✓" glyph in the button for ~1s as visual
//      confirmation. The button restores its original label after the
//      flash so multiple rapid clicks all get feedback.
//
// This file intentionally has no module imports and no dependencies.
// It runs in every modern browser without transpilation.

(function () {
  var FLASH_MS = 1000
  var FLASH_GLYPH = '\u2713' // ✓

  function resolveUrl(button) {
    if (button.dataset.url) return button.dataset.url
    var card = button.closest('[data-bookmark-url]')
    if (card) return card.getAttribute('data-bookmark-url') || ''
    return ''
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    var ok = false
    try {
      ok = document.execCommand && document.execCommand('copy')
    } catch (e) {
      ok = false
    }
    document.body.removeChild(ta)
    return ok
  }

  function flash(button) {
    var original = button.textContent
    button.textContent = FLASH_GLYPH
    button.setAttribute('data-copied', 'true')
    setTimeout(function () {
      // Guard against the button being removed/replaced during the flash.
      if (button.isConnected) {
        button.textContent = original
        button.removeAttribute('data-copied')
      }
    }, FLASH_MS)
  }

  function onCopyClick(button) {
    var url = resolveUrl(button)
    if (!url) return
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      navigator.clipboard.writeText(url).then(
        function () { flash(button) },
        function () { if (fallbackCopy(url)) flash(button) }
      )
    } else if (fallbackCopy(url)) {
      flash(button)
    }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-action="copy"]')
    if (!btn) return
    e.preventDefault()
    onCopyClick(btn)
  })
})()