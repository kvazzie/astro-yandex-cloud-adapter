/** Exact runtime dependency metadata for install Function Artifacts. */

export interface ResolvedRuntimePackage {
  name: string;
  version: string;
  resolved?: string;
  integrity?: string;
  license?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export const FUNCTION_NODE_RANGE = ">=22.12.0";
export const NPM_LOCKFILE_VERSION = 3;

export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedPackages(
  packages: ResolvedRuntimePackage[],
): ResolvedRuntimePackage[] {
  return [...packages].sort((a, b) => compareNames(a.name, b.name));
}

function exactDependencies(
  packages: ResolvedRuntimePackage[],
): Record<string, string> {
  const dependencies: Record<string, string> = {};
  for (const package_ of sortedPackages(packages)) {
    dependencies[package_.name] = package_.version;
  }
  return dependencies;
}

function sortedRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort(compareNames)) {
    const value = record[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

/** Formats the Function Artifact package.json with exact dependency versions. */
export function formatFunctionPackageJson(
  packages: ResolvedRuntimePackage[],
): string {
  return `${JSON.stringify(
    {
      private: true,
      type: "module",
      engines: { node: FUNCTION_NODE_RANGE },
      dependencies: exactDependencies(packages),
    },
    null,
    2,
  )}\n`;
}

interface NpmLockPackageEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  license?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function lockPackageEntry(package_: ResolvedRuntimePackage): NpmLockPackageEntry {
  const entry: NpmLockPackageEntry = { version: package_.version };
  if (package_.resolved !== undefined) entry.resolved = package_.resolved;
  if (package_.integrity !== undefined) entry.integrity = package_.integrity;
  if (package_.license !== undefined) entry.license = package_.license;
  if (package_.engines !== undefined)
    entry.engines = sortedRecord(package_.engines);
  const dependencies = sortedRecord(package_.dependencies);
  if (dependencies !== undefined) entry.dependencies = dependencies;
  const optionalDependencies = sortedRecord(package_.optionalDependencies);
  if (optionalDependencies !== undefined)
    entry.optionalDependencies = optionalDependencies;
  return entry;
}

/** Formats a deterministic npm lockfileVersion 3 for install artifacts. */
export function formatNpmLockfile(packages: ResolvedRuntimePackage[]): string {
  const sorted = sortedPackages(packages);
  const direct = exactDependencies(sorted);
  const lockPackages: Record<string, NpmLockPackageEntry> = {
    "": { version: "1.0.0", dependencies: direct },
  };
  const legacy: Record<string, NpmLockPackageEntry> = {};
  for (const package_ of sorted) {
    const entry = lockPackageEntry(package_);
    lockPackages[`node_modules/${package_.name}`] = entry;
    legacy[package_.name] = entry;
  }
  return `${JSON.stringify(
    {
      name: "function",
      version: "1.0.0",
      lockfileVersion: NPM_LOCKFILE_VERSION,
      requires: true,
      packages: lockPackages,
      dependencies: legacy,
    },
    null,
    2,
  )}\n`;
}
