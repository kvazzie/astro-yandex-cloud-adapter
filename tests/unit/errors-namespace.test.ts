import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yandexCloud from "@astro-yandex-cloud/eslint-plugin";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(
	join(tmpdir(), "errors-namespace-"),
);
mkdirSync(join(directory, "Module"));
writeFileSync(join(directory, "Module/Errors.ts"), "");
writeFileSync(join(directory, "Module/index.ts"), "");
afterAll(() =>
	rmSync(directory, { recursive: true, force: true }),
);

const linter = new Linter({ cwd: directory });
const config = {
	files: ["**/*.ts"],
	languageOptions: { parser: tseslint.parser },
	plugins: { "astro-yandex-cloud": yandexCloud },
	rules: { "astro-yandex-cloud/errors-namespace": "error" },
} satisfies Linter.Config;

describe("module error namespaces", () => {
	it("accepts a namespace import and export from the owning index", () => {
		expect(
			linter.verify(
				'import * as Errors from "./Errors.ts"; export * as Errors from "./Errors.ts";',
				config,
				{ filename: join(directory, "Module/index.ts") },
			),
		).toEqual([]);
	});

	it("requires the index to expose its PascalCase error file", () => {
		expect(
			linter.verify("export {};", config, {
				filename: join(directory, "Module/index.ts"),
			}),
		).toMatchObject([{ messageId: "missingExport" }]);
	});

	it.each([
		'import * as Errors from "./Module/Errors.ts";',
		'import { Failure } from "./Module/Errors.ts";',
		'void import("./Module/Errors.ts");',
		'type Failure = import("./Module/Errors.ts").Failure;',
	])("rejects bypassing the module index: %s", (source) => {
		expect(
			linter.verify(source, config, {
				filename: join(directory, "consumer.ts"),
			}),
		).toMatchObject([{ messageId: "importNamespace" }]);
	});

	it("rejects named error re-exports from the owning index", () => {
		const messages = linter.verify(
			'export { Failure } from "./Errors.ts";',
			config,
			{ filename: join(directory, "Module/index.ts") },
		);
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					messageId: "exportNamespace",
				}),
			]),
		);
	});

	it("accepts access through a public module namespace", () => {
		expect(
			linter.verify(
				'import * as Module from "./Module"; type Failure = Module.Errors.Failure;',
				config,
				{ filename: join(directory, "consumer.ts") },
			),
		).toEqual([]);
	});
});
