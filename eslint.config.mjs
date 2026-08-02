import eslint from '@eslint/js';
import lit from 'eslint-plugin-lit';
import security from 'eslint-plugin-security';
import wc from 'eslint-plugin-wc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      '_site/**',
      'node_modules/**',
      'playwright-report/**',
      'reports/**',
      'test-results/**',
      'src/ui/xterm-styles.generated.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'demo/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['src/server/**/*.ts'],
    plugins: { security },
    rules: security.configs.recommended.rules,
  },
  {
    files: ['demo/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['src/ui/**/*.ts'],
    plugins: { lit, wc },
    rules: {
      ...lit.configs['flat/recommended'].rules,
      ...wc.configs['flat/recommended'].rules,
      ...wc.configs['flat/best-practice'].rules,
      '@typescript-eslint/unbound-method': 'off',
      'wc/guard-super-call': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', 'playwright.config.ts', 'vitest.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
);
