// =====================================================================
// eslint.config.js — Flat config for ESLint 9.
//
// Two execution contexts in this repo:
//   1. Browser: app.js, data.js, utils.js, icons.js, selectors.js,
//      i18n.js, backup.js, csv.js — loaded via <script> tags with
//      window/document/etc. globals.
//   2. Node:    _test_*.js, eslint.config.js — CommonJS via npm/node.
//
// Recommended rules only; no stylistic rules (no Prettier entanglement).
// =====================================================================

const globals = require('globals');

module.exports = [
  // ---- Browser context -------------------------------------------
  {
    files: [
      'app.js',
      'data.js',
      'utils.js',
      'icons.js',
      'selectors.js',
      'i18n.js',
      'backup.js',
      'csv.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Globals this app exposes on `window` (defined in one file, consumed in others).
        $: 'readonly',
        $$: 'readonly',
        el: 'readonly',
        toast: 'readonly',
        confirmAction: 'readonly',
        Fmt: 'readonly',
        Icons: 'readonly',
        CategoryIcons: 'readonly',
        Deco: 'readonly',
        Logo: 'readonly',
        Store: 'readonly',
        Selectors: 'readonly',
        SelectorScopes: 'readonly',
        CSVImport: 'readonly',
        Backup: 'readonly',
        App: 'readonly',
        Strings: 'readonly',
        t: 'readonly',
        // csv.js guards its CommonJS export with `typeof module !== 'undefined'`.
        // Declare module as a known global so the guard pattern lints cleanly.
        module: 'readonly',
        exports: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },

  // ---- Node test files ------------------------------------------
  {
    files: ['_test_*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },

  // ---- ESLint config file itself ---------------------------------
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  // ---- Ignore patterns -------------------------------------------
  {
    ignores: [
      'node_modules/**',
      'statements/**',
      'docs/**',
    ],
  },
];
