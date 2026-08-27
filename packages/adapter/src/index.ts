import type {
  AstroConfig,
  AstroIntegration,
  IntegrationResolvedRoute,
} from "astro";

import { readAstroVersion } from "./artifacts.js";
import { ADAPTER_NAME } from "./constants.js";
import {
  assertSupportedUserExternals,
  createDriver,
  serverViteConfig,
} from "./driver.js";
import { runtimeConfigPlugin } from "./runtime-config.js";
import type { AdapterOptions } from "./types.js";

export type {
  AdapterOptions,
  Target,
  YandexCloudManifestV1,
  YandexCloudRuntime,
} from "./types.js";
export type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudHttpResult,
} from "./runtime.js";

function routePattern(route: IntegrationResolvedRoute): string {
  return route.pattern;
}

function routePathname(pathname: string): string {
  return pathname ? `/${pathname.replace(/^\/+/, "")}` : "/";
}

function injectedRuntimeTypes(): string {
  return `declare namespace App {
  interface Locals {
    runtime: import('${ADAPTER_NAME}').YandexCloudRuntime;
  }
}
`;
}

export default function yandexCloud(options?: AdapterOptions): AstroIntegration {
  const driver = createDriver(options);
  let config: AstroConfig;
  let routes: IntegrationResolvedRoute[] = [];
  let astroMajor = 6;

  return {
    name: ADAPTER_NAME,
    hooks: {
      "astro:config:setup": ({ config: initialConfig, updateConfig }) => {
        assertSupportedUserExternals(initialConfig);
        updateConfig({
          build: driver.configureBuild(initialConfig.outDir),
          vite: { plugins: [runtimeConfigPlugin(initialConfig.site)] },
        });
      },
      "astro:routes:resolved": ({ routes: resolvedRoutes }) => {
        routes = resolvedRoutes.filter(
          (route) =>
            route.origin === "project" &&
            (route.type === "page" || route.type === "endpoint"),
        );
        const onDemand = routes.filter((route) => !route.isPrerendered);
        driver.assertRoutesSupported(onDemand.map(routePattern));
      },
      "astro:config:done": async ({
        config: resolvedConfig,
        injectTypes,
        setAdapter,
      }) => {
        config = resolvedConfig;
        astroMajor = Number.parseInt(
          (await readAstroVersion(config.root)).split(".")[0] ?? "6",
          10,
        );
        const hasOnDemand = routes.some((route) => !route.isPrerendered);
        setAdapter(driver.adapter(hasOnDemand));
        injectTypes({
          filename: "yandex-cloud.d.ts",
          content: injectedRuntimeTypes(),
        });
      },
      "astro:build:setup": ({ target: buildTarget, vite, updateConfig }) => {
        if (buildTarget !== "server") return;
        updateConfig(serverViteConfig(astroMajor, vite));
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
