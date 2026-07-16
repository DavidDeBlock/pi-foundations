import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import {
  getPreferredVideoSummaryRun,
  getVideoSummary,
  getVideoSummaryRun,
  listVideoSummaryRuns,
  type VideoSummary,
  type VideoSummaryRun,
  type YouTubeVideoSummaryService,
} from './youtube-video-summaries.js'

export function youtubeVideoSummariesApi(deps: {
  readonly db: Database
  readonly service?: YouTubeVideoSummaryService
}): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/:id/summaries', (c) => {
    const videoId = c.req.param('id')
    if (!videoExists(deps.db, videoId)) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json({ ok: true, configured: deps.service !== undefined,
      preferred_run_id: getPreferredVideoSummaryRun(deps.db, videoId)?.id ?? null,
      summaries: listVideoSummaryRuns(deps.db, videoId).map(toApiRunMetadata) })
  })

  api.post('/:id/summaries', async (c) => {
    if (!deps.service) return c.json({ ok: false, error: 'llm_not_configured' }, 503)
    let body: Record<string, unknown>
    try { body = await c.req.json<Record<string, unknown>>() } catch { return c.json({ ok: false, error: 'invalid_json' }, 400) }
    const result = deps.service.requestRun(c.req.param('id'), {
      profileId: typeof body.profile_id === 'string' ? body.profile_id : '',
      outputLanguage: typeof body.output_language === 'string' ? body.output_language as 'en' | 'nl' | 'en_nl' : 'en',
      focusInstruction: typeof body.focus_instruction === 'string' ? body.focus_instruction : null,
      research: body.research === true,
    })
    if (result.kind === 'not_found') return c.json({ ok: false, error: 'not_found' }, 404)
    if (result.kind === 'transcript_required') return c.json({ ok: false, error: 'transcript_required' }, 409)
    if (result.kind === 'research_unavailable') return c.json({ ok: false, error: 'research_not_configured' }, 503)
    if (result.kind === 'invalid') return c.json({ ok: false, error: result.error }, 400)
    if (result.kind !== 'run') return c.json({ ok: false, error: 'invalid_request' }, 400)
    return c.json({ ok: true, summary: toApiRun(result.run) }, 202)
  })

  api.get('/:id/summaries/:runId', (c) => {
    if (!videoExists(deps.db, c.req.param('id'))) return c.json({ ok: false, error: 'not_found' }, 404)
    const run = getVideoSummaryRun(deps.db, c.req.param('id'), c.req.param('runId'))
    return run ? c.json({ ok: true, summary: toApiRun(run) }) : c.json({ ok: false, error: 'not_found' }, 404)
  })

  api.post('/:id/summaries/:runId/prefer', (c) => {
    if (!deps.service) return c.json({ ok: false, error: 'llm_not_configured' }, 503)
    return deps.service.prefer(c.req.param('id'), c.req.param('runId')) === 'ok'
      ? c.json({ ok: true, preferred_run_id: c.req.param('runId') })
      : c.json({ ok: false, error: 'not_found' }, 404)
  })

  // Temporary v3.0 compatibility façade. It reads the preferred run and a
  // forced POST creates a fresh immutable Quick/English run.
  api.get('/:id/summary', (c) => {
    const videoId = c.req.param('id')
    if (!videoExists(deps.db, videoId)) return c.json({ ok: false, error: 'not_found' }, 404)
    const summary = getVideoSummary(deps.db, videoId)
    return c.json({ ok: true, configured: deps.service !== undefined, summary: summary ? toApiSummary(summary) : null })
  })

  api.post('/:id/summary', async (c) => {
    if (!deps.service) return c.json({ ok: false, error: 'llm_not_configured' }, 503)
    let force = false
    try { const body = await c.req.json<{ force?: unknown }>(); force = body.force === true } catch { /* empty body */ }
    const result = deps.service.request(c.req.param('id'), { force })
    if (result.kind === 'not_found') return c.json({ ok: false, error: 'not_found' }, 404)
    if (result.kind === 'transcript_required') return c.json({ ok: false, error: 'transcript_required' }, 409)
    if (result.kind === 'invalid') return c.json({ ok: false, error: result.error }, 400)
    if (result.kind !== 'summary') return c.json({ ok: false, error: 'invalid_request' }, 400)
    return c.json({ ok: true, summary: toApiSummary(result.summary) }, result.summary.status === 'ready' ? 200 : 202)
  })

  return api
}

function videoExists(db: Database, videoId: string): boolean { return db.get('SELECT id FROM videos WHERE id = ?', [videoId]) !== undefined }

function toApiRunMetadata(run: VideoSummaryRun): Record<string, unknown> {
  return { id: run.id, status: run.status, profile_id: run.profileId, profile: {
    name: run.profile.name, built_in_key: run.profile.built_in_key, revision: run.profile.revision,
  }, output_language: run.outputLanguage, focus_instruction: run.focusInstruction, model: run.model,
  research_status: run.researchStatus, requested_at: run.requestedAt, generated_at: run.generatedAt,
  research_country: run.researchCountry, research_language: run.researchLanguage,
  research_query_limit: run.researchQueryLimit, research_error_message: run.researchErrorMessage,
  source_count: run.sources.length, error_message: run.errorMessage, preferred: run.preferred, is_test: run.isTest }
}

function toApiRun(run: VideoSummaryRun): Record<string, unknown> {
  return { ...toApiRunMetadata(run), prompt_revision: run.promptRevision,
    transcript_fingerprint: run.transcriptFingerprint, profile_snapshot: run.profile,
    evidence: run.evidence, outputs: run.outputs, sources: run.sources.map((source) => ({
      id: source.id, position: source.position, query: source.query, title: source.title, url: source.url,
      domain: source.domain, snippet: source.snippet, published_at: source.publishedAt, retrieved_at: source.retrievedAt,
    })) }
}

function toApiSummary(summary: VideoSummary): Record<string, unknown> {
  return { run_id: summary.runId, status: summary.status, tldr: summary.tldr,
    key_points: summary.keyPoints.map(toApiInsight), worth_watching: summary.worthWatching,
    action_items: summary.actionItems.map(toApiInsight), mentioned: summary.mentioned,
    model: summary.model, prompt_version: summary.promptVersion, requested_at: summary.requestedAt,
    generated_at: summary.generatedAt, error_message: summary.errorMessage }
}
function toApiInsight(insight: { readonly text: string; readonly startMs: number | null }): Record<string, unknown> {
  return { text: insight.text, start_ms: insight.startMs }
}
