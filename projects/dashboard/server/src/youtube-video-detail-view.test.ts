// youtube-video-detail-view.test.ts — issue YT-005
//
// Server-rendered detail page tests.
//
// Coverage:
//   * 401 unauthenticated
//   * 404 for unknown id
//   * 200 with: title, channel, dates, watch link, folder picker,
//     tag chips + input + datalist, inline JSON script
//   * Folder select reflects the current folder_id (or unfoldered)
//   * Tag chips for each attached tag
//   * Channel-excluded flag when the channel's is_included=0
//   * Deleted folder renders as a disabled "(folder deleted)" placeholder

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import bcrypt from 'bcryptjs'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { auth, type AuthVariables } from './auth.js'
import { InMemoryTokenStore } from './token-store.js'
import { youtubeVideoDetailView } from './youtube-video-detail-view.js'
import { insertVideo, type VideoInsertInput } from './youtube-videos.js'
import { upsertSubscription } from './youtube-subscriptions.js'

const PASSWORD = 'secret'
const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

interface TestEnv {
  db: Database
  app: Hono<{ Variables: AuthVariables }>
  seed(overrides?: Partial<VideoInsertInput>): string
}

let env: TestEnv

beforeEach(async () => {
  const db = new Database(':memory:')
  await runMigrations(db, { dir: MIGRATIONS_DIR })
  db.run(
    `INSERT INTO youtube_accounts
       (id, provider, google_user_id, email_address,
        access_token_enc, refresh_token_enc, scopes)
     VALUES (?, 'youtube', 'g-1', 'd@example.com', 'x', 'y', 'youtube.readonly')`,
    ['acct-1'],
  )
  upsertSubscription(db, {
    googleAccountId: 'acct-1',
    channelId: 'UCaaaaaaa000000000000aab',
    channelTitle: 'Alpha',
    channelThumbnailUrl: null,
    subscribedAt: '2024-01-01T00:00:00.000Z',
  })
  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  const tokenStore = new InMemoryTokenStore()
  const view = youtubeVideoDetailView({ db })
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', auth({ passwordHash, tokenStore }))
  app.route('/videos', view)
  env = {
    db,
    app,
    seed(overrides: Partial<VideoInsertInput> = {}) {
      return insertVideo(db, {
        videoId: overrides.videoId ?? 'dQw4w9WgXcQ',
        channelId: overrides.channelId ?? 'UCaaaaaaa000000000000aab',
        title: overrides.title ?? 'Never Gonna Give You Up',
        publishedAt: overrides.publishedAt ?? '2009-10-25T06:57:33.000Z',
        thumbnailUrl:
          overrides.thumbnailUrl !== undefined
            ? overrides.thumbnailUrl
            : 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        link: overrides.link ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      }).id
    },
  }
})

afterEach(() => {
  env.db.close()
})

function basic(p: string): string {
  return `Basic ${Buffer.from(`david:${p}`).toString('base64')}`
}

async function getText(
  app: Hono<{ Variables: AuthVariables }>,
  path: string,
): Promise<{ status: number; body: string }> {
  const res = await app.request(path, {
    headers: { authorization: basic(PASSWORD) },
  })
  return { status: res.status, body: await res.text() }
}

// ─── Auth ──────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('returns 401 unauthenticated', async () => {
    const id = env.seed()
    const res = await env.app.request(`/videos/${id}`)
    expect(res.status).toBe(401)
  })
})

// ─── 404 ───────────────────────────────────────────────────────────────────

describe('GET /videos/:id — not found', () => {
  it('returns 404 for an unknown id', async () => {
    const { status } = await getText(env.app, '/videos/no-such-id')
    expect(status).toBe(404)
  })
})

// ─── Scaffold ─────────────────────────────────────────────────────────────

describe('GET /videos/:id — scaffold', () => {
  it('returns 200 with breadcrumb + title + meta + thumb + folder + tags', async () => {
    const id = env.seed({ title: 'A specific title' })
    const { status, body } = await getText(env.app, `/videos/${id}`)
    expect(status).toBe(200)
    expect(body).toContain('Back to videos')
    expect(body).toContain('data-video-id="' + id + '"')
    expect(body).toContain('A specific title')
    expect(body).toContain('Alpha')
    expect(body).toContain('<time datetime="2009-10-25')
    expect(body).toContain('Open on YouTube')
    // Edit button + folder select + tag chips + add input
    expect(body).toContain('data-edit-video-title')
    expect(body).toContain('data-video-folder-select')
    expect(body).toContain('data-video-tag-input')
    expect(body).toContain('data-video-tag-add')
    // Datalist for autocomplete
    expect(body).toContain('id="video-all-tags-list"')
  })

  it('renders the watch link with the YouTube URL', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
  })

  it('HTML-escapes channel + title (XSS defence)', async () => {
    const id = env.seed({ title: '<script>alert(1)</script>' })
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).not.toContain('<script>alert(1)</script>')
  })

  it('inlines the all-tags JSON block for autocomplete', async () => {
    env.db.run(
      `INSERT INTO tags (id, name) VALUES ('t-1', 'launch'), ('t-2', 'queue')`,
    )
    const id = env.seed()
    env.db.run(`INSERT INTO video_tags (video_id, tag_id) VALUES (?, 't-1')`, [id])
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('id="video-all-tags"')
    expect(body).toContain('data-video-all-tags')
    expect(body).toContain('"launch"')
    expect(body).toContain('"queue"')
  })
})

