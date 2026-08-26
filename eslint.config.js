import js from '@eslint/js';
import globals from 'globals';

// Deliberately minimal. This config exists to catch the bug class that a card
// rendering as an empty box came from: a reference to an identifier that no
// longer exists. Vite doesn't type-check and the tests never render React, so
// nothing else in the toolchain catches it.
//
// Style is not policed here — only mistakes that break at runtime.
export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['**/*.js', '**/*.jsx', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',   // import attributes: cards.json is imported with { type: 'json' }
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // The whole point: an undefined identifier is a runtime crash waiting.
      'no-undef': 'error',
      // Catches the other half of a half-finished rename — a binding left behind
      // with nothing using it. Args are noisy and harmless, so they're exempt.
      'no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // A few of js.configs.recommended's genuine footguns, without the rest.
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-compare': 'error',
    },
  },
  {
    // Test files use the shim's describe/test/expect, imported explicitly, so
    // nothing extra is needed — but node globals matter for the runner.
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
