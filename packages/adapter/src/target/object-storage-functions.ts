import type { AstroConfig, IntegrationResolvedRoute } from "astro";
import { Effect } from "effect";
import type { InlineConfig } from "vite";

import { completeBuild } from "../build/complete.js";
import {
  assertUserExternals,
  configureServerBuild,
  sharpImageService,
} from "../function/config.js";
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
    astroAdapter(routes: readonly IntegrationResolvedRoute[]) {
      const hasOnDemand = routes.some(
        (route) => !route.isPrerendered && route.origin !== "internal",
      );
      return Effect.succeed(
        adapter(hasOnDemand, {
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
      return completeBuild(build, plan);
    },
  };
}
