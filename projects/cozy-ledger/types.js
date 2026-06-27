// =====================================================================
// types.js — JSDoc @typedefs for the data model
// =====================================================================
// Loaded as the FIRST script in index.html so the typedefs are in scope
// before any other file references them. This file has no executable
// code — only documentation. Editor tooling (TypeScript "JavaScript
// type-checking", VS Code "Check JS") reads these blocks and provides
// inline type hints on hover and parameter completion.
//
// Why typedefs instead of TypeScript proper?
//   * Zero runtime cost — JSDoc tags are stripped at parse time.
//   * No build step — the `<script>` tag chain stays intact.
//   * Zero migration cost — existing .js files are unchanged at the
//     syntax level; only comments are added.
//
// Adding a new field?
//   1. Add it to the matching @typedef below.
//   2. Add it to the matching seed entry in data.js (idempotent —
//      Store.migrate() backfills any field that an older save lacks).
//
// Editor `Window` augmentation lives in globals.d.ts (not loaded at
// runtime; editor-only).
// =====================================================================

/** @typedef {'private'|'shared'|'all'} Scope */

/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} name
 * @property {string} color       Hex colour, e.g. '#5a7248'
 * @property {boolean} active
 */

/**
 * @typedef {Object} Source
 * @property {string} id
 * @property {string} name
 * @property {'bank'|'cash'|'savings'|'other'} type
 * @property {string|null} ownerId  null = shared (joint / common)
 * @property {boolean} active
 * @property {number} balance       User-typed current balance; the chart walks back from this.
 */

/**
 * @typedef {Object} Category
 * @property {string} id
 * @property {string} name
 * @property {'income'|'expense'} type
 * @property {string} color
 * @property {string} icon          Emoji or short label.
 * @property {boolean} active
 * @property {string|null} [groupId]  Presentation-group id (ISSUE-007). null = ungrouped.
 */

/**
 * @typedef {Object} Group
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} icon
 * @property {number} order          1-based sort order within the categories page.
 * @property {boolean} active
 */

/**
 * @typedef {Object} Transaction
 * @property {string} id
 * @property {'income'|'expense'} type
 * @property {number} amount         Always positive; direction comes from `type`.
 * @property {string} date           ISO YYYY-MM-DD
 * @property {string} description
 * @property {string} categoryId
 * @property {string} paidByUserId
 * @property {string} sourceId
 * @property {'private'|'shared'} scope
 * @property {string} notes
 * @property {string} createdAt      ISO 8601 with timezone
 * @property {string} updatedAt      ISO 8601 with timezone
 * @property {string} [importedKey]  Set by CSV import for dedup; absent on manual entries.
 */

/**
 * @typedef {Object} Settings
 * @property {string} currentUserId
 * @property {Scope} scope           Dashboard / chart scope.
 * @property {boolean} applyCategoryToPayee     ISSUE-005: default the edit-modal "apply to all" checkbox.
 * @property {boolean} dashboardByGroup         ISSUE-007: roll dashboard cards up to group level.
 */

/**
 * @typedef {Object} State
 * @property {User[]} users
 * @property {Source[]} sources
 * @property {Category[]} categories
 * @property {Group[]} groups
 * @property {Transaction[]} transactions
 * @property {Object<string,string>} payeeCategories  payee name → categoryId
 * @property {Settings} settings
 * @property {Goal[]} [goals]  ISSUE-017: savings goals (envelopes are the next slice). Optional — backfilled by Store.migrate().
 * @property {Envelope[]} [envelopes]  ISSUE-018: spending caps. Optional — backfilled by Store.migrate().
 */

/**
 * @typedef {Object} BalancePoint
 * @property {string} date           ISO YYYY-MM-DD
 * @property {number} balance
 */

/**
 * @typedef {Object} MonthFlow
 * @property {string} month          'YYYY-MM'
 * @property {number} income
 * @property {number} expense
 * @property {number} net            income − expense
 * @property {Object<string,number>} perSource  Source id → net flow that month.
 */

/**
 * @typedef {Object} FmtMoneyOpts
 * @property {boolean} [signed]      Prepend '+' to positive values.
 */

/**
 * @typedef {'1m'|'3m'|'6m'|'1y'|'2y'|'all'|'custom'} PeriodPreset
 *   The rolling-window preset selected by the user, or 'custom' when
 *   the user picked a manual date range. ISSUE-013 / PRD-004.
 */

/**
 * @typedef {Object} Period
 * @property {PeriodPreset} preset
 * @property {string} from  ISO YYYY-MM-DD, inclusive
 * @property {string} to    ISO YYYY-MM-DD, inclusive (clamped to today)
 */

/**
 * @typedef {Object} GoalFunding
 * @property {string} date    ISO YYYY-MM-DD of the deposit.
 * @property {number} amount  Always positive; deposit amount in EUR.
 */

/**
 * @typedef {Object} Goal
 * @property {string} id
 * @property {string} name
 * @property {number} target              Target amount in EUR (always > 0).
 * @property {number} funded              Cumulative funded amount in EUR.
 * @property {string|null} targetDate     Optional ISO YYYY-MM-DD target completion date.
 * @property {string} notes               Free-form notes (may be empty).
 * @property {GoalFunding[]} fundingHistory  Append-only deposit log.
 * @property {string} createdAt           ISO 8601 with timezone.
 * @property {string} updatedAt           ISO 8601 with timezone.
 */

/**
 * @typedef {'monthly'|'yearly'} EnvelopePeriod
 *   Resets the spend window: monthly = first of this month, yearly = Jan 1.
 */

/**
 * @typedef {Object} Envelope
 * @property {string} id
 * @property {string} name
 * @property {number} cap                 Limit amount in EUR (always > 0).
 * @property {EnvelopePeriod} period      Spend window.
 * @property {string[]} categoryIds       Category ids whose txns count toward this envelope.
 * @property {string[]} payeeIds          Payee-name strings (the strings produced by `CSVImport.extractPayee(description)`). A transaction matches when its extracted payee is in this list.
 * @property {string} notes               Free-form notes (may be empty).
 * @property {string} createdAt           ISO 8601 with timezone.
 * @property {string} updatedAt           ISO 8601 with timezone.
 */