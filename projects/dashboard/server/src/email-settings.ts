// email-settings.ts — issue #020
//
// HTML view at GET /settings/email. Shows:
//
//   * "Connect Gmail" button when no account is connected, with a
//     link to the one-time Google Cloud Console setup.
//   * The connected account(s) — email + connected-on + last-sync-at —
//     each with a form-POST Disconnect button.
//   * The post-OAuth flash banner: `?status=connected|disconnected|error`.
//   * The setup checklist docs in-page (Google Cloud project + OAuth
//     client + env vars). Operators run this once; the docs live next
//     to the button so it's the only place a new admin has to look.
//
// POST /settings/email/accounts/:id/disconnect is the form-friendly
// alias for DELETE /api/email/accounts/:id — matches the existing
// token-revoke pattern (browsers don't support method=DELETE in <form>).
// POST /settings/email/accounts/:id/sync is the form-friendly alias
// for POST /api/email/sync?account_id=:id. Kicks off the worker
// fire-and-forget, then redirects to the polling page. (Bug fix #023:
// an earlier version only redirected without starting the sync, so
// the "Refresh" button was a no-op. The form post is now the actual
// trigger; the redirect just carries the account id so the poller
// JS knows who to watch.)

import { Hono } from 'hono'
import type { Database } from './db.js'
import type { AuthVariables } from './auth.js'
import type { TokenCipher } from './token-encryption.js'
import { listEmailAccounts, getEmailAccount, deleteEmailAccount } from './email-accounts.js'
import type { EmailSyncWorker } from './email-sync-worker.js'
import {
  COMMON_HEAD,
  THEME_SCRIPT_TAG,
  HAMBURGER_SCRIPT_TAG,
  CLIPBOARD_SCRIPT_TAG,
  renderHeader,
} from './view-shared.js'

// ─── Hono sub-app ─────────────────────────────────────────────────────────

export interface EmailSettingsDeps {
  readonly db: Database
  readonly cipher: TokenCipher
  /** Used for the Disconnect POST endpoint so it can revoke at Google. */
  readonly revokeFetchFn?: typeof fetch
  /** Required for the Refresh button + sync-progress indicator. */
  readonly syncWorker: EmailSyncWorker
}

export function emailSettingsView(
  deps: EmailSettingsDeps,
): Hono<{ Variables: AuthVariables }> {
  const api = new Hono<{ Variables: AuthVariables }>()
  const fetchFn = deps.revokeFetchFn ?? fetch

  api.get('/', (c) => {
    const accounts = listEmailAccounts(deps.db, deps.cipher)
    const status = c.req.query('status') ?? ''
    const reason = c.req.query('reason') ?? ''
    const accountId = c.req.query('account') ?? ''
    const statusInfo = accountId !== '' ? deps.syncWorker.status(accountId) : null
    const html = renderPage({
      accounts,
      flash: readFlash(status, reason),
      sync: {
        // Render the poller whenever the URL says a sync is in
        // flight, regardless of the DB state at render time. The
        // previous version required `statusInfo.inProgress`, which
        // created a chicken-and-egg: the form post that was
        // supposed to START the sync needed `inProgress: true` to
        // render the poller, but `inProgress` only flips true
        // after a sync has started. Bug #023.
        showProgress: status === 'syncing' && accountId !== '',
        accountId,
        statusInfo,
      },
      setupMissing: null,
    })
    return c.html(html)
  })

  // Form-friendly alias for DELETE /api/email/accounts/:id. Mirrors
  // the token-revoke pattern (issue #002).
  api.post('/accounts/:id/disconnect', async (c) => {
    const id = c.req.param('id')
    const account = getEmailAccount(deps.db, deps.cipher, id)
    if (!account) {
      // Idempotent — silently redirect back; an outdated form
      // submission (e.g. account already deleted in another tab)
      // shouldn't produce an error in the UI.
      return c.redirect('/settings/email', 302)
    }
    // Best-effort revoke (matches the DELETE /api/email/accounts/:id path).
    try {
      await fetchFn(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(account.accessToken)}`,
        { method: 'POST' },
      )
    } catch {
      // ignore — local delete is the source of truth
    }
    deleteEmailAccount(deps.db, id)
    return c.redirect('/settings/email?status=disconnected', 302)
  })

  // Form-friendly alias for POST /api/email/sync?account_id=:id. This
  // is the primary trigger for the manual Refresh button. We do not
  // block on the sync — the worker is fire-and-forget, and the page
  // polls /api/email/accounts/:id/status for completion. The redirect
  // to "?status=syncing" carries the account id so the polling JS
  // knows who to watch.
  //
  // Bug fix #023: an earlier version only redirected without
  // starting the sync. Combined with the showProgress check above
  // (which required `inProgress: true` to render the poller), this
  // meant clicking Refresh never actually ran a sync. The handler
  // now mirrors what the JSON endpoint does: pre-flight the
  // account + in-progress flag, then kick off the worker.
  api.post('/accounts/:id/sync', (c) => {
    const id = c.req.param('id')

    // Pre-flight: account must exist. An outdated form submission
    // (account disconnected in another tab) should not look like a
    // sync failure in the UI — just redirect back to the list.
    const account = getEmailAccount(deps.db, deps.cipher, id)
    if (!account) {
      return c.redirect('/settings/email', 302)
    }

    // Pre-flight: don't double-trigger. A second Refresh click
    // while a sync is running is a no-op (the running sync will
    // finish, the poller will redirect back here).
    if (deps.syncWorker.status(id).inProgress) {
      return c.redirect(
        `/settings/email?status=syncing&account=${encodeURIComponent(id)}`,
        303,
      )
    }

    // Fire-and-forget. Errors during the sync are NOT surfaced via
    // this response (the sync is already in flight); the poller
    // observes `inProgress` flipping to false and `lastSyncAt`
    // either updating or staying old. We log so the operator has
    // something to grep for.
    void deps.syncWorker
      .sync({ accountId: id })
      .then((result) => {
        // eslint-disable-next-line no-console
        console.log(
          `[email-sync] account ${id}: +${result.added} ~${result.updated} -${result.removed} (${result.pages} page(s))`,
        )
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(
          `[email-sync] account ${id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })

    return c.redirect(
      `/settings/email?status=syncing&account=${encodeURIComponent(id)}`,
      303,
    )
  })

  return api
}

