/** Exact runtime dependency metadata for install Function Artifacts. */

export interface ResolvedRuntimeDependency {
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

function sortedDependencies(
  dependencies: ResolvedRuntimeDependency[],
): ResolvedRuntimeDependency[] {
  return dependencies.toSorted((a, b) => compareNames(a.name, b.name));
}

function exactDependencies(
  dependencies: ResolvedRuntimeDependency[],
): Record<string, string> {
  const exact: Record<string, string> = {};
  for (const dependency of sortedDependencies(dependencies)) {
    exact[dependency.name] = dependency.version;
  }
  return exact;
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
  dependencies: ResolvedRuntimeDependency[],
): string {
  return `${JSON.stringify(
    {
      private: true,
      type: "module",
      engines: { node: FUNCTION_NODE_RANGE },
      dependencies: exactDependencies(dependencies),
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

function lockPackageEntry(
  dependency: ResolvedRuntimeDependency,
): NpmLockPackageEntry {
  const entry: NpmLockPackageEntry = { version: dependency.version };
  if (dependency.resolved !== undefined) entry.resolved = dependency.resolved;
  if (dependency.integrity !== undefined) entry.integrity = dependency.integrity;
  if (dependency.license !== undefined) entry.license = dependency.license;
  if (dependency.engines !== undefined)
    entry.engines = sortedRecord(dependency.engines);
  const dependencies = sortedRecord(dependency.dependencies);
  if (dependencies !== undefined) entry.dependencies = dependencies;
  const optionalDependencies = sortedRecord(dependency.optionalDependencies);
  if (optionalDependencies !== undefined)
    entry.optionalDependencies = optionalDependencies;
  return entry;
}

/** Formats a deterministic npm lockfileVersion 3 for install artifacts. */
export function formatNpmLockfile(
  dependencies: ResolvedRuntimeDependency[],
): string {
  const sorted = sortedDependencies(dependencies);
  const direct = exactDependencies(sorted);
  const lockPackages: Record<string, NpmLockPackageEntry> = {
    "": { version: "1.0.0", dependencies: direct },
  };
  const legacy: Record<string, NpmLockPackageEntry> = {};
  for (const dependency of sorted) {
    const entry = lockPackageEntry(dependency);
    lockPackages[`node_modules/${dependency.name}`] = entry;
    legacy[dependency.name] = entry;
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
