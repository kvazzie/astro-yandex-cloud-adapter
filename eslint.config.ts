import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const typedFiles = [
  "packages/adapter/src/**/*.ts",
  "packages/adapter/*.ts",
  "tests/unit/**/*.ts",
  "tests/integration/**/*.ts",
  "*.ts",
];

export default defineConfig(
  globalIgnores([
    "**/dist/**",
    "**/.astro/**",
    "**/node_modules/**",
    ".artifacts/**",
  ]),
  eslint.configs.recommended,
  {
    files: typedFiles,
    extends: tseslint.configs.recommendedTypeChecked,
  },
  {
    files: ["tests/fixtures/**/*.ts", "examples/**/*.ts"],
    extends: tseslint.configs.recommended,
  },
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
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
