import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import unicorn from 'eslint-plugin-unicorn';
import sonarjs from 'eslint-plugin-sonarjs';
import vitest from '@vitest/eslint-plugin';
import playwright from 'eslint-plugin-playwright';
import prettier from 'eslint-config-prettier';

const TS_GLOBS = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const TEST_GLOBS = ['**/*.spec.ts', '**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'];

/**
 * One flat config for the whole monorepo.
 *
 * Type-aware rules are on everywhere (`projectService`), because the bugs worth
 * catching here — floating promises across the agent loop, unsafe `any` leaking
 * out of LangChain, unawaited stream teardown — are invisible to syntax-only
 * linting. Everything Prettier owns is disabled last so the two never fight.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/reports/**',
      '**/node_modules/**',
      '**/.stryker-tmp/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'app/src-tauri/target/**',
      'app/src-tauri/gen/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  unicorn.configs.recommended,

  {
    files: TS_GLOBS,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
    },
    rules: {
      // --- correctness ---------------------------------------------------
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'import-x/no-cycle': ['error', { maxDepth: 10 }],
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'no-console': ['error', { allow: ['error'] }],

      // --- deliberate relaxations ----------------------------------------
      // Nest DI, LangChain runnables and MUI slot props all legitimately use
      // template-literal-unfriendly or loosely typed values.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // Kebab-case files are the Nest convention; PascalCase is the React one.
      'unicorn/filename-case': [
        'error',
        { cases: { kebabCase: true, pascalCase: true, camelCase: true } },
      ],
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-null': 'off', // `null` is part of the wire contract (activeJob).
      'unicorn/prefer-top-level-await': 'off', // CJS-compatible bootstrap functions.
      'unicorn/no-array-reduce': 'off',
      'unicorn/no-array-for-each': 'off',
      'unicorn/no-await-expression-member': 'off', // `(await resolve()).x` is the point of the facade.
      'unicorn/import-style': 'off', // Named node: imports are clearer than a namespace.
      'unicorn/numeric-separators-style': 'off', // Hex hash constants read better ungrouped.
      'unicorn/prefer-string-repeat': 'off',
      'unicorn/no-useless-undefined': 'off', // `() => undefined` states intent better than `() => {}`.
      'unicorn/no-new-array': 'off', // `new Array(n).fill(0)` is the fast, deliberate idiom.
      'unicorn/no-for-loop': 'off', // Index loops that walk two arrays in step.
      'unicorn/prefer-global-this': 'off', // `window`/`process` say which runtime is meant.
      'unicorn/prefer-https': 'off', // Loopback defaults are http by design.
      'sonarjs/no-nested-functions': 'off', // Nest factories and React effects nest by design.
      // An `async` method with no `await` is how a class conforms to a Promise-returning
      // interface; that is intent, not an oversight.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],
    },
  },

  // --- process entry points -------------------------------------------------
  {
    files: ['backend/src/main.ts', 'backend/src/mcp-server.ts'],
    rules: {
      // These are CLI entry points: exiting non-zero is the contract.
      'unicorn/no-process-exit': 'off',
      'no-console': 'off',
    },
  },

  // --- backend --------------------------------------------------------------
  {
    files: ['backend/**/*.ts'],
    rules: {
      // Nest decorators legitimately produce classes with only injected members.
      '@typescript-eslint/no-extraneous-class': 'off',
      // Controllers and gateways are instantiated by Nest, never called directly.
      '@typescript-eslint/unbound-method': ['error', { ignoreStatic: true }],
    },
  },

  // --- frontend -------------------------------------------------------------
  {
    files: ['app/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'react/prop-types': 'off', // TypeScript already covers this.
      'react/jsx-no-leaked-render': ['error', { validStrategies: ['ternary', 'coerce'] }],
    },
  },

  // --- tests ----------------------------------------------------------------
  {
    files: TEST_GLOBS,
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/expect-expect': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'warn',
      'vitest/no-identical-title': 'error',
      'vitest/valid-expect': 'error',
      // Tests deliberately cast partial doubles into service positions.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off', // no-op stubs
      '@typescript-eslint/no-unnecessary-condition': 'off', // assertions probe impossible states
      'sonarjs/no-duplicate-string': 'off',
      'unicorn/consistent-function-scoping': 'off',
      // Fixtures name protocols on purpose (a URL parser's tests, a loopback default).
      'sonarjs/no-clear-text-protocols': 'off',
    },
  },

  {
    files: ['app/e2e/**/*.ts'],
    ...playwright.configs['flat/recommended'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/expect-expect': 'error',
      // Assertions match short, fixed strings rendered by our own UI, so the
      // analyser's conservative backtracking warning does not apply.
      'sonarjs/super-linear-regex': 'off',
      'playwright/no-conditional-in-test': 'error',
      'playwright/no-wait-for-timeout': 'error',
    },
  },

  // --- config files ---------------------------------------------------------
  {
    files: ['**/*.config.ts', '**/vite.config.ts', '**/playwright.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // Plain JS (this config file, hooks) has no tsconfig, so type-aware rules
  // cannot run against it.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },

  prettier,
);
