import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import type { AstroConfig } from "astro";
import { init, parse } from "es-module-lexer";

import { ADAPTER_NAME, ADAPTER_VERSION } from "./constants.js";
import { parseDeploymentManifest } from "./deployment-manifest.js";
import type {
  ClientArtifactFile,
  PrerenderedRouteRequirement,
  Target,
  YandexCloudManifestV1,
} from "./types.js";

const allowedBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

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
      `The Function Artifact contains the native runtime module ${nativeModule.name}, which cannot use the "bundle" dependency strategy. Use dependencyStrategy: "install".`,
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
  if (allowedBuiltins.has(specifier)) return undefined;
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

async function unresolvedPackages(directory: string): Promise<Set<string>> {
  const packages = new Set<string>();
  await init;
  for (const file of await javascriptFiles(directory)) {
    const source = await readFile(file, "utf8");
    if (/\.node(?:["'`]|\\)/.test(source)) {
      throw new Error(
        `The Function Artifact contains native runtime dependency code in ${relative(directory, file)}, which cannot use the "bundle" dependency strategy. Use dependencyStrategy: "install".`,
      );
    }
    const [imports] = parse(source, file);
    for (const specifier of imports) {
      const dependency = specifier.n && barePackage(specifier.n);
      if (dependency) packages.add(dependency);
    }
    for (const match of source.matchAll(
      /\b(?:require|__require)\(\s*["']([^"']+)["']\s*\)/g,
    )) {
      const dependency = barePackage(match[1]);
      if (dependency) packages.add(dependency);
    }
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
      'The Function Artifact contains the native runtime dependency sharp, which cannot use the "bundle" dependency strategy. Use dependencyStrategy: "install".',
    );
  }
  if (packages.size) {
    throw new Error(
      `The "bundle" dependency strategy left unresolved runtime package imports in the Function Artifact: ${[...packages].sort().join(", ")}. ` +
        'Bundle these packages with Astro/Vite or use dependencyStrategy: "install".',
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