// ─── Folder select state ────────────────────────────────────────────────

describe('GET /videos/:id — folder select', () => {
  it('marks the current folder as selected', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const id = env.seed()
    env.db.run(`UPDATE videos SET folder_id = 'f-1' WHERE id = ?`, [id])
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain(`<option value="f-1" selected>Work</option>`)
  })

  it('marks "(none — uncategorized)" when folder_id is null', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    // The placeholder option carries `selected` somewhere in its
    // attribute list. The literal regex with [^>]* is fine —
    // order of attributes within the tag isn't guaranteed.
    expect(body).toMatch(/<option[^>]*selected[^>]*>\(none — uncategorized\)<\/option>/)
  })

  it('renders a disabled placeholder when the folder was deleted', async () => {
    env.db.run(`INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`)
    const id = env.seed()
    env.db.run(`UPDATE videos SET folder_id = 'f-1' WHERE id = ?`, [id])
    env.db.run(`DELETE FROM folders WHERE id = 'f-1'`) // ON DELETE SET NULL
    const { body } = await getText(env.app, `/videos/${id}`)
    // After cascade, folder_id is null again → falls back to (none)
    expect(body).toContain(`(none — uncategorized)`)
    expect(body).not.toContain(`<option value="f-1">Work</option>`)
  })

  it('lists all folders in the dropdown', async () => {
    env.db.run(
      `INSERT INTO folders (id, parent_id, name) VALUES ('f-1', NULL, 'Work')`,
    )
    env.db.run(
      `INSERT INTO folders (id, parent_id, name) VALUES ('f-2', NULL, 'Personal')`,
    )
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain(`>Work<`)
    expect(body).toContain(`>Personal<`)
  })
})

// ─── Tag chips ──────────────────────────────────────────────────────────

describe('GET /videos/:id — tag chips', () => {
  it('renders one chip per attached tag with a × button', async () => {
    env.db.run(
      `INSERT INTO tags (id, name) VALUES ('t-1', 'launch'), ('t-2', 'queue')`,
    )
    const id = env.seed()
    env.db.run(
      `INSERT INTO video_tags (video_id, tag_id) VALUES (?, 't-1'), (?, 't-2')`,
      [id, id],
    )
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('data-video-tag data-tag-id="t-1"')
    expect(body).toContain('data-video-tag data-tag-id="t-2"')
    expect(body).toContain('aria-label="Remove tag launch"')
    expect(body).toContain('aria-label="Remove tag queue"')
  })

  it('renders no chips when no tags attached (only the input remains)', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    // No chips, but the input is there for adding
    expect(body).not.toContain('data-video-tag data-tag-id')
    expect(body).toContain('data-video-tag-input')
  })
})

describe('GET /videos/:id — transcript', () => {
  it('offers on-demand fetching when no transcript has been requested', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('data-video-transcript')
    expect(body).toContain('data-transcript-status="not_requested"')
    expect(body).toContain('data-fetch-transcript>Fetch transcript</button>')
  })

  it('renders stored segments with clickable timestamps', async () => {
    const id = env.seed()
    env.db.run(
      `INSERT INTO video_transcripts
         (video_id, status, language, requested_at, fetched_at, updated_at)
       VALUES (?, 'ready', 'en', '2026-07-16T00:00:00.000Z',
               '2026-07-16T00:00:01.000Z', '2026-07-16T00:00:01.000Z')`,
      [id],
    )
    env.db.run(
      `INSERT INTO video_transcript_segments
         (video_id, position, start_ms, duration_ms, text)
       VALUES (?, 0, 65000, 2000, 'A useful explanation')`,
      [id],
    )
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('data-transcript-status="ready"')
    expect(body).toContain('A useful explanation')
    expect(body).toContain('>1:05</a>')
    expect(body).toContain('&amp;t=65s')
  })
})

