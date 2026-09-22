import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { parse } from "acorn";
import type { AstroConfig } from "astro";

import { ADAPTER_NAME, ADAPTER_VERSION } from "./constants.js";
import { parseDeploymentManifest } from "./deployment-manifest.js";
import {
  compareNames,
  formatFunctionPackageJson,
  formatNpmLockfile,
  type ResolvedRuntimePackage,
} from "./install-lockfile.js";
import type {
  ClientArtifactFile,
  DependencyStrategy,
  PrerenderedRouteRequirement,
  Target,
  YandexCloudManifestV1,
} from "./types.js";

interface DiscoveredFile {
  name: string;
  absolutePath: string;
}

async function filesUnder(directory: string): Promise<DiscoveredFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = resolve(directory, entry.name);
      return entry.isDirectory()
        ? filesUnder(absolutePath)
        : [{ name: entry.name, absolutePath }];
    }),
  );
  return files.flat();
}

async function javascriptFiles(
  directory: string,
  strategy: DependencyStrategy = "bundle",
): Promise<string[]> {
  const files = await filesUnder(directory);
  const nativeModule = files.find((file) => file.name.endsWith(".node"));
  if (nativeModule && strategy === "bundle") {
    throw new Error(
      `The Function Artifact contains the native runtime module ${nativeModule.name}, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.`,
    );
  }
  const commonJs = files.find((file) => file.name.endsWith(".cjs"));
  if (commonJs) {
    throw new Error(
      `The function artifact contains the unsupported CommonJS module ${commonJs.name}. V1 function artifacts must use ESM.`,
    );
  }
  return files
    .filter((file) => /\.m?js$/.test(file.name))
    .map((file) => file.absolutePath);
}

function barePackage(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  ) {
    return undefined;
  }
  if (isBuiltin(specifier)) return undefined;
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
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

function isIdentifier(value: unknown, name: string): boolean {
  return isSyntaxNode(value) && value.type === "Identifier" && value.name === name;
}

