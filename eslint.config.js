import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import preferArrowFunctions from 'eslint-plugin-prefer-arrow-functions';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'prefer-arrow-functions': preferArrowFunctions,
      'react-hooks': reactHooks,
    },
    rules: {
      // React hooks correctness (rules-of-hooks, exhaustive-deps)
      ...reactHooks.configs.recommended.rules,
      // Enforce arrow function style
      'prefer-arrow-functions/prefer-arrow-functions': [
        'error',
        {
          allowNamedFunctions: false,
          classPropertiesAllowed: false,
          disallowPrototype: false,
          returnStyle: 'unchanged',
          singleReturnOnly: false,
        },
      ],
      // Also enforce arrow functions for callbacks
      'prefer-arrow-callback': 'error',
      // Enforce const for variables that are never reassigned
      'prefer-const': 'error',
      // Disallow var declarations, use let or const instead
      'no-var': 'error',
      // Require === and !== instead of == and !=
      'eqeqeq': 'error',
      // Require braces around all blocks
      'curly': 'error',
      // Ensure promises are awaited or handled
      '@typescript-eslint/no-floating-promises': 'error',
      // Catch common promise mistakes
      '@typescript-eslint/no-misused-promises': 'error',
      // Only await things that are actually promises
      '@typescript-eslint/await-thenable': 'error',
      // Catch conditions that are always true/false
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // Catch unnecessary type conversions
      '@typescript-eslint/no-unnecessary-type-conversion': 'error',
      // Disallow unsafe operations with `any` types
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      // Only throw Error objects, not strings or literals
      'no-throw-literal': 'error',
      // One quote style across src/ (single, matching the majority of files)
      quotes: ['error', 'single', { avoidEscape: true }],
      // Enforce using interface instead of type for object type definitions
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      // Relative imports must be explicit .ts/.tsx paths (Node type stripping
      // does no extensionless or directory resolution)
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Any specifier starting with ./ or ../ that does not end in .ts
              // or .tsx (.json is also allowed; JSON imports work under plain
              // node via the `with { type: "json" }` attribute)
              regex: String.raw`^\.{1,2}($|/(?!.*\.(ts|tsx|json)$))`,
              message:
                'Relative imports must include the .ts/.tsx extension (e.g. "../Player/index.ts") so sources run under plain node.',
            },
            {
              group: ['**/*.js', '**/*.jsx'],
              message:
                'Do not import .js/.jsx paths from TypeScript sources; import the .ts/.tsx file.',
            },
            {
              // Node builtins must use the node: prefix
              regex:
                '^(assert|buffer|child_process|crypto|events|fs|http|https|net|os|path|stream|string_decoder|tty|url|util|worker_threads|zlib)(/.*)?$',
              message: 'Use the node: prefix for Node builtins (e.g. "node:zlib").',
            },
          ],
        },
      ],
      // Disallow magic numbers - use named constants instead
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  },
  {
    files: ['src/**/tests.ts', 'src/**/tests.tsx'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
];
