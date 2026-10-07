import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, readFile } from "node:fs/promises";

import type { PackageJson } from "pkg-types";
import semver from "semver";

import {
  compareNames,
  type ResolvedRuntimeDependency,
} from "../install-lockfile.js";
import { asDirectoryPath, type DirectoryPath } from "./imports.js";
import type { Registry, RegistryVersionMetadata } from "./registry.js";

interface DependencySource {
  version: string;
  directory?: string;
  metadata?: RegistryVersionMetadata;
}

/** Pins the runtime graph, including optional packages absent on the build host. */
export async function resolvePinnedRuntimeDependencies(
  appRoot: URL,
  directDependencyNames: Set<string>,
  registry: Registry,
): Promise<ResolvedRuntimeDependency[]> {
  const appDirectory = asDirectoryPath(fileURLToPath(appRoot));
  const appManifestPath = new URL("package.json", appRoot);
  const pinned = new Map<string, ResolvedRuntimeDependency>();
  const visited = new Set<string>();
  const discoveredVersions = new Map<string, string>();
  const pending: Array<{
    dependencyName: string;
    resolutionBases: Array<URL | string>;
    source?: DependencySource;
  }> = Array.from(directDependencyNames)
    .sort()
    .map((dependencyName) => ({
      dependencyName,
      resolutionBases: [appManifestPath],
    }));
  while (pending.length) {
    const current = pending.shift();
    if (!current) continue;
    const source: DependencySource | undefined =
      current.source ??
      (await findInstalledPackage(
        current.resolutionBases,
        current.dependencyName,
      ));
    if (!source) {
      throw new Error(
        `The "install" dependency strategy cannot resolve the runtime package "${current.dependencyName}" imported by the Function Artifact. Install it as an application dependency so its exact version can be written to the Function Artifact.`,
      );
    }
    assertCompatibleVersion(
      discoveredVersions,
      current.dependencyName,
      source.version,
    );
    if (visited.has(current.dependencyName)) continue;
    visited.add(current.dependencyName);
    const metadata =
      source.metadata ??
      (await readLocalLockMetadata(
        appDirectory,
        current.dependencyName,
        source.version,
      )) ??
      (await registry.resolve(current.dependencyName, source.version));
    const dependencies: Record<string, string> = {};
    const optionalDependencies: Record<string, string> = {};
    const resolutionBases = [
      ...(source.directory ? [join(source.directory, "package.json")] : []),
      appManifestPath,
    ];
    const transitiveRanges = [
      ...Object.entries(metadata.dependencies ?? {})
        .filter(([name]) => metadata.optionalDependencies?.[name] === undefined)
        .map(([name, range]) => ({ name, range, optional: false })),
      ...Object.entries(metadata.optionalDependencies ?? {}).map(
        ([name, range]) => ({ name, range, optional: true }),
      ),
    ].sort((a, b) => compareNames(a.name, b.name));
    for (const { name, range, optional } of transitiveRanges) {
      let dependency: DependencySource | undefined = await findInstalledPackage(
        resolutionBases,
        name,
      );
      if (!dependency || !semver.satisfies(dependency.version, range)) {
        if (!optional && source.directory) {
          throw new Error(
            `The "install" dependency strategy cannot resolve the runtime package "${name}" (required by "${current.dependencyName}" as "${range}"). Install a matching application dependency.`,
          );
        }
        const remoteMetadata = await registry.resolve(name, range);
        const version = remoteMetadata.version ?? semver.valid(range);
        if (!version) {
          throw new Error(
            `The "install" dependency strategy cannot pin ${name}@${range} to an exact version.`,
          );
        }
        dependency = { version, metadata: remoteMetadata };
      }
      assertCompatibleVersion(discoveredVersions, name, dependency.version);
      (optional ? optionalDependencies : dependencies)[name] = dependency.version;
      if (!visited.has(name)) {
        pending.push({
          dependencyName: name,
          resolutionBases,
          source: dependency,
        });
      }
    }
    pinned.set(current.dependencyName, {
      name: current.dependencyName,
      version: source.version,
      ...(metadata.resolved !== undefined ? { resolved: metadata.resolved } : {}),
      ...(metadata.integrity !== undefined
        ? { integrity: metadata.integrity }
        : {}),
      ...(metadata.license !== undefined ? { license: metadata.license } : {}),
      ...(metadata.engines !== undefined ? { engines: metadata.engines } : {}),
      ...(metadata.os !== undefined ? { os: metadata.os } : {}),
      ...(metadata.cpu !== undefined ? { cpu: metadata.cpu } : {}),
      ...(metadata.libc !== undefined ? { libc: metadata.libc } : {}),
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
      ...(Object.keys(optionalDependencies).length
        ? { optionalDependencies }
        : {}),
    });
  }
  // An optional-first discovery must not make a later required edge optional.
  const required = new Set<string>();
  const requiredPending = [...directDependencyNames];
  while (requiredPending.length) {
    const name = requiredPending.shift()!;
    if (required.has(name)) continue;
    required.add(name);
    requiredPending.push(...Object.keys(pinned.get(name)?.dependencies ?? {}));
  }
  return [...pinned.values()].map((dependency) =>
    required.has(dependency.name) ? dependency : { ...dependency, optional: true },
  );
}

function assertCompatibleVersion(
  discoveredVersions: Map<string, string>,
  dependencyName: string,
  version: string,
): void {
  const previous = discoveredVersions.get(dependencyName);
  if (previous !== undefined && previous !== version) {
    throw new Error(
      `The "install" dependency strategy found conflicting versions of the runtime package "${dependencyName}" (${previous} and ${version}). The Function Artifact lockfile cannot represent both. Align dependency versions or use dependencyStrategy: "bundle" when the package can be bundled.`,
    );
  }
  discoveredVersions.set(dependencyName, version);
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
  os?: string[];
  cpu?: string[];
  libc?: string[];
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
    os: entry.os,
    cpu: entry.cpu,
    libc: entry.libc,
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
