import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { AstroConfig } from "astro";
import * as Effect from "effect/Effect";
import { glob } from "tinyglobby";

import { ADAPTER_VERSION, DIRECT_REQUEST_TARGET_PARAMETER } from "../constants.js";
import {
  defineDeploymentManifest,
  parseDeploymentManifest,
} from "../deployment-manifest.js";
import type { Target, YandexCloudManifestV1 } from "../types.js";
import { validateFunctionEntrypoint } from "../function/package.js";
import {
  isSyntaxNode,
  parseModule,
  visitSyntax,
} from "../function/emitted-modules.js";
import type { CompletedBuild } from "../integration/session.js";
import type { BuildError } from "../target/module.js";
import type { PartitionedFunctions } from "../function/partition.js";
import { generateGatewayTemplate } from "./gateway.js";
import { manifestRoutes, reconcileRoutes, type RoutePlan } from "./routes.js";
import { hasRuntimeImageCalls } from "./runtime-image.js";

function failure(_tag: BuildError["_tag"], error: unknown): BuildError {
  return {
    _tag,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  };
}

/** Completes the selected Target from emitted Astro output. */
export interface BuildCompletionPolicy {
  target: Target;
  dependencyStrategy?: "bundle" | "install";
  apiGateway: boolean;
  recursive404: boolean;
  functionPartition?: "shared" | "separate";
  prepareArtifacts(
    build: CompletedBuild,
    routePlan: RoutePlan,
    hasFunction: boolean,
  ): Effect.Effect<PartitionedFunctions, BuildError>;
}

export function completeBuild(
  build: CompletedBuild,
  policy: BuildCompletionPolicy,
): Effect.Effect<YandexCloudManifestV1, BuildError> {
  return Effect.gen(function* () {
    const { config } = build;
    const entrypoint = yield* Effect.tryPromise({
      try: () => validateFunctionEntrypoint(config.build.server),
      catch: (error) => failure("InvalidArtifact", error),
    });
    const hasFunction = entrypoint.ok;
    const routePlan = yield* Effect.tryPromise({
      try: () => inspectRoutes(build, hasFunction),
      catch: (error) => failure("InvalidArtifact", error),
    });
    const prepared = yield* policy.prepareArtifacts(build, routePlan, hasFunction);
    return yield* Effect.tryPromise({
      try: () =>
        writeDeploymentManifest(config.outDir, config, {
          deploymentTarget: policy.target,
          ...(policy.dependencyStrategy
            ? { dependencyStrategy: policy.dependencyStrategy }
            : {}),
          routePlan: prepared.routePlan,
          functions: prepared.functions,
          apiGateway: policy.apiGateway,
          recursive404: policy.recursive404,
          ...(policy.functionPartition
            ? { functionPartition: policy.functionPartition }
            : {}),
        }),
      catch: (error) => failure("InvalidManifest", error),
    });
  });
}

export function relativeArtifactPath(outDir: URL, artifact: URL): string {
  return relative(fileURLToPath(outDir), fileURLToPath(artifact))
    .split(sep)
    .join("/");
}

interface WriteDeploymentManifestInput {
  deploymentTarget: Target;
  dependencyStrategy?: "bundle" | "install";
  routePlan: RoutePlan;
  functions: PartitionedFunctions["functions"];
  apiGateway: boolean;
  recursive404: boolean;
  functionPartition?: "shared" | "separate";
}

async function inspectRoutes(
  build: CompletedBuild,
  hasFunction: boolean,
): Promise<RoutePlan> {
  const { config } = build;
  const client = config.build.client;
  const clientFiles = await glob(["**/*"], {
    cwd: fileURLToPath(client),
    dot: true,
    onlyFiles: true,
  });
  const clientHtml = (
    await Promise.all(
      clientFiles
        .filter((file) => file.endsWith(".html"))
        .map((file) => readFile(new URL(file, client), "utf8")),
    )
  ).join("\n");
  return reconcileRoutes({
    base: normalizedBase(config.base),
    clientDirectory: client,
    clientFiles,
    clientHtml,
    pages: build.pages,
    resolvedRoutes: build.resolvedRoutes,
    emittedAssets: build.emittedAssets,
    hasFunction,
    trailingSlash: config.trailingSlash,
    hasServerIslands:
      hasFunction && (await hasServerIslandEntries(config.build.server)),
    hasRuntimeImages:
      hasFunction &&
      (await hasRuntimeImageCalls(config.build.server, build.resolvedRoutes)),
    imageEndpoint: config.image.endpoint.route,
  });
}

