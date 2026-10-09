import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";

import type { PlannedRoute, RoutePlan } from "../build/routes.js";
import type { CompletedBuild } from "../integration/session.js";
import type { FunctionArtifactPolicy } from "../runtime/types.js";
import type { BuildError } from "../target/module.js";
import type { DependencyStrategy } from "../types.js";
import {
  isSyntaxNode,
  localModuleReferences,
  parseModule,
  type SyntaxNode,
  visitSyntax,
} from "./emitted-modules.js";
import { prepareFunctionArtifact } from "./package.js";

export interface PreparedFunctionArtifact {
  id: string;
  path: string;
  directory: URL;
  runtime: "nodejs22";
  entrypoint: "index.handler";
  allowedRoutes?: string[];
}

export interface PartitionedFunctions {
  routePlan: RoutePlan;
  functions: PreparedFunctionArtifact[];
}

interface PartitionOptions {
  functions: "shared" | "separate";
  dependencyStrategy: DependencyStrategy;
}

/** Packages Astro's emitted graph per on-demand route without rebundling the app. */
export function partitionFunctions(
  build: CompletedBuild,
  routePlan: RoutePlan,
  options: PartitionOptions,
): Effect.Effect<PartitionedFunctions, BuildError> {
  return Effect.gen(function* () {
    const routes = routePlan.routes.filter(
      (route): route is Extract<PlannedRoute, { kind: "on-demand" }> =>
        route.kind === "on-demand",
    );
    if (!routes.length) return { routePlan, functions: [] };
    const { config } = build;
    const appRoot =
      options.dependencyStrategy === "install" ? config.root : undefined;
    const prepare = (directory: URL) =>
      prepareFunctionArtifact(directory, appRoot).pipe(
        Effect.mapError((cause) => ({
          _tag: "UnresolvedDependency" as const,
          message: cause.message,
          cause,
        })),
      );
    if (options.functions === "shared") {
      yield* prepare(config.build.server);
      return {
        routePlan,
        functions: [
          artifact(config.outDir, config.build.server, "function:shared"),
        ],
      };
    }
    const functions: PreparedFunctionArtifact[] = [];
    const assignments = new Map<string, string>();
    const index = yield* Effect.tryPromise({
      try: () => readFile(new URL("index.js", config.build.server), "utf8"),
      catch: invalidArtifact,
    });
    for (const route of routes) {
      const identity = `${route.routeKind}:${route.pattern}`;
      const suffix = createHash("sha256")
        .update(identity)
        .digest("hex")
        .slice(0, 16);
      const id = `function:${suffix}`;
      const directory = new URL(`functions/${suffix}/`, config.outDir);
      const originalPattern = withoutBase(route.pattern, config.base);
      const resolved = build.resolvedRoutes.find(
        (candidate) => candidate.pattern === originalPattern,
      );
      if (!resolved) {
        return yield* Effect.fail({
          _tag: "InvalidArtifact" as const,
          message: `Cannot identify Astro's emitted entrypoint for ${route.pattern}.`,
        });
      }
      yield* Effect.tryPromise({
        try: async () => {
          await rm(directory, { recursive: true, force: true });
          await mkdir(directory, { recursive: true });
          const keepServerIslands =
            originalPattern.startsWith("/_server-islands/");
          const selected = prunePageModules(index, new Set([resolved.entrypoint]));
          const source = keepServerIslands
            ? selected
            : pruneServerIslandLoaders(selected);
          await writeFile(new URL("index.js", directory), source);
          await copyEmittedGraph(
            config.build.server,
            directory,
            source,
            keepServerIslands,
          );
        },
        catch: invalidArtifact,
      });
      yield* prepare(directory);
      assignments.set(identity, id);
      functions.push({
        ...artifact(config.outDir, directory, id),
        allowedRoutes: [originalPattern],
      });
    }
    yield* Effect.tryPromise({
      try: () => rm(config.build.server, { recursive: true, force: true }),
      catch: invalidArtifact,
    });
    return {
      functions,
      routePlan: {
        ...routePlan,
        routes: routePlan.routes.map((route) =>
          route.kind === "on-demand"
            ? {
                ...route,
                artifactId: assignments.get(
                  `${route.routeKind}:${route.pattern}`,
                )! as typeof route.artifactId,
              }
            : route,
        ),
      },
    };
  });
}

