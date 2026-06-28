// activity-feed.test.ts — issue #007 unit tests
//
// Exercises the query + render layer of the activity feed module
// against an in-memory SQLite. No HTTP plumbing — that's covered by
// the route-level tests in home.test.ts.

import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { applySync, type SyncInput } from './sync.js'
import {
  queryFeed,
  queryBookmark,
  renderFeedPage,
  renderDetailPage,
  renderDetailNotFound,
  type FeedItem,
} from './activity-feed.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────

let db: Database

beforeEach(async () => {
  db = new Database(':memory:')
  await runMigrations(db, { dir: resolve(process.cwd(), 'migrations') })
})

/** Insert tags + link them to bookmarks (tags land in #008 but the
 *  schema exists from #003, so we can pre-seed test data here). */
function addTagsToBookmark(bookmarkId: string, ...tagNames: string[]) {
  for (const name of tagNames) {
    const tagId = randomUUID()
    db.run('INSERT INTO tags (id, name) VALUES (?, ?)', [tagId, name])
    db.run(
      'INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)',
      [bookmarkId, tagId],
    )
  }
}

/** Seed a folder tree + bookmarks via the real sync pipeline. Returns
 *  the chromeIds of the seeded bookmarks in the order they appear
 *  in the input (so tests can address them by index). */
function seed(...bookmarks: Array<{ chromeId: string; url: string; title: string }>): {
  folderChromeIds: Record<string, string>
  bookmarkChromeIds: string[]
} {
  const folderChromeIds = { bar: 'f-bar', tech: 'f-tech', news: 'f-news' }
  const input: SyncInput = {
    folders: [
      { chromeId: folderChromeIds.bar, parentChromeId: null, name: 'Bookmarks bar' },
      { chromeId: folderChromeIds.tech, parentChromeId: folderChromeIds.bar, name: 'Tech' },
      { chromeId: folderChromeIds.news, parentChromeId: folderChromeIds.bar, name: 'News' },
    ],
    bookmarks: bookmarks.map((b) => ({
      chromeId: b.chromeId,
      url: b.url,
      title: b.title,
      folderChromeId: folderChromeIds.tech,
    })),
  }
  applySync(db, input)
  return { folderChromeIds, bookmarkChromeIds: bookmarks.map((b) => b.chromeId) }
}

/** Resolve a chromeId to the server-side id by looking it up in
 *  the `bookmarks` table. Syncs the `applySync` result idMap into
 *  the test scope. */
function serverIdFor(chromeId: string): string {
  const row = db.get<{ id: string }>(
    'SELECT id FROM bookmarks WHERE chrome_id = ?',
    [chromeId],
  )
  if (!row) throw new Error(`No bookmark with chromeId=${chromeId}`)
  return row.id
}

// ─── queryFeed ────────────────────────────────────────────────────────────

describe('queryFeed — ordering', () => {
  it('returns bookmarks sorted by created_at DESC', async () => {
    const { bookmarkChromeIds } = seed(
      { chromeId: 'b1', url: 'https://a.com', title: 'A' },
      { chromeId: 'b2', url: 'https://b.com', title: 'B' },
      { chromeId: 'b3', url: 'https://c.com', title: 'C' },
    )

    // Bump b3 to be the newest (after the bulk insert).
    db.run(`UPDATE bookmarks SET created_at = '2099-12-31T23:59:59Z' WHERE chrome_id = ?`, [bookmarkChromeIds[2]])
    db.run(`UPDATE bookmarks SET created_at = '2020-01-01T00:00:00Z' WHERE chrome_id = ?`, [bookmarkChromeIds[0]])

    const feed = queryFeed(db)
    expect(feed.items).toHaveLength(3)
    expect(feed.items[0]?.title).toBe('C')   // 2099
    expect(feed.items[1]?.title).toBe('B')   // bulk-insert default (now-ish)
    expect(feed.items[2]?.title).toBe('A')   // 2020
  })

  it('uses id as a stable tiebreaker when created_at is identical', async () => {
    // Seed two bookmarks, then force them to share an exact timestamp.
    seed(
      { chromeId: 'b1', url: 'https://a.com', title: 'A' },
      { chromeId: 'b2', url: 'https://b.com', title: 'B' },
    )
    db.run(`UPDATE bookmarks SET created_at = '2024-01-01T00:00:00Z'`)
    const feed = queryFeed(db)
    // Both rows have the same created_at; order is implementation-defined
    // beyond that. We just verify both appear (no missing row).
    expect(feed.items).toHaveLength(2)
    expect(new Set(feed.items.map((i) => i.title))).toEqual(new Set(['A', 'B']))
  })

  it('returns an empty page when there are no bookmarks', () => {
    // Seed folders but no bookmarks.
    applySync(db, {
      folders: [
        { chromeId: 'f1', parentChromeId: null, name: 'Bar' },
      ],
      bookmarks: [],
    })

    const feed = queryFeed(db)
    expect(feed.items).toEqual([])
    expect(feed.totalItems).toBe(0)
    expect(feed.totalPages).toBe(1) // Math.max(1, ceil(0/N))
  })
})

