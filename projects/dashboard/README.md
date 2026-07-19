# Dashboard

Dashboard is a self-hosted, single-user personal information hub for bookmarks, Gmail, YouTube, news, and weather. It runs as one Node.js process backed primarily by SQLite and serves a responsive, server-rendered interface with no frontend build step.

The project is designed for a private home server: open the same dashboard from any computer on the network and work with the same server-side data. Browser-specific settings, such as the Chrome extension's server URL and API token, still need to be configured on each browser profile.

## What it does

### Bookmarks

- Mirrors the complete Chrome bookmark tree through a Manifest V3 extension.
- Detects bookmark creates, edits, moves, and deletions and sends a debounced full-tree sync.
- Provides folders, dashboard-only tags, inline organization, an activity feed, and bookmark detail pages.
- Searches titles and URLs with SQLite FTS5 and a fuzzy trigram fallback.

The extension currently reads from Chrome and pushes to Dashboard. It does not write Dashboard changes back to Chrome.

### Gmail

- Connects one or more Gmail accounts with read-only Google OAuth access.
- Mirrors a configurable initial history window, then performs incremental background syncs.
- Provides inbox, hidden mail, message and thread views, search, tags, and visibility controls.
- Encrypts stored OAuth tokens with AES-256-GCM.

Email remains available as a local mirror when Google is temporarily unreachable. Sending, deleting, and modifying messages in Gmail are intentionally outside its read-only scope.

### YouTube

- Connects YouTube accounts with OAuth and stores account data centrally in SQLite.
- Syncs subscriptions and playlists and polls included subscriptions' RSS feeds for new videos.
- Imports recent channel uploads, video metadata, descriptions, and playlist membership.
- Offers quota-cached YouTube Data API search and opens embeddable results in the local player.
- Tracks embedded-player progress, resume position, play count, partial/completed state, and local watch events.
- Imports Google Takeout watch history from JSON or legacy HTML exports.
- Fetches transcripts and can generate queued AI insight cards and optional web-researched summaries.
- Supports video and subscription tags, included/important subscription controls, and local preferences.

Only videos played inside Dashboard can be tracked live. Watches on youtube.com, mobile apps, televisions, or other devices require a later Takeout import. Some videos cannot be embedded because of uploader, age, region, cookie, or authentication restrictions.

YouTube search is deliberately submit-only rather than autocomplete: `search.list` is quota-expensive. Results are cached, but a valid `YOUTUBE_API_KEY` and available YouTube Data API quota are still required for uncached searches.

### News and weather

- Shows current conditions and a seven-day Open-Meteo forecast for Ghent.
- Polls Belgian news feeds from VRT NWS, De Tijd, and the Centre for Cybersecurity Belgium.
- Normalizes and deduplicates RSS and Atom articles and isolates individual source failures.
- Displays article images only when the source feed supplies a usable image URL; the seeded feeds commonly provide text-only entries.
- Supports scheduled ingestion and an authenticated manual refresh endpoint.

## How it is built

| Area | Implementation |
|------|----------------|
| Server | Hono on Node.js 22+, run directly with `tsx` |
| UI | Server-rendered HTML, shared CSS, and small vanilla JavaScript modules |
| Database | SQLite through `better-sqlite3`; ordered SQL migrations run on startup |
| Search | SQLite FTS5 plus an application-managed trigram index |
| Feed ingestion | RSS/Atom parsing plus Open-Meteo JSON |
| Authentication | HTTP Basic for browsers; bearer API tokens for the extension |
| OAuth security | Google OAuth tokens encrypted at rest with separate email and YouTube keys |
| Tests | Vitest unit and integration tests plus HTTP smoke scripts |

There is no client framework, bundler, external database, Redis instance, or separate worker service. Background email sync, YouTube synchronization and polling, transcript/metadata queues, and news refreshes all run in the server process.

## Repository layout

```text
dashboard/
├── README.md                 Project overview and local setup
├── docs/                     Context, plans, PRDs, ADRs, and deployment runbook
├── extension/                Unpacked Chrome bookmark-sync extension
├── scripts/                  Backup and cross-project operational scripts
└── server/
    ├── env.example           Runtime configuration template
    ├── migrations/           Ordered SQLite schema migrations
    ├── scripts/              Smoke tests and key/certificate utilities
    ├── static/               CSS, fonts, icons, and browser-side JavaScript
    └── src/                  Hono routes, services, storage, schedulers, and tests
```

Architectural decisions are indexed in [`docs/40-decisions/`](./docs/40-decisions/_index.md). The production runbook, systemd configuration, TLS guidance, backup procedure, and upgrade steps are in [`docs/deployment.md`](./docs/deployment.md).

