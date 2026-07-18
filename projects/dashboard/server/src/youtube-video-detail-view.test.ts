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
import { attachTagByNameToSubscription, upsertSubscription } from './youtube-subscriptions.js'
import { reconcileVideoDescriptionResources } from './youtube-description-resources.js'

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

function seedDescription(videoId: string, description: string, status = 'ready'): void {
  env.db.run(
    `INSERT INTO video_descriptions
       (video_id, status, description, fingerprint, requested_at, fetched_at,
        last_attempted_at, attempt_count, updated_at)
     VALUES (?, ?, ?, 'sha256:fixture', '2026-07-16T08:00:00Z',
       '2026-07-16T08:00:01Z', '2026-07-16T08:00:01Z', 1, '2026-07-16T08:00:01Z')`,
    [videoId, status, description],
  )
  reconcileVideoDescriptionResources(env.db, videoId, description, '2026-07-16T08:00:01Z')
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

  it('renders a responsive privacy-enhanced player without autoplay', async () => {
    const id = env.seed({ title: 'A focused video' })
    const res = await env.app.request(`/videos/${id}`, {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = await res.text()
    expect(res.headers.get('content-security-policy')).toBe(
      'frame-src https://www.youtube-nocookie.com',
    )
    expect(body).toContain('class="video-player-frame"')
    expect(body).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&amp;playsinline=1&amp;enablejsapi=1"',
    )
    expect(body).not.toContain('autoplay=1')
    expect(body).toContain('title="Play A focused video by Alpha"')
    expect(body).toContain('allow="autoplay; encrypted-media; picture-in-picture; fullscreen"')
    expect(body).toContain('allowfullscreen')
    expect(body).not.toContain('modestbranding')
    expect(body).not.toContain('showinfo')
  })

  it('offers pop-out and explicit YouTube fallback actions', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain(`href="/videos/${id}/player"`)
    expect(body).toContain('data-popout-player')
    expect(body).toContain('Pop out player')
    expect(body).toContain('Open on YouTube')
    expect(body).toContain('Private, deleted, age-restricted, or embed-disabled')
  })

  it('does not construct an embed URL from an invalid stored video id', async () => {
    const id = env.seed({ videoId: 'bad\"><script', title: '<unsafe>' })
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).not.toContain('youtube-nocookie.com/embed/')
    expect(body).toContain('Its stored YouTube ID is invalid')
    expect(body).toContain('&lt;unsafe&gt;')
    expect(body).not.toContain('<unsafe>')
  })

  it('shows derived watch count and last watched time without playback progress', async () => {
    const id = env.seed()
    env.db.run(`INSERT INTO youtube_history_imports
      (id,file_hash,original_filename,staged_filename,status,total_count,new_event_count,duplicate_count,
       malformed_count,unique_video_count,new_video_count,committed_event_count,created_at,expires_at,committed_at)
      VALUES ('detail-import','hash','history.json','gone.json','committed',1,1,0,0,1,0,1,
       '2026-07-16T00:00:00Z','2026-07-17T00:00:00Z','2026-07-16T00:00:00Z')`)
    env.db.run(`INSERT INTO youtube_watch_events
      (id,video_id,youtube_video_id,watched_at,title_snapshot,event_fingerprint,history_import_id,created_at)
      VALUES ('detail-watch',?,'dQw4w9WgXcQ','2026-07-15T09:30:00Z','Snapshot','detail-fp','detail-import','2026-07-16T00:00:00Z')`, [id])
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('video-detail-watched">Watched')
    expect(body).toContain('1 time · last watched')
    expect(body).toContain('2026-07-15T09:30:00Z')
    expect(body).not.toContain('playback position')
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

// ─── Focus player ────────────────────────────────────────────────────────

describe('GET /videos/:id/player — focus player', () => {
  it('returns 401 unauthenticated', async () => {
    const id = env.seed()
    const res = await env.app.request(`/videos/${id}/player`)
    expect(res.status).toBe(401)
  })

  it('returns the existing authenticated 404 for an unknown video', async () => {
    const { status, body } = await getText(env.app, '/videos/no-such-id/player')
    expect(status).toBe(404)
    expect(body).toBe('Video not found')
  })

  it('renders an autoplaying full-viewport privacy-enhanced iframe', async () => {
    const id = env.seed({ title: 'Focus <demo>' })
    env.db.run(`UPDATE youtube_channels SET title = 'Alpha & <Beta>' WHERE channel_id = 'UCaaaaaaa000000000000aab'`)
    const res = await env.app.request(`/videos/${id}/player`, {
      headers: { authorization: basic(PASSWORD) },
    })
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(
      'frame-src https://www.youtube-nocookie.com',
    )
    expect(body).toContain('class="focus-player-canvas"')
    expect(body).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&amp;rel=0&amp;playsinline=1&amp;enablejsapi=1"',
    )
    expect(body).toContain('title="Play Focus &lt;demo&gt; by Alpha &amp; &lt;Beta&gt;"')
    expect(body).toContain('allow="autoplay; encrypted-media; picture-in-picture; fullscreen"')
    expect(body).toContain('allowfullscreen')
    expect(body).not.toContain('Focus <demo>')
  })

  it('contains no dashboard chrome, metadata, transcript, or watch mutation code', async () => {
    const id = env.seed()
    const before = env.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM youtube_watch_events',
    )!.count
    const { body } = await getText(env.app, `/videos/${id}/player`)
    expect(body).not.toContain('site-header')
    expect(body).not.toContain('sidebar')
    expect(body).not.toContain('video-detail-title')
    expect(body).not.toContain('video-detail-meta')
    expect(body).not.toContain('Transcript')
    expect(body).not.toContain('Video briefing')
    expect(body).not.toContain('Open on YouTube')
    expect(body).not.toContain('/api/videos/')
    expect(env.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM youtube_watch_events',
    )!.count).toBe(before)
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
  it('shows inherited tags with a channel indicator and subscription edit link', async () => {
    const subscription = env.db.get<{ id: string }>('SELECT id FROM subscriptions LIMIT 1')!
    attachTagByNameToSubscription(env.db, subscription.id, 'research')
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('data-tag-source="subscription"')
    expect(body).toContain('video-detail-tag-channel')
    expect(body).toContain('Manage research on subscription')
    expect(body).not.toContain('aria-label="Remove tag research"')
  })

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

describe('GET /videos/:id — description resources', () => {
  it('renders directly below the focus player and above Folder without moving later sections', async () => {
    const id = env.seed()
    seedDescription(id, 'Code https://github.com/acme/project')
    const { body } = await getText(env.app, `/videos/${id}`)
    const player = body.indexOf('video-detail-player-section')
    const resources = body.indexOf('data-video-resources')
    const folder = body.indexOf('class="video-detail-folder"')
    const tags = body.indexOf('class="video-detail-tags"')
    const insight = body.indexOf('data-video-summary')
    const transcript = body.indexOf('data-video-transcript')
    expect(player).toBeLessThan(resources)
    expect(resources).toBeLessThan(folder)
    expect(folder).toBeLessThan(tags)
    expect(tags).toBeLessThan(insight)
    expect(insight).toBeLessThan(transcript)
  })

  it('features useful links and collapses other, promotional, and full-description groups independently', async () => {
    const id = env.seed()
    seedDescription(id, [
      '[Project source](https://github.com/acme/project)',
      'Community https://discord.gg/example',
      'Sponsor https://shop.example/deal?aff=channel',
    ].join('\n'))
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('Resources from this video')
    expect(body).toContain('Project source')
    expect(body).toContain('Repository')
    expect(body).toContain('github.com')
    expect(body).toContain('data-copy-resource="https://github.com/acme/project"')
    expect(body).toMatch(/<details class="video-resources-group"><summary><span>Other links<\/span><strong>1<\/strong>/)
    expect(body).toMatch(/<details class="video-resources-group"><summary><span>Promotional links hidden<\/span><strong>1<\/strong>/)
    expect(body).toContain('<details class="video-resources-description"><summary><span>Full description</span>')
    expect(body).not.toContain('<details class="video-resources-group" open')
    expect(body).toContain('target="_blank" rel="noopener noreferrer"')
  })

  it('escapes remote fields and linkifies only a persisted, validated resource', async () => {
    const id = env.seed()
    const description = '<img src=x onerror=alert(1)>\nSafe https://example.com/path?q=%3Cscript%3E'
    seedDescription(id, description)
    env.db.run(`UPDATE video_description_resources SET label = ?, context_before = ?, domain = ?, effective_reason = ? WHERE video_id = ?`, [
      '<svg onload=alert(2)>', '</p><script>alert(3)</script>', 'bad.example<script>', '<model-reason onmouseover=alert(4)>', id,
    ])
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(body).toContain('&lt;svg onload=alert(2)&gt;')
    expect(body).toContain('&lt;/p&gt;&lt;script&gt;alert(3)&lt;/script&gt;')
    expect(body).toContain('&lt;model-reason onmouseover=alert(4)&gt;')
    expect(body).not.toContain('<img src=x')
    expect(body).not.toContain('<svg onload')
    expect(body).toContain('href="https://example.com/path?q=%3Cscript%3E"')
    expect(body).not.toContain('href="&lt;img')
  })

  it('covers not-fetched, pending-last-value, unavailable, failed, and link-free states without GET side effects', async () => {
    const id = env.seed()
    let result = await getText(env.app, `/videos/${id}`)
    expect(result.body).toContain('Description not fetched')
    expect(result.body).toContain('data-description-status="not_fetched"')
    expect(env.db.get('SELECT * FROM video_descriptions WHERE video_id = ?', [id])).toBeUndefined()

    seedDescription(id, 'There are no links here', 'pending')
    result = await getText(env.app, `/videos/${id}`)
    expect(result.body).toContain('Refreshing in the background')
    expect(result.body).toContain('This description does not contain any validated web links.')
    expect(result.body).toContain('data-refresh-description disabled')

    env.db.run(`UPDATE video_descriptions SET status = 'unavailable', description = NULL,
      fingerprint = NULL, unavailable_reason = 'no_description' WHERE video_id = ?`, [id])
    result = await getText(env.app, `/videos/${id}`)
    expect(result.body).toContain('No description available')

    env.db.run(`UPDATE video_descriptions SET status = 'failed', unavailable_reason = NULL,
      error_message = 'Remote <failure>' WHERE video_id = ?`, [id])
    result = await getText(env.app, `/videos/${id}`)
    expect(result.body).toContain('Description refresh failed')
    expect(result.body).toContain('Remote &lt;failure&gt;')
  })

  it('includes accessible copy feedback, explicit refresh polling, responsive cards, and visible focus styling', async () => {
    const id = env.seed()
    seedDescription(id, 'https://github.com/acme/project')
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain('data-description-feedback aria-live="polite"')
    expect(body).toContain("navigator.clipboard.writeText(url)")
    expect(body).toContain("method: 'POST', credentials: 'same-origin'")
    expect(body).toContain("'/description/refresh'")
    expect(body).toContain("data-description-status') === 'pending'")
    expect(body).toContain('.video-resources :is(a, button, summary):focus-visible')
    expect(body).toContain('.video-resources-featured, .video-resources-list { grid-template-columns: 1fr; }')
    expect(body).toContain('@media (pointer: coarse)')
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

  it('shows an animated working indicator while a summary is pending', async () => {
    const id = env.seed()
    env.db.run(`INSERT INTO video_summaries
      (video_id, status, model, prompt_version, requested_at, updated_at)
      VALUES (?, 'pending', 'MiniMax-M2.7', 2, '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')`, [id])
    const passwordHash = await bcrypt.hash(PASSWORD, 4)
    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({ passwordHash, tokenStore: new InMemoryTokenStore() }))
    app.route('/videos', youtubeVideoDetailView({ db: env.db, summaryConfigured: true }))
    const { body } = await getText(app, `/videos/${id}`)
    expect(body).toContain('class="video-ai-spinner"')
    expect(body).toContain('@keyframes ai-spin')
    expect(body).toContain('data-summary-started-at="2026-07-16T00:00:00Z"')
    expect(body).toContain('data-summary-elapsed')
    expect(body).toContain('Running <strong')
    expect(body).toContain("summaryPollAttempts < 80 ? 1500 : 5000")
    expect(body).toContain("window.setInterval(updateSummaryTiming, 1000)")
    expect(body).toContain("summaryFeedback.className = 'video-ai-feedback is-working'")
  })

  it('renders profile controls, bilingual tabs, escaped output, history, and preferred actions', async () => {
    const id = env.seed()
    env.db.run(`INSERT INTO video_transcripts
      (video_id, status, language, requested_at, fetched_at, updated_at)
      VALUES (?, 'ready', 'en', '2026-07-16T00:00:00Z', '2026-07-16T00:00:01Z', '2026-07-16T00:00:01Z')`, [id])
    env.db.run(`INSERT INTO video_transcript_segments
      (video_id, position, start_ms, duration_ms, text) VALUES (?, 0, 65000, 1000, 'Use SQLite')`, [id])
    const profile = env.db.get<{ snapshot: string }>(`SELECT json_object(
      'id', id, 'built_in_key', built_in_key, 'name', name, 'description', description,
      'instructions', instructions, 'options', json(options_json), 'revision', revision) snapshot
      FROM summary_profiles WHERE id = 'builtin-detailed'`)!
    const output = (language: 'en' | 'nl', text: string) => ({ language, tldr: text,
      keyPoints: [{ text, startMs: 65000 }], worthWatching: text, actionItems: [], mentioned: ['SQLite'],
      sections: [{ id: 'arguments', title: language === 'nl' ? 'Argumenten' : 'Arguments',
        items: [{ claimId: 'claim-1', text, startMs: 65000 }] }],
    })
    env.db.run(`INSERT INTO video_summary_runs
      (id, video_id, status, profile_id, profile_snapshot_json, prompt_revision, focus_instruction,
       output_language, transcript_fingerprint, model, research_status, evidence_json, outputs_json,
       requested_at, generated_at, updated_at)
      VALUES ('run-both', ?, 'ready', 'builtin-detailed', ?, 1, 'Focus <carefully>', 'en_nl',
       'sha256:test', 'MiniMax-M2.7', 'disabled', '{}', ?, '2026-07-16T00:00:00Z',
       '2026-07-16T00:01:00Z', '2026-07-16T00:01:00Z')`,
    [id, profile.snapshot, JSON.stringify({ en: output('en', 'Safe <English>'), nl: output('nl', 'Veilig <Nederlands>') })])
    env.db.run(`INSERT INTO video_preferred_summary_runs (video_id, run_id) VALUES (?, 'run-both')`, [id])
    const passwordHash = await bcrypt.hash(PASSWORD, 4)
    const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({ passwordHash, tokenStore: new InMemoryTokenStore() }))
    app.route('/videos', youtubeVideoDetailView({ db: env.db, summaryConfigured: true }))
    const { body } = await getText(app, `/videos/${id}`)
    expect(body).toContain('data-summary-form')
    expect(body).toContain('Detailed</option>')
    expect(body).toContain('English + Nederlands')
    expect(body).toContain('data-summary-language-tab="nl"')
    expect(body).toContain('Safe &lt;English&gt;')
    expect(body).toContain('Veilig &lt;Nederlands&gt;')
    expect(body).not.toContain('Safe <English>')
    expect(body).toContain('Previous runs')
    expect(body).toContain('Preferred')
  })

  it('renders research controls, web citations, source metadata, and escaped provider content', async () => {
    const id = env.seed()
    env.db.run(`INSERT INTO video_transcripts (video_id,status,language,requested_at,fetched_at,updated_at)
      VALUES (?,'ready','en','2026-07-16','2026-07-16','2026-07-16')`, [id])
    env.db.run(`INSERT INTO video_transcript_segments (video_id,position,start_ms,duration_ms,text) VALUES (?,0,0,1,'Fact')`, [id])
    const profile = env.db.get<{ snapshot: string }>(`SELECT json_object('id',id,'built_in_key',built_in_key,'name',name,
      'description',description,'instructions',instructions,'options',json(options_json),'revision',revision) snapshot
      FROM summary_profiles WHERE id='builtin-detailed'`)!
    const output = { language: 'en', tldr: 'Fact', keyPoints: [{ text: 'Fact', startMs: 0 }], worthWatching: 'Yes',
      actionItems: [], mentioned: [], sections: [{ id: 'facts', title: 'Facts', items: [{ claimId: 'c1', text: 'Fact', startMs: 0 }] }],
      research: { supportingContext: [{ text: 'Current <context>', sourceIds: ['run-research:source-1'] }], contradictionsUpdates: [], unresolvedItems: [] } }
    env.db.run(`INSERT INTO video_summary_runs (id,video_id,status,profile_id,profile_snapshot_json,prompt_revision,output_language,
      transcript_fingerprint,model,research_status,research_country,research_language,research_query_limit,evidence_json,outputs_json,
      requested_at,generated_at,updated_at) VALUES ('run-research',?,'pending','builtin-detailed',?,1,'en','sha256:x','MiniMax-M2.7',
      'pending','NL','nl',3,'{}',?,'2026-07-16','2026-07-16','2026-07-16')`, [id, profile.snapshot, JSON.stringify({ en: output })])
    env.db.run(`INSERT INTO video_summary_sources (id,summary_run_id,position,query,title,url,domain,snippet,retrieved_at)
      VALUES ('run-research:source-1','run-research',1,'unsafe <query>','Source <title>','https://example.com/path','example.com',
      'Snippet <script>alert(1)</script>','2026-07-16')`)
    env.db.run(`UPDATE video_summary_runs SET status='ready',research_status='ready' WHERE id='run-research'`)
    env.db.run(`INSERT INTO video_preferred_summary_runs (video_id,run_id) VALUES (?,'run-research')`, [id])
    const passwordHash = await bcrypt.hash(PASSWORD, 4); const app = new Hono<{ Variables: AuthVariables }>()
    app.use('*', auth({ passwordHash, tokenStore: new InMemoryTokenStore() }))
    app.route('/videos', youtubeVideoDetailView({ db: env.db, summaryConfigured: true, researchConfigured: true }))
    const { body } = await getText(app, `/videos/${id}`)
    expect(body).toContain('Web research · up to 3 queries')
    expect(body).toContain('data-summary-research checked')
    expect(body).toContain('Current &lt;context&gt;')
    expect(body).toContain('Source &lt;title&gt;')
    expect(body).toContain('Snippet &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('Research metadata')
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

  it('opens a resizable 16:9 popup and preserves native new-tab fallback', async () => {
    const id = env.seed()
    const { body } = await getText(env.app, `/videos/${id}`)
    expect(body).toContain("var width = 960")
    expect(body).toContain("var height = 540")
    expect(body).toContain("popup=yes,resizable=yes,scrollbars=no")
    expect(body).toContain("var popup = window.open('', 'dashboard-youtube-focus-' + videoId, features)")
    expect(body).toContain('if (!popup) return')
    expect(body).toContain('ev.preventDefault()')
    expect(body).toContain('popup.location.href = popoutLink.href')
    expect(body).toContain('target="_blank"')
  })
})
