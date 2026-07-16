import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'

export const RESOURCE_CATEGORIES = [
  'repository', 'documentation', 'tool', 'article', 'dataset', 'community',
  'creator', 'social', 'promotional', 'other',
] as const
export type VideoResourceCategory = typeof RESOURCE_CATEGORIES[number]
export type VideoResourceVisibility = 'featured' | 'normal' | 'hidden'

export interface ExtractedVideoResource {
  readonly originalUrl: string
  readonly canonicalUrl: string
  readonly domain: string
  readonly label: string | null
  readonly contextBefore: string
  readonly contextAfter: string
  readonly sourcePositions: readonly number[]
  readonly firstPosition: number
  readonly category: VideoResourceCategory
  readonly visibility: VideoResourceVisibility
  readonly confidence: number
  readonly reason: string
}

export interface VideoDescriptionResource extends ExtractedVideoResource {
  readonly id: string
  readonly videoId: string
  readonly automaticCategory: VideoResourceCategory
  readonly automaticVisibility: VideoResourceVisibility
  readonly automaticSource: string
  readonly automaticReason: string
  readonly effectiveCategory: VideoResourceCategory
  readonly effectiveVisibility: VideoResourceVisibility
  readonly effectiveSource: string
  readonly effectiveReason: string
  readonly present: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

type Mutable<T> = { -readonly [Property in keyof T]: T[Property] }
interface MutableExtracted extends Mutable<Omit<ExtractedVideoResource, 'sourcePositions'>> {
  sourcePositions: number[]
}

interface ResourceRow {
  id: string
  video_id: string
  original_url: string
  canonical_url: string
  domain: string
  label: string | null
  context_before: string
  context_after: string
  source_positions_json: string
  first_position: number | bigint
  automatic_category: VideoResourceCategory
  automatic_visibility: VideoResourceVisibility
  automatic_confidence: number | null
  automatic_source: string
  automatic_reason: string
  effective_category: VideoResourceCategory
  effective_visibility: VideoResourceVisibility
  effective_source: string
  effective_reason: string
  is_present: number | bigint
  created_at: string
  updated_at: string
}

const MAX_URL_LENGTH = 4_096
const MAX_LABEL_LENGTH = 200
const CONTEXT_LENGTH = 240
const MAX_POSITIONS = 100
const TRACKING_PARAMETERS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi',
])
const AFFILIATE_PARAMETERS = new Set([
  'ref', 'ref_', 'affiliate', 'aff', 'aff_id', 'affid', 'partner', 'tag', 'ascsubtag',
])

/** Pure, deterministic extraction. It never follows or requests a URL. */
export function extractVideoDescriptionResources(description: string): ExtractedVideoResource[] {
  const labels = markdownLabels(description)
  const resources = new Map<string, MutableExtracted>()
  const matcher = /https?:\/\/[^\s<>"'`]+/giu
  for (const match of description.matchAll(matcher)) {
    const position = match.index
    const originalUrl = trimUrlPunctuation(match[0])
    if (!originalUrl || originalUrl.length > MAX_URL_LENGTH) continue
    const normalized = normalizeResourceUrl(originalUrl)
    if (!normalized) continue
    const end = position + originalUrl.length
    const lineStart = description.lastIndexOf('\n', position - 1) + 1
    const nextLine = description.indexOf('\n', end)
    const lineEnd = nextLine === -1 ? description.length : nextLine
    const contextBefore = boundedContext(description.slice(Math.max(lineStart, position - CONTEXT_LENGTH), position))
    const contextAfter = cleanText(description.slice(end, Math.min(lineEnd, end + CONTEXT_LENGTH)))
    const label = labels.get(position) ?? null
    const classification = classifyResource(normalized.url, `${contextBefore} ${label ?? ''} ${contextAfter}`)
    const existing = resources.get(normalized.url.toString())
    if (existing) {
      if (existing.sourcePositions.length < MAX_POSITIONS) existing.sourcePositions.push(position)
      if (!existing.label && label) existing.label = label
      continue
    }
    resources.set(normalized.url.toString(), {
      originalUrl,
      canonicalUrl: normalized.url.toString(),
      domain: normalized.url.hostname,
      label,
      contextBefore,
      contextAfter,
      sourcePositions: [position],
      firstPosition: position,
      ...classification,
    })
  }
  return [...resources.values()].sort((a, b) => a.firstPosition - b.firstPosition)
}

export function normalizeResourceUrl(original: string): { readonly url: URL } | null {
  if (original.length === 0 || original.length > MAX_URL_LENGTH) return null
  try {
    // URL accepts Unicode and safely percent-encodes it. Repair only stray percent
    // signs; valid escapes retain their identity.
    const safe = original.replace(/%(?![0-9a-f]{2})/giu, '%25').replaceAll('&amp;', '&')
    let url = new URL(safe)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (isYouTubeRedirect(url)) {
      const target = url.searchParams.get('q') ?? url.searchParams.get('url')
      if (!target || target.length > MAX_URL_LENGTH) return null
      url = new URL(target)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    }
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase()
      if (lower.startsWith('utm_') || TRACKING_PARAMETERS.has(lower)) {
        url.searchParams.delete(key)
      }
    }
    return { url }
  } catch {
    return null
  }
}

