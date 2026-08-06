import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: { reporter: ['text', 'json-summary'] },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
