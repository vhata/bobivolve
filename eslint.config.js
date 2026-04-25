// Flat config. Encodes the mechanizable architectural disciplines from
// ARCHITECTURE.md (Determinism disciplines, sim/UI seam) and PROCESS.md
// (Code review, Layer 1).
//
// The rule: if a discipline can be expressed in lint, it goes in lint.
// Lint runs every commit and does not negotiate.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['node_modules', 'dist', 'build', 'out', 'coverage', 'protocol/generated'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Sim core — ARCHITECTURE.md Determinism disciplines.
  // No nondeterministic stdlib, no wall-clock time, no host APIs.
  {
    files: ['sim/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message:
            'Sim core must use the seeded PRNG (xoshiro256**), not Math.random. See ARCHITECTURE.md.',
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: 'Sim core must use simTick, not wall-clock time. See ARCHITECTURE.md.',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Sim core must not consult wall-clock time. See ARCHITECTURE.md.',
        },
        {
          selector: "MemberExpression[object.name='performance'][property.name='now']",
          message: 'Sim core must use simTick, not performance.now. See ARCHITECTURE.md.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Sim core must not touch the DOM.' },
        { name: 'document', message: 'Sim core must not touch the DOM.' },
        { name: 'self', message: 'Sim core must not touch worker globals.' },
        { name: 'performance', message: 'Sim core must use simTick.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fs', 'fs/*', 'node:fs', 'node:fs/*'],
              message: 'Sim core must not touch the filesystem. Use the Storage port.',
            },
            {
              group: ['process', 'node:process'],
              message: 'Sim core must not import process.',
            },
            {
              group: ['os', 'node:os', 'path', 'node:path', 'perf_hooks', 'node:perf_hooks'],
              message: 'Sim core must not import Node host APIs. Pass capabilities through ports.',
            },
            {
              group: ['react', 'react-dom', 'react-dom/*'],
              message: 'Sim core must not import UI libraries.',
            },
            {
              group: ['../host/*', '../transport/*', '../ui/*'],
              message: 'Sim core must not import from host, transport, or UI layers.',
            },
          ],
        },
      ],
    },
  },

  // Test files — relax a few rules.
  {
    files: ['test/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
