import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, readFile } from "node:fs/promises";

import type { PackageJson } from "pkg-types";

import {
  compareNames,
  type ResolvedRuntimeDependency,
} from "../install-lockfile.js";
import { asDirectoryPath, type DirectoryPath } from "./imports.js";
import type { Registry, RegistryVersionMetadata } from "./registry.js";

export async function resolvePinnedRuntimeDependencies(
  appRoot: URL,
  directDependencyNames: Set<string>,
  registry: Registry,
): Promise<ResolvedRuntimeDependency[]> {
  const appDirectory = asDirectoryPath(fileURLToPath(appRoot));
  const appManifestPath = new URL("package.json", appRoot);
  const pinned = new Map<string, ResolvedRuntimeDependency>();
  const visited = new Set<string>();
  // Set order follows discovery; sort for a deterministic resolution order.
  const pending: Array<{
    dependencyName: string;
    resolutionBases: Array<URL | string>;
  }> = Array.from(directDependencyNames)
    .sort()
    .map((dependencyName) => ({
      dependencyName,
      resolutionBases: [appManifestPath],
    }));
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current.dependencyName)) continue;
    visited.add(current.dependencyName);
    const installedPackage = await findInstalledPackage(
      current.resolutionBases,
      current.dependencyName,
    );
    if (!installedPackage) {
      throw new Error(
        `The "install" dependency strategy cannot resolve the runtime package "${current.dependencyName}" imported by the Function Artifact. Install it as an application dependency so its exact version can be written to the Function Artifact.`,
      );
    }
    const localMetadata = await readLocalLockMetadata(
      appDirectory,
      current.dependencyName,
      installedPackage.version,
    );
    const metadata =
      localMetadata ||
      (await registry.resolve(current.dependencyName, installedPackage.version));
    const dependencies: Record<string, string> = {};
    const optionalDependencies: Record<string, string> = {};
    const dependentManifestPath = join(installedPackage.directory, "package.json");
    const transitiveRanges: Array<{
      name: string;
      range: string;
      optional: boolean;
    }> = [
      ...Object.entries(metadata.dependencies ?? {})
        .sort(([a], [b]) => compareNames(a, b))
        .map(([name, range]) => ({ name, range, optional: false })),
      ...Object.keys(metadata.optionalDependencies ?? {})
        .sort(compareNames)
        .map((name) => ({ name, range: "", optional: true })),
    ];
    for (const { name: dependencyName, range, optional } of transitiveRanges) {
      const installedDependency = await findInstalledPackage(
        [dependentManifestPath, appManifestPath],
        dependencyName,
      );
      if (!installedDependency) {
        if (optional) continue;
        throw new Error(
          `The "install" dependency strategy cannot resolve the runtime package "${dependencyName}" (required by "${current.dependencyName}" as "${range}"). Install it as an application dependency so its exact version can be written to the Function Artifact.`,
        );
      }
      (optional ? optionalDependencies : dependencies)[dependencyName] =
        installedDependency.version;
      if (!visited.has(dependencyName))
        pending.push({
          dependencyName,
          resolutionBases: [
            join(installedDependency.directory, "package.json"),
            appManifestPath,
          ],
        });
    }
    pinned.set(current.dependencyName, {
      name: current.dependencyName,
      version: installedPackage.version,
      ...(metadata.resolved !== undefined ? { resolved: metadata.resolved } : {}),
      ...(metadata.integrity !== undefined
        ? { integrity: metadata.integrity }
        : {}),
      ...(metadata.license !== undefined ? { license: metadata.license } : {}),
      ...(metadata.engines !== undefined ? { engines: metadata.engines } : {}),
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
      ...(Object.keys(optionalDependencies).length
        ? { optionalDependencies }
        : {}),
    });
  }
  return [...pinned.values()];
}

async function findInstalledPackage(
  resolutionBases: Array<URL | string>,
  packageName: string,
): Promise<{ version: string; directory: string } | undefined> {
  for (const resolutionBase of resolutionBases) {
    const installed = await findPackageFromBase(resolutionBase, packageName);
    if (installed) return installed;
  }
  return undefined;
}

async function findPackageFromBase(
  resolutionBase: URL | string,
  packageName: string,
): Promise<{ version: string; directory: string } | undefined> {
  const requireFunction = createRequire(resolutionBase);
  const manifestPath = tryResolveModule(
    requireFunction,
    `${packageName}/package.json`,
  );
  if (manifestPath) {
    const manifest = await readJsonFile<PackageJson>(manifestPath);
    if (manifest?.version !== undefined)
      return { version: manifest.version, directory: dirname(manifestPath) };
  }
  const entryPoint = tryResolveModule(requireFunction, packageName);
  if (!entryPoint) return undefined;
  let current: string | undefined = dirname(entryPoint);
  while (current !== undefined) {
    const manifest = await readJsonFile<PackageJson>(
      join(current, "package.json"),
    );
    if (
      manifest !== undefined &&
      manifest.name === packageName &&
      manifest.version !== undefined
    )
      return { version: manifest.version, directory: current };
    current = parentDirectory(current);
  }
  return undefined;
}

function tryResolveModule(
  requireFunction: ReturnType<typeof createRequire>,
  importSpecifier: string,
): string | undefined {
  try {
    return requireFunction.resolve(importSpecifier);
  } catch {
    return undefined;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function parentDirectory(childPath: string): string | undefined {
  const parent = dirname(childPath);
  return parent === childPath ? undefined : parent;
}

interface NpmLockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  license?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface NpmLockfile {
  packages?: Record<string, NpmLockEntry>;
  dependencies?: Record<string, NpmLockEntry>;
}

async function readLocalLockMetadata(
  fromDirectory: DirectoryPath,
  packageName: string,
  version: string,
): Promise<RegistryVersionMetadata | undefined> {
  const lockfilePath = await findNearestPackageLock(fromDirectory);
  if (!lockfilePath) return undefined;
  const lockfile = await readJsonFile<NpmLockfile>(lockfilePath);
  const lockEntry = lockfile?.packages?.[`node_modules/${packageName}`];
  const entry = lockEntry ?? lockfile?.dependencies?.[packageName];
  if (!entry || entry.version !== version) return undefined;
  return {
    resolved: entry.resolved,
    integrity: entry.integrity,
    license: entry.license,
    engines: entry.engines,
    // The packages section pins exact transitive versions; the legacy
    // section only carries ranges, so transitive discovery uses packages.
    dependencies: lockEntry?.dependencies,
    optionalDependencies: lockEntry?.optionalDependencies,
  };
}

async function findNearestPackageLock(
  fromDirectory: DirectoryPath,
): Promise<string | undefined> {
  let current: string | undefined = resolve(fromDirectory);
  while (current !== undefined) {
    const candidate = join(current, "package-lock.json");
    if (await pathExists(candidate)) return candidate;
    current = parentDirectory(current);
  }
  return undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
