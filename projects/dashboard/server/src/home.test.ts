import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { resolve } from 'node:path'
import { createApp } from './app.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { InMemoryTokenStore } from './token-store.js'
import { applySync, type SyncInput } from './sync.js'
import { attachTagsToBookmark } from './tags.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────

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

// ─── Home page ────────────────────────────────────────────────────────────

describe('GET / — activity feed landing page', () => {
  it('shows the empty-state message when no bookmarks have been synced', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('No bookmarks synced yet')
  })

  it('renders the folder tree in the sidebar after a sync', async () => {
    const input: SyncInput = {
      folders: [
        { chromeId: 'root', parentChromeId: null, name: 'Bookmarks bar' },
        { chromeId: 'news', parentChromeId: 'root', name: 'News' },
        { chromeId: 'tech', parentChromeId: 'root', name: 'Tech' },
        { chromeId: 'web', parentChromeId: 'tech', name: 'Web' },
      ],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'web' },
      ],
    }
    applySync(db, input)

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()

    // Sidebar: every folder name appears.
    expect(html).toContain('Bookmarks bar')
    expect(html).toContain('News')
    expect(html).toContain('Tech')
    expect(html).toContain('Web')

    // Activity feed: the bookmark appears in the main area.
    expect(html).toContain('>A</a>')
    expect(html).toContain('href="https://a.com"')
    // The edit button is the equivalent affordance in categorize mode
    // (slice #012: card layout removed the explicit "details →" link in
    // favour of the action row). The non-categorize path keeps the
    // detail-page link via the same button.
    expect(html).toContain('data-edit-title="true"')
  })

  it('renders the full tree structure (nested <ul>s in sidebar)', async () => {
    const input: SyncInput = {
      folders: [
        { chromeId: 'root', parentChromeId: null, name: 'Root' },
        { chromeId: 'a', parentChromeId: 'root', name: 'A' },
        { chromeId: 'a1', parentChromeId: 'a', name: 'A1' },
      ],
      bookmarks: [],
    }
    applySync(db, input)

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()

    // At least 2 levels of <ul> (root + nested children).
    const ulCount = (html.match(/<ul>/g) ?? []).length
    expect(ulCount).toBeGreaterThanOrEqual(2)
    expect(html).toContain('A1')
  })

  it('renders within 500ms on a 1,000-bookmark bulk sync (AC #5 smoke)', async () => {
    // Seed 1,000 bookmarks across a single folder, mirroring the AC.
    // All share the same `created_at` (bulk insert); the differ's
    // id-DESC tiebreaker determines order. We only need to verify that
    // a) the page renders fast enough, b) it actually contains items.
    const bookmarks = Array.from({ length: 1000 }, (_, i) => ({
      chromeId: `b${i}`,
      url: `https://example.com/${i}`,
      title: `Bookmark ${i}`,
      folderChromeId: 'f1',
    }))
    applySync(db, {
      folders: [
        { chromeId: 'f1', parentChromeId: null, name: 'Bookmarks bar' },
      ],
      bookmarks,
    })

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const start = Date.now()
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const elapsed = Date.now() - start

    expect(res.status).toBe(200)
    expect(elapsed).toBeLessThan(500)
    const html = await res.text()
    // Sanity: the page rendered SOMETHING from the feed (not empty).
    expect(html).toMatch(/Bookmark \d+/) // at least one rendered title
    expect(html).toContain('Page 1 of 20') // 1000 / 50 = 20 pages
    expect(html).toContain('1–50 of 1000') // the range header
  })

  it('honors ?page and ?perPage query params', async () => {
    const bookmarks = Array.from({ length: 60 }, (_, i) => ({
      chromeId: `b${i}`,
      url: `https://example.com/${i}`,
      title: `B${i.toString().padStart(2, '0')}`,
      folderChromeId: 'f1',
    }))
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bookmarks bar' }],
      bookmarks,
    })

    // Force unique timestamps so the page-2 assertion is unambiguous.
    // (Bulk insert gives them all the same created_at; the id-DESC
    // tiebreaker would put items in reverse insertion order.)
    for (let i = 0; i < 60; i++) {
      // 2024-01-01 + i minutes gives i=0 the oldest, i=59 the newest.
      const ts = new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString()
      db.run('UPDATE bookmarks SET created_at = ? WHERE chrome_id = ?', [ts, `b${i}`])
    }

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/?page=2&perPage=20', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Page 2 of 3') // 60 / 20 = 3 pages
    // Newest items appear first: B59 (newest) → B40 (oldest on page 1).
    // Page 2: B39 → B20. So B59 should NOT be on page 2; B39 SHOULD be.
    expect(html).not.toContain('>B59</a>')
    expect(html).toContain('>B39</a>')
    // Sanity: page 1 has B59.
    const page1 = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html1 = await page1.text()
    expect(html1).toContain('>B59</a>')
  })

  it('uses the bookmark title (escaped) and links to the detail page', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'My & "special" title', folderChromeId: 'f1' },
      ],
    })

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // HTML-escaped form of: My & "special" title
    expect(html).toContain('My &amp; &quot;special&quot; title')
    // The ✏ edit button is the inline-rename affordance in categorize
    // mode (slice #012). In non-categorize mode this same button is an
    // <a href="/bookmarks/..."> linking to the detail page.
    expect(html).toContain('data-edit-title="true"')
    expect(html).toContain('data-action="edit"')
  })
})

