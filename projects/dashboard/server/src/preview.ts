// preview.ts — v2 visual preview
//
// Live HTML mockup of the dashboard's future state (Bookmarks +
// YouTube + Projects + Email compartments). Served at /preview/v2,
// auth-gated like the rest of the dashboard. Single server-rendered
// HTML page with client-side tab switching between compartments.
//
// This module is the visual artifact from the design grill — it does
// not implement any of the v2 features. Fixture data is hardcoded,
// there is no DB read, no real folder tree, no real project state.
// The point is to show the layout and information architecture
// before any of those features are built.
//
// NOT responsible for:
//   - Real v2 functionality (those come in their own slices)
//   - Auth (handled by middleware in app.ts)
//   - Persistence (every request rebuilds the page from fixtures)

import type { Context } from 'hono'
import {
  COMMON_HEAD,
  THEME_SCRIPT_TAG,
  HAMBURGER_SCRIPT_TAG,
  renderHeader,
} from './view-shared.js'

export function previewV2Page(_c: Context): Response {
  const html = renderPage()
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

// ─── Compartments ─────────────────────────────────────────────────────────

type CompartmentId = 'bookmarks' | 'youtube-saves' | 'youtube-history' | 'projects' | 'email' | 'today'

interface CompartmentDef {
  readonly id: CompartmentId
  readonly icon: string
  readonly label: string
  /** When false, the sidebar's folder tree is hidden for this compartment. */
  readonly showFolderTree: boolean
}

const COMPARTMENTS: readonly CompartmentDef[] = [
  { id: 'bookmarks',       icon: '▣', label: 'Bookmarks',          showFolderTree: true  },
  { id: 'youtube-saves',   icon: '▶', label: 'YouTube — Saves',    showFolderTree: true  },
  { id: 'youtube-history', icon: '◷', label: 'YouTube — History',  showFolderTree: false },
  { id: 'projects',        icon: '▤', label: 'Projects',           showFolderTree: false },
  { id: 'email',           icon: '✉', label: 'Email',              showFolderTree: false },
  { id: 'today',           icon: '◐', label: 'Today',              showFolderTree: false },
]

// Today compartment has its own inner tab strip with 3 sub-views.
// "Today" is the default landing of the compartment (daily check-in).
type TodaySubViewId = 'today' | 'this-week' | 'all-tasks'

const TODAY_SUBVIEWS: readonly { id: TodaySubViewId; label: string }[] = [
  { id: 'today',     label: 'Today' },
  { id: 'this-week', label: 'This week' },
  { id: 'all-tasks', label: 'All tasks' },
]

// ─── Fixtures ─────────────────────────────────────────────────────────────

interface BookmarkFixture {
  readonly title: string
  readonly url: string
  readonly folder: string
  readonly tags: readonly string[]
}

const BOOKMARKS: readonly BookmarkFixture[] = [
  { title: 'How to use SQLite FTS5 for full-text search',        url: 'https://sqlite.org/fts5.html',          folder: 'Tech/Backend/Databases', tags: ['sql', 'reference'] },
  { title: 'Pixel Poesy — Latest generative drop',               url: 'https://pixelpoesy.dev/feed',           folder: 'Art/Generative',          tags: ['inspiration'] },
  { title: 'Hacker News — Frontpage',                            url: 'https://news.ycombinator.com/',         folder: 'News/Tech',               tags: ['news', 'daily'] },
  { title: 'Recipe: Cast Iron Pizza',                            url: 'https://seriouseats.com/cast-iron-pizza', folder: 'Personal/Cooking',       tags: ['cast-iron', 'pizza'] },
  { title: 'Pi-POS project tracker',                             url: 'https://github.com/david/pi-pos',       folder: 'Projects/Pi-POS',         tags: ['pos', 'wip'] },
  { title: 'Daily journaling — what worked',                     url: 'https://example.com/journaling',         folder: 'Personal/Journal',        tags: ['habits'] },
]

interface YouTubeSaveFixture {
  readonly title: string
  readonly channel: string
  readonly folder: string
  readonly tags: readonly string[]
}

const YOUTUBE_SAVES: readonly YouTubeSaveFixture[] = [
  { title: 'Designing Data-Intensive Applications — Ch. 5 talk', channel: 'Conf Talks',  folder: 'Tech/Backend/Reading',  tags: ['ddia', 'reference'] },
  { title: 'Hikaru Nakamura plays 1.b3 — annotated',            channel: 'GothamChess', folder: 'Chess/Notable Games',  tags: ['chess', 'gm-game'] },
  { title: 'Lo-fi hip hop radio — beats to relax/study to',     channel: 'Lofi Girl',    folder: 'Music/Background',     tags: ['lofi', 'study'] },
  { title: 'Postgres performance for humans',                   channel: 'pganalyze',   folder: 'Tech/Backend/Databases', tags: ['sql', 'reference'] },
  { title: 'Veritasium — Are golf ball dimples actually useful?', channel: 'Veritasium', folder: 'Science/Curious',     tags: ['physics', 'fun'] },
  { title: 'Tom Scott — How to read a UK road sign',            channel: 'Tom Scott',   folder: 'Education/UK',         tags: ['uk', 'culture'] },
]

interface YouTubeHistoryFixture {
  readonly title: string
  readonly channel: string
  readonly relativeTime: string
  readonly isSaved: boolean
}

const YOUTUBE_HISTORY: readonly YouTubeHistoryFixture[] = [
  { title: 'Cooking with cast iron — beginner mistakes',   channel: 'Kitchen Atlas',  relativeTime: '12 min ago', isSaved: true },
  { title: 'Lo-fi hip hop radio',                          channel: 'Lofi Girl',       relativeTime: '1 hour ago', isSaved: true },
  { title: 'React Server Components explained',            channel: 'Vercel',          relativeTime: '3 hours ago', isSaved: false },
  { title: 'Git undo: reflog basics',                      channel: 'ThePrimeagen',    relativeTime: 'yesterday', isSaved: false },
  { title: 'How to clean a kitchen properly',              channel: 'Sorted Food',     relativeTime: '2 days ago', isSaved: false },
  { title: 'Why is the sky blue?',                         channel: 'Physics Girl',    relativeTime: '3 days ago', isSaved: false },
  { title: 'Funniest moments in chess',                    channel: 'Agadmator',       relativeTime: '1 week ago', isSaved: false },
  { title: 'Improving at League — wave management',        channel: 'ProGuides',       relativeTime: '2 weeks ago', isSaved: false },
]

type ProjectStatus = 'running' | 'stopped' | 'starting' | 'errored'

interface ProjectFixture {
  readonly name: string
  readonly description: string
  readonly category: string
  readonly status: ProjectStatus
  readonly port: number | null
  readonly uptime: string | null
}

const PROJECTS: readonly ProjectFixture[] = [
  { name: 'Cozy Ledger',  description: 'Personal finance app',          category: 'dev-servers', status: 'running', port: 3001, uptime: '4h 12m' },
  { name: 'MTGA Logs',    description: 'MTG Arena log parser',           category: 'dev-servers', status: 'running', port: 4000, uptime: '1d 3h' },
  { name: 'Pi-POS',       description: 'Point-of-sale system',           category: 'services',    status: 'running', port: 3000, uptime: '12d 5h' },
  { name: 'a4-math',      description: 'Math problem-set app',           category: 'experiments', status: 'stopped', port: null,  uptime: null },
  { name: 'Pixel Poesy',  description: 'Generative pixel-art studio',    category: 'experiments', status: 'stopped', port: null,  uptime: null },
]

interface EmailFixture {
  readonly sender: string
  readonly senderEmail: string
  readonly subject: string
  readonly snippet: string
  readonly relativeTime: string
  readonly provider: 'gmail' | 'outlook'
  readonly unread: boolean
}

const EMAILS: readonly EmailFixture[] = [
  { sender: 'John Smith',     senderEmail: 'john@example.com',         subject: 'Q3 report — please review attached',     snippet: 'Hi David, attached is the Q3 financial report. Please flag any concerns by…', relativeTime: '10:34 AM', provider: 'gmail',   unread: true  },
  { sender: 'GitHub',         senderEmail: 'noreply@github.com',       subject: 'david/pi-foundations#42 — review requested', snippet: 'A new pull request needs your review: Add TypeScript types to the…',           relativeTime: '9:15 AM',  provider: 'gmail',   unread: true  },
  { sender: 'Hacker News',    senderEmail: 'reply@news.ycombinator.com', subject: 'Daily digest — top stories',           snippet: 'Today\'s top stories: "Why SQLite won", "The decline of the mid-range…',     relativeTime: '8:00 AM',  provider: 'gmail',   unread: false },
  { sender: 'Figma',          senderEmail: 'no-reply@figma.com',       subject: 'Your team commented on "Dashboard v2"',   snippet: 'Sarah left 3 comments on the "Dashboard v2" file. Click here to view…',      relativeTime: 'Yesterday', provider: 'gmail',   unread: true  },
  { sender: 'Stripe',         senderEmail: 'statements@stripe.com',     subject: 'Your October payout is on its way',      snippet: 'We\'ll deposit your October earnings to your bank account ending in…',      relativeTime: 'Yesterday', provider: 'gmail',   unread: false },
  { sender: 'Stack Overflow', senderEmail: 'do-not-reply@stackoverflow.com', subject: 'You earned a new badge: "Strunk & White"', snippet: 'Congratulations! You\'ve edited 80 posts — earned the badge "Strunk & White".', relativeTime: '2 days ago', provider: 'gmail', unread: false },
  { sender: 'Mailing list',   senderEmail: 'list@example.org',         subject: '[pi-foundation] Weekly summary',         snippet: 'Highlights from this week: 14 merged PRs, 3 new issues, dashboard v1…',       relativeTime: '3 days ago', provider: 'gmail',   unread: false },
  { sender: 'Sarah Lee',      senderEmail: 'sarah.lee@contoso.com',    subject: 'RE: Office hours next week',              snippet: '"Tuesday works for me. I\'ll send a calendar invite shortly — also looping…',  relativeTime: '9:48 AM',  provider: 'outlook', unread: true  },
  { sender: 'Microsoft Teams', senderEmail: 'noreply@teams.microsoft.com', subject: 'Daily digest from your teams',          snippet: 'You have 4 unread mentions across 2 teams. Most active: Engineering…',       relativeTime: '8:30 AM',  provider: 'outlook', unread: true  },
  { sender: 'Office 365 Admin', senderEmail: 'admin@contoso.com',     subject: 'Monthly security report',                snippet: 'Your organization\'s monthly security report is ready. 12 sign-in events…',  relativeTime: 'Yesterday', provider: 'outlook', unread: false },
  { sender: 'Outlook Calendar', senderEmail: 'calendar@noreply.com',   subject: 'Reminder: Sprint review tomorrow',        snippet: 'Don\'t forget — the sprint review is scheduled for tomorrow at 10:00 AM…',   relativeTime: '2 days ago', provider: 'outlook', unread: false },
  { sender: 'Project Lead',   senderEmail: 'lead@contoso.com',         subject: 'Updated timeline for Q4',                 snippet: 'Please find attached the revised timeline. Key change: Pi-POS launch…',      relativeTime: '3 days ago', provider: 'outlook', unread: false },
]

// ─── Today compartment fixtures ─────────────────────────────────────────────────────────

// Routines are recurring items that appear in the "Today" sub-view every
// day and get unchecked at midnight. They never appear in the week view
// (too repetitive).
interface RoutineFixture {
  readonly title: string
  readonly done: boolean
}

const ROUTINES: readonly RoutineFixture[] = [
  { title: 'Drink water',                done: false },
  { title: 'Stretch 5 min',              done: true  },
  { title: 'Review yesterday\'s notes',  done: true  },
  { title: 'Plan tomorrow',              done: false },
]

interface TaskTiming {
  /** When during the day the task belongs. Free-form — used as a small
   * hint label so the user can cluster tasks mentally. */
  readonly hint: 'before-work' | 'evening' | 'anytime'
  readonly hintLabel: string
}

interface TaskFixture {
  readonly title: string
  readonly timing: TaskTiming
  readonly done: boolean
}

const TODAYS_TASKS: readonly TaskFixture[] = [
  { title: 'Reply to Sarah\'s email',         timing: { hint: 'before-work', hintLabel: 'before work' }, done: false },
  { title: 'Finish Q3 draft',                 timing: { hint: 'evening',     hintLabel: 'evening' },     done: false },
  { title: 'Book dentist appointment',        timing: { hint: 'anytime',     hintLabel: 'anytime' },     done: false },
  { title: 'Order new standing desk converter', timing: { hint: 'anytime',   hintLabel: 'anytime' },     done: false },
  { title: 'Pay credit card bill',            timing: { hint: 'evening',     hintLabel: 'evening' },     done: false },
  { title: 'Call mom',                        timing: { hint: 'evening',     hintLabel: 'evening' },     done: false },
]

interface EventFixture {
  readonly title: string
  readonly hour: number   // 24-hour, 0-23
  readonly minute: number // 0-59
}

const TODAYS_EVENTS: readonly EventFixture[] = [
  { title: 'Morning walk',  hour:  7, minute: 30 },
  { title: 'Read chapter 4', hour: 19, minute:  0 },
  { title: 'Journal',       hour: 20, minute: 30 },
]

// Week view: 7 days starting Monday. Events placed in personal time
// (before/after work); work block is rendered separately on weekdays.
const WORK_START_HOUR = 10
const WORK_START_MIN = 10
const WORK_END_HOUR = 18
const WORK_END_MIN = 30

interface WeekDayFixture {
  readonly label: string       // "Mon 30"
  readonly isToday: boolean
  readonly isWeekend: boolean
  readonly events: readonly EventFixture[]
}

const WEEK_DAYS: readonly WeekDayFixture[] = [
  { label: 'Mon 30', isToday: false, isWeekend: false,
    events: [{ title: 'Morning walk', hour:  7, minute: 30 }] },
  { label: 'Tue 1',  isToday: false, isWeekend: false,
    events: [{ title: 'Run',          hour:  9, minute:  0 },
             { title: 'Film night',   hour: 20, minute:  0 }] },
  { label: 'Wed 2',  isToday: true,  isWeekend: false,
    events: [{ title: 'Yoga',         hour:  7, minute:  0 },
             { title: 'Read chapter 4', hour: 19, minute: 0 },
             { title: 'Journal',      hour: 20, minute: 30 }] },
  { label: 'Thu 3',  isToday: false, isWeekend: false,
    events: [{ title: 'Run',          hour:  9, minute:  0 },
             { title: 'Film night',   hour: 20, minute:  0 }] },
  { label: 'Fri 4',  isToday: false, isWeekend: false,
    events: [{ title: 'Morning walk', hour:  7, minute: 30 },
             { title: 'Cook with Sarah', hour: 19, minute: 0 }] },
  { label: 'Sat 5',  isToday: false, isWeekend: true,
    events: [{ title: 'Long run',     hour:  9, minute:  0 },
             { title: 'Game night',   hour: 20, minute: 30 }] },
  { label: 'Sun 6',  isToday: false, isWeekend: true,
    events: [{ title: 'Read & relax', hour: 10, minute:  0 }] },
]

// All-tasks view: full backlog, active first, completed last.
interface AllTaskFixture {
  readonly title: string
  readonly dueLabel: string
  readonly done: boolean
}

const ALL_TASKS: readonly AllTaskFixture[] = [
  { title: 'Reply to Sarah\'s email',           dueLabel: 'today',     done: false },
  { title: 'Finish Q3 draft',                   dueLabel: 'today',     done: false },
  { title: 'Book dentist appointment',          dueLabel: 'this week', done: false },
  { title: 'Order new standing desk converter', dueLabel: 'this week', done: false },
  { title: 'Pay credit card bill',              dueLabel: 'this week', done: false },
  { title: 'Call mom',                          dueLabel: 'this week', done: false },
  { title: 'Renew passport',                    dueLabel: 'this month',done: false },
  { title: 'Read DDIA chapter 6',               dueLabel: 'no date',   done: false },
  { title: 'Submit expense report',             dueLabel: 'yesterday', done: true  },
  { title: 'Review pull request #42',           dueLabel: 'yesterday', done: true  },
  { title: 'Backup photos',                     dueLabel: 'last week', done: true  },
]

// ─── Renderers ────────────────────────────────────────────────────────────

function renderPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
${COMMON_HEAD}
    <title>Dashboard — v2 Preview</title>
    <meta name="robots" content="noindex">
  </head>
  <body class="preview-body">
    ${renderHeader()}
    <div class="layout">
      <aside class="sidebar" data-sidebar>
        ${renderCompartmentNav()}
        <div data-folder-tree>${renderFolderTree()}</div>
      </aside>
      <main class="preview-main">
        <div class="preview-banner" role="status">
          <span class="preview-banner-icon" aria-hidden="true">⚠</span>
          <span class="preview-banner-text">PREVIEW — placeholder data, v2 features not yet implemented.</span>
        </div>
        <div class="preview-tabs" role="tablist" data-preview-tabs>
          ${COMPARTMENTS.map((c, i) => `<button type="button" role="tab" class="preview-tab${i === 0 ? ' preview-tab-active' : ''}" data-tab="${c.id}" aria-selected="${i === 0 ? 'true' : 'false'}">${c.icon} ${escapeHtml(c.label)}</button>`).join('\n          ')}
        </div>
        <div class="preview-panels">
          ${renderBookmarksPanel()}
          ${renderYouTubeSavesPanel()}
          ${renderYouTubeHistoryPanel()}
          ${renderProjectsPanel()}
          ${renderEmailPanel()}
          ${renderTodayPanel()}
        </div>
      </main>
    </div>
    <div class="preview-watermark" aria-hidden="true">PREVIEW</div>
    ${THEME_SCRIPT_TAG}
    ${HAMBURGER_SCRIPT_TAG}
    <script>${PREVIEW_SCRIPT}</script>
  </body>
</html>`
}

function renderCompartmentNav(): string {
  const items = COMPARTMENTS.map((c, i) => `
        <li>
          <button type="button" class="compartment-button${i === 0 ? ' compartment-button-active' : ''}" data-compartment="${c.id}">
            <span class="compartment-icon" aria-hidden="true">${c.icon}</span>
            <span class="compartment-label">${escapeHtml(c.label)}</span>
          </button>
        </li>`).join('')
  return `
      <div class="sidebar-section">
        <h2 class="sidebar-title">Compartments</h2>
        <ul class="compartment-nav">${items}
        </ul>
      </div>`
}

function renderFolderTree(): string {
  // Hand-built tree — matches the styling the real folder tree uses,
  // but the data is fictional. Folders show counts (bookmarks + videos).
  return `
      <div class="sidebar-section sidebar-folder-section">
        <div class="sidebar-header">
          <h2 class="sidebar-title">Folders</h2>
          <button type="button" class="add-folder-btn" aria-label="New folder">+</button>
        </div>
        <div class="sidebar-tree">
          <ul>
            <li class="sidebar-item" data-depth="0">
              <a class="folder-label" href="#">
                <span class="sidebar-icon" aria-hidden="true">📁</span>
                <span class="sidebar-name">Tech</span>
                <span class="sidebar-count">42</span>
              </a>
              <ul>
                <li class="sidebar-item" data-depth="1">
                  <a class="folder-label" href="#">
                    <span class="sidebar-icon" aria-hidden="true">📁</span>
                    <span class="sidebar-name">Backend</span>
                    <span class="sidebar-count">18</span>
                  </a>
                  <ul>
                    <li class="sidebar-item" data-depth="2">
                      <a class="folder-label" href="#">
                        <span class="sidebar-icon" aria-hidden="true">📁</span>
                        <span class="sidebar-name">Databases</span>
                        <span class="sidebar-count">7</span>
                      </a>
                    </li>
                    <li class="sidebar-item" data-depth="2">
                      <a class="folder-label sidebar-link-active" href="#" data-active="true">
                        <span class="sidebar-icon" aria-hidden="true">📁</span>
                        <span class="sidebar-name">Reading</span>
                        <span class="sidebar-count">11</span>
                      </a>
                    </li>
                  </ul>
                </li>
                <li class="sidebar-item" data-depth="1">
                  <a class="folder-label" href="#">
                    <span class="sidebar-icon" aria-hidden="true">📁</span>
                    <span class="sidebar-name">Web</span>
                    <span class="sidebar-count">9</span>
                  </a>
                </li>
              </ul>
            </li>
            <li class="sidebar-item" data-depth="0">
              <a class="folder-label" href="#">
                <span class="sidebar-icon" aria-hidden="true">📁</span>
                <span class="sidebar-name">Personal</span>
                <span class="sidebar-count">12</span>
              </a>
            </li>
            <li class="sidebar-item" data-depth="0">
              <a class="folder-label" href="#">
                <span class="sidebar-icon" aria-hidden="true">📁</span>
                <span class="sidebar-name">News</span>
                <span class="sidebar-count">8</span>
              </a>
            </li>
            <li class="sidebar-item" data-depth="0">
              <a class="folder-label" href="#">
                <span class="sidebar-icon" aria-hidden="true">📁</span>
                <span class="sidebar-name">Art</span>
                <span class="sidebar-count">6</span>
              </a>
            </li>
          </ul>
        </div>
      </div>`
}

function renderBookmarksPanel(): string {
  const items = BOOKMARKS.map((b) => renderBookmarkCard(b)).join('')
  return `
        <section class="preview-panel" data-panel="bookmarks" role="tabpanel">
          <div class="preview-panel-header">
            <h2 class="preview-panel-title">Activity</h2>
            <span class="preview-panel-meta">${BOOKMARKS.length} of ${BOOKMARKS.length}</span>
          </div>
          <div class="feed-list">${items}</div>
        </section>`
}

function renderBookmarkCard(b: BookmarkFixture): string {
  const domain = domainOf(b.url)
  const tagsHtml = b.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')
  return `
            <article class="feed-item">
              <div class="feed-item-header">
                <span class="source-badge">${escapeHtml(domain)}</span>
                <div class="feed-item-thumb-slot"></div>
              </div>
              <h3 class="feed-item-title"><a href="${escapeHtml(b.url)}" rel="noopener" target="_blank">${escapeHtml(b.title)}</a></h3>
              <div class="feed-item-meta">
                <span class="folder-path">📁 ${escapeHtml(b.folder)}</span>
                <span class="meta-sep">·</span>
                <span class="tags">${tagsHtml}</span>
              </div>
              <div class="feed-item-actions">
                <a class="action-button" href="${escapeHtml(b.url)}" rel="noopener" target="_blank" title="Open">↗</a>
                <button class="action-button" type="button" title="Edit">✏</button>
                <button class="action-button" type="button" title="Copy URL" data-copy-url="${escapeHtml(b.url)}">📋</button>
              </div>
            </article>`
}

function renderYouTubeSavesPanel(): string {
  const items = YOUTUBE_SAVES.map((v) => renderYouTubeSaveCard(v)).join('')
  return `
        <section class="preview-panel preview-panel-hidden" data-panel="youtube-saves" role="tabpanel" hidden>
          <div class="preview-panel-header">
            <h2 class="preview-panel-title">YouTube Saves</h2>
            <span class="preview-panel-meta">${YOUTUBE_SAVES.length} of ${YOUTUBE_SAVES.length}</span>
          </div>
          <div class="feed-list">${items}</div>
        </section>`
}

function renderYouTubeSaveCard(v: YouTubeSaveFixture): string {
  const tagsHtml = v.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')
  return `
            <article class="feed-item">
              <div class="feed-item-header">
                <span class="source-badge source-badge-youtube">YouTube</span>
                <div class="feed-item-thumb-slot">
                  <div class="feed-item-thumb feed-item-thumb-youtube feed-item-thumb-placeholder"></div>
                </div>
              </div>
              <h3 class="feed-item-title"><a href="#" rel="noopener">${escapeHtml(v.title)}</a></h3>
              <div class="feed-item-meta">
                <span class="folder-path">📁 ${escapeHtml(v.folder)}</span>
                <span class="meta-sep">·</span>
                <span class="meta-channel">${escapeHtml(v.channel)}</span>
                <span class="meta-sep">·</span>
                <span class="tags">${tagsHtml}</span>
              </div>
              <div class="feed-item-actions">
                <a class="action-button" href="#" title="Open on YouTube" target="_blank" rel="noopener">↗</a>
                <button class="action-button" type="button" title="Edit">✏</button>
                <button class="action-button" type="button" title="Unsave">−</button>
              </div>
            </article>`
}

function renderYouTubeHistoryPanel(): string {
  const rows = YOUTUBE_HISTORY.map((h) => renderHistoryRow(h)).join('')
  return `
        <section class="preview-panel preview-panel-hidden" data-panel="youtube-history" role="tabpanel" hidden>
          <div class="preview-panel-header">
            <h2 class="preview-panel-title">YouTube History</h2>
            <span class="preview-panel-meta">${YOUTUBE_HISTORY.length} watched</span>
          </div>
          <ul class="history-list">${rows}</ul>
        </section>`
}

function renderHistoryRow(h: YouTubeHistoryFixture): string {
  const savedBadge = h.isSaved
    ? `<span class="history-saved-badge" title="This video is in your Saves">★ Saved</span>`
    : ''
  return `
            <li class="history-row">
              <div class="history-main">
                <span class="source-badge source-badge-youtube">YouTube</span>
                <div class="history-text">
                  <a class="history-title" href="#" rel="noopener">${escapeHtml(h.title)}</a>
                  <span class="history-channel">${escapeHtml(h.channel)}</span>
                </div>
              </div>
              <div class="history-meta">
                <span class="history-time">${escapeHtml(h.relativeTime)}</span>
                ${savedBadge}
                <button class="action-button" type="button" title="Delete from history" aria-label="Delete from history">🗑</button>
              </div>
            </li>`
}

function renderProjectsPanel(): string {
  const items = PROJECTS.map((p) => renderProjectCard(p)).join('')
  return `
        <section class="preview-panel preview-panel-hidden" data-panel="projects" role="tabpanel" hidden>
          <div class="preview-panel-header">
            <h2 class="preview-panel-title">Projects</h2>
            <span class="preview-panel-meta">${PROJECTS.filter((p) => p.status === 'running').length} running · ${PROJECTS.filter((p) => p.status === 'stopped').length} stopped</span>
          </div>
          <div class="feed-list">${items}</div>
        </section>`
}

function renderProjectCard(p: ProjectFixture): string {
  const statusInfo = statusFor(p.status)
  const portLink = p.port !== null
    ? `<a class="action-button" href="http://ubuntu-server:${p.port}" target="_blank" rel="noopener" title="Open at port ${p.port}">↗</a>`
    : ''
  const uptimeLine = p.uptime !== null
    ? `<span class="project-uptime">uptime ${escapeHtml(p.uptime)}</span>`
    : ''
  const startStop = p.status === 'running'
    ? `<button class="action-button" type="button" title="Stop project" aria-label="Stop">■</button>`
    : `<button class="action-button" type="button" title="Start project" aria-label="Start">▶</button>`
  return `
            <article class="feed-item project-item">
              <div class="feed-item-header">
                <span class="project-status-pill project-status-${p.status}" title="${statusInfo.tooltip}">
                  <span class="project-status-dot" aria-hidden="true"></span>${statusInfo.label}
                </span>
              </div>
              <h3 class="feed-item-title">${escapeHtml(p.name)}</h3>
              <div class="feed-item-meta">
                <span class="folder-path">${escapeHtml(p.category)}</span>
                ${uptimeLine ? `<span class="meta-sep">·</span>${uptimeLine}` : ''}
              </div>
              <p class="project-description">${escapeHtml(p.description)}</p>
              <div class="feed-item-actions">
                ${startStop}
                ${portLink}
                <button class="action-button" type="button" title="Restart" aria-label="Restart">↻</button>
                <button class="action-button" type="button" title="View logs" aria-label="View logs">≡</button>
              </div>
            </article>`
}

function statusFor(s: ProjectStatus): { readonly label: string; readonly tooltip: string } {
  switch (s) {
    case 'running':  return { label: 'Running',  tooltip: 'Process is alive' }
    case 'stopped':  return { label: 'Stopped',  tooltip: 'Not running' }
    case 'starting': return { label: 'Starting', tooltip: 'Spawning' }
    case 'errored':  return { label: 'Errored',  tooltip: 'Process exited unexpectedly' }
  }
}

function renderEmailPanel(): string {
  const unreadCount = EMAILS.filter((e) => e.unread).length
  const filterPills = `
        <div class="email-filters" role="tablist">
          <button type="button" class="email-filter email-filter-active" data-email-filter="all">All (${EMAILS.length})</button>
          <button type="button" class="email-filter" data-email-filter="gmail">Gmail (${EMAILS.filter((e) => e.provider === 'gmail').length})</button>
          <button type="button" class="email-filter" data-email-filter="outlook">Outlook (${EMAILS.filter((e) => e.provider === 'outlook').length})</button>
        </div>`
  const rows = EMAILS.map((e) => renderEmailRow(e)).join('')
  return `
        <section class="preview-panel preview-panel-hidden" data-panel="email" role="tabpanel" hidden>
          <div class="preview-panel-header">
            <h2 class="preview-panel-title">Inbox</h2>
            <span class="preview-panel-meta">${unreadCount} unread · ${EMAILS.length} total</span>
          </div>
          ${filterPills}
          <ul class="email-list">${rows}</ul>
        </section>`
}

function renderEmailRow(e: EmailFixture): string {
  const unreadClass = e.unread ? ' email-row-unread' : ''
  const providerClass = `email-provider-${e.provider}`
  const providerLabel = e.provider === 'gmail' ? 'Gmail' : 'Outlook'
  return `
            <li class="email-row${unreadClass}" data-email-provider="${e.provider}">
              <span class="email-unread-dot" aria-hidden="true"></span>
              <span class="email-sender">${escapeHtml(e.sender)}</span>
              <div class="email-content">
                <span class="email-subject">${escapeHtml(e.subject)}</span>
                <span class="email-snippet">${escapeHtml(e.snippet)}</span>
              </div>
              <span class="email-time">${escapeHtml(e.relativeTime)}</span>
              <span class="source-badge ${providerClass}">${providerLabel}</span>
            </li>`
}

// ─── Today compartment renderers ─────────────────────────────────────────────────────────

function renderTodayPanel(): string {
  const subtabs = TODAY_SUBVIEWS.map((sv, i) =>
    `<button type="button" role="tab" class="today-subtab${i === 0 ? ' today-subtab-active' : ''}" data-today-subtab="${sv.id}" aria-selected="${i === 0 ? 'true' : 'false'}">${escapeHtml(sv.label)}</button>`,
  ).join('\n          ')
  return `
        <section class="preview-panel preview-panel-hidden" data-panel="today" role="tabpanel" hidden>
          <div class="today-subtabs" role="tablist" data-today-subtabs>
            ${subtabs}
          </div>
          <div class="today-subpanel" data-today-subpanel="today">
            ${renderTodaySubView()}
          </div>
          <div class="today-subpanel" data-today-subpanel="this-week" hidden>
            ${renderThisWeekSubView()}
          </div>
          <div class="today-subpanel" data-today-subpanel="all-tasks" hidden>
            ${renderAllTasksSubView()}
          </div>
        </section>`
}

function renderTodaySubView(): string {
  const routineRows = ROUTINES.map((r) => renderRoutineRow(r)).join('')
  const taskRows = TODAYS_TASKS.map((t) => renderTodayTaskRow(t)).join('')
  const eventRows = TODAYS_EVENTS.map((e) => renderTodayEventRow(e)).join('')
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  return `
          <div class="preview-panel-header">
            <h2 class="preview-panel-title">Today</h2>
            <span class="preview-panel-meta">${escapeHtml(today)}</span>
          </div>
          <section class="today-section">
            <h3 class="today-section-title">Routines <span class="today-section-meta">daily — auto-reset at midnight</span></h3>
            <ul class="today-list today-list-routines">${routineRows}
            </ul>
          </section>
          <section class="today-section">
            <h3 class="today-section-title">Tasks <span class="today-section-meta">${TODAYS_TASKS.length} for today</span></h3>
            <ul class="today-list today-list-tasks">${taskRows}
            </ul>
          </section>
          <section class="today-section">
            <h3 class="today-section-title">Schedule <span class="today-section-meta">${TODAYS_EVENTS.length} events</span></h3>
            <ul class="today-list today-list-events">${eventRows}
            </ul>
          </section>`
}

function renderRoutineRow(r: RoutineFixture): string {
  const doneClass = r.done ? ' today-row-done' : ''
  return `
              <li class="today-row${doneClass}">
                <span class="today-checkbox" aria-hidden="true">${r.done ? '✓' : '☐'}</span>
                <span class="today-row-text">${escapeHtml(r.title)}</span>
              </li>`
}

function renderTodayTaskRow(t: TaskFixture): string {
  const doneClass = t.done ? ' today-row-done' : ''
  return `
              <li class="today-row${doneClass}">
                <span class="today-checkbox" aria-hidden="true">${t.done ? '✓' : '☐'}</span>
                <span class="today-row-text">${escapeHtml(t.title)}</span>
                <span class="today-task-hint today-task-hint-${t.timing.hint}">${escapeHtml(t.timing.hintLabel)}</span>
              </li>`
}

function renderTodayEventRow(e: EventFixture): string {
  const time = formatTime(e.hour, e.minute)
  return `
              <li class="today-row today-row-event">
                <span class="today-event-time">${time}</span>
                <span class="today-row-text">${escapeHtml(e.title)}</span>
              </li>`
}

function renderThisWeekSubView(): string {
  const days = WEEK_DAYS.map((d) => renderWeekDayColumn(d)).join('')
  return `
          <div class="preview-panel-header">
            <h2 class="preview-panel-title">This week</h2>
            <span class="preview-panel-meta">Personal time only — work block shown but not schedulable</span>
          </div>
          <div class="week-grid">${days}
          </div>`
}

function renderWeekDayColumn(d: WeekDayFixture): string {
  // Build the column chronologically: morning events, work block
  // (weekdays only), evening events. Events themselves are rendered as
  // small blocks; the work block is a dashed separator.
  const sorted = [...d.events].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
  const morning = sorted.filter((e) => !isInWorkBlock(e.hour, e.minute))
    .filter((e) => (e.hour * 60 + e.minute) < (WORK_START_HOUR * 60 + WORK_START_MIN))
  const evening = sorted.filter((e) => !isInWorkBlock(e.hour, e.minute))
    .filter((e) => (e.hour * 60 + e.minute) >= (WORK_END_HOUR * 60 + WORK_END_MIN))

  const morningHtml = morning.map((e) => renderWeekEvent(e)).join('')
  const eveningHtml = evening.map((e) => renderWeekEvent(e)).join('')
  const workBlockHtml = d.isWeekend
    ? ''
    : `<div class="week-work-block" aria-label="Work hours, not schedulable">
           <span class="week-work-time">${formatTime(WORK_START_HOUR, WORK_START_MIN)}–${formatTime(WORK_END_HOUR, WORK_END_MIN)}</span>
           <span class="week-work-label">Work</span>
         </div>`

  const headerClass = d.isToday ? ' week-day-header week-day-today' : ' week-day-header'

  return `
            <div class="week-day">
              <div class="${headerClass.trim()}">${escapeHtml(d.label)}${d.isToday ? ' · today' : ''}</div>
              <div class="week-day-events">
                ${morningHtml}
                ${workBlockHtml}
                ${eveningHtml}
              </div>
            </div>`
}

function renderWeekEvent(e: EventFixture): string {
  return `
                <div class="week-event">
                  <span class="week-event-time">${formatTime(e.hour, e.minute)}</span>
                  <span class="week-event-title">${escapeHtml(e.title)}</span>
                </div>`
}

function renderAllTasksSubView(): string {
  const active = ALL_TASKS.filter((t) => !t.done)
  const completed = ALL_TASKS.filter((t) => t.done)
  const activeRows = active.map((t) => renderAllTaskRow(t)).join('')
  const completedRows = completed.map((t) => renderAllTaskRow(t)).join('')
  return `
          <div class="preview-panel-header">
            <h2 class="preview-panel-title">All tasks</h2>
            <span class="preview-panel-meta">${active.length} active · ${completed.length} completed</span>
          </div>
          <section class="today-section">
            <h3 class="today-section-title">Active</h3>
            <ul class="today-list">${activeRows}
            </ul>
          </section>
          <section class="today-section">
            <h3 class="today-section-title">Completed <span class="today-section-meta">last 7 days</span></h3>
            <ul class="today-list">${completedRows}
            </ul>
          </section>`
}

function renderAllTaskRow(t: AllTaskFixture): string {
  const doneClass = t.done ? ' today-row-done' : ''
  return `
              <li class="today-row${doneClass}">
                <span class="today-checkbox" aria-hidden="true">${t.done ? '✓' : '☐'}</span>
                <span class="today-row-text">${escapeHtml(t.title)}</span>
                <span class="today-task-due">${escapeHtml(t.dueLabel)}</span>
              </li>`
}

function isInWorkBlock(hour: number, minute: number): boolean {
  const mins = hour * 60 + minute
  const start = WORK_START_HOUR * 60 + WORK_START_MIN
  const end = WORK_END_HOUR * 60 + WORK_END_MIN
  return mins >= start && mins < end
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// ─── Utilities ────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// ─── Client script ────────────────────────────────────────────────────────

const PREVIEW_SCRIPT = `(function(){
  // Compartment tab switching.
  // - Sidebar buttons + tab strip buttons both update the active panel.
  // - The folder tree is hidden for compartments that don't have folders.
  //
  // Note: uses Array.from(NodeList).forEach rather than C-style for
  // loops. An earlier version had a 'var show' inside one of the
  // loops; 'var' is function-scoped, so it hoisted to the top of the
  // click handler and shadowed the outer show() function — every tab
  // click threw TypeError silently. forEach callbacks have their own
  // scope so a stray 'var show' cannot shadow anything.
  var COMPARTMENTS_WITH_FOLDERS = ['bookmarks', 'youtube-saves'];

  function showCompartment(id) {
    Array.from(document.querySelectorAll('[data-tab]')).forEach(function (t) {
      var active = t.getAttribute('data-tab') === id;
      t.classList.toggle('preview-tab-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    Array.from(document.querySelectorAll('[data-compartment]')).forEach(function (n) {
      var active = n.getAttribute('data-compartment') === id;
      n.classList.toggle('compartment-button-active', active);
    });
    Array.from(document.querySelectorAll('[data-panel]')).forEach(function (p) {
      var active = p.getAttribute('data-panel') === id;
      p.classList.toggle('preview-panel-hidden', !active);
      if (active) { p.removeAttribute('hidden'); } else { p.setAttribute('hidden', ''); }
    });
    var tree = document.querySelector('[data-folder-tree]');
    if (tree) {
      tree.style.display = COMPARTMENTS_WITH_FOLDERS.indexOf(id) === -1 ? 'none' : '';
    }
    // The Today compartment has its own inner tab strip. Reset it to
    // the first sub-view ("Today") every time the user clicks the
    // Today compartment from outside, so they always land on the
    // daily check-in.
    if (id === 'today') {
      showTodaySubView('today');
    }
  }

  function showTodaySubView(id) {
    Array.from(document.querySelectorAll('[data-today-subtab]')).forEach(function (t) {
      var active = t.getAttribute('data-today-subtab') === id;
      t.classList.toggle('today-subtab-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    Array.from(document.querySelectorAll('[data-today-subpanel]')).forEach(function (p) {
      var active = p.getAttribute('data-today-subpanel') === id;
      if (active) { p.removeAttribute('hidden'); } else { p.setAttribute('hidden', ''); }
    });
  }

  function setEmailFilter(filter) {
    Array.from(document.querySelectorAll('[data-email-filter]')).forEach(function (pill) {
      pill.classList.toggle('email-filter-active', pill.getAttribute('data-email-filter') === filter);
    });
    Array.from(document.querySelectorAll('[data-email-provider]')).forEach(function (row) {
      var visible = filter === 'all' || row.getAttribute('data-email-provider') === filter;
      row.style.display = visible ? '' : 'none';
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var tabBtn = t.closest('[data-tab]');
    if (tabBtn) {
      e.preventDefault();
      showCompartment(tabBtn.getAttribute('data-tab'));
      return;
    }
    var navBtn = t.closest('[data-compartment]');
    if (navBtn) {
      e.preventDefault();
      showCompartment(navBtn.getAttribute('data-compartment'));
      return;
    }
    var filterBtn = t.closest('[data-email-filter]');
    if (filterBtn) {
      e.preventDefault();
      setEmailFilter(filterBtn.getAttribute('data-email-filter'));
      return;
    }
    var subtabBtn = t.closest('[data-today-subtab]');
    if (subtabBtn) {
      e.preventDefault();
      showTodaySubView(subtabBtn.getAttribute('data-today-subtab'));
    }
  });
})();`