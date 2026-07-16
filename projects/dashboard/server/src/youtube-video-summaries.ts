import type { Database } from './db.js'
import { OpenAiCompatibleLlmClient } from './llm-client.js'
import { getVideoTranscript, type TranscriptSegment } from './youtube-transcripts.js'

export const VIDEO_SUMMARY_PROMPT_VERSION = 1

export type VideoSummaryStatus = 'pending' | 'ready' | 'failed'

export interface CitedInsight {
  readonly text: string
  readonly startMs: number | null
}

export interface VideoSummary {
  readonly videoId: string
  readonly status: VideoSummaryStatus
  readonly tldr: string | null
  readonly keyPoints: ReadonlyArray<CitedInsight>
  readonly worthWatching: string | null
  readonly actionItems: ReadonlyArray<CitedInsight>
  readonly mentioned: ReadonlyArray<string>
  readonly model: string
  readonly promptVersion: number
  readonly requestedAt: string
  readonly generatedAt: string | null
  readonly errorMessage: string | null
}

interface SummaryRow {
  video_id: string
  status: VideoSummaryStatus
  tldr: string | null
  key_points_json: string | null
  worth_watching: string | null
  action_items_json: string | null
  mentioned_json: string | null
  model: string
  prompt_version: number | bigint
  requested_at: string
  generated_at: string | null
  error_message: string | null
}

export function getVideoSummary(db: Database, videoId: string): VideoSummary | null {
  const row = db.get<SummaryRow>(
    `SELECT video_id, status, tldr, key_points_json, worth_watching,
            action_items_json, mentioned_json, model, prompt_version,
            requested_at, generated_at, error_message
       FROM video_summaries WHERE video_id = ?`,
    [videoId],
  )
  if (!row) return null
  return {
    videoId: row.video_id,
    status: row.status,
    tldr: row.tldr,
    keyPoints: parseCitedInsights(row.key_points_json),
    worthWatching: row.worth_watching,
    actionItems: parseCitedInsights(row.action_items_json),
    mentioned: parseStrings(row.mentioned_json),
    model: row.model,
    promptVersion: Number(row.prompt_version),
    requestedAt: row.requested_at,
    generatedAt: row.generated_at,
    errorMessage: row.error_message,
  }
}

export interface GeneratedVideoSummary {
  readonly tldr: string
  readonly keyPoints: ReadonlyArray<CitedInsight>
  readonly worthWatching: string
  readonly actionItems: ReadonlyArray<CitedInsight>
  readonly mentioned: ReadonlyArray<string>
}

export interface VideoSummarizer {
  readonly model: string
  summarize(input: {
    readonly title: string
    readonly channelTitle: string
    readonly segments: ReadonlyArray<TranscriptSegment>
  }): Promise<GeneratedVideoSummary>
}

/** MiniMax-backed summarizer using the provider-neutral chat client. */
export class MiniMaxVideoSummarizer implements VideoSummarizer {
  readonly model: string
  readonly #client: OpenAiCompatibleLlmClient

  constructor(client: OpenAiCompatibleLlmClient) {
    this.#client = client
    this.model = client.model
  }

  async summarize(input: {
    readonly title: string
    readonly channelTitle: string
    readonly segments: ReadonlyArray<TranscriptSegment>
  }): Promise<GeneratedVideoSummary> {
    const raw = await this.#client.complete([
      { role: 'system', content: summarySystemPrompt() },
      { role: 'user', content: summaryUserPrompt(input) },
    ])
    return parseGeneratedSummary(raw, input.segments)
  }
}

export function summarySystemPrompt(): string {
  return `You create concise, trustworthy YouTube Insight Cards from timed transcripts.
Use only information in the transcript. Do not invent claims, products, or timestamps.
Return ONLY one valid JSON object with this exact shape:
{"tldr":"2-3 sentences","key_points":[{"text":"...","start_ms":1234}],"worth_watching":"What the full video adds, or why a skim is enough","action_items":[{"text":"...","start_ms":1234}],"mentioned":["name or tool"]}
Rules: provide 3-7 key points; keep each point concise; use transcript start_ms values exactly; action_items may be empty; mentioned may be empty; no markdown or code fences.`
}