## Quick start

### Requirements

- Node.js 22 or newer
- pnpm
- A browser that supports HTTP Basic authentication

### Run locally

```bash
cd server
pnpm install
cp env.example .env
```

Set at least the required password in `server/.env`:

```ini
DASHBOARD_PASSWORD=replace-with-a-strong-password
```

Then start the application:

```bash
pnpm start
```

Open <http://localhost:8080>. The browser will prompt for HTTP Basic credentials; the username may be anything and the password is `DASHBOARD_PASSWORD`. Migrations run automatically and the default data directory is created on first boot.

For development with automatic server restarts:

```bash
pnpm dev
```

The core bookmark, local search, news/weather, and existing local-data views can run without Google or AI credentials. Gmail and YouTube show setup guidance until their optional integrations are configured.

## Chrome bookmark sync

1. Start Dashboard and open `/settings`.
2. Generate an API token and copy the plaintext value when it is shown.
3. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
4. Select the repository's `extension/` directory.
5. Open the extension options and enter the Dashboard base URL and API token.
6. Save and validate. The extension requests access only to the configured Dashboard origin and performs its initial sync.

Repeat the extension setup for every Chrome profile or computer that should push bookmarks. See [`extension/README.md`](./extension/README.md) for its event and permission model.

## Optional integrations

Copy and edit [`server/env.example`](./server/env.example) as the annotated configuration template. The reference table below also includes newer optional scheduler and research settings. Shell environment variables override values loaded from `.env`.

### Gmail OAuth

Enable the Gmail API and configure a Google OAuth web client with the read-only Gmail scope. Dashboard requires:

```ini
EMAIL_TOKEN_ENCRYPTION_KEY=<64 hex characters>
GOOGLE_OAUTH_CLIENT_ID=<client id>
GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
EMAIL_OAUTH_REDIRECT_URI=http://localhost:8080/api/email/oauth/callback
```

Generate the encryption key from `server/` with:

```bash
pnpm keygen
```

The redirect URI must exactly match the URI registered in Google Cloud. Google permits plain HTTP for loopback addresses; access from another computer normally requires a trusted HTTPS URL. The live setup checklist is available at `/settings/email`.

### YouTube OAuth and search

Enable YouTube Data API v3 and configure a Google OAuth web client:

```ini
YOUTUBE_TOKEN_ENCRYPTION_KEY=<64 hex characters>
YOUTUBE_OAUTH_CLIENT_ID=<client id>
YOUTUBE_OAUTH_CLIENT_SECRET=<client secret>
YOUTUBE_OAUTH_REDIRECT_URI=http://localhost:8080/api/youtube/oauth/callback
YOUTUBE_API_KEY=<restricted server-side API key>
```

OAuth enables account, subscription, playlist, and authenticated metadata features. The developer API key enables custom search. Configure it with a server/IP restriction where practical and restrict it to YouTube Data API v3. The live setup checklist is at `/settings/youtube`.

### AI summaries and research

YouTube insight cards use an OpenAI-compatible text endpoint. MiniMax defaults are provided, but the client is provider-neutral:

```ini
LLM_API_KEY=<server-side API key>
LLM_BASE_URL=https://api.minimax.io/v1
LLM_MODEL=MiniMax-M2.7
SERPER_API_KEY=<optional key for web-researched summaries>
```

These keys remain on the server and are never rendered into pages or API responses. AI settings and provider status are shown at `/settings/ai`.

### HTTPS

Set both paths to serve HTTPS directly from the Node process:

```ini
DASHBOARD_TLS_CERT=/absolute/path/to/server.pem
DASHBOARD_TLS_KEY=/absolute/path/to/server.key
```

Use `pnpm certgen <hostname> [ip]` from `server/` to create local development material, then trust the generated CA on each client computer. See the deployment runbook for Google redirect-URI rules and certificate setup.