/** Reads emitted island loader entries without executing application code at build time. */
async function hasServerIslandEntries(directory: URL): Promise<boolean> {
  const files = await glob(["index.js", "**/*server-island-manifest*.js"], {
    cwd: fileURLToPath(directory),
    onlyFiles: true,
  });
  for (const file of files) {
    let found = false;
    visitSyntax(
      parseModule(await readFile(new URL(file, directory), "utf8")),
      (node) => {
        if (
          node.type !== "VariableDeclarator" ||
          !isSyntaxNode(node.id) ||
          typeof node.id.name !== "string" ||
          !/^serverIslandMap(?:\$\d+)?$/.test(node.id.name)
        )
          return;
        const init = node.init;
        if (
          !isSyntaxNode(init) ||
          init.type !== "NewExpression" ||
          !Array.isArray(init.arguments)
        )
          return;
        const entries: unknown = init.arguments[0];
        if (
          isSyntaxNode(entries) &&
          entries.type === "ArrayExpression" &&
          Array.isArray(entries.elements) &&
          entries.elements.length
        )
          found = true;
      },
    );
    if (found) return true;
  }
  return false;
}

export async function writeDeploymentManifest(
  outDir: URL,
  config: AstroConfig,
  input: WriteDeploymentManifestInput,
): Promise<YandexCloudManifestV1> {
  const client = config.build.client;
  const base = normalizedBase(config.base);
  const routes = manifestRoutes(input.routePlan, input.recursive404);
  const pageFunctionIds = [
    ...new Set(
      input.routePlan.routes
        .filter(
          (route) => route.kind === "on-demand" && route.routeKind === "page",
        )
        .map((route) => (route.kind === "on-demand" ? route.artifactId : "")),
    ),
  ];
  const manifest = defineDeploymentManifest({
    schemaVersion: 1,
    adapter: { version: ADAPTER_VERSION },
    target: input.deploymentTarget,
    modifiers: {
      apiGateway: input.apiGateway,
      recursive404: input.recursive404,
      ...(input.functionPartition ? { functions: input.functionPartition } : {}),
      ...(input.dependencyStrategy
        ? { dependencyStrategy: input.dependencyStrategy }
        : {}),
    },
    base,
    ...(config.build.assetsPrefix !== undefined
      ? { assetsPrefix: config.build.assetsPrefix }
      : {}),
    artifacts: {
      client: {
        id: "client:primary",
        path: relativeArtifactPath(outDir, client),
      },
      functions: input.functions.map(({ id, path, runtime, entrypoint }) => ({
        id,
        path,
        runtime,
        entrypoint,
      })),
    },
    routes: {
      ...routes,
      notFound: routes.notFound.map((scope) => ({
        ...scope,
        ...(pageFunctionIds.length
          ? { functionArtifactIds: pageFunctionIds }
          : {}),
      })),
    },
    ...(input.functions.length && !input.apiGateway
      ? {
          directInvocation: {
            requestTargetParameter: DIRECT_REQUEST_TARGET_PARAMETER,
          },
        }
      : {}),
    ...(input.apiGateway
      ? { gatewayTemplate: { path: "yandex-api-gateway.json" } }
      : {}),
  });
  parseDeploymentManifest(manifest);
  await mkdir(fileURLToPath(outDir), { recursive: true });
  if (input.apiGateway) {
    await writeFile(
      new URL("yandex-api-gateway.json", outDir),
      `${JSON.stringify(generateGatewayTemplate(manifest, input.routePlan), null, 2)}\n`,
    );
  }
  await writeFile(
    new URL("yandex-cloud.json", outDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function normalizedBase(base: string): string {
  const path = `/${base.replace(/^\/+|\/+$/g, "")}`;
  return path === "/" ? path : path.replace(/\/+$/, "");
}