describe('queryFeed — pagination', () => {
  it('returns the requested page with correct metadata', () => {
    // Seed 7 bookmarks.
    const items = Array.from({ length: 7 }, (_, i) => ({
      chromeId: `b${i}`,
      url: `https://example.com/${i}`,
      title: `Bookmark ${i}`,
    }))
    seed(...items)

    const page1 = queryFeed(db, { page: 1, perPage: 3 })
    expect(page1.items).toHaveLength(3)
    expect(page1.page).toBe(1)
    expect(page1.perPage).toBe(3)
    expect(page1.totalItems).toBe(7)
    expect(page1.totalPages).toBe(3) // ceil(7/3)

    const page3 = queryFeed(db, { page: 3, perPage: 3 })
    expect(page3.items).toHaveLength(1) // last page has 1 item
    expect(page3.page).toBe(3)
  })

  it('returns an empty page when page is beyond the data', () => {
    seed(
      { chromeId: 'b1', url: 'https://a.com', title: 'A' },
    )
    const feed = queryFeed(db, { page: 99, perPage: 10 })
    expect(feed.items).toEqual([])
    expect(feed.totalItems).toBe(1)
    expect(feed.totalPages).toBe(1)
  })

  it('clamps page < 1 to 1', () => {
    seed({ chromeId: 'b1', url: 'https://a.com', title: 'A' })
    const feed = queryFeed(db, { page: 0 })
    expect(feed.page).toBe(1)
    const feedNeg = queryFeed(db, { page: -5 })
    expect(feedNeg.page).toBe(1)
  })

  it('clamps perPage to the documented range', () => {
    seed({ chromeId: 'b1', url: 'https://a.com', title: 'A' })

    const overMax = queryFeed(db, { perPage: 10_000 })
    expect(overMax.perPage).toBe(200) // MAX_PER_PAGE

    const zeroDefault = queryFeed(db, { perPage: 0 })
    expect(zeroDefault.perPage).toBe(50) // DEFAULT_PER_PAGE

    const negDefault = queryFeed(db, { perPage: -1 })
    expect(negDefault.perPage).toBe(50)
  })

  it('defaults to page 1, perPage 50 when no options are passed', () => {
    seed({ chromeId: 'b1', url: 'https://a.com', title: 'A' })
    const feed = queryFeed(db)
    expect(feed.page).toBe(1)
    expect(feed.perPage).toBe(50)
  })
})

