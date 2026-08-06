import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const typedFiles = [
  'packages/adapter/src/**/*.ts',
  'packages/adapter/*.ts',
  'tests/unit/**/*.ts',
  'tests/integration/**/*.ts',
  '*.ts',
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.astro/**', '**/node_modules/**', '.artifacts/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: typedFiles })),
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['tests/fixtures/**/*.ts', 'examples/**/*.ts'],
  })),
  prettier,
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