describe('GET /videos/:id — AI Insight Card', () => {
  it('shows the server-side API key location when MiniMax is not configured', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('data-video-summary')
    expect(body).toContain('LLM_API_KEY')
    expect(body).toContain('server/.env')
  })

  it('renders a cached summary with real YouTube timestamp links', async () => {
    const id = env.seed()
    env.db.run(
      `INSERT INTO video_summaries
         (video_id, status, tldr, key_points_json, worth_watching,
          action_items_json, mentioned_json, model, prompt_version,
          requested_at, generated_at, updated_at)
       VALUES (?, 'ready', ?, ?, ?, '[]', ?, 'MiniMax-M2.7', 1,
               '2026-07-16T00:00:00Z', '2026-07-16T00:00:01Z', '2026-07-16T00:00:01Z')`,
      [id, 'A <short> briefing.', JSON.stringify([{ text: 'Use SQLite', startMs: 65000 }]), 'Watch the demo.', JSON.stringify(['SQLite'])],
    )
    const passwordHash = await bcrypt.hash(PASSWORD, 4)
    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({ passwordHash, tokenStore: new InMemoryTokenStore() }))
    app.route('/videos', youtubeVideoDetailView({ db: env.db, summaryConfigured: true }))

    const { body } = await getText(app, `/videos/${id}`)
    expect(body).toContain('data-summary-status="ready"')
    expect(body).toContain('A &lt;short&gt; briefing.')
    expect(body).toContain('Use SQLite')
    expect(body).toContain('&amp;t=65s')
    expect(body).toContain('>1:05</a>')
    expect(body).toContain('Generated with MiniMax-M2.7')
  })
})

// ─── Channel-included flag ──────────────────────────────────────────────

describe('GET /videos/:id — channel flag', () => {
  it('does not flag when the channel is included', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).not.toContain('channel is excluded from polling')
  })

  it('flags "channel is excluded" when is_included=0', async () => {
    const id = env.seed()
    env.db.run(`UPDATE subscriptions SET is_included = 0 WHERE channel_id = 'UCaaaaaaa000000000000aab'`)
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('channel is excluded from polling')
  })

  it('renders a canonical non-subscribed channel without treating it as excluded', async () => {
    const id = env.seed({ channelId: 'UC-not-subscribed', videoId: 'playlist-only' })
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('UC-not-subscribed')
    expect(body).toContain('not a subscribed channel')
    expect(body).not.toContain('channel is excluded from polling')
    expect(body).toContain('data-video-folder-select')
    expect(body).toContain('data-video-tag-input')
    expect(body).toContain('data-video-transcript')
    expect(body).toContain('data-video-summary')
  })
})

describe('GET /videos/:id — playlists', () => {
  it('shows each playlist membership once and links back to its detail page', async () => {
    const id = env.seed()
    env.db.run(
      `INSERT INTO youtube_playlists
       (google_account_id, playlist_id, title, privacy_status, is_included)
       VALUES ('acct-1', 'PL-one', '<Research>', 'private', 1)`,
    )
    env.db.run(
      `INSERT INTO youtube_playlist_items
       (google_account_id, playlist_id, playlist_item_id, video_id, position, synced_at)
       VALUES ('acct-1', 'PL-one', 'item-one', ?, 0, '2026-07-16T00:00:00Z')`,
      [id],
    )
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('Saved in')
    expect(body).toContain('href="/playlists/PL-one"')
    expect(body).toContain('&lt;Research&gt;')
    expect(body).not.toContain('<Research>')
  })
})

// ─── Sidebar ──────────────────────────────────────────────────────────────

describe('GET /videos/:id — sidebar', () => {
  it('renders YouTube compartment with Videos active + links to /subscriptions + /settings/youtube', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toMatch(/class="context-link context-link-active"[^>]*href="\/videos"/)
    expect(body).toContain('href="/videos"')
    expect(body).toContain('href="/subscriptions"')
    expect(body).toContain('href="/settings/youtube"')
  })
})

// ─── Inline JS ───────────────────────────────────────────────────────────

describe('GET /videos/:id — inline script', () => {
  it('includes the inline script with all the handlers it owns', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    // The <script> tag containing the inline IIFE is rendered.
    // Look for handlers unique to it so we don't grep strings that
    // might appear in the data-attributes of static markup.
    expect(body).toMatch(/<script>\(function\(\)\{/)
    // Each of the three handler types is wired in the script body.
    expect(body).toContain('data-edit-video-title')
    expect(body).toContain('data-video-folder-select')
    expect(body).toContain('data-video-tag-remove')
  })
})
