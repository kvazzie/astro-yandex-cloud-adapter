import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvePinnedRuntimeDependencies } from "../../packages/adapter/src/function/dependencies.js";
import type { Registry } from "../../packages/adapter/src/function/registry.js";

describe("install dependency resolution", () => {
  it("fails when the flat Function Artifact lockfile cannot represent two versions", async () => {
    const app = await mkdtemp(join(tmpdir(), "astro-yandex-versions-"));
    const writePackage = async (
      directory: string,
      name: string,
      version: string,
    ) => {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name, version }),
      );
    };
    try {
      await writePackage(app, "app", "1.0.0");
      for (const [parent, version] of [
        ["alpha", "1.0.0"],
        ["beta", "2.0.0"],
      ] as const) {
        await writePackage(join(app, "node_modules", parent), parent, "1.0.0");
        await writePackage(
          join(app, "node_modules", parent, "node_modules", "shared"),
          "shared",
          version,
        );
      }
      const registry: Registry = {
        resolve(name) {
          return Promise.resolve(
            name === "shared"
              ? {}
              : { dependencies: { shared: "^1.0.0 || ^2.0.0" } },
          );
        },
      };
      await expect(
        resolvePinnedRuntimeDependencies(
          pathToFileURL(`${app}/`),
          new Set(["alpha", "beta"]),
          registry,
        ),
      ).rejects.toThrow(
        /conflicting versions of the runtime package "shared" \(1\.0\.0 and 2\.0\.0\)/,
      );
    } finally {
      await rm(app, { recursive: true, force: true });
    }
  });
});