/** Wraps the exported handler once, retaining Astro's original entrypoint layout. */
export async function applyFunctionPolicy(
  directory: URL,
  policy: Omit<FunctionArtifactPolicy, "artifactDirectory">,
): Promise<void> {
  const entrypoint = new URL("index.js", directory);
  const source = await readFile(entrypoint, "utf8");
  let handlerName: string | undefined;
  const edits: Array<{ start: number; end: number; value: string }> = [];
  visitSyntax(parseModule(source), (node) => {
    if (node.type !== "ExportNamedDeclaration" || !Array.isArray(node.specifiers))
      return;
    for (const specifier of node.specifiers as unknown[]) {
      if (
        isSyntaxNode(specifier) &&
        isSyntaxNode(specifier.exported) &&
        specifier.exported.name === "handler" &&
        isSyntaxNode(specifier.local) &&
        typeof specifier.local.name === "string"
      ) {
        handlerName = specifier.local.name;
        edits.push({
          start: specifier.start,
          end: specifier.end,
          value: "__yandexArtifactHandler as handler",
        });
      }
    }
  });
  if (!handlerName || handlerName === "__yandexArtifactHandler")
    throw new Error("The emitted handler export is missing or already wrapped.");
  const serialized = JSON.stringify(policy);
  const wrapper =
    `\nconst __yandexArtifactHandler = (event, context, previewUrl) => ` +
    `${handlerName}(event, context, previewUrl, {...${serialized}, artifactDirectory: new URL('.', import.meta.url)});\n`;
  await writeFile(entrypoint, applyEdits(source, edits) + wrapper);
}

/** Keeps Astro preview's single entrypoint while deploying only listed Functions. */
export async function writePreviewDispatcher(
  build: CompletedBuild,
  routePlan: RoutePlan,
  functions: readonly PreparedFunctionArtifact[],
): Promise<void> {
  if (!functions.length) return;
  const directory = build.config.build.server;
  const base = `/${build.config.base.replace(/^\/+|\/+$/g, "")}`;
  const routes = routePlan.routes
    .filter((route) => route.kind === "on-demand")
    .sort((a, b) => a.priority - b.priority)
    .map((route) => ({
      pattern: route.patternRegex,
      artifact: functions.findIndex(
        (artifact) => artifact.id === route.artifactId,
      ),
    }));
  const fallback = routePlan.routes.find(
    (route) => route.kind === "on-demand" && route.routeKind === "page",
  );
  const fallbackIndex =
    fallback && fallback.kind === "on-demand"
      ? functions.findIndex((artifact) => artifact.id === fallback.artifactId)
      : 0;
  const handlers = functions.map((artifact) => {
    const path = relative(
      fileURLToPath(directory),
      fileURLToPath(new URL("index.js", artifact.directory)),
    )
      .split(sep)
      .join("/");
    return `() => import(${JSON.stringify(path.startsWith(".") ? path : `./${path}`)})`;
  });
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL("package.json", directory),
    '{"private":true,"type":"module"}\n',
  );
  await writeFile(
    new URL("index.js", directory),
    `// Local Astro preview dispatcher; deploy only Functions listed in yandex-cloud.json.\n` +
      `const handlers = [${handlers.join(",")}];\n` +
      `const routes = ${JSON.stringify(routes)}.map(route => ({...route, pattern: new RegExp(route.pattern)}));\n` +
      `const base = ${JSON.stringify(base)};\n` +
      `export async function handler(event, context, previewUrl) {\n` +
      `  let pathname = (previewUrl ?? new URL(event.url ?? event.rawPath ?? event.path ?? '/', 'https://preview.invalid')).pathname;\n` +
      `  if (base !== '/' && (pathname === base || pathname.startsWith(base + '/'))) pathname = pathname.slice(base.length) || '/';\n` +
      `  try { pathname = decodeURI(pathname); } catch {}\n` +
      `  const matched = routes.find(route => route.pattern.test(pathname));\n` +
      `  const module = await handlers[matched?.artifact ?? ${fallbackIndex}]();\n` +
      `  return module.handler(event, context, previewUrl);\n` +
      `}\n`,
  );
}

/** Gives a Deployment Product both portable metadata and the local preparation URL. */
function artifact(
  outDir: URL,
  directory: URL,
  id: string,
): PreparedFunctionArtifact {
  return {
    id,
    path: relative(fileURLToPath(outDir), fileURLToPath(directory))
      .split(sep)
      .join("/"),
    directory,
    runtime: "nodejs22",
    entrypoint: "index.handler",
  };
}

