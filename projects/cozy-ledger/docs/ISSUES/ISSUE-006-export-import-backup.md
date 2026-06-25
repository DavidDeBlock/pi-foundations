# ISSUE-006 — Export / Import backup (JSON full + CSV Excel) with dry-run

## Why

All data lives in one browser's `localStorage`. There is no way to take a backup, hand the file to a partner, move to a new laptop, or recover after a browser data wipe. The household has been actively using the app for months and would lose real data if anything went wrong.

This issue adds a Settings route with two export paths (a round-trippable JSON backup and a one-way CSV view of the transactions for Excel) and a replace-only JSON import with a dry-run preview and a pre-import safety snapshot.

## What to build

1. **New `Settings` sidebar route.** Add a sidebar entry `Settings` (becomes `Instellingen` after ISSUE-007). Hosts three controls:
   - Button: `Export → JSON (full backup)`.
   - Button: `Export → CSV (for Excel)`.
   - Button + hidden file input: `Import from JSON backup`.
   - A short help line under each control (one sentence, in English until ISSUE-007).

2. **JSON export.** Build a backup object:
   ```json
   {
     "schemaVersion": 1,
     "exportedAt": "<ISO 8601 UTC>",
     "app": "cozy-ledger",
     "state": { ...full state object, including settings, transactions, categories, sources, users, and groups (if present)... }
   }
   ```
   Download as `cozy-ledger-backup-YYYY-MM-DD.json` via a `Blob` + `URL.createObjectURL` + temporary `<a download>`. Inactive entities are included (they were real at the time). The exported `state` is a deep clone, not a reference.

3. **CSV export.** Transactions only. Standard CSV: comma-separated, dot decimal, ISO date `YYYY-MM-DD`, UTF-8 without BOM. Column header: `Date,Description,Amount,Type,Category,User,Source,Scope,Notes`. Rows are sorted by date descending. Category, user, and source are resolved to their display names; if an entity is missing (e.g. deleted after the transaction was created), the cell is empty. Download as `cozy-ledger-transactions-YYYY-MM-DD.csv`. CSV escaping follows RFC 4180: fields containing `,`, `"`, or newline are wrapped in `"` and inner `"` are doubled.

4. **JSON import — validation.** File picker (`.json` only). On file selected:
   - Read with `FileReader.readAsText` as UTF-8.
   - `JSON.parse` — on parse error, show a toast and abort.
   - Validate: `typeof data === 'object'`, `data.schemaVersion === 1`, `data.state` is an object.
   - On any validation failure, show a toast with the specific reason and abort. Do **not** mutate state.

5. **JSON import — dry-run preview.** On validation success, open a modal:
   - Title: `Import backup?`.
   - Body: counts derived from the parsed `data.state`:
     `This backup contains N transactions, M categories, P sources, Q users` (and `R groups` when present).
     Plus the backup's `exportedAt` and `schemaVersion`.
   - A short warning: `This will REPLACE all current data. A safety snapshot will be saved to localStorage first.`
   - Two buttons: `Cancel` (default) and `Replace current data`.

6. **JSON import — apply.** On confirm:
   - Write the current `state` to `localStorage.setItem('cozy_ledger_pre_import_backup', JSON.stringify({ savedAt: new Date().toISOString(), state: deepClone(state) }))`, overwriting any previous snapshot.
   - `Object.assign(state, parsed.state)` — every top-level key in `parsed.state` replaces the current value. Keys not present in `parsed.state` (e.g. `groups` on a pre-ISSUE-007 backup) are left alone.
   - `Store.save(state)` to persist immediately.
   - `window.dispatchEvent(new Event('store:changed'))`.
   - Close the modal, toast: `Imported N transactions.`
   - On any thrown error during apply, restore from the snapshot, toast the error, and leave state untouched.

7. **Schema versioning.** `Store.load()` is unchanged in this issue (no migration needed; the new `schemaVersion` is a backup-file concept, not a runtime one). If `schemaVersion` is missing or `!== 1` on import, refuse with a clear message: `Backup schema version X is not supported by this app version (expected 1).`

## Acceptance criteria

- [ ] A new `Settings` sidebar item renders and routes to a Settings view with the three controls.
- [ ] Clicking `Export → JSON (full backup)` downloads a file named `cozy-ledger-backup-YYYY-MM-DD.json` whose contents are a valid JSON object with `schemaVersion === 1`, an ISO 8601 `exportedAt`, `app === "cozy-ledger"`, and a `state` key containing every persisted collection.
- [ ] Exporting, then immediately importing the same file (replace), produces a state that is deep-equal to the pre-export state.
- [ ] Clicking `Export → CSV (for Excel)` downloads `cozy-ledger-transactions-YYYY-MM-DD.csv` with header `Date,Description,Amount,Type,Category,User,Source,Scope,Notes` and one row per transaction, sorted by date descending, with `,` and `"` correctly escaped per RFC 4180.
- [ ] CSV export resolves `categoryId` / `paidByUserId` / `sourceId` to display names; missing entities produce empty cells.
- [ ] Clicking `Import from JSON backup` opens a file picker accepting only `.json`.
- [ ] Selecting a valid backup opens the dry-run modal showing accurate counts of transactions, categories, sources, users, and (if present) groups, plus the backup's `exportedAt` and `schemaVersion`.
- [ ] Confirming the dry-run replaces state, persists immediately, fires `store:changed`, and shows the success toast.
- [ ] Cancelling the dry-run closes the modal and does not mutate state or `localStorage`.
- [ ] Before any successful import, the pre-import state is written to `localStorage.cozy_ledger_pre_import_backup` with a `savedAt` ISO timestamp, overwriting any prior snapshot.
- [ ] Selecting a JSON file with `schemaVersion !== 1` (or missing) shows a clear error toast and does not mutate state.
- [ ] Selecting a JSON file with a missing `state` key shows a clear error toast and does not mutate state.
- [ ] Selecting a malformed JSON file shows a clear error toast and does not mutate state.
- [ ] Selecting a valid backup that throws during apply (e.g. corrupted nested data) restores from the pre-import snapshot and shows the error toast.
- [ ] Pre-ISSUE-007 backups (no `groups` key) import cleanly: `state.groups` (if it exists) is left untouched and other collections are replaced.
- [ ] New tests in `_test_boot.js` (or a new `_test_backup.js`): at least 8 assertions covering: JSON round-trip deep-equal, CSV header and row count, CSV escaping for descriptions containing `,` and `"`, schema-mismatch refusal, missing-`state` refusal, malformed-JSON refusal, pre-import snapshot is written, CSV resolves names and handles missing entities.
- [ ] All existing tests still pass.

## Blocked by

None — can start immediately. Intentional that this lands before ISSUE-007 so the backup format captures the simpler state shape before groups are introduced.

## Out of scope

- Encrypted backups.
- Merging imported data into the existing data (replace-only).
- CSV import (the existing ING CSV importer is untouched).
- Periodic auto-backup or scheduled exports.
- "Restore from pre-import snapshot" UI — the snapshot exists in `localStorage.cozy_ledger_pre_import_backup` and a user with browser devtools can recover manually; a UI affordance for it is a future improvement.
- Picking between Belgian-locale CSV (semicolon, comma decimal, DD/MM/YYYY) and standard CSV (comma, dot decimal, ISO). Standard is used; Belgian format can be added later if needed.
- PDF export.
- Sharing via cloud storage integrations.
