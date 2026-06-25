# [PRD] Payee grouping, Dutch UI, and data backup

## Problem Statement

The Cozy Ledger app is fully built and feels right at home for daily use, but three frictions have built up:

1. **Categorisation is per-transaction.** When a new statement arrives and contains 8 transactions from the same payee (e.g. Delhaize, Telenet, the energy company), the user has to set the category 8 times — once per row — even though they already know it's the same category every time. There is a Payees tab that lists distinct payees with a bulk-assign dropdown, but that lives one click away from where categorisation actually happens (the transactions table and the dashboard). Setting a category inline should also offer to do it for every other transaction of the same payee, and that decision should be remembered so future imports of the same payee come in pre-categorised.

2. **All data lives in one browser's `localStorage`.** There is no way to take a backup, hand the file to a partner or move to a new laptop, or restore after a browser data wipe. The household has been actively using the app for months and would lose real data if anything went wrong.

3. **The UI is in English.** The household speaks Dutch in daily life and the bank statements are Belgian, so labels like "Spending share", "Need categorisation", "Top categories" feel like a translation layer instead of a native surface. The code, comments, and identifiers stay English — that's the team's working language — but every user-facing string should be Dutch. While at it, the categories would benefit from a simple **grouping** layer (Wonen, Boodschappen, Vervoer, …) so charts and reports can roll up at a higher level without inventing subcategories.

## Solution

Three independent features, each shippable on its own, planned in this order so the simpler data model is captured by the backup format before the Dutch + groups work lands:

1. **Payee → category propagation.** When the user changes a transaction's category inline (from the transactions table or the dashboard edit modal), offer to apply that category to every other transaction of the same payee. Remember the user's choice for the rest of the session and future sessions. Persist a `payeeName → categoryId` mapping so that future CSV imports of those payees come in pre-categorised. The existing Payees-tab bulk dropdown becomes a front-end for the same mapping, so there is exactly one source of truth.

2. **Export / Import backup.** Add a "Settings" route with two export buttons (`JSON full backup` and `CSV for Excel`) and one import button. JSON is the canonical round-trippable backup format and is versioned so future schema changes can migrate. CSV export is a one-way view of the transactions, intended for Excel analysis. Import is replace-only (no merging) with a dry-run preview and a pre-import snapshot to `localStorage` so the user can recover from a bad import.

3. **Dutch UI + category groups.** Translate every visible string to Dutch (code, comments, identifiers stay English). Add a flat **Group** layer above categories: a new `groups` collection plus an optional `groupId` on each category. The `Transaction` model stays untouched — groups are a presentation and roll-up dimension, not a hierarchy. Charts, filters, and (later) reports can group by either categories or groups.

## User Stories

### Payee → category propagation

1. As a user, when I edit a transaction's category from the transactions table or the dashboard, I want a checkbox that says "Also apply to all N other transactions of [payee]", so that I can categorise a whole payee in one click.
2. As a user, when I tick that checkbox once, I want the app to remember that choice for me, so that I don't have to keep ticking it for the same workflow.
3. As a user, when I tick that checkbox, I want every other transaction of that payee to be updated — including ones I previously categorised differently — so that my payee-level decision wins.
4. As a user, after I categorise a payee, I want future CSV imports from that payee to come in already categorised, so that I don't have to redo the work each statement.
5. As a user, the existing Payees tab should keep working and should write to the same mapping, so that I have a single bulk-edit surface for the same decision.

### Export / Import backup

6. As a user, I want a "Settings" area with an "Export → JSON" button, so that I can save a complete, restorable backup of my data.
7. As a user, I want the exported JSON to include a schema version and an export date, so that I know what I have and so the app can detect old backups later.
8. As a user, I want an "Export → CSV" button that gives me a transactions-only spreadsheet, so that I can open it in Excel for analysis without losing categories, sources, users, or settings.
9. As a user, I want an "Import" button that lets me load a previously exported JSON file, so that I can move data between browsers or recover after a wipe.
10. As a user, I want the import to show me a dry-run preview ("This backup contains 142 transactions, 26 categories, …") before anything changes, so that I can confirm with eyes open.
11. As a user, I want the import to fully replace my current data — no merging, no "skip if exists" — so that the backup is a true snapshot.
12. As a user, I want the app to take a safety snapshot of my current state to `localStorage` before every import, so that I can recover from a bad import without losing my old data.
13. As a user, I want clear errors when I try to import a file with an unknown or future schema version, so that I'm not silently fed garbage.

### Dutch UI + category groups

14. As a user, every visible string in the app should be in Dutch, so that the surface matches the language I think in.
15. As a user, code, comments, identifiers, console messages, and commit messages stay in English, so that the team's working language doesn't drift.
16. As a user, I want a simple **group** above categories (Wonen, Boodschappen & eten, Vervoer, …) so that I can see totals at a higher level without inventing subcategories.
17. As a user, I want categories to be assignable to a group but still flat — a transaction still references a single category, and a category optionally references a group, so that nothing about the transaction model has to change.
18. As a user, I want to filter and chart by group, so that the dashboard can show "Wonen: €842" instead of eight separate lines.
19. As a user, the migration of my existing 26 categories into groups should happen automatically on first load after the update, so that I don't have to redo it manually.