// ─── Bookmark detail page ─────────────────────────────────────────────────

describe('GET /bookmarks/:id — bookmark detail', () => {
  it('returns 404 for a missing id', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/bookmarks/does-not-exist', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(404)
    const html = await res.text()
    expect(html).toContain('Bookmark not found')
    expect(html).toContain('href="/"')
  })

  it('renders title, URL, folder path, and dates for an existing bookmark', async () => {
    applySync(db, {
      folders: [
        { chromeId: 'f1', parentChromeId: null, name: 'Bookmarks bar' },
        { chromeId: 'f2', parentChromeId: 'f1', name: 'Tech' },
      ],
      bookmarks: [
        { chromeId: 'b1', url: 'https://example.com', title: 'Example Site', folderChromeId: 'f2' },
      ],
    })
    const serverId = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])?.id
    expect(serverId).toBeTruthy()

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request(`/bookmarks/${serverId}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Example Site')
    expect(html).toContain('https://example.com')
    expect(html).toContain('Bookmarks bar &gt; Tech')
    expect(html).toContain('Created')
    expect(html).toContain('Updated')
    expect(html).toContain('never') // last_seen_at not set
    expect(html).toContain('Back to activity feed')
  })

  it('requires auth (401 without a valid credential)', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    })
    const serverId = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])?.id

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request(`/bookmarks/${serverId}`)
    expect(res.status).toBe(401)
  })
})

// ─── Categorize UI surface (#008) ────────────────────────────────────────

describe('GET / — categorize UI markers', () => {
  it('embeds data-bookmark-id on each card', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    })
    const id = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])?.id

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain(`data-bookmark-id="${id}"`)
  })

  it('renders the categorize.js <script> tag', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('/static/categorize.js')
  })

  it('renders the sidebar + button for creating folders', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-add-folder')
  })

  it('renders tag datalist options for autocomplete', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    })
    const id = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])?.id
    // Seed two tags.
    db.run('INSERT INTO tags (id, name) VALUES (?, ?)', ['t1', 'postgres'])
    db.run('INSERT INTO tags (id, name) VALUES (?, ?)', ['t2', 'database'])
    db.run('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)', [id, 't1'])

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // Datalist id is per-bookmark so the input can find its own suggestions.
    expect(html).toContain(`id="tag-suggestions-${id}"`)
    expect(html).toContain('<option value="postgres">')
    expect(html).toContain('<option value="database">')
  })

  it('renders the tag input on every card', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    })
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-tag-input')
    expect(html).toContain('placeholder="add tag\u2026"')
  })

  it('renders the folder-select dropdown on every card', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    })
    const serverFolderId = db.get<{ id: string }>('SELECT id FROM folders WHERE chrome_id = ?', ['f1'])?.id
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-folder-select')
    // The dropdown should include the seeded folder as an option.
    expect(html).toContain(`value="${serverFolderId}"`)
  })

  it('renders the delete button on each card', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    })
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-delete-bookmark')
  })

  it('renders the title-edit button on each card', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    })
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-edit-title')
  })

  it('renders data-remove-tag hook on each tag chip', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    })
    const serverId = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])?.id
    if (!serverId) throw new Error('seed failed')
    attachTagsToBookmark(db, serverId, ['demo', 'smoke'])

    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // One × button per tag.
    expect(html.match(/data-remove-tag=/g)?.length).toBe(2)
    expect(html).toContain('data-tag="demo"')
    expect(html).toContain('data-tag="smoke"')
  })
})

describe('GET /bookmarks/:id — categorize UI markers', () => {
  it('embeds data-bookmark-id via the categorize scope', async () => {
    applySync(db, {
      folders: [{ chromeId: 'f1', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'f1' },
      ],
    })
    const serverId = db.get<{ id: string }>('SELECT id FROM bookmarks WHERE chrome_id = ?', ['b1'])?.id
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request(`/bookmarks/${serverId}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('data-folder-select')
    expect(html).toContain('data-tag-input')
    expect(html).toContain('data-edit-title')
    expect(html).toContain('data-delete-bookmark')
    expect(html).toContain('/static/categorize.js')
  })
})
describe('GET /?folder=:id — sidebar folder filter', () => {
  it('renders the sidebar folders as clickable filter links', async () => {
    applySync(db, {
      folders: [
        { chromeId: 'fbb', parentChromeId: null, name: 'Bar' },
        { chromeId: 'fte', parentChromeId: 'fbb', name: 'Tech' },
      ],
      bookmarks: [],
    })
    const techId = db.get<{ id: string }>('SELECT id FROM folders WHERE name = ?', ['Tech'])?.id
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain(`href="/?folder=${techId}"`)
    // The label is wrapped in <a><span>…</span></a> in categorize mode.
    expect(html).toMatch(/<a[^>]+class="folder-label"[^>]+href="\/\?folder=[^"]+"[^>]*>[\s\S]*?<span[^>]+data-folder-name[^>]*>Tech<\/span>[\s\S]*?<\/a>/)
  })

  it('filters the feed to only the named folder + descendants', async () => {
    applySync(db, {
      folders: [
        { chromeId: 'fbb', parentChromeId: null, name: 'Bar' },
        { chromeId: 'fte', parentChromeId: 'fbb', name: 'Tech' },
        { chromeId: 'fwe', parentChromeId: 'fte', name: 'Web' },
        { chromeId: 'fco', parentChromeId: 'fbb', name: 'Cooking' },
      ],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'Tech-book', folderChromeId: 'fte' },
        { chromeId: 'b2', url: 'https://b.com', title: 'Web-book', folderChromeId: 'fwe' },
        { chromeId: 'b3', url: 'https://c.com', title: 'Cook-book', folderChromeId: 'fco' },
      ],
    })
    const techId = db.get<{ id: string }>('SELECT id FROM folders WHERE name = ?', ['Tech'])?.id
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request(`/?folder=${techId}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('Tech-book')
    expect(html).toContain('Web-book')
    expect(html).not.toContain('Cook-book')
    // Active folder is highlighted.
    expect(html).toMatch(/<a[^>]+class="folder-label sidebar-link-active"[^>]+data-active="true"[^>]*>[\s\S]*?Tech[\s\S]*?<\/a>/)
    // Filter label in the heading (non-empty branch uses <span>, empty uses <strong>).
    expect(html).toContain('in Bar &gt; Tech')
  })

  it('falls back to the unfiltered feed for an unknown folder id', async () => {
    applySync(db, {
      folders: [{ chromeId: 'fbb', parentChromeId: null, name: 'Bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: 'fbb' },
      ],
    })
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/?folder=nonexistent-id', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // No filter applied → all bookmarks show.
    expect(html).toContain('A')
    expect(html).not.toContain('data-active="true"')
  })

  it('renders the empty-state message when the filter matches nothing', async () => {
    applySync(db, {
      folders: [
        { chromeId: 'fbb', parentChromeId: null, name: 'Bar' },
        { chromeId: 'fte', parentChromeId: 'fbb', name: 'Empty' },
      ],
      bookmarks: [],
    })
    const emptyId = db.get<{ id: string }>('SELECT id FROM folders WHERE name = ?', ['Empty'])?.id
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request(`/?folder=${emptyId}`, {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('No bookmarks in')
    expect(html).toContain('Show all bookmarks')
  })
})

// ─── Slice #026: email cross-link in the home page ───────────────────
//
// The activity-feed API queries the email_accounts + emails tables on
// every request to populate the sidebar's Email section + the inbox
// teaser line above the feed list. These tests ride the real HTTP
// route to verify the wiring is intact end-to-end.

describe('GET / — email cross-link (slice #026)', () => {
  /** Seed a connected Gmail account + a couple of unread emails. */
  function seedEmailAccount(unreadIds: string[], readIds: string[] = []) {
    const accountId = 'acc-1'
    db.run(
      `INSERT INTO email_accounts (id, provider, email_address, access_token_enc, refresh_token_enc, token_expires_at, last_sync_at)
       VALUES (?, 'gmail', ?, 'enc-a', 'enc-r', '2026-12-31T00:00:00.000Z', ?)`,
      [accountId, 'me@gmail.com', new Date().toISOString()],
    )
    for (let i = 0; i < unreadIds.length; i++) {
      db.run(
        `INSERT INTO emails (id, account_id, thread_id, subject, sender, sender_email, received_at, is_unread, snippet, body_plain)
         VALUES (?, ?, 't-1', ?, 'a@b.com', 'a@b.com', '2024-06-01T10:00:00.000Z', 1, '', '')`,
        [unreadIds[i]!, accountId, `unread ${i}`],
      )
    }
    for (let i = 0; i < readIds.length; i++) {
      db.run(
        `INSERT INTO emails (id, account_id, thread_id, subject, sender, sender_email, received_at, is_unread, snippet, body_plain)
         VALUES (?, ?, 't-2', ?, 'a@b.com', 'a@b.com', '2024-06-01T10:00:00.000Z', 0, '', '')`,
        [readIds[i]!, accountId, `read ${i}`],
      )
    }
  }

  it('renders the sidebar Bookmarks entry with the active class when on /', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // Bookmarks is the active compartment on the activity feed page.
    expect(html).toMatch(/<a[^>]*class="[^"]*compartment-button-active[^"]*"[^>]*href="\/"/)
    expect(html).toContain('>Bookmarks</span>')
  })

  it('renders the Email section in the sidebar with unread count when an account is connected', async () => {
    seedEmailAccount(['m-1', 'm-2', 'm-3'])
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // Sidebar Email link with the unread badge.
    expect(html).toMatch(/<a[^>]*class="[^"]*compartment-button[^"]*"[^>]*href="\/email"/)
    expect(html).toContain('aria-label="3 unread"')
  })

  it('renders the inbox teaser line with the correct unread count', async () => {
    seedEmailAccount(['m-1', 'm-2'])
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toMatch(/class="inbox-teaser"/)
    expect(html).toMatch(/<a[^>]*class="inbox-teaser-link"[^>]*href="\/email"/)
    expect(html).toContain('2 unread emails')
  })

  it('excludes hidden messages from the unread count', async () => {
    seedEmailAccount(['m-1', 'm-2'])
    // Hide one of the two unread messages.
    db.run('UPDATE emails SET hidden_at = ? WHERE id = ?', [
      new Date().toISOString(), 'm-1',
    ])
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // Hidden row is excluded — count drops to 1.
    expect(html).toContain('1 unread email')
    expect(html).not.toContain('2 unread emails')
  })

  it('keeps Email discoverable but omits the teaser when no account is connected', async () => {
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    expect(html).toContain('>Email</span>')
    expect(html).toContain('data-sidebar-nav="email"')
    expect(html).not.toContain('data-inbox-teaser')
    // Bookmarks is always present.
    expect(html).toContain('>Bookmarks</span>')
  })

  it('shows the "no unread" state when connected but everything is read or hidden', async () => {
    seedEmailAccount([], ['m-1'])
    const app = createApp({ passwordHash: HASH, tokenStore, db })
    const res = await app.request('/', {
      headers: { authorization: basicHeader('david', PASSWORD) },
    })
    const html = await res.text()
    // Teaser line shows the no-unread copy, not "0 unread emails".
    expect(html).toContain('Inbox \u2014 no unread')
  })
})
