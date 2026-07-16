// youtube-settings.ts — issue YT-001
//
// HTML view at GET /settings/youtube. Shows:
//
//   * "Connect YouTube" button when no account is connected, with a
//     link to the one-time Google Cloud Console setup.
//   * The connected account — email + connected-on + last-refreshed-on
//     + granted scopes — with a form-POST Disconnect button.
//   * The post-OAuth flash banner: `?status=connected|disconnected|error`.
//   * The setup checklist docs in-page (Google Cloud project + OAuth
//     client + env vars). Operators run this once; the docs live next
//     to the button so it's the only place a new admin has to look.
//
// POST /settings/youtube/disconnect is the form-friendly alias for
// DELETE /api/youtube/connection — matches the existing token-revoke
// pattern (browsers don't support method=DELETE in <form>).
//
// `youtubeSettingsSetupOnly()` is the fallback when one or more of
// the YouTube env vars are missing at boot. It renders the same docs
// page with a banner listing the missing vars; no live data, no
// Connect button. Used to break the chicken-and-egg loop where the
// env vars the operator needs to set are documented on a page they
// cannot reach without those env vars (the same pattern as the email
// slice's `emailSettingsSetupOnly`).

import { Hono } from 'hono'
import type { Database } from './db.js'
import type { AuthVariables } from './auth.js'
import type { TokenCipher } from './token-encryption.js'
import {
  listYouTubeAccounts,
  deleteYouTubeAccount,
  getMostRecentYouTubeAccountId,
  getYouTubeAccount,
} from './youtube-accounts.js'
import { OAUTH_SCOPE } from './youtube-oauth.js'
import type { YouTubeOAuthClient } from './youtube-oauth.js'
import {
  COMMON_HEAD,
  THEME_SCRIPT_TAG,
  HAMBURGER_SCRIPT_TAG,
  CLIPBOARD_SCRIPT_TAG,
  renderHeader,
} from './view-shared.js'

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface YouTubeSettingsDeps {
  readonly db: Database
  readonly cipher: TokenCipher
  /** Used by the Disconnect POST endpoint so it can revoke at Google. */
  readonly client: YouTubeOAuthClient
}

export function youtubeSettingsView(
  deps: YouTubeSettingsDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()

  api.get('/', (c) => {
    const accounts = listYouTubeAccounts(deps.db, deps.cipher)
    const status = c.req.query('status') ?? ''
    const reason = c.req.query('reason') ?? ''
    const html = renderPage({
      accounts,
      flash: readFlash(status, reason),
      setupMissing: null,
    })
    return c.html(html)
  })

  // Form-friendly alias for DELETE /api/youtube/connection.
  api.post('/disconnect', async (c) => {
    const accountId = getMostRecentYouTubeAccountId(deps.db)
    if (accountId === null) {
      // Idempotent — silently redirect back; an outdated form
      // submission shouldn't produce an error in the UI.
      return c.redirect('/settings/youtube', 302)
    }

    // Best-effort revoke (matches the DELETE /api/youtube/connection
    // path). Skip if we can't decrypt the token.
    let accessToken: string | null = null
    try {
      const account = getYouTubeAccount(deps.db, deps.cipher, accountId)
      accessToken = account?.accessToken ?? null
    } catch {
      // Decryption failed; skip revoke.
    }
    if (accessToken !== null) {
      try {
        await deps.client.revoke(accessToken)
      } catch {
        // ignore — local delete is the source of truth
      }
    }

    deleteYouTubeAccount(deps.db, accountId)
    return c.redirect('/settings/youtube?status=disconnected', 302)
  })

  return api
}

// ─── Setup-only fallback (no YouTube deps) ───────────────────────────────

/** Renders the same page as `youtubeSettingsView` but in setup mode:
 *  no live data, no connect button, no account list. Just a banner
 *  listing the missing env vars and the docs explaining how to set
 *  them. Used when the server is started without the required YouTube
 *  env vars — without this fallback, an operator cannot reach the
 *  page that documents the env vars. */
export function youtubeSettingsSetupOnly(): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()
  api.get('/', (c) => {
    // The boot banner knows which vars are missing; it links here
    // with `?missing=A,B,C`. If the operator navigates here without
    // the query, render the docs anyway (still useful).
    const raw = c.req.query('missing') ?? ''
    const missing = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const html = renderPage({
      accounts: [],
      flash: null,
      setupMissing: missing,
    })
    return c.html(html)
  })
  return api
}

