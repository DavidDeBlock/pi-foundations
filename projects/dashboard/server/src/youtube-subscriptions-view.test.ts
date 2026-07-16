// youtube-subscriptions-view.test.ts — issue YT-003
//
// UI smoke tests for `/subscriptions`. We don't need a full
// Playwright run — the page is server-rendered HTML with one
// inline JS handler — so we drive it with `app.request()` and
// assert on the markup directly. Auth gates every request.
//
// Coverage:
//   * Auth — 401 unauthenticated.
//   * Empty state — no subscriptions at all (connect prompt).
//   * Filtered empty state — filter=excluded with zero excluded.
//   * Search empty state — search returns nothing.
//   * List rendering — rows + thumbs + toggles + status slot.
//   * Filter chips + active state.
//   * Sync-now button + banner slot.
//   * Counts line (included/excluded/total).
//   * Pagination — present when items > limit, absent when not.
//   * Sync banner slot present in the DOM (the JS hydrates it).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { resolve } from 'node:path'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { subscriptionsViewApi } from './youtube-subscriptions-view.js'
import { upsertSubscription } from './youtube-subscriptions.js'
import { randomUUID } from 'node:crypto'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

const PASSWORD = 'secret'

interface TestEnv {
  db: Database
  app: Hono<{ Variables: AuthVariables }>
}

let env: TestEnv

beforeEach(async () => {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  const passwordHash = await bcrypt(PASSWORD)
  const tokenStore = new InMemoryTokenStore()
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash, tokenStore }))
  app.route('/subscriptions', subscriptionsViewApi({ db }))
  env = { db, app }
})

afterEach(() => {
  env.db.close()
})

async function bcrypt(p: string): Promise<string> {
  return (await import('bcryptjs')).default.hash(p, 4)
}

function basic(pass: string): string {
  return `Basic ${Buffer.from(`david:${pass}`).toString('base64')}`
}

function seedAccount(email: string = 'd@example.com'): string {
  const id = randomUUID()
  env.db.run(
    `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address,
        access_token_enc, refresh_token_enc, scopes)
     VALUES (?, 'youtube', ?, ?, 'x', 'y', 'youtube.readonly')`,
    [id, `g-${id}`, email],
  )
  return id
}