export function reconcileVideoDescriptionResources(
  db: Database,
  videoId: string,
  description: string | null,
  now = new Date().toISOString(),
): VideoDescriptionResource[] {
  return db.transaction(() => {
    const extracted = description ? extractVideoDescriptionResources(description) : []
    db.run('UPDATE video_description_resources SET is_present = 0, updated_at = ? WHERE video_id = ? AND is_present = 1', [now, videoId])
    for (const resource of extracted) {
      db.run(
        `INSERT INTO video_description_resources
           (id, video_id, original_url, canonical_url, domain, label,
            context_before, context_after, source_positions_json, first_position,
            automatic_category, automatic_visibility, automatic_confidence,
            automatic_source, automatic_reason, effective_category,
            effective_visibility, effective_source, effective_reason, is_present,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deterministic', ?,
                 ?, ?, 'deterministic', ?, 1, ?, ?)
         ON CONFLICT(video_id, canonical_url) DO UPDATE SET
           original_url = excluded.original_url, domain = excluded.domain,
           label = excluded.label, context_before = excluded.context_before,
           context_after = excluded.context_after,
           source_positions_json = excluded.source_positions_json,
           first_position = excluded.first_position,
           automatic_category = excluded.automatic_category,
           automatic_visibility = excluded.automatic_visibility,
           automatic_confidence = excluded.automatic_confidence,
           automatic_source = excluded.automatic_source,
           automatic_reason = excluded.automatic_reason,
           effective_category = CASE WHEN video_description_resources.effective_source = 'deterministic'
             THEN excluded.effective_category ELSE video_description_resources.effective_category END,
           effective_visibility = CASE WHEN video_description_resources.effective_source = 'deterministic'
             THEN excluded.effective_visibility ELSE video_description_resources.effective_visibility END,
           effective_reason = CASE WHEN video_description_resources.effective_source = 'deterministic'
             THEN excluded.effective_reason ELSE video_description_resources.effective_reason END,
           is_present = 1, updated_at = excluded.updated_at`,
        [randomUUID(), videoId, resource.originalUrl, resource.canonicalUrl,
          resource.domain, resource.label, resource.contextBefore, resource.contextAfter,
          JSON.stringify(resource.sourcePositions), resource.firstPosition,
          resource.category, resource.visibility, resource.confidence, resource.reason,
          resource.category, resource.visibility, resource.reason, now, now],
      )
    }
    return getVideoDescriptionResources(db, videoId, false)
  })
}

export function getVideoDescriptionResources(
  db: Database,
  videoId: string,
  includeInactive = false,
): VideoDescriptionResource[] {
  const rows = db.all<ResourceRow>(
    `${RESOURCE_SELECT} WHERE video_id = ?${includeInactive ? '' : ' AND is_present = 1'}
      ORDER BY first_position, canonical_url`,
    [videoId],
  )
  return rows.map(toResource)
}

function classifyResource(url: URL, nearbyText: string): Pick<ExtractedVideoResource,
  'category' | 'visibility' | 'confidence' | 'reason'> {
  const host = url.hostname.replace(/^www\./u, '').toLowerCase()
  const path = url.pathname.toLowerCase()
  const context = nearbyText.toLowerCase()
  const affiliateKey = [...url.searchParams.keys()].find((key) => AFFILIATE_PARAMETERS.has(key.toLowerCase()))
  if (affiliateKey) return classification('promotional', 0.98, `Affiliate parameter: ${affiliateKey}`)
  if (/\b(sponsor(?:ed)?|affiliate|partner link|use (?:my )?code|discount code|promo code)\b/iu.test(context)) {
    return classification('promotional', 0.92, 'Sponsor or promotional wording nearby')
  }
  if (['amzn.to', 'amazon.com', 'amazon.co.uk', 'aliexpress.com'].includes(host)) {
    return classification('promotional', 0.88, 'Storefront host')
  }
  if (['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org'].includes(host) && path.split('/').filter(Boolean).length >= 2) {
    return classification('repository', 0.99, `${displayHost(host)} repository host`)
  }
  if (host === 'docs.github.com' || host.startsWith('docs.') || host.includes('readthedocs.') ||
      host === 'developer.mozilla.org' || /\/(?:docs?|documentation|manual|guide)(?:\/|$)/u.test(path)) {
    return classification('documentation', 0.95, 'Documentation host or path')
  }
  if (host === 'kaggle.com' || host === 'data.gov' || host === 'zenodo.org' ||
      host === 'figshare.com' || (host === 'huggingface.co' && path.startsWith('/datasets/'))) {
    return classification('dataset', 0.96, 'Dataset host or path')
  }
  if (['discord.gg', 'discord.com', 'reddit.com', 'news.ycombinator.com', 'discourse.org'].includes(host) ||
      host.startsWith('community.') || /\/(?:community|forum|forums)(?:\/|$)/u.test(path)) {
    return classification('community', 0.9, 'Community host or path')
  }
  if (['x.com', 'twitter.com', 'instagram.com', 'facebook.com', 'linkedin.com', 'tiktok.com', 'bsky.app', 'threads.net'].includes(host)) {
    return classification('social', 0.98, 'Social network host')
  }
  if (['patreon.com', 'ko-fi.com', 'buymeacoffee.com', 'linktr.ee', 'beacons.ai'].includes(host)) {
    return classification('creator', 0.94, 'Creator profile host')
  }
  if (['npmjs.com', 'pypi.org', 'hub.docker.com', 'crates.io', 'apps.apple.com', 'play.google.com'].includes(host) ||
      /\b(download|try the tool|project website)\b/iu.test(context)) {
    return classification('tool', 0.86, 'Software tool host or nearby label')
  }
  if (['medium.com', 'substack.com', 'dev.to', 'arxiv.org'].includes(host) || host.startsWith('blog.') ||
      /\/(?:blog|articles?|posts?|papers?)(?:\/|$)/u.test(path)) {
    return classification('article', 0.87, 'Article host or path')
  }
  return classification('other', 0.35, 'No deterministic category matched')
}

