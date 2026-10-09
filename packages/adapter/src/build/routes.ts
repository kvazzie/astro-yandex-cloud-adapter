import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { IntegrationResolvedRoute } from "astro";
import type * as Brand from "effect/Brand";

import type {
  DeploymentManifestV1,
  OnDemandRouteRequirement,
  PrerenderedRouteRequirement,
} from "../manifest/schema.js";

type ArtifactId<K extends "client" | "function"> = string & Brand.Brand<K>;
const clientId = "client:primary" as ArtifactId<"client">;
const functionId = "function:shared" as ArtifactId<"function">;

export type PlannedRoute =
  | {
      kind: "prerendered";
      routeKind: "page" | "endpoint";
      pattern: string;
      priority: number;
      patternRegex: string;
      paths: Array<{
        url: string;
        objectKey: string;
        artifactId: ArtifactId<"client">;
      }>;
    }
  | {
      kind: "on-demand";
      routeKind: "page" | "endpoint";
      pattern: string;
      artifactId: ArtifactId<"function">;
      priority: number;
      patternRegex: string;
      origin: string;
    };

export interface RoutePlan {
  routes: PlannedRoute[];
  base: string;
  trailingSlash: "always" | "never" | "ignore";
}

interface RouteEvidence {
  base: string;
  clientDirectory: URL;
  clientFiles: readonly string[];
  clientHtml: string;
  pages: readonly { pathname: string }[];
  resolvedRoutes: readonly IntegrationResolvedRoute[];
  emittedAssets: ReadonlyMap<string, readonly URL[]>;
  hasFunction: boolean;
  trailingSlash: "always" | "never" | "ignore";
  hasServerIslands: boolean;
}

/** Preliminary route compatibility before Astro emits build artifacts. */
export function registeredOnDemandRoutes(
  routes: readonly IntegrationResolvedRoute[],
): IntegrationResolvedRoute[] {
  return routes.filter(
    (route) =>
      (route.type === "page" || route.type === "endpoint") &&
      !route.isPrerendered &&
      route.origin !== "internal",
  );
}

function withBase(base: string, urlPath: string): string {
  const suffix = `/${urlPath.replace(/^\/+/, "")}`;
  if (base === "/") return suffix;
  return suffix === "/" ? `${base}/` : `${base}${suffix}`;
}

function objectKey(base: string, path: string): string {
  return base === "/" ? path : `${base.slice(1)}/${path}`;
}

function pageFile(url: string, files: Set<string>): string {
  const pathname = url.replace(/^\/+|\/+$/g, "");
  const candidates =
    url === "/"
      ? ["index.html"]
      : url.endsWith("/")
        ? [`${pathname}/index.html`, `${pathname}.html`]
        : [`${pathname}.html`, `${pathname}/index.html`];
  const file = candidates.find((candidate) => files.has(candidate));
  if (!file)
    throw new Error(
      `Could not match the Prerendered Route ${url} to a Client Artifact file.`,
    );
  return file;
}

function isActiveInternalRoute(
  route: IntegrationResolvedRoute,
  clientHtml: string,
  hasServerIslands: boolean,
): boolean {
  if (route.origin !== "internal") return true;
  if (route.pattern.startsWith("/_actions/")) return true;
  if (route.pattern.startsWith("/_server-islands/"))
    return hasServerIslands || clientHtml.includes("/_server-islands/");
  if (route.pattern === "/_image") return clientHtml.includes("/_image?");
  return false;
}

