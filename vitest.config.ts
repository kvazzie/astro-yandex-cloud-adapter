import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/integration/s3.test.ts"],
    coverage: { reporter: ["text", "json-summary"] },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
