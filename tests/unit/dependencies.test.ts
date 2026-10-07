import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvePinnedRuntimeDependencies } from "../../packages/adapter/src/function/dependencies.js";
import {
  formatFunctionPackageJson,
  formatNpmLockfile,
} from "../../packages/adapter/src/install-lockfile.js";
import type {
  Registry,
  RegistryVersionMetadata,
} from "../../packages/adapter/src/function/registry.js";

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
        resolve(name): Promise<RegistryVersionMetadata> {
          return Promise.resolve<RegistryVersionMetadata>(
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
  it("retains uninstalled native variants and their required children as optional", async () => {
    const app = await mkdtemp(join(tmpdir(), "astro-yandex-platforms-"));
    try {
      await mkdir(join(app, "node_modules", "sharp"), { recursive: true });
      await writeFile(join(app, "package.json"), JSON.stringify({ name: "app" }));
      await writeFile(
        join(app, "node_modules", "sharp", "package.json"),
        JSON.stringify({ name: "sharp", version: "1.0.0" }),
      );
      const registry: Registry = {
        resolve(name): Promise<RegistryVersionMetadata> {
          return Promise.resolve<RegistryVersionMetadata>(
            name === "sharp"
              ? {
                  optionalDependencies: {
                    "native-linux": "1.0.0",
                    "native-darwin": "1.0.0",
                  },
                }
              : name === "native-linux"
                ? {
                    version: "1.0.0",
                    os: ["linux"],
                    cpu: ["x64"],
                    libc: ["glibc"],
                    dependencies: { "native-helper": "^1.0.0" },
                  }
                : name === "native-darwin"
                  ? { version: "1.0.0", os: ["darwin"], cpu: ["arm64"] }
                  : { version: "1.2.3" },
          );
        },
      };
      const dependencies = await resolvePinnedRuntimeDependencies(
        pathToFileURL(`${app}/`),
        new Set(["sharp"]),
        registry,
      );
      const packageJson = JSON.parse(formatFunctionPackageJson(dependencies)) as {
        dependencies: Record<string, string>;
        optionalDependencies: Record<string, string>;
      };
      expect(packageJson.dependencies).toEqual({ sharp: "1.0.0" });
      expect(packageJson.optionalDependencies).toEqual({
        "native-darwin": "1.0.0",
        "native-helper": "1.2.3",
        "native-linux": "1.0.0",
      });
      const lock = JSON.parse(formatNpmLockfile(dependencies)) as {
        packages: Record<string, unknown>;
      };
      expect(lock.packages["node_modules/native-linux"]).toMatchObject({
        version: "1.0.0",
        optional: true,
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
        dependencies: { "native-helper": "1.2.3" },
      });
      expect(lock.packages["node_modules/native-darwin"]).toMatchObject({
        optional: true,
        os: ["darwin"],
      });
      expect(lock.packages["node_modules/native-helper"]).toMatchObject({
        optional: true,
      });
    } finally {
      await rm(app, { recursive: true, force: true });
    }
  });

  it("keeps a dependency required when an optional edge discovers it first", async () => {
    const app = await mkdtemp(join(tmpdir(), "astro-yandex-required-"));
    try {
      await writeFile(join(app, "package.json"), JSON.stringify({ name: "app" }));
      for (const name of ["alpha", "beta", "shared", "leaf"]) {
        const directory = join(app, "node_modules", name);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({ name, version: "1.0.0" }),
        );
      }
      const registry: Registry = {
        resolve(name): Promise<RegistryVersionMetadata> {
          return Promise.resolve<RegistryVersionMetadata>(
            name === "alpha"
              ? { optionalDependencies: { shared: "1.0.0" } }
              : name === "beta"
                ? { dependencies: { shared: "1.0.0" } }
                : name === "shared"
                  ? { dependencies: { leaf: "1.0.0" } }
                  : {},
          );
        },
      };
      const dependencies = await resolvePinnedRuntimeDependencies(
        pathToFileURL(`${app}/`),
        new Set(["alpha", "beta"]),
        registry,
      );
      const packageJson = JSON.parse(formatFunctionPackageJson(dependencies)) as {
        dependencies: Record<string, string>;
        optionalDependencies?: unknown;
      };
      expect(packageJson.dependencies).toMatchObject({
        shared: "1.0.0",
        leaf: "1.0.0",
      });
      expect(packageJson.optionalDependencies).toBeUndefined();
    } finally {
      await rm(app, { recursive: true, force: true });
    }
  });
});
