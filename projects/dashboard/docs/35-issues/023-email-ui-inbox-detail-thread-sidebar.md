# 023 — Email UI: /email inbox + /email/:id detail + /email/thread + filters + sidebar nav

**Labels**: `email`, `v4`, `needs-triage`
**Type**: AFK
**Parent**: [PRD-002](../35-prds/PRD-002-email-mirror.md)

## What to build

Email gets first-class production routes from day one. The sidebar gains an "Email" entry linking to `/email`, which renders the chronological inbox with working filters (provider, label, unread, sender). Clicking an email opens `/email/:id` showing full body, sender, recipients, date, and thread context, plus action buttons (Hide, Tag, Summarize — these are placeholders until later slices; clicking them shows "coming soon" or is wired through to the eventual API). Thread view at `/email/thread/:threadId` shows all messages in a conversation, chronological. The hardcoded email fixture in `/preview/v2` is removed (other compartments in that page are untouched).

## Acceptance criteria

- [ ] `/email` renders the inbox as a server-side HTML list, sorted by `received_at DESC`
- [ ] Filters on `/email`: provider (Gmail only in v1), label (Inbox / Sent / Starred / custom), unread toggle, sender substring — all wired to `GET /api/email`
- [ ] Each inbox row links to `/email/:id` and shows sender, subject, snippet, relative time, unread indicator
- [ ] `/email/:id` shows: subject, sender, recipients (to + cc), date received, plain-text body, thread context (link to `/email/thread/:threadId`), and action buttons: Hide, Tag, Summarize (the latter three are visual placeholders; their wiring lands in 024, 025, 027)
- [ ] `/email/thread/:threadId` shows all thread messages in chronological order, each linking to `/email/:id`
- [ ] Sidebar nav gains an "Email" entry linking to `/email` (matches the existing sidebar styling from the styling pass — slice 013)
- [ ] The hardcoded email fixture (10 sample Gmail/Outlook messages) in `/preview/v2` is removed; the email tab is removed from the preview compartments list (other compartments — bookmarks, YouTube saves, YouTube history, projects — are unchanged)
- [ ] `/email` page loads <500ms with 1000 emails (smoke check)
- [ ] Tests: view rendering with fixtures, filter combinations (provider/label/unread/sender), navigation between inbox → detail → thread, sidebar nav presence, `/preview/v2` no longer renders email compartment

## Blocked by

- [022](./022-email-read-api-querybuilder-searcher-retriever.md)