// ─── Flash banner ─────────────────────────────────────────────────────────

interface Flash {
  readonly kind: 'connected' | 'disconnected' | 'succeeded' | 'error' | 'already_running'
  readonly message: string
}

function readFlash(status: string, reason: string): Flash | null {
  if (status === 'connected') {
    return { kind: 'connected', message: 'Gmail connected successfully.' }
  }
  if (status === 'disconnected') {
    return { kind: 'disconnected', message: 'Gmail disconnected.' }
  }
  if (status === 'synced') {
    const added = formatCount('added', reason, 'added')
    const updated = formatCount('updated', reason, 'updated')
    const removed = formatCount('removed', reason, 'removed')
    return {
      kind: 'succeeded',
      message: `Sync complete: ${added}, ${updated}, ${removed}.`,
    }
  }
  if (status === 'syncing') return null // progress UI handles it
  if (status === 'already_running') {
    return { kind: 'already_running', message: 'A sync is already running for this account.' }
  }
  if (status === 'error') {
    return {
      kind: 'error',
      message: `Couldn\u2019t finish the OAuth flow: ${humaniseReason(reason)}`,
    }
  }
  return null
}

/** Parse `?reason=added:N&updated:M&removed:K` into a count summary. */
function formatCount(
  key: 'added' | 'updated' | 'removed',
  reason: string,
  _: string,
): string {
  const match = new RegExp(`(?:^|&)${key}=(\\d+)`).exec(reason)
  const n = match ? Number(match[1]) : 0
  return `${n} ${key}`
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
      if (reason.startsWith('gmail_profile_failed:')) {
        return `could not read your Gmail profile (${reason.replace('gmail_profile_failed:', '').trim()}).`
      }
      if (reason.startsWith('store_failed:')) {
        return `could not store the new account locally (${reason.replace('store_failed:', '').trim()}).`
      }
      if (reason === '') return 'an unknown error occurred.'
      return reason
  }
}

// ─── Setup-only fallback (no email deps) ─────────────────────────────────

/** Renders the same page as `emailSettingsView` but in setup mode:
 *  no live data, no connect button, no account list. Just a banner
 *  listing the missing env vars and the docs explaining how to set
 *  them. Used when the server is started without the required email
 *  env vars — without this fallback, an operator cannot reach the
 *  page that documents the env vars. */
export function emailSettingsSetupOnly(): Hono<{ Variables: AuthVariables }> {
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
      sync: { showProgress: false, accountId: '', statusInfo: null },
      setupMissing: missing,
    })
    return c.html(html)
  })
  return api
}

