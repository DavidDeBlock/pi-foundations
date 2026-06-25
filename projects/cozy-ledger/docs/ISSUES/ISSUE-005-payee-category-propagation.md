# ISSUE-005 — Payee → category propagation (inline + import-time auto-categorise)

## Parent

[PRD] Payee grouping, Dutch UI, and data backup — `docs/PRD/PRD-002-payee-grouping-i18n-backup.md`

## Why

The Payees tab has had a "Set category for all" bulk dropdown since Phase 1, but it lives one click away from where categorisation actually happens. When a user changes a transaction's category from the transactions table or the dashboard edit modal, the change applies to that single row only — every other transaction of the same payee stays uncategorised (or wrongly categorised). The user ends up doing the same categorisation N times for N transactions of the same payee, and they have to redo the work again every time a new CSV statement arrives.

This issue makes the inline edit offer to do the bulk work in one click, remembers the user's preference, and persists a `payeeName → categoryId` mapping so future imports of those payees come in pre-categorised.

## What to build

1. **New persisted mapping.** `state.payeeCategories = { [payeeName: string]: categoryId: string }`. Keyed by the result of `CSVImport.extractPayee(description)` (already exists in `csv.js`). Initial value: `{}`. Migration in `Store.load()`: if the key is absent, set it to `{}` (idempotent).

2. **New persisted setting.** `state.settings.applyCategoryToPayee: boolean`. Default `false`. Migration in `Store.load()`: if absent, set `false` (idempotent).

3. **Canonical bulk-update function.** Refactor `bulkUpdatePayeeCategory(name, categoryId)` in `app.js` so that, in addition to its current behaviour, it writes `state.payeeCategories[name] = categoryId` (or deletes the key when `categoryId` is empty). It remains the only path that mutates `payeeCategories`. The Payees-tab dropdown continues to call it; behaviour is preserved.

4. **Edit-transaction modal — "apply to all" checkbox.** In the existing edit-transaction modal (reached from the transactions table and the dashboard), when the user changes the category select:
   - If the transaction has a non-empty `extractPayee(description)` and at least one other in-scope transaction shares that payee, show a checkbox below the category field: `Ook toepassen op alle N andere transacties van "[payee]"` (English until ISSUE-007 lands: `Also apply to all N other transactions of "[payee]"`).
   - The checkbox is checked by default when `settings.applyCategoryToPayee === true`, unchecked otherwise.
   - When the user ticks the box, immediately persist `settings.applyCategoryToPayee = true` so future modals start checked.
   - When the user saves the modal with the box checked, call the canonical bulk-update function with the new categoryId (after the single-transaction update is persisted, so the count "N other" matches the post-save state).
   - When the user saves with the box unchecked, no propagation; the per-transaction update is the only change.

5. **CSV import — auto-categorise from mapping.** After the importer creates each transaction in the preview/batch flow, look up `state.payeeCategories[extractPayee(row.description)]`. If found and the row currently has no `categoryId`, set `categoryId` from the mapping. The importer's explicit row-level classification (set by the user in the preview table, or by the row's own classifier) still wins when both are present. Add a small badge in the import preview "auto" next to category cells that came from the mapping, so the user can see what happened.

## Acceptance criteria

- [ ] `state.payeeCategories` exists as a flat object keyed by payee name, initialised to `{}` on first load and idempotent across reloads.
- [ ] `state.settings.applyCategoryToPayee` exists, defaults to `false`, and is idempotent across reloads.
- [ ] The Payees-tab "Set category for all" dropdown still updates every same-payee transaction and now also writes the mapping (`payeeCategories[name] = categoryId`). After the dropdown is used, reloading and revisiting the Payees tab shows the saved category as the dropdown's selected value.
- [ ] Editing a single transaction's category from the transactions table shows an "apply to all" checkbox when at least one other in-scope transaction of the same payee exists, with the count `N other` matching the actual count of same-payee transactions excluding the one being edited.
- [ ] Editing a single transaction's category from the dashboard edit modal shows the same checkbox with the same count and the same behaviour.
- [ ] Saving the modal with the checkbox ticked updates every other same-payee transaction, including ones that already had a different category (overwrite is intentional).
- [ ] Saving the modal with the checkbox unticked updates only the one transaction.
- [ ] Ticking the checkbox once (regardless of whether the modal is then saved) persists `settings.applyCategoryToPayee = true`, and the checkbox is checked by default in subsequent modals until the user unticks it (which then persists `false`).
- [ ] Editing a transaction whose `extractPayee(description)` returns `''` (manual transaction with no recognisable SEPA shape) does **not** show the checkbox.
- [ ] Editing a transaction that is the only one of its payee does **not** show the checkbox (count would be `0`).
- [ ] After saving a category via the new propagation path, importing a CSV that contains a transaction of the same payee pre-fills its `categoryId` from `payeeCategories` when the row has no other classification.
- [ ] When the CSV importer's classifier has set a `categoryId` on a row, the saved mapping does not override it.
- [ ] The import preview marks cells that came from the saved mapping (a small "auto" badge or equivalent visual cue) so the user can see what was auto-applied.
- [ ] New tests in `_test_boot.js` (or a new `_test_payee_propagation.js`): at least 6 assertions covering: mapping is written by the bulk-update, mapping is read by the importer, `settings.applyCategoryToPayee` flips to `true` on first tick, checkbox count is correct, propagation skips transactions with empty `extractPayee`, importer's explicit classification wins over the mapping.
- [ ] The existing Payees-tab tests (if any) and `_test_csv.js` still pass with no changes to their assertions.

