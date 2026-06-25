# ISSUE-007 — Dutch UI + category groups

## Why

The household speaks Dutch in daily life and the bank statements are Belgian, but every visible string in the app is in English. Labels like "Spending share", "Need categorisation", "Top categories" feel like a translation layer rather than a native surface. While at it, the categories would benefit from a simple **grouping** layer (Wonen, Boodschappen, Vervoer, …) so charts and reports can roll up at a higher level without inventing subcategories. The user has been explicit: groups are a presentation concept, **not** subcategories — the `Transaction` model must not change.

## What to build

1. **Translation infrastructure.** New file `i18n.js` exposing a global `Strings` table and a `t(key)` helper:
   ```js
   const Strings = { nl: { 'nav.dashboard': 'Overzicht', /* ... */ } };
   function t(key) { return Strings.nl[key] ?? key; }
   ```
   `i18n.js` loads before `app.js` in `index.html` (next slot in the existing `<script>` chain). When a key is missing, `t(key)` returns the key string so missing translations are visible during development. There is no English fallback path — once a key exists, only the Dutch value is shipped.

2. **Translate every visible string.** Every user-facing string in `app.js`, `index.html`, and (if it renders anything) `selectors.js` is replaced with `t('key')`. Code identifiers, comments, console messages, and commit messages stay English. Major surfaces to translate (non-exhaustive — the build is "all visible strings, none missed"):
   - Sidebar nav items (Dashboard, Trends, Transactions, Categories, Sources, Users, Payees, Settings).
   - Page titles (`titles` map in `renderView`).
   - Summary cards (income, expenses, balance, shared vs private, distinct payees, need categorisation, etc.).
   - Filter labels (month, type, category, user, source, scope, payee).
   - Modal titles and form labels (Add transaction, Edit transaction, Categories, Sources, Users, Groups, Settings).
   - Button labels (Save, Cancel, Delete, Reset, Edit, Add, Import, Export, Replace, …).
   - Table headers (Date, Description, Category, Amount, User / Source, Scope, Need category, Last category, Last seen, Set category for all, Payee, Transactions, …).
   - Empty states.
   - Toasts (success, error, info).
   - CSV import preview headers and labels.
   - Balance flow chart card labels and tooltips.
   - Payees-tab specific strings.
   - Settings page (added by ISSUE-006).

3. **`groups` collection.** New persisted `state.groups = [{ id, name, color, icon, order }]`. `name` is Dutch. Migration in `Store.load()`: if absent, set to `[]` (idempotent).

4. **`groupId` on categories.** Add `groupId: string | null` to each category. Migration in `Store.load()`: for each existing category, look up the mapping table below and assign; categories not in the table get `groupId = null`. Idempotent: re-running does not change stored state.

5. **Seed groups.** Seed these eight groups on first run (after migration), each with a Dutch name, a colour drawn from the existing palette in `styles.css`, an emoji icon in the same style as the category icons, and an `order` field that sorts the groups in this sequence:

   | id | name | order | colour reference |
   |---|---|---|---|
   | `g_huis` | *Wonen* | 1 | sage `#7a8b94` |
   | `g_boodschappen` | *Boodschappen & eten* | 2 | warm orange `#c2714f` |
   | `g_vervoer` | *Vervoer* | 3 | forest `#3d5230` |
   | `g_media` | *Communicatie & media* | 4 | plum `#9a6b8a` |
   | `g_gezin` | *Gezin* | 5 | wood `#b8895c` |
   | `g_persoonlijk` | *Persoonlijk* | 6 | sage-green `#5a7248` |
   | `g_overig_uit` | *Overige uitgaven* | 7 | sand `#a4926b` |
   | `g_inkomen` | *Inkomen* | 8 | deep green `#3d5230` |

   Icons: `g_huis 🏠`, `g_boodschappen 🧺`, `g_vervoer 🚌`, `g_media 📡`, `g_gezin 🧸`, `g_persoonlijk 🌿`, `g_overig_uit ✦`, `g_inkomen 💼`.

