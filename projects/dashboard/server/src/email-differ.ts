// email-differ.ts — issue #021
//
// Pure deep module that computes the minimal set of CRUD ops needed
// to bring the `emails` mirror in line with an incoming set of Gmail
// messages.
//
// Responsibilities (and ONLY these):
//   - Compare an incoming set of RawEmail (typically the full fetched
//     set from a sync run) against a DbState snapshot.
//   - Emit `{upserts, removes, matchedIds}` so the worker knows what
//     to write (UPSERT), what to delete (DELETE), and what was a
//     no-op (purely for telemetry / counts).
//
// NOT responsible for:
//   - DB reads (caller provides DbState via readDbState()).
//   - DB writes (email-sync-worker.ts does that in a transaction).
//   - HTTP serialization (email-sync.ts does that).
//   - Pagination (the worker drives the page loop and accumulates
//     the full incoming set before calling the differ once).
//   - The `hidden_at` column arriving in #024: the UPSERT issued by
//     the worker explicitly omits any local-state columns, so this
//     file and the worker don't need a code change when that column
//     lands. The "preserves protected columns" test in the worker
//     suite exercises this guarantee even today.
//
// Why a separate module from the worker:
//   - Pure, side-effect free; testing requires only the inputs.
//   - Reusable for future endpoints (e.g., a "dry-run sync" debug
//     endpoint) without dragging the DB or the GmailClient.
//   - Mirrors the #006 pattern: BookmarkDiffer (compute) +
//     sync.ts (apply) → here: EmailDiffer + email-sync-worker.

import type { RawEmail } from './gmail-client.js'

// ─── DbState (caller provides this) ───────────────────────────────────────

/**
 * One email as it currently exists in the DB. The differ only needs
 * the fields that come from Gmail; local-state columns (e.g.
 * `hidden_at` arriving in #024) are not tracked here on purpose —
 * the UPSERT preserves them via the worker's explicit column list.
 */
export interface DbEmailState {
  readonly id: string
  readonly threadId: string
  readonly subject: string
  readonly sender: string
  readonly senderEmail: string
  readonly toAddrs: readonly string[]
  readonly ccAddrs: readonly string[]
  readonly receivedAt: string
  readonly snippet: string
  readonly bodyPlain: string
  readonly isUnread: boolean
  readonly labels: readonly string[]
}

/**
 * Snapshot of the DB state relevant to a sync. Caller builds this
 * via `readDbState(db)` once per decision point.
 */
export interface DbState {
  readonly emails: ReadonlyMap<string, DbEmailState>
}

// ─── Result ───────────────────────────────────────────────────────────────

/**
 * Pure describe-result of the diff.
 *
 *  * `upserts`  — full RawEmail records to write. The worker turns
 *    these into INSERT ... ON CONFLICT(id) DO UPDATE statements; the
 *    "minimal" guarantee comes from the differ skipping any incoming
 *    email whose DB row already matches (`matchedIds`).
 *  * `removes`  — Gmail ids to DELETE (no longer present in Gmail).
 *  * `matchedIds` — Gmail ids seen in both incoming and DB with no
 *    field changes; surfaces as zero-writes in the worker's run
 *    and in the "messagesSynced" tally.
 */
export interface DiffResult {
  readonly upserts: readonly RawEmail[]
  readonly removes: readonly string[]
  readonly matchedIds: readonly string[]
}

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * Thrown when the diff encounters something it can't reconcile. Today
 * the differ doesn't throw — every case falls into a "treat as
 * upsert/delete" bucket. The class exists for forward compatibility:
 * if Gmail ever returns a malformed message that breaks the
 * `emailChanged` heuristic in some way that requires a human decision,
 * the differ will throw here and the route will surface HTTP 400.
 */
export class DiffError extends Error {
  public readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'DiffError'
    this.code = code
  }
}

// ─── Differ ───────────────────────────────────────────────────────────────

/**
 * Compute the minimal CRUD ops to reconcile `incoming` (a set of Gmail
 * messages) against `dbState` (the mirror's current row set, keyed by
 * Gmail id).
 *
 * Algorithm:
 *   1. For each incoming email:
 *        - If not in DB → upsert (it's new).
 *        - If in DB but any tracked field differs → upsert (it changed).
 *        - Otherwise → matchedIds (no write).
 *   2. For each DB id not in incoming → remove (deleted in Gmail).
 *
 * Tracked fields are the per-message data from Gmail (subject,
 * sender, recipients, body, snippet, labels, unread flag, thread).
 * Local-state columns (added by future slices) are NOT compared —
 * the UPSERT explicitly excludes them, so any change there is
 * preserved automatically.
 *
 * Complexity: O(N) where N = max(|incoming|, |dbState|).
 */
