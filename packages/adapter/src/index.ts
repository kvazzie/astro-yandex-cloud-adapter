import type { AstroIntegration } from "astro";
import { Effect, Either } from "effect";

import { ADAPTER_NAME } from "./constants.js";
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

function buildError(error: BuildError): Error {
  return new Error(error.message, { cause: error.cause });
}

function runHook<A>(effect: Effect.Effect<A, BuildError>): A {
  const result = Effect.runSync(Effect.either(effect));
  if (Either.isLeft(result)) throw buildError(result.left);
  return result.right;
}

async function runBuild<A>(effect: Effect.Effect<A, BuildError>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) throw buildError(result.left);
  return result.right;
}

/** Creates the Bare Adapter integration for the selected Yandex Cloud Target. */
export default function yandexCloud(options?: AdapterOptions): AstroIntegration {
  const plan = decodeOptions(options);
  const target = selectTarget(plan);
  const session = createIntegrationSession();

  return {
    name: ADAPTER_NAME,
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        session.reset();
        const patch = runHook(target.astroBuildConfig(config));
        updateConfig({
          ...patch,
          vite: { plugins: [runtimeConfigPlugin(config.site)] },
        });
      },
      "astro:routes:resolved": ({ routes }) => {
        const snapshot = session.recordRoutes(routes);
        runHook(target.astroAdapter(snapshot));
      },
      "astro:config:done": ({ config, injectTypes, setAdapter }) => {
        const snapshot = session.recordConfig(config);
        setAdapter(runHook(target.astroAdapter(snapshot.routes)));
        injectTypes({
          filename: "yandex-cloud.d.ts",
          content: injectedRuntimeTypes(),
        });
      },
      "astro:build:setup": ({ target: buildTarget, vite, updateConfig }) => {
        if (buildTarget === "server") updateConfig(target.serverViteConfig(vite));
      },
      "astro:build:done": async ({ pages, assets }) => {
        await runBuild(
          target.generateArtifacts(session.completedBuild(pages, assets)),
        );
      },
    },
  };
}
