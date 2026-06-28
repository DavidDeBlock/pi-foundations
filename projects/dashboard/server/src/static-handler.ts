// static-handler.ts — small static-file handler for categorize.js
//
// The dashboard is server-rendered HTML and has no public/static
// directory; the only static asset we ship is the browser-side
// categorize.js (issue #008). Rather than introducing a static-file
// middleware library, we hand-roll a tiny handler that resolves the
// file from `static/` relative to the server's CWD.
//
// Tradeoff: this is a special-case handler. If we ever need more
// static assets, swap to Hono's `serveStatic` middleware.

import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STATIC_DIR = resolve(process.cwd(), 'static')

interface Asset {
  readonly path: string
  readonly contentType: string
}

const ASSETS: Record<string, Asset> = {
  '/categorize.js': {
    path: resolve(STATIC_DIR, 'categorize.js'),
    contentType: 'application/javascript; charset=utf-8',
  },
  '/search.js': {
    path: resolve(STATIC_DIR, 'search.js'),
    contentType: 'application/javascript; charset=utf-8',
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