function classification(category: VideoResourceCategory, confidence: number, reason: string) {
  const visibility: VideoResourceVisibility = category === 'promotional'
    ? 'hidden'
    : ['repository', 'documentation', 'tool', 'article', 'dataset'].includes(category)
      ? 'featured'
      : 'normal'
  return { category, visibility, confidence, reason }
}

function markdownLabels(description: string): Map<number, string> {
  const labels = new Map<number, string>()
  const matcher = /\[([^\]\r\n]{1,400})\]\(\s*(https?:\/\/[^\s<>"'`]+)\s*\)/giu
  for (const match of description.matchAll(matcher)) {
    const urlOffset = match[0].indexOf(match[2])
    const label = cleanText(match[1]).slice(0, MAX_LABEL_LENGTH)
    if (label) labels.set(match.index + urlOffset, label)
  }
  return labels
}

function trimUrlPunctuation(value: string): string {
  let result = value
  result = result.replace(/[.,;:!\]}>，。；！]+$/gu, '')
  while (result.endsWith(')') && count(result, ')') > count(result, '(')) result = result.slice(0, -1)
  return result
}

function count(value: string, needle: string): number {
  return [...value].filter((char) => char === needle).length
}

function boundedContext(value: string): string {
  return cleanText(value).slice(-CONTEXT_LENGTH)
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function isYouTubeRedirect(url: URL): boolean {
  const host = url.hostname.replace(/^www\./u, '').toLowerCase()
  return (host === 'youtube.com' || host === 'youtu.be') && url.pathname === '/redirect'
}

function displayHost(host: string): string {
  if (host === 'github.com') return 'GitHub'
  if (host === 'gitlab.com') return 'GitLab'
  return host.split('.')[0].replace(/^./u, (char) => char.toUpperCase())
}

function toResource(row: ResourceRow): VideoDescriptionResource {
  let sourcePositions: number[] = []
  try {
    const parsed: unknown = JSON.parse(row.source_positions_json)
    if (Array.isArray(parsed)) sourcePositions = parsed.filter((value): value is number => Number.isInteger(value))
  } catch { /* A corrupt provenance field must not break the entire read. */ }
  return {
    id: row.id,
    videoId: row.video_id,
    originalUrl: row.original_url,
    canonicalUrl: row.canonical_url,
    domain: row.domain,
    label: row.label,
    contextBefore: row.context_before,
    contextAfter: row.context_after,
    sourcePositions,
    firstPosition: Number(row.first_position),
    category: row.effective_category,
    visibility: row.effective_visibility,
    confidence: row.automatic_confidence ?? 0,
    reason: row.effective_reason,
    automaticCategory: row.automatic_category,
    automaticVisibility: row.automatic_visibility,
    automaticSource: row.automatic_source,
    automaticReason: row.automatic_reason,
    effectiveCategory: row.effective_category,
    effectiveVisibility: row.effective_visibility,
    effectiveSource: row.effective_source,
    effectiveReason: row.effective_reason,
    present: Boolean(row.is_present),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const RESOURCE_SELECT = `SELECT id, video_id, original_url, canonical_url, domain,
  label, context_before, context_after, source_positions_json, first_position,
  automatic_category, automatic_visibility, automatic_confidence,
  automatic_source, automatic_reason, effective_category, effective_visibility,
  effective_source, effective_reason, is_present, created_at, updated_at
  FROM video_description_resources`