function seedFixture(): void {
  const acct = seedAccount()
  const rows: ReadonlyArray<{ id: string; title: string; thumb: string | null; included: boolean }> = [
    { id: 'UCa', title: 'Alpha', thumb: 'https://example.com/a.jpg', included: true },
    { id: 'UCb', title: 'Beta', thumb: null, included: false },
    { id: 'UCc', title: 'Gamma', thumb: 'https://example.com/c.jpg', included: true },
  ]
  for (const r of rows) {
    upsertSubscription(env.db, {
      googleAccountId: acct,
      channelId: r.id,
      channelTitle: r.title,
      channelThumbnailUrl: r.thumb,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    if (!r.included) {
      env.db.run(`UPDATE subscriptions SET is_included = 0 WHERE channel_id = ?`, [r.id])
    }
  }
}

// ─── Auth ──────────────────────────────────────────────────────────────────

describe('/subscriptions auth', () => {
  it('returns 401 unauthenticated', async () => {
    const res = await env.app.request('/subscriptions')
    expect(res.status).toBe(401)
  })
})

// ─── Empty states ─────────────────────────────────────────────────────────

describe('/subscriptions empty states', () => {
  it('shows the connect-prompt when there are zero subscriptions', async () => {
    seedAccount()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('No subscriptions yet')
    expect(html).toContain('Connect YouTube')
    expect(html).toContain('/api/youtube/oauth/start')
  })

  it('shows a filtered-empty state when filter=included returns 0', async () => {
    // Seed one EXCLUDED row → filter=included yields 0.
    const acct = seedAccount('only@example.com')
    upsertSubscription(env.db, {
      googleAccountId: acct,
      channelId: 'UCa',
      channelTitle: 'Alpha',
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    env.db.run(`UPDATE subscriptions SET is_included = 0 WHERE channel_id = 'UCa'`)
    const res = await env.app.request(
      '/subscriptions?filter=included',
      { headers: { authorization: basic(PASSWORD) } },
    )
    const html = await res.text()
    expect(html).toContain('No included subscriptions')
    expect(html).toContain('Show all')
  })

  it('shows a search-empty state with a clear-search CTA', async () => {
    seedFixture()
    const res = await env.app.request(
      '/subscriptions?search=zzz-no-match',
      { headers: { authorization: basic(PASSWORD) } },
    )
    const html = await res.text()
    expect(html).toContain('No subscriptions match')
    expect(html).toContain('Clear search')
  })
})

// ─── List rendering ───────────────────────────────────────────────────────

describe('/subscriptions list rendering', () => {
  it('renders every seeded row in title-ASC order', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    // Three rows expected; titles appear in title order: Alpha, Beta, Gamma.
    const alphaIdx = html.indexOf('Alpha')
    const betaIdx = html.indexOf('>Beta<')
    const gammaIdx = html.indexOf('Gamma')
    expect(alphaIdx).toBeGreaterThan(-1)
    expect(betaIdx).toBeGreaterThan(-1)
    expect(gammaIdx).toBeGreaterThan(-1)
    expect(alphaIdx).toBeLessThan(betaIdx)
    expect(betaIdx).toBeLessThan(gammaIdx)
  })

  it('renders a thumbnail <img> when one is known, fallback initials otherwise', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('https://example.com/a.jpg')
    expect(html).toContain('class="channel-thumb channel-thumb-fallback"')
    // Beta has no thumbnail → falls back to first letter "B".
    expect(html).toContain('>B<')
  })

  it('renders all three toggles per row with the right checked state', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    // Split on the row marker — but the JS also references the
    // attribute (in `querySelectorAll`), so we need a marker
    // that only appears in the markup. `<li class="subscription-row"`
    // is unique to the rendered row.
    const rows = html.split('<li class="subscription-row"').slice(1)
    expect(rows.length).toBe(3)
    // Find the row containing "Alpha" (is_included=true) → its
    // is_included toggle is checked.
    const alphaRow = rows.find((r) => r.includes('Alpha'))!
    expect(alphaRow).toMatch(/data-toggle="is_included"[^>]*checked/)
    expect(alphaRow).toContain('data-toggle="auto_fetch_transcripts"')
    expect(alphaRow).toContain('Auto transcripts')
    // Find the row containing "Beta" (is_included=false) → its
    // is_included toggle is NOT checked.
    const betaRow = rows.find((r) => r.includes('Beta'))!
    expect(betaRow).toMatch(/data-toggle="is_included"(?!.*\bchecked)/)
    expect(betaRow).not.toMatch(/data-toggle="is_included"[^>]*checked/)
  })

  it('renders each row with a status slot for the toggle PATCH feedback', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    // 3 rows → 3 status slots. The pattern `data-row-status>`
    // matches the element attribute (not the JS references to
    // `data-row-status-kind`, which don't have the trailing `>`).
    expect((html.match(/data-row-status>/g) ?? []).length).toBe(3)
  })

  it('renders a YouTube link per channel pointing at the channel page', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('https://www.youtube.com/channel/UCa')
    expect(html).toContain('https://www.youtube.com/channel/UCb')
    expect(html).toContain('https://www.youtube.com/channel/UCc')
  })
})

// ─── Filter chips ─────────────────────────────────────────────────────────

describe('/subscriptions filter chips', () => {
  it('renders all three chips and marks the active one', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions?filter=included', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-filter-chip="all"')
    expect(html).toContain('data-filter-chip="included"')
    expect(html).toContain('data-filter-chip="excluded"')
    // The chip element has the shape
    //   <a class="filter-chip filter-chip-active" href="..." data-filter-chip="included" aria-pressed="true">
    // so the regex looks for the class attribute containing
    // `filter-chip-active` and the same element carrying
    // `data-filter-chip="included"`.
    expect(html).toMatch(/<a[^>]*class="filter-chip filter-chip-active"[^>]*data-filter-chip="included"/)
    expect(html).not.toMatch(/<a[^>]*class="filter-chip filter-chip-active"[^>]*data-filter-chip="all"/)
    expect(html).not.toMatch(/<a[^>]*class="filter-chip filter-chip-active"[^>]*data-filter-chip="excluded"/)
  })

  it('preserves the search query across chip clicks', async () => {
    seedFixture()
    const res = await env.app.request(
      '/subscriptions?search=alpha&filter=all',
      { headers: { authorization: basic(PASSWORD) } },
    )
    const html = await res.text()
    expect(html).toContain('href="/subscriptions?filter=included&amp;search=alpha"')
    expect(html).toContain('href="/subscriptions?filter=excluded&amp;search=alpha"')
  })
})

