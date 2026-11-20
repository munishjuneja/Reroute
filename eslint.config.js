// ESLint flat config. Rules here back up CONTRIBUTING.md › Code style; keep the two in step.
import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

const readability = {
  // Names must say what a thing is. Single letters only for loop indexes and unused parameters.
  'id-length': ['error', { min: 2, exceptions: ['i', 'j', '_'], properties: 'never' }],
  'no-nested-ternary': 'error',
  'max-depth': ['error', 3],
  'max-params': ['warn', 4],
  'max-lines-per-function': ['warn', { max: 60, skipBlankLines: true, skipComments: true }],
  complexity: ['warn', 12],
  curly: ['error', 'multi-line', 'consistent'],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'prefer-const': 'error',
  'no-var': 'error',
  'no-param-reassign': ['error', { props: false }],
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-console': ['warn', { allow: ['warn', 'error'] }],
};

const security = {
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-script-url': 'error',
};

export default [
  { ignores: ['node_modules/', 'dist/', 'private/'] },
  js.configs.recommended,
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker },
    },
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      ...readability,
      ...security,
      ...jsdoc.configs['flat/recommended-error'].rules,
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: false,
          require: {
            FunctionDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: [
            'VariableDeclaration > VariableDeclarator > ArrowFunctionExpression[body.type="BlockStatement"]',
          ],
        },
      ],
      'jsdoc/require-description': 'error',
      'jsdoc/require-returns-description': 'off',
      // Descriptions are required only where the name and type are not enough (CONTRIBUTING.md).
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-property-description': 'off',
      'jsdoc/tag-lines': ['error', 'any', { startLines: 1 }],
    },
  },
  {
    // Content scripts run as classic scripts, not modules.
    files: ['extension/page/*.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs', '*.js', '*.mjs'],
    // Tests also contain callbacks that Playwright runs inside pages and the extension.
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions },
    },
    rules: { ...readability, 'max-lines-per-function': 'off', 'no-console': 'off' },
  },
];