// ─── HTML rendering ───────────────────────────────────────────────────────

interface RenderArgs {
  readonly accounts: ReturnType<typeof listEmailAccounts>
  readonly flash: Flash | null
  readonly sync: {
    readonly showProgress: boolean
    readonly accountId: string
    readonly statusInfo: {
      readonly inProgress: boolean
      readonly lastSyncAt: string | null
      readonly lastMessagesSynced: number
      readonly lastAdded: number
      readonly lastUpdated: number
      readonly lastRemoved: number
      readonly startedAt: string | null
    } | null
  }
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
    <title>Dashboard — Email Settings</title>
    <meta name="robots" content="noindex">
    <style>${STYLES}</style>
  </head>
  <body>
    ${renderHeader({ showSearch: true })}
    <main class="email-settings-main">
      <nav class="breadcrumb"><a href="/settings">\u2190 Settings</a></nav>
      <h1>Email</h1>

      ${inSetupMode ? renderSetupRequiredBanner(args.setupMissing!) : ''}
      ${args.flash ? renderFlash(args.flash) : ''}
      ${args.sync.showProgress ? renderSyncProgress(args.sync.accountId) : ''}

      ${inSetupMode
        ? renderSetupModePrompt()
        : args.accounts.length === 0
          ? renderConnectPrompt()
          : renderAccountList(args.accounts, args.sync.statusInfo)}

      <section class="setup-docs">
        <h2>One-time Google Cloud Console setup</h2>
        <p>
          Before you can connect Gmail you need an OAuth 2.0 client
          registered in the Google Cloud Console. Run through these steps
          once per dashboard host.
        </p>
        <ol>
          <li>Open
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">APIs &amp; Services \u2192 Credentials</a>
            in the Google Cloud Console.
          </li>
          <li>Create (or select) a project. Enable the
            <strong>Gmail API</strong> in
            <em>APIs &amp; Services \u2192 Library</em>.
          </li>
          <li>Click <strong>Create credentials \u2192 OAuth client ID</strong>.
            Choose <em>Web application</em>. Under
            <em>Authorized redirect URIs</em>, add
            <code>${escapeHtml('<your EMAIL_OAUTH_REDIRECT_URI>')}</code>
            \u2014 it must match the dashboard\u2019s
            <code>EMAIL_OAUTH_REDIRECT_URI</code> env var exactly.
            See the
            <a href="#redirect-uri-rules">redirect URI rules</a>
            below \u2014 the wrong choice will be rejected by the
            Cloud Console with a vague error.
          </li>
          <li>Copy the client id + client secret into
            <code>GOOGLE_OAUTH_CLIENT_ID</code> and
            <code>GOOGLE_OAUTH_CLIENT_SECRET</code>, then restart the
            server.
          </li>
          <li>Confirm the consent screen lists
            <strong>gmail.readonly</strong> as the only requested scope.
            The dashboard never requests <code>gmail.modify</code>,
            <code>gmail.send</code>, or <code>gmail.compose</code>.
          </li>
        </ol>

        <h2 id="redirect-uri-rules">Redirect URI rules (the gotcha)</h2>
        <p>
          Google\u2019s <em>Web application</em> client has two rules
          that bite local development:
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

        <h3>What works, ranked from simplest to most flexible</h3>

