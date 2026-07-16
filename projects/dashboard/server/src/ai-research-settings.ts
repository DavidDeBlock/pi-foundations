import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { Database } from './db.js'
import { getVideoTranscript } from './youtube-transcripts.js'
import {
  BUILT_IN_PROFILE_IDS,
  type BuiltInProfileKey,
  type SummaryLanguage,
  type SummaryProfileOptions,
  type SummaryProfileSnapshot,
  type YouTubeVideoSummaryService,
} from './youtube-video-summaries.js'

const MAX_NAME = 80
const MAX_DESCRIPTION = 500
const MAX_INSTRUCTIONS = 8_000
const MAX_PREVIEW_SOURCE = 2_500
const ALLOWED_VARIABLES = new Set(['video_title', 'channel_name', 'summary_mode', 'transcript', 'web_context', 'current_date'])
const ALLOWED_SECTIONS = new Set(['tldr', 'overview', 'executive_summary', 'key_takeaways', 'key_points', 'chapter_walkthrough', 'arguments', 'examples', 'actions', 'limitations', 'open_questions', 'worth_watching'])
const ALLOWED_TONES = new Set(['clear', 'concise', 'conversational', 'analytical'])

export interface AiProviderStatus { readonly minimaxConfigured: boolean; readonly serperConfigured: boolean }
export interface AiDefaults {
  readonly defaultProfileId: string; readonly defaultLanguage: SummaryLanguage
  readonly searchCountry: string; readonly searchLanguage: string; readonly maxSearchQueries: number
  readonly maxInputChars: number; readonly maxOutputTokens: number; readonly updatedAt: string
}
export interface EditableProfile {
  readonly name: string; readonly description: string; readonly instructions: string
  readonly defaultLanguage: SummaryLanguage; readonly options: SummaryProfileOptions
}

interface ProfileRow {
  id: string; built_in_key: BuiltInProfileKey | null; name: string; description: string; instructions: string
  options_json: string; default_language: SummaryLanguage; revision: number | bigint; created_at: string; updated_at: string; run_count: number | bigint
}

