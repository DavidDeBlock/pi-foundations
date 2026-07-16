import { Hono } from 'hono'
import {
  HistoryImportAlreadyCommittedError,
  HistoryImportExpiredError,
  HistoryImportIntegrityError,
  HistoryImportNotFoundError,
  TakeoutHistoryFormatError,
  TakeoutHistorySizeError,
  type YouTubeHistoryImports,
} from './youtube-history-imports.js'
import type { Database } from './db.js'
import { searchWatchHistory } from './youtube-history.js'

const MULTIPART_OVERHEAD_BYTES = 64 * 1024

export function youtubeHistoryApi(deps: { readonly imports: YouTubeHistoryImports; readonly db: Database }): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    const page = positiveInt(c.req.query('page')) ?? 1
    const limit = positiveInt(c.req.query('limit')) ?? 50
    const result = searchWatchHistory(deps.db, { page, limit })
    return c.json({
      items: result.items.map((item) => ({
        id: item.id,
        video_id: item.videoId,
        youtube_video_id: item.youtubeVideoId,
        title: item.title,
        channel_id: item.channelId,
        channel_title: item.channelTitle,
        thumbnail_url: item.thumbnailUrl,
        watched_at: item.watchedAt,
        watch_count: item.watchCount,
      })),
      total: result.total,
      unique_videos: result.uniqueVideos,
      page: result.page,
      limit: result.limit,
    })
  })

  app.post('/preview', async (c) => {
    try {
      const upload = await readUpload(c.req.raw, deps.imports.maxBytes)
      const preview = await deps.imports.preview(upload.data, upload.filename)
      return c.json({
        token: preview.token,
        filename: preview.filename,
        total_count: preview.totalCount,
        new_event_count: preview.newEventCount,
        duplicate_count: preview.duplicateCount,
        malformed_count: preview.malformedCount,
        unique_video_count: preview.uniqueVideoCount,
        new_video_count: preview.newVideoCount,
        oldest_watched_at: preview.oldestWatchedAt,
        newest_watched_at: preview.newestWatchedAt,
        expires_at: preview.expiresAt,
      }, 201)
    } catch (error: unknown) {
      if (error instanceof TakeoutHistorySizeError) return c.json({ error: error.message }, 413)
      if (error instanceof TakeoutHistoryFormatError || error instanceof UploadFormatError) {
        return c.json({ error: error.message }, 400)
      }
      return c.json({ error: 'History preview failed.' }, 500)
    }
  })

  app.post('/imports/:token/commit', async (c) => {
    try {
      const result = await deps.imports.commit(c.req.param('token'))
      return c.json({
        token: result.token,
        committed_event_count: result.committedEventCount,
        duplicate_count: result.duplicateCount,
        malformed_count: result.malformedCount,
        inserted_video_count: result.insertedVideoCount,
        existing_video_count: result.existingVideoCount,
        snapshot_only_count: result.snapshotOnlyCount,
        committed_at: result.committedAt,
      })
    } catch (error: unknown) {
      if (error instanceof HistoryImportNotFoundError) return c.json({ error: error.message }, 404)
      if (error instanceof HistoryImportExpiredError) return c.json({ error: error.message }, 410)
      if (error instanceof HistoryImportAlreadyCommittedError) return c.json({ error: error.message }, 409)
      if (error instanceof HistoryImportIntegrityError || error instanceof TakeoutHistoryFormatError) {
        return c.json({ error: error.message }, 409)
      }
      return c.json({ error: 'History import failed; no watch events were committed.' }, 500)
    }
  })

  app.get('/imports', async (c) => {
    const items = (await deps.imports.list()).map((item) => ({
      token: item.token,
      filename: item.filename,
      file_hash: item.fileHash,
      status: item.status,
      total_count: item.totalCount,
      new_event_count: item.newEventCount,
      duplicate_count: item.duplicateCount,
      malformed_count: item.malformedCount,
      unique_video_count: item.uniqueVideoCount,
      new_video_count: item.newVideoCount,
      committed_event_count: item.committedEventCount,
      oldest_watched_at: item.oldestWatchedAt,
      newest_watched_at: item.newestWatchedAt,
      created_at: item.createdAt,
      expires_at: item.expiresAt,
      committed_at: item.committedAt,
    }))
    return c.json({ items, total: items.length })
  })

  return app
}

function positiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

class UploadFormatError extends Error {}

async function readUpload(request: Request, maxFileBytes: number): Promise<{ data: Buffer; filename: string }> {
  const contentType = request.headers.get('content-type') ?? ''
  const isMultipart = /^multipart\/form-data\b/i.test(contentType)
  const maxRequestBytes = maxFileBytes + (isMultipart ? MULTIPART_OVERHEAD_BYTES : 0)
  const contentLength = request.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxRequestBytes) {
    throw new TakeoutHistorySizeError(`Takeout file exceeds the ${maxFileBytes}-byte upload limit.`)
  }
  const body = await readBounded(request.body, maxRequestBytes, maxFileBytes)

  if (isMultipart) {
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
    const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
    if (!boundary) throw new UploadFormatError('Multipart upload has no boundary.')
    const part = extractFilePart(body, boundary)
    if (part.data.byteLength > maxFileBytes) {
      throw new TakeoutHistorySizeError(`Takeout file exceeds the ${maxFileBytes}-byte upload limit.`)
    }
    return part
  }

  if (!/^application\/(?:json|octet-stream)\b/i.test(contentType)) {
    throw new UploadFormatError('Upload must be a JSON file or multipart form-data with a file field.')
  }
  return { data: body, filename: request.headers.get('x-filename') ?? 'watch-history.json' }
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  reportedFileLimit: number,
): Promise<Buffer> {
  if (!stream) throw new UploadFormatError('Upload body is empty.')
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new TakeoutHistorySizeError(`Takeout file exceeds the ${reportedFileLimit}-byte upload limit.`)
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new UploadFormatError('Upload body is empty.')
  return Buffer.concat(chunks, total)
}

function extractFilePart(body: Buffer, boundary: string): { data: Buffer; filename: string } {
  if (boundary.length > 200 || /[\r\n]/.test(boundary)) throw new UploadFormatError('Multipart boundary is invalid.')
  const delimiter = Buffer.from(`--${boundary}`)
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`)
  let cursor = body.indexOf(delimiter)
  while (cursor >= 0) {
    const headersStart = cursor + delimiter.length + 2
    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), headersStart)
    if (headersEnd < 0) break
    const headers = body.subarray(headersStart, headersEnd).toString('latin1')
    const disposition = headers.match(/^content-disposition:\s*form-data;([^\r\n]+)$/im)?.[1] ?? ''
    const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1]
    const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1]
    const contentStart = headersEnd + 4
    const contentEnd = body.indexOf(nextDelimiter, contentStart)
    if (contentEnd < 0) break
    if (filename !== undefined || name === 'file') {
      return { data: body.subarray(contentStart, contentEnd), filename: filename || 'watch-history.json' }
    }
    cursor = body.indexOf(delimiter, contentEnd + 2)
  }
  throw new UploadFormatError('Multipart upload must contain a file field.')
}
