import type { AstroConfig, IntegrationResolvedRoute } from "astro";

export interface CompletedBuild {
  config: AstroConfig;
  resolvedRoutes: readonly IntegrationResolvedRoute[];
  pages: readonly { pathname: string }[];
  emittedAssets: ReadonlyMap<string, readonly URL[]>;
}

/** Keeps one Astro integration instance's lifecycle snapshots together. */
export function createIntegrationSession() {
  let config: AstroConfig | undefined;
  let routes: readonly IntegrationResolvedRoute[] = [];
  return {
    reset() {
      config = undefined;
      routes = [];
    },
    recordRoutes(next: readonly IntegrationResolvedRoute[]) {
      routes = next.filter(
        (route) => route.type === "page" || route.type === "endpoint",
      );
      return routes;
    },
    recordConfig(next: AstroConfig) {
      config = next;
      return { config, routes };
    },
    completedBuild(
      pages: readonly { pathname: string }[],
      emittedAssets: ReadonlyMap<string, readonly URL[]>,
    ): CompletedBuild {
      if (!config)
        throw new Error(
          "Astro build completed before adapter configuration was resolved.",
        );
      return { config, resolvedRoutes: routes, pages, emittedAssets };
    },
  };
}
