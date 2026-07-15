# ADR-009: YouTube subscriptions + RSS-based new-video detection (v3.0)

**Status**: Accepted
**Date**: 2026-07-15
**Authors**: David

## Context

The dashboard already ships Chrome bookmarks (v1) and is scoped to add YouTube data in v3. The original v3 ambition covered saves (Data API), watch history (Google Takeout), and a YouTube playlist mirror. Discovery in July 2026 narrowed the user's actual near-term ask:

- They want a **morning briefing** for YouTube — see new uploads from channels they care about, decide whether to watch, organize them.
- They explicitly want to **drop music channels** from the dashboard view (those stay on YouTube itself).
- For the most important channels they eventually want **transcript + LLM summary** of each new video, but that part is deferred — no immediate consumer.
- They want to **categorize** everything in the same folders/tags model that bookmarks use (ADR-004).

This ADR locks down the V0 (v3.0) slice. It deliberately does NOT cover saves, mirror, history, playlists, transcripts, or LLM — those are deferred to v3.1 / v3.x so the dashboard can ship a useful YouTube surface quickly and we learn from real usage before building the more complex pieces.

## Decision Drivers

- Data API `subscriptions.list` is the canonical way to get the user's subscription set — one OAuth scope, one endpoint
- Every YouTube channel publishes an RSS feed at `youtube.com/feeds/videos.xml?channel_id=...` — no auth, no quota, no key required
- RSS polling every 15 min gives "new since I last looked" latency that is fine for a daily-briefing use case
- PubSubHubbub would give real-time push but requires a publicly-reachable HTTPS endpoint (the LAN server doesn't qualify without a tunnel)
- Data API polling (`playlistItems.list` on each channel's uploads playlist) works but burns 1 unit/call per channel per poll — marginal at ~20 channels, but gratuitous when RSS exists
- LLM/transcript work is meaningful effort with no immediate user value — defer until we know the subscription flow actually gets used
- Watch history via Takeout, saves via Data API, and own-playlists ingestion are all independent slices that can ship after v3.0

## Decision

**v3.0 = subscriptions + RSS + categorization. Nothing else.**

1. **Subscriptions ingestion** — Data API v3 `subscriptions.list` on first OAuth grant; refresh on a schedule (e.g. daily). Stored in a `subscriptions` table: `channel_id`, `title`, `thumbnail_url`, `subscribed_at`, `is_included` (bool, default true), `is_important` (bool, default false).

2. **Subscription filter UX** — Hybrid:
   - Initial import writes all subscriptions with `is_included = true`.
   - Dashboard Subscriptions page shows the list with a per-row toggle for `is_included` (drop music channels here) and a separate toggle for `is_important` (reserved for the future LLM job).
   - In v3.0, `is_important` is stored but **not yet consumed** — no behavior change today.

3. **New-video detection** — A server-side job polls RSS for every subscription where `is_included = true`. Polling interval: **15 minutes**. Source: `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`. New entries (by video ID, not yet in the `videos` table) are inserted into the `videos` table with: `video_id`, `channel_id`, `title`, `published_at`, `thumbnail_url`, `link`, `discovered_at`.

4. **Categorization** — New videos land in the dashboard DB with no folder and no tags. The user categorizes them via the existing folders/tags UI (ADR-004). No auto-categorization.

5. **Source of truth** — Dashboard DB is the source of truth for new-video state (per ADR-005's principle, applied to subscriptions). YouTube is read-only for subscriptions; no mirror in v3.0.

6. **OAuth** — Existing dashboard OAuth flow gets the YouTube scopes added (`youtube.readonly` at minimum, plus `youtube.force-ssl` if needed for `subscriptions.list`). One OAuth grant, one token store entry — same model as email (ADR-adjacent).

7. **Explicitly NOT in v3.0** (deferred, each may get its own ADR later):
   - Saves + mirror to YouTube playlist (ADR-003, ADR-005) → v3.1
   - Watch history via Takeout (ADR-003) → v3.1
   - User playlists ingestion → v3.1
   - Transcript fetching (npm `youtube-transcript` or equivalent) → v3.x with LLM
   - LLM summarization job → v3.x (cloud provider TBD)
   - Real-time push via PubSubHubbub → revisit if 15-min latency feels bad
   - AI auto-categorization → not in scope

## Consequences

**Positive:**
- v3.0 ships a real, useful morning-briefing surface with the smallest moving-parts count
- RSS path has zero quota cost and zero OAuth dependency for the polling loop (only subscription ingestion uses OAuth)
- `is_important` flag is captured now so when LLM lands, the schema doesn't need a migration — just a new job
- Polling is trivially observable (last-polled-at per channel) and retryable
- Clear boundaries: anything beyond the RSS feed + categorization is a future slice with its own ADR

**Negative:**
- Up to 15-min latency between upload and dashboard visibility — acceptable for daily-briefing, but not real-time
- `youtube-transcript` and LLM are deferred, so for now users get metadata only on new videos — they'll click through to YouTube to read the description or watch
- Polling ~20 channels every 15 min = ~1920 HTTP requests/day to YouTube — negligible but worth monitoring
- OAuth scope list grows; if we later need write scopes (for v3.1 saves), the user re-grants
- Schema reservation for `is_important` adds a column with no current consumer — small but real

## Alternatives Considered

- **PubSubHubbub (webhooks)** — Real-time push, free, no quota. Rejected: requires a publicly-reachable HTTPS endpoint. The LAN server doesn't have one, and adding Cloudflare Tunnel / ngrok / a domain is infra work that isn't justified for v3.0. Revisit if 15-min latency becomes painful.
- **Data API polling (`playlistItems.list` on uploads playlists)** — Same shape as RSS but uses OAuth and burns quota. Rejected: gratuitous quota spend when RSS exists. Revisit only if YouTube kills the public RSS feeds (no public signal that they will).
- **One-shot manual sync ("Refresh now" button, no cron)** — Simpler, no background job. Rejected: defeats the "morning briefing" use case; user would have to remember to click.
- **Build LLM + transcripts in v3.0 too** — Rejected per discovery: no immediate consumer, adds 2+ weeks of work and a new external dependency for no shipped value. The `is_important` flag preserves the schema so we add it as a job later, not a migration.
- **Defer everything YouTube until v3.1 can ship as one big chunk** — Rejected: the subscription/refresh/feed surface is independently useful and small enough to ship first. We learn from real usage before committing to the bigger slices.

## References

- ADR-003 — YouTube data ingestion via Data API + Takeout (saves + history scope, deferred to v3.1)
- ADR-004 — Folders + tags, unified for bookmarks and YouTube
- ADR-005 — Dashboard DB is source of truth for YouTube saves (principle applied to subscriptions in v3.0; mirror piece deferred)
- ADR-008 — MVP scope (v1 = bookmarks)