import type { AstroConfig } from "astro";
import { rm } from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { InlineConfig } from "vite";

import { completeBuild } from "../build/complete.js";
import {
  assertUserExternals,
  configureServerBuild,
  sharpImageService,
} from "../function/config.js";
import {
  applyFunctionPolicy,
  partitionFunctions,
  writePreviewDispatcher,
} from "../function/partition.js";
import { prepareNotFoundArtifacts } from "../build/not-found.js";
import type { BuildPlan } from "../integration/options.js";
import type { CompletedBuild } from "../integration/session.js";
import type { TargetModule } from "./module.js";
import { adapter, buildDirectories } from "./shared.js";

export function objectStorageFunctionsModule(
  plan: Extract<BuildPlan, { target: "object-storage-functions" }>,
): TargetModule {
  return {
    target: "object-storage-functions",
    astroBuildConfig(config: AstroConfig) {
      return Effect.try({
        try: () => {
          assertUserExternals(config, plan.dependencyStrategy);
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
          sharpImageService: sharpImageService(plan.dependencyStrategy),
          envGetSecret: "stable",
          i18nDomains: "unsupported",
        }),
      );
    },
    serverViteConfig(vite: InlineConfig) {
      return configureServerBuild(vite, plan.dependencyStrategy);
    },
    generateArtifacts(build: CompletedBuild) {
      return completeBuild(build, {
        target: plan.target,
        dependencyStrategy: plan.dependencyStrategy,
        apiGateway: plan.apiGateway,
        recursive404: plan.recursive404,
        functionPartition: plan.functions,
        prepareArtifacts: (build, routePlan) =>
          Effect.gen(function* () {
            const incompatible = routePlan.routes.filter(
              (route) =>
                route.kind === "on-demand" &&
                (route.routeKind === "page" || route.origin === "internal"),
            );
            if (!plan.apiGateway && incompatible.length) {
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
            const prepared = yield* partitionFunctions(build, routePlan, plan);
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
                  plan.recursive404,
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
            if (plan.functions === "separate" && prepared.functions.length)
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
