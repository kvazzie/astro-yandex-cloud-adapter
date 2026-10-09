import { createHash } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";

import type { CompletedBuild } from "../integration/session.js";
import type { PreparedFunctionArtifact } from "../function/partition.js";
import type { FunctionArtifactPolicy } from "../runtime/types.js";
import { manifestRoutes, type RoutePlan } from "./routes.js";

/** Copies completed static error pages into each Function that serves pages. */
export async function prepareNotFoundArtifacts(
  build: CompletedBuild,
  routePlan: RoutePlan,
  functions: PreparedFunctionArtifact[],
  recursive404: boolean,
): Promise<Map<string, Omit<FunctionArtifactPolicy, "artifactDirectory">>> {
  const scopes = manifestRoutes(routePlan, recursive404).notFound;
  const pageFunctions = new Set<string>(
    routePlan.routes.flatMap((route) =>
      route.kind === "on-demand" && route.routeKind === "page"
        ? [route.artifactId]
        : [],
    ),
  );
  const policies = new Map<
    string,
    Omit<FunctionArtifactPolicy, "artifactDirectory">
  >();
  const prefix = routePlan.base === "/" ? "" : `${routePlan.base.slice(1)}/`;
  for (const artifact of functions) {
    const policy: Omit<FunctionArtifactPolicy, "artifactDirectory"> = {
      ...(artifact.allowedRoutes ? { allowedRoutes: artifact.allowedRoutes } : {}),
    };
    if (pageFunctions.has(artifact.id) && scopes.length) {
      policy.notFound = [];
      policy.recursive404 = recursive404;
      await mkdir(new URL(".yandex/404/", artifact.directory), {
        recursive: true,
      });
      for (const scope of scopes) {
        const name = createHash("sha256")
          .update(scope.url)
          .digest("hex")
          .slice(0, 16);
        const file = `.yandex/404/${name}.html`;
        const source = scope.objectKey.slice(prefix.length);
        await copyFile(
          new URL(source, build.config.build.client),
          new URL(file, artifact.directory),
        );
        policy.notFound.push({ scope: scope.scope, url: scope.url, file });
      }
    }
    policies.set(artifact.id, policy);
  }
  return policies;
}