## Configuration reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `DASHBOARD_PASSWORD` | required | Browser HTTP Basic password |
| `PORT` | `8080` | Listening port |
| `HOSTNAME` | `0.0.0.0` | Bind address |
| `DASHBOARD_DATA_DIR` | `./data` | Token-store and staged local-data directory |
| `DASHBOARD_DB_PATH` | `./data/dashboard.db` | SQLite database path |
| `DASHBOARD_ENV_FILE` | `.env` | Alternate environment-file path |
| `DASHBOARD_TLS_CERT`, `DASHBOARD_TLS_KEY` | unset | PEM certificate/key pair for HTTPS |
| `EMAIL_TOKEN_ENCRYPTION_KEY` | unset | Gmail OAuth-token encryption key |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | unset | Gmail OAuth web-client credentials |
| `EMAIL_OAUTH_REDIRECT_URI` | unset | Gmail OAuth callback URL |
| `EMAIL_SYNC_HISTORY_DAYS` | `90` | First Gmail sync lookback |
| `EMAIL_SYNC_INTERVAL_MIN` | `10` | Gmail background sync interval; `0` disables it |
| `YOUTUBE_TOKEN_ENCRYPTION_KEY` | unset | YouTube OAuth-token encryption key |
| `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET` | unset | YouTube OAuth web-client credentials |
| `YOUTUBE_OAUTH_REDIRECT_URI` | unset | YouTube OAuth callback URL |
| `YOUTUBE_API_KEY` | unset | Public YouTube search and video-detail requests |
| `YOUTUBE_RSS_CONCURRENCY` | `5` | Maximum concurrent subscription-feed requests |
| `LLM_API_KEY` | unset | Enables AI summaries |
| `LLM_BASE_URL` | MiniMax endpoint | OpenAI-compatible API base URL |
| `LLM_MODEL` | `MiniMax-M2.7` | Summary model |
| `SERPER_API_KEY` | unset | Enables optional web research for summaries |
| `DASHBOARD_NEWS_INTERVAL_MIN` | `1` | News scheduler tick interval; `0` makes refresh manual-only |

Invalid or incomplete optional OAuth configuration does not prevent the rest of Dashboard from starting. Invalid encryption keys or incomplete TLS pairs are treated as startup errors.

## Data, synchronization, and backups

Dashboard's application data is stored on the server, not independently in each visiting browser:

- `server/data/dashboard.db` contains bookmarks, Gmail mirrors, YouTube accounts and library data, local watch state/history, cached YouTube searches, transcripts, summaries, news, and weather by default.
- `server/data/tokens.json` contains hashed bearer-token records for clients such as the Chrome extension.
- Google OAuth access and refresh tokens are encrypted inside SQLite. Their encryption keys live in the environment and must be backed up separately.
- Temporary Takeout import files are staged below the configured data directory and removed according to the import workflow.

Opening the same Dashboard server from another computer therefore shows the same stored subscriptions, playlists, history, and other records. A manual resync is only needed to pull changes made upstream in Google/YouTube or when a scheduled sync has not run; it is not required merely because the browser changed.

Back up the SQLite database, token file, environment file, and TLS material. Losing an OAuth encryption key makes the corresponding stored credentials unreadable. Use [`scripts/backup.sh`](./scripts/backup.sh) or follow the consistent SQLite backup procedure in the deployment runbook rather than copying a busy database casually.

## Main pages

| Path | Purpose |
|------|---------|
| `/` | Bookmark activity and organization |
| `/search` | Bookmark full-text and fuzzy search |
| `/email` | Mirrored Gmail inbox |
| `/youtube/search` | Cached YouTube search and embedded playback |
| `/videos` | New and locally organized YouTube videos |
| `/playlists` | Mirrored YouTube playlists |
| `/history` | Takeout and locally tracked watch history |
| `/subscriptions` | Subscription inclusion, importance, and tags |
| `/news-weather` | Ghent forecast and Belgian news |
| `/settings` | Dashboard API tokens |
| `/settings/email` | Gmail connection and sync status |
| `/settings/youtube` | YouTube connection and sync status |
| `/settings/ai` | AI provider and research settings |
| `/health` | Authenticated health response |

Every route, including `/health`, requires Dashboard authentication.

## Tests and verification

Run these commands from `server/`:

```bash
pnpm typecheck       # TypeScript validation
pnpm test            # Vitest unit and integration suite
pnpm test:watch      # Vitest watch mode
pnpm smoke           # Isolated bookmark/API HTTP smoke flow
pnpm smoke:news      # Isolated news and weather ingestion smoke flow
```

The test suite uses temporary or in-memory databases and exercises migrations, authentication, synchronization, search, OAuth flows, schedulers, parsing, persistence, and rendered views.

## Deployment

The intended deployment is one long-running process on a private Linux server, managed by systemd, with state outside the Git checkout. See [`docs/deployment.md`](./docs/deployment.md) for:

- a hardened systemd unit;
- production environment-file layout;
- Google OAuth and HTTPS setup;
- logs and health checks;
- SQLite-safe backups and restore testing;
- firewall guidance and upgrades.

This is a personal, single-user application. It does not provide user accounts, permissions, public sharing, or multi-tenant isolation and should not be exposed directly to the public internet without an appropriate private network or additional access layer.
