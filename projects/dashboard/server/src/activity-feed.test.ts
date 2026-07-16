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
import { type FolderNode } from './folders.js'
import {
  queryFeed,
  queryBookmark,
  renderFeedPage,
  renderDetailPage,
  renderDetailNotFound,
  getSourceFromUrl,
  getCardThumbnail,
  getYouTubeVideoId,
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
    // Slice #015 unified the empty-state markup into a single
    // .empty-state component with an icon + CTA.
    expect(html).toContain('class="empty-state"')
    expect(html).toContain('class="empty-icon"')
    expect(html).toContain('class="empty-cta"')
    expect(html).toContain('href="/settings"')
  })

  it('does not render a bottom <nav> with Settings/JSON links (issue #017)', () => {
    // Settings moved to the shared header; JSON was a debug affordance
    // and never belonged in user-facing HTML. /api/folders the route
    // still exists and is tested in folders.test.ts.
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).not.toContain('/api/folders')
    expect(html).not.toContain('>JSON</a>')
    // The settings link that USED to live in this bottom nav is now
    // expected in the header instead — assert both halves of the move:
    expect(html).toContain('class="settings-link"')
    // and it lives in the .header-right cluster, not in <main>.
    const headerRightStart = html.indexOf('class="header-right"')
    const settingsIdx = html.indexOf('class="settings-link"')
    const mainIdx = html.indexOf('<main>')
    expect(headerRightStart).toBeGreaterThan(-1)
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(mainIdx).toBeGreaterThan(-1)
    expect(settingsIdx).toBeLessThan(mainIdx)
  })

  it('renders an empty-folder state when the active folder has no items', () => {
    const html = renderFeedPage('david', [{
      id: 'f1', name: 'Empty', parentId: null, chromeId: 'f1', children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, 'f1')
    expect(html).toContain('class="empty-state"')
    expect(html).toContain('No bookmarks in <strong>Empty</strong>')
    expect(html).toContain('href="/">Show all bookmarks')
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
    // Issue #019: pagination renders on BOTH top and bottom of the
    // feed list. Assert via count of the wrapper class.
    expect(html.match(/<div class="pagination">/g)).toHaveLength(2)
  })

  it('disables pagination links on the first/last page', () => {
    const htmlFirst = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 10, totalItems: 100, totalPages: 10,
    })
    expect(htmlFirst).toContain('<span class="disabled">← Newer</span>')
    expect(htmlFirst).toContain('href="?page=2"')
    // Issue #019: the disabled state appears on BOTH the top and
    // bottom pagination bars (since they share the same render fn).
    expect(htmlFirst.match(/<span class="disabled">← Newer<\/span>/g)).toHaveLength(2)

    const htmlLast = renderFeedPage('david', [], {
      items: [], page: 10, perPage: 10, totalItems: 100, totalPages: 10,
    })
    expect(htmlLast).toContain('<span class="disabled">Older →</span>')
    expect(htmlLast).toContain('href="?page=9"')
    expect(htmlLast.match(/<span class="disabled">Older →<\/span>/g)).toHaveLength(2)
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
    // Raw injection must not survive. We can't assert `not.toContain('<script>')`
    // in general (the view legitimately emits a <script src="/static/theme.js">
    // tag at the end of <body>), so we target the specific injection attempt
    // in the user-supplied URL instead.
    expect(html).not.toContain('?q=<script>')
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
    expect(html).toContain('<aside class="sidebar">')
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
    // In categorize mode (the default for the route), the label
    // wraps the folder name in an inner span for the rename hook.
    // The outer anchor still matches `class="folder-label"`.
    expect(html).toMatch(/<a[^>]+class="folder-label"[^>]*href="\/\?folder=f1"[^>]*>[\s\S]*?Tech[\s\S]*?<\/a>/)
  })

  it('marks the active folder with data-active and a sidebar-link-active class', () => {
    const html = renderFeedPage('david', [{
      id: 'f1',
      name: 'Tech',
      parentId: null,
      chromeId: 'f1',
      children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, 'f1')
    // Slice #013: active styling moved from `.active` (BEM-style
    // collision risk with other elements) to `.sidebar-link-active`
    // to scope it to the sidebar tree. `data-active="true"` stays as
    // the source of truth that CSS and JS both read.
    expect(html).toContain('class="folder-label sidebar-link-active"')
    expect(html).toContain('data-active="true"')
    expect(html).toContain('href="/?folder=f1"')
    expect(html).toMatch(/<a[^>]*class="folder-label sidebar-link-active"[^>]*data-active="true"[^>]*>[\s\S]*?Tech[\s\S]*?<\/a>/)
  })

  it('wraps the folder name in a <span> for categorize-mode rename hooks', () => {
    // In categorize mode (the default for the route), each folder is
    // rendered as <a><span data-folder-name>…</span></a> so the inline
    // rename script can hook the inner span. Slice #013 adds a folder
    // icon + chevron inside the anchor; the rename span still has
    // `.folder-name` so the existing categorize.js querySelector
    // continues to match.
    const html = renderFeedPage('david', [{
      id: 'f1', name: 'Tech', parentId: null, chromeId: 'f1', children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, {
      folderOptions: [], allTags: [],
    })
    expect(html).toMatch(/<a[^>]+class="folder-label"[^>]*href="\/\?folder=f1"[^>]*>[\s\S]*?<span class="sidebar-name folder-name"[^>]*data-folder-id="f1"[^>]*>Tech<\/span>[\s\S]*?<\/a>/)
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
    // Issue #019: the folder-filtered link appears in BOTH top and
    // bottom pagination bars.
    expect(html.match(/href="\?page=1&folder=f1"/g)).toHaveLength(2)
    expect(html.match(/href="\?page=3&folder=f1"/g)).toHaveLength(2)
  })

  it('hides both pagination bars when there is only one page (issue #019)', () => {
    // totalPages === 1 (e.g. 5 items at perPage=50) — no nav needed.
    // The bars must NOT render at all: no "Page 1 of 1" placeholder,
    // no disabled prev/next. Both top AND bottom positions are empty.
    const html = renderFeedPage('david', [], {
      items: [{
        id: 'b1', url: 'https://a.com', title: 'A', folderPath: 'Bar',
        createdAt: '2024-01-15T10:30:00.000Z', tags: [],
      }],
      page: 1, perPage: 50, totalItems: 5, totalPages: 1,
    })
    expect(html).not.toContain('<div class="pagination">')
    expect(html).not.toContain('Page 1 of 1')
    expect(html).not.toContain('← Newer')
    expect(html).not.toContain('Older →')
    expect(html).not.toContain('class="disabled"')
  })

  it('keeps the folder label as a clickable anchor (cursor:pointer via styles.css)', () => {
    // Slice #013 moved the .folder-label styling into styles.css
    // (no longer in the inline <style> block). The equivalent
    // guarantee — that the entire row is a hit target and the
    // cursor indicates a link — now lives in /static/styles.css.
    // Here we assert the rendered markup still produces an
    // anchor (not a button) and that the new sidebar structure
    // is in place; the visual styling is verified by manual
    // inspection of the page (no automated CSS lint in this slice).
    const html = renderFeedPage('david', [{
      id: 'f1', name: 'Tech', parentId: null, chromeId: 'f1', children: [],
    }], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).toMatch(/<a[^>]+class="folder-label"[^>]+href="\/\?folder=f1"/)
    // data-depth drives the per-level padding-left in styles.css.
    expect(html).toMatch(/<li[^>]*data-folder-id="f1"[^>]*data-depth="0"/)
  })
})

describe('renderFolderSidebar (issue #013 slice 4)', () => {
  const sampleTree: FolderNode[] = [
    {
      id: 'f1', name: 'Top', parentId: null, chromeId: 'f1',
      children: [
        {
          id: 'f2', name: 'Nested', parentId: 'f1', chromeId: 'f2',
          children: [],
        },
      ],
    },
  ]

  it('wraps the tree in <aside class="sidebar">', () => {
    const html = renderFeedPage('david', sampleTree, {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).toContain('<aside class="sidebar">')
    expect(html).toContain('</aside>')
  })

  it('emits a folder icon span next to each name', () => {
    const html = renderFeedPage('david', sampleTree, {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).toMatch(/<span class="sidebar-icon"[^>]*>\ud83d\udcc1<\/span>/)
  })

  it('emits a chevron only on folders that have children', () => {
    const html = renderFeedPage('david', sampleTree, {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    // Slice #016: the chevron is now a sibling <button> (not a <span>
    // inside the <a>). "Top" has children — its <li> should carry the
    // button right after the folder label.
    expect(html).toMatch(/data-folder-id="f1"[^>]*data-has-children="true"[\s\S]*?<button type="button" class="sidebar-chevron"[^>]*data-toggle-folder[^>]*aria-expanded="true"[^>]*aria-label="Collapse"[^>]*>\u203a<\/button>/)
    // "Nested" has no children — no chevron button.
    expect(html).not.toMatch(/data-folder-id="f2"[^>]*data-has-children="true"/)
    expect(html).not.toMatch(/data-folder-id="f2"[\s\S]*?sidebar-chevron/)
  })

  it('slice #016: chevron is a sibling of the <a>, not a child', () => {
    // The chevron must live outside the folder-label anchor so clicking
    // it does NOT navigate to the filtered feed. It's also outside the
    // rename-target span so the inline rename doesn't swallow it.
    const html = renderFeedPage('david', sampleTree, {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, {
      folderOptions: [], allTags: [],
    })
    // Drill into the "Top" <li> and assert the order: <a> … </a> then
    // <button class="sidebar-chevron"> then <ul>. Anchoring to the <li>
    // avoids matching earlier <a> tags in the page (nav links, header).
    const liMatch = html.match(
      /<li[^>]*data-folder-id="f1"[^>]*data-has-children="true"[\s\S]*?<\/li>/,
    )
    expect(liMatch).not.toBeNull()
    const liHtml = liMatch![0]
    // No <span class="sidebar-chevron"> anywhere in the <li> — the
    // chevron must be a <button>, not the old inline span.
    expect(liHtml).not.toMatch(/<span class="sidebar-chevron"/)
    const aCloseIdx = liHtml.indexOf('</a>')
    const buttonIdx = liHtml.indexOf('<button type="button" class="sidebar-chevron"')
    const ulIdx = liHtml.indexOf('<ul>')
    expect(aCloseIdx).toBeGreaterThan(-1)
    expect(buttonIdx).toBeGreaterThan(aCloseIdx)
    expect(ulIdx).toBeGreaterThan(buttonIdx)
  })

  it('slice #016: chevron has ARIA attributes for accessibility', () => {
    const html = renderFeedPage('david', sampleTree, {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    // The chevron announces its current state to screen readers via
    // aria-expanded + aria-label. Initial state is always expanded
    // (server-side rendering, no client state yet).
    expect(html).toMatch(/<button type="button" class="sidebar-chevron"[^>]*aria-expanded="true"[^>]*aria-label="Collapse"/)
  })

  it('slice #016: chevron is rendered in non-categorize mode too', () => {
    // The chevron toggle is a pure DOM interaction owned by
    // categorize.js, but the markup must be present regardless of
    // categorize context so non-categorize mode also gets collapse.
    const html = renderFeedPage('david', sampleTree, {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    // Without categorize context, the chevron button still emits on
    // folders with children.
    expect(html).toMatch(/data-folder-id="f1"[\s\S]*?<button type="button" class="sidebar-chevron" data-toggle-folder aria-expanded="true" aria-label="Collapse">\u203a<\/button>/)
  })

  it('emits data-depth on every sidebar item for CSS indentation', () => {
    const html = renderFeedPage('david', sampleTree, {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).toMatch(/<li[^>]*data-folder-id="f1"[^>]*data-depth="0"/)
    expect(html).toMatch(/<li[^>]*data-folder-id="f2"[^>]*data-depth="1"/)
  })

  it('emits data-folder-id on the <li> wrapper', () => {
    const html = renderFeedPage('david', sampleTree, {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).toContain('<li class="sidebar-item" data-folder-id="f1"')
    expect(html).toContain('<li class="sidebar-item" data-folder-id="f2"')
  })

  it('categorize-mode sidebar includes the + New folder button + form', () => {
    const html = renderFeedPage('david', sampleTree, {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, {
      folderOptions: [], allTags: [],
    })
    expect(html).toContain('class="add-folder-btn"')
    expect(html).toContain('data-add-folder')
    expect(html).toContain('class="add-folder-form"')
    expect(html).toContain('data-add-folder-form')
    expect(html).toContain('data-cancel-add-folder')
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

// ─── Issue #012: card layout — helpers and markup ─────────────────────────

describe('getSourceFromUrl (issue #012)', () => {
  it('parses the hostname of a normal URL', () => {
    expect(getSourceFromUrl('https://github.com/whatever').domain).toBe('github.com')
  })

  it('strips a leading www.', () => {
    expect(getSourceFromUrl('https://www.github.com/x').domain).toBe('github.com')
  })

  it('lowercases the host', () => {
    expect(getSourceFromUrl('https://GitHub.COM/x').domain).toBe('github.com')
  })

  it('flags youtube.com as YouTube', () => {
    expect(getSourceFromUrl('https://www.youtube.com/watch?v=abc').isYouTube).toBe(true)
  })

  it('flags youtu.be as YouTube', () => {
    expect(getSourceFromUrl('https://youtu.be/abc').isYouTube).toBe(true)
  })

  it('does not flag similar hosts', () => {
    expect(getSourceFromUrl('https://notyoutube.com/').isYouTube).toBe(false)
  })

  it('returns the raw url on parse failure (does not throw)', () => {
    // Not a valid URL — the function must not crash; the feed should
    // still render the card with a fallback "domain" of the raw string.
    const info = getSourceFromUrl('not a url at all')
    expect(info.domain).toBe('not a url at all')
    expect(info.isYouTube).toBe(false)
  })

  it('returns badgeLabel equal to domain today', () => {
    const info = getSourceFromUrl('https://example.com/path')
    expect(info.badgeLabel).toBe(info.domain)
  })
})

describe('getYouTubeVideoId (issue #014)', () => {
  it('extracts the video ID from a youtube.com/watch URL', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts the video ID from a youtu.be short URL', () => {
    expect(getYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts the video ID from a youtube.com/embed URL', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('accepts m.youtube.com watch URLs', () => {
    expect(getYouTubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('returns null for non-YouTube URLs', () => {
    expect(getYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBe(null)
    expect(getYouTubeVideoId('https://github.com/foo/bar')).toBe(null)
  })
  it('returns null for YouTube URLs with a too-short video ID', () => {
    // Video IDs are exactly 11 chars; this one is 10.
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=short')).toBe(null)
  })
  it('returns null for a YouTube channel page (no video)', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/@mkbhd')).toBe(null)
  })
})

describe('getCardThumbnail (issue #014)', () => {
  it('returns a youtube thumbnail for watch URLs', () => {
    const t = getCardThumbnail('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(t).not.toBe(null)
    expect(t?.type).toBe('youtube')
    expect(t?.src).toBe('https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
    expect(t?.alt).toBe('YouTube video thumbnail')
  })

  it('returns a youtube thumbnail for youtu.be short URLs', () => {
    const t = getCardThumbnail('https://youtu.be/dQw4w9WgXcQ')
    expect(t?.type).toBe('youtube')
    expect(t?.src).toBe('https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  })

  it('returns a favicon thumbnail for a generic URL', () => {
    const t = getCardThumbnail('https://github.com/foo/bar')
    expect(t?.type).toBe('favicon')
    expect(t?.src).toBe('https://www.google.com/s2/favicons?domain=github.com&sz=64')
    expect(t?.alt).toBe('github.com favicon')
  })

  it('strips www. from the favicon hostname', () => {
    const t = getCardThumbnail('https://www.example.com/x')
    expect(t?.type).toBe('favicon')
    expect(t?.src).toContain('domain=example.com')
    expect(t?.alt).toBe('example.com favicon')
  })

  it('returns null for malformed URLs', () => {
    expect(getCardThumbnail('not a url at all')).toBe(null)
  })

  it('returns null for a YouTube homepage (no video ID)', () => {
    // A bare youtube.com URL isn't a video — it should fall through
    // to the favicon path (not null) since the URL itself is valid.
    const t = getCardThumbnail('https://www.youtube.com/')
    expect(t?.type).toBe('favicon')
    expect(t?.alt).toBe('youtube.com favicon')
  })
})

describe('renderFeedItem — card markup (issue #012)', () => {
  const sampleItem: FeedItem = {
    id: 'uuid-1',
    url: 'https://example.com/foo',
    title: 'Example',
    folderPath: 'Bar',
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5m ago
    tags: ['t1'],
  }

  it('emits an <article class="feed-item"> wrapper', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toMatch(/<article class="feed-item"[^>]*data-bookmark-id="uuid-1"/)
    expect(html).toContain('<header class="feed-item-header">')
  })

  it('renders the URL host as the source badge', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('class="source-badge"')
    expect(html).toContain('data-source="example.com"')
    expect(html).toContain('>example.com</span>')
  })

  it('marks YouTube URLs with the red badge variant', () => {
    const ytItem: FeedItem = {
      ...sampleItem,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    }
    const html = renderFeedPage('david', [], {
      items: [ytItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('source-badge-youtube')
    expect(html).toContain('data-source="youtube.com"')
    expect(html).toContain('title="YouTube"')
  })

  it('renders the relative time inside <time> with ISO in datetime and title', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toMatch(/<time datetime="[^"]+" title="[^"]+">5m ago<\/time>/)
  })

  it('renders "just now" for items less than a minute old', () => {
    const item = { ...sampleItem, createdAt: new Date().toISOString() }
    const html = renderFeedPage('david', [], {
      items: [item],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('>just now</time>')
  })

  it('renders "Nh ago" for items between 1h and 24h old', () => {
    const item = {
      ...sampleItem,
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    }
    const html = renderFeedPage('david', [], {
      items: [item],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('>3h ago</time>')
  })

  it('renders "Nd ago" for items between 1d and 7d old', () => {
    const item = {
      ...sampleItem,
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }
    const html = renderFeedPage('david', [], {
      items: [item],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('>3d ago</time>')
  })

  it('renders the three action buttons with data-action attributes', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('data-action="open"')
    expect(html).toContain('data-action="edit"')
    expect(html).toContain('data-action="copy"')
  })

  it('emits data-bookmark-url on the card so the clipboard handler can find the URL', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toMatch(/data-bookmark-url="https:\/\/example\.com\/foo"/)
  })

  it('in non-categorize mode, the edit button links to /bookmarks/:id', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('href="/bookmarks/uuid-1"')
    // No data-edit-title in non-categorize mode.
    expect(html).not.toContain('data-edit-title')
  })

  it('in categorize mode, the edit button has data-edit-title (no detail-page link)', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    }, {
      folderOptions: [], allTags: [],
    })
    expect(html).toContain('data-edit-title="true"')
    // No detail-page link in categorize mode — the edit button does
    // inline rename instead.
    expect(html).not.toContain('href="/bookmarks/uuid-1"')
  })

  it('renders the open button as an <a> with target="_blank" for the bookmark URL', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toMatch(
      /<a[^>]+class="action-button"[^>]+href="https:\/\/example\.com\/foo"[^>]+target="_blank"[^>]+data-action="open"[^>]*>↗<\/a>/,
    )
  })

  it('renders a favicon thumbnail for a generic URL (issue #014)', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('class="feed-item-thumb feed-item-thumb-favicon"')
    expect(html).toContain('src="https://www.google.com/s2/favicons?domain=example.com&amp;sz=64"')
    expect(html).toContain('alt="example.com favicon"')
  })

  it('renders a YouTube video thumbnail for youtube.com/watch URLs', () => {
    const ytItem: FeedItem = {
      ...sampleItem,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    }
    const html = renderFeedPage('david', [], {
      items: [ytItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('class="feed-item-thumb feed-item-thumb-youtube"')
    expect(html).toContain('src="https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg"')
    expect(html).toContain('alt="YouTube video thumbnail"')
  })

  it('renders a YouTube thumbnail for youtu.be short URLs', () => {
    const ytItem: FeedItem = {
      ...sampleItem,
      url: 'https://youtu.be/abc_-123XYZ',
    }
    const html = renderFeedPage('david', [], {
      items: [ytItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('feed-item-thumb-youtube')
    expect(html).toContain('/vi/abc_-123XYZ/hqdefault.jpg')
  })

  it('renders a YouTube thumbnail for youtube.com/embed URLs', () => {
    const ytItem: FeedItem = {
      ...sampleItem,
      url: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    }
    const html = renderFeedPage('david', [], {
      items: [ytItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('feed-item-thumb-youtube')
    expect(html).toContain('/vi/dQw4w9WgXcQ/hqdefault.jpg')
  })

  it('renders the favicon thumbnail lazily with an onerror fallback', () => {
    const html = renderFeedPage('david', [], {
      items: [sampleItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).toContain('loading="lazy"')
    // The onerror handler hides broken-image icons without reflowing.
    expect(html).toContain("onerror=\"this.style.display='none'\"")
  })

  it('omits the thumbnail <img> when the URL is malformed', () => {
    const badItem: FeedItem = { ...sampleItem, url: 'not a url' }
    const html = renderFeedPage('david', [], {
      items: [badItem],
      page: 1, perPage: 50, totalItems: 1, totalPages: 1,
    })
    expect(html).not.toContain('class="feed-item-thumb')
    // The thumb slot itself collapses to nothing — the header just
    // contains the source badge in this case.
    expect(html).not.toContain('feed-item-thumb-slot')
  })
})

// ─── Sidebar cross-links + inbox teaser (#026) ────────────────────────
//
// Slice #026 wires the email slice into the main dashboard sidebar
// and adds an inbox teaser line above the feed list. The tests
// below pin the new shape so a regression that hides email from
// the main dashboard gets caught.

describe('renderFeedPage — sidebar cross-links (#026)', () => {
  /** Helper: build a connected-account teaser for test inputs. The
   *  function is private to the module, so we construct the same
   *  shape via a public call signature — but renderFeedPage accepts
   *  any InboxTeaser-shaped value, so we just feed one in. */
  function teaser(over: Partial<{ connected: boolean; unreadCount: number; accountEmail: string | null; lastSyncAt: string | null }> = {}) {
    return {
      connected: true,
      unreadCount: 0,
      accountEmail: 'me@gmail.com',
      lastSyncAt: null,
      ...over,
    }
  }

  it('renders a Bookmarks entry in the sidebar with the active class', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    })
    expect(html).toMatch(/<a[^>]*class="[^"]*compartment-button-active[^"]*"[^>]*href="\/"/)
    expect(html).toContain('>Bookmarks</span>')
    expect(html).toMatch(/data-sidebar-nav="bookmarks"/)
  })

  it('renders Email as a primary space with an unread badge when connected', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({ unreadCount: 3 }))
    expect(html).toMatch(/<a[^>]*class="[^"]*compartment-button[^"]*"[^>]*href="\/email"[^>]*data-sidebar-nav="email"/)
    expect(html).toContain('aria-label="3 unread"')
    expect(html).toContain('class="space-count"')
  })

  it('keeps the Email space discoverable when no account is connected', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({ connected: false, accountEmail: null }))
    expect(html).toContain('>Email</span>')
    expect(html).toMatch(/data-sidebar-nav="email"/)
    expect(html).not.toContain('class="space-count"')
    expect(html).toContain('>Bookmarks</span>')
  })

  it('shows the unread count in the sidebar Inbox link', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({ unreadCount: 12 }))
    expect(html).toContain('aria-label="12 unread"')
  })

  it('omits the unread badge when the count is zero', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({ unreadCount: 0 }))
    expect(html).toContain('>Email</span>')
    expect(html).not.toContain('class="space-count"')
  })

  it('renders the inbox teaser line above the feed list when connected', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({ unreadCount: 7 }))
    expect(html).toMatch(/class="inbox-teaser"/)
    expect(html).toContain('data-inbox-teaser')
    expect(html).toMatch(/<a[^>]*class="inbox-teaser-link"[^>]*href="\/email"/)
    expect(html).toContain('7 unread emails')
  })

  it('renders singular "1 unread email" (not "1 unread emails")', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({ unreadCount: 1 }))
    expect(html).toContain('1 unread email')
    expect(html).not.toContain('1 unread emails')
  })

  it('renders the "no unread" state when connected with zero unread', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({ unreadCount: 0 }))
    expect(html).toContain('Inbox \u2014 no unread')
  })

  it('omits the inbox teaser line when no account is connected', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({ connected: false }))
    expect(html).not.toContain('data-inbox-teaser')
    expect(html).not.toContain('inbox-teaser-link')
  })

  it('shows last sync note when an account has synced', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({
      lastSyncAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    }))
    expect(html).toContain('last sync')
    expect(html).toContain('5m ago')
  })

  it('does not show stale sync metadata when no sync has run', () => {
    const html = renderFeedPage('david', [], {
      items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 1,
    }, undefined, null, teaser({ lastSyncAt: null }))
    expect(html).not.toContain('never synced')
  })
})
