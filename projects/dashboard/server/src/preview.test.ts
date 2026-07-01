// preview.test.ts — /preview/v2 visual preview page
//
// Smoke tests for the v2 preview route. Verifies:
//   - Auth is required (matches the rest of the dashboard).
//   - The page renders with a 200 + HTML when authenticated.
//   - Every compartment (Bookmarks, YouTube Saves, YouTube History,
//     Projects, Today) appears in the rendered HTML.
//   - The PREVIEW watermark is present.
//   - The email compartment is NOT present (it has its own real
//     surface at /email as of #023).
//   - Fixture data is wired in (at least one item from each compartment
//     shows up — guards against the renderers silently dropping data).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { resolve } from 'node:path'
import { createApp } from './app.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { InMemoryTokenStore } from './token-store.js'

const PASSWORD = 'correct horse battery staple'
const HASH = bcrypt.hashSync(PASSWORD, 10)

let db: Database
let tokenStore: InMemoryTokenStore

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
  tokenStore = new InMemoryTokenStore()
})

afterEach(() => {
  db.close()
})

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

describe('GET /preview/v2 — v2 visual preview', () => {
  it('requires auth (returns 401 without credentials)', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/preview/v2')
    expect(res.status).toBe(401)
  })

  it('renders the preview page with all five compartments', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/preview/v2', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).toMatch(/text\/html/)
    const html = await res.text()

    // Page chrome: shared header + sidebar.
    expect(html).toContain('Dashboard')
    expect(html).toContain('brand-name')

    // All five compartments present as sidebar buttons and tab strip.
    expect(html).toContain('data-compartment="bookmarks"')
    expect(html).toContain('data-compartment="youtube-saves"')
    expect(html).toContain('data-compartment="youtube-history"')
    expect(html).toContain('data-compartment="projects"')
    expect(html).toContain('data-compartment="today"')

    // Email has its own surface at /email as of #023 — no longer a
    // preview compartment. Asserting absence guards against
    // accidentally re-adding it to the v2 mockup.
    expect(html).not.toContain('data-compartment="email"')
    expect(html).not.toContain('data-panel="email"')

    // All five panels exist in the DOM (most are hidden, but rendered).
    expect(html).toContain('data-panel="bookmarks"')
    expect(html).toContain('data-panel="youtube-saves"')
    expect(html).toContain('data-panel="youtube-history"')
    expect(html).toContain('data-panel="projects"')
    expect(html).toContain('data-panel="today"')

    // PREVIEW markers are unmistakable.
    expect(html).toContain('PREVIEW')
    expect(html).toContain('preview-watermark')

    // Folder tree renders the unified folder tree (visible by default
    // because Bookmarks is the initial compartment).
    expect(html).toContain('sidebar-tree')
    expect(html).toContain('Tech')
  })

  it('shows fixture data from every compartment', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/preview/v2', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()

    // Bookmarks fixture
    expect(html).toContain('How to use SQLite FTS5')

    // YouTube saves fixture
    expect(html).toContain('Designing Data-Intensive Applications')

    // YouTube history fixture
    expect(html).toContain('Cooking with cast iron')

    // Projects fixture
    expect(html).toContain('Cozy Ledger')
    expect(html).toContain('Pixel Poesy')

    // Email fixture removed as of #023. Real email surface is at
    // /email; the preview should not show email data.

    // Today sub-view fixture — routines
    expect(html).toContain('Drink water')
    expect(html).toContain('Stretch 5 min')
    // Today sub-view — tasks (verify at least one with timing hint)
    expect(html).toContain('Finish Q3 draft')
    expect(html).toContain('before work')
    // Today sub-view — schedule
    expect(html).toContain('Morning walk')

    // This-week sub-view fixture (rendered, just hidden by default)
    expect(html).toContain('Yoga')
    expect(html).toContain('Cook with Sarah')

    // All-tasks sub-view fixture
    expect(html).toContain('Renew passport')
    expect(html).toContain('Submit expense report')

    // Work block is rendered (weekdays only) on the this-week view
    expect(html).toContain('Work')
  })

  it('Today compartment has its own inner sub-tab strip with 3 sub-views', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/preview/v2', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()

    // Inner tab strip buttons.
    expect(html).toContain('data-today-subtab="today"')
    expect(html).toContain('data-today-subtab="this-week"')
    expect(html).toContain('data-today-subtab="all-tasks"')

    // All 3 sub-panels are rendered inside the Today panel.
    expect(html).toContain('data-today-subpanel="today"')
    expect(html).toContain('data-today-subpanel="this-week"')
    expect(html).toContain('data-today-subpanel="all-tasks"')

    // Today sub-view is the default — check the active class is on the
    // 'today' subtab. The order of attributes in the rendered HTML puts
    // class before data-today-subtab, so we match against the full
    // button tag and look for both substrings.
    expect(html).toMatch(/<button[^>]*class="[^"]*today-subtab-active[^"]*"[^>]*data-today-subtab="today"/)
  })

  it('sets robots=noindex so the preview is not search-indexable', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/preview/v2', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('name="robots"')
    expect(html).toContain('noindex')
  })
})