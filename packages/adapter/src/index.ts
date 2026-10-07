import * as Effect from "effect/Effect";
import {
  defineIntegration,
  EffectifyIntegrationHookError,
} from "effectify/astro/integration";

import { ADAPTER_NAME } from "./constants.js";
import { reportArtifactSizes } from "./build/report.js";
import { injectedRuntimeTypes } from "./injected-types.js";
import { decodeOptions } from "./integration/options.js";
import { createIntegrationSession } from "./integration/session.js";
import { runtimeConfigPlugin } from "./runtime-config.js";
import { selectTarget } from "./target/index.js";
import type { BuildError } from "./target/module.js";
import type { AdapterOptions } from "./types.js";

export {
  defineDeploymentManifest,
  parseDeploymentManifest,
} from "./deployment-manifest.js";
export type {
  AdapterOptions,
  DependencyStrategy,
  DeploymentManifestV1,
  OnDemandRouteRequirement,
  PrerenderedRouteRequirement,
  Target,
  YandexCloudManifestV1,
  YandexCloudRuntime,
} from "./types.js";
export type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudHttpResult,
} from "./runtime.js";

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
export default defineIntegration<AdapterOptions | undefined, AdapterOptions>({
  name: ADAPTER_NAME,
  setup: ({ options }) => {
    const plan = decodeOptions(options);
    const target = selectTarget(plan);
    const session = createIntegrationSession();

    return {
      "astro:config:setup": ({ config, updateConfig }) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => session.reset());
          const patch = yield* target.astroBuildConfig(config);
          yield* Effect.sync(() =>
            updateConfig({
              ...patch,
              vite: { plugins: [runtimeConfigPlugin(config.site)] },
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
