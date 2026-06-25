// =====================================================================
// app.js — Bootstrap: state, init, global store:changed listener
// =====================================================================
// After ISSUE-009 (modal helper extraction), ISSUE-010 (re-render
// storm fix) and ISSUE-011 (split by view), app.js is the smallest
// piece in the system. It owns nothing but:
//   - `state` (loaded from Store on boot and after every store:changed)
//   - the boot sequence (Shell + initial Router render)
//   - the public API exposed on `window.App`
//
// View renderers live in views/*.js, the chrome (sidebar + topbar +
// month picker + scope pills) lives in shell.js, the route + dispatch
// logic lives in router.js, and modals live in modals/*.js.
// =====================================================================

const App = (() => {
  // ---- State --------------------------------------------------------
  // The state object is reloaded from `Store.load()` after every
  // `store:changed` event, so any module that reads `App._state` sees
  // the freshest copy without us having to broadcast individual
  // patches.
  let state = Store.load();

  function reloadState() {
    state = Store.load();
  }

  // ---- Boot ---------------------------------------------------------
  // ISSUE-010: `Shell.render()` runs exactly once at boot. After that,
  // store changes call `Router.renderView()` only; the sidebar and
  // topbar stay mounted and are updated in place (badges, active
  // classes, picker label, scope pills).
  function init() {
    Shell.render();
    Router.boot();         // ISSUE-013: restore persisted period from localStorage
    Router.renderView();
    bindGlobal();
  }

  function bindGlobal() {
    // ISSUE-010: re-render the active view after any store change, but
    // leave the shell alone. Router.renderView() updates sidebar
    // badges, the active nav class, scope pills, and the month picker
    // label in place; only `#view` is destroyed and rebuilt.
    window.addEventListener('store:changed', () => {
      reloadState();
      Router.renderView();
    });
  }

  // ---- Public API ---------------------------------------------------
  // Test surface for `_test_boot.js`:
  //   - `init()`                       — boot the app
  //   - `_state` (getter)              — current state object
  //   - `_shellRenderCount` (getter)   — how many times Shell.render ran
  //   - `_resetRenderCount()`          — reset the shell render counter
  //   - `_goTo(viewId)`                — navigate without dispatching
  //                                       a synthetic click event
  //   - `bulkUpdatePayeeCategory(...)` — used by both the transaction
  //                                       modal's applyAll checkbox
  //                                       (modals/transaction.js) and
  //                                       the payees view's bulk-assign
  //                                       dropdown (views/payees.js).
  //                                       Delegates to ViewHelpers.
  return {
    init,
    get _state() { return state; },
    get _shellRenderCount() { return Shell.getRenderCount(); },
    _resetRenderCount() { Shell.resetRenderCount(); },
    _goTo(viewId) { Router.goTo(viewId); },
    bulkUpdatePayeeCategory(name, categoryId) {
      ViewHelpers.bulkUpdatePayeeCategory(name, categoryId);
    },
  };
})();
window.App = App;