// ─── Flash banner ─────────────────────────────────────────────────────────

interface Flash {
  readonly kind: 'connected' | 'disconnected' | 'error'
  readonly message: string
}

function readFlash(status: string, reason: string): Flash | null {
  if (status === 'connected') {
    return { kind: 'connected', message: 'YouTube connected successfully.' }
  }
  if (status === 'disconnected') {
    return { kind: 'disconnected', message: 'YouTube disconnected.' }
  }
  if (status === 'error') {
    return {
      kind: 'error',
      message: `Couldn\u2019t finish the OAuth flow: ${humaniseReason(reason)}`,
    }
  }
  return null
}

function humaniseReason(reason: string): string {
  switch (reason) {
    case 'missing_params':
      return 'the redirect from Google was missing required parameters.'
    case 'invalid_or_expired_state':
      return 'the CSRF state was invalid or expired. Please try again.'
    case 'expired_state':
      return 'the OAuth state expired (>10 minutes). Please try again.'
    case 'no_refresh_token':
      return 'Google did not return a refresh token. Disconnect any prior grant at myaccount.google.com/permissions, then retry.'
    default:
      if (reason.startsWith('token_exchange_failed:')) {
        return `Google rejected the authorisation code (${reason.replace('token_exchange_failed:', '').trim()}).`
      }
      if (reason.startsWith('userinfo_failed:')) {
        return `could not read your Google profile (${reason.replace('userinfo_failed:', '').trim()}).`
      }
      if (reason.startsWith('store_failed:')) {
        return `could not store the new account locally (${reason.replace('store_failed:', '').trim()}).`
      }
      if (reason === '') return 'an unknown error occurred.'
      return reason
  }
}

// ─── HTML rendering ───────────────────────────────────────────────────────

interface RenderArgs {
  readonly accounts: ReturnType<typeof listYouTubeAccounts>
  readonly flash: Flash | null
  /** When non-null, the page renders a setup-required banner
   *  listing these env vars as the missing ones. Empty array means
   *  "we're here but no live data". */
  readonly setupMissing: ReadonlyArray<string> | null
}

