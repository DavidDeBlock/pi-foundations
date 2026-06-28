// static-handler.test.ts — issue #008
//
// Tests for the hand-rolled static asset handler that serves
// categorize.js. Verifies the 200/404 contract and that the file
// content matches what's on disk.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { staticAssets } from './static-handler.js'

describe('static asset handler', () => {
  it('serves /static/categorize.js with the file contents and correct content-type', async () => {
    const app = new Hono()
    app.route('/static', staticAssets())

    const res = await app.request('/static/categorize.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8')

    // File on disk matches what the handler returns.
    const onDisk = readFileSync(
      resolve(process.cwd(), 'static', 'categorize.js'),
      'utf8',
    )
    expect(await res.text()).toBe(onDisk)
  })

  it('returns 404 for an unknown asset', async () => {
    const app = new Hono()
    app.route('/static', staticAssets())

    const res = await app.request('/static/does-not-exist.js')
    expect(res.status).toBe(404)
  })

  it('serves /static/search.js with the file contents and correct content-type', async () => {
    const app = new Hono()
    app.route('/static', staticAssets())

    const res = await app.request('/static/search.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8')

    const onDisk = readFileSync(
      resolve(process.cwd(), 'static', 'search.js'),
      'utf8',
    )
    expect(await res.text()).toBe(onDisk)
  })
})

// ── Issue #011: styling foundation assets ────────────────────────────────

describe('static asset handler (issue #011: styling foundation)', () => {
  it('serves /static/styles.css with the file contents and correct content-type', async () => {
    const app = new Hono()
    app.route('/static', staticAssets())

    const res = await app.request('/static/styles.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/css; charset=utf-8')

    const onDisk = readFileSync(
      resolve(process.cwd(), 'static', 'styles.css'),
      'utf8',
    )
    expect(await res.text()).toBe(onDisk)
  })

  it('serves /static/theme.js with the file contents and correct content-type', async () => {
    const app = new Hono()
    app.route('/static', staticAssets())

    const res = await app.request('/static/theme.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8')

    const onDisk = readFileSync(
      resolve(process.cwd(), 'static', 'theme.js'),
      'utf8',
    )
    expect(await res.text()).toBe(onDisk)
  })

  it('serves all three font files with the font/woff2 content-type', async () => {
    const app = new Hono()
    app.route('/static', staticAssets())

    const fonts = [
      '/static/fonts/Inter-Regular.woff2',
      '/static/fonts/Inter-SemiBold.woff2',
      '/static/fonts/JetBrainsMono-Regular.woff2',
    ]
    for (const path of fonts) {
      const res = await app.request(path)
      expect(res.status, `${path} should be 200`).toBe(200)
      expect(res.headers.get('Content-Type'), `${path} content-type`).toBe('font/woff2')
    }
  })

  it('returns 404 for an unknown font', async () => {
    const app = new Hono()
    app.route('/static', staticAssets())

    const res = await app.request('/static/fonts/DoesNotExist.woff2')
    expect(res.status).toBe(404)
  })
})

describe('static asset handler (issue #012: clipboard helper)', () => {
  it('serves /static/clipboard.js with the correct content-type', async () => {
    const app = new Hono()
    app.route('/static', staticAssets())

    const res = await app.request('/static/clipboard.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8')

    const onDisk = readFileSync(
      resolve(process.cwd(), 'static', 'clipboard.js'),
      'utf8',
    )
    expect(await res.text()).toBe(onDisk)
  })
})