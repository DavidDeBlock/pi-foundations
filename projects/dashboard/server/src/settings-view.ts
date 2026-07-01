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
    <style>
      body { font-family: system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
      h1 { font-weight: 500; }
      h2 { font-weight: 500; margin-top: 2rem; }
      h3 { font-weight: 500; margin-top: 2rem; }
      nav a { margin-right: 1rem; color: #06c; }
      table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
      th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #eee; vertical-align: middle; }
      th { font-weight: 500; color: #666; font-size: 0.9rem; }
      code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }
      .plaintext { background: #fffbe6; border: 1px solid #f0c000; padding: 1rem; margin: 1rem 0; }
      .plaintext code { background: transparent; padding: 0; font-size: 0.95rem; word-break: break-all; }
      form { margin: 1rem 0; }
      input[type="text"] { padding: 0.4rem; width: 20rem; max-width: 100%; }
      button { padding: 0.4rem 0.8rem; cursor: pointer; }
      .revoke-form { display: inline; margin: 0; }
      .empty { color: #888; }
    </style>
  </head>
  <body>
    ${renderHeader({ showSearch: false })}
    <main class="settings-main">
      <h1>Settings</h1>
    <nav>
      <a href="/">Home</a>
      <a href="/settings">Settings</a>
      <a href="/settings/email">Email</a>
    </nav>

    ${justCreated ? renderPlaintextOnce(justCreated) : ''}

    <h2>API tokens</h2>
    ${tokens.length === 0
      ? '<p class="empty">No tokens yet. Generate one to use with the Chrome extension.</p>'
      : renderTokenList(tokens)}

    <h3>Generate new token</h3>
    <form method="post" action="/settings/tokens">
      <input type="text" name="label" placeholder="Label (e.g. 'Chrome extension — home desktop')" maxlength="100" />
      <button type="submit">Generate</button>
    </form>
    ${CLIPBOARD_SCRIPT_TAG}
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
    </main>
  </body>
</html>`
}

function renderPlaintextOnce(result: CreateTokenResult): string {
  return `<div class="plaintext">
      <strong>New token created.</strong> Copy it now — you will not see it again.
      <p>Label: <em>${escapeHtml(result.record.label)}</em></p>
      <p><code>${escapeHtml(result.plaintext)}</code></p>
      <p><a href="/settings">← Back to settings</a></p>
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
          <button type="submit">Revoke</button>
        </form>
      </td>
    </tr>`,
    )
    .join('')
  return `<table>
    <thead>
      <tr><th>Label</th><th>ID</th><th>Created</th><th>Last used</th><th></th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`
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