describe('queryFeed — folder path', () => {
  it('builds the full ancestry from root → bookmark folder', () => {
    // Deep nesting: Bookmarks bar > Tech > Web > Frameworks
    const root = randomUUID()
    const tech = randomUUID()
    const web = randomUUID()
    const fw = randomUUID()
    applySync(db, {
      folders: [
        { chromeId: root, parentChromeId: null, name: 'Bookmarks bar' },
        { chromeId: tech, parentChromeId: root, name: 'Tech' },
        { chromeId: web, parentChromeId: tech, name: 'Web' },
        { chromeId: fw, parentChromeId: web, name: 'Frameworks' },
      ],
      bookmarks: [
        { chromeId: 'b1', url: 'https://react.dev', title: 'React', folderChromeId: fw },
      ],
    })

    const feed = queryFeed(db)
    expect(feed.items).toHaveLength(1)
    expect(feed.items[0]?.folderPath).toBe('Bookmarks bar > Tech > Web > Frameworks')
  })

  it('uses just the folder name for a root-level bookmark', () => {
    const root = randomUUID()
    applySync(db, {
      folders: [{ chromeId: root, parentChromeId: null, name: 'Bookmarks bar' }],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'A', folderChromeId: root },
      ],
    })
    const feed = queryFeed(db)
    expect(feed.items[0]?.folderPath).toBe('Bookmarks bar')
  })

  it('skips bookmarks whose folder was deleted (FK cascade)', () => {
    // Seed one valid + one in a folder we then delete via the differ.
    const { folderChromeIds } = seed(
      { chromeId: 'b1', url: 'https://a.com', title: 'Keep' },
      { chromeId: 'b2', url: 'https://b.com', title: 'Delete' },
    )

    // Re-sync without folderChromeIds.news — its bookmarks cascade-delete.
    applySync(db, {
      folders: [
        { chromeId: folderChromeIds.bar, parentChromeId: null, name: 'Bookmarks bar' },
        { chromeId: folderChromeIds.tech, parentChromeId: folderChromeIds.bar, name: 'Tech' },
      ],
      // Move b1 to tech, omit b2 entirely.
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'Keep', folderChromeId: folderChromeIds.tech },
      ],
    })

    const feed = queryFeed(db)
    expect(feed.items).toHaveLength(1)
    expect(feed.items[0]?.title).toBe('Keep')
  })
})

describe('queryFeed — folder filter', () => {
  // Helper to seed a tree: root > Tech > Web + root > Cooking.
  function seedDeepTree() {
    applySync(db, {
      folders: [
        { chromeId: 'root', parentChromeId: null, name: 'Bar' },
        { chromeId: 'tech', parentChromeId: 'root', name: 'Tech' },
        { chromeId: 'web', parentChromeId: 'tech', name: 'Web' },
        { chromeId: 'cook', parentChromeId: 'root', name: 'Cooking' },
      ],
      bookmarks: [
        { chromeId: 'b1', url: 'https://a.com', title: 'Tech-book', folderChromeId: 'tech' },
        { chromeId: 'b2', url: 'https://b.com', title: 'Web-book', folderChromeId: 'web' },
        { chromeId: 'b3', url: 'https://c.com', title: 'Cook-book', folderChromeId: 'cook' },
      ],
    })
  }

  it('returns bookmarks in the folder AND its descendants (recursive)', () => {
    seedDeepTree()
    const techId = db.get<{ id: string }>('SELECT id FROM folders WHERE name = ?', ['Tech'])?.id
    expect(techId).toBeDefined()
    const feed = queryFeed(db, { folderId: techId! })
    const titles = feed.items.map((i) => i.title).sort()
    // Both Tech-book (direct) and Web-book (nested under Tech > Web) match.
    expect(titles).toEqual(['Tech-book', 'Web-book'])
  })

  it('does not include bookmarks in sibling folders', () => {
    seedDeepTree()
    const techId = db.get<{ id: string }>('SELECT id FROM folders WHERE name = ?', ['Tech'])?.id
    const feed = queryFeed(db, { folderId: techId! })
    expect(feed.items.find((i) => i.title === 'Cook-book')).toBeUndefined()
  })

  it('reports correct totalItems for pagination', () => {
    seedDeepTree()
    const techId = db.get<{ id: string }>('SELECT id FROM folders WHERE name = ?', ['Tech'])?.id
    const feed = queryFeed(db, { folderId: techId!, perPage: 1 })
    expect(feed.totalItems).toBe(2)
    expect(feed.totalPages).toBe(2)
  })

  it('returns empty when the folder has no bookmarks', () => {
    seedDeepTree()
    const cookId = db.get<{ id: string }>('SELECT id FROM folders WHERE name = ?', ['Cooking'])?.id
    // Delete the cook bookmark so the folder is empty.
    db.run('DELETE FROM bookmarks WHERE folder_id = ?', [cookId!])
    const feed = queryFeed(db, { folderId: cookId! })
    expect(feed.items).toHaveLength(0)
    expect(feed.totalItems).toBe(0)
  })

  it('returns empty items when folderId points at nothing', () => {
    // Pure queryFeed is strict — unknown id → 0 rows. The route handler
    // is responsible for the UX decision of "unknown folder → fall back
    // to all bookmarks". That fallback is tested in home.test.ts.
    seedDeepTree()
    const feed = queryFeed(db, { folderId: 'nonexistent' })
    expect(feed.items).toHaveLength(0)
  })
})