export function summaryUserPrompt(input: {
  readonly title: string
  readonly channelTitle: string
  readonly segments: ReadonlyArray<TranscriptSegment>
}): string {
  const transcript = input.segments
    .map((segment) => `[${segment.startMs}ms | ${formatTimestamp(segment.startMs)}] ${segment.text}`)
    .join('\n')
  return `Video: ${input.title}\nChannel: ${input.channelTitle}\n\nTimed transcript:\n${transcript}`
}

export function parseGeneratedSummary(
  raw: string,
  segments: ReadonlyArray<TranscriptSegment>,
): GeneratedVideoSummary {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error('LLM returned invalid summary JSON')

  let value: unknown
  try {
    value = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1))
  } catch {
    throw new Error('LLM returned invalid summary JSON')
  }
  if (!isRecord(value)) throw new Error('LLM summary must be a JSON object')

  const tldr = requiredString(value.tldr, 'tldr')
  const worthWatching = requiredString(value.worth_watching, 'worth_watching')
  const keyPoints = parseGeneratedCitations(value.key_points, segments, 7)
  if (keyPoints.length < 1) throw new Error('LLM summary did not include key points')
  const actionItems = parseGeneratedCitations(value.action_items, segments, 5)
  const mentioned = Array.isArray(value.mentioned)
    ? value.mentioned.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim()).slice(0, 12)
    : []
  return { tldr, keyPoints, worthWatching, actionItems, mentioned }
}

function parseGeneratedCitations(
  value: unknown,
  segments: ReadonlyArray<TranscriptSegment>,
  limit: number,
): CitedInsight[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, limit).flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== 'string' || item.text.trim() === '') return []
    const requested = typeof item.start_ms === 'number' && Number.isFinite(item.start_ms)
      ? Math.max(0, Math.round(item.start_ms))
      : null
    return [{ text: item.text.trim(), startMs: nearestSegmentStart(requested, segments) }]
  })
}

function nearestSegmentStart(
  requested: number | null,
  segments: ReadonlyArray<TranscriptSegment>,
): number | null {
  if (requested === null || segments.length === 0) return null
  let closest = segments[0]!.startMs
  let distance = Math.abs(closest - requested)
  for (const segment of segments.slice(1)) {
    const candidate = Math.abs(segment.startMs - requested)
    if (candidate < distance) {
      closest = segment.startMs
      distance = candidate
    }
  }
  return closest
}

export type SummaryRequestResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'transcript_required' }
  | { readonly kind: 'summary'; readonly summary: VideoSummary }

export class YouTubeVideoSummaryService {
  readonly #db: Database
  readonly #summarizer: VideoSummarizer
  readonly #nowMs: () => number
  readonly #queue: string[] = []
  readonly #queued = new Set<string>()
  readonly #idleWaiters = new Set<() => void>()
  #active = false

  constructor(deps: {
    readonly db: Database
    readonly summarizer: VideoSummarizer
    readonly nowMs?: () => number
  }) {
    this.#db = deps.db
    this.#summarizer = deps.summarizer
    this.#nowMs = deps.nowMs ?? (() => Date.now())
  }

