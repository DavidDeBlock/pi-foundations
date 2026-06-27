// =====================================================================
// globals.d.ts — Editor-only `Window` augmentation.
// =====================================================================
// Teaches TypeScript "Check JS" / VS Code about the `window.X = X`
// globals that each script assigns. NOT loaded by the app at runtime
// — see `types.js` for the runtime-loaded JSDoc typedefs.
//
// `types.js` is a non-module `<script>` and cannot export types, so the
// type aliases below mirror its JSDoc typedefs. The two definitions are
// kept in sync manually; the source of truth is `types.js` for humans,
// this file for tooling.
// =====================================================================
//
// If you add a new public global, append it here AND make sure
// jsconfig.json includes this file in its `include` list.
//
// =====================================================================

type Scope = 'private' | 'shared' | 'all';

interface User {
  id: string;
  name: string;
  color: string;
  active: boolean;
}

interface Source {
  id: string;
  name: string;
  type: 'bank' | 'cash' | 'savings' | 'other';
  ownerId: string | null;
  active: boolean;
  balance: number;
}

interface Category {
  id: string;
  name: string;
  type: 'income' | 'expense';
  color: string;
  icon: string;
  active: boolean;
  groupId?: string | null;
}

interface Group {
  id: string;
  name: string;
  color: string;
  icon: string;
  order: number;
  active: boolean;
}

interface Transaction {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  date: string;
  description: string;
  categoryId: string;
  paidByUserId: string;
  sourceId: string;
  scope: 'private' | 'shared';
  notes: string;
  createdAt: string;
  updatedAt: string;
  importedKey?: string;
}

interface Settings {
  currentUserId: string;
  scope: Scope;
  applyCategoryToPayee: boolean;
  dashboardByGroup: boolean;
}

interface State {
  users: User[];
  sources: Source[];
  categories: Category[];
  // `groups` is backfilled by Store.migrate() on first ever load and on
  // every upgrade from a pre-ISSUE-007 install. The seed intentionally
  // omits it; older persisted states also lack it. Treat as optional.
  groups?: Group[];
  transactions: Transaction[];
  payeeCategories: Record<string, string>;
  settings: Settings;
  // ISSUE-017: optional in State — backfilled by Store.migrate().
  goals?: Goal[];
  // ISSUE-018: optional in State — backfilled by Store.migrate().
  envelopes?: Envelope[];
}

interface GoalFunding {
  date: string;
  amount: number;
}

interface Goal {
  id: string;
  name: string;
  target: number;
  funded: number;
  targetDate: string | null;
  notes: string;
  fundingHistory: GoalFunding[];
  createdAt: string;
  updatedAt: string;
}

