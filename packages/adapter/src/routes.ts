import type { IntegrationResolvedRoute } from "astro";

export function routePattern(route: IntegrationResolvedRoute): string {
  return route.pattern;
}

export function needsConfiguredRuntime(route: IntegrationResolvedRoute): boolean {
  return !route.isPrerendered && route.origin !== "internal";
}

export function routePathname(pathname: string): string {
  return pathname ? `/${pathname.replace(/^\/+/, "")}` : "/";
}
