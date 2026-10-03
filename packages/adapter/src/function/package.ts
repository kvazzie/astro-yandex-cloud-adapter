import { fileURLToPath } from "node:url";
import { access, writeFile } from "node:fs/promises";

import type { PackageJson } from "pkg-types";
import * as Effect from "effect/Effect";

import {
  formatFunctionPackageJson,
  formatNpmLockfile,
} from "../install-lockfile.js";
import { npmRegistry, type Registry } from "./registry.js";
import { asDirectoryPath, findRuntimePackageImports } from "./imports.js";
import { resolvePinnedRuntimeDependencies } from "./dependencies.js";

/** Validates and packages an emitted Function Artifact as one operation. */
export function prepareFunctionArtifact(
  functionDirectory: URL,
  appRoot?: URL,
  registry: Registry = npmRegistry,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      const entrypoint = await validateFunctionEntrypoint(functionDirectory);
      if (!entrypoint.ok)
        throw new Error(entrypoint.reason, { cause: entrypoint.cause });
      await finalizeFunctionArtifact(functionDirectory, appRoot, registry);
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

async function finalizeFunctionArtifact(
  functionDirectory: URL,
  appRoot?: URL,
  registry: Registry = npmRegistry,
): Promise<void> {
  const functionDirectoryPath = asDirectoryPath(fileURLToPath(functionDirectory));
  if (appRoot) {
    const directDependencyNames = await findRuntimePackageImports(
      functionDirectoryPath,
      "install",
    );
    const pinnedDependencies = await resolvePinnedRuntimeDependencies(
      appRoot,
      directDependencyNames,
      registry,
    );
    await writeFile(
      new URL("package.json", functionDirectory),
      formatFunctionPackageJson(pinnedDependencies),
    );
    await writeFile(
      new URL("package-lock.json", functionDirectory),
      formatNpmLockfile(pinnedDependencies),
    );
    return;
  }
  const dependencyNames = await findRuntimePackageImports(functionDirectoryPath);
  // The .node scan only sees emitted native modules and specifiers, so a
  // bare import of a native package (sharp) needs this rejection by name
  // to point at install instead of misadvising bundling.
  if (dependencyNames.has("sharp")) {
    throw new Error(
      'The Function Artifact contains the native runtime dependency sharp, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.',
    );
  }
  if (dependencyNames.size) {
    // Set order follows discovery; sort for a deterministic message.
    throw new Error(
      `The "bundle" dependency strategy left unresolved runtime package imports in the Function Artifact: ${Array.from(dependencyNames).sort().join(", ")}. ` +
        'Bundle these packages with Astro/Vite or select dependencyStrategy: "install".',
    );
  }
  const packageJson: PackageJson = {
    private: true,
    type: "module",
    engines: { node: ">=22.12.0" },
    dependencies: {},
  };
  await writeFile(
    new URL("package.json", functionDirectory),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
}

type FunctionEntrypointValidation =
  { ok: true } | { ok: false; reason: string; cause: unknown };

export async function validateFunctionEntrypoint(
  functionDirectory: URL,
): Promise<FunctionEntrypointValidation> {
  const entrypoint = new URL("index.js", functionDirectory);
  try {
    await access(entrypoint);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Astro did not emit the expected function entrypoint at ${entrypoint.pathname}.`,
      cause: error,
    };
  }
}