6. **Category → group mapping (migration table).** Each existing seed category maps to one group:

   | categoryId | groupId |
   |---|---|
   | `c_rent`, `c_home_maint` | `g_huis` |
   | `c_eating`, `c_groceries` | `g_boodschappen` |
   | `c_transport`, `c_car` | `g_vervoer` |
   | `c_phone`, `c_internet`, `c_streaming` | `g_media` |
   | `c_family`, `c_pets`, `c_gifts` | `g_gezin` |
   | `c_clothing`, `c_medical`, `c_leisure` | `g_persoonlijk` |
   | `c_other_exp` | `g_overig_uit` |
   | `c_electricity`, `c_water`, `c_heating`, `c_insurance` | also `g_huis` (in addition to the first row) |
   | `c_salary`, `c_child_benefit`, `c_refunds`, `c_side`, `c_gifts_in`, `c_other_in` | `g_inkomen` |

   Categories created by the user after this issue ships start with `groupId = null`; they can be assigned to a group from the categories UI.

7. **Group management UI.** A new section in the existing Categories page (`renderCategories`), titled *Groepen*. Renders a card per group with name, icon, colour swatch, and an `Edit` button. The edit modal reuses the existing category-modal shape: name, colour (picker), icon (text input), order (number). Delete refuses if any category still references the group, with a clear Dutch message: *Deze groep wordt nog gebruikt door N categorieën en kan niet worden verwijderd.*

8. **Categories UI updates.** The categories list gains a `groupId` dropdown in the edit modal and a group column or visual grouping in the list (categories grouped under their group's name, with a small header per group; categories without a group fall under *Overige categorieën*).

9. **Filters and charts.** The transactions-list filter bar gains a `group` dropdown alongside `categoryId`, sourced from `state.groups`. The dashboard summary cards gain a "toon per groep" toggle that switches the breakdown from category-level to group-level totals (top categories card respects the toggle too). This is the first cut; further chart integration (Trends bar chart, balance chart) is **not** required for this issue.

## Acceptance criteria

- [ ] `i18n.js` exists, loads before `app.js` in `index.html`, and exposes `Strings` and `t()` on `window`.
- [ ] Every visible string in `app.js`, `index.html`, and `selectors.js` (if it renders) is replaced with `t('key')`; no English remains in the rendered UI on a fresh load with default seed data.
- [ ] Code identifiers, comments, console messages, and console output stay English.
- [ ] `state.groups` is persisted, defaults to `[]` on first load, idempotent across reloads.
- [ ] On first load after this issue ships, the eight seed groups exist with the exact Dutch names above and the listed `order` values.
- [ ] On first load after this issue ships, every existing seed category has a non-null `groupId` matching the mapping table; the migration is idempotent across reloads.
- [ ] A user-added category created after the migration starts with `groupId = null` and can be assigned to a group from the categories edit modal.
- [ ] The Categories page renders a *Groepen* section above or beside the existing categories list, with an edit and a delete affordance per group, in Dutch.
- [ ] Deleting a group that still has categories assigned refuses with the Dutch message above and does not mutate state.
- [ ] Editing a category in the existing modal shows a `groupId` dropdown listing all groups plus a *Geen groep* option; saving persists the chosen `groupId`.
- [ ] The transactions-list filter bar has a new `group` dropdown (Dutch label) sourced from `state.groups`; selecting a group filters the table to transactions whose category's `groupId` matches.
- [ ] The dashboard summary cards have a "toon per groep" toggle that, when active, replaces the per-category breakdown with per-group totals; the toggle is Dutch-labelled.
- [ ] The top-categories card on the dashboard respects the "toon per groep" toggle.
- [ ] Trends page and balance chart are not required to gain group integration in this issue; their existing behaviour is preserved.
- [ ] New tests in `_test_boot.js` (or a new `_test_i18n.js` / `_test_groups.js`): at least 6 assertions covering: every key in the `Strings.nl` table is non-empty, every required group exists after migration, every existing seed category has a non-null `groupId` after migration, migration is idempotent, deleting a group with assigned categories refuses, transactions-list group filter returns only same-group transactions.
- [ ] All existing tests still pass.

## Blocked by

None in principle — but logically follows ISSUE-006 so the backup format captures the simpler state shape before groups land. ISSUE-006 is the recommended ordering, not a hard dependency.

## Out of scope

- Subcategories or any deeper hierarchy than `Group → Category`. The user has explicitly excluded this.
- Drag-and-drop reordering of categories or groups; an `order` field is sufficient for now.
- Translating user-entered content (transaction descriptions, notes, payee names, custom category names, custom group names).
- Per-user groups or per-source groups.
- Group integration into the Trends bar chart, the balance-over-time chart, or the yearly reports feature (deferred per user).
- A "move all categories from group A to group B" bulk action.
- Switching the UI language back to English. There is one language, Dutch.