// ─── Counts line ──────────────────────────────────────────────────────────

describe('/subscriptions counts line', () => {
  it('renders included/excluded/total counts', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    // 2 included, 1 excluded, 3 total.
    expect(html).toMatch(/<strong>3<\/strong>\s*total/)
    expect(html).toMatch(/<strong>2<\/strong>\s*included/)
    expect(html).toMatch(/<strong>1<\/strong>\s*excluded/)
  })
})

// ─── Sync-now button + banner slot ─────────────────────────────────────────

describe('/subscriptions sync-now wiring', () => {
  it('renders the Sync now button', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-sync-now')
    expect(html).toContain('Sync now')
  })

  it('renders an empty banner slot for the JS to populate', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-sync-banner-slot')
  })

  it('loads the page script that wires the toggle PATCH + Sync-now POST', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    // Sanity-check the inline script contains both handlers.
    expect(html).toContain('PATCH')
    expect(html).toContain('/api/youtube/sync')
  })
})

// ─── Pagination ───────────────────────────────────────────────────────────

describe('/subscriptions pagination', () => {
  it('omits pagination when the list fits in one page', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    // The page CSS always references `.subscriptions-pagination`,
    // so we assert on the actual nav element instead.
    expect(html).not.toMatch(/<nav[^>]*class="[^"]*subscriptions-pagination/)
  })

  it('renders prev/next when total > limit', async () => {
    seedFixture()
    // Add enough rows to force pagination with limit=2.
    // Reuse the same account that seedFixture created — both
    // helper calls land on the same row thanks to channel_id
    // uniqueness; we only need one more channel.
    const acct = seedAccount('delta@example.com')
    upsertSubscription(env.db, {
      googleAccountId: acct,
      channelId: 'UCd',
      channelTitle: 'Delta',
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    const res = await env.app.request('/subscriptions?limit=2', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    expect(html).toMatch(/<nav[^>]*class="[^"]*subscriptions-pagination/)
    expect(html).toContain('Page 1 of 2')
    expect(html).toContain('Page 2 \u2192')
  })
})

// ─── Layout chrome ────────────────────────────────────────────────────────

describe('/subscriptions layout chrome', () => {
  it('renders the header, sidebar, and tabs', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('class="site-header"')
    expect(html).toContain('class="sidebar"')
    expect(html).toContain('data-sidebar-nav="subscriptions"')
    expect(html).toContain('subscriptions-tab-active')
  })


  it('renders a "Videos" tab + sidebar item linking to /videos', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    // Tab + sidebar both link to /videos.
    expect(html).toMatch(/<a[^>]*href="\/videos"/)
    expect(html).toContain('data-sidebar-nav="videos"')
  })

  it('marks /subscriptions active in the sidebar (Videos is not active)', async () => {
    seedFixture()
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    // Find each whole <a ...> sidebar nav tag.
    const videosTag = html.match(/<a [^>]*data-sidebar-nav="videos"[^>]*>/)
    const subsTag = html.match(/<a [^>]*data-sidebar-nav="subscriptions"[^>]*>/)
    expect(videosTag).toBeTruthy()
    expect(videosTag![0]).not.toContain('compartment-button-active')
    expect(subsTag).toBeTruthy()
    expect(subsTag![0]).toContain('context-link-active')
    expect(subsTag![0]).toContain('aria-current="page"')
  })

  it('escapes HTML in channel titles (defence in depth)', async () => {
    seedFixture()
    const acct = seedAccount('xss@example.com')
    upsertSubscription(env.db, {
      googleAccountId: acct,
      channelId: 'UCx',
      channelTitle: '<script>alert(1)</script>',
      channelThumbnailUrl: null,
      subscribedAt: '2024-01-01T00:00:00.000Z',
    })
    const res = await env.app.request('/subscriptions', {
      headers: { authorization: basic(PASSWORD) },
    })
    const html = await res.text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
