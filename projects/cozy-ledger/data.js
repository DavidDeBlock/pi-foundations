// =====================================================================
// data.js — Storage layer + seed data
// All app state persists to localStorage. No backend, no bank sync.
// Easy to swap for a real API later by replacing `Store` methods.
// =====================================================================

const Store = (() => {
  const KEY = 'cozy-ledger-v1';

  // ---- Seed data (first run) -----------------------------------------
  /**
   * Build the initial in-memory state. `groups` is intentionally omitted;
   * `migrate()` backfills it from SEED_GROUPS on every load.
   * @returns {State}
   */
  const seed = () => {
    const today = new Date();
    const ym = (y, m, d) => new Date(y, m - 1, d).toISOString().slice(0, 10);
    const yr = today.getFullYear();
    const mo = today.getMonth() + 1;

    return /** @type {State} */ ({
      users: [
        { id: 'u_david',    name: 'David',    color: '#5a7248', active: true },
        { id: 'u_isabelle', name: 'Isabelle', color: '#b8895c', active: true },
      ],
      sources: [
        { id: 's_david',    name: 'David private',    type: 'bank',  ownerId: 'u_david',    active: true, balance: 0 },
        { id: 's_isabelle', name: 'Isabelle private', type: 'bank',  ownerId: 'u_isabelle', active: true, balance: 0 },
        { id: 's_joint',    name: 'Joint account',    type: 'bank',  ownerId: null,        active: true, balance: 0 },
        { id: 's_cash',     name: 'Cash',             type: 'cash',  ownerId: null,        active: true, balance: 0 },
        { id: 's_savings',  name: 'Savings',          type: 'savings', ownerId: null,      active: true, balance: 0 },
      ],
      categories: [
        // Expense — soft, warm, sage-leaning palette
        { id: 'c_groceries',     name: 'Groceries',         type: 'expense', color: '#7a8b94', icon: '🧺', active: true },
        { id: 'c_eating',        name: 'Eating out',        type: 'expense', color: '#c2714f', icon: '🍞', active: true },
        { id: 'c_streaming',     name: 'Netflix / streaming', type: 'expense', color: '#9a6b8a', icon: '🎬', active: true },
        { id: 'c_phone',         name: 'Phone',             type: 'expense', color: '#5a7248', icon: '📱', active: true },
        { id: 'c_internet',      name: 'Internet',          type: 'expense', color: '#3d5230', icon: '📡', active: true },
        { id: 'c_insurance',     name: 'Insurance',         type: 'expense', color: '#7a8b94', icon: '🛟', active: true },
        { id: 'c_water',         name: 'Water',             type: 'expense', color: '#96a884', icon: '💧', active: true },
        { id: 'c_electricity',   name: 'Electricity',       type: 'expense', color: '#d4ad7f', icon: '⚡', active: true },
        { id: 'c_heating',       name: 'Heating',           type: 'expense', color: '#b8895c', icon: '🔥', active: true },
        { id: 'c_rent',          name: 'Rent / mortgage',   type: 'expense', color: '#8a6340', icon: '🏠', active: true },
        { id: 'c_home_maint',    name: 'Home maintenance',  type: 'expense', color: '#a4926b', icon: '🛠️', active: true },
        { id: 'c_transport',     name: 'Transport',         type: 'expense', color: '#5a7248', icon: '🚌', active: true },
        { id: 'c_car',           name: 'Car / bike',        type: 'expense', color: '#3d5230', icon: '🚲', active: true },
        { id: 'c_medical',       name: 'Medical',           type: 'expense', color: '#c2714f', icon: '🩺', active: true },
        { id: 'c_clothing',      name: 'Clothing',          type: 'expense', color: '#9a6b8a', icon: '🧵', active: true },
        { id: 'c_family',        name: 'Child / family',    type: 'expense', color: '#b8895c', icon: '🧸', active: true },
        { id: 'c_pets',          name: 'Pets',              type: 'expense', color: '#7a8b94', icon: '🐾', active: true },
        { id: 'c_gifts',         name: 'Gifts',             type: 'expense', color: '#d4ad7f', icon: '🎁', active: true },
        { id: 'c_leisure',       name: 'Leisure',           type: 'expense', color: '#5a7248', icon: '🌿', active: true },
        { id: 'c_other_exp',     name: 'Other',             type: 'expense', color: '#a4926b', icon: '✦', active: true },
        // Income
        { id: 'c_salary',        name: 'Salary',            type: 'income',  color: '#3d5230', icon: '💼', active: true },
        { id: 'c_child_benefit', name: 'Child benefits',    type: 'income',  color: '#5a7248', icon: '🌱', active: true },
        { id: 'c_refunds',       name: 'Refunds',           type: 'income',  color: '#7a8b94', icon: '↺', active: true },
        { id: 'c_side',          name: 'Side income',       type: 'income',  color: '#b8895c', icon: '✨', active: true },
        { id: 'c_gifts_in',      name: 'Gifts received',    type: 'income',  color: '#c2714f', icon: '🎀', active: true },
        { id: 'c_other_in',      name: 'Other income',      type: 'income',  color: '#9a6b8a', icon: '✦', active: true },
      ],
      transactions: [],
      // (Seeded sample transactions removed — start with an empty ledger
      //  so CSV imports are the only thing in there. Users, sources, and
      //  categories are still seeded above.)
      settings: {
        currentUserId: 'u_david',  // first user; can be changed via Store.setCurrentUserId
        scope: 'private',          // 'private' | 'shared' | 'all' — dashboard scope
        applyCategoryToPayee: false, // ISSUE-005: tick "apply to all" by default in edit modal
        dashboardByGroup: false,     // ISSUE-007: roll dashboard cards up at the group level
      },
      // ISSUE-005: payeeName (as returned by CSVImport.extractPayee) → categoryId.
      // Written by the bulk-edit path; read by the CSV importer to pre-fill
      // categoryId on rows that have no classifier-suggested category.
      payeeCategories: {},
      // ISSUE-007: presentation-layer grouping over categories. The seed
      // itself intentionally leaves this undefined — the migration in
      // Store.load() fills it from SEED_GROUPS on first ever load and on
      // every upgrade from a pre-ISSUE-007 install.
    });
  };

  // ---- Helpers -------------------------------------------------------
  function uid() { return 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function now() { return new Date().toISOString(); }
  // Local rounding helper (the one in selectors.js isn't visible from
  // inside this IIFE, and goal.funded is the only place that needs it
  // for now — fundingHistory entries preserve full cents via Math.abs).
  function round2(n) { return Math.round(n * 100) / 100; }

  // ---- ISSUE-007: seed groups + category→group migration table -------
  // Each seed category carries a `groupId` referencing one of these. The
  // mapping is applied only when a category lacks a groupId (idempotent:
  // user-chosen groupIds are not overwritten). Order sorts the Groepen
  // section and the categories list.
  const SEED_GROUPS = [
    { id: 'g_huis',         name: 'Wonen',                order: 1, color: '#7a8b94', icon: '🏠' },
    { id: 'g_boodschappen', name: 'Boodschappen & eten',  order: 2, color: '#c2714f', icon: '🧺' },
    { id: 'g_vervoer',      name: 'Vervoer',              order: 3, color: '#3d5230', icon: '🚌' },
    { id: 'g_media',        name: 'Communicatie & media', order: 4, color: '#9a6b8a', icon: '📡' },
    { id: 'g_gezin',        name: 'Gezin',                order: 5, color: '#b8895c', icon: '🧸' },
    { id: 'g_persoonlijk',  name: 'Persoonlijk',          order: 6, color: '#5a7248', icon: '🌿' },
    { id: 'g_overig_uit',   name: 'Overige uitgaven',     order: 7, color: '#a4926b', icon: '✦' },
    { id: 'g_inkomen',      name: 'Inkomen',              order: 8, color: '#3d5230', icon: '💼' },
  ];

  // First time this issue ships, every seed category below gets the
  // matching groupId. Categories created by the user after migration
  // start with groupId = null (they can be assigned from the UI).
  const CATEGORY_GROUP_MAP = {
    c_rent:           'g_huis',
    c_home_maint:     'g_huis',
    c_electricity:    'g_huis',
    c_water:          'g_huis',
    c_heating:        'g_huis',
    c_insurance:      'g_huis',
    c_eating:         'g_boodschappen',
    c_groceries:      'g_boodschappen',
    c_transport:      'g_vervoer',
    c_car:            'g_vervoer',
    c_phone:          'g_media',
    c_internet:       'g_media',
    c_streaming:      'g_media',
    c_family:         'g_gezin',
    c_pets:           'g_gezin',
    c_gifts:          'g_gezin',
    c_clothing:       'g_persoonlijk',
    c_medical:        'g_persoonlijk',
    c_leisure:        'g_persoonlijk',
    c_other_exp:      'g_overig_uit',
    c_salary:         'g_inkomen',
    c_child_benefit:  'g_inkomen',
    c_refunds:        'g_inkomen',
    c_side:           'g_inkomen',
    c_gifts_in:       'g_inkomen',
    c_other_in:       'g_inkomen',
  };

  // Idempotent migration: backfills any missing fields with their defaults
  // and normalises invalid values. Safe to run on every load.
  const VALID_SCOPES = ['private', 'shared', 'all'];
  function migrate(state) {
    if (!state.settings || typeof state.settings !== 'object') {
      state.settings = {};
    }
    if (!state.users || state.users.length === 0) {
      // Without a user list, leave currentUserId empty; the selectors fall back gracefully.
      if (!state.settings.currentUserId) state.settings.currentUserId = '';
    } else if (!state.settings.currentUserId || !state.users.some(u => u.id === state.settings.currentUserId)) {
      state.settings.currentUserId = state.users[0].id;
    }
    if (!VALID_SCOPES.includes(state.settings.scope)) {
      state.settings.scope = 'private';
    }
    // ISSUE-005: persisted flag controlling the edit-modal "apply to all" default.
    if (typeof state.settings.applyCategoryToPayee !== 'boolean') {
      state.settings.applyCategoryToPayee = false;
    }
    if (Array.isArray(state.sources)) {
      for (const s of state.sources) {
        if (typeof s.balance !== 'number' || !isFinite(s.balance)) s.balance = 0;
      }
    }
    // ISSUE-005: payee → category mapping. Always present, flat object.
    if (!state.payeeCategories || typeof state.payeeCategories !== 'object' || Array.isArray(state.payeeCategories)) {
      state.payeeCategories = {};
    }
    // ISSUE-007: dashboard toggle persisted across sessions. Defaults to
    // false so users see the per-category breakdown first.
    if (typeof state.settings.dashboardByGroup !== 'boolean') {
      state.settings.dashboardByGroup = false;
    }
    // ISSUE-007: groups collection. Backfill with the seed list on first
    // run (state.groups === undefined). On subsequent runs, leave the
    // user-edited list alone. Idempotent.
    if (!Array.isArray(state.groups)) {
      state.groups = SEED_GROUPS.map(g => ({ ...g }));
    }
    // ISSUE-007: category → group mapping. Backfill any seed category
    // that lacks a groupId; leave user-set groupIds alone. Idempotent.
    if (Array.isArray(state.categories)) {
      for (const c of state.categories) {
        if (c.groupId == null && CATEGORY_GROUP_MAP[c.id]) {
          c.groupId = CATEGORY_GROUP_MAP[c.id];
        }
      }
    }
    // ISSUE-017: savings goals. Optional in State — backfill with an
    // empty list so renderers never see `state.goals === undefined`.
    if (!Array.isArray(state.goals)) {
      state.goals = [];
    } else {
      // Normalise any pre-existing entries: clamp funded to a number,
      // ensure fundingHistory is an array, etc. Safe to run on every
      // load — new fields on existing goals fall back to their defaults.
      for (const g of state.goals) {
        if (typeof g.funded !== 'number' || !isFinite(g.funded)) g.funded = 0;
        if (typeof g.target !== 'number' || !isFinite(g.target)) g.target = 0;
        if (!Array.isArray(g.fundingHistory)) g.fundingHistory = [];
        if (typeof g.notes !== 'string') g.notes = '';
        if (g.targetDate == null) g.targetDate = null;
      }
    }
    // ISSUE-018: spending caps. Optional in State — backfill with an
    // empty list. Normalisation is per-entry; legacy saves are unlikely
    // but the migration is idempotent and cheap.
    if (!Array.isArray(state.envelopes)) {
      state.envelopes = [];
    } else {
      for (const e of state.envelopes) {
        if (!Array.isArray(e.categoryIds)) e.categoryIds = [];
        if (!Array.isArray(e.payeeIds)) e.payeeIds = [];
        if (typeof e.notes !== 'string') e.notes = '';
        if (e.period !== 'monthly' && e.period !== 'yearly') e.period = 'monthly';
        if (typeof e.cap !== 'number' || !isFinite(e.cap)) e.cap = 0;
      }
    }
    return state;
  }

  /**
   * Load the persisted state, applying migrations. Seeds on first run.
   * @returns {State}
   */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) {
        const s = /** @type {State} */ (seed());
        migrate(s);
        save(s);
        return s;
      }
      return migrate(JSON.parse(raw));
    } catch (e) {
      console.warn('Store load failed, reseeding', e);
      const s = /** @type {State} */ (seed());
      migrate(s);
      save(s);
      return s;
    }
  }

  /**
   * Persist the in-memory state to localStorage.
   * @param {State} state
   * @returns {void}
   */
  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  /**
   * Wipe localStorage and reseed. Used by tests and the Settings reset button.
   * @returns {State}
   */
  function reset() {
    localStorage.removeItem(KEY);
    return load();
  }

  // ---- Public CRUD API ----------------------------------------------
  return {
    /**
     * Load the persisted state, applying migrations. Seeds on first run.
     * @returns {State}
     */
    load,

    /**
     * Persist state to localStorage.
     * @param {State} state
     * @returns {void}
     */
    save,

    /**
     * Wipe localStorage and reseed. Used by tests and the Settings reset button.
     * @returns {State}
     */
    reset,

    /**
     * Generate a short random id. Useful for tests and ad-hoc inserts.
     * @returns {string}
     */
    uid,

    /**
     * Current time as an ISO 8601 string.
     * @returns {string}
     */
    now,

    // Transactions
    /**
     * All transactions, newest first. Does not mutate state.
     * @param {State} state
     * @returns {Transaction[]}
     */
    listTransactions(state) { return [...state.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)); },

    /**
     * Append a transaction. Assigns id, createdAt, updatedAt. Persists.
     * @param {State} state
     * @param {Partial<Transaction>} t
     * @returns {Transaction}
     */
    addTransaction(state, t) {
      const txn = /** @type {Transaction} */ ({ id: uid(), createdAt: now(), updatedAt: now(), ...t });
      state.transactions.push(txn);
      save(state);
      return txn;
    },

    /**
     * Patch a transaction by id. Stamps updatedAt. Returns null if no match.
     * @param {State} state
     * @param {string} id
     * @param {Partial<Transaction>} patch
     * @returns {Transaction|null}
     */
    updateTransaction(state, id, patch) {
      const idx = state.transactions.findIndex(t => t.id === id);
      if (idx === -1) return null;
      state.transactions[idx] = { ...state.transactions[idx], ...patch, updatedAt: now() };
      save(state);
      return state.transactions[idx];
    },

    /**
     * Remove a transaction by id. Persists. No-op if not found.
     * @param {State} state
     * @param {string} id
     * @returns {void}
     */
    deleteTransaction(state, id) {
      state.transactions = state.transactions.filter(t => t.id !== id);
      save(state);
    },

    // Categories
    /**
     * Append a category. Assigns id and active=true. Persists.
     * @param {State} state
     * @param {Partial<Category>} c
     * @returns {Category}
     */
    addCategory(state, c) { const cat = /** @type {Category} */ ({ id: uid(), active: true, ...c }); state.categories.push(cat); save(state); return cat; },

    /**
     * Patch a category by id. Returns null if no match.
     * @param {State} state
     * @param {string} id
     * @param {Partial<Category>} patch
     * @returns {Category|null}
     */
    updateCategory(state, id, patch) {
      const idx = state.categories.findIndex(c => c.id === id);
      if (idx === -1) return null;
      state.categories[idx] = { ...state.categories[idx], ...patch };
      save(state);
      return state.categories[idx];
    },

    /**
     * Remove a category by id. The UI checks for in-use categories first.
     * @param {State} state
     * @param {string} id
     * @returns {void}
     */
    deleteCategory(state, id) {
      state.categories = state.categories.filter(c => c.id !== id);
      save(state);
    },

    // Sources
    /**
     * Append a source. Assigns id, active=true, balance=0. Persists.
     * @param {State} state
     * @param {Partial<Source>} s
     * @returns {Source}
     */
    addSource(state, s) { const src = /** @type {Source} */ ({ id: uid(), active: true, balance: 0, ...s }); state.sources.push(src); save(state); return src; },

    /**
     * Patch a source by id. Returns null if no match.
     * @param {State} state
     * @param {string} id
     * @param {Partial<Source>} patch
     * @returns {Source|null}
     */
    updateSource(state, id, patch) {
      const idx = state.sources.findIndex(s => s.id === id);
      if (idx === -1) return null;
      state.sources[idx] = { ...state.sources[idx], ...patch };
      save(state);
      return state.sources[idx];
    },

    /**
     * Remove a source by id. Persists. No-op if not found.
     * @param {State} state
     * @param {string} id
     * @returns {void}
     */
    deleteSource(state, id) { state.sources = state.sources.filter(s => s.id !== id); save(state); },

    // Users
    /**
     * Append a user. Assigns id and active=true. Persists.
     * @param {State} state
     * @param {Partial<User>} u
     * @returns {User}
     */
    addUser(state, u) { const usr = /** @type {User} */ ({ id: uid(), active: true, ...u }); state.users.push(usr); save(state); return usr; },

    /**
     * Patch a user by id. Returns null if no match.
     * @param {State} state
     * @param {string} id
     * @param {Partial<User>} patch
     * @returns {User|null}
     */
    updateUser(state, id, patch) {
      const idx = state.users.findIndex(u => u.id === id);
      if (idx === -1) return null;
      state.users[idx] = { ...state.users[idx], ...patch };
      save(state);
      return state.users[idx];
    },

    /**
     * Remove a user by id. Persists. No-op if not found.
     * @param {State} state
     * @param {string} id
     * @returns {void}
     */
    deleteUser(state, id) { state.users = state.users.filter(u => u.id !== id); save(state); },

    // Settings — scope and current viewer. Validates inputs; no-ops on invalid.
    /**
     * Set the dashboard / chart scope. Invalid values are ignored.
     * @param {State} state
     * @param {Scope} scope
     * @returns {State}
     */
    setScope(state, scope) {
      if (!VALID_SCOPES.includes(scope)) return state;
      if (!state.settings || typeof state.settings !== 'object') state.settings = /** @type {Settings} */ ({});
      state.settings.scope = scope;
      save(state);
      return state;
    },

    /**
     * Set the active viewer. Unknown ids are ignored.
     * @param {State} state
     * @param {string} userId
     * @returns {State}
     */
    setCurrentUserId(state, userId) {
      if (!state.users || !state.users.some(u => u.id === userId)) return state;
      if (!state.settings || typeof state.settings !== 'object') state.settings = /** @type {Settings} */ ({});
      state.settings.currentUserId = userId;
      save(state);
      return state;
    },

    // ISSUE-005: persisted flag that defaults the edit-modal "apply to all"
    // checkbox. Flipped on by ticking the checkbox at least once.
    /**
     * Toggle the default value of the edit-modal "apply to all" checkbox.
     * @param {State} state
     * @param {boolean} value
     * @returns {State}
     */
    setApplyCategoryToPayee(state, value) {
      if (!state.settings || typeof state.settings !== 'object') state.settings = /** @type {Settings} */ ({});
      state.settings.applyCategoryToPayee = !!value;
      save(state);
      return state;
    },

    // ISSUE-005: write or clear a payee → category mapping. Empty
    // categoryId deletes the key. Always persists and returns state.
    /**
     * Persist a payee → category mapping. Empty categoryId clears the entry.
     * @param {State} state
     * @param {string} payeeName
     * @param {string} categoryId
     * @returns {State}
     */
    setPayeeCategory(state, payeeName, categoryId) {
      if (!payeeName) return state;
      if (!state.payeeCategories || typeof state.payeeCategories !== 'object' || Array.isArray(state.payeeCategories)) {
        state.payeeCategories = {};
      }
      if (categoryId) state.payeeCategories[payeeName] = categoryId;
      else delete state.payeeCategories[payeeName];
      save(state);
      return state;
    },

    // ISSUE-007: dashboard toggle persisted across sessions.
    /**
     * Toggle the "roll dashboard up at the group level" preference.
     * @param {State} state
     * @param {boolean} value
     * @returns {State}
     */
    setDashboardByGroup(state, value) {
      if (!state.settings || typeof state.settings !== 'object') state.settings = /** @type {Settings} */ ({});
      state.settings.dashboardByGroup = !!value;
      save(state);
      return state;
    },

    // ISSUE-007: groups CRUD. Groups are an ordered presentation layer
    // over categories; deleting a group is the caller's responsibility
    // (the UI checks for assigned categories before calling delete).
    /**
     * Append a group. Assigns id, order, active=true. Persists.
     * @param {State} state
     * @param {Partial<Group>} g
     * @returns {Group}
     */
    addGroup(state, g) {
      const grp = /** @type {Group} */ ({ id: uid(), order: (state.groups?.length || 0) + 1, active: true, ...g });
      if (!Array.isArray(state.groups)) state.groups = [];
      state.groups.push(grp);
      save(state);
      return grp;
    },

    /**
     * Patch a group by id. Returns null if no match.
     * @param {State} state
     * @param {string} id
     * @param {Partial<Group>} patch
     * @returns {Group|null}
     */
    updateGroup(state, id, patch) {
      const idx = (state.groups || []).findIndex(g => g.id === id);
      if (idx === -1) return null;
      state.groups[idx] = { ...state.groups[idx], ...patch };
      save(state);
      return state.groups[idx];
    },

    /**
     * Remove a group by id. Persists. Categories retain their (now stale) groupId.
     * @param {State} state
     * @param {string} id
     * @returns {void}
     */
    deleteGroup(state, id) {
      state.groups = (state.groups || []).filter(g => g.id !== id);
      // Categories keep their (now-stale) groupId; the UI ignores
      // groupIds that no longer resolve to a group.
      save(state);
    },

    // Goals (ISSUE-017). A goal is pure accumulation toward a target —
    // no transaction plumbing yet (envelopes come next). `funded` and
    // `fundingHistory` are only mutated through `fundGoal` so the
    // history is always consistent with the running total.
    /**
     * Append a new goal. Validates `name` (non-empty after trim) and
     * `target` (> 0); throws on invalid input. Stamps id + timestamps.
     * @param {State} state
     * @param {Partial<Goal>} g
     * @returns {Goal}
     */
    addGoal(state, g) {
      const name = (g && g.name && String(g.name).trim()) || '';
      const target = Number(g && g.target);
      if (!name) throw new Error('Store.addGoal: name is required');
      if (!isFinite(target) || target <= 0) throw new Error('Store.addGoal: target must be > 0');
      if (!Array.isArray(state.goals)) state.goals = [];
      const goal = /** @type {Goal} */ ({
        id: uid(),
        name,
        target,
        funded: 0,
        targetDate: (g && g.targetDate) || null,
        notes: (g && g.notes) || '',
        fundingHistory: [],
        createdAt: now(),
        updatedAt: now(),
      });
      state.goals.push(goal);
      save(state);
      return goal;
    },

    /**
     * Patch a goal's editable fields. Refuses to change `id`, `funded`,
     * `fundingHistory` (those go through `fundGoal`). Returns null if
     * no match.
     * @param {State} state
     * @param {string} id
     * @param {Partial<Goal>} patch
     * @returns {Goal|null}
     */
    updateGoal(state, id, patch) {
      const goals = Array.isArray(state.goals) ? state.goals : [];
      const idx = goals.findIndex(g => g.id === id);
      if (idx === -1) return null;
      const safe = { ...patch };
      delete safe.id;
      delete safe.funded;
      delete safe.fundingHistory;
      delete safe.createdAt;
      // Validate target if supplied.
      if (safe.target !== undefined) {
        const n = Number(safe.target);
        if (!isFinite(n) || n <= 0) return null;
        safe.target = n;
      }
      if (safe.name !== undefined) {
        const trimmed = String(safe.name).trim();
        if (!trimmed) return null;
        safe.name = trimmed;
      }
      goals[idx] = { ...goals[idx], ...safe, updatedAt: now() };
      save(state);
      return goals[idx];
    },

    /**
     * Remove a goal by id. Persists. No-op if not found.
     * @param {State} state
     * @param {string} id
     * @returns {void}
     */
    deleteGoal(state, id) {
      if (!Array.isArray(state.goals)) return;
      state.goals = state.goals.filter(g => g.id !== id);
      save(state);
    },

    /**
     * Append a deposit to a goal's funding history and bump its
     * running total. Validates `amount > 0`; defaults `date` to today.
     * Returns the patched goal, or null if no match.
     * @param {State} state
     * @param {string} id
     * @param {{ date?: string, amount: number }} deposit
     * @returns {Goal|null}
     */
    fundGoal(state, id, deposit) {
      const goals = Array.isArray(state.goals) ? state.goals : [];
      const idx = goals.findIndex(g => g.id === id);
      if (idx === -1) return null;
      const amt = Number(deposit && deposit.amount);
      if (!isFinite(amt) || amt <= 0) return null;
      const date = (deposit && deposit.date) || new Date().toISOString().slice(0, 10);
      const goal = goals[idx];
      if (!Array.isArray(goal.fundingHistory)) goal.fundingHistory = [];
      goal.fundingHistory.push({ date, amount: Math.abs(amt) });
      goal.funded = round2((Number(goal.funded) || 0) + Math.abs(amt));
      goal.updatedAt = now();
      save(state);
      return goal;
    },

    // Envelopes (ISSUE-018). A cap on spend for a set of categories
    // and/or payees over a rolling window (monthly / yearly). Pure
    // CRUD — the per-envelope spend computation lives in Selectors
    // so it can be tested without booting the app.
    /**
     * Append a new envelope. Validates name (non-empty after trim),
     * cap (> 0), period ('monthly'|'yearly'). Throws on invalid input.
     * @param {State} state
     * @param {Partial<Envelope>} e
     * @returns {Envelope}
     */
    addEnvelope(state, e) {
      const name = (e && e.name && String(e.name).trim()) || '';
      const cap = Number(e && e.cap);
      const period = e && e.period;
      if (!name) throw new Error('Store.addEnvelope: name is required');
      if (!isFinite(cap) || cap <= 0) throw new Error('Store.addEnvelope: cap must be > 0');
      if (period !== 'monthly' && period !== 'yearly') {
        throw new Error("Store.addEnvelope: period must be 'monthly' or 'yearly'");
      }
      if (!Array.isArray(state.envelopes)) state.envelopes = [];
      const env = /** @type {Envelope} */ ({
        id: uid(),
        name,
        cap,
        period,
        categoryIds: Array.isArray(e.categoryIds) ? e.categoryIds.slice() : [],
        payeeIds: Array.isArray(e.payeeIds) ? e.payeeIds.slice() : [],
        notes: (e && e.notes) || '',
        createdAt: now(),
        updatedAt: now(),
      });
      state.envelopes.push(env);
      save(state);
      return env;
    },

    /**
     * Patch an envelope's editable fields. Refuses to change `id`,
     * `createdAt`. Validates `cap` (> 0) and `period` ('monthly'|
     * 'yearly') when supplied. Returns null if no match or invalid.
     * @param {State} state
     * @param {string} id
     * @param {Partial<Envelope>} patch
     * @returns {Envelope|null}
     */
    updateEnvelope(state, id, patch) {
      const envelopes = Array.isArray(state.envelopes) ? state.envelopes : [];
      const idx = envelopes.findIndex(e => e.id === id);
      if (idx === -1) return null;
      const safe = { ...patch };
      delete safe.id;
      delete safe.createdAt;
      if (safe.cap !== undefined) {
        const n = Number(safe.cap);
        if (!isFinite(n) || n <= 0) return null;
        safe.cap = n;
      }
      if (safe.name !== undefined) {
        const trimmed = String(safe.name).trim();
        if (!trimmed) return null;
        safe.name = trimmed;
      }
      if (safe.period !== undefined && safe.period !== 'monthly' && safe.period !== 'yearly') {
        return null;
      }
      if (safe.categoryIds !== undefined && !Array.isArray(safe.categoryIds)) {
        return null;
      }
      if (safe.payeeIds !== undefined && !Array.isArray(safe.payeeIds)) {
        return null;
      }
      // Clone the link arrays so external mutations don't leak in.
      if (Array.isArray(safe.categoryIds)) safe.categoryIds = safe.categoryIds.slice();
      if (Array.isArray(safe.payeeIds)) safe.payeeIds = safe.payeeIds.slice();
      envelopes[idx] = { ...envelopes[idx], ...safe, updatedAt: now() };
      save(state);
      return envelopes[idx];
    },

    /**
     * Remove an envelope by id. Persists. No-op if not found.
     * @param {State} state
     * @param {string} id
     * @returns {void}
     */
    deleteEnvelope(state, id) {
      if (!Array.isArray(state.envelopes)) return;
      state.envelopes = state.envelopes.filter(e => e.id !== id);
      save(state);
    },
  };
})();
window.Store = Store;