  request(videoId: string, options: { readonly force?: boolean } = {}): SummaryRequestResult {
    const exists = this.#db.get<{ id: string }>('SELECT id FROM videos WHERE id = ?', [videoId])
    if (!exists) return { kind: 'not_found' }
    const transcript = getVideoTranscript(this.#db, videoId)
    if (transcript?.status !== 'ready') return { kind: 'transcript_required' }
    const current = getVideoSummary(this.#db, videoId)
    if (current?.status === 'ready' && !options.force) return { kind: 'summary', summary: current }

    const now = this.#nowIso()
    this.#db.run(
      `INSERT INTO video_summaries
         (video_id, status, tldr, key_points_json, worth_watching,
          action_items_json, mentioned_json, model, prompt_version,
          requested_at, generated_at, error_message, updated_at)
       VALUES (?, 'pending', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         status = 'pending', tldr = NULL, key_points_json = NULL,
         worth_watching = NULL, action_items_json = NULL, mentioned_json = NULL,
         model = excluded.model, prompt_version = excluded.prompt_version,
         requested_at = excluded.requested_at, generated_at = NULL,
         error_message = NULL, updated_at = excluded.updated_at`,
      [videoId, this.#summarizer.model, VIDEO_SUMMARY_PROMPT_VERSION, now, now],
    )
    this.#enqueue(videoId)
    return { kind: 'summary', summary: getVideoSummary(this.#db, videoId)! }
  }

  resumePending(): number {
    const rows = this.#db.all<{ video_id: string }>(
      `SELECT video_id FROM video_summaries WHERE status = 'pending' ORDER BY requested_at`,
    )
    for (const row of rows) this.#enqueue(row.video_id)
    return rows.length
  }

  whenIdle(): Promise<void> {
    if (!this.#active && this.#queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.#idleWaiters.add(resolve))
  }

  #enqueue(videoId: string): void {
    if (this.#queued.has(videoId)) return
    this.#queued.add(videoId)
    this.#queue.push(videoId)
    this.#drain()
  }

  #drain(): void {
    if (this.#active) return
    const videoId = this.#queue.shift()
    if (!videoId) {
      for (const resolve of this.#idleWaiters) resolve()
      this.#idleWaiters.clear()
      return
    }
    this.#active = true
    void this.#process(videoId).finally(() => {
      this.#active = false
      this.#queued.delete(videoId)
      this.#drain()
    })
  }

  async #process(videoId: string): Promise<void> {
    const video = this.#db.get<{ title: string; channel_title: string }>(
      `SELECT COALESCE(v.local_title_override, v.title) AS title,
              c.title AS channel_title
         FROM videos v JOIN youtube_channels c ON c.channel_id = v.channel_id
        WHERE v.id = ?`,
      [videoId],
    )
    const transcript = getVideoTranscript(this.#db, videoId)
    if (!video || transcript?.status !== 'ready') {
      this.#saveFailure(videoId, 'Transcript is no longer available')
      return
    }
    try {
      const generated = await this.#summarizer.summarize({
        title: video.title,
        channelTitle: video.channel_title,
        segments: transcript.segments,
      })
      const now = this.#nowIso()
      this.#db.run(
        `UPDATE video_summaries SET
           status = 'ready', tldr = ?, key_points_json = ?, worth_watching = ?,
           action_items_json = ?, mentioned_json = ?, generated_at = ?,
           error_message = NULL, updated_at = ?
         WHERE video_id = ?`,
        [
          generated.tldr,
          JSON.stringify(generated.keyPoints),
          generated.worthWatching,
          JSON.stringify(generated.actionItems),
          JSON.stringify(generated.mentioned),
          now,
          now,
          videoId,
        ],
      )
    } catch (error: unknown) {
      this.#saveFailure(videoId, error instanceof Error ? error.message : String(error))
    }
  }

  #saveFailure(videoId: string, message: string): void {
    const now = this.#nowIso()
    this.#db.run(
      `UPDATE video_summaries
          SET status = 'failed', error_message = ?, generated_at = ?, updated_at = ?
        WHERE video_id = ?`,
      [message.slice(0, 500), now, now, videoId],
    )
  }

  #nowIso(): string {
    return new Date(this.#nowMs()).toISOString()
  }
}

function parseCitedInsights(json: string | null): CitedInsight[] {
  if (!json) return []
  try {
    const value = JSON.parse(json) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (!isRecord(item) || typeof item.text !== 'string') return []
      return [{
        text: item.text,
        startMs: typeof item.startMs === 'number' ? item.startMs : null,
      }]
    })
  } catch {
    return []
  }
}

function parseStrings(json: string | null): string[] {
  if (!json) return []
  try {
    const value = JSON.parse(json) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`LLM summary is missing ${field}`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}
