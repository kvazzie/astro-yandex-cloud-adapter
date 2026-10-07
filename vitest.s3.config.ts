import { defineConfig } from "vitest/config";

import config from "./vitest.config.js";

export default defineConfig({
  test: {
    ...config.test,
    include: ["tests/integration/s3.test.ts"],
    exclude: [],
    reporters: ["default", "junit"],
    outputFile: { junit: ".artifacts/local-s3.xml" },
  },
});
