import * as Effect from "effect/Effect";
import {
  defineIntegration,
  EffectifyIntegrationHookError,
} from "effectify/astro/integration";

import { ADAPTER_NAME } from "./constants.ts";
import { reportArtifactSizes } from "./build/report.ts";
import { injectedRuntimeTypes } from "./injected-types.ts";
import { OptionsSchema } from "./integration/options.ts";
import type { Options } from "./integration/options.ts";
import { createIntegrationSession } from "./integration/session.ts";
import { runtimeConfigPlugin } from "./runtime-config.ts";
import { selectTarget } from "./target";
import type { BuildError } from "./target/module.ts";
import type { AdapterOptions } from "./types.ts";

export {
  defineDeploymentManifest,
  parseDeploymentManifest,
} from "./deployment-manifest.ts";
export type {
  AdapterOptions,
  DependencyStrategy,
  FunctionPartition,
  DeploymentManifestV1,
  OnDemandRouteRequirement,
  PrerenderedRouteRequirement,
  Target,
  YandexCloudManifestV1,
  YandexCloudRuntime,
} from "./types.ts";
export type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudHttpResult,
} from "./runtime.ts";

function hookError(
  hook: "astro:config:setup" | "astro:config:done" | "astro:build:done",
) {
  return (error: BuildError) =>
    new EffectifyIntegrationHookError({
      hook,
      message: error.message,
      cause: error.cause,
    });
}

/** Creates the Bare Adapter integration for the selected Yandex Cloud Target. */
export default defineIntegration<Options, AdapterOptions>({
  name: ADAPTER_NAME,
  schema: OptionsSchema,
  setup: ({ options }) => {
    const target = selectTarget(options);
    const session = createIntegrationSession();

    return {
      "astro:config:setup": ({ config, updateConfig }) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => session.reset());
          const patch = yield* target.astroBuildConfig(config);
          yield* Effect.sync(() =>
            updateConfig({
              ...patch,
              vite: { plugins: [runtimeConfigPlugin(config.site, options)] },
            }),
          );
        }).pipe(Effect.mapError(hookError("astro:config:setup"))),
      "astro:routes:resolved": ({ routes }) =>
        Effect.sync(() => {
          session.recordRoutes(routes);
        }),
      "astro:config:done": ({ config, injectTypes, setAdapter }) =>
        Effect.gen(function* () {
          const snapshot = yield* Effect.sync(() => session.recordConfig(config));
          const adapter = yield* target.astroAdapter(snapshot.routes);
          yield* Effect.sync(() => {
            setAdapter(adapter);
            injectTypes({
              filename: "yandex-cloud.d.ts",
              content: injectedRuntimeTypes(),
            });
          });
        }).pipe(Effect.mapError(hookError("astro:config:done"))),
      "astro:build:setup": ({ target: buildTarget, vite, updateConfig }) =>
        Effect.sync(() => {
          if (buildTarget === "server")
            updateConfig(target.serverViteConfig(vite));
        }),
      "astro:build:done": ({ pages, assets, logger }) =>
        Effect.try({
          try: () => session.completedBuild(pages, assets),
          catch: (cause): BuildError => ({
            _tag: "InvalidConfiguration",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        }).pipe(
          Effect.flatMap((build) =>
            target
              .generateArtifacts(build)
              .pipe(
                Effect.tap((manifest) =>
                  Effect.tryPromise(() =>
                    reportArtifactSizes(build.config.outDir, manifest, logger),
                  ).pipe(
                    Effect.catchAll(() =>
                      Effect.sync(() =>
                        logger.warn(
                          "Could not read generated artifacts for the size report. The build continues.",
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ),
          Effect.mapError(hookError("astro:build:done")),
          Effect.asVoid,
        ),
    };
  },
});
