import js from '@eslint/js';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'test-results/**'],
  },
  {
    ...js.configs.recommended,
    files: ['scripts/**/*.mjs', '*.config.mjs'],
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
];
