import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import yandexCloud from "@astro-yandex-cloud/eslint-plugin";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(
	join(tmpdir(), "default-import-name-"),
);
for (const file of [
	"hooks/index.ts",
	"function-runtime-bridge/index.ts",
	"snake_case/index.ts",
	"camelCase/index.ts",
	"404/index.ts",
	"src/index.ts",
	"package.json",
	"package/index.ts",
	"package/package.json",
	"nested/src/index.ts",
	"native/index.js",
	"preview.ts",
	"ambiguous.ts",
	"ambiguous/index.ts",
]) {
	const path = join(directory, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
}
afterAll(() =>
	rmSync(directory, { recursive: true, force: true }),
);

const linter = new Linter({ cwd: directory });
const config = {
	files: ["**/*.ts"],
	languageOptions: { parser: tseslint.parser },
	plugins: { "astro-yandex-cloud": yandexCloud },
	rules: { "astro-yandex-cloud/default-import-name": "error" },
} satisfies Linter.Config;
const options = { filename: join(directory, "consumer.ts") };

describe("directory default import names", () => {
	it.each([
		['import hooks from "./hooks";', "Hooks"],
		['import Wrong from "./hooks/";', "Hooks"],
		['import Wrong from "./hooks/index.ts";', "Hooks"],
		['import Wrong from "./hooks/index.js";', "Hooks"],
		[
			'import Wrong from "./function-runtime-bridge";',
			"FunctionRuntimeBridge",
		],
		['import Wrong from "./snake_case";', "SnakeCase"],
		['import Wrong from "./camelCase";', "CamelCase"],
		['import type Wrong from "./hooks";', "Hooks"],
		['import { default as Wrong } from "./hooks";', "Hooks"],
		[
			'import { type default as Wrong } from "./hooks";',
			"Hooks",
		],
		['import Wrong, { extra } from "./hooks";', "Hooks"],
		['import Wrong from "./native/index.js";', "Native"],
		['import Wrong from "./ambiguous/";', "Ambiguous"],
		['import Wrong from "./hooks?query#fragment";', "Hooks"],
		['import Wrong from "./nested/src";', "Src"],
	])("checks %s", (source, expected) => {
		const messages = linter.verify(source, config, options);
		expect(messages).toMatchObject([
			{
				ruleId: "astro-yandex-cloud/default-import-name",
			},
		]);
		expect(messages[0]?.message).toContain(`as "${expected}"`);
	});

	it.each([
		'import Hooks from "./hooks";',
		'import Hooks from "./hooks/index.ts";',
		'import FunctionRuntimeBridge from "./function-runtime-bridge";',
		'import type Hooks from "./hooks";',
		'import { default as Hooks } from "./hooks";',
		'import { type default as Hooks } from "./hooks";',
		'import Hooks, { extra } from "./hooks";',
		'import * as Namespace from "./hooks";',
		'import { named as alias } from "./hooks";',
		'import "./hooks";',
		'import preview from "./preview.ts";',
		'import ambiguous from "./ambiguous";',
		'import Whatever from "./missing";',
		'import Whatever from "third-party/hooks";',
		'import yandexCloud from "./src";',
		'import api from "./package";',
		'export { default as PublicName } from "./hooks";',
	])("accepts %s", (source) => {
		expect(linter.verify(source, config, options)).toEqual([]);
	});

	it("resolves the containing directory for a parent index import", () => {
		const messages = linter.verify(
			'import Wrong from "../index.ts";',
			config,
			{
				filename: join(
					directory,
					"function-runtime-bridge/nested/consumer.ts",
				),
			},
		);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.message).toContain(
			'as "FunctionRuntimeBridge"',
		);
	});

	it("can also enforce names for public package entrypoints", () => {
		const strict = {
			...config,
			rules: {
				"astro-yandex-cloud/default-import-name": [
					"error",
					{ includePackageEntrypoints: true },
				],
			},
		} satisfies Linter.Config;

		const messages = linter.verify(
			'import adapter from "./src";',
			strict,
			options,
		);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.message).toContain('as "Src"');
		expect(
			linter.verify(
				'import Package from "./package";',
				strict,
				options,
			),
		).toEqual([]);
	});

	it("reports a directory name that cannot be a PascalCase identifier", () => {
		expect(
			linter.verify(
				'import Routes from "./404";',
				config,
				options,
			),
		).toMatchObject([{ messageId: "directory" }]);
	});
});
