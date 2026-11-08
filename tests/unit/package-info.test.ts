import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { readPackageInfo } from "@astro-yandex-cloud/package-info";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "package-info-"));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function writePackage(root: string, manifest: unknown) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
}

function moduleUrl(relative: string) {
  const path = join(directory, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "export {};\n");
  return pathToFileURL(path);
}

describe("package info", () => {
  it.each(["string", "URL"])(
    "reads the caller's metadata using a %s file URL",
    (format) => {
      const metadata = { name: "@example/adapter", version: "1.2.3-beta.4" };
      writePackage(directory, { ...metadata, private: true });
      const url = moduleUrl("src/source files/#metadata.js");

      expect(readPackageInfo(format === "string" ? url.href : url)).toEqual(
        metadata,
      );
    },
  );

  it("uses the nearest package instead of the enclosing workspace", () => {
    writePackage(directory, { name: "workspace", version: "9.0.0" });
    const metadata = { name: "@example/inner", version: "2.0.0" };
    writePackage(join(directory, "packages/inner"), metadata);

    expect(
      readPackageInfo(moduleUrl("packages/inner/src/deep/module.js")),
    ).toEqual(metadata);
  });

  it("reads installed package metadata from a dist module", () => {
    writePackage(directory, { name: "consumer", version: "9.0.0" });
    const metadata = { name: "@example/installed", version: "3.0.0" };
    writePackage(join(directory, "node_modules/@example/installed"), metadata);

    expect(
      readPackageInfo(
        moduleUrl("node_modules/@example/installed/dist/shared/chunk.js"),
      ),
    ).toEqual(metadata);
  });

  it("does not use the consumer's metadata when an installed package has no manifest", () => {
    writePackage(directory, { name: "consumer", version: "9.0.0" });

    expect(() =>
      readPackageInfo(moduleUrl("node_modules/missing/dist/index.js")),
    ).toThrow("No package.json found");
  });

  it.each(
    [
      null,
      [],
      {},
      { name: "inner" },
      { version: "1.0.0" },
      { name: "", version: "1.0.0" },
      { name: "inner", version: "   " },
      { name: 42, version: "1.0.0" },
      { name: "inner", version: 42 },
    ].map((manifest) => ({ manifest })),
  )(
    "rejects invalid nearest metadata without falling back: $manifest",
    ({ manifest }) => {
      writePackage(directory, { name: "workspace", version: "9.0.0" });
      const root = join(directory, "inner");
      writePackage(root, manifest);

      expect(() => readPackageInfo(moduleUrl("inner/src/index.js"))).toThrow(
        `${join(root, "package.json")} must declare a non-empty package name and version.`,
      );
    },
  );

  it("reports malformed JSON instead of using the enclosing package", () => {
    writePackage(directory, { name: "workspace", version: "9.0.0" });
    const url = moduleUrl("inner/src/index.js");
    writeFileSync(join(directory, "inner/package.json"), "{");

    expect(() => readPackageInfo(url)).toThrow(SyntaxError);
  });

  it("preserves filesystem errors instead of treating them as missing manifests", () => {
    const url = moduleUrl("src/index.js");
    mkdirSync(join(directory, "package.json"));

    expect(() => readPackageInfo(url)).toThrow(/EISDIR/);
  });
});
