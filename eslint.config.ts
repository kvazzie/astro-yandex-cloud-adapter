import yandexCloud from "@astro-yandex-cloud/eslint-plugin";
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const typedFiles = [
	"packages/*/src/**/*.{ts,js}",
	"packages/*/*.ts",
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
		files: ["packages/adapter/src/Hooks/**/*.ts"],
		rules: {
			"require-yield": "off",
		},
	},
	{
		files: ["**/*.ts"],
		plugins: {
			"astro-yandex-cloud": yandexCloud,
		},
		rules: {
			"astro-yandex-cloud/import-paths": "error",
			"astro-yandex-cloud/default-import-name": "error",
		},
	},
	{
		files: typedFiles,
		plugins: {
			"astro-yandex-cloud": yandexCloud,
		},
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"astro-yandex-cloud/errors-namespace": "error",
			"@typescript-eslint/consistent-type-imports": "error",
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
);
