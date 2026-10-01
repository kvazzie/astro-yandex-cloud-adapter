export interface RegistryVersionMetadata {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  resolved?: string;
  integrity?: string;
  license?: string;
  engines?: Record<string, string>;
}

export interface Registry {
  resolve(packageName: string, version: string): Promise<RegistryVersionMetadata>;
}

export const npmRegistry: Registry = { resolve: fetchRegistryMetadata };

const NPM_REGISTRY_URL = "https://registry.npmjs.org";

async function fetchRegistryMetadata(
  packageName: string,
  version: string,
): Promise<RegistryVersionMetadata> {
  const encodedName = packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `${NPM_REGISTRY_URL}/${encodedName}/${encodeURIComponent(version)}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(
      `The "install" dependency strategy cannot resolve the runtime package "${packageName}@${version}" from the npm registry. Check network access and try again.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `The "install" dependency strategy cannot resolve the runtime package "${packageName}@${version}" from the npm registry (HTTP ${response.status}).`,
    );
  }
  const metadata = (await response.json()) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    dist?: { tarball?: string; integrity?: string };
    license?: unknown;
    engines?: Record<string, string>;
  };
  return {
    dependencies: metadata.dependencies,
    optionalDependencies: metadata.optionalDependencies,
    resolved: metadata.dist?.tarball,
    integrity: metadata.dist?.integrity,
    license: extractLicenseIdentifier(metadata.license),
    engines: metadata.engines,
  };
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
