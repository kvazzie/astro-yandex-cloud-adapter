import semver from "semver";

export interface RegistryVersionMetadata {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  resolved?: string;
  integrity?: string;
  license?: string;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

export interface Registry {
  resolve(packageName: string, version: string): Promise<RegistryVersionMetadata>;
}

export const npmRegistry: Registry = { resolve: fetchRegistryMetadata };

interface PublishedVersion {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  dist?: { tarball?: string; integrity?: string };
  license?: unknown;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

/** Resolves exact versions and ranges needed by uninstalled optional packages. */
async function fetchRegistryMetadata(
  packageName: string,
  requirement: string,
): Promise<RegistryVersionMetadata> {
  const encodedName = packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const registryUrl = (
    process.env.npm_config_registry ?? "https://registry.npmjs.org"
  ).replace(/\/+$/, "");
  const packageUrl = `${registryUrl}/${encodedName}`;
  let version = semver.valid(requirement);
  let metadata: PublishedVersion;
  if (version) {
    metadata = await requestMetadata<PublishedVersion>(
      `${packageUrl}/${encodeURIComponent(version)}`,
      packageName,
      requirement,
    );
  } else {
    const packument = await requestMetadata<{
      versions: Record<string, PublishedVersion>;
    }>(packageUrl, packageName, requirement);
    version = semver.maxSatisfying(Object.keys(packument.versions), requirement);
    if (!version) {
      throw new Error(
        `The "install" dependency strategy cannot resolve ${packageName}@${requirement} to an exact registry version.`,
      );
    }
    metadata = packument.versions[version]!;
  }
  return {
    version,
    dependencies: metadata.dependencies,
    optionalDependencies: metadata.optionalDependencies,
    resolved: metadata.dist?.tarball,
    integrity: metadata.dist?.integrity,
    license: extractLicenseIdentifier(metadata.license),
    engines: metadata.engines,
    os: metadata.os,
    cpu: metadata.cpu,
    libc: metadata.libc,
  };
}

async function requestMetadata<T>(
  url: string,
  packageName: string,
  requirement: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(
      `The "install" dependency strategy cannot resolve the runtime package "${packageName}@${requirement}" from the npm registry. Check network access and try again.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `The "install" dependency strategy cannot resolve the runtime package "${packageName}@${requirement}" from the npm registry (HTTP ${response.status}).`,
    );
  }
  return (await response.json()) as T;
}

function extractLicenseIdentifier(license: unknown): string | undefined {
  if (typeof license === "string") return license;
  if (Array.isArray(license)) {
    const types = license
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof entry === "object" && entry !== null && "type" in entry
            ? (entry as { type?: unknown }).type
            : undefined,
      )
      .filter((entry): entry is string => typeof entry === "string");
    return types.length ? types.join(" OR ") : undefined;
  }
  if (typeof license === "object" && license !== null && "type" in license) {
    const type = (license as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  }
  return undefined;
}
