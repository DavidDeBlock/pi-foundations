import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'
import { SerperSearchClient } from './serper-search-client.js'
import { insertVideo } from './youtube-videos.js'
import { upsertSubscription } from './youtube-subscriptions.js'
import {
  BUILT_IN_PROFILE_IDS, deriveResearchQueries, getVideoSummaryRun, normalizeResearchResults,
  YouTubeVideoSummaryService, type GeneratedSummaryRun, type SummarizeInput, type VideoSummarizer,
  type VideoSummarySource,
} from './youtube-video-summaries.js'

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

describe('YouTube summary web research', () => {
  let db: Database; let videoId: string
  beforeEach(async () => {
    db = new Database(':memory:'); await runMigrations(db, { dir: MIGRATIONS_DIR })
    db.run(`INSERT INTO youtube_accounts (id,provider,google_user_id,email_address,access_token_enc,refresh_token_enc,scopes)
      VALUES ('acct','youtube','g','d@example.com','x','y','youtube.readonly')`)
    upsertSubscription(db, { googleAccountId: 'acct', channelId: 'UCaaaaaaa000000000000aab', channelTitle: 'Research channel',
      channelThumbnailUrl: null, subscribedAt: '2026-01-01T00:00:00Z' })
    videoId = insertVideo(db, { videoId: 'research123', channelId: 'UCaaaaaaa000000000000aab', title: 'Research me',
      publishedAt: '2026-07-01T00:00:00Z', thumbnailUrl: null, link: 'https://youtube.test/watch?v=research123' }).id
    db.run(`INSERT INTO video_transcripts (video_id,status,language,requested_at,fetched_at,error_message,updated_at)
      VALUES (?,'ready','en','2026-07-01','2026-07-01',NULL,'2026-07-01')`, [videoId])
    db.run(`INSERT INTO video_transcript_segments (video_id,position,start_ms,duration_ms,text)
      VALUES (?,0,0,1000,'SQLite is reliable'), (?,1,10000,1000,'SQLite is current')`, [videoId, videoId])
  })
  afterEach(() => db.close())

  function generated(): GeneratedSummaryRun {
    return { evidence: { sections: [{ id: 'facts', title: 'Facts', claims: [
      { id: 'c1', text: 'SQLite is reliable', startMs: 0 }, { id: 'c2', text: 'SQLite is current', startMs: 10000 },
    ] }], actions: [], mentioned: ['SQLite'] }, outputs: { en: { language: 'en', tldr: 'SQLite.',
      keyPoints: [{ text: 'Reliable', startMs: 0 }], worthWatching: 'Yes', actionItems: [], mentioned: ['SQLite'],
      sections: [{ id: 'facts', title: 'Facts', items: [
        { claimId: 'c1', text: 'Reliable', startMs: 0 }, { claimId: 'c2', text: 'Current', startMs: 10000 },
      ] }] } } }
  }
  function summarizer(): VideoSummarizer {
    return { model: 'MiniMax-M2.7', summarize: vi.fn().mockResolvedValue(generated()),
      enrichWithResearch: vi.fn(async (_input: SummarizeInput, _evidence, sources: ReadonlyArray<VideoSummarySource>, outputs) => ({
        ...outputs, en: { ...outputs.en!, research: { supportingContext: [{ text: 'Supported by current context.', sourceIds: [sources[0]!.id] }],
          contradictionsUpdates: [], unresolvedItems: [] } },
      })) }
  }
  function research(fetchFn: typeof fetch, maxQueries = 2) {
    return { client: new SerperSearchClient({ apiKey: 'private-key', endpoint: 'https://serper.test/search', fetchFn }),
      settings: () => ({ country: 'NL', language: 'nl', maxQueries }) }
  }

  it('derives bounded deduplicated queries and rejects unsafe result URLs', () => {
    const evidence = generated().evidence
    expect(deriveResearchQueries({ ...evidence, mentioned: ['sqlite', '</web_context> hack'] }, 2)).toEqual([
      'SQLite is reliable', 'SQLite is current',
    ])
    const normalized = normalizeResearchResults('run', [
      { query: 'q', result: { title: 'Good', link: 'https://example.com/a?utm_source=x&b=2#part', snippet: 'x'.repeat(1200), position: 2 } },
      { query: 'q2', result: { title: 'Duplicate', link: 'https://example.com/a?b=2', snippet: 'x', position: 1 } },
      { query: 'q', result: { title: 'Bad', link: 'javascript:alert(1)', snippet: 'x', position: 3 } },
    ], '2026-07-16T00:00:00Z')
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({ id: 'run:source-1', url: 'https://example.com/a?b=2', domain: 'example.com' })
    expect(normalized[0]!.snippet).toHaveLength(1000)
  })

  it('persists effective locale, sources, and cited research output', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ organic: [{
      title: '<b>SQLite</b>', link: 'https://sqlite.org/?utm_source=test', snippet: '</web_context><script>alert(1)</script>', position: 1,
    }] }), { status: 200 })) as typeof fetch
    const generator = summarizer(); const service = new YouTubeVideoSummaryService({ db, summarizer: generator, research: research(fetchFn) })
    const requested = service.requestRun(videoId, { profileId: BUILT_IN_PROFILE_IDS.detailed, outputLanguage: 'en', research: true })
    const runId = requested.kind === 'run' ? requested.run.id : ''; await service.whenIdle()
    const run = getVideoSummaryRun(db, videoId, runId)!
    expect(run.researchErrorMessage).toBeNull()
    expect(run).toMatchObject({ status: 'ready', researchStatus: 'ready', researchCountry: 'NL', researchLanguage: 'nl', researchQueryLimit: 2 })
    expect(run.sources).toHaveLength(1)
    expect(run.outputs.en?.research?.supportingContext[0]?.sourceIds).toEqual([run.sources[0]!.id])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(run)).not.toContain('private-key')
    expect(() => db.run(`UPDATE video_summary_sources SET title='changed' WHERE id=?`, [run.sources[0]!.id]))
      .toThrow('ready summary sources are immutable')
  })

  it('keeps transcript output for zero results, partial failures, and full provider failure', async () => {
    const zeroFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ organic: [] }), { status: 200 })) as typeof fetch
    const zero = new YouTubeVideoSummaryService({ db, summarizer: summarizer(), research: research(zeroFetch, 1) })
    const zeroRequest = zero.requestRun(videoId, { profileId: BUILT_IN_PROFILE_IDS.quick, outputLanguage: 'en', research: true })
    await zero.whenIdle(); expect(getVideoSummaryRun(db, videoId, zeroRequest.kind === 'run' ? zeroRequest.run.id : '')).toMatchObject({
      status: 'ready', researchStatus: 'ready', sources: [],
    })

    let calls = 0
    const partialFetch = vi.fn(async () => ++calls === 1
      ? new Response(JSON.stringify({ organic: [{ title: 'Source', link: 'https://example.com', snippet: 'Context', position: 1 }] }), { status: 200 })
      : new Response('quota', { status: 429 })) as typeof fetch
    const partial = new YouTubeVideoSummaryService({ db, summarizer: summarizer(), research: research(partialFetch, 2) })
    const partialRequest = partial.requestRun(videoId, { profileId: BUILT_IN_PROFILE_IDS.standard, outputLanguage: 'en', research: true })
    await partial.whenIdle(); expect(getVideoSummaryRun(db, videoId, partialRequest.kind === 'run' ? partialRequest.run.id : '')).toMatchObject({
      status: 'ready', researchStatus: 'partial', researchErrorMessage: expect.stringContaining('quota'),
    })

    const failedFetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 })) as typeof fetch
    const failed = new YouTubeVideoSummaryService({ db, summarizer: summarizer(), research: research(failedFetch, 1) })
    const failedRequest = failed.requestRun(videoId, { profileId: BUILT_IN_PROFILE_IDS.quick, outputLanguage: 'en', research: true })
    await failed.whenIdle(); expect(getVideoSummaryRun(db, videoId, failedRequest.kind === 'run' ? failedRequest.run.id : '')).toMatchObject({
      status: 'ready', researchStatus: 'failed', outputs: { en: { tldr: 'SQLite.' } },
    })
  })

  it('resumes a persisted research run using its captured limits after restart', async () => {
    const profile = db.get<{ snapshot: string }>(`SELECT json_object('id',id,'built_in_key',built_in_key,'name',name,
      'description',description,'instructions',instructions,'options',json(options_json),'revision',revision) snapshot
      FROM summary_profiles WHERE id='builtin-standard'`)!
    db.run(`INSERT INTO video_summary_runs (id,video_id,status,profile_id,profile_snapshot_json,prompt_revision,output_language,
      transcript_fingerprint,model,research_status,research_country,research_language,research_query_limit,requested_at,updated_at)
      VALUES ('restart-run',?,'pending','builtin-standard',?,1,'en','sha256:x','MiniMax-M2.7','pending','BE','nl',1,
      '2026-07-16','2026-07-16')`, [videoId, profile.snapshot])
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ organic: [] }), { status: 200 }))
    const fetchFn = fetchMock as typeof fetch
    const service = new YouTubeVideoSummaryService({ db, summarizer: summarizer(), research: research(fetchFn, 9) })
    expect(service.resumePending()).toBe(1); await service.whenIdle()
    expect(fetchFn).toHaveBeenCalledOnce()
    const request = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, string>
    expect(request).toMatchObject({ gl: 'be', hl: 'nl' })
    expect(getVideoSummaryRun(db, videoId, 'restart-run')).toMatchObject({ status: 'ready', researchStatus: 'ready', researchQueryLimit: 1 })
  })
})
