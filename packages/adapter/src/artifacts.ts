import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

import { parse } from "acorn";
import type { AstroConfig } from "astro";
import { glob } from "tinyglobby";

import { ADAPTER_NAME, ADAPTER_VERSION } from "./constants.js";
import {
  defineDeploymentManifest,
  parseDeploymentManifest,
} from "./deployment-manifest.js";
import { defaults, type FunctionSharpSupport } from "./defaults.js";
import {
  compareNames,
  formatFunctionPackageJson,
  formatNpmLockfile,
  type ResolvedRuntimeDependency,
} from "./install-lockfile.js";
import type {
  ClientArtifactFile,
  DependencyStrategy,
  PrerenderedRouteRequirement,
  Target,
  YandexCloudManifestV1,
} from "./types.js";

/**
 * Finalizes an existing Function Artifact directory.
 *
 * Call only after validateFunctionEntrypoint succeeds: writes metadata for
 * the entrypoint Astro emitted. With appRoot (the install dependency
 * strategy) pins the bare runtime imports to exact versions in Package
 * JSON and lockfile files; otherwise writes the bundle Package JSON with
 * no runtime Dependencies.
 */
export async function finalizeFunctionArtifact(
  functionDirectory: URL,
  appRoot?: URL,
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
  const packageJson = {
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

export async function getAstroVersion(root: URL): Promise<string> {
  return installedVersion(root, "astro");
}

export function relativeArtifactPath(outDir: URL, artifact: URL): string {
  return relative(fileURLToPath(outDir), fileURLToPath(artifact))
    .split(sep)
    .join("/");
}

interface WriteDeploymentManifestInput {
  deploymentTarget: Target;
  prerendered: string[];
  onDemand: string[];
  hasFunction: boolean;
  sharpSupport?: FunctionSharpSupport;
}

export async function writeDeploymentManifest(
  outDir: URL,
  config: AstroConfig,
  input: WriteDeploymentManifestInput,
): Promise<YandexCloudManifestV1> {
  const client = new URL("client/", outDir);
  const functionDirectory = new URL("function/", outDir);
  const base = normalizedBase(config.base);
  const clientArtifact = await describeClientArtifact(
    client,
    base,
    input.prerendered,
  );
  const manifest = defineDeploymentManifest({
    schemaVersion: 1,
    adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
    astro: { version: await getAstroVersion(config.root) },
    target: input.deploymentTarget,
    buildOutput: input.hasFunction ? "server" : "static",
    base,
    artifacts: {
      client: {
        path: relativeArtifactPath(outDir, client),
        files: clientArtifact.files,
      },
      ...(input.hasFunction
        ? {
            function: {
              path: relativeArtifactPath(outDir, functionDirectory),
              runtime: "nodejs22",
              format: "esm",
              entrypoint: "index.handler",
              support: {
                sharp: input.sharpSupport ?? defaults.SHARP_SUPPORT,
              },
            },
          }
        : {}),
    },
    routes: {
      prerendered: clientArtifact.routes,
      // Set order follows discovery; sort for a deterministic manifest.
      onDemand: Array.from(new Set(input.onDemand))
        .sort()
        .map((pattern) => ({ pattern: withBase(base, pattern) })),
    },
  });
  parseDeploymentManifest(manifest);
  await mkdir(fileURLToPath(outDir), { recursive: true });
  await writeFile(
    new URL("yandex-cloud.json", outDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function findRuntimePackageImports(
  directoryPath: DirectoryPath,
  strategy: DependencyStrategy = defaults.STRATEGY,
): Promise<Set<string>> {
  const dependencyNames = new Set<string>();
  for (const absolutePath of await listFunctionScriptPaths(
    directoryPath,
    strategy,
  )) {
    const moduleSource = await readFile(absolutePath, "utf8");
    const relativePath = relative(directoryPath, absolutePath);
    for (const dependencyName of findImportedPackageNames(
      moduleSource,
      relativePath,
      strategy,
    ))
      dependencyNames.add(dependencyName);
  }
  return dependencyNames;
}

async function listFunctionScriptPaths(
  directoryPath: DirectoryPath,
  strategy: DependencyStrategy = defaults.STRATEGY,
): Promise<string[]> {
  const relativePaths = await emittedRelativePaths(directoryPath);
  const fileNames = relativePaths.map((relativePath) => basename(relativePath));
  const hasNativeModule = fileNames.some((fileName) => fileName.endsWith(".node"));
  if (hasNativeModule && strategy === "bundle") {
    throw new Error(
      'The Function Artifact contains a native runtime module, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.',
    );
  }
  const hasCommonJsModule = fileNames.some((fileName) =>
    fileName.endsWith(".cjs"),
  );
  if (hasCommonJsModule) {
    throw new Error(
      "The function artifact contains an unsupported CommonJS module. V1 function artifacts must use ESM.",
    );
  }
  return relativePaths
    .filter((relativePath) => /\.m?js$/.test(basename(relativePath)))
    .map((relativePath) => join(directoryPath, relativePath));
}

declare const directoryPathBrand: unique symbol;

type DirectoryPath = string & {
  readonly [directoryPathBrand]: "DirectoryPath";
};

function asDirectoryPath(path: string): DirectoryPath {
  return path as DirectoryPath;
}

async function emittedRelativePaths(
  directoryPath: DirectoryPath,
): Promise<string[]> {
  const paths = await glob(["**/*"], {
    cwd: directoryPath,
    dot: true,
    onlyFiles: true,
  });
  return paths.sort(compareNames);
}

function findImportedPackageNames(
  moduleSource: string,
  relativePath: string,
  strategy: DependencyStrategy = defaults.STRATEGY,
): Set<string> {
  const dependencyNames = new Set<string>();
  const program = parse(moduleSource, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as SyntaxNode;

  const collectPackageImport = (importSpecifier: string): void => {
    if (importSpecifier.endsWith(".node") && strategy === "bundle") {
      throw new Error(
        `The Function Artifact contains the native runtime module ${importSpecifier} referenced by ${relativePath}, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.`,
      );
    }
    // Native file imports stay inside the owning package for install builds,
    // so the package itself is pinned; bundle builds cannot carry native code.
    if (!isBareImportSpecifier(importSpecifier)) return;
    dependencyNames.add(packageNameFromSpecifier(importSpecifier));
  };
  const rejectDynamicImport = (): never => {
    if (strategy === "install") {
      throw new Error(
        `The Function Artifact contains unresolved dynamic runtime dependency resolution in ${relativePath}, which cannot use the "install" dependency strategy. Replace it with a fixed package import so its exact version can be written to the Function Artifact.`,
      );
    }
    throw new Error(
      `The Function Artifact contains unresolved dynamic or native runtime dependency resolution in ${relativePath}, which cannot use the "bundle" dependency strategy. Bundle a fixed package import or select dependencyStrategy: "install" to keep runtime package imports.`,
    );
  };
  visitSyntax(program, (node, ancestors) => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration": {
        const importSpecifier = getStaticString(node.source);
        if (importSpecifier) collectPackageImport(importSpecifier);
        return;
      }
      case "ImportExpression": {
        const importSpecifier = getStaticString(node.source);
        if (importSpecifier) {
          collectPackageImport(importSpecifier);
        } else if (!isAstroLoggerImport(node.source, relativePath, ancestors)) {
          rejectDynamicImport();
        }
        return;
      }
      case "CallExpression": {
        const callee = node.callee;
        if (
          !isSyntaxNode(callee) ||
          callee.type !== "Identifier" ||
          (callee.name !== "require" && callee.name !== "__require")
        ) {
          return;
        }
        const arguments_ = node.arguments;
        const requireArgument: unknown = Array.isArray(arguments_)
          ? arguments_[0]
          : undefined;
        collectPackageImport(
          getStaticString(requireArgument) ?? rejectDynamicImport(),
        );
        return;
      }
      default: {
        return;
      }
    }
  });
  return dependencyNames;
}

declare const bareSpecifierBrand: unique symbol;

type BareImportSpecifier = string & {
  readonly [bareSpecifierBrand]: "BareImportSpecifier";
};

function isBareImportSpecifier(
  importSpecifier: string,
): importSpecifier is BareImportSpecifier {
  if (
    importSpecifier.startsWith(".") ||
    importSpecifier.startsWith("/") ||
    importSpecifier.startsWith("file:")
  ) {
    return false;
  }
  return !isBuiltin(importSpecifier);
}

function packageNameFromSpecifier(bareSpecifier: BareImportSpecifier): string {
  if (bareSpecifier.startsWith("@")) {
    return bareSpecifier.split("/").slice(0, 2).join("/");
  }
  const slashIndex = bareSpecifier.indexOf("/");
  return slashIndex === -1 ? bareSpecifier : bareSpecifier.slice(0, slashIndex);
}

function getStaticString(value: unknown): string | undefined {
  if (!isSyntaxNode(value)) return undefined;
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type !== "TemplateLiteral") return undefined;
  const expressions = value.expressions;
  const quasis = value.quasis;
  if (
    !Array.isArray(expressions) ||
    expressions.length ||
    !Array.isArray(quasis)
  ) {
    return undefined;
  }
  const first: unknown = (quasis as unknown[])[0];
  if (!isSyntaxNode(first)) return undefined;
  const templateValue = first.value;
  if (typeof templateValue !== "object" || templateValue === null) {
    return undefined;
  }
  const cooked = "cooked" in templateValue ? templateValue.cooked : undefined;
  return typeof cooked === "string" ? cooked : undefined;
}

function isAstroLoggerImport(
  sourceNode: unknown,
  relativePath: string,
  ancestors: SyntaxNode[],
): boolean {
  if (
    relativePath !== "index.js" &&
    !/(^|[\\/])chunks[\\/]render-[^\\/]+\.js$/.test(relativePath)
  ) {
    return false;
  }
  if (
    !ancestors.some(
      (ancestor) =>
        ancestor.type === "FunctionDeclaration" &&
        isIdentifier(ancestor.id, "loadLoggerDestination"),
    )
  ) {
    return false;
  }
  if (isIdentifier(sourceNode, "entrypoint")) return true;
  if (!isSyntaxNode(sourceNode) || sourceNode.type !== "CallExpression")
    return false;
  if (!isIdentifier(sourceNode.callee, "normalizeEntrypoint")) return false;
  const arguments_ = sourceNode.arguments;
  const entrypointArgument: unknown = Array.isArray(arguments_)
    ? arguments_[0]
    : undefined;
  return (
    isSyntaxNode(entrypointArgument) &&
    entrypointArgument.type === "MemberExpression" &&
    isIdentifier(entrypointArgument.object, "loggerConfig") &&
    isIdentifier(entrypointArgument.property, "entrypoint")
  );
}

function isIdentifier(value: unknown, name: string): boolean {
  return isSyntaxNode(value) && value.type === "Identifier" && value.name === name;
}

interface SyntaxNode {
  type: string;
  [property: string]: unknown;
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function visitSyntax(
  node: SyntaxNode,
  visitor: (node: SyntaxNode, ancestors: SyntaxNode[]) => void,
  ancestors: SyntaxNode[] = [],
): void {
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const value of Object.values(node)) {
    if (isSyntaxNode(value)) visitSyntax(value, visitor, nextAncestors);
    else if (Array.isArray(value)) {
      for (const child of value) {
        if (isSyntaxNode(child)) visitSyntax(child, visitor, nextAncestors);
      }
    }
  }
}

async function resolvePinnedRuntimeDependencies(
  appRoot: URL,
  directDependencyNames: Set<string>,
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
      (await fetchRegistryMetadata(
        current.dependencyName,
        installedPackage.version,
      ));
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
    const manifest = await readJsonFile<{ version?: string }>(manifestPath);
    if (manifest?.version !== undefined)
      return { version: manifest.version, directory: dirname(manifestPath) };
  }
  const entryPoint = tryResolveModule(requireFunction, packageName);
  if (!entryPoint) return undefined;
  let current: string | undefined = dirname(entryPoint);
  while (current !== undefined) {
    const manifest = await readJsonFile<{ name?: string; version?: string }>(
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

async function installedVersion(root: URL, packageName: string): Promise<string> {
  const installedPackage = await findInstalledPackage(
    [new URL("package.json", root)],
    packageName,
  );
  if (installedPackage) return installedPackage.version;
  throw new Error(`Could not determine the installed ${packageName} version.`);
}

interface RegistryVersionMetadata {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  resolved?: string;
  integrity?: string;
  license?: string;
  engines?: Record<string, string>;
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

async function describeClientArtifact(
  clientDirectory: URL,
  base: string,
  prerendered: string[],
): Promise<{
  files: ClientArtifactFile[];
  routes: PrerenderedRouteRequirement[];
}> {
  const paths = await relativeFiles(
    asDirectoryPath(fileURLToPath(clientDirectory)),
  );
  const pathSet = new Set(paths);
  // Set order follows discovery; sort for deterministic output.
  const uniqueRoutes = Array.from(new Set(prerendered)).sort();
  const routeFileEntries = uniqueRoutes.map(
    (url) => [prerenderedFile(url, pathSet), withBase(base, url)] as const,
  );
  const routeUrlByFile = new Map(routeFileEntries);
  return {
    files: paths.map((clientRelativePath): ClientArtifactFile => ({
      path: clientRelativePath,
      url:
        routeUrlByFile.get(clientRelativePath) ??
        withBase(base, encodedPath(clientRelativePath)),
      objectKey: objectKey(base, clientRelativePath),
    })),
    routes: routeFileEntries.map(([clientRelativePath, url]) => ({
      url,
      objectKey: objectKey(base, clientRelativePath),
    })),
  };
}

async function relativeFiles(directoryPath: DirectoryPath): Promise<string[]> {
  // tinyglobby already yields forward-slash relative paths.
  return emittedRelativePaths(directoryPath);
}

function prerenderedFile(routeUrl: string, clientFiles: Set<string>): string {
  const pathname = routeUrl.replace(/^\/+|\/+$/g, "");
  const candidates =
    routeUrl === "/"
      ? ["index.html"]
      : routeUrl.endsWith("/")
        ? [`${pathname}/index.html`, `${pathname}.html`]
        : [`${pathname}.html`, `${pathname}/index.html`];
  const file = candidates.find((candidate) => clientFiles.has(candidate));
  if (file) return file;
  throw new Error(
    `Could not match the Prerendered Route ${routeUrl} to a Client Artifact file.`,
  );
}

function normalizedBase(base: string): string {
  const path = `/${base.replace(/^\/+|\/+$/g, "")}`;
  return path === "/" ? path : path.replace(/\/+$/, "");
}

function withBase(base: string, urlPath: string): string {
  const suffix = `/${urlPath.replace(/^\/+/, "")}`;
  if (base === "/") return suffix;
  return suffix === "/" ? `${base}/` : `${base}${suffix}`;
}

function objectKey(base: string, clientRelativePath: string): string {
  const prefix = base === "/" ? "" : base.slice(1);
  return [prefix, clientRelativePath].filter(Boolean).join("/");
}

function encodedPath(clientRelativePath: string): string {
  return clientRelativePath.split("/").map(encodeURIComponent).join("/");
}