function isAstroLoggerImport(
  source: unknown,
  file: string,
  ancestors: SyntaxNode[],
): boolean {
  if (
    file !== "index.js" &&
    !/(^|[\\/])chunks[\\/]render-[^\\/]+\.js$/.test(file)
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
  if (isIdentifier(source, "entrypoint")) return true;
  if (!isSyntaxNode(source) || source.type !== "CallExpression") return false;
  if (!isIdentifier(source.callee, "normalizeEntrypoint")) return false;
  const arguments_ = source.arguments;
  const entrypoint: unknown = Array.isArray(arguments_)
    ? arguments_[0]
    : undefined;
  return (
    isSyntaxNode(entrypoint) &&
    entrypoint.type === "MemberExpression" &&
    isIdentifier(entrypoint.object, "loggerConfig") &&
    isIdentifier(entrypoint.property, "entrypoint")
  );
}

function staticSpecifier(value: unknown): string | undefined {
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

function dependencySpecifier(
  specifier: string,
  file: string,
  strategy: DependencyStrategy = "bundle",
): string | undefined {
  if (specifier.endsWith(".node")) {
    // Native file imports stay inside the owning package for install builds,
    // so the package itself is pinned; bundle builds cannot carry native code.
    if (strategy === "install") return barePackage(specifier);
    throw new Error(
      `The Function Artifact contains the native runtime module ${specifier} referenced by ${file}, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.`,
    );
  }
  return barePackage(specifier);
}

function runtimeSpecifiers(
  source: string,
  file: string,
  strategy: DependencyStrategy = "bundle",
): Set<string> {
  const packages = new Set<string>();
  const program = parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as SyntaxNode;

  const add = (specifier: string): void => {
    const dependency = dependencySpecifier(specifier, file, strategy);
    if (dependency) packages.add(dependency);
  };
  const rejectDynamic = (): never => {
    if (strategy === "install") {
      throw new Error(
        `The Function Artifact contains unresolved dynamic runtime dependency resolution in ${file}, which cannot use the "install" dependency strategy. Replace it with a fixed package import so its exact version can be written to the Function Artifact.`,
      );
    }
    throw new Error(
      `The Function Artifact contains unresolved dynamic or native runtime dependency resolution in ${file}, which cannot use the "bundle" dependency strategy. Bundle a fixed package import or select dependencyStrategy: "install" to keep runtime package imports.`,
    );
  };
  const requiredSpecifier = (value: unknown): string =>
    staticSpecifier(value) ?? rejectDynamic();

  visitSyntax(program, (node, ancestors) => {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      const specifier = staticSpecifier(node.source);
      if (specifier) add(specifier);
      return;
    }
    if (node.type === "ImportExpression") {
      const specifier = staticSpecifier(node.source);
      if (specifier) {
        add(specifier);
      } else if (!isAstroLoggerImport(node.source, file, ancestors)) {
        rejectDynamic();
      }
      return;
    }
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (
      !isSyntaxNode(callee) ||
      callee.type !== "Identifier" ||
      (callee.name !== "require" && callee.name !== "__require")
    ) {
      return;
    }
    const arguments_ = node.arguments;
    add(requiredSpecifier(Array.isArray(arguments_) ? arguments_[0] : undefined));
  });
  return packages;
}

async function unresolvedPackages(
  directory: string,
  strategy: DependencyStrategy = "bundle",
): Promise<Set<string>> {
  const packages = new Set<string>();
  for (const file of await javascriptFiles(directory, strategy)) {
    const source = await readFile(file, "utf8");
    const relativePath = relative(directory, file);
    for (const dependency of runtimeSpecifiers(source, relativePath, strategy))
      packages.add(dependency);
  }
  return packages;
}

async function installedVersion(root: URL, packageName: string): Promise<string> {
  const located = await locateInstalledPackage(
    [new URL("package.json", root)],
    packageName,
  );
  if (located) return located.version;
  throw new Error(`Could not determine the installed ${packageName} version.`);
}

async function locateInstalledPackage(
  bases: Array<URL | string>,
  packageName: string,
): Promise<{ version: string; directory: string } | undefined> {
  for (const base of bases) {
    const require = createRequire(base);
    try {
      const packagePath = require.resolve(`${packageName}/package.json`);
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
        version?: string;
      };
      if (packageJson.version)
        return { version: packageJson.version, directory: dirname(packagePath) };
    } catch {
      // Fall through to the directory walk below.
    }
    try {
      let directory = dirname(require.resolve(packageName));
      for (;;) {
        try {
          const packageJson = JSON.parse(
            await readFile(join(directory, "package.json"), "utf8"),
          ) as {
            name?: string;
            version?: string;
          };
          if (packageJson.name === packageName && packageJson.version)
            return { version: packageJson.version, directory };
        } catch {
          // Keep walking until the package root is found.
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    } catch {
      // Try the next resolution base.
    }
  }
  return undefined;
}

interface RegistryVersionMetadata {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  resolved?: string;
  integrity?: string;
  license?: string;
  engines?: Record<string, string>;
}

function normalizeLicense(license: unknown): string | undefined {
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

async function nearestPackageLock(
  fromDirectory: string,
): Promise<string | undefined> {
  let directory = resolve(fromDirectory);
  for (;;) {
    const candidate = join(directory, "package-lock.json");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function localLockMetadata(
  fromDirectory: string,
  packageName: string,
  version: string,
): Promise<RegistryVersionMetadata | undefined> {
  const lockfilePath = await nearestPackageLock(fromDirectory);
  if (!lockfilePath) return undefined;
  try {
    const lockfile = JSON.parse(await readFile(lockfilePath, "utf8")) as {
      packages?: Record<
        string,
        {
          version?: string;
          resolved?: string;
          integrity?: string;
          license?: string;
          engines?: Record<string, string>;
          dependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
        }
      >;
      dependencies?: Record<
        string,
        {
          version?: string;
          resolved?: string;
          integrity?: string;
          license?: string;
          engines?: Record<string, string>;
        }
      >;
    };
    const entry =
      lockfile.packages?.[`node_modules/${packageName}`] ??
      lockfile.dependencies?.[packageName];
    if (!entry || entry.version !== version) return undefined;
    return {
      resolved: entry.resolved,
      integrity: entry.integrity,
      license: entry.license,
      engines: entry.engines,
      // The packages section pins exact transitive versions; the legacy
      // section only carries ranges, so transitive discovery uses packages.
      dependencies:
        lockfile.packages?.[`node_modules/${packageName}`]?.dependencies,
      optionalDependencies:
        lockfile.packages?.[`node_modules/${packageName}`]?.optionalDependencies,
    };
  } catch {
    return undefined;
  }
}

async function fetchRegistryMetadata(
  packageName: string,
  version: string,
): Promise<RegistryVersionMetadata> {
  const encodedName = packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `https://registry.npmjs.org/${encodedName}/${encodeURIComponent(version)}`;
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
    license: normalizeLicense(metadata.license),
    engines: metadata.engines,
  };
}

async function resolveInstallPackages(
  appRoot: URL,
  direct: Set<string>,
): Promise<ResolvedRuntimePackage[]> {
  const appDirectory = fileURLToPath(appRoot);
  const resolved = new Map<string, ResolvedRuntimePackage>();
  const seen = new Set<string>();
  const queue: Array<{ name: string; bases: Array<URL | string> }> = [
    ...[...direct].sort(),
  ].map((name) => ({ name, bases: [new URL("package.json", appRoot)] }));
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current.name)) continue;
    seen.add(current.name);
    const located = await locateInstalledPackage(current.bases, current.name);
    if (!located) {
      throw new Error(
        `The "install" dependency strategy cannot resolve the runtime package "${current.name}" imported by the Function Artifact. Install it as an application dependency so its exact version can be written to the Function Artifact.`,
      );
    }
    const local = await localLockMetadata(
      appDirectory,
      current.name,
      located.version,
    );
    const metadata =
      local || (await fetchRegistryMetadata(current.name, located.version));
    const dependencies: Record<string, string> = {};
    const optionalDependencies: Record<string, string> = {};
    const dependentBase = join(located.directory, "package.json");
    for (const [dependency, range] of Object.entries(
      metadata.dependencies ?? {},
    ).sort(([a], [b]) => compareNames(a, b))) {
      const transitive = await locateInstalledPackage(
        [dependentBase, new URL("package.json", appRoot)],
        dependency,
      );
      if (!transitive) {
        throw new Error(
          `The "install" dependency strategy cannot resolve the runtime package "${dependency}" (required by "${current.name}" as "${range}"). Install it as an application dependency so its exact version can be written to the Function Artifact.`,
        );
      }
      dependencies[dependency] = transitive.version;
      if (!seen.has(dependency))
        queue.push({
          name: dependency,
          bases: [
            join(transitive.directory, "package.json"),
            new URL("package.json", appRoot),
          ],
        });
    }
    for (const [dependency] of Object.keys(metadata.optionalDependencies ?? {})
      .sort()
      .map((name) => [name] as const)) {
      const transitive = await locateInstalledPackage(
        [dependentBase, new URL("package.json", appRoot)],
        dependency,
      );
      if (!transitive) continue;
      optionalDependencies[dependency] = transitive.version;
      if (!seen.has(dependency))
        queue.push({
          name: dependency,
          bases: [
            join(transitive.directory, "package.json"),
            new URL("package.json", appRoot),
          ],
        });
    }
    resolved.set(current.name, {
      name: current.name,
      version: located.version,
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
  return [...resolved.values()];
}

async function writeInstallFunctionPackage(
  functionDirectory: URL,
  appRoot: URL,
): Promise<void> {
  const path = fileURLToPath(functionDirectory);
  const direct = await unresolvedPackages(path, "install");
  const resolved = await resolveInstallPackages(appRoot, direct);
  await writeFile(
    new URL("package.json", functionDirectory),
    formatFunctionPackageJson(resolved),
  );
  await writeFile(
    new URL("package-lock.json", functionDirectory),
    formatNpmLockfile(resolved),
  );
}

async function writeFunctionPackage(functionDirectory: URL): Promise<void> {
  const path = fileURLToPath(functionDirectory);
  const packages = await unresolvedPackages(path);
  if (packages.has("sharp")) {
    throw new Error(
      'The Function Artifact contains the native runtime dependency sharp, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.',
    );
  }
  if (packages.size) {
    throw new Error(
      `The "bundle" dependency strategy left unresolved runtime package imports in the Function Artifact: ${[...packages].sort().join(", ")}. ` +
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

async function validateFunctionArtifact(functionDirectory: URL): Promise<void> {
  const entrypoint = new URL("index.js", functionDirectory);
  try {
    await readFile(entrypoint);
  } catch (error) {
    throw new Error(
      `Astro did not emit the expected function entrypoint at ${entrypoint.pathname}.`,
      {
        cause: error,
      },
    );
  }
}

export async function prepareFunctionArtifact(
  functionDirectory: URL,
): Promise<void> {
  await validateFunctionArtifact(functionDirectory);
  await writeFunctionPackage(functionDirectory);
}

export async function prepareInstallFunctionArtifact(
  functionDirectory: URL,
  appRoot: URL,
): Promise<void> {
  await validateFunctionArtifact(functionDirectory);
  await writeInstallFunctionPackage(functionDirectory, appRoot);
}

export async function hasFunctionArtifact(
  functionDirectory: URL,
): Promise<boolean> {
  try {
    await access(new URL("index.js", functionDirectory));
    return true;
  } catch {
    return false;
  }
}

export async function readAstroVersion(root: URL): Promise<string> {
  return installedVersion(root, "astro");
}

export function artifactPath(outDir: URL, artifact: URL): string {
  return relative(fileURLToPath(outDir), fileURLToPath(artifact))
    .split(sep)
    .join("/");
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

async function relativeFiles(directory: string): Promise<string[]> {
  return (await filesUnder(directory))
    .map((file) => relative(directory, file.absolutePath).split(sep).join("/"))
    .sort();
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

async function describeClientArtifact(
  clientDirectory: URL,
  base: string,
  prerendered: string[],
): Promise<{
  files: ClientArtifactFile[];
  routes: PrerenderedRouteRequirement[];
}> {
  const paths = await relativeFiles(fileURLToPath(clientDirectory));
  const pathSet = new Set(paths);
  const uniqueRoutes = [...new Set(prerendered)].sort();
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

export async function writeDeploymentManifest(
  outDir: URL,
  config: AstroConfig,
  input: {
    target: Target;
    prerendered: string[];
    onDemand: string[];
    hasFunction: boolean;
    sharpSupport?: "unsupported" | "limited";
  },
): Promise<YandexCloudManifestV1> {
  const client = new URL("client/", outDir);
  const functionDirectory = new URL("function/", outDir);
  const base = normalizedBase(config.base);
  const clientArtifact = await describeClientArtifact(
    client,
    base,
    input.prerendered,
  );
  const manifest: YandexCloudManifestV1 = {
    schemaVersion: 1,
    adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
    astro: { version: await readAstroVersion(config.root) },
    target: input.target,
    buildOutput: input.hasFunction ? "server" : "static",
    base,
    artifacts: {
      client: {
        path: artifactPath(outDir, client),
        files: clientArtifact.files,
      },
      ...(input.hasFunction
        ? {
            function: {
              path: artifactPath(outDir, functionDirectory),
              runtime: "nodejs22" as const,
              format: "esm" as const,
              entrypoint: "index.handler" as const,
              support: { sharp: input.sharpSupport ?? ("unsupported" as const) },
            },
          }
        : {}),
    },
    routes: {
      prerendered: clientArtifact.routes,
      onDemand: [...new Set(input.onDemand)]
        .sort()
        .map((pattern) => ({ pattern: withBase(base, pattern) })),
    },
  };
  parseDeploymentManifest(manifest);
  await mkdir(fileURLToPath(outDir), { recursive: true });
  await writeFile(
    new URL("yandex-cloud.json", outDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