/** Reconciles Astro patterns with actual emitted Client Artifact files. */
export function reconcileRoutes(evidence: RouteEvidence): RoutePlan {
  const {
    base,
    clientDirectory,
    pages,
    resolvedRoutes,
    emittedAssets,
    hasFunction,
  } = evidence;
  const files = new Set(evidence.clientFiles);
  const prerenderedRoutes = new Map<
    string,
    Extract<PlannedRoute, { kind: "prerendered" }>
  >();
  const seenUrls = new Set<string>();
  const addPrerendered = (
    route: IntegrationResolvedRoute,
    url: string,
    file: string,
  ) => {
    if (!files.has(file))
      throw new Error(
        `Prerendered Route ${url} has no emitted Client Artifact file ${file}.`,
      );
    const publicUrl =
      url === "/" && base !== "/" && evidence.trailingSlash === "never"
        ? base
        : withBase(base, url);
    if (seenUrls.has(publicUrl))
      throw new Error(`Ambiguous Prerendered Route ${publicUrl}.`);
    seenUrls.add(publicUrl);
    let planned = prerenderedRoutes.get(route.pattern);
    if (!planned) {
      planned = {
        kind: "prerendered",
        routeKind: route.type as "page" | "endpoint",
        pattern: withBase(base, route.pattern),
        priority: resolvedRoutes.indexOf(route),
        patternRegex: route.patternRegex.source,
        paths: [],
      };
      prerenderedRoutes.set(route.pattern, planned);
    }
    planned.paths.push({
      url: publicUrl,
      objectKey: objectKey(base, file),
      artifactId: clientId,
    });
  };

  for (const { pathname } of pages) {
    const url = pathname ? `/${pathname.replace(/^\/+/, "")}` : "/";
    const matches = resolvedRoutes.filter(
      (route) =>
        route.type === "page" &&
        route.isPrerendered &&
        route.patternRegex.test(url),
    );
    const exact = matches.find(
      (route) => route.pattern.replace(/\/$/, "") === url.replace(/\/$/, ""),
    );
    const route = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!route)
      throw new Error(`Could not identify the Astro route that emitted ${url}.`);
    addPrerendered(route, url, pageFile(url, files));
  }

  const clientPath = fileURLToPath(clientDirectory);
  for (const route of resolvedRoutes) {
    if (route.type !== "endpoint" || !route.isPrerendered) continue;
    for (const asset of emittedAssets.get(route.pattern) ?? []) {
      const file = relative(clientPath, fileURLToPath(asset)).split(sep).join("/");
      if (!files.has(file)) continue;
      addPrerendered(
        route,
        `/${file.split("/").map(encodeURIComponent).join("/")}`,
        file,
      );
    }
  }

  const onDemand: PlannedRoute[] = hasFunction
    ? resolvedRoutes
        .filter(
          (route) =>
            (route.type === "page" || route.type === "endpoint") &&
            !route.isPrerendered &&
            isActiveInternalRoute(
              route,
              evidence.clientHtml,
              evidence.hasServerIslands,
            ),
        )
        .map((route) => ({
          kind: "on-demand" as const,
          routeKind: route.type as "page" | "endpoint",
          pattern: withBase(base, route.pattern),
          artifactId: functionId,
          priority: resolvedRoutes.indexOf(route),
          patternRegex: route.patternRegex.source,
          origin: route.origin,
        }))
    : [];
  for (const route of prerenderedRoutes.values())
    route.paths.sort((a, b) => a.url.localeCompare(b.url));
  return {
    base,
    trailingSlash: evidence.trailingSlash,
    routes: [...prerenderedRoutes.values(), ...onDemand].sort((a, b) =>
      a.pattern.localeCompare(b.pattern),
    ),
  };
}

/** Projects the route plan into the portable Manifest contract. */
export function manifestRoutes(
  plan: RoutePlan,
  recursive404 = false,
): {
  prerendered: PrerenderedRouteRequirement[];
  onDemand: OnDemandRouteRequirement[];
  notFound: DeploymentManifestV1["routes"]["notFound"];
} {
  const prerendered: PrerenderedRouteRequirement[] = [];
  const onDemand: OnDemandRouteRequirement[] = [];
  const notFound: Array<DeploymentManifestV1["routes"]["notFound"][number]> = [];
  for (const route of plan.routes) {
    if (route.kind === "prerendered") {
      prerendered.push(
        ...route.paths.map((path) => ({ kind: route.routeKind, ...path })),
      );
      if (route.routeKind === "page" && /\/404\/?$/.test(route.pattern)) {
        notFound.push(
          ...route.paths
            .map((path) => ({
              scope: path.url.replace(/\/404\/?$/, "") || "/",
              ...path,
            }))
            .filter(({ scope }) => recursive404 || scope === plan.base),
        );
      }
    } else {
      onDemand.push({
        kind: route.routeKind,
        pattern: route.pattern,
        artifactId: route.artifactId,
      });
    }
  }
  prerendered.sort((a, b) => a.url.localeCompare(b.url));
  onDemand.sort((a, b) => a.pattern.localeCompare(b.pattern));
  notFound.sort((a, b) => a.scope.localeCompare(b.scope));
  return { prerendered, onDemand, notFound };
}