export function diff(
  incoming: readonly RawEmail[],
  dbState: DbState,
): DiffResult {
  const incomingIds = new Set<string>()
  const upserts: RawEmail[] = []
  const matchedIds: string[] = []

  for (const email of incoming) {
    incomingIds.add(email.id)
    const dbRow = dbState.emails.get(email.id)

    if (!dbRow) {
      upserts.push(email)
      continue
    }

    if (emailChanged(dbRow, email)) {
      upserts.push(email)
    } else {
      matchedIds.push(email.id)
    }
  }

  const removes: string[] = []
  for (const [id] of dbState.emails) {
    if (!incomingIds.has(id)) removes.push(id)
  }

  return { upserts, removes, matchedIds }
}

// ─── Field-by-field comparison ───────────────────────────────────────────

/**
 * True iff any field coming from Gmail has changed. We re-derive the
 * `sender` rendering here so the column stored in `emails.sender`
 * matches the column shape written by the worker (they must agree).
 *
 * `receivedAt` is Gmail's `internalDate`; it's invariant for a given
 * message id and shouldn't change between syncs, but we compare it
 * defensively in case Gmail ever surfaces a metadata edit.
 */
function emailChanged(db: DbEmailState, incoming: RawEmail): boolean {
  if (db.subject !== incoming.subject) return true
  if (db.sender !== formatSender(incoming.from)) return true
  if (db.senderEmail !== (incoming.from?.email ?? '')) return true
  if (!arrayEq(db.toAddrs, incoming.to.map((a) => a.email))) return true
  if (!arrayEq(db.ccAddrs, incoming.cc.map((a) => a.email))) return true
  if (db.snippet !== incoming.snippet) return true
  if (db.bodyPlain !== incoming.bodyPlain) return true
  if (db.isUnread !== incoming.isUnread) return true
  if (!arrayEq(db.labels, [...incoming.labels])) return true
  if (db.threadId !== incoming.threadId) return true
  if (db.receivedAt !== incoming.internalDate) return true
  return false
}

function formatSender(from: RawEmail['from']): string {
  if (!from) return ''
  return from.name ? `${from.name} <${from.email}>` : from.email
}

function arrayEq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ─── DB state reading ─────────────────────────────────────────────────────

/**
 * Read the current `emails` table into a `DbState` snapshot.
 * Synchronous (better-sqlite3 is sync). Used by the sync worker
 * before calling the differ.
 *
 * Exported so tests and future debug endpoints can build a DbState
 * directly without going through the worker.
 */
export function readDbState(db: {
  all<T>(sql: string, params?: readonly unknown[]): T[]
}): DbState {
  const rows = db.all<{
    id: string
    thread_id: string
    subject: string
    sender: string
    sender_email: string
    to_addrs: string
    cc_addrs: string
    received_at: string
    snippet: string
    body_plain: string
    is_unread: number | bigint
    labels: string
  }>(`SELECT id, thread_id, subject, sender, sender_email,
                to_addrs, cc_addrs, received_at, snippet,
                body_plain, is_unread, labels
           FROM emails`)
  const emails = new Map<string, DbEmailState>()
  for (const r of rows) {
    emails.set(r.id, {
      id: r.id,
      threadId: r.thread_id,
      subject: r.subject,
      sender: r.sender,
      senderEmail: r.sender_email,
      toAddrs: parseJsonArray(r.to_addrs),
      ccAddrs: parseJsonArray(r.cc_addrs),
      receivedAt: r.received_at,
      snippet: r.snippet,
      bodyPlain: r.body_plain,
      isUnread: !!r.is_unread,
      labels: parseJsonArray(r.labels),
    })
  }
  return { emails }
}

function parseJsonArray(s: string): readonly string[] {
  // Defensive parsing — accept anything that JSON-decodes to a
  // string[]; fall back to empty on garbage so a corrupted row
  // doesn't crash the differ.
  try {
    const parsed: unknown = JSON.parse(s)
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    // Fall through.
  }
  return []
}
