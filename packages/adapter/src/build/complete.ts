import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { AstroConfig } from "astro";
import * as Effect from "effect/Effect";
import { glob } from "tinyglobby";

import { ADAPTER_VERSION } from "../constants.js";
import {
  defineDeploymentManifest,
  parseDeploymentManifest,
} from "../deployment-manifest.js";
import type { Target, YandexCloudManifestV1 } from "../types.js";
import { validateFunctionEntrypoint } from "../function/package.js";
import type { CompletedBuild } from "../integration/session.js";
import type { BuildError } from "../target/module.js";
import { manifestRoutes, reconcileRoutes, type RoutePlan } from "./routes.js";

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
  prepareArtifacts(
    build: CompletedBuild,
    routePlan: RoutePlan,
    hasFunction: boolean,
  ): Effect.Effect<void, BuildError>;
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
    yield* policy.prepareArtifacts(build, routePlan, hasFunction);
    return yield* Effect.tryPromise({
      try: () =>
        writeDeploymentManifest(config.outDir, config, {
          deploymentTarget: policy.target,
          ...(policy.dependencyStrategy
            ? { dependencyStrategy: policy.dependencyStrategy }
            : {}),
          routePlan,
          hasFunction,
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
  hasFunction: boolean;
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
  });
}

export async function writeDeploymentManifest(
  outDir: URL,
  config: AstroConfig,
  input: WriteDeploymentManifestInput,
): Promise<YandexCloudManifestV1> {
  const client = config.build.client;
  const functionDirectory = config.build.server;
  const base = normalizedBase(config.base);
  const manifest = defineDeploymentManifest({
    schemaVersion: 1,
    adapter: { version: ADAPTER_VERSION },
    target: input.deploymentTarget,
    modifiers: {
      apiGateway: false,
      ...(input.dependencyStrategy
        ? { dependencyStrategy: input.dependencyStrategy }
        : {}),
    },
    base,
    ...(typeof config.build.assetsPrefix === "string"
      ? { assetsPrefix: config.build.assetsPrefix }
      : {}),
    artifacts: {
      client: {
        id: "client:primary",
        path: relativeArtifactPath(outDir, client),
      },
      functions: input.hasFunction
        ? [
            {
              id: "function:shared",
              path: relativeArtifactPath(outDir, functionDirectory),
              runtime: "nodejs22",
              entrypoint: "index.handler",
            },
          ]
        : [],
    },
    routes: {
      ...manifestRoutes(input.routePlan),
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

function normalizedBase(base: string): string {
  const path = `/${base.replace(/^\/+|\/+$/g, "")}`;
  return path === "/" ? path : path.replace(/\/+$/, "");
}
