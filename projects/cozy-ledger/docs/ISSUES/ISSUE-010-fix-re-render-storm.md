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

- [ ] `bindGlobal` no longer calls `renderShell()` on `store:changed`.
- [ ] `renderShell()` runs exactly once at boot.
- [ ] Sidebar badge counts (transactions, categories, sources, users, payees needing category) update on store changes **without** re-rendering the sidebar.
- [ ] Topbar month picker and scope pills update on store changes without re-rendering the topbar.
- [ ] Saving a transaction does not tear down the sidebar or topbar DOM (verifiable: add `console.log` instrumentation in `renderSidebar()` / `renderTopbar()` and confirm they fire only once at boot).
- [ ] `_test_boot.js` and `_test_selectors.js` still pass.
- [ ] Manual smoke test: open and close modals, navigate views, edit data — sidebar and topbar remain visually stable; badges update correctly.

## Blocked by

[ISSUE-008](../ISSUES/ISSUE-008-dev-tooling-and-pure-layer-tests.md) — needs the test harness so regressions surface immediately.

## Out of scope

- View-internal subscriptions (already work).
- Splitting the shell into its own file (ISSUE-011).
- Switching to a virtual DOM diff. The current "tear down the active view subtree and rebuild" stays.