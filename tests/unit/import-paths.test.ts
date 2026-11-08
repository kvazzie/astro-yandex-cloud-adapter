import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yandexCloud from "@astro-yandex-cloud/eslint-plugin";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "import-paths-"));
for (const file of [
  "index.ts",
  "file.ts",
  "file.test.ts",
  "module/index.ts",
  "nested/consumer.ts",
  "ambiguous.ts",
  "ambiguous/index.ts",
  "native.js",
  "data.json",
]) {
  mkdirSync(join(directory, file, ".."), { recursive: true });
  writeFileSync(join(directory, file), "");
}
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const linter = new Linter({ cwd: directory });
const config = {
  files: ["**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  plugins: { "astro-yandex-cloud": yandexCloud },
  rules: { "astro-yandex-cloud/import-paths": "error" },
} satisfies Linter.Config;
const options = { filename: join(directory, "consumer.ts") };

describe("TypeScript import specifiers", () => {
  it.each([
    ['import "./file.js";', 'import "./file.ts";'],
    ['import "./file";', 'import "./file.ts";'],
    ['import "./file.test";', 'import "./file.test.ts";'],
    ['import "./module/index.js";', 'import "./module";'],
    ['import "./module/index.ts";', 'import "./module";'],
    ['import "./module/index";', 'import "./module";'],
    ['import "./index.ts";', 'import ".";'],
    ['import "./module/";', 'import "./module";'],
    ['import "./ambiguous";', 'import "./ambiguous.ts";'],
    ['import "./ambiguous/index.ts";', 'import "./ambiguous/";'],
    ['import "./file.js?raw#part";', 'import "./file.ts?raw#part";'],
    [
      'import type { Value } from "./module/index.js";',
      'import type { Value } from "./module";',
    ],
    ['export { value } from "./file.js";', 'export { value } from "./file.ts";'],
    ['export * from "./module/index.ts";', 'export * from "./module";'],
    [
      'export * as Module from "./module/index.js";',
      'export * as Module from "./module";',
    ],
    [
      'export type { Value } from "./file.js";',
      'export type { Value } from "./file.ts";',
    ],
    ['void import("./file.js");', 'void import("./file.ts");'],
    ["void import(`./module/index.js`);", 'void import("./module");'],
    [
      'type Value = import("./file.js").Value;',
      'type Value = import("./file.ts").Value;',
    ],
    ['require("./file.js");', 'require("./file.ts");'],
  ])("fixes %s", (source, expected) => {
    expect(linter.verify(source, config, options)).toMatchObject([
      { ruleId: "astro-yandex-cloud/import-paths" },
    ]);
    const result = linter.verifyAndFix(source, config, options);
    expect(result.output).toBe(expected);
    expect(result.messages).toEqual([]);
  });

  it.each([
    'import "./file.ts";',
    'import "./module";',
    'import "./ambiguous/";',
    'import "./native.js";',
    'import "./data.json";',
    'import "package/module/index.js";',
    'import "node:fs";',
    "void import(variable);",
    "void import(`./${variable}.js`);",
    'new URL("./file.js", import.meta.url);',
  ])("accepts %s", (source) => {
    expect(linter.verify(source, config, options)).toEqual([]);
  });

  it("resolves parent directories relative to the importing file", () => {
    const result = linter.verifyAndFix('import "../index.js";', config, {
      filename: join(directory, "nested/consumer.ts"),
    });
    expect(result.output).toBe('import "..";');
    expect(result.messages).toEqual([]);
  });
});