## Implementation Decisions

- **`payeeCategories` mapping.** New persisted object `state.payeeCategories = { [payeeName: string]: categoryId: string }`. Keyed by the result of `CSVImport.extractPayee(description)` (already exists in `csv.js`). Written every time a category is applied to a payee via either the Payees-tab bulk dropdown or the inline "apply to all" checkbox in the edit modal. Read by the CSV importer after each row is created: if the row's extracted payee has a saved category, that category is set on the new transaction unless the importer's classifier has already explicitly classified it.

- **`settings.applyCategoryToPayee`.** New persisted boolean, default `false`. When `true`, the inline "apply to all" checkbox in the edit modal is checked by default; when `false`, it is unchecked but still visible. Ticking the box once persists `true` for future sessions.

- **Single source of truth.** Refactor `bulkUpdatePayeeCategory(name, categoryId)` in `app.js` into the canonical function that:
  1. Updates every in-scope transaction with `extractPayee(description) === name`.
  2. Writes the mapping `state.payeeCategories[name] = categoryId` (clears it when `categoryId` is empty).
  3. Fires `store:changed`.
  Both the Payees-tab dropdown and the edit-modal checkbox call this function. Existing Payees-tab behaviour is preserved.

- **CSV import integration.** After the importer creates a transaction, it looks up `state.payeeCategories[extractPayee(description)]`. If found and the row currently has no `categoryId`, the mapping wins. This means manual re-categorisation during import preview still takes priority over the saved mapping; the mapping is the safety net for rows the user didn't touch.

- **Backup format (`Export → JSON`).** A single file:
  ```json
  {
    "schemaVersion": 1,
    "exportedAt": "2025-12-31T23:59:59.000Z",
    "app": "cozy-ledger",
    "state": {
      "settings": { ... },
      "transactions": [ ... ],
      "categories": [ ... ],
      "sources": [ ... ],
      "users": [ ... ],
      "groups": [ ... ]
    }
  }
  ```
  Downloaded as `cozy-ledger-backup-YYYY-MM-DD.json`. `groups` is included if present (forward-compatible with ISSUE-007). Round-trip is exact: `JSON.stringify(state)` is wrapped with the header; import is `JSON.parse` → `Object.assign(state, parsed.state)`.

- **CSV export.** Transactions only. Standard CSV (comma-separated, dot decimal, ISO date `YYYY-MM-DD`). Columns: `Date, Description, Amount, Type, Category, User, Source, Scope, Notes`. Category, user, and source are resolved to their display names. Inactive entities are still exported (they were real at the time). File name: `cozy-ledger-transactions-YYYY-MM-DD.csv`. Suitable for any Excel locale.

- **Import flow.** File picker (`.json` only) → parse → validate `schemaVersion` and required keys → dry-run modal showing counts of `transactions`, `categories`, `sources`, `users`, and (if present) `groups` → confirm → snapshot current state to `localStorage.cozy_ledger_pre_import_backup` (overwriting any previous snapshot) with a `savedAt` ISO timestamp → replace state → `store:changed` → toast. Refuses with a clear error when `schemaVersion > 1`, when the JSON is malformed, or when `state` is missing.

- **Schema versioning.** `schemaVersion: 1` is introduced now. Future migrations live in `Store.load()` and check the version, applying transformations as needed. Exported files always carry the current version. The CSV importer and the rest of the app are not aware of versions — only the JSON backup path is.

- **`Settings` route.** New sidebar item (`Instellingen` after ISSUE-007, `Settings` until then). Hosts the Export and Import buttons. Lives in `app.js` next to the other `renderX` functions; no new file. Two buttons (Export JSON, Export CSV), one file input (Import JSON), and one dry-run modal. No additional sub-pages.

- **Dutch translations.** A single translation table in a new `i18n.js` file:
  ```js
  const Strings = {
    nl: {
      'nav.dashboard': 'Overzicht',
      'nav.trends': 'Trends',
      // ...
    },
  };
  function t(key) { return Strings.nl[key] ?? key; }
  ```
  Every visible string in `app.js`, `index.html`, and `selectors.js` (if it renders anything) is replaced with `t('key')`. English is dropped entirely from the UI — there is no English fallback path. If a key is missing during development, `t()` returns the key string so missing translations are visible. Code identifiers, comments, console messages, and commit messages stay English.

- **Groups.** New collection `state.groups = [{ id, name, color, icon, order }]`. Categories gain an optional `groupId: string | null`. The `Transaction` model is **not** touched — a transaction references a `categoryId`, never a group. A category without a group is valid (renders under an "Overig / Geen groep" header in the categories page).

