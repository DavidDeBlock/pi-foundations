# ISSUE-010 — Fix the re-render storm

## Parent

[PRD-003] Refactor for maintainability — `docs/PRD/PRD-003-refactor-for-maintainability.md`

## What to build

Today, every `store:changed` event triggers a full re-render of sidebar + topbar + view. The handler lives at `app.js:127–130`:

```js
window.addEventListener('store:changed', () => {
  state = Store.load();
  renderShell();
  renderView();
});
```

Saving a transaction tears down DOM the user can see (sidebar nav badges, topbar buttons) and rebuilds it. Fix this so the shell renders once and views re-render on store change.

### 1. Split the global handler

- `bindGlobal()` calls `renderShell()` exactly **once** at boot.
- A separate `store:changed` listener calls `renderView()` only.

### 2. Keep sidebar badges in sync without re-rendering

The sidebar's nav items carry live counts (transactions, categories, sources, users, payees needing category). Since the sidebar no longer re-renders, those counts must update in place. Approach:

- Add `data-badge-for="transactions"` etc. attributes to the badge `<span>`s when the sidebar is built.
- After `renderView()` runs, walk the sidebar and update the badge text from `state` for each known slot.

If a nav item is added or removed (e.g. a future "Reports" view), the sidebar re-renders — but this slice keeps that case out of scope. The five badges that exist today are stable.

### 3. Keep topbar pills in sync

The topbar's month picker and scope pills live inside the `renderTopbar()` tree, which is also part of the shell. Same approach: keep them mounted, but make their `state` reads explicit:

- Month picker: re-read `Fmt.currentMonthKey()` on `store:changed` and update the displayed label in place if the active month changed.
- Scope pills: re-read `state.settings.scope` and update the `active` class.

### 4. View-internal re-renders

Views can also subscribe to `store:changed` and re-render themselves; `renderView()` does this for the active view. The exact dispatch is unchanged from the existing pattern — only the shell's re-render is removed.

## Acceptance criteria

- [x] `bindGlobal` no longer calls `renderShell()` on `store:changed`.
- [x] `renderShell()` runs exactly once at boot.
- [x] Sidebar badge counts (transactions, categories, sources, users, payees needing category) update on store changes **without** re-rendering the sidebar.
- [x] Topbar month picker and scope pills update on store changes without re-rendering the topbar.
- [x] Saving a transaction does not tear down the sidebar or topbar DOM (verifiable: add `console.log` instrumentation in `renderSidebar()` / `renderTopbar()` and confirm they fire only once at boot).
- [x] `_test_boot.js` and `_test_selectors.js` still pass.
- [x] Manual smoke test: open and close modals, navigate views, edit data — sidebar and topbar remain visually stable; badges update correctly.

## Blocked by

[ISSUE-008](../ISSUES/ISSUE-008-dev-tooling-and-pure-layer-tests.md) — needs the test harness so regressions surface immediately.

## Out of scope

- View-internal subscriptions (already work).
- Splitting the shell into its own file (ISSUE-011).
- Switching to a virtual DOM diff. The current "tear down the active view subtree and rebuild" stays.

## Implementation log

Captured during implementation.

### What was built

