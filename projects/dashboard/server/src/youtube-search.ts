import type { Database } from './db.js'
import { upsertYouTubeVideo } from './youtube-video-upsert.js'

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search'
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos'
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

export interface YouTubeSearchResult {
  readonly videoId: string
  readonly title: string
  readonly channelId: string
  readonly channelTitle: string
  readonly publishedAt: string
  readonly thumbnailUrl: string | null
  readonly description: string
  readonly durationSeconds: number
  readonly viewCount: number | null
  readonly embeddable: boolean
}

export class YouTubeSearchService {
  readonly #db: Database
  readonly #apiKey: string | null
  readonly #accessToken: (() => Promise<string>) | null
  readonly #fetch: typeof fetch
  readonly #nowMs: () => number
  readonly #cacheTtlMs: number

  constructor(deps: { readonly db: Database; readonly apiKey?: string | null; readonly accessToken?: () => Promise<string>; readonly fetchFn?: typeof fetch; readonly nowMs?: () => number; readonly cacheTtlMs?: number }) {
    this.#db = deps.db
    this.#apiKey = deps.apiKey?.trim() || null
    this.#accessToken = deps.accessToken ?? null
    this.#fetch = deps.fetchFn ?? fetch
    this.#nowMs = deps.nowMs ?? (() => Date.now())
    this.#cacheTtlMs = deps.cacheTtlMs ?? 60 * 60 * 1000
  }

  async search(rawQuery: string): Promise<{ items: readonly YouTubeSearchResult[]; cached: boolean }> {
    const query = rawQuery.trim().replace(/\s+/g, ' ')
    if (query.length < 1 || query.length > 100) throw new RangeError('Search query must be between 1 and 100 characters.')
    const key = query.toLocaleLowerCase('en-US')
    const now = new Date(this.#nowMs())
    const cached = this.#db.get<{ response_json: string }>('SELECT response_json FROM youtube_search_cache WHERE query_key = ? AND expires_at > ?', [key, now.toISOString()])
    if (cached) try { return { items: JSON.parse(cached.response_json) as YouTubeSearchResult[], cached: true } } catch { /* refetch */ }
    const searchUrl = new URL(SEARCH_URL)
    searchUrl.searchParams.set('part', 'snippet'); searchUrl.searchParams.set('type', 'video'); searchUrl.searchParams.set('maxResults', '20'); searchUrl.searchParams.set('q', query)
    const searchBody = await this.#request(searchUrl)
    const ids = Array.isArray(searchBody.items) ? searchBody.items.flatMap((item) => isRecord(item) && isRecord(item.id) && typeof item.id.videoId === 'string' && VIDEO_ID.test(item.id.videoId) ? [item.id.videoId] : []) : []
    const items = await this.#details(ids)
    this.#db.run(`INSERT INTO youtube_search_cache (query_key,response_json,fetched_at,expires_at) VALUES (?,?,?,?) ON CONFLICT(query_key) DO UPDATE SET response_json=excluded.response_json,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at`, [key, JSON.stringify(items), now.toISOString(), new Date(now.getTime() + this.#cacheTtlMs).toISOString()])
    return { items, cached: false }
  }

  async open(videoId: string): Promise<string> {
    if (!VIDEO_ID.test(videoId)) throw new RangeError('Invalid YouTube video id.')
    const [detail] = await this.#details([videoId])
    if (!detail) throw new YouTubeSearchNotFoundError()
    return upsertYouTubeVideo(this.#db, { videoId: detail.videoId, channelId: detail.channelId, channelTitle: detail.channelTitle, title: detail.title, publishedAt: detail.publishedAt, thumbnailUrl: detail.thumbnailUrl, link: `https://www.youtube.com/watch?v=${encodeURIComponent(detail.videoId)}`, origin: { type: 'manual', sourceId: 'youtube-search' } }).id
  }

  async #details(ids: readonly string[]): Promise<YouTubeSearchResult[]> {
    if (!ids.length) return []
    const url = new URL(VIDEOS_URL)
    url.searchParams.set('part', 'snippet,contentDetails,statistics,status'); url.searchParams.set('id', ids.join(',')); url.searchParams.set('maxResults', String(ids.length))
    const body = await this.#request(url)
    if (!Array.isArray(body.items)) throw new YouTubeSearchError('YouTube returned an invalid video-details response.')
    const byId = new Map<string, YouTubeSearchResult>()
    for (const item of body.items) {
      if (!isRecord(item) || typeof item.id !== 'string' || !VIDEO_ID.test(item.id) || !isRecord(item.snippet) || typeof item.snippet.title !== 'string' || typeof item.snippet.channelId !== 'string' || typeof item.snippet.channelTitle !== 'string' || typeof item.snippet.publishedAt !== 'string') continue
      const thumbnails = isRecord(item.snippet.thumbnails) ? item.snippet.thumbnails : null
      const thumb = thumbnails && (isRecord(thumbnails.medium) ? thumbnails.medium : isRecord(thumbnails.high) ? thumbnails.high : null)
      const viewRaw = isRecord(item.statistics) ? item.statistics.viewCount : null
      const status = isRecord(item.status) ? item.status : null
      byId.set(item.id, { videoId:item.id, title:item.snippet.title, channelId:item.snippet.channelId, channelTitle:item.snippet.channelTitle, publishedAt:item.snippet.publishedAt, thumbnailUrl:thumb && typeof thumb.url === 'string' ? thumb.url : null, description:typeof item.snippet.description === 'string' ? item.snippet.description : '', durationSeconds:isRecord(item.contentDetails) && typeof item.contentDetails.duration === 'string' ? parseDuration(item.contentDetails.duration) : 0, viewCount:typeof viewRaw === 'string' && /^\d+$/.test(viewRaw) ? Number(viewRaw) : null, embeddable:status?.embeddable === true })
    }
    return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : [])
  }

