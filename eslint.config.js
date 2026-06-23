import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**', '.recall-build/**'] },
  js.configs.recommended,
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
      ...reactHooks.configs.recommended.rules,
      // TypeScript already checks for undefined identifiers; no-undef is noisy
      // and wrong for type-only globals (HTMLDivElement, etc.).
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
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
