// email-differ.test.ts — issue #021
//
// Unit tests for the pure differ deep module. Side-effect free; only
// the inputs + DbState shape. Mirrors bookmark-differ.test.ts.

import { describe, expect, it } from 'vitest'
import { diff, readDbState, type DbEmailState, type DbState } from './email-differ.js'
import type { RawEmail, RawEmailAddress } from './gmail-client.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────

function address(name: string | null, email: string): RawEmailAddress {
  return { name, email }
}

function email(overrides: Partial<RawEmail> = {}): RawEmail {
  return {
    id: 'msg-1',
    threadId: 't-1',
    internalDate: '2024-01-01T12:00:00.000Z',
    snippet: 'snippet 1',
    subject: 'Subject 1',
    from: address('Alice', 'alice@example.com'),
    to: [address('Bob', 'bob@example.com')],
    cc: [],
    bodyPlain: 'Hello, world.',
    labels: ['INBOX'],
    isUnread: true,
    ...overrides,
  }
}

function dbEmail(overrides: Partial<DbEmailState> = {}): DbEmailState {
  return {
    id: 'msg-1',
    threadId: 't-1',
    subject: 'Subject 1',
    sender: 'Alice <alice@example.com>',
    senderEmail: 'alice@example.com',
    toAddrs: ['bob@example.com'],
    ccAddrs: [],
    receivedAt: '2024-01-01T12:00:00.000Z',
    snippet: 'snippet 1',
    bodyPlain: 'Hello, world.',
    isUnread: true,
    labels: ['INBOX'],
    ...overrides,
  }
}

function dbFrom(rows: DbEmailState[]): DbState {
  return { emails: new Map(rows.map((r) => [r.id, r])) }
}

// ─── No-op ────────────────────────────────────────────────────────────────

describe('diff — no-op', () => {
  it('returns 0 upserts + 0 removes when incoming matches DB exactly', () => {
    const e = email()
    const d = diff([e], dbFrom([dbEmail({ id: e.id })]))
    expect(d.upserts).toEqual([])
    expect(d.removes).toEqual([])
    expect(d.matchedIds).toEqual([e.id])
  })

  it('handles empty incoming + empty DB', () => {
    const d = diff([], dbFrom([]))
    expect(d).toEqual({ upserts: [], removes: [], matchedIds: [] })
  })

  it('emits removes but no upserts when incoming is empty (all DB ids are deletes)', () => {
    const d = diff([], dbFrom([dbEmail({ id: 'm1' }), dbEmail({ id: 'm2' })]))
    expect(d.upserts).toEqual([])
    expect([...d.removes].sort()).toEqual(['m1', 'm2'])
    expect(d.matchedIds).toEqual([])
  })
})

// ─── Adds ─────────────────────────────────────────────────────────────────

describe('diff — pure adds', () => {
  it('emits upsert for an incoming id not in DB', () => {
    const e = email({ id: 'new-1' })
    const d = diff([e], dbFrom([]))
    expect(d.upserts).toEqual([e])
    expect(d.removes).toEqual([])
    expect(d.matchedIds).toEqual([])
  })

  it('emits upserts for multiple incoming ids not in DB', () => {
    const e1 = email({ id: 'new-1' })
    const e2 = email({ id: 'new-2', subject: 'Hi' })
    const d = diff([e1, e2], dbFrom([]))
    expect(d.upserts).toEqual([e1, e2])
    expect(d.removes).toEqual([])
  })
})

// ─── Updates ──────────────────────────────────────────────────────────────

describe('diff — pure updates', () => {
  it('emits upsert when subject changes', () => {
    const incoming = email({ subject: 'New subject' })
    const d = diff([incoming], dbFrom([dbEmail({ subject: 'Old subject' })]))
    expect(d.upserts).toEqual([incoming])
    expect(d.matchedIds).toEqual([])
  })

  it('emits upsert when sender name changes', () => {
    const incoming = email({ from: address('Alice II', 'alice@example.com') })
    const d = diff([incoming], dbFrom([]))
    expect(d.upserts).toEqual([incoming])
  })

  it('emits upsert when body changes', () => {
    const incoming = email({ bodyPlain: 'new body' })
    const d = diff([incoming], dbFrom([dbEmail({ bodyPlain: 'old body' })]))
    expect(d.upserts).toEqual([incoming])
  })

  it('emits upsert when labels change', () => {
    const incoming = email({ labels: ['INBOX', 'STARRED'] })
    const d = diff(
      [incoming],
      dbFrom([dbEmail({ labels: ['INBOX'] })]),
    )
    expect(d.upserts).toEqual([incoming])
  })

  it('emits upsert when isUnread toggles', () => {
    const incoming = email({ isUnread: false })
    const d = diff([incoming], dbFrom([dbEmail({ isUnread: true })]))
    expect(d.upserts).toEqual([incoming])
  })

  it('emits upsert when recipients change', () => {
    const incoming = email({ to: [address('Carol', 'carol@example.com')] })
    const d = diff(
      [incoming],
      dbFrom([dbEmail({ toAddrs: ['bob@example.com'] })]),
    )
    expect(d.upserts).toEqual([incoming])
  })
})