        <p>
          <strong>1. Same-machine testing (no TLS, no extra tools):</strong>
          use <code>http://localhost:8080/api/email/oauth/callback</code>
          (or <code>http://127.0.0.1:8080/...</code>). Loopback is
          the only host Google still accepts over plain
          <code>http</code>. Open the dashboard from the same machine
          you started it on. Limitation: no testing from a phone or
          another laptop.
        </p>

        <p>
          <strong>2. Tunnel (one line, no cert management):</strong>
          run a public HTTPS tunnel in front of the dashboard and
          register the tunnel URL in the Cloud Console. Free tools:
        </p>
        <ul>
          <li><code>ngrok http 8080</code> \u2014 gives you a
            <code>https://&lt;random&gt;.ngrok-free.app</code> URL.
            Copy it into both the Cloud Console and
            <code>EMAIL_OAUTH_REDIRECT_URI</code>.</li>
          <li><code>cloudflared tunnel --url http://localhost:8080</code>
            \u2014 gives a <code>https://&lt;random&gt;.trycloudflare.com</code>
            URL. Same drill.</li>
        </ul>
        <p>
          <em>Caveat:</em> on free tiers the URL is random and changes
          every restart, so you\u2019ll re-edit the env var each time.
          For a persistent URL you need a paid plan or your own
          domain with a named tunnel.
        </p>

        <p>
          <strong>3. LAN with TLS (no external dependency):</strong>
          if you want <code>https://192.168.0.136.nip.io:8080/...</code>
          without a tunnel, run the dashboard over HTTPS directly.
          You\u2019ll need a TLS cert trusted by your browser.
          Pick whichever cert-generator fits your tooling:
        </p>

        <p>
          <em>a) <code>pnpm certgen</code> \u2014 recommended.
          Pure Node, no Python, no separate installs. Uses
          <code>node-forge</code> (already a dev-dep):</em>
        </p>
        <pre><code>pnpm certgen 192.168.0.136.nip.io 192.168.0.136

# Trust the CA on your machine (one-time per machine)
# Debian/Ubuntu (no p11-kit required):
sudo cp ca.pem /usr/local/share/ca-certificates/dashboard-ca.crt
sudo update-ca-certificates

# Fedora / Arch (with p11-kit):
sudo trust anchor ca.pem

# macOS:
sudo security add-trusted-cert -d -r trustRoot \\
  -k /Library/Keychains/System.keychain ca.pem

# Windows (admin PowerShell):
certutil -addstore -f "Root" ca.pem</code></pre>

        <p>
          <em>b) <a href="https://github.com/FiloSottile/mkcert" target="_blank" rel="noopener">mkcert</a>
          \u2014 single Go binary, no Python required:</em>
        </p>
        <pre><code>brew install mkcert &amp;&amp; mkcert -install       # macOS
sudo apt install mkcert &amp;&amp; mkcert -install   # Linux
mkcert 192.168.0.136.nip.io                  # \u2192 cert.pem + key.pem</code></pre>

        <p>
          Both produce the same <code>server.pem</code> +
          <code>server.key</code> shape the dashboard expects.
          Once the CA is trusted, point your <code>.env</code> at
          the files and start:
        </p>
        <pre><code>echo "DASHBOARD_TLS_CERT=$(pwd)/server.pem" >> .env
echo "DASHBOARD_TLS_KEY=$(pwd)/server.key"  >> .env
pnpm start
# \u2192 Dashboard listening on https://192.168.0.136:8080</code></pre>
        <p>
          Register
          <code>https://192.168.0.136.nip.io:8080/api/email/oauth/callback</code>
          in the Cloud Console once the server is up.
        </p>

        <p>
          <strong>4. Production:</strong> any real domain you own,
          e.g. <code>https://mail.example.com/api/email/oauth/callback</code>.
        </p>

        <p class="muted">
          Whatever you register in the Cloud Console must match the
          <code>EMAIL_OAUTH_REDIRECT_URI</code> env var byte-for-byte \u2014
          different host, different port, trailing slash, or
          <code>http</code> vs <code>https</code> and Google will
          reject the consent with a <em>redirect_uri_mismatch</em>.
        </p>

        <h2>Env vars (one-time)</h2>
        <p>The server refuses to start if any of these are missing:</p>
        <dl class="env-list">
          <dt><code>EMAIL_TOKEN_ENCRYPTION_KEY</code></dt>
          <dd>64 hex characters (32 bytes). Generate with
            <code>openssl rand -hex 32</code>. Used for AES-256-GCM
            at-rest encryption of OAuth tokens. Rotate every 12 months
            (deferred slice).</dd>

          <dt><code>GOOGLE_OAUTH_CLIENT_ID</code></dt>
          <dd>The OAuth 2.0 client id from step 3 above.</dd>

          <dt><code>GOOGLE_OAUTH_CLIENT_SECRET</code></dt>
          <dd>The OAuth 2.0 client secret from step 3 above.</dd>

          <dt><code>EMAIL_OAUTH_REDIRECT_URI</code></dt>
          <dd>Full callback URL. Loopback testing:
            <code>http://localhost:8080/api/email/oauth/callback</code>.
            LAN / phone testing: <code>https://&lt;your-ip&gt;.nip.io:8080/api/email/oauth/callback</code>
            (HTTPS is required for non-loopback hosts). See the
            <a href="#redirect-uri-rules">redirect URI rules</a>
            above for the full tunnel / mkcert / production options.
            Must match the value registered in the Google Cloud
            Console byte-for-byte.</dd>

          <dt><code>EMAIL_SYNC_HISTORY_DAYS</code></dt>
          <dd>Optional. Initial-sync lookback window in days (default
            <code>90</code>). Used only on the first sync for an
            account; subsequent syncs use the persisted cursor and
            ignore this value. Set higher for a heavier inbox.</dd>

          <dt><code>DASHBOARD_TLS_CERT</code> / <code>DASHBOARD_TLS_KEY</code></dt>
          <dd>Optional. Absolute paths to a PEM-encoded TLS cert +
            key. When both are set, the dashboard serves HTTPS
            directly \u2014 no reverse proxy needed. Required for any
            non-loopback redirect URI (see the
            <a href="#redirect-uri-rules">redirect URI rules</a>
            above). Generate the cert + key with
            <code>trustme</code> or <code>mkcert</code> (full
            commands above). Both vars must be set together; setting
            only one is a startup error.</dd>
        </dl>
      </section>
    </main>
    ${CLIPBOARD_SCRIPT_TAG}
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
    ${args.sync.showProgress ? renderSyncPoller(args.sync.accountId) : ''}
  </body>
