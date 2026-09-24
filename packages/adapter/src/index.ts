import type {
  AstroConfig,
  AstroIntegration,
  IntegrationResolvedRoute,
} from "astro";

import { ADAPTER_NAME } from "./constants.js";
import { createDriver } from "./driver/index.js";
import { injectedRuntimeTypes } from "./injected-types.js";
import { needsConfiguredRuntime, routePathname, routePattern } from "./routes.js";
import { runtimeConfigPlugin } from "./runtime-config.js";
import type { AdapterOptions } from "./types.js";

export {
  defineDeploymentManifest,
  parseDeploymentManifest,
} from "./deployment-manifest.js";
export type {
  AdapterOptions,
  ClientArtifactFile,
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

/** Creates the Bare Adapter integration for the selected Yandex Cloud Target. */
export default function yandexCloud(options?: AdapterOptions): AstroIntegration {
  const driver = createDriver(options);
  let config: AstroConfig;
  let routes: IntegrationResolvedRoute[] = [];

  return {
    name: ADAPTER_NAME,
    hooks: {
      "astro:config:setup": ({ config: initialConfig, updateConfig }) => {
        driver.assertUserExternals(initialConfig);
        updateConfig({
          build: driver.configureBuild(initialConfig.outDir),
          vite: { plugins: [runtimeConfigPlugin(initialConfig.site)] },
        });
      },
      "astro:routes:resolved": ({ routes: resolvedRoutes }) => {
        routes = resolvedRoutes.filter(
          (route) => route.type === "page" || route.type === "endpoint",
        );
        const onDemand = routes.filter(needsConfiguredRuntime);
        driver.assertRoutesSupported(onDemand.map(routePattern));
      },
      "astro:config:done":
        /** Finalizes adapter metadata and generated runtime types. */
        ({ config: resolvedConfig, injectTypes, setAdapter }) => {
          config = resolvedConfig;
          const hasOnDemand = routes.some(needsConfiguredRuntime);
          setAdapter(driver.adapter(hasOnDemand));
          injectTypes({
            filename: "yandex-cloud.d.ts",
            content: injectedRuntimeTypes(),
          });
        },
      "astro:build:setup":
        /** Applies Function Artifact bundling only to Astro's server build. */
        ({ target: buildTarget, vite, updateConfig }) => {
          if (buildTarget !== "server") return;
          updateConfig(driver.configureServerBuild(vite));
        },
      "astro:build:done": async ({ pages }) => {
        const onDemand = routes
          .filter((route) => !route.isPrerendered)
          .map(routePattern);
        await driver.completeBuild({
          config,
          onDemand,
          prerendered: pages.map((page) => routePathname(page.pathname)),
        });
      },
    },
  };
}