// ─── Removes ──────────────────────────────────────────────────────────────

describe('diff — pure removes', () => {
  it('emits remove for a DB id not in incoming', () => {
    const d = diff([], dbFrom([dbEmail({ id: 'gone' })]))
    expect(d.removes).toEqual(['gone'])
  })

  it('emits removes for multiple DB ids not in incoming', () => {
    const d = diff(
      [email({ id: 'keep' })],
      dbFrom([
        dbEmail({ id: 'keep' }),
        dbEmail({ id: 'gone-1' }),
        dbEmail({ id: 'gone-2' }),
      ]),
    )
    expect([...d.removes].sort()).toEqual(['gone-1', 'gone-2'])
  })
})

// ─── Mixed ────────────────────────────────────────────────────────────────

describe('diff — mixed adds / updates / removes', () => {
  it('classifies each incoming id correctly (new / updated / matched)', () => {
    const sameMsg = email({ id: 'm-same' })
    const updatedMsg = email({ id: 'm-upd', bodyPlain: 'updated body' })
    const newMsg = email({ id: 'm-new', subject: 'new one' })

    const d = diff(
      [sameMsg, updatedMsg, newMsg],
      dbFrom([
        dbEmail({ id: 'm-same' }),
        dbEmail({ id: 'm-upd', bodyPlain: 'old body' }),
        dbEmail({ id: 'm-deleted' }), // will appear in removes
      ]),
    )

    expect(d.matchedIds).toEqual(['m-same'])
    expect(d.upserts.map((u) => u.id).sort()).toEqual(['m-new', 'm-upd'])
    expect(d.removes).toEqual(['m-deleted'])
  })
})

// ─── readDbState ─────────────────────────────────────────────────────────

describe('readDbState', () => {
  it('decodes JSON-encoded label / address columns safely', () => {
    // Minimal in-memory mock of the Database wrapper's `all`.
    const db = {
      all: () => [
        {
          id: 'a',
          thread_id: 't',
          subject: 's',
          sender: 'Sender <sender@x.com>',
          sender_email: 'sender@x.com',
          to_addrs: JSON.stringify(['one@x.com', 'two@x.com']),
          cc_addrs: JSON.stringify([]),
          received_at: '2024-01-01T00:00:00.000Z',
          snippet: '',
          body_plain: '',
          is_unread: 1,
          labels: JSON.stringify(['INBOX', 'STARRED']),
        },
      ],
    }
    const state = readDbState(db as unknown as Parameters<typeof readDbState>[0])
    expect(state.emails.size).toBe(1)
    const row = state.emails.get('a')!
    expect(row.toAddrs).toEqual(['one@x.com', 'two@x.com'])
    expect(row.labels).toEqual(['INBOX', 'STARRED'])
    expect(row.isUnread).toBe(true)
  })

  it('falls back to empty arrays for malformed JSON columns', () => {
    const db = {
      all: () => [
        {
          id: 'a',
          thread_id: 't',
          subject: 's',
          sender: '',
          sender_email: '',
          to_addrs: 'not-json',
          cc_addrs: 'also-not-json',
          received_at: '2024-01-01T00:00:00.000Z',
          snippet: '',
          body_plain: '',
          is_unread: 0,
          labels: 'still-not-json',
        },
      ],
    }
    const state = readDbState(db as unknown as Parameters<typeof readDbState>[0])
    const row = state.emails.get('a')!
    expect(row.toAddrs).toEqual([])
    expect(row.ccAddrs).toEqual([])
    expect(row.labels).toEqual([])
  })
})
