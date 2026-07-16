// static-handler.ts — small static-file handler for browser-side assets
//
// The dashboard is server-rendered HTML and has no public/static
// directory; the assets we ship are listed in the ASSETS manifest
// below. Rather than introducing a static-file middleware library,
// we hand-roll a tiny handler that resolves the file from `static/`
// relative to the server's CWD.
//
// Tradeoff: this is a special-case handler. If the manifest ever
// grows past ~20 entries, swap to Hono's `serveStatic` middleware
// with a directory listing.
//
// Adding a new asset: append to ASSETS, then add a test in
// static-handler.test.ts that fetches the new path and asserts on
// its content-type.

import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STATIC_DIR = resolve(process.cwd(), 'static')

interface Asset {
  readonly path: string
  readonly contentType: string
}

const ASSETS: Record<string, Asset> = {
  '/site-icon.svg': {
    path: resolve(STATIC_DIR, 'site-icon.svg'),
    contentType: 'image/svg+xml; charset=utf-8',
  },
  '/categorize.js': {
    path: resolve(STATIC_DIR, 'categorize.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
  '/search.js': {
    path: resolve(STATIC_DIR, 'search.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
  '/clipboard.js': {
    path: resolve(STATIC_DIR, 'clipboard.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
  // ── Issue #011: styling foundation ─────────────────────────────
  '/styles.css': {
    path: resolve(STATIC_DIR, 'styles.css'),
    contentType: 'text/css; charset=utf-8',
  },
  '/theme.js': {
    path: resolve(STATIC_DIR, 'theme.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
  '/fonts/Inter-Regular.woff2': {
    path: resolve(STATIC_DIR, 'fonts', 'Inter-Regular.woff2'),
    contentType: 'font/woff2',
  },
  '/fonts/Inter-SemiBold.woff2': {
    path: resolve(STATIC_DIR, 'fonts', 'Inter-SemiBold.woff2'),
    contentType: 'font/woff2',
  },
  '/fonts/JetBrainsMono-Regular.woff2': {
    path: resolve(STATIC_DIR, 'fonts', 'JetBrainsMono-Regular.woff2'),
    contentType: 'font/woff2',
  },
}

/**
 * Hono sub-app exposing the static assets. Mount at `/static`:
 *
 *   app.route('/static', staticAssets())
 *
 * Returns 404 for anything not in the manifest. Files outside `static/`
 * cannot be reached (path resolution is fixed, not user-controlled).
 */
export function staticAssets(): Hono {
  const api = new Hono()

  api.get('/*', (c) => {
    const reqPath = new URL(c.req.url).pathname.replace(/^\/static/, '')
    const asset = ASSETS[reqPath]
    if (!asset) {
      return c.text('Not found', 404)
    }
    try {
      const body = readFileSync(asset.path, 'utf8')
      return c.body(body, 200, { 'Content-Type': asset.contentType })
    } catch (err) {
      // File missing on disk → surface as 500 so a deployment problem
      // is visible (vs. masking with 404).
      console.error(`static asset read failed: ${asset.path}`, err)
      return c.text('Internal server error', 500)
    }
  })

  return api
}
