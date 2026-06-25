// =====================================================================
// shell.js — Sidebar + topbar + month picker + scope pills
// =====================================================================
// Runs once at boot. In-place updaters handle subsequent store changes
// (ISSUE-010). Router.renderView() calls into these for every state
// change; no full re-render happens after the initial mount.
// =====================================================================

const Shell = (() => {
  let _renderCount = 0;

  function render() {
    _renderCount++;
    const root = $('#app');
    root.innerHTML = '';
    root.appendChild(renderSidebar());
    root.appendChild(el('main', { class: 'main', id: 'main' },
      renderTopbar(),
      el('div', { id: 'view' }),
      el('div', { class: 'toast', id: 'toast' }),
    ));
  }

  // -- Sidebar (mounted once) ---------------------------------------
  function renderSidebar() {
    const txCount = App._state.transactions.length;
    const back = el('div', { class: 'sidebar-backdrop', id: 'sb-back', onclick: closeSidebar });
    document.body.appendChild(back);

    // Each nav badge gets a `data-badge-for` slot so updateSidebarBadges()
    // can find it and rewrite the text in place on store changes. The
    // badge span is always present; its visibility is toggled based on
    // the count (null/0 → hidden, > 0 → visible).
    const navItem = (id, label, icon, badge) =>
      el('button', { class: 'nav-item' + (Router.view === id ? ' active' : ''), 'data-view': id, onclick: () => Router.goTo(id) },
        el('span', { class: 'ni-icon', html: icon }),
        label,
        el('span', {
          class: 'ni-badge',
          'data-badge-for': id,
          style: { display: badge == null ? 'none' : '' },
        }, badge != null ? String(badge) : ''),
      );

    const payeesBadge = ViewHelpers.distinctPayees().filter(p => p.noCategory > 0).length || null;

    return el('aside', { class: 'sidebar', id: 'sidebar' },
      el('div', { class: 'brand' },
        el('div', { class: 'brand-mark', html: Logo }),
        el('div', {},
          el('div', { class: 'brand-name' }, t('brand.name')),
          el('div', { class: 'brand-sub' }, t('brand.tagline')),
        ),
      ),
      el('nav', { class: 'nav' },
        el('div', { class: 'nav-label' }, t('sidebar.label.overview')),
        navItem('dashboard',    t('nav.dashboard'),    Icons.home),
        navItem('trends',       t('nav.trends'),       Icons.trend),
        navItem('transactions', t('nav.transactions'), Icons.list, txCount),
        el('div', { class: 'nav-label' }, t('sidebar.label.manage')),
        navItem('categories',   t('nav.categories'),   Icons.tags, App._state.categories.length),
        navItem('sources',      t('nav.sources'),      Icons.wallet, App._state.sources.length),
        navItem('users',        t('nav.users'),        Icons.users, App._state.users.length),
        navItem('payees',       t('nav.payees'),       Icons.store, payeesBadge),
        el('div', { class: 'nav-label' }, t('sidebar.label.backup')),
        navItem('settings',     t('nav.settings'),     Icons.settings),
      ),
      el('div', { class: 'sidebar-foot' },
        el('strong', {}, t('sidebar.foot.title')),
        t('sidebar.foot.body')),
    );
  }

  // -- Topbar (mounted once; pills host pre-populated) --------------
  function renderTopbar() {
    // Scope pills are populated here so they exist before renderView
    // first runs. renderView() then just toggles their `active` class.
    const scopeHost = el('div', { class: 'scope-pills', id: 'scope-pills' });
    renderScopeSelector(scopeHost);
    return el('div', { class: 'topbar' },
      el('div', {},
        el('button', { class: 'menu-btn', onclick: openSidebar, html: Icons.menu }),
        el('div', { class: 'page-title', id: 'page-title' }, ''),
        el('div', { class: 'page-sub', id: 'page-sub' }, ''),
      ),
      el('div', { class: 'flex center gap-8' },
        el('div', { class: 'month-picker', id: 'month-picker' }),
        scopeHost,
        el('button', { class: 'btn btn-ghost', onclick: () => window.Modals.import(), id: 'import-btn', title: t('topbar.import.title') },
          el('span', { html: Icons.upload }), t('topbar.import')),
        el('button', { class: 'btn btn-primary', onclick: () => window.Modals.transaction(), id: 'add-txn-btn' },
          el('span', { html: Icons.plus }), t('topbar.add')),
      ),
    );
  }

  // -- Scope pills: Private / Shared / All --------------------------
  function renderScopeSelector(host) {
    if (!host) return;
    host.innerHTML = '';
    const current = App._state.settings && App._state.settings.scope;
    const opts = [
      { id: 'private', label: t('scope.private.label'), title: t('scope.private.title') },
      { id: 'shared',  label: t('scope.shared.label'),  title: t('scope.shared.title') },
      { id: 'all',     label: t('scope.all.label'),     title: t('scope.all.title') },
    ];
    for (const o of opts) {
      const active = current === o.id;
      host.appendChild(el('button', {
        class: 'scope-pill' + (active ? ' active' : ''),
        'data-scope': o.id,
        title: o.title,
        onclick: () => setScope(o.id),
      }, o.label));
    }
  }

  function setScope(id) {
    if (!window.SelectorScopes.includes(id)) return;
    if (App._state.settings && App._state.settings.scope === id) return;
    Store.setScope(App._state, id);
    window.dispatchEvent(new Event('store:changed'));
  }

  // -- Month picker --------------------------------------------------
  function renderMonthPicker(host) {
    host.innerHTML = '';
    const label = Fmt.monthLabel(Router.monthKey);
    host.appendChild(el('button', { title: t('month.prev'), onclick: () => { Router.shiftMonth(-1); }, html: Icons.chevLeft }));
    host.appendChild(el('div', { class: 'mp-label' }, label));
    host.appendChild(el('button', { title: t('month.next'), onclick: () => { Router.shiftMonth(1); }, html: Icons.chevRight }));
  }

  // The month picker lives inside the static topbar shell. On the
  // first call for a view that shows the picker, build the three child
  // elements (prev / label / next). On subsequent calls just rewrite
  // the label text. When the active view hides the picker, clear the
  // host so the empty space collapses.
  // ISSUE-015: dashboard no longer uses Router.monthKey — the period
  // selector owns the dashboard's time scope now. The picker is only
  // shown on the transactions view.
  function ensureMonthPicker() {
    const host = document.getElementById('month-picker');
    if (!host) return;
    const showMonth = (Router.view === 'transactions');
    if (!showMonth) { host.innerHTML = ''; return; }
    if (host.children.length === 0) {
      renderMonthPicker(host);
      return;
    }
    const label = host.querySelector('.mp-label');
    if (label) label.textContent = Fmt.monthLabel(Router.monthKey);
  }

  // -- Sidebar (mobile) ---------------------------------------------
  function openSidebar() { $('#sidebar').classList.add('open'); $('#sb-back').classList.add('show'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sb-back').classList.remove('show'); }

  // -- In-place shell updaters (ISSUE-010) --------------------------
  function updateSidebarBadges() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const counts = {
      transactions: App._state.transactions.length,
      categories: App._state.categories.length,
      sources: App._state.sources.length,
      users: App._state.users.length,
      payees: ViewHelpers.distinctPayees().filter(p => p.noCategory > 0).length || null,
    };
    for (const [key, count] of Object.entries(counts)) {
      const badge = sidebar.querySelector(`[data-badge-for="${key}"]`);
      if (!badge) continue;
      if (count == null) {
        badge.textContent = '';
        badge.style.display = 'none';
      } else {
        badge.textContent = String(count);
        badge.style.display = '';
      }
    }
  }

  function updateSidebarActiveClass() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    for (const btn of sidebar.querySelectorAll('.nav-item')) {
      if (btn.getAttribute('data-view') === Router.view) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  }

  function updateScopePills() {
    const host = document.getElementById('scope-pills');
    if (!host) return;
    const current = App._state.settings && App._state.settings.scope;
    for (const pill of host.querySelectorAll('.scope-pill')) {
      if (pill.getAttribute('data-scope') === current) pill.classList.add('active');
      else pill.classList.remove('active');
    }
  }

  return {
    render,
    openSidebar,
    closeSidebar,
    ensureMonthPicker,
    updateSidebarBadges,
    updateSidebarActiveClass,
    updateScopePills,
    getRenderCount() { return _renderCount; },
    resetRenderCount() { _renderCount = 0; },
  };
})();
window.Shell = Shell;