</html>`
}

function renderConnectPrompt(): string {
  return `<section class="connect-prompt">
    <p class="lead">
      Connect a Gmail account to mirror your email into the dashboard.
      The dashboard requests <strong>read-only</strong> access \u2014 it
      cannot delete, archive, label, or send mail on your behalf.
    </p>
    <a class="primary-button" href="/api/email/oauth/start">
      <span class="gmail-icon" aria-hidden="true">\u2709</span>
      Connect Gmail
    </a>
    <p class="scope-note">
      Scope: <code>https://www.googleapis.com/auth/gmail.readonly</code>
    </p>
  </section>`
}

/** Top-of-page banner shown when email deps aren't fully configured.
 *  Lists every missing env var so the operator can copy them straight
 *  into their shell script / .env. */
function renderSetupRequiredBanner(missing: ReadonlyArray<string>): string {
  const items = missing
    .map((name) => `      <li><code>${escapeHtml(name)}</code></li>`)
    .join('\n')
  return `<section class="setup-required">
    <h2>\u26a0 Email slice not configured</h2>
    <p>
      The server started, but the email feature is not wired up yet.
      Set the following environment variables and restart the server:
    </p>
    <ul class="env-missing">
${items}
    </ul>
    <p>
      Need a fresh <code>EMAIL_TOKEN_ENCRYPTION_KEY</code>? Run
      <code>pnpm keygen</code> (or <code>openssl rand -hex 32</code>).
    </p>
    <p>
      Full setup walkthrough is below.
    </p>
  </section>`
}

/** Body of the page when in setup mode. Replaces the "Connect Gmail"
 *  prompt + account list with a clear note that the operator must
 *  configure the server first. */
function renderSetupModePrompt(): string {
  return `<section class="setup-mode-prompt">
    <p class="lead">
      The Gmail connection is unavailable because the server is missing
      required environment variables (see the banner above).
      The OAuth flow cannot start until the server is restarted with
      every required var in place.
    </p>
    <p class="muted">
      The rest of the dashboard \u2014 bookmarks, folders, tags, search,
      settings \u2014 keeps working while email is unconfigured.
    </p>
  </section>`
}

function renderAccountList(
  accounts: ReturnType<typeof listEmailAccounts>,
  statusInfo: RenderArgs['sync']['statusInfo'],
): string {
  const rows = accounts
    .map((a) => {
      const isThisAccountRunning =
        statusInfo !== null &&
        statusInfo.inProgress &&
        statusInfo.startedAt !== null
      const counts = isThisAccountRunning
        ? null
        : (statusInfo !== null && statusInfo.lastMessagesSynced > 0
            ? statusInfo
            : null)
      const lastSyncLine = a.lastSyncAt
        ? `Last sync ${escapeHtml(formatDate(a.lastSyncAt))}`
        : 'Never synced'
      const countsLine =
        counts !== null
          ? ` \u00b7 Added ${counts.lastAdded}, updated ${counts.lastUpdated}, removed ${counts.lastRemoved}`
          : ''
      return `
        <li class="account-row">
          <div class="account-info">
            <span class="gmail-icon" aria-hidden="true">\u2709</span>
            <div>
              <div class="account-email">${escapeHtml(a.emailAddress)}</div>
              <div class="account-meta">
                Connected ${escapeHtml(formatDate(a.connectedAt))}
                \u00b7 ${lastSyncLine}${countsLine}
              </div>
            </div>
          </div>
          <div class="account-actions">
            <form method="post" action="/settings/email/accounts/${escapeHtml(a.id)}/sync" class="refresh-form">
              <button type="submit" class="secondary-button">Refresh</button>
            </form>
            <form method="post" action="/settings/email/accounts/${escapeHtml(a.id)}/disconnect" class="disconnect-form">
              <button type="submit" class="danger-button">Disconnect</button>
            </form>
          </div>
        </li>`
    })
    .join('')
  const reconnect = accounts.length >= 1
    ? `<div class="reconnect">
         <a class="secondary-button" href="/api/email/oauth/start">
           + Connect another account
         </a>
       </div>`
    : ''
  return `<section class="account-list-section">
    <h2>Connected Gmail accounts</h2>
    <ul class="account-list">${rows}
    </ul>
    ${reconnect}
  </section>`
}

function renderSyncProgress(accountId: string): string {
  // Server-rendered placeholder shown while the page loads. The
  // poller below updates the body and turns the indicator off when
  // the sync is finished.
  return `<div class="sync-progress" id="sync-progress" data-account-id="${escapeHtml(accountId)}">
    <span class="sync-spinner" aria-hidden="true">\u21bb</span>
    <span class="sync-text">Syncing\u2026</span>
  </div>`
}

/** Tiny vanilla-JS poller. Runs after page load; pings the status
 *  endpoint once per second until `inProgress` flips to `false`,
 *  then reloads to /settings/email?status=synced so the post-sync
 *  banner + counts render. */
function renderSyncPoller(accountId: string): string {
  return `<script>