function renderPage(args: RenderArgs): string {
  const inSetupMode = args.setupMissing !== null
  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Dashboard — YouTube Settings</title>
    <meta name="robots" content="noindex">
    <style>${STYLES}</style>
  </head>
  <body>
    ${renderHeader({ showSearch: true, showSidebarToggle: false })}
    <main class="youtube-settings-main">
      <header class="page-heading">
        <span class="page-eyebrow">Integration</span>
        <h1>YouTube</h1>
        <p>Connect a read-only YouTube account and manage its dashboard access.</p>
      </header>
      <nav class="settings-tabs" aria-label="Settings sections">
        <a href="/settings" class="settings-tab">API tokens</a>
        <a href="/settings/email" class="settings-tab">Email</a>
        <a href="/settings/youtube" class="settings-tab settings-tab-active" aria-current="page">YouTube</a>
        <a href="/settings/ai" class="settings-tab">AI &amp; Research</a>
      </nav>

      ${inSetupMode ? renderSetupRequiredBanner(args.setupMissing!) : ''}
      ${args.flash ? renderFlash(args.flash) : ''}

      ${inSetupMode
        ? renderSetupModePrompt()
        : args.accounts.length === 0
          ? renderConnectPrompt()
          : renderAccountList(args.accounts)}

      ${!inSetupMode && args.accounts.length > 0
        ? `<p class="settings-yt-jump-links">
            <a href="/videos">View new videos \u2192</a>
            <a href="/subscriptions">Manage subscriptions \u2192</a>
          </p>`
        : ''}

      ${renderHistoryImport()}

      <section class="setup-docs">
        <h2>One-time Google Cloud Console setup</h2>
        <p>
          Before you can connect YouTube you need an OAuth 2.0 client
          registered in the Google Cloud Console, with the YouTube Data
          API v3 enabled. Run through these steps once per dashboard host.
        </p>
        <ol>
          <li>Open
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">APIs &amp; Services \u2192 Credentials</a>
            in the Google Cloud Console.
          </li>
          <li>Create (or select) a project. Enable the
            <strong>YouTube Data API v3</strong> in
            <em>APIs &amp; Services \u2192 Library</em>.
          </li>
          <li>Click <strong>Create credentials \u2192 OAuth client ID</strong>.
            Choose <em>Web application</em>. Under
            <em>Authorized redirect URIs</em>, add
            <code>${escapeHtml('<your YOUTUBE_OAUTH_REDIRECT_URI>')}</code>
            \u2014 it must match the dashboard\u2019s
            <code>YOUTUBE_OAUTH_REDIRECT_URI</code> env var exactly.
            See the
            <a href="#redirect-uri-rules">redirect URI rules</a>
            below \u2014 the wrong choice will be rejected by the
            Cloud Console with a vague error.
          </li>
          <li>Copy the client id + client secret into
            <code>YOUTUBE_OAUTH_CLIENT_ID</code> and
            <code>YOUTUBE_OAUTH_CLIENT_SECRET</code>, then restart the
            server.
          </li>
          <li>Confirm the consent screen lists
            <strong>youtube.readonly</strong>,
            <strong>openid</strong>, AND
            <strong>userinfo.email</strong> as the three requested
            scopes. The dashboard never requests
            <code>youtube.upload</code>, <code>youtube.force-ssl</code>
            (unless <code>subscriptions.list</code> ever returns a
            <code>403 insufficient authentication scopes</code> error),
            or write access of any kind. The <code>openid</code> +
            <code>userinfo.email</code> pair is what lets us read
            your Google profile (email + id) so we can label the
            connection in <code>/settings/youtube</code>; both grant
            zero YouTube access.
          </li>
        </ol>

        <h2 id="redirect-uri-rules">Redirect URI rules (the gotcha)</h2>
        <p>
          Google\u2019s <em>Web application</em> client has two rules
          that bite local development. (These are the same rules that
          apply to the Gmail connection \u2014 see
          <a href="/settings/email">/settings/email</a> for the full
          tunnel / mkcert / production walkthrough with copy-pasteable
          commands.)
        </p>
        <ol>
          <li>The host must be either the literal loopback
            (<code>localhost</code> / <code>127.0.0.1</code>) or a
            publicly resolvable domain. Bare private IPs
            (<code>192.168.x.x</code>, <code>10.x.x.x</code>) and
            RFC1918-shaped hostnames are rejected with a vague
            <em>"Invalid Redirect URI"</em>.</li>
          <li>Plain <code>http://</code> is only allowed for the
            loopback hosts. Anything else \u2014 including
            <code>nip.io</code>, <code>sslip.io</code>, your
            <code>192.168.0.136.nip.io</code> LAN trick, etc. \u2014
            <strong>must be <code>https://</code></strong>. Google
            enforces this since 2024 and will reject
            <code>http://192.168.0.136.nip.io:8080/...</code> with
            <em>"Redirect URI must use HTTPS"</em>.</li>
        </ol>

        <p>
          Whatever you register in the Cloud Console must match the
          <code>YOUTUBE_OAUTH_REDIRECT_URI</code> env var byte-for-byte
          \u2014 different host, different port, trailing slash, or
          <code>http</code> vs <code>https</code> and Google will
          reject the consent with a <em>redirect_uri_mismatch</em>.
        </p>

        <h2>Env vars (one-time)</h2>
        <p>The YouTube OAuth routes return 503 if any of these are missing:</p>
        <dl class="env-list">
          <dt><code>YOUTUBE_TOKEN_ENCRYPTION_KEY</code></dt>
          <dd>64 hex characters (32 bytes). Generate with
            <code>openssl rand -hex 32</code>. Used for AES-256-GCM
            at-rest encryption of OAuth tokens. Rotate every 12 months
            (deferred slice).</dd>

          <dt><code>YOUTUBE_OAUTH_CLIENT_ID</code></dt>
          <dd>The OAuth 2.0 client id from step 3 above.</dd>

          <dt><code>YOUTUBE_OAUTH_CLIENT_SECRET</code></dt>
          <dd>The OAuth 2.0 client secret from step 3 above.</dd>

          <dt><code>YOUTUBE_OAUTH_REDIRECT_URI</code></dt>
          <dd>Full callback URL. Loopback testing:
            <code>http://localhost:8080/api/youtube/oauth/callback</code>.
            LAN / phone testing: <code>https://&lt;your-ip&gt;.nip.io:8080/api/youtube/oauth/callback</code>
            (HTTPS is required for non-loopback hosts). Must match the
            value registered in the Google Cloud Console byte-for-byte.</dd>

          <dt><code>DASHBOARD_TLS_CERT</code> / <code>DASHBOARD_TLS_KEY</code></dt>
          <dd>Optional. Absolute paths to a PEM-encoded TLS cert +
            key. Required for any non-loopback redirect URI. Both
            vars must be set together.</dd>
        </dl>
      </section>
    </main>
    ${CLIPBOARD_SCRIPT_TAG}
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
    <script>${HISTORY_IMPORT_SCRIPT}</script>
  </body>
</html>`
}

function renderHistoryImport(): string {
  return `<section class="history-import" id="watch-history-import" data-history-import>
    <div class="history-import-heading"><div><span class="page-eyebrow">Private local import</span><h2>Import watch history</h2><p>Bring in watch events from Google Takeout. The file is validated locally, staged privately, and nothing is saved until you confirm the preview.</p></div><a href="/history">View History →</a></div>
    <details class="takeout-help"><summary>How to get <code>watch-history.json</code></summary><ol><li>Open <a href="https://takeout.google.com/" target="_blank" rel="noopener">Google Takeout</a> and deselect all products.</li><li>Select <strong>YouTube and YouTube Music</strong>, choose <strong>history</strong>, and create the export.</li><li>In the archive, select <code>YouTube and YouTube Music/history/watch-history.json</code> below.</li></ol></details>
    <form class="history-upload-form" data-history-upload-form>
      <label for="history-file">Takeout JSON file</label>
      <div><input id="history-file" name="file" type="file" accept="application/json,.json" required data-history-file><button type="submit" class="primary-button" data-history-preview>Validate file</button></div>
    </form>
    <div class="history-import-status" data-history-status role="status" aria-live="polite"></div>
    <section class="history-preview" data-history-preview-panel hidden aria-labelledby="history-preview-title">
      <div class="history-preview-title"><div><span class="page-eyebrow">Dry-run preview</span><h3 id="history-preview-title">Review before importing</h3></div><span data-history-preview-expiry></span></div>
      <dl class="history-preview-counts" data-history-preview-counts></dl>
      <div class="history-preview-warning" data-history-preview-warning hidden></div>
      <div class="history-confirm"><p>This action only adds missing watch events. It does not change or delete anything on YouTube.</p><button type="button" class="primary-button" data-history-confirm>Confirm import</button></div>
    </section>
    <section class="history-import-result" data-history-result hidden></section>
    <section class="history-audits"><h3>Previous imports</h3><p data-history-audit-empty>Loading import history…</p><div class="history-audit-list" data-history-audit-list></div></section>
  </section>`
}

function renderConnectPrompt(): string {
  return `<section class="connect-prompt">
    <p class="lead">
      Connect a YouTube account to mirror your subscriptions + new
      video uploads into the dashboard. The dashboard requests
      <strong>read-only</strong> access \u2014 it cannot upload,
      delete, comment, or modify anything on your channel.
    </p>
    <a class="primary-button" href="/api/youtube/oauth/start">
      <span class="youtube-icon" aria-hidden="true">\u25b6</span>
      Connect YouTube
    </a>
    <p class="scope-note">
      Scope: <code>${escapeHtml(OAUTH_SCOPE)}</code>
    </p>
  </section>`
}

/** Top-of-page banner shown when YouTube deps aren't fully configured.
 *  Lists every missing env var so the operator can copy them straight
 *  into their shell script / .env. */
function renderSetupRequiredBanner(missing: ReadonlyArray<string>): string {
  const items = missing
    .map((name) => `      <li><code>${escapeHtml(name)}</code></li>`)
    .join('\n')
  return `<section class="setup-required">
    <h2>\u26a0 YouTube slice not configured</h2>
    <p>
      The server started, but the YouTube feature is not wired up yet.
      Set the following environment variables and restart the server:
    </p>
    <ul class="env-missing">
${items}
    </ul>
    <p>
      Need a fresh <code>YOUTUBE_TOKEN_ENCRYPTION_KEY</code>? Run
      <code>openssl rand -hex 32</code>.
    </p>
    <p>
      Full setup walkthrough is below.
    </p>
  </section>`
}

/** Body of the page when in setup mode. Replaces the "Connect YouTube"
 *  prompt + account list with a clear note that the operator must
 *  configure the server first. */
function renderSetupModePrompt(): string {
  return `<section class="setup-mode-prompt">
    <p class="lead">
      The YouTube connection is unavailable because the server is missing
      required environment variables (see the banner above).
      The OAuth flow cannot start until the server is restarted with
      every required var in place.
    </p>
    <p class="muted">
      The rest of the dashboard \u2014 bookmarks, folders, tags, search,
      settings \u2014 keeps working while YouTube is unconfigured.
    </p>
  </section>`
}

function renderAccountList(
  accounts: ReturnType<typeof listYouTubeAccounts>,
): string {
  const rows = accounts
    .map((a) => {
      const lastRefreshLine = a.lastRefreshedAt
        ? `Last refreshed ${escapeHtml(formatDate(a.lastRefreshedAt))}`
        : 'Never refreshed'
      return `
        <li class="account-row" data-account-row-id="${escapeHtml(a.id)}">
          <div class="account-info">
            <span class="youtube-icon" aria-hidden="true">\u25b6</span>
            <div>
              <div class="account-email">${escapeHtml(a.emailAddress)}</div>
              <div class="account-meta">
                Connected ${escapeHtml(formatDate(a.connectedAt))}
                \u00b7 ${lastRefreshLine}
                \u00b7 Permissions: <code>${escapeHtml(a.scopes)}</code>
              </div>
            </div>
          </div>
          <div class="account-actions">
            <form method="post" action="/settings/youtube/disconnect" class="disconnect-form">
              <button type="submit" class="danger-button">Disconnect</button>
            </form>
          </div>
        </li>`
    })
    .join('')
  return `<section class="account-list-section">
    <h2>Connected YouTube accounts</h2>
    <ul class="account-list">${rows}
    </ul>
  </section>`
}

function renderFlash(flash: Flash): string {
  return `<div class="flash flash-${escapeHtml(flash.kind)}" role="status">
    <span class="flash-icon" aria-hidden="true">${
      flash.kind === 'error' ? '\u26a0' : '\u2713'
    }</span>
    <span>${escapeHtml(flash.message)}</span>
  </div>`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Styles ───────────────────────────────────────────────────────────────

const STYLES = `
  /* Scoped styles for the YouTube settings page. Inherits CSS variables
   * (--text, --muted, --surface, --border, --accent, --danger, --success)
   * from /static/styles.css so the page renders correctly under both
   * light and dark themes. Mirrors email-settings.ts style block —
   * intentional duplication over abstraction since the two pages are
   * likely to diverge as features grow (sync status vs refresh status). */
  .youtube-settings-main { width: min(100% - 2rem, 1040px); margin: 0 auto; padding: 2.25rem 0 4rem; color: var(--text); }
  .youtube-settings-main h1 { font-weight: 600; }
  .youtube-settings-main h2 { font-weight: 600; margin-top: 2.5rem; color: var(--text); }
  .youtube-settings-main nav.breadcrumb { font-size: 0.9rem; margin-bottom: 1rem; }
  .youtube-settings-main nav.breadcrumb a { color: var(--accent); text-decoration: none; }
  .youtube-settings-main nav.breadcrumb a:hover { text-decoration: underline; }
  .youtube-settings-main .lead { color: var(--muted); line-height: 1.5; max-width: 36rem; }
  .youtube-settings-main .muted { color: var(--muted); }
  .youtube-settings-main .scope-note { color: var(--muted); font-size: 0.85rem; margin-top: 0.5rem; }

  .primary-button, .secondary-button, .danger-button {
    display: inline-flex; align-items: center; gap: 0.5rem;
    padding: 0.6rem 1.1rem; border-radius: 0.3rem; cursor: pointer;
    text-decoration: none; font-size: 0.95rem; line-height: 1;
    border: 1px solid transparent;
    font-weight: 500;
  }
  .primary-button { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .primary-button:hover { filter: brightness(0.92); }
  .secondary-button { background: var(--surface); color: var(--text); border-color: var(--border); }
  .secondary-button:hover { background: var(--surface-hover); }
  .danger-button { background: var(--bg); color: var(--danger); border-color: var(--danger); }
  .danger-button:hover { background: var(--surface-hover); }
  .youtube-icon { font-size: 1.1rem; line-height: 1; color: #ff0000; }

  .connect-prompt {
    padding: 1.5rem; border: 1px solid var(--border); border-radius: 0.5rem;
    background: var(--surface); max-width: 40rem; color: var(--text);
  }
  .connect-prompt .lead { margin-top: 0; color: var(--muted); }
  .connect-prompt .primary-button { margin: 0.75rem 0 0.5rem; }

  .account-list-section { margin-top: 2rem; }
  .account-list { list-style: none; padding: 0; margin: 0; }
  .account-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 1rem; border: 1px solid var(--border); border-radius: 0.4rem;
    background: var(--bg); margin-bottom: 0.5rem; color: var(--text);
  }
  .account-info { display: flex; align-items: center; gap: 0.75rem; }
  .account-email { font-weight: 600; color: var(--text); }
  .account-meta { color: var(--muted); font-size: 0.85rem; margin-top: 0.2rem; }
  .account-meta code {
    background: var(--surface); padding: 0.05rem 0.3rem; border-radius: 3px;
    border: 1px solid var(--border); font-size: 0.8rem;
  }
  .disconnect-form { margin: 0; }
  .account-actions { display: flex; gap: 0.5rem; align-items: center; }

  .setup-required {
    margin-top: 1.5rem; padding: 1.25rem 1.5rem;
    border: 1px solid var(--danger); border-radius: 0.5rem;
    background: var(--surface); color: var(--text);
  }
  .setup-required h2 {
    margin: 0 0 0.5rem; font-size: 1.1rem; color: var(--danger);
  }
  .setup-required ul.env-missing {
    margin: 0.75rem 0; padding-left: 1.25rem; color: var(--text);
  }
  .setup-required ul.env-missing li { margin: 0.25rem 0; }
  .setup-required code { color: var(--text); }
  .setup-required p { color: var(--text); }

  .setup-mode-prompt {
    padding: 1.5rem; border: 1px solid var(--border); border-radius: 0.5rem;
    background: var(--surface); max-width: 40rem; color: var(--text);
  }
  .setup-mode-prompt .lead { color: var(--text); margin-top: 0; }
  .setup-mode-prompt .muted { color: var(--muted); }

  .flash {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.8rem 1rem; border-radius: 0.3rem; margin: 1rem 0;
    border: 1px solid;
  }
  .flash-connected { background: var(--accent-dim); color: var(--success); border-color: var(--success); }
  .flash-disconnected { background: var(--surface); color: var(--text); border-color: var(--border); }
  .flash-error { background: var(--surface); color: var(--danger); border-color: var(--danger); }
  .flash-icon { font-size: 1.1rem; }

  .setup-docs { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--border); max-width: 40rem; color: var(--text); }
  .setup-docs p { color: var(--text); }
  .setup-docs ol, .setup-docs ul { line-height: 1.5; color: var(--text); }
  .setup-docs li { margin: 0.5rem 0; }
  .setup-docs code {
    background: var(--surface); color: var(--text);
    padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85rem;
    word-break: break-all; border: 1px solid var(--border);
  }
  .setup-docs .env-list { margin-top: 0.75rem; }
  .setup-docs dt { font-weight: 600; margin-top: 0.75rem; color: var(--text); }
  .setup-docs dd { color: var(--muted); line-height: 1.5; margin-left: 1rem; }
  .setup-docs a { color: var(--accent); text-decoration: none; }
  .setup-docs a:hover { text-decoration: underline; }
  .history-import { margin-top:2.5rem; padding:1.4rem; border:1px solid var(--border); border-radius:14px; background:var(--surface); box-shadow:var(--shadow); }
  .history-import h2,.history-import h3 { margin:0; }.history-import p { color:var(--muted); line-height:1.5; }
  .history-import-heading { display:flex; justify-content:space-between; gap:20px; align-items:flex-start; }.history-import-heading>div>p { max-width:650px; margin:.45rem 0 0; }.history-import-heading>a { color:var(--accent); text-decoration:none; white-space:nowrap; }
  .takeout-help { margin:1rem 0; padding:.75rem 1rem; border:1px solid var(--border); border-radius:9px; background:var(--surface-2); }.takeout-help summary { cursor:pointer; font-weight:600; }.takeout-help ol { color:var(--muted); line-height:1.5; }
  .history-upload-form { display:grid; gap:.4rem; margin-top:1rem; }.history-upload-form>label { font-size:.8rem; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }.history-upload-form>div { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }.history-upload-form input { flex:1; min-width:230px; padding:.55rem; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--text); }
  .history-import-status { min-height:1.4em; margin:.8rem 0; color:var(--muted); }.history-import-status[data-kind=error] { color:var(--danger); }.history-import-status[data-kind=working]::before { content:'◌'; display:inline-block; margin-right:.4rem; animation:history-spin 1s linear infinite; }
  .history-preview { border-top:1px solid var(--border); padding-top:1.2rem; }.history-preview-title { display:flex; justify-content:space-between; gap:12px; }.history-preview-title>span { color:var(--muted); font-size:.8rem; }
  .history-preview-counts { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px; margin:1rem 0; }.history-preview-counts div { padding:.7rem; border-radius:9px; background:var(--surface-2); }.history-preview-counts dt { color:var(--muted); font-size:.75rem; }.history-preview-counts dd { margin:.2rem 0 0; font-size:1.1rem; font-weight:650; }
  .history-preview-warning { padding:.7rem .9rem; border:1px solid color-mix(in srgb,#f59e0b 45%,var(--border)); border-radius:8px; color:#f59e0b; background:color-mix(in srgb,#f59e0b 8%,transparent); }
  .history-confirm { display:flex; justify-content:space-between; gap:18px; align-items:center; }.history-confirm p { margin:.6rem 0; font-size:.85rem; }.history-confirm button { white-space:nowrap; }
  .history-import-result { margin-top:1rem; padding:1rem; border:1px solid color-mix(in srgb,#10b981 45%,var(--border)); border-radius:9px; background:color-mix(in srgb,#10b981 8%,var(--surface)); }.history-import-result h3 { color:var(--success); }.history-import-result a { color:var(--accent); }
  .history-audits { margin-top:1.5rem; padding-top:1.2rem; border-top:1px solid var(--border); }.history-audits>p { margin:.5rem 0; }.history-audit-list { display:grid; gap:8px; }.history-audit { padding:.8rem; border:1px solid var(--border); border-radius:9px; background:var(--bg); }.history-audit header { display:flex; justify-content:space-between; gap:10px; }.history-audit strong { overflow-wrap:anywhere; }.history-audit header span { color:var(--muted); font-size:.78rem; }.history-audit p { margin:.35rem 0 0; font-size:.82rem; }.history-audit code { color:var(--muted); }
  @keyframes history-spin { to { transform:rotate(360deg); } }
  @media (max-width: 640px) {
    .youtube-settings-main { padding-top: 1.5rem; }
    .connect-prompt, .setup-mode-prompt, .setup-required { padding: 1rem; }
    .account-row { align-items: flex-start; flex-direction: column; gap: 1rem; }
    .account-info { align-items: flex-start; min-width: 0; }
    .account-meta { overflow-wrap: anywhere; }
    .account-actions, .disconnect-form, .danger-button { width: 100%; }
    .danger-button { justify-content: center; min-height: 42px; }
    .setup-docs dd { margin-left: 0; }
    .history-import-heading,.history-confirm { flex-direction:column; }.history-confirm button { width:100%; justify-content:center; }
  }
`

const HISTORY_IMPORT_SCRIPT = String.raw`(function () {
  var root = document.querySelector('[data-history-import]')
  if (!root) return
  var form = root.querySelector('[data-history-upload-form]')
  var file = root.querySelector('[data-history-file]')
  var status = root.querySelector('[data-history-status]')
  var panel = root.querySelector('[data-history-preview-panel]')
  var counts = root.querySelector('[data-history-preview-counts]')
  var warning = root.querySelector('[data-history-preview-warning]')
  var expiry = root.querySelector('[data-history-preview-expiry]')
  var confirm = root.querySelector('[data-history-confirm]')
  var result = root.querySelector('[data-history-result]')
  var auditList = root.querySelector('[data-history-audit-list]')
  var auditEmpty = root.querySelector('[data-history-audit-empty]')
  var token = null

  function setStatus(message, kind) { status.textContent = message; status.dataset.kind = kind || '' }
  function metric(label, value) { var d=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value);d.append(dt,dd);return d }
  function date(value) { if (!value) return '—'; var d=new Date(value); return isNaN(d.getTime()) ? value : d.toLocaleString() }
  async function json(response) { var body=await response.json().catch(function(){return {error:'The server returned an invalid response.'}}); if(!response.ok) throw new Error(body.error || 'Request failed.'); return body }

  form.addEventListener('submit', async function (event) {
    event.preventDefault(); if (!file.files || !file.files[0]) { setStatus('Choose a watch-history.json file first.', 'error'); return }
    token=null; panel.hidden=true; result.hidden=true; setStatus('Validating your Takeout file…', 'working')
    var body=new FormData(); body.append('file', file.files[0])
    try {
      var preview=await json(await fetch('/api/youtube/history/preview',{method:'POST',body:body,credentials:'same-origin'}))
      token=preview.token; counts.replaceChildren(
        metric('Total events',preview.total_count),metric('New events',preview.new_event_count),metric('Duplicates',preview.duplicate_count),metric('Malformed',preview.malformed_count),metric('Unique videos',preview.unique_video_count),metric('New videos',preview.new_video_count),metric('Oldest watch',date(preview.oldest_watched_at)),metric('Newest watch',date(preview.newest_watched_at)))
      expiry.textContent='Preview expires '+date(preview.expires_at)
      var notes=[]; if(preview.duplicate_count)notes.push(preview.duplicate_count+' duplicate event'+(preview.duplicate_count===1?'':'s')+' will be skipped'); if(preview.malformed_count)notes.push(preview.malformed_count+' malformed entr'+(preview.malformed_count===1?'y':'ies')+' could not be imported')
      warning.textContent=notes.join('. '); warning.hidden=notes.length===0; panel.hidden=false; confirm.disabled=false
      setStatus('Validation complete. Review the dry-run counts before confirming.', '')
      panel.scrollIntoView({behavior:'smooth',block:'nearest'})
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not validate this file.', 'error') }
  })

  confirm.addEventListener('click', async function () {
    if(!token)return; confirm.disabled=true; setStatus('Importing watch events…', 'working')
    try {
      var imported=await json(await fetch('/api/youtube/history/imports/'+encodeURIComponent(token)+'/commit',{method:'POST',credentials:'same-origin'}))
      token=null; panel.hidden=true; result.replaceChildren()
      var heading=document.createElement('h3'); heading.textContent='Import complete'
      var copy=document.createElement('p'); copy.textContent=imported.committed_event_count+' watch events added · '+imported.duplicate_count+' duplicates skipped · '+imported.malformed_count+' malformed entries skipped · '+imported.inserted_video_count+' new videos created.'
      var link=document.createElement('a'); link.href='/history'; link.textContent='View watch history →'; result.append(heading,copy,link); result.hidden=false
      setStatus('Your watch history is ready.', ''); await loadAudits()
    } catch(error) { confirm.disabled=false; setStatus(error instanceof Error ? error.message : 'Could not commit this import.', 'error') }
  })

  async function loadAudits() {
    try {
      var body=await json(await fetch('/api/youtube/history/imports',{credentials:'same-origin'})); auditList.replaceChildren(); auditEmpty.hidden=body.items.length>0; if(!body.items.length)auditEmpty.textContent='No imports yet.'
      body.items.forEach(function(item){
        var card=document.createElement('article');card.className='history-audit';var head=document.createElement('header');var name=document.createElement('strong');name.textContent=item.filename;var state=document.createElement('span');state.textContent=item.status+(item.committed_at?' · '+date(item.committed_at):'');head.append(name,state)
        var meta=document.createElement('p');meta.textContent=(item.committed_event_count===null?item.new_event_count:item.committed_event_count)+' added · '+item.duplicate_count+' duplicates · '+item.malformed_count+' malformed · '+date(item.oldest_watched_at)+' — '+date(item.newest_watched_at)
        var hash=document.createElement('code');hash.textContent='SHA-256 '+item.file_hash.slice(0,12)+'…';card.append(head,meta,hash);auditList.append(card)
      })
    } catch(error) { auditEmpty.hidden=false; auditEmpty.textContent='Import history is unavailable right now.' }
  }
  loadAudits()
})()`
