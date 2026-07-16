// youtube-rss-poll-api.ts — issue YT-004
//
// HTTP boundary for "Poll now". POST `/api/youtube/poll`
// synchronously runs one RSS poll cycle and returns the same
// shape as `YouTubeRssPoller.pollAll()` per the AC.
//
// Why call the poller directly (not the scheduler):
//   * The AC says we return the poll's result, but the
//     scheduler's `runOnce()` swallows errors + discards the
//     result. The route needs to surface both.
//   * The manual trigger is its own path. Adding a
//     `pollAndReturnResult()` helper to the scheduler would
//     duplicate the catch logic; calling the poller here and
//     handling errors in the route is simpler and matches the
//     way `/api/youtube/sync` calls `YouTubeSubscriptionsSync.sync`
//     directly.
//
// Hono splits routes by exact path; `/api/youtube/poll` lives
// alongside `/api/youtube/oauth/*` and `/api/youtube/sync` —
// each in its own factory. `app.ts` mounts all three onto
// `/api/youtube`.

import { Hono } from 'hono'
import type { AuthVariables } from './auth.js'
import type { YouTubeRssPoller } from './youtube-rss-poller.js'

export interface YouTubeRssPollApiDeps {
  readonly poller: YouTubeRssPoller
}

/**
 * Mounted at `/api/youtube` (alongside the OAuth + sync routes).
 * Adds:
 *   * `POST /poll` — manual RSS poll trigger.
 */
export function youtubeRssPollApi(
  deps: YouTubeRssPollApiDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  // ─── POST /poll ───────────────────────────────────────────────────
  // Per the AC, returns the same shape as `pollAll()`:
  //   { succeeded, failed, totalChannels, added, skipped, ranAt, channels }
  // with one extra top-level field `ok: boolean` so the UI can
  // branch without sniffing the response.
  api.post('/poll', async (c) => {
    try {
      const result = await deps.poller.pollAll()
      return c.json({ ok: true, ...result })
    } catch (err: unknown) {
      // `NoIncludedSubscriptionsError` is the operator's
      // "nothing to do" signal. Return 200 with `ok: false`
      // and a stable `reason` so the /subscriptions UI can
      // render it ("All channels are excluded — enable one to
      // start polling").
      if (
        err instanceof Error &&
        err.name === 'NoIncludedSubscriptionsError'
      ) {
        return c.json({ ok: false, reason: 'no_included_subscriptions' }, 200)
      }
      // eslint-disable-next-line no-console
      console.error(
        `[youtube-rss-poll-api] poll failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500,
      )
    }
  })

  return api
}