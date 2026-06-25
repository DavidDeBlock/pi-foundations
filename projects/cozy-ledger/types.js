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