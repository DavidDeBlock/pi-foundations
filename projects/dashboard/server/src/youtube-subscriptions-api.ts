// youtube-subscriptions-api.ts — issue YT-002
//
// HTTP boundary for the subscriptions sync. One route:
//
//   * `POST /sync` — triggers a synchronous manual sync, returns
//     the count summary as JSON. Mirrors the email slice's
//     `POST /api/email/sync` endpoint (same shape: 200 with
//     counts, 404 when no account, 500 on API errors).
//
// Kept as a separate file from `youtube-oauth.ts` because the
// OAuth routes (`/oauth/*`, `/connection`) and the sync routes
// (`/sync`) have different lifecycles: OAuth routes are mounted
// as soon as the env vars exist, while sync routes also need the
// `YouTubeSubscriptionsSync` orchestrator wired. Splitting the
// files lets the OAuth slice ship independently and keeps the
// long OAuth callback handler readable.

import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import {
  NoYouTubeAccountError,
  YouTubeSubscriptionsSync,
} from './youtube-subscriptions-sync.js'

export interface YouTubeSyncApiDeps {
  readonly sync: YouTubeSubscriptionsSync
}

/**
 * Mounted at `/api/youtube`. Adds:
 *   * `POST /sync` — manual trigger.
 *
 * The OAuth-related routes on the same path are owned by
 * `youtube-oauth.ts`'s `youtubeApi` factory; Hono dispatches by
 * exact path match so both can coexist.
 */
export function youtubeSyncApi(deps: YouTubeSyncApiDeps): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  // ─── POST /sync ─────────────────────────────────────────────────────
  // Manual trigger — returns the count summary as JSON. The OAuth
  // callback also fires a sync (fire-and-forget) on grant; this
  // route is the explicit "Sync now" button on /settings/youtube
  // (and the equivalent Subscriptions page in v3.x).
  api.post('/sync', async (c) => {
    try {
      const result = await deps.sync.sync()
      return c.json(result)
    } catch (err: unknown) {
      if (err instanceof NoYouTubeAccountError) {
        return c.json({ ok: false, error: 'no_account' }, 404)
      }
      // Re-throw so Hono's error boundary produces a 500 with a
      // log entry; the operator sees the stack in the server log.
      throw err
    }
  })

  return api
}