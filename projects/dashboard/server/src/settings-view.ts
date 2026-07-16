import type { Context } from 'hono'
import type { CreateTokenResult, TokenRecord, TokenStore } from './token-store.js'
import { COMMON_HEAD, THEME_SCRIPT_TAG, CLIPBOARD_SCRIPT_TAG, HAMBURGER_SCRIPT_TAG, renderHeader } from './view-shared.js'

export interface SettingsView {
  list(c: Context): Promise<Response>
  createToken(c: Context): Promise<Response>
  revokeFromUi(c: Context): Promise<Response>
}

/**
 * Server-rendered HTML for /settings. Three routes:
 *
 *   GET  /settings                  — list tokens + generate form
 *   POST /settings/tokens           — create a token, render plaintext once
 *   POST /settings/tokens/:id/revoke — revoke from UI, redirect to /settings
 *
 * Browser caches Basic credentials per realm, so the form POSTs pick up
 * the Authorization header automatically — no JS needed.
 */
export function settingsView(store: TokenStore): SettingsView {
  return {
    async list(c) {
      const tokens = await store.list()
      return c.html(renderPage(tokens, null))
    },

    async createToken(c) {
      const body = (await c.req.parseBody()) as { label?: unknown }
      const label = sanitizeLabel(body.label)
      const result = await store.create(label)
      // Render the same page but with the plaintext visible. The list
      // itself is empty here because the user is about to be redirected
      // back via the link; the focus is "copy this token now".
      return c.html(renderPage([], result))
    },

    async revokeFromUi(c) {
      const { id } = c.req.param()
      if (!id) return c.redirect('/settings')
      // Idempotent: silently ignore unknown ids from the UI (could happen
      // if another tab just revoked the same token).
      await store.revoke(id)
      return c.redirect('/settings')
    },
  }
}

function renderPage(
  tokens: readonly TokenRecord[],
  justCreated: CreateTokenResult | null,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Dashboard — Settings</title>
  </head>
  <body>
    ${renderHeader({ showSearch: false, showSidebarToggle: false })}
    <main class="settings-main">
      <header class="page-heading">
        <span class="page-eyebrow">Dashboard</span>
        <h1>Settings</h1>
        <p>Manage integrations, access tokens, and connected services.</p>
      </header>
      <nav class="settings-tabs" aria-label="Settings sections">
        <a href="/settings" class="settings-tab settings-tab-active" aria-current="page">API tokens</a>
        <a href="/settings/email">Email</a>
        <a href="/settings/youtube" class="settings-tab">YouTube</a>
        <a href="/settings/ai" class="settings-tab">AI &amp; Research</a>
      </nav>

    ${justCreated ? renderPlaintextOnce(justCreated) : ''}

    <section class="settings-panel">
      <div class="settings-panel-heading">
        <div>
          <h2>API tokens</h2>
          <p>Tokens let browser extensions and trusted clients sync with this dashboard.</p>
        </div>
      </div>
      <form method="post" action="/settings/tokens" class="token-create-form">
        <label>
          <span>Token label</span>
          <input type="text" name="label" placeholder="Chrome extension — home desktop" maxlength="100" />
        </label>
        <button type="submit" class="button button-primary">Generate token</button>
      </form>
      ${tokens.length === 0
        ? '<div class="settings-empty"><p>No tokens yet.</p><span>Generate one above to connect the Chrome extension.</span></div>'
        : renderTokenList(tokens)}
    </section>
    ${CLIPBOARD_SCRIPT_TAG}
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
    </main>
  </body>
</html>`
}

function renderPlaintextOnce(result: CreateTokenResult): string {
  return `<div class="plaintext" role="status">
      <div><strong>New token created</strong><p>Copy it now — it will not be shown again.</p></div>
      <span class="plaintext-label">${escapeHtml(result.record.label)}</span>
      <div class="plaintext-value"><code>${escapeHtml(result.plaintext)}</code>
        <button type="button" class="button button-secondary" data-action="copy" data-url="${escapeHtml(result.plaintext)}">Copy token</button>
      </div>
    </div>`
}

function renderTokenList(tokens: readonly TokenRecord[]): string {
  const rows = tokens
    .map(
      (t) => `<tr>
      <td>${escapeHtml(t.label)}</td>
      <td><code>${escapeHtml(t.id)}</code></td>
      <td>${escapeHtml(formatDate(t.createdAt))}</td>
      <td>${t.lastUsedAt ? escapeHtml(formatDate(t.lastUsedAt)) : '<em class="empty">never</em>'}</td>
      <td>
        <form method="post" action="/settings/tokens/${escapeHtml(t.id)}/revoke" class="revoke-form">
          <button type="submit" class="button button-danger">Revoke</button>
        </form>
      </td>
    </tr>`,
    )
    .join('')
  return `<div class="settings-table-wrap"><table class="settings-table">
    <thead>
      <tr><th>Label</th><th>ID</th><th>Created</th><th>Last used</th><th></th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function formatDate(iso: string): string {
  // Local date+time, no seconds — readable in the table.
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sanitizeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'Untitled'
  const trimmed = value.trim().slice(0, 100)
  return trimmed.length > 0 ? trimmed : 'Untitled'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