- **`renderShell()` runs exactly once at boot.** A module-level `_shellRenderCount` counter increments inside `renderShell()` and is exposed on the public App surface as `App._shellRenderCount` plus a `_resetRenderCount()` helper so tests can assert it.
- **`bindGlobal()` no longer calls `renderShell()`** on `store:changed`. The handler now reloads `state` from `Store.load()` and calls `renderView()` only.
- **`goTo()` no longer calls `renderShell()`** on navigation. The active nav class is moved in place by `updateSidebarActiveClass()` from inside `renderView()`.
- **`navItem` factory** now stamps every badge `<span>` with `data-badge-for="<view-id>"` and always creates the span (initial visibility driven by the initial count). The pre-ISSUE-010 conditional `badge != null ? … : null` is gone.
- **`updateSidebarBadges()`** walks `#sidebar` for `[data-badge-for]` elements and rewrites their text + visibility from a fresh count snapshot. Payees badge hides when no payee is missing a category.
- **`updateSidebarActiveClass()`** walks `.nav-item` buttons in `#sidebar` and toggles the `active` class to match `view`.
- **`updateScopePills()`** walks `.scope-pill` buttons in `#scope-pills` and toggles the `active` class to match `state.settings.scope`.
- **`ensureMonthPicker()`** builds the picker once on first mount (via `renderMonthPicker()`) and updates only the `.mp-label` text on subsequent calls — the prev/next button identity is preserved.
- **`renderTopbar()`** now builds the scope pills inline (`renderScopeSelector(scopeHost)`) so they exist before `renderView()` first runs. `renderView()` then just toggles their active class.
- **`renderView()`** now:
  1. clears `#view` (the only subtree it tears down);
  2. updates page title/sub in place;
  3. updates add-txn-btn visibility in place;
  4. updates the month picker (`ensureMonthPicker()`);
  5. toggles scope pills in place (`updateScopePills()`);
  6. updates sidebar badges in place (`updateSidebarBadges()`);
  7. updates sidebar active class in place (`updateSidebarActiveClass()`);
  8. mounts the active view subtree.
- **`App._goTo`** exposed for tests so they can navigate without dispatching synthetic clicks.
- **Cache buster** bumped to `?v=14` on every script and `styles.css`.

### File-level changes

| File | Δ |
|---|---|
| `app.js` | −23 lines net (228 lines added for helpers + tests surface, 251 deleted for the removed `renderShell()` calls and redundant inline topbar rebuilds). |
| `index.html` | 1 line — `?v=13` → `?v=14`. |
| `_test_boot.js` | +135 lines — 6 new ISSUE-010 tests plus stub-harness upgrades. |

### Stub-harness upgrades (`_test_boot.js`)

- `matchSelector` now also handles attribute selectors (`[data-badge-for="…"]`, `[data-view="…"]`) in addition to `#id`, `.class`, `tag`, and space-separated compounds. Production code uses `[data-…]` lookups inside `updateSidebarBadges()`, `updateSidebarActiveClass()`, and `updateScopePills()`; without this, those lookups returned `null` and the tests would have spuriously failed.
- `documentStub.querySelector` / `querySelectorAll` now defer to `matchSelector` instead of only supporting tag names. The scope-pill test uses `document.querySelectorAll('.scope-pill')` to verify in-place updates.

### Verification

- **Stub** (`_test_boot.js`): 76/76 pass (was 70, +6 new ISSUE-010 tests).
- **CSV tests**: 21/21.
- **Selectors tests**: 73/73.
- **`npm run lint`**: 0 errors, 13 pre-existing warnings (none introduced).
- **Real-browser Playwright** (viewport 1280×900, `?v=14`): installed `MutationObserver` on `#sidebar` and `.topbar` to count childList mutations; **0 mutations** across a save + scope switch. Badges correctly show `1` transaction. Active scope pill correctly moves to `shared`. No page errors.

### Test count progression

| File | Before | After | New |
|---|---|---|---|
| `_test_csv.js` | 21 | 21 | 0 |
| `_test_boot.js` | 70 | 76 | +6 |
| `_test_selectors.js` | 73 | 73 | 0 |

### Known follow-ups (out of scope here)

- View-internal subscriptions — `renderView()` already runs on every `store:changed`, so each view re-mounts. Once views move into their own files (ISSUE-011), they can subscribe to `store:changed` themselves and only re-render the affected slices (e.g. the transactions table without the filter bar).
- If a future nav item is added or removed, the sidebar must be rebuilt — the five badges in scope today are stable. The architecture supports it: the existing `renderShell()` path stays intact; the in-place updaters just become unreachable for nav items added outside the boot-time list.