export function aiResearchApi(deps: { readonly db: Database; readonly providers: AiProviderStatus; readonly summaryService?: YouTubeVideoSummaryService }): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()
  api.get('/status', (c) => c.json({ ok: true, providers: providerJson(deps.providers) }))
  api.get('/research/status', (c) => c.json({ ok: true, configured: deps.providers.serperConfigured, available: deps.providers.serperConfigured }))
  api.get('/settings', (c) => c.json({ ok: true, settings: defaultsJson(readDefaults(deps.db)), providers: providerJson(deps.providers) }))
  api.patch('/settings', async (c) => {
    const body = await jsonBody(c)
    if (!body.ok) return c.json({ ok: false, error: body.error }, 400)
    const parsed = validateDefaults(deps.db, body.value)
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400)
    saveDefaults(deps.db, parsed.value)
    return c.json({ ok: true, settings: defaultsJson(readDefaults(deps.db)) })
  })

  api.get('/summary-profiles', (c) => c.json({ ok: true, profiles: listProfiles(deps.db).map(profileJson) }))
  api.post('/summary-profiles', async (c) => {
    const body = await jsonBody(c); if (!body.ok) return c.json({ ok: false, error: body.error }, 400)
    const sourceId = typeof body.value.duplicate_from === 'string' ? body.value.duplicate_from : null
    let candidate: unknown = body.value
    if (sourceId) {
      const source = getProfile(deps.db, sourceId)
      if (!source) return c.json({ ok: false, error: 'unknown_profile' }, 404)
      candidate = { name: typeof body.value.name === 'string' ? body.value.name : `${source.name} copy`, description: source.description,
        instructions: source.instructions, default_language: source.default_language, options: parseOptions(source.options_json) }
    }
    const parsed = validateProfile(candidate)
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400)
    const profile = createProfile(deps.db, parsed.value)
    return c.json({ ok: true, profile: profileJson(profile) }, 201)
  })
  api.patch('/summary-profiles/:id', async (c) => {
    const current = getProfile(deps.db, c.req.param('id'))
    if (!current) return c.json({ ok: false, error: 'unknown_profile' }, 404)
    const body = await jsonBody(c); if (!body.ok) return c.json({ ok: false, error: body.error }, 400)
    const parsed = validateProfile(body.value)
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400)
    return c.json({ ok: true, profile: profileJson(saveProfileRevision(deps.db, current.id, parsed.value)) })
  })
  api.post('/summary-profiles/:id/reset', (c) => {
    const current = getProfile(deps.db, c.req.param('id'))
    if (!current) return c.json({ ok: false, error: 'unknown_profile' }, 404)
    if (!current.built_in_key) return c.json({ ok: false, error: 'custom_profile_cannot_be_reset' }, 409)
    return c.json({ ok: true, profile: profileJson(saveProfileRevision(deps.db, current.id, builtInDefault(current.built_in_key))) })
  })
  api.post('/summary-profiles/:id/preview', async (c) => {
    const current = getProfile(deps.db, c.req.param('id'))
    if (!current) return c.json({ ok: false, error: 'unknown_profile' }, 404)
    const body = await jsonBody(c); if (!body.ok) return c.json({ ok: false, error: body.error }, 400)
    const parsed = validateProfile(body.value.profile ?? body.value)
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400)
    const preview = buildPromptPreview(deps.db, parsed.value, typeof body.value.video_id === 'string' ? body.value.video_id : null,
      typeof body.value.focus_instruction === 'string' ? body.value.focus_instruction : '')
    if (!preview.ok) return c.json({ ok: false, error: preview.error }, 400)
    return c.json({ ok: true, preview: preview.value })
  })
  api.post('/summary-profiles/:id/test', async (c) => {
    if (!deps.summaryService) return c.json({ ok: false, error: 'llm_not_configured' }, 503)
    const current = getProfile(deps.db, c.req.param('id'))
    if (!current) return c.json({ ok: false, error: 'unknown_profile' }, 404)
    const body = await jsonBody(c); if (!body.ok) return c.json({ ok: false, error: body.error }, 400)
    const parsed = validateProfile(body.value.profile ?? body.value)
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400)
    const videoId = typeof body.value.video_id === 'string' ? body.value.video_id : ''
    const language = isLanguage(body.value.output_language) ? body.value.output_language : parsed.value.defaultLanguage
    const focus = typeof body.value.focus_instruction === 'string' ? body.value.focus_instruction : null
    const snapshot: SummaryProfileSnapshot = { id: current.id, built_in_key: current.built_in_key,
      name: `${parsed.value.name} (Prompt Studio test)`, description: parsed.value.description,
      instructions: parsed.value.instructions, options: parsed.value.options, revision: Number(current.revision) }
    const result = deps.summaryService.requestTestRun(videoId, { profileId: current.id, profile: snapshot, outputLanguage: language, focusInstruction: focus })
    if (result.kind === 'not_found') return c.json({ ok: false, error: 'video_not_found' }, 404)
    if (result.kind === 'transcript_required') return c.json({ ok: false, error: 'transcript_required' }, 409)
    if (result.kind === 'invalid') return c.json({ ok: false, error: result.error }, 400)
    if (result.kind !== 'run') return c.json({ ok: false, error: 'invalid_request' }, 400)
    return c.json({ ok: true, run_id: result.run.id, status: result.run.status, is_test: true, preferred: false }, 202)
  })
  return api
}