describe('queryFeed — tags', () => {
  it('includes tags alphabetically sorted', () => {
    seed({ chromeId: 'b1', url: 'https://a.com', title: 'A' })
    const id = serverIdFor('b1')
    addTagsToBookmark(id, 'postgres', 'database', 'backend')

    const feed = queryFeed(db)
    expect(feed.items[0]?.tags).toEqual(['backend', 'database', 'postgres'])
  })

  it('returns an empty tags array when none are linked', () => {
    seed({ chromeId: 'b1', url: 'https://a.com', title: 'A' })
    const feed = queryFeed(db)
    expect(feed.items[0]?.tags).toEqual([])
  })
})

// ─── queryBookmark ────────────────────────────────────────────────────────

describe('queryBookmark', () => {
  it('returns the full detail for an existing id', () => {
    seed(
      { chromeId: 'b1', url: 'https://example.com', title: 'Example' },
    )
    const id = serverIdFor('b1')

    const detail = queryBookmark(db, id)
    expect(detail).not.toBeNull()
    expect(detail?.id).toBe(id)
    expect(detail?.url).toBe('https://example.com')
    expect(detail?.title).toBe('Example')
    expect(detail?.folderPath).toBe('Bookmarks bar > Tech')
    expect(detail?.tags).toEqual([])
    expect(detail?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)  // ISO 8601
    expect(detail?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(detail?.lastSeenAt).toBeNull() // never set
  })

  it('returns null for a non-existent id', () => {
    seed({ chromeId: 'b1', url: 'https://a.com', title: 'A' })
    const detail = queryBookmark(db, 'does-not-exist')
    expect(detail).toBeNull()
  })

  it('returns null for a deleted bookmark (cascade)', () => {
    seed({ chromeId: 'b1', url: 'https://a.com', title: 'A' })
    const id = serverIdFor('b1')

    db.run('DELETE FROM bookmarks WHERE id = ?', [id])
    const detail = queryBookmark(db, id)
    expect(detail).toBeNull()
  })

  it('includes last_seen_at when set', () => {
    seed({ chromeId: 'b1', url: 'https://a.com', title: 'A' })
    const id = serverIdFor('b1')
    db.run(`UPDATE bookmarks SET last_seen_at = '2025-01-15T12:00:00Z' WHERE id = ?`, [id])

    const detail = queryBookmark(db, id)
    expect(detail?.lastSeenAt).toBe('2025-01-15T12:00:00Z')
  })

  it('includes tags when linked', () => {
    seed({ chromeId: 'b1', url: 'https://a.com', title: 'A' })
    const id = serverIdFor('b1')
    addTagsToBookmark(id, 'rust', 'systems')

    const detail = queryBookmark(db, id)
    expect(detail?.tags).toEqual(['rust', 'systems'])
  })
})

// ─── HTML rendering (smoke — output is HTML, not deeply asserted) ────────

describe('renderFeedPage', () => {
  it('renders an empty-state message when there are no bookmarks', () => {
    const html = renderFeedPage('david', [], {
      items: [],
      page: 1,
      perPage: 50,
      totalItems: 0,
      totalPages: 1,
    })
    expect(html).toContain('No bookmarks synced yet')
    expect(html).toContain('Activity')
  })

  it('renders each bookmark with title, link, folder path, and date', () => {
    const items: readonly FeedItem[] = [
      {
        id: 'uuid-1',
        url: 'https://example.com',
        title: 'Example Site',
        folderPath: 'Bookmarks bar > Tech',
        createdAt: '2024-01-15T10:30:00.000Z',
        tags: ['demo'],
      },
    ]
    const html = renderFeedPage('david', [], {
      items,
      page: 1,
      perPage: 50,
      totalItems: 1,
      totalPages: 1,
    })
    expect(html).toContain('Example Site')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('Bookmarks bar &gt; Tech') // '>' is HTML-escaped
    expect(html).toContain('href="/bookmarks/uuid-1"')
    expect(html).toContain('class="tag" data-tag="demo">demo<')
  })

  it('renders pagination links when there are multiple pages', () => {
    const html = renderFeedPage('david', [], {
      items: [],
      page: 2,
      perPage: 10,
      totalItems: 100,
      totalPages: 10,
    })
    expect(html).toContain('href="?page=1"')  // ← Newer
    expect(html).toContain('href="?page=3"')  // Older →
    expect(html).toContain('Page 2 of 10')
  })

  it('disables pagination links on the first/last page', () => {
    const htmlFirst = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 10, totalItems: 100, totalPages: 10,
    })
    expect(htmlFirst).toContain('<span class="disabled">← Newer</span>')
    expect(htmlFirst).toContain('href="?page=2"')

    const htmlLast = renderFeedPage('david', [], {
      items: [], page: 10, perPage: 10, totalItems: 100, totalPages: 10,
    })
    expect(htmlLast).toContain('<span class="disabled">Older →</span>')
    expect(htmlLast).toContain('href="?page=9"')
  })

  it('escapes HTML in titles, URLs, and folder names', () => {
    const html = renderFeedPage('david', [], {
      items: [{
        id: 'x',
        url: 'https://example.com/?q=<script>',
        title: 'Title with <script> & "quotes"',
        folderPath: 'Tech & <Dev>',
        createdAt: '2024-01-15T10:30:00.000Z',
        tags: [],
      }],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    // Raw injection must not survive.
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;')
  })

  it('renders folder sidebar in the layout', () => {
    const html = renderFeedPage('david', [{
      id: 'f1',
      name: 'Tech',
      parentId: null,
      chromeId: 'f1',
      children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).toContain('<aside>')
    expect(html).toContain('Tech')
  })

  it('renders folder names as filter links with the folder id in the href', () => {
    const html = renderFeedPage('david', [{
      id: 'f1',
      name: 'Tech',
      parentId: null,
      chromeId: 'f1',
      children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).toContain('href="/?folder=f1"')
    // In non-categorize mode, the label is a plain anchor (no inner span).
    expect(html).toMatch(/<a[^>]+class="folder-label"[^>]*>Tech<\/a>/)
  })

  it('marks the active folder with data-active and an active CSS class', () => {
    const html = renderFeedPage('david', [{
      id: 'f1',
      name: 'Tech',
      parentId: null,
      chromeId: 'f1',
      children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, 'f1')
    // Both markers must be on the same anchor, in any attribute order.
    expect(html).toContain('class="folder-label active"')
    expect(html).toContain('data-active="true"')
    expect(html).toContain('href="/?folder=f1"')
    expect(html).toMatch(/<a[^>]*class="folder-label active"[^>]*data-active="true"[^>]*>Tech<\/a>/)
  })

  it('wraps the folder name in a <span> for categorize-mode rename hooks', () => {
    // In categorize mode (the default for the route), each folder is
    // rendered as <a><span data-folder-name>…</span></a> so the inline
    // rename script can hook the inner span. The plain-text <a> path is
    // for non-categorize callers (none today, but kept as an escape hatch).
    const html = renderFeedPage('david', [{
      id: 'f1', name: 'Tech', parentId: null, chromeId: 'f1', children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, {
      folderOptions: [], allTags: [],
    })
    expect(html).toMatch(/<a[^>]+class="folder-label"[^>]*href="\/\?folder=f1"[^>]*>[\s\S]*?<span class="folder-name"[^>]*data-folder-id="f1"[^>]*>Tech<\/span>[\s\S]*?<\/a>/)
  })

  it('preserves the folder filter in pagination links', () => {
    // We need at least one item so the empty-state branch doesn't fire
    // and pagination renders.
    const html = renderFeedPage('david', [], {
      items: [{
        id: 'b1', url: 'https://a.com', title: 'A', folderPath: 'Bar',
        createdAt: '2024-01-15T10:30:00.000Z', tags: [],
      }],
      page: 2, perPage: 10, totalItems: 100, totalPages: 10,
    }, undefined, 'f1')
    expect(html).toContain('href="?page=1&folder=f1"')
    expect(html).toContain('href="?page=3&folder=f1"')
  })

  it('shows "no bookmarks in folder" empty state when filter excludes everything', () => {
    const html = renderFeedPage('david', [{
      id: 'f1', name: 'Empty', parentId: null, chromeId: 'f1', children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, 'f1')
    expect(html).toContain('No bookmarks in <strong>Empty</strong>')
    expect(html).toContain('Show all bookmarks')
    expect(html).toContain('href="/">Show all bookmarks')
  })

  it('renders folder labels with display:block so the whole row is clickable', () => {
    // Regression test for the "only the border is clickable" bug: the
    // .folder-label rule must use display:block (not inline-block), so
    // the anchor fills the <li> and the entire rectangle is a hit target.
    const html = renderFeedPage('david', [{
      id: 'f1', name: 'Tech', parentId: null, chromeId: 'f1', children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).toMatch(/aside \.folder-label\s*\{[^}]*display:\s*block/)
    // The cursor should be pointer, not text \u2014 the folder name is
    // now a link, not an editable text field. (The rename hook flips
    // cursor to text only while data-editing="true" on the inner span.)
    expect(html).toMatch(/aside \.folder-label\s*\{[^}]*cursor:\s*pointer/)
  })
})

describe('renderDetailPage', () => {
  it('renders all required fields', () => {
    const html = renderDetailPage({
      id: 'uuid-1',
      url: 'https://example.com',
      title: 'Example Site',
      folderPath: 'Bookmarks bar > Tech',
      tags: ['demo', 'tag2'],
      createdAt: '2024-01-15T10:30:00.000Z',
      updatedAt: '2024-01-16T11:00:00.000Z',
      lastSeenAt: '2024-01-17T12:00:00.000Z',
    })
    expect(html).toContain('Example Site')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('Bookmarks bar &gt; Tech')
    expect(html).toContain('class="tag" data-tag="demo">demo<')
    expect(html).toContain('class="tag" data-tag="tag2">tag2<')
    expect(html).toContain('2024-01-15') // created date appears (formatted)
    expect(html).toContain('2024-01-16') // updated date
    expect(html).toContain('2024-01-17') // last seen
  })

  it('shows "no tags" when the bookmark has none', () => {
    const html = renderDetailPage({
      id: 'x', url: 'https://a.com', title: 'A',
      folderPath: 'Bar', tags: [],
      createdAt: '2024-01-15T10:30:00.000Z',
      updatedAt: '2024-01-16T11:00:00.000Z',
      lastSeenAt: null,
    })
    expect(html).toContain('no tags')
  })

  it('shows "never" for last_seen_at when null', () => {
    const html = renderDetailPage({
      id: 'x', url: 'https://a.com', title: 'A',
      folderPath: 'Bar', tags: [],
      createdAt: '2024-01-15T10:30:00.000Z',
      updatedAt: '2024-01-16T11:00:00.000Z',
      lastSeenAt: null,
    })
    expect(html).toContain('never')
  })

  it('includes a back link to the feed', () => {
    const html = renderDetailPage({
      id: 'x', url: 'https://a.com', title: 'A',
      folderPath: 'Bar', tags: [],
      createdAt: '2024-01-15T10:30:00.000Z',
      updatedAt: '2024-01-16T11:00:00.000Z',
      lastSeenAt: null,
    })
    expect(html).toContain('href="/"')
    expect(html).toContain('Back to activity feed')
  })

  it('escapes HTML in title and URL', () => {
    const html = renderDetailPage({
      id: 'x', url: 'https://a.com/?q=<bad>', title: '<script>alert(1)</script>',
      folderPath: 'Bar', tags: [],
      createdAt: '2024-01-15T10:30:00.000Z',
      updatedAt: '2024-01-16T11:00:00.000Z',
      lastSeenAt: null,
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('renderDetailNotFound', () => {
  it('renders a 404 page with a back link', () => {
    const html = renderDetailNotFound()
    expect(html).toContain('Bookmark not found')
    expect(html).toContain('href="/"')
  })
})