(function() {
  var el = document.getElementById('sync-progress');
  if (!el) return;
  var accountId = ${JSON.stringify(accountId)};
  var tick = function() {
    fetch('/api/email/accounts/' + encodeURIComponent(accountId) + '/status', { credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.inProgress) {
          window.location.href = '/settings/email';
        } else {
          setTimeout(tick, 1000);
        }
      })
      .catch(function() { setTimeout(tick, 2000); });
  };
  // Trigger the actual sync by POSTing to the JSON API on page
  // load — the form post above already redirected here.
  fetch('/api/email/sync?account_id=' + encodeURIComponent(accountId), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'accept': 'application/json' },
  })
    .then(function() { tick(); })
    .catch(function() { tick(); });
})();
</script>`
}

function renderFlash(flash: Flash): string {
  return `<div class="flash flash-${escapeHtml(flash.kind)}" role="status">
    <span class="flash-icon" aria-hidden="true">${
      flash.kind === 'error' || flash.kind === 'already_running'
        ? '\u26a0'
        : '\u2713'
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
  /* Scoped styles for the email settings page. Inherits CSS variables
   * (--text, --muted, --surface, --border, --accent, --danger, --success)
   * from /static/styles.css so the page renders correctly under both
   * light and dark themes. Hardcoded hex values are only used for
   * subtle accents that need a specific hue in each mode — those are
   * defined via the same theme tokens. */
  .email-settings-main { max-width: 56rem; margin: 0 auto; padding: 0 1rem; color: var(--text); }
  .email-settings-main h1 { font-weight: 600; }
  .email-settings-main h2 { font-weight: 600; margin-top: 2.5rem; color: var(--text); }
  .email-settings-main nav.breadcrumb { font-size: 0.9rem; margin-bottom: 1rem; }
  .email-settings-main nav.breadcrumb a { color: var(--accent); text-decoration: none; }
  .email-settings-main nav.breadcrumb a:hover { text-decoration: underline; }
  .email-settings-main .lead { color: var(--muted); line-height: 1.5; max-width: 36rem; }
  .email-settings-main .muted { color: var(--muted); }
  .email-settings-main .scope-note { color: var(--muted); font-size: 0.85rem; margin-top: 0.5rem; }

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
  .gmail-icon { font-size: 1.1rem; line-height: 1; }

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
  .disconnect-form { margin: 0; }
  .account-actions { display: flex; gap: 0.5rem; align-items: center; }
  .refresh-form { margin: 0; }
  .reconnect { margin-top: 1rem; }

  /* ─── Setup-required banner (issue #021 follow-up) ───────────────── */
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

  .sync-progress {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.8rem 1rem; border-radius: 0.3rem; margin: 1rem 0;
    background: var(--accent-dim); color: var(--text); border: 1px solid var(--accent);
  }
  .sync-spinner {
    display: inline-block;
    animation: spin 1.2s linear infinite;
    font-size: 1.1rem;
  }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .sync-text { font-weight: 500; }

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
`
