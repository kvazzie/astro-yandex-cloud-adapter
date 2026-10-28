import type { AstroConfig } from "astro";
import { rm } from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { InlineConfig } from "vite";

import { completeBuild } from "../build/complete.ts";
import {
  assertUserExternals,
  configureServerBuild,
  sharpImageService,
} from "../function/config.ts";
import {
  applyFunctionPolicy,
  partitionFunctions,
  writePreviewDispatcher,
} from "../function/partition.ts";
import { prepareNotFoundArtifacts } from "../build/not-found.ts";
import type { Options } from "../integration/options.ts";
import type { CompletedBuild } from "../integration/session.ts";
import type { TargetModule } from "./module.ts";
import { adapter, buildDirectories } from "./shared.ts";

export function objectStorageFunctionsModule(
  options: Extract<Options, { target: "object-storage-functions" }>,
): TargetModule {
  return {
    target: "object-storage-functions",
    astroBuildConfig(config: AstroConfig) {
      return Effect.try({
        try: () => {
          assertUserExternals(config, options.dependencyStrategy);
          return { build: buildDirectories(config.outDir) };
        },
        catch: (cause) => ({
          _tag: "InvalidConfiguration" as const,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      });
    },
    astroAdapter() {
      return Effect.succeed(
        // Runtime capability must be available before Astro discovers deferred islands.
        // The completed build decides whether a Function Artifact is actually required.
        adapter(true, {
          staticOutput: "stable",
          hybridOutput: "stable",
          serverOutput: "stable",
          sharpImageService: sharpImageService(options.dependencyStrategy),
          envGetSecret: "stable",
          i18nDomains: "unsupported",
        }),
      );
    },
    serverViteConfig(vite: InlineConfig) {
      return configureServerBuild(vite, options.dependencyStrategy);
    },
    generateArtifacts(build: CompletedBuild) {
      return completeBuild(build, {
        target: options.target,
        dependencyStrategy: options.dependencyStrategy,
        apiGateway: options.apiGateway,
        recursive404: options.recursive404,
        functionPartition: options.functions,
        prepareArtifacts: (build, routePlan) =>
          Effect.gen(function* () {
            const incompatible = routePlan.routes.filter(
              (route) =>
                route.kind === "on-demand" &&
                (route.routeKind === "page" || route.origin === "internal"),
            );
            if (!options.apiGateway && incompatible.length) {
              return yield* Effect.fail({
                _tag: "UnsupportedRoute" as const,
                message: `Direct Function URLs support only stateless user-defined endpoints. These required routes need apiGateway: true: ${incompatible.map((route) => route.pattern).join(", ")}.`,
              });
            }
            const dynamic404 = routePlan.routes.find(
              (route) =>
                route.kind === "on-demand" &&
                route.routeKind === "page" &&
                /\/404\/?$/.test(route.pattern),
            );
            if (dynamic404) {
              return yield* Effect.fail({
                _tag: "UnsupportedRoute" as const,
                message: `Custom 404 page ${dynamic404.pattern} must be prerendered. Add export const prerender = true.`,
              });
            }
            const prepared = yield* partitionFunctions(build, routePlan, options);
            if (!prepared.functions.length)
              yield* Effect.tryPromise({
                try: () =>
                  rm(build.config.build.server, { recursive: true, force: true }),
                catch: (cause) => ({
                  _tag: "InvalidArtifact" as const,
                  message: String(cause),
                  cause,
                }),
              });
            const policies = yield* Effect.tryPromise({
              try: () =>
                prepareNotFoundArtifacts(
                  build,
                  prepared.routePlan,
                  prepared.functions,
                  options.recursive404,
                ),
              catch: (cause) => ({
                _tag: "InvalidArtifact" as const,
                message: String(cause),
                cause,
              }),
            });
            for (const artifact of prepared.functions) {
              const policy = policies.get(artifact.id)!;
              if (Object.keys(policy).length)
                yield* Effect.tryPromise({
                  try: () => applyFunctionPolicy(artifact.directory, policy),
                  catch: (cause) => ({
                    _tag: "InvalidArtifact" as const,
                    message: String(cause),
                    cause,
                  }),
                });
            }
            if (options.functions === "separate" && prepared.functions.length)
              yield* Effect.tryPromise({
                try: () =>
                  writePreviewDispatcher(
                    build,
                    prepared.routePlan,
                    prepared.functions,
                  ),
                catch: (cause) => ({
                  _tag: "InvalidArtifact" as const,
                  message: String(cause),
                  cause,
                }),
              });
            return prepared;
          }),
      });
    },
  };
}
