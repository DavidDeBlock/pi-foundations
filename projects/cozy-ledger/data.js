// =====================================================================
// data.js — Storage layer + seed data
// All app state persists to localStorage. No backend, no bank sync.
// Easy to swap for a real API later by replacing `Store` methods.
// =====================================================================

const Store = (() => {
  const KEY = 'cozy-ledger-v1';

  // ---- Seed data (first run) -----------------------------------------
  const seed = () => {
    const today = new Date();
    const ym = (y, m, d) => new Date(y, m - 1, d).toISOString().slice(0, 10);
    const yr = today.getFullYear();
    const mo = today.getMonth() + 1;

    return {
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
      },
    };
  };

  // ---- Helpers -------------------------------------------------------
  function uid() { return 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function now() { return new Date().toISOString(); }

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
    if (Array.isArray(state.sources)) {
      for (const s of state.sources) {
        if (typeof s.balance !== 'number' || !isFinite(s.balance)) s.balance = 0;
      }
    }
    return state;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) {
        const s = seed();
        migrate(s);
        save(s);
        return s;
      }
      return migrate(JSON.parse(raw));
    } catch (e) {
      console.warn('Store load failed, reseeding', e);
      const s = seed();
      migrate(s);
      save(s);
      return s;
    }
  }

  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  function reset() {
    localStorage.removeItem(KEY);
    return load();
  }

  // ---- Public CRUD API ----------------------------------------------
  return {
    load, save, reset, uid, now,

    // Transactions
    listTransactions(state) { return [...state.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)); },
    addTransaction(state, t) {
      const txn = { id: uid(), createdAt: now(), updatedAt: now(), ...t };
      state.transactions.push(txn);
      save(state);
      return txn;
    },
    updateTransaction(state, id, patch) {
      const idx = state.transactions.findIndex(t => t.id === id);
      if (idx === -1) return null;
      state.transactions[idx] = { ...state.transactions[idx], ...patch, updatedAt: now() };
      save(state);
      return state.transactions[idx];
    },
    deleteTransaction(state, id) {
      state.transactions = state.transactions.filter(t => t.id !== id);
      save(state);
    },

    // Categories
    addCategory(state, c) { const cat = { id: uid(), active: true, ...c }; state.categories.push(cat); save(state); return cat; },
    updateCategory(state, id, patch) {
      const idx = state.categories.findIndex(c => c.id === id);
      if (idx === -1) return null;
      state.categories[idx] = { ...state.categories[idx], ...patch };
      save(state);
      return state.categories[idx];
    },
    deleteCategory(state, id) {
      state.categories = state.categories.filter(c => c.id !== id);
      save(state);
    },

    // Sources
    addSource(state, s) { const src = { id: uid(), active: true, balance: 0, ...s }; state.sources.push(src); save(state); return src; },
    updateSource(state, id, patch) {
      const idx = state.sources.findIndex(s => s.id === id);
      if (idx === -1) return null;
      state.sources[idx] = { ...state.sources[idx], ...patch };
      save(state);
      return state.sources[idx];
    },
    deleteSource(state, id) { state.sources = state.sources.filter(s => s.id !== id); save(state); },

    // Users
    addUser(state, u) { const usr = { id: uid(), active: true, ...u }; state.users.push(usr); save(state); return usr; },
    updateUser(state, id, patch) {
      const idx = state.users.findIndex(u => u.id === id);
      if (idx === -1) return null;
      state.users[idx] = { ...state.users[idx], ...patch };
      save(state);
      return state.users[idx];
    },
    deleteUser(state, id) { state.users = state.users.filter(u => u.id !== id); save(state); },

    // Settings — scope and current viewer. Validates inputs; no-ops on invalid.
    setScope(state, scope) {
      if (!VALID_SCOPES.includes(scope)) return state;
      if (!state.settings || typeof state.settings !== 'object') state.settings = {};
      state.settings.scope = scope;
      save(state);
      return state;
    },
    setCurrentUserId(state, userId) {
      if (!state.users || !state.users.some(u => u.id === userId)) return state;
      if (!state.settings || typeof state.settings !== 'object') state.settings = {};
      state.settings.currentUserId = userId;
      save(state);
      return state;
    },
  };
})();
window.Store = Store;