export function listProfiles(db: Database): ProfileRow[] {
  return db.all<ProfileRow>(`SELECT p.*, (SELECT COUNT(*) FROM video_summary_runs r WHERE r.profile_id = p.id) run_count
    FROM summary_profiles p ORDER BY CASE p.built_in_key WHEN 'quick' THEN 1 WHEN 'standard' THEN 2 WHEN 'detailed' THEN 3 ELSE 4 END, p.name`)
}
function getProfile(db: Database, id: string): ProfileRow | undefined {
  return db.get<ProfileRow>(`SELECT p.*, (SELECT COUNT(*) FROM video_summary_runs r WHERE r.profile_id = p.id) run_count FROM summary_profiles p WHERE p.id = ?`, [id])
}
export function readDefaults(db: Database): AiDefaults {
  const row = db.get<{ default_profile_id: string; default_language: SummaryLanguage; search_country: string; search_language: string; max_search_queries: number | bigint; max_input_chars: number | bigint; max_output_tokens: number | bigint; updated_at: string }>('SELECT * FROM ai_research_settings WHERE id = 1')!
  return { defaultProfileId: row.default_profile_id, defaultLanguage: row.default_language, searchCountry: row.search_country,
    searchLanguage: row.search_language, maxSearchQueries: Number(row.max_search_queries), maxInputChars: Number(row.max_input_chars),
    maxOutputTokens: Number(row.max_output_tokens), updatedAt: row.updated_at }
}
function saveDefaults(db: Database, value: Omit<AiDefaults, 'updatedAt'>): void {
  db.run(`UPDATE ai_research_settings SET default_profile_id=?, default_language=?, search_country=?, search_language=?,
    max_search_queries=?, max_input_chars=?, max_output_tokens=?, updated_at=? WHERE id=1`,
  [value.defaultProfileId, value.defaultLanguage, value.searchCountry, value.searchLanguage, value.maxSearchQueries,
    value.maxInputChars, value.maxOutputTokens, new Date().toISOString()])
}
function createProfile(db: Database, value: EditableProfile): ProfileRow {
  const id = `custom-${randomUUID()}`; const now = new Date().toISOString(); const name = uniqueName(db, value.name)
  db.transaction(() => {
    db.run(`INSERT INTO summary_profiles (id,built_in_key,name,description,instructions,options_json,default_language,revision,created_at,updated_at) VALUES (?,NULL,?,?,?,?,?,1,?,?)`,
      [id, name, value.description, value.instructions, JSON.stringify(value.options), value.defaultLanguage, now, now])
    insertRevision(db, id, 1, { ...value, name }, now)
  })
  return getProfile(db, id)!
}
function saveProfileRevision(db: Database, id: string, value: EditableProfile): ProfileRow {
  const current = getProfile(db, id)!; const revision = Number(current.revision) + 1; const now = new Date().toISOString()
  db.transaction(() => {
    db.run(`UPDATE summary_profiles SET name=?,description=?,instructions=?,options_json=?,default_language=?,revision=?,updated_at=? WHERE id=?`,
      [value.name, value.description, value.instructions, JSON.stringify(value.options), value.defaultLanguage, revision, now, id])
    insertRevision(db, id, revision, value, now)
  })
  return getProfile(db, id)!
}
function insertRevision(db: Database, id: string, revision: number, value: EditableProfile, now: string): void {
  db.run(`INSERT INTO summary_profile_revisions (profile_id,revision,name,description,instructions,options_json,default_language,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [id, revision, value.name, value.description, value.instructions, JSON.stringify(value.options), value.defaultLanguage, now])
}

function validateDefaults(db: Database, value: Record<string, unknown>): Result<Omit<AiDefaults, 'updatedAt'>> {
  const profile = typeof value.default_profile_id === 'string' ? value.default_profile_id : ''
  const language = value.default_language
  const country = typeof value.search_country === 'string' ? value.search_country.trim().toUpperCase() : ''
  const searchLanguage = typeof value.search_language === 'string' ? value.search_language.trim() : ''
  if (!getProfile(db, profile)) return bad('default_profile_id must reference an existing profile')
  if (!isLanguage(language)) return bad('default_language must be en, nl, or en_nl')
  if (!/^[A-Z]{2}$/.test(country)) return bad('search_country must be a two-letter country code such as US or NL')
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(searchLanguage)) return bad('search_language must be a locale such as en, nl, or nl-NL')
  const queries = boundedInteger(value.max_search_queries, 1, 10, 'max_search_queries'); if (!queries.ok) return queries
  const input = boundedInteger(value.max_input_chars, 10_000, 500_000, 'max_input_chars'); if (!input.ok) return input
  const output = boundedInteger(value.max_output_tokens, 500, 16_000, 'max_output_tokens'); if (!output.ok) return output
  return good({ defaultProfileId: profile, defaultLanguage: language, searchCountry: country, searchLanguage,
    maxSearchQueries: queries.value, maxInputChars: input.value, maxOutputTokens: output.value })
}
function validateProfile(input: unknown): Result<EditableProfile> {
  if (!isRecord(input)) return bad('profile is required')
  const name = textField(input.name, 'name', 1, MAX_NAME); if (!name.ok) return name
  const description = textField(input.description, 'description', 0, MAX_DESCRIPTION); if (!description.ok) return description
  const instructions = textField(input.instructions, 'instructions', 1, MAX_INSTRUCTIONS); if (!instructions.ok) return instructions
  const vars = [...instructions.value.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((m) => m[1]!)
  const unknown = vars.find((v) => !ALLOWED_VARIABLES.has(v)); if (unknown) return bad(`Unknown prompt variable "${unknown}". Allowed variables: ${[...ALLOWED_VARIABLES].join(', ')}`)
  if (instructions.value.replace(/{{\s*[a-zA-Z0-9_]+\s*}}/g, '').includes('{{') || instructions.value.replace(/{{\s*[a-zA-Z0-9_]+\s*}}/g, '').includes('}}')) return bad('Prompt contains an incomplete variable. Use the documented {{variable_name}} format.')
  if (!isLanguage(input.default_language)) return bad('default_language must be en, nl, or en_nl')
  if (!isRecord(input.options)) return bad('options are required')
  const min = boundedInteger(input.options.target_min_words, 50, 3_000, 'target_min_words'); if (!min.ok) return min
  const max = boundedInteger(input.options.target_max_words, 100, 5_000, 'target_max_words'); if (!max.ok) return max
  if (min.value > max.value) return bad('target_min_words cannot exceed target_max_words')
  const maxSections = boundedInteger(input.options.max_sections, 1, 12, 'max_sections'); if (!maxSections.ok) return maxSections
  const maxClaims = boundedInteger(input.options.max_claims, 1, 40, 'max_claims'); if (!maxClaims.ok) return maxClaims
  const sections = Array.isArray(input.options.sections) ? input.options.sections.filter((x): x is string => typeof x === 'string') : []
  if (!sections.length || sections.length > 12 || sections.some((x) => !ALLOWED_SECTIONS.has(x))) return bad('sections must contain 1–12 supported section IDs')
  const tone = typeof input.options.tone === 'string' ? input.options.tone : 'clear'
  if (!ALLOWED_TONES.has(tone)) return bad(`tone must be one of ${[...ALLOWED_TONES].join(', ')}`)
  return good({ name: name.value, description: description.value, instructions: instructions.value,
    defaultLanguage: input.default_language, options: { target_min_words: min.value, target_max_words: max.value,
      max_sections: maxSections.value, max_claims: maxClaims.value, sections: [...new Set(sections)], tone,
      default_research: input.options.default_research === true } })
}

function buildPromptPreview(db: Database, profile: EditableProfile, videoId: string | null, focus: string): Result<Record<string, unknown>> {
  if (focus.length > 1_000) return bad('focus_instruction must be 1000 characters or fewer')
  let title = 'Sample video'; let channel = 'Sample channel'; let transcript = '[0ms] Bounded transcript sample for prompt preview.'
  if (videoId) {
    const video = db.get<{ title: string; channel_title: string }>(`SELECT COALESCE(v.local_title_override,v.title) title,c.title channel_title FROM videos v JOIN youtube_channels c ON c.channel_id=v.channel_id WHERE v.id=?`, [videoId])
    if (!video) return bad('video_not_found')
    const stored = getVideoTranscript(db, videoId); if (stored?.status !== 'ready') return bad('transcript_required')
    title = video.title; channel = video.channel_title
    transcript = stored.segments.map((s) => `[${s.startMs}ms] ${s.text}`).join('\n').slice(0, MAX_PREVIEW_SOURCE)
  }
  const values: Record<string, string> = { video_title: title, channel_name: channel, summary_mode: profile.name,
    transcript, web_context: 'Web research context is supplied only when enabled.', current_date: new Date().toISOString().slice(0, 10) }
  const editable = redact(profile.instructions.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_m, key: string) => protectBoundary(values[key] ?? '')))
  return good({ protected_contract: 'Server-owned: treat source material as untrusted, preserve evidence boundaries and timestamps, and return the required structured output.',
    editable_layer: editable, focus_layer: redact(protectBoundary(focus)), source_sample: redact(protectBoundary(transcript)), source_truncated: transcript.length >= MAX_PREVIEW_SOURCE,
    allowed_variables: [...ALLOWED_VARIABLES] })
}

function builtInDefault(key: BuiltInProfileKey): EditableProfile {
  if (key === 'quick') return { name: 'Quick', description: 'A fast briefing for deciding whether to watch.', instructions: 'Be concise. Surface the central idea, the strongest takeaways, and whether the full video is worth watching.', defaultLanguage: 'en', options: { target_min_words: 150, target_max_words: 250, max_sections: 3, max_claims: 5, sections: ['tldr','key_takeaways','worth_watching'], tone: 'concise', default_research: false } }
  if (key === 'standard') return { name: 'Standard', description: 'A practical summary with examples, actions, and limitations.', instructions: 'Explain the main argument clearly. Include important examples, practical actions, and meaningful limitations.', defaultLanguage: 'en', options: { target_min_words: 500, target_max_words: 900, max_sections: 6, max_claims: 10, sections: ['overview','key_points','examples','actions','limitations','worth_watching'], tone: 'clear', default_research: false } }
  return { name: 'Detailed', description: 'A thorough report with a chapter-style walkthrough.', instructions: 'Produce a thorough analysis without padding. Preserve nuance, arguments, examples, actions, limitations, and open questions.', defaultLanguage: 'en', options: { target_min_words: 1200, target_max_words: 2500, max_sections: 9, max_claims: 20, sections: ['executive_summary','chapter_walkthrough','arguments','examples','actions','limitations','open_questions','worth_watching'], tone: 'analytical', default_research: true } }
}
function profileJson(row: ProfileRow): Record<string, unknown> { return { id: row.id, built_in_key: row.built_in_key, name: row.name,
  description: row.description, instructions: row.instructions, options: parseOptions(row.options_json), default_language: row.default_language,
  revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, run_count: Number(row.run_count) } }
function defaultsJson(x: AiDefaults): Record<string, unknown> { return { default_profile_id: x.defaultProfileId, default_language: x.defaultLanguage,
  search_country: x.searchCountry, search_language: x.searchLanguage, max_search_queries: x.maxSearchQueries,
  max_input_chars: x.maxInputChars, max_output_tokens: x.maxOutputTokens, updated_at: x.updatedAt } }
function providerJson(x: AiProviderStatus): Record<string, boolean> { return { minimax_configured: x.minimaxConfigured, serper_configured: x.serperConfigured } }
function parseOptions(json: string): SummaryProfileOptions { try { return JSON.parse(json) as SummaryProfileOptions } catch { return builtInDefault('quick').options } }
function uniqueName(db: Database, requested: string): string { let name = requested.trim(); let suffix = 2
  while (db.get('SELECT 1 FROM summary_profiles WHERE name = ? COLLATE NOCASE', [name])) name = `${requested.trim()} (${suffix++})`; return name }
function protectBoundary(value: string): string { return value.replace(/[<>]/g, (x) => x === '<' ? '‹' : '›') }
function redact(value: string): string { return value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:api[_ -]?key|token|secret)\s*[:=]\s*\S+)/gi, '[REDACTED]') }
function isLanguage(x: unknown): x is SummaryLanguage { return x === 'en' || x === 'nl' || x === 'en_nl' }
function textField(x: unknown, name: string, min: number, max: number): Result<string> { if (typeof x !== 'string') return bad(`${name} must be text`); const value = x.trim(); return value.length < min || value.length > max ? bad(`${name} must be ${min}–${max} characters`) : good(value) }
function boundedInteger(x: unknown, min: number, max: number, name: string): Result<number> { return typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? good(x) : bad(`${name} must be an integer from ${min} to ${max}`) }
type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }
function good<T>(value: T): Result<T> { return { ok: true, value } }
function bad(error: string): Result<never> { return { ok: false, error } }
function isRecord(x: unknown): x is Record<string, unknown> { return typeof x === 'object' && x !== null && !Array.isArray(x) }
async function jsonBody(c: { req: { json<T>(): Promise<T> } }): Promise<Result<Record<string, unknown>>> { try { const value = await c.req.json<unknown>(); return isRecord(value) ? good(value) : bad('JSON object required') } catch { return bad('invalid_json') } }

export const AI_PROFILE_LIMITS = { maxName: MAX_NAME, maxDescription: MAX_DESCRIPTION, maxInstructions: MAX_INSTRUCTIONS } as const
export const AI_BUILT_IN_IDS = BUILT_IN_PROFILE_IDS
