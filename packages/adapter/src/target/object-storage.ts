import type { AstroConfig, IntegrationResolvedRoute } from "astro";
import { Effect } from "effect";
import type { InlineConfig } from "vite";

import { completeBuild } from "../build/complete.js";
import { manifestRoutes, registeredOnDemandRoutes } from "../build/routes.js";
import { assertUserExternals, configureServerBuild } from "../function/config.js";
import type { BuildPlan } from "../integration/options.js";
import type { CompletedBuild } from "../integration/session.js";
import type { TargetModule } from "./module.js";
import { adapter, buildDirectories } from "./shared.js";

export function objectStorageModule(
  plan: Extract<BuildPlan, { target: "object-storage" }>,
): TargetModule {
  return {
    target: "object-storage",
    astroBuildConfig(config: AstroConfig) {
      return Effect.try({
        try: () => {
          assertUserExternals(config, "bundle");
          return { build: buildDirectories(config.outDir) };
        },
        catch: (cause) => ({
          _tag: "InvalidConfiguration" as const,
          message: String(cause),
          cause,
        }),
      });
    },
    astroAdapter(routes: readonly IntegrationResolvedRoute[]) {
      const onDemand = registeredOnDemandRoutes(routes);
      if (onDemand.length) {
        return Effect.fail({
          _tag: "UnsupportedRoute" as const,
          message: `The object-storage target cannot serve on-demand routes: ${onDemand.map((route) => route.pattern).join(", ")}. Use target "object-storage-functions" or prerender these routes.`,
        });
      }
      return Effect.succeed(
        adapter(false, {
          staticOutput: "stable",
          hybridOutput: "unsupported",
          serverOutput: "unsupported",
          sharpImageService: "stable",
          envGetSecret: "stable",
          i18nDomains: "unsupported",
        }),
      );
    },
    serverViteConfig(vite: InlineConfig) {
      return configureServerBuild(vite, "bundle");
    },
    generateArtifacts(build: CompletedBuild) {
      return completeBuild(build, {
        target: plan.target,
        prepareArtifacts: (_build, routePlan, hasFunction) => {
          const onDemand = manifestRoutes(routePlan).onDemand.map(
            (route) => route.pattern,
          );
          if (onDemand.length || hasFunction)
            return Effect.fail({
              _tag: "UnsupportedRoute" as const,
              message: onDemand.length
                ? `The object-storage target cannot serve on-demand routes: ${onDemand.join(", ")}. Use target "object-storage-functions" or prerender these routes.`
                : 'The object-storage target cannot deploy a Function Artifact. Use target "object-storage-functions".',
            });
          return Effect.void;
        },
      });
    },
  };
}
