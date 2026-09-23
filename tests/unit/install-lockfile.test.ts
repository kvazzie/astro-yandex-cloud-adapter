import { describe, expect, it } from "vitest";

import {
  formatFunctionPackageJson,
  formatNpmLockfile,
} from "../../packages/adapter/src/install-lockfile.js";
import type { ResolvedRuntimeDependency } from "../../packages/adapter/src/install-lockfile.js";

const nanoid: ResolvedRuntimeDependency = {
  name: "nanoid",
  version: "3.3.17",
  resolved: "https://registry.npmjs.org/nanoid/-/nanoid-3.3.17.tgz",
  integrity:
    "sha512-xQLf0A3HOMlgHq0n247/LRuAOYmB7dXJ/DvAxGvsSBij45XtBSmQycu+F8ODbHwns/XyFZagyL1+J0Offw1E0g==",
  license: "MIT",
  engines: { node: "^10 || ^12 || ^13.7 || ^14 || >=15.0.1" },
};

describe("install artifact metadata", () => {
  it("formats exact package.json deterministically", () => {
    const first = formatFunctionPackageJson([nanoid]);
    expect(formatFunctionPackageJson([nanoid])).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(first) as {
      dependencies?: Record<string, string>;
    };
    expect(parsed.dependencies).toEqual({ nanoid: "3.3.17" });
    expect(first).not.toContain("^");
  });

  it("orders dependencies alphabetically in package.json", () => {
    const second: ResolvedRuntimeDependency = {
      name: "aproject",
      version: "1.0.0",
    };
    const first = formatFunctionPackageJson([nanoid, second]);
    expect(formatFunctionPackageJson([second, nanoid])).toBe(first);
    const parsed = JSON.parse(first) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(parsed.dependencies ?? {})).toEqual(["aproject", "nanoid"]);
  });

  it("formats a deterministic npm lockfile with no version ranges", () => {
    const first = formatNpmLockfile([nanoid]);
    expect(formatNpmLockfile([nanoid])).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    const lockfile = JSON.parse(first) as {
      lockfileVersion?: number;
      packages?: Record<
        string,
        {
          version?: string;
          dependencies?: Record<string, string>;
        }
      >;
    };
    expect(lockfile.lockfileVersion).toBe(3);
    expect(lockfile.packages?.[""]?.dependencies).toEqual({
      nanoid: "3.3.17",
    });
    expect(lockfile.packages?.["node_modules/nanoid"]?.version).toBe("3.3.17");
    for (const entry of Object.values(lockfile.packages ?? {})) {
      for (const version of Object.values(entry.dependencies ?? {})) {
        expect(version).not.toMatch(/^[\^~><=*\s]/);
      }
    }
  });
});
