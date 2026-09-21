import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { parse } from "acorn";
import type { AstroConfig } from "astro";

import { ADAPTER_NAME, ADAPTER_VERSION } from "./constants.js";
import { parseDeploymentManifest } from "./deployment-manifest.js";
import type {
  ClientArtifactFile,
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

async function javascriptFiles(directory: string): Promise<string[]> {
  const files = await filesUnder(directory);
  const nativeModule = files.find((file) => file.name.endsWith(".node"));
  if (nativeModule) {
    throw new Error(
      `The Function Artifact contains the native runtime module ${nativeModule.name}, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", whose packaging is not available yet.`,
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
  if (!/(^|[\\/])chunks[\\/]render-[^\\/]+\.js$/.test(file)) return false;
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

function dependencySpecifier(specifier: string, file: string): string | undefined {
  if (specifier.endsWith(".node")) {
    throw new Error(
      `The Function Artifact contains the native runtime module ${specifier} referenced by ${file}, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", whose packaging is not available yet.`,
    );
  }
  return barePackage(specifier);
}

function runtimeSpecifiers(source: string, file: string): Set<string> {
  const packages = new Set<string>();
  const program = parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as SyntaxNode;

  const add = (specifier: string): void => {
    const dependency = dependencySpecifier(specifier, file);
    if (dependency) packages.add(dependency);
  };
  const rejectDynamic = (): never => {
    throw new Error(
      `The Function Artifact contains unresolved dynamic or native runtime dependency resolution in ${file}, which cannot use the "bundle" dependency strategy. Bundle a fixed package import; dependencyStrategy: "install" packaging is not available yet.`,
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

async function unresolvedPackages(directory: string): Promise<Set<string>> {
  const packages = new Set<string>();
  for (const file of await javascriptFiles(directory)) {
    const source = await readFile(file, "utf8");
    const relativePath = relative(directory, file);
    for (const dependency of runtimeSpecifiers(source, relativePath))
      packages.add(dependency);
  }
  return packages;
}

async function installedVersion(root: URL, packageName: string): Promise<string> {
  const require = createRequire(new URL("package.json", root));
  try {
    const packagePath = require.resolve(`${packageName}/package.json`);
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      version?: string;
    };
    if (packageJson.version) return packageJson.version;
  } catch {
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
          return packageJson.version;
      } catch {
        // Keep walking until the package root is found.
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error(`Could not determine the installed ${packageName} version.`);
}

async function writeFunctionPackage(functionDirectory: URL): Promise<void> {
  const path = fileURLToPath(functionDirectory);
  const packages = await unresolvedPackages(path);
  if (packages.has("sharp")) {
    throw new Error(
      'The Function Artifact contains the native runtime dependency sharp, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", whose packaging is not available yet.',
    );
  }
  if (packages.size) {
    throw new Error(
      `The "bundle" dependency strategy left unresolved runtime package imports in the Function Artifact: ${[...packages].sort().join(", ")}. ` +
        'Bundle these packages with Astro/Vite; dependencyStrategy: "install" packaging is not available yet.',
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
              support: { sharp: "unsupported" as const },
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