  async #request(url: URL): Promise<Record<string, unknown>> {
    if (this.#apiKey) {
      url.searchParams.set('key', this.#apiKey)
      return requestJson(this.#fetch, url, {})
    }
    if (this.#accessToken) {
      return requestJson(this.#fetch, url, { authorization: `Bearer ${await this.#accessToken()}` })
    }
    throw new YouTubeSearchError('YouTube search needs a server-side API key. Set YOUTUBE_API_KEY and restart the dashboard.')
  }
}

export class YouTubeSearchError extends Error {}
export class YouTubeSearchNotFoundError extends Error {}
async function requestJson(fetchFn: typeof fetch, url: URL, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, { headers })
  let body: unknown
  try { body = await response.json() } catch {
    if (!response.ok) throw new YouTubeSearchError(`YouTube search failed (HTTP ${response.status}).`)
    throw new YouTubeSearchError('YouTube returned invalid JSON.')
  }
  if (!response.ok) throw googleError(response.status, body)
  if (!isRecord(body)) throw new YouTubeSearchError('YouTube returned an invalid response.')
  return body
}
function googleError(status:number,body:unknown):YouTubeSearchError {
  const error=isRecord(body)&&isRecord(body.error)?body.error:null
  const reasons=error&&Array.isArray(error.errors)?error.errors.flatMap((entry:unknown)=>isRecord(entry)&&typeof entry.reason==='string'?[entry.reason]:[]):[]
  if(reasons.includes('insufficientPermissions')) return new YouTubeSearchError('YouTube search needs a server-side API key. Set YOUTUBE_API_KEY and restart the dashboard.')
  if(reasons.some((reason:string)=>['quotaExceeded','dailyLimitExceeded','dailyLimitExceededUnreg'].includes(reason))) return new YouTubeSearchError('YouTube search quota is exhausted. Try again after the quota resets.')
  if(reasons.some((reason:string)=>['rateLimitExceeded','userRateLimitExceeded'].includes(reason))) return new YouTubeSearchError('YouTube search is temporarily rate-limited. Wait a moment and try again.')
  if(reasons.includes('accessNotConfigured')) return new YouTubeSearchError('Enable YouTube Data API v3 for the Google Cloud project used by YOUTUBE_API_KEY.')
  const message=error&&typeof error.message==='string'?error.message:''
  return new YouTubeSearchError(message?`YouTube search failed: ${message}`:`YouTube search failed (HTTP ${status}).`)
}
function parseDuration(value:string):number{const m=value.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);return m?Number(m[1]??0)*86400+Number(m[2]??0)*3600+Number(m[3]??0)*60+Number(m[4]??0):0}
function isRecord(value:unknown):value is Record<string,any>{return typeof value==='object'&&value!==null}