- **Seed groups (proposed Dutch names — open to pushback):**
  | id | name | covers |
  |---|---|---|
  | `g_huis` | *Wonen* | rent/mortgage, electricity, water, heating, internet, home maintenance, insurance |
  | `g_boodschappen` | *Boodschappen & eten* | groceries, eating out |
  | `g_vervoer` | *Vervoer* | transport, car/bike |
  | `g_media` | *Communicatie & media* | phone, Netflix/streaming |
  | `g_gezin` | *Gezin* | child/family, pets, gifts |
  | `g_persoonlijk` | *Persoonlijk* | clothing, medical, leisure |
  | `g_overig_uit` | *Overige uitgaven* | other expense |
  | `g_inkomen` | *Inkomen* | all income categories |

- **Migration of existing categories.** On first load after ISSUE-007 ships, an idempotent migration in `Store.load()` assigns each existing category to a group based on a name → group mapping table (e.g. `c_eating → g_boodschappen`). Categories that don't match any entry get `groupId = null`. Re-running the migration is safe.

- **Group UI.** Groups are managed from a new section in the existing Categories page (sidebar item stays "Categories" / "Categorieën"). Each group renders as a card similar to the existing category cards: edit modal for name/color/icon/order, delete with confirmation (refuses if categories still reference it). The categories list under a group can be reordered by drag-and-drop if simple, otherwise by an `order` field — start with the simpler `order` field.

- **Charts and filters.** Dashboard summary cards gain a "by group" toggle or a stacked breakdown (group totals plus category drill-down). Transactions-list filter gains a `group` dropdown alongside `categoryId`. The Trends bar chart's per-category breakdown gets a "group by group" toggle. None of this is required for the first cut of ISSUE-007 — categories still work alone — but the data model and the group-management UI must be in place so the roll-ups can be added later without another migration.

- **No new dependencies, no build step.** Translations live in a flat JS object. Group UI uses existing `el()`/`modal()` helpers. Backup uses `Blob`, `URL.createObjectURL`, `<a download>`, and `FileReader` (all browser-native).

## Testing Decisions

- **Pattern.** Pure-function tests in `_test_*.js` files (no jsdom) for everything that's testable in isolation: `payeeCategories` lookup, JSON round-trip, CSV export column set, schema-mismatch refusal, group migration. UI smoke in `_test_boot.js` for things that need a stubbed DOM.

- **Modules to test:**
  - **Payee mapping**: `payeeCategories` is written when bulk-updating a payee; CSV import sets `categoryId` from the mapping when the row has none; explicit row-level classification still wins.
  - **Backup round-trip**: `state → JSON.stringify(state) → parse → Object.assign` is deep-equal to the original; `schemaVersion` and `exportedAt` are present and well-formed.
  - **CSV export**: header row matches the column spec; one row per transaction; categories/users/sources are resolved to names; numbers are dot-decimal; dates are ISO.
  - **Schema validation**: importing a file with `schemaVersion: 999` refuses with a clear error; importing malformed JSON refuses; importing a file with `state` missing refuses.
  - **Pre-import snapshot**: current state is written to `localStorage.cozy_ledger_pre_import_backup` before the replace.
  - **Group migration**: idempotent; every seed category ends up in exactly one group; categories not in the mapping get `groupId = null`; re-running does not change the stored state.
  - **Dutch strings**: a small test that asserts every key in the translation table is non-empty and not still in English (a tiny allow-list for keys that legitimately stay English, e.g. brand names).

- **Out of test scope:** visual layout of the Settings page, drag-and-drop reordering, font rendering, button click styling.

## Out of Scope

- Yearly summary / category-trend reports (the user is deferring these).
- "Viewing as" UI to switch the active user.
- Multi-currency support.
- Real backend / multi-device sync.
- Encrypted backups.
- Importing JSON from other budgeting apps.
- Subcategories or any deeper hierarchy than `Group → Category`.
- Auto-translation of user-entered content (transaction descriptions, notes, payee names, custom category names added by the user).

## Further Notes

- The order matters only because the JSON backup format captures `state.groups` once ISSUE-007 lands. If a user takes a JSON backup before ISSUE-007 and then upgrades, the backup still imports cleanly because the `groups` field is optional on read (absent key → empty array). The reverse — a post-ISSUE-007 backup imported on a pre-ISSUE-007 app — fails with a clear "schema version not supported" error.

- The Dutch seed names in the groups table are a proposal. The user has been invited to push back on any of them before implementation.

- "Settings" is the working name for the new sidebar route; it becomes "Instellingen" when ISSUE-007 ships. No need to keep two names alive during the interim.

- `payeeCategories` is keyed by the **exact** string returned by `extractPayee(description)`. Two payees whose extracted strings differ ("DELHAIZE" vs "Delhaize") will not be merged. This is a known limitation; a future improvement could normalise case and whitespace.

- The CSV export is intentionally a one-way, transactions-only view. It is **not** a backup format. A user who exports CSV and re-imports via the JSON import gets an error; that is correct behaviour.

- Group management is intentionally minimal. No per-user groups, no shared vs private groups, no nested groups. If the user later wants any of that, it is a new PRD.
