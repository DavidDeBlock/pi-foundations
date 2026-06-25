# [PRD] Refactor for maintainability

## Problem Statement

Cozy Ledger has grown to **8 K LOC across 13 files**, with `app.js` alone at **2 443 lines** holding state, routing, 8 view renderers, 6 modal openers, and 2 SVG charts in a single IIFE. The codebase is otherwise healthy — clean Store / Selectors / Utils separation, no framework lock-in, runs from `file://` — but a handful of structural patterns now compound complexity and block Phase 2 work (recurring transactions, budgets, splits, export refinements):

1. **Re-render storm.** Every store mutation re-creates the sidebar, topbar, *and* view (`bindGlobal` at `app.js:127–130`). Saving a transaction tears down DOM that didn't change.
2. **Modal boilerplate.** Six modals (`openTransactionModal`, `openCategoryModal`, `openGroupModal`, `openSourceModal`, `openUserModal`, `openImportModal`) each repeat the same build-populate-bind-save dance; the biggest is 207 lines.
3. **Single-file monolith.** No file boundary between `renderCategories`, `renderPayees`, and `renderBalanceTrajectoryChart`. Adding a new view means growing the monolith.
4. **Untested pure layer.** `selectors.js` (290 lines of pure functions) and `Fmt.*` have no direct test coverage — only an end-to-end boot smoke test.
5. **No linter.** 8 K LOC of hand-written DOM glue with no static guardrails.

The goal of this PRD is to remove those frictions **without changing product behaviour**. Phase 2 features then ship faster because they land into a structure that already invites them.

## Solution

A targeted refactor in **five independently-shippable slices**, ordered so each one has the safety net it needs:

1. **Dev tooling + pure-layer tests.** ESLint as a devDependency (no runtime impact) and direct unit tests for every public function in `selectors.js` and `utils.js`. Establishes the guardrails all later slices rely on.
2. **Modal helper extraction.** New `modals/_helper.js` exposing `createModal({ title, fields, onSave, onDelete })`. Collapses the 6 modal openers into config + glue. Biggest single-slice line reduction.
3. **Re-render fix.** `bindGlobal` re-renders only the active view; sidebar badge counts update in place. Shell renders once at boot.
4. **File split.** `app.js` becomes state + router + shell + init (under 600 lines). Renderers move into `views/`, modals into `modals/`, charts into `charts/`. No bundler — `<script>` tags reordered in `index.html`.
5. **JSDoc typedefs.** `@typedef` blocks for the data model, `@param` / `@returns` on every public function. Free type-hints in editors; zero runtime cost.

Each slice ships green and can be reverted independently. No product behaviour changes. No new runtime dependencies. `python3 -m http.server` + `index.html` works the same way before and after.

## User Stories

1. As a developer, I want a linter running on every change, so that I catch typos and bad patterns before they ship.
2. As a developer, I want direct tests for every pure function in the app, so that I can refactor without fear.
3. As a developer, I want to add a new modal in under 80 lines of config, so that feature work isn't 200 lines of DOM glue.
4. As a user, I want the sidebar and topbar to stay mounted while I edit data, so that the app feels faster and doesn't lose scroll position.
5. As a developer, I want each view in its own file, so that I can find code by feature name instead of scrolling a 2 400-line file.
6. As a developer, I want type hints for the data model in my editor, so that I get inline feedback when I pass the wrong shape.

## Non-goals

- Switching to a framework (React / Vue / Svelte). The README's "no build, no deps" stance stays.
- Introducing a state management library. The `store:changed` event and `Store` API stay.
- Migrating from `<script>` tags to a bundler.
- Building Phase 2 features (recurring transactions, budgets, splits, export/import refinements, sync to a real backend).

## Success Criteria

- `app.js` is under **600 lines** and contains only state, routing, shell, and init.
- Each modal opener is under **80 lines**.
- Saving a transaction re-creates only the active view subtree — the sidebar and topbar remain stable across the save.
- Pure-layer test coverage exceeds **30 assertions** and runs in under 1 second.
- `npm run lint` passes with zero errors on the whole repo.
- `npm test` passes.
- End-user behaviour is unchanged: opening `index.html` (or serving with `python3 -m http.server`) produces the same UI and interactions.

## Risks

- **Behavioural regressions during the modal helper extraction.** Mitigated by ISSUE-008 (tests for the pure layer and a green boot smoke test before the refactor starts).
- **Scope creep into Phase 2 features.** Each issue is bounded by its acceptance criteria; PRD-002's features stay in PRD-002.
- **Re-render fix breaks a subscription.** The current `bindGlobal` re-render is wasteful but correct; any code that relied on the wasteful behaviour (e.g. reading stale DOM after a render) needs to be moved onto the new pattern. Test coverage surfaces this.
- **File-split circular imports.** Mitigated by loading `views/` and `modals/` after `data.js`, `utils.js`, `selectors.js`; the existing `index.html` script-tag chain already enforces the order.

## Open Questions

- **Lint config style.** Airbnb, Standard, or a minimal project-specific config? The PRD proposes minimal project-specific (browser globals + node globals per file). Confirm before ISSUE-008 lands.
- **Test runner.** `node:test` (built-in, zero deps) vs. Mocha (extra dep). PRD proposes `node:test`. Confirm.
- **Sidebar badge update mechanism.** In-place update vs. sidebar re-render only on data-shape change? PRD proposes in-place. Confirm.

## Slices

| # | Issue | Depends on | Goal |
|---|---|---|---|
| 1 | [ISSUE-008](../ISSUES/ISSUE-008-dev-tooling-and-pure-layer-tests.md) | — | Linter + tests for pure layer |
| 2 | [ISSUE-009](../ISSUES/ISSUE-009-modal-helper-extraction.md) | #1 | Collapse 6 modals into config + helper |
| 3 | [ISSUE-010](../ISSUES/ISSUE-010-fix-re-render-storm.md) | #1 | Shell renders once; views re-render on change |
| 4 | [ISSUE-011](../ISSUES/ISSUE-011-split-app-js-by-view.md) | #2, #3 | Move renderers into views/, modals/, charts/ |
| 5 | [ISSUE-012](../ISSUES/ISSUE-012-jsdoc-typedefs.md) | #1, #4 | JSDoc typedefs + per-function annotations |

## Next Step

Hand off to **Builder** with ISSUE-008 as the first slice.