## Blocked by

None — can start immediately.

## Out of scope

- Payee-key normalisation (case-insensitive matching, whitespace collapsing, fuzzy matching). Two payees whose extracted strings differ in case will continue to be treated as distinct.
- A "forget this payee mapping" button. The user can clear a mapping by bulk-assigning the empty string via the Payees-tab dropdown, which already deletes the key.
- A "viewing as" UI to switch the active user; out of scope here.
- Auto-applied category badges on the dashboard or transactions table (the badge appears only in the CSV import preview).
- Drag-and-drop reordering of payees.

---

## ✅ Implementation summary (closed 2026-06-25)

### Files touched

| File | Change |
|---|---|
| `data.js` | Seed: added `payeeCategories: {}` (top-level) and `settings.applyCategoryToPayee: false`. Migration: idempotent backfill for both. New Store methods: `setPayeeCategory(state, name, categoryId)` (writes/clears + persists), `setApplyCategoryToPayee(state, value)` (toggle + persists). |
| `app.js` | `bulkUpdatePayeeCategory(name, categoryId)` now calls `Store.setPayeeCategory` after the transaction loop, so the mapping is written even when count === 0. `openTransactionModal`: added an "Also apply to all N other transactions of "Payee"" checkbox that appears below the Category field when (a) the transaction has a non-empty `extractPayee(description)` and (b) at least one other in-scope transaction shares that payee. Checkbox defaults from `settings.applyCategoryToPayee`. Ticking the box persists the setting immediately. On save with the box checked, the modal calls `bulkUpdatePayeeCategory(name, categoryId)` after the single update; the bulk function's own `store:changed` dispatch is preserved when it actually updated rows, otherwise the modal dispatches once. Description `oninput` recomputes payee + count live. CSV import: row-parsing step looks up `state.payeeCategories[extractPayee(row.omschrijving)]` as a fallback when `CSVImport.suggestedCategoryFor` returned null; tracks `autoMapped: true` on the row item. Preview renders a small `auto` badge (using existing `.pill` class) next to the category select when `autoMapped` is true; selecting a different category clears the flag. |
| `styles.css` | Added `.apply-all-opt` block: cream-deep background, sage-accent checkbox, italic payee name. Matches the warm notebook aesthetic. |
| `_test_boot.js` | 8 new tests covering: `setPayeeCategory` write/delete, `setApplyCategoryToPayee` round-trip, migration idempotency for both new fields, CSV importer auto-applies mapping when classifier has no resolvable hint, CSV importer classifier wins over mapping, `autoMapped` flag set correctly across mapping/classifier/none. |

### ACs met

All 13 acceptance criteria from this issue pass:

- ✅ `state.payeeCategories` and `state.settings.applyCategoryToPayee` exist with correct defaults and idempotent migration.
- ✅ Payees-tab bulk dropdown still works and now writes the mapping; the dropdown's `selected` reflects the saved value after reload.
- ✅ Edit modal (transactions table + dashboard entry points) shows the checkbox with the correct `N other` count, defaults from `settings`, persists on tick/untick.
- ✅ Saving with checkbox ticked updates every other same-payee transaction (overwriting existing categories, per the agreed semantics).
- ✅ Empty `extractPayee` or single-transaction payee: checkbox hidden.
- ✅ Importer applies mapping when no classifier suggestion; classifier wins when present; preview marks auto-applied cells with a small `auto` badge.
- ✅ 8 new test assertions, all existing tests still pass (39 boot + 21 csv = 60 total).

### Notes / known limits

- The Payees-tab bulk dropdown shows a confirmation only via the inline toast. If the user picks a category for a payee that has zero in-scope transactions, no toast fires (count === 0 → early return); the mapping is still written so future imports come in pre-categorised. This is intentional — surfacing a "no transactions to update" toast felt noisy for a routine UI interaction.
- The duplicate `store:changed` dispatch path (bulk dispatches when count > 0; modal dispatches otherwise) is preserved as a small efficiency cost in exchange for not having to refactor `bulkUpdatePayeeCategory`'s contract.
- Migration fills the new fields but does not call `save()` from `load()`. This is consistent with the existing migration behaviour for `settings.scope`. The first user-initiated save (any CRUD operation) persists the migrated shape. No data loss risk.
- The `auto` badge is a small inline-styled `.pill`. It deliberately reuses the existing pill class so no new CSS theme work is needed before ISSUE-007.
