import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'scripts/**', '.recall-build/**', '.skills-build/**'] },
  js.configs.recommended,
  {
    rules: {
      // New in ESLint 10's recommended set. Every hit here was the
      // `let x = fallback; try { x = ... } catch { return }` shape, never a lost
      // value; rewriting them only trades the initializer for TS
      // definite-assignment friction.
      'no-useless-assignment': 'off'
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // react-hooks 7's recommended set adds the React Compiler rules (refs,
      // set-state-in-effect, purity, ...). Stem does not run the compiler, so
      // only the two classic hook rules apply, as under react-hooks 5.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // TypeScript already checks for undefined identifiers; no-undef is noisy
      // and wrong for type-only globals (HTMLDivElement, etc.).
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    // The headless boundary. src/server has to run under plain `node`, so it may
    // not reach for Electron — directly or through anything it imports.
    //
    // This rule is the fast half of that guarantee, not the whole of it. It sees
    // the literal specifier and nothing else: an `electron` import pulled in
    // through a barrel file, or through a module that re-exports one, satisfies
    // it and still fails at runtime. The real proof is scripts/server-boot.mjs,
    // which boots dist/main/server.js under a `node` that has no `electron`
    // module to resolve. Keep both — this one to fail in the editor, that one to
    // fail in CI.
    files: ['src/server/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'src/server must run headless. Electron capabilities go through the host shim (src/server/host); windows, dialogs and shell integration belong to src/desktop.'
            }
          ],
          patterns: [
            {
              group: ['electron/*', '**/desktop', '**/desktop/**'],
              message:
                'src/server must not depend on the Electron client. The dependency runs one way only: src/desktop imports src/server.'
            }
          ]
        }
      ]
    }
  },
  {
    // Standalone Node ESM scripts (e.g. the recall MCP server) run outside the
    // TS graph; no-undef can't see Node globals here and would false-positive.
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: { 'no-undef': 'off' }
  },
  {
    // The Linux computer-control helper and GNOME Shell extension run under
    // gjs, whose globals (global, print, printerr, TextEncoder…) eslint does
    // not know.
    files: ['native/linux/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { global: 'readonly', print: 'readonly', printerr: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', console: 'readonly' }
    }
  },
  {
    // Tests: Playwright's `use()` fixture API trips react-hooks/rules-of-hooks
    // (it's not a React Hook), and probing the renderer through `window.stem`
    // legitimately needs `any` casts.
    files: ['tests/**/*.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Playwright fixtures idiomatically destructure `{}` as the first arg.
      'no-empty-pattern': 'off'
    }
  }
];