interface Envelope {
  id: string;
  name: string;
  cap: number;
  period: 'monthly' | 'yearly';
  categoryIds: string[];
  payeeIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

interface BalancePoint {
  date: string;
  balance: number;
}

interface MonthFlow {
  month: string;
  income: number;
  expense: number;
  net: number;
  perSource: Record<string, number>;
}

interface FmtMoneyOpts {
  signed?: boolean;
}

declare global {
  interface Window {
    /* ---- Pure helpers (utils.js) ---- */
    $: (selector: string, root?: ParentNode) => Element | null;
    $$: (selector: string, root?: ParentNode) => Element[];
    // `el` is a polymorphic DOM builder: returns an HTMLInputElement,
    // HTMLSelectElement, HTMLElement, or SVGElement depending on the
    // `tag` string. TypeScript can't infer the narrowed type from a
    // runtime-determined tag, so we declare `any` for ergonomics.
    // The runtime contract is well-defined in `utils.js`.
    el: (
      tag: string,
      props?: Record<string, unknown>,
      ...children: (Node | string | false | null | undefined)[]
    ) => any;
    toast: (message: string) => void;
    confirmAction: (message: string) => Promise<boolean>;

    Fmt: {
      money: (n: number | null | undefined, opts?: FmtMoneyOpts) => string;
      moneyShort: (n: number | null | undefined) => string;
      date: (d: string | Date | null | undefined, opts?: { month?: boolean }) => string;
      ymKey: (d: string | Date) => string;
      monthLabel: (yyyyMm: string) => string;
      today: () => string;
      currentMonthKey: () => string;
      shiftMonth: (yyyyMm: string, delta: number) => string;
      inMonth: (date: string | Date, yyyyMm: string) => boolean;
      pct: (part: number, total: number) => number;
    };

    /* ---- Seed + persistence (data.js) ---- */
    Store: {
      load: () => State;
      save: (state: State) => void;
      reset: () => State;
      uid: () => string;
      now: () => string;

      listTransactions: (state: State) => Transaction[];
      addTransaction: (state: State, t: Partial<Transaction>) => Transaction;
      updateTransaction: (state: State, id: string, patch: Partial<Transaction>) => Transaction | null;
      deleteTransaction: (state: State, id: string) => void;

      addCategory: (state: State, c: Partial<Category>) => Category;
      updateCategory: (state: State, id: string, patch: Partial<Category>) => Category | null;
      deleteCategory: (state: State, id: string) => void;

      addSource: (state: State, s: Partial<Source>) => Source;
      updateSource: (state: State, id: string, patch: Partial<Source>) => Source | null;
      deleteSource: (state: State, id: string) => void;

      addUser: (state: State, u: Partial<User>) => User;
      updateUser: (state: State, id: string, patch: Partial<User>) => User | null;
      deleteUser: (state: State, id: string) => void;

      setScope: (state: State, scope: Scope) => State;
      setCurrentUserId: (state: State, userId: string) => State;
      setApplyCategoryToPayee: (state: State, value: boolean) => State;
      setPayeeCategory: (state: State, payeeName: string, categoryId: string) => State;
      setDashboardByGroup: (state: State, value: boolean) => State;

      addGroup: (state: State, g: Partial<Group>) => Group;
      updateGroup: (state: State, id: string, patch: Partial<Group>) => Group | null;
      deleteGroup: (state: State, id: string) => void;

      // ISSUE-017: savings goals CRUD. Throws on invalid addGoal input;
      // returns null for unknown id on update/fund; no-op on missing
      // id on delete.
      addGoal: (state: State, g: Partial<Goal>) => Goal;
      updateGoal: (state: State, id: string, patch: Partial<Goal>) => Goal | null;
      deleteGoal: (state: State, id: string) => void;
      fundGoal: (state: State, id: string, deposit: { date?: string; amount: number }) => Goal | null;

      // ISSUE-018: spending caps CRUD. Throws on invalid addEnvelope
      // input (name / cap / period); returns null for unknown id on
      // update or invalid patch; no-op on missing id on delete.
      addEnvelope: (state: State, e: Partial<Envelope>) => Envelope;
      updateEnvelope: (state: State, id: string, patch: Partial<Envelope>) => Envelope | null;
      deleteEnvelope: (state: State, id: string) => void;
    };

    /* ---- Pure selectors (selectors.js) ---- */
    Selectors: {
      scope: (state: State) => Scope;
      currentUserId: (state: State) => string;
      sourcesInScope: (state: State) => Source[];
      transactionsInScope: (state: State) => Transaction[];
      sourcesById: (state: State) => Record<string, Source | undefined>;
      balanceSeries: (state: State, sourceId: string) => BalancePoint[];
      balanceChartDateRange: (state: State) => { from: string; to: string };
      balanceAtDate: (state: State, sourceId: string, date: string) => number;
      netWorthSeries: (state: State) => BalancePoint[];
      dailyNetFlow: (state: State) => { date: string; perSource: Record<string, number>; total: number }[];
      monthlyBalance: (state: State, sourceId: string, months?: number) => BalancePoint[];
      monthlyNetWorth: (state: State, months?: number) => BalancePoint[];
      monthlyNetFlow: (state: State, months?: number) => MonthFlow[];
      // ISSUE-013: period helpers (PRD-004).
      periodRangeForPreset: (
        preset: '1m' | '3m' | '6m' | '1y' | '2y',
        today?: Date,
      ) => { from: string; to: string } | null;
      periodRangeForAll: (state: State, today?: Date) => { from: string; to: string };
      txnsInPeriod: (state: State, range: { from: string; to: string }) => Transaction[];
      monthsInPeriod: (range: { from: string; to: string }) => string[];
      // ISSUE-017: pure progress helper for goals.
      goalProgress: (goal: Partial<Goal> | null | undefined) => {
        funded: number;
        target: number;
        percent: number;
        remaining: number;
      };

      // ISSUE-018: envelope spend / progress helpers. All pure; safe
      // to call from anywhere with a valid `state` + envelope pair.
      currentPeriodFor: (envelope: Partial<Envelope> | null | undefined, today?: Date) => { from: string; to: string };
      envelopeSpend: (envelope: Partial<Envelope> | null | undefined, state: State, today?: Date) => number;
      envelopeProgress: (envelope: Partial<Envelope> | null | undefined, state: State, today?: Date) => {
        spent: number;
        cap: number;
        percent: number;
        remaining: number;
        overspent: number;
      };
    };
    SelectorScopes: readonly Scope[];

    /* ---- CSV import (csv.js) ---- */
    CSVImport: {
      parseIngStatement: (text: string) => Record<string, unknown>[];
      extractPayee: (description: string) => string;
      classifyRow: (row: Record<string, unknown>) => {
        type: 'income' | 'expense' | null;
        scope: 'private' | null;
        categoryHint: string | null;
        skip: boolean;
        skipReason?: string;
      };
      mapRowToTxn: (
        row: Record<string, unknown>,
        classification: ReturnType<Window['CSVImport']['classifyRow']>,
        defaults: { userId: string; sourceId: string; scope: 'private' | 'shared' },
        suggestedCategoryId: string | null,
      ) => Partial<Transaction>;
      suggestedCategoryFor: (hint: string | null, type: 'income' | 'expense' | null, state: State) => string | null;
      makeDedupKey: (row: Record<string, unknown>) => string;
    };

    /* ---- Backup / restore (backup.js) ---- */
    Backup: {
      exportJSON: (state: State) => void;
      exportCSV: (state: State) => void;
      parseAndValidate: (text: string) => { ok: boolean; error?: string; data?: unknown };
      applyImport: (state: State, parsed: unknown, save?: (state: State) => void) => { error: string } | null;
      countRecords: (parsed: unknown) => { transactions: number; categories: number; sources: number; users: number; groups: number };
    };

    /* ---- Icons (icons.js) ---- */
    Icons: Record<string, string>;
    CategoryIcons: string[];
    Deco: Record<string, string>;
    Logo: string;

    /* ---- i18n (i18n.js) ---- */
    Strings: { nl: Record<string, string> };
    t: (key: string, params?: Record<string, string | number>) => string;
    i18n: {
      t: (key: string, params?: Record<string, string | number>) => string;
      Strings: { nl: Record<string, string> };
    };

    /* ---- App + router + shell (app.js / router.js / shell.js) ---- */
    App: {
      init: () => void;
      _state: State;
      _shellRenderCount: number;
      _resetRenderCount: () => void;
      _goTo: (view: string) => void;
      // Triggers a store:changed event; count is observable via
      // window.dispatchEvent listeners. Returns void.
      bulkUpdatePayeeCategory: (payeeName: string, categoryId: string) => void;
    };
    Router: {
      boot: () => void;
      view: string;
      monthKey: string;
      txnFilters: Record<string, string>;
      balanceViewMode: 'sources' | 'networth';
      period: Period;
      renderView: () => void;
      goTo: (id: string) => void;
      shiftMonth: (delta: number) => void;
      setTxnFilter: (key: string, value: string) => void;
      resetTxnFilters: () => void;
      setBalanceViewMode: (mode: 'sources' | 'networth') => void;
      // ISSUE-013: shared period state (PRD-004).
      periodRange: () => { from: string; to: string };
      setPeriodPreset: (preset: PeriodPreset) => void;
      setPeriodRange: (range: { from: string; to: string }) => void;
      resetPeriod: (viewKey: string) => void;
      defaultPresetFor: (viewKey: string) => PeriodPreset;
    };
    Shell: {
      render: () => void;
      resetRenderCount: () => void;
      openSidebar: () => void;
      closeSidebar: () => void;
      ensureMonthPicker: () => void;
      updateSidebarBadges: () => void;
      updateSidebarActiveClass: () => void;
      updateScopePills: () => void;
      getRenderCount: () => number;
    };

    /* ---- Views (views/*.js) ---- */
    Dashboard: { render: () => HTMLElement };
    Trends: { render: () => HTMLElement };
    Transactions: { render: () => HTMLElement };
    Categories: { render: () => HTMLElement };
    Sources: { render: () => HTMLElement };
    Users: { render: () => HTMLElement };
    Payees: { render: () => HTMLElement };
    Goals: { render: () => HTMLElement };
    Envelopes: { render: () => HTMLElement };
    Settings: { render: () => HTMLElement };
    PeriodSelector: {
      render: (viewKey: string) => HTMLElement;
      PRESETS: readonly ('1m' | '3m' | '6m' | '1y' | '2y' | 'all')[];
    };
    ViewHelpers: {
      sum: (arr: object[], key: string) => number;
      countTxns: (txns: Transaction[]) => number;
      aggregateBy: (arr: object[], key: string) => Record<string, number>;
      emptyState: (text: string) => HTMLElement;
      escapeText: (s: string) => string;
      escapeAttr: (s: string) => string;
      field: (label: string, control: HTMLElement) => HTMLElement;
      option: (value: string, label: string) => HTMLOptionElement;
      extractPayee: (s: string) => string;
      distinctPayees: (state: State) => string[];
      bulkUpdatePayeeCategory: (state: State, payeeName: string, categoryId: string) => number;
    };

    /* ---- Charts (charts/*.js) ---- */
    ChartHelpers: {
      CHART_W: number;
      HB_H: number;
      TR_H: number;
      CHART_M_HB: { top: number; right: number; bottom: number; left: number };
      CHART_M_TR: { top: number; right: number; bottom: number; left: number };
      NW_COLOR: string;
      POS_COLOR: string;
      NEG_COLOR: string;
      SHARED_PALETTE: string[];
      colorForSource: (src: Source) => string;
    };
    MonthlyFlow: {
      render: (opts: {
        months: MonthFlow[];
        sources: Source[];
        isNetWorth: boolean;
        i18n: Record<string, string>;
        rangeButtons: HTMLElement;
      }) => HTMLElement;
    };
    BalanceTrajectory: {
      render: (opts: {
        series: { id: string; name: string; points: BalancePoint[]; today: number; flat?: boolean }[];
        isNetWorth: boolean;
        i18n: Record<string, string>;
        rangeButtons: HTMLElement;
      }) => HTMLElement;
    };

    /* ---- Modals (modals/*.js) ---- */
    Modal: {
      create: (config: unknown) => { modal: HTMLElement; close: () => void };
    };
    Modals: {
      transaction: (id?: string) => void;
      category: (id?: string) => void;
      group: (id?: string) => void;
      source: (id?: string) => void;
      user: (id?: string) => void;
      import: () => void;
      importConfirm: (parsed: unknown) => void;
      // Helpers invoked from list-row delete buttons.
      transactionDelete: (id: string) => void;
      categoryDelete: (id: string) => void;
      groupDelete: (id: string) => void;
      sourceDelete: (id: string) => void;
      userDelete: (id: string) => void;
      // ISSUE-017: goals modal openers.
      goal: (id?: string) => void;
      goalDelete: (id: string) => void;
      // ISSUE-018: envelopes modal openers.
      envelope: (id?: string) => void;
      envelopeDelete: (id: string) => void;
    };
    ImportPreview: {
      render: (rows: unknown[], into: HTMLElement) => void;
    };
  }
}

export {};