import { Hono } from 'hono'
import type { TokenStore } from './token-store.js'

/**
 * JSON API for managing API tokens. Mounted at `/api/tokens`.
 *
 * All endpoints require auth (Basic or Bearer) via the global middleware.
 *
 *   GET    /api/tokens      — list tokens (no plaintext)
 *   POST   /api/tokens      — create a new token (plaintext in response)
 *   DELETE /api/tokens/:id  — revoke a token (idempotent: 404 if unknown)
 */
export function tokenApi(store: TokenStore): Hono {
  const api = new Hono()

  api.get('/', async (c) => {
    const tokens = await store.list()
    return c.json({ tokens })
  })

  api.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown }
    const label = sanitizeLabel(body.label)
    const { record, plaintext } = await store.create(label)
    // 201 Created. The `plaintext` field is the ONE place the secret
    // appears in plaintext — clients must capture it now.
    return c.json({ ...record, plaintext }, 201)
  })

  api.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const revoked = await store.revoke(id)
    if (!revoked) return c.json({ error: 'not_found' }, 404)
    return c.body(null, 204)
  })

  return api
}

/** Trim and clamp to 100 chars; fall back to "Untitled" for missing/empty. */
function sanitizeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'Untitled'
  const trimmed = value.trim().slice(0, 100)
  return trimmed.length > 0 ? trimmed : 'Untitled'
}