/** Restores the route identity used by Astro's app.match result. */
function withoutBase(pattern: string, base: string): string {
  const normalized = `/${base.replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? pattern : pattern.slice(normalized.length) || "/";
}

/** Removes other page loaders while retaining all route metadata for precedence. */
function prunePageModules(source: string, components: Set<string>): string {
  const declarations = new Map<string, SyntaxNode>();
  const edits: Array<{ start: number; end: number; value: string }> = [];
  visitSyntax(parseModule(source), (node) => {
    if (
      node.type === "VariableDeclarator" &&
      isSyntaxNode(node.id) &&
      typeof node.id.name === "string"
    ) {
      declarations.set(node.id.name, node);
    }
  });
  const pageMap = [...declarations.entries()].find(([name]) =>
    /^pageMap(?:\$\d+)?$/.test(name),
  )?.[1];
  const init = pageMap?.init;
  if (!isSyntaxNode(init) || !Array.isArray(init.arguments))
    throw new Error(
      "Astro did not emit the expected route module map for separate Functions.",
    );
  const entries = (init.arguments as unknown[])[0];
  if (!isSyntaxNode(entries) || !Array.isArray(entries.elements))
    throw new Error("Astro's emitted route module map has an unsupported shape.");
  const retained: string[] = [];
  for (const entry of entries.elements as unknown[]) {
    if (!isSyntaxNode(entry) || !Array.isArray(entry.elements))
      throw new Error(
        "Astro's emitted route module map contains an invalid entry.",
      );
    const [component, loader] = entry.elements as unknown[];
    if (!isSyntaxNode(component) || typeof component.value !== "string")
      throw new Error("Astro's emitted route component is not a fixed module ID.");
    if (components.has(component.value)) {
      retained.push(source.slice(entry.start, entry.end));
      continue;
    }
    if (!isSyntaxNode(loader) || typeof loader.name !== "string")
      throw new Error("Astro's emitted page loader has an unsupported shape.");
    const declaration = declarations.get(loader.name);
    if (!declaration || !isSyntaxNode(declaration.init))
      throw new Error("Astro's emitted page loader declaration is missing.");
    edits.push({
      start: declaration.init.start,
      end: declaration.init.end,
      value: "undefined",
    });
  }
  edits.push({
    start: entries.start,
    end: entries.end,
    value: `[${retained.join(",")}]`,
  });
  return applyEdits(source, edits);
}

/** Keeps deferred component names but removes loaders outside the island Function. */
function pruneServerIslandLoaders(source: string): string {
  const edits: Array<{ start: number; end: number; value: string }> = [];
  visitSyntax(parseModule(source), (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      !isSyntaxNode(node.id) ||
      typeof node.id.name !== "string" ||
      !/^serverIslandMap(?:\$\d+)?$/.test(node.id.name) ||
      !isSyntaxNode(node.init) ||
      node.init.type !== "NewExpression" ||
      !Array.isArray(node.init.arguments)
    )
      return;
    const entries = (node.init.arguments as unknown[])[0];
    if (isSyntaxNode(entries) && entries.type === "ArrayExpression")
      edits.push({ start: entries.start, end: entries.end, value: "[]" });
  });
  return applyEdits(source, edits);
}

/** Applies non-overlapping AST edits from the end to preserve original offsets. */
function applyEdits(
  source: string,
  edits: Array<{ start: number; end: number; value: string }>,
): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  }
  return source;
}

/** Copies only the fixed import graph reachable after route loader selection. */
async function copyEmittedGraph(
  source: URL,
  target: URL,
  index: string,
  keepServerIslands: boolean,
): Promise<void> {
  const pending = localModuleReferences(index);
  const copied = new Set<string>(["index.js"]);
  while (pending.length) {
    const path = pending.pop()!;
    const original = new URL(path, source);
    const local = relative(fileURLToPath(source), fileURLToPath(original))
      .split(sep)
      .join("/");
    if (local.startsWith("../") || local === "..")
      throw new Error(
        `Astro's emitted module ${path} escapes its Function Artifact.`,
      );
    if (copied.has(local)) continue;
    copied.add(local);
    const destination = new URL(local, target);
    await mkdir(dirname(fileURLToPath(destination)), { recursive: true });
    if (/\.m?js$/.test(local)) {
      const originalSource = await readFile(original, "utf8");
      const moduleSource = keepServerIslands
        ? originalSource
        : pruneServerIslandLoaders(originalSource);
      await writeFile(destination, moduleSource);
      for (const reference of localModuleReferences(moduleSource)) {
        pending.push(
          relative(
            fileURLToPath(source),
            fileURLToPath(new URL(reference, original)),
          )
            .split(sep)
            .join("/"),
        );
      }
    } else {
      await copyFile(original, destination);
    }
  }
}

/** Keeps artifact failures distinct from runtime dependency resolution failures. */
function invalidArtifact(cause: unknown): BuildError {
  return {
    _tag: "InvalidArtifact",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  };
}
