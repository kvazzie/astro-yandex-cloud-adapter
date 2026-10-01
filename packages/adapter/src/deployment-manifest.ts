import { Schema } from "effect";

import { ManifestV1Schema, type DeploymentManifestV1 } from "./manifest/schema.js";

function invalidManifest(detail: string): never {
  throw new TypeError(`Invalid Deployment Manifest: ${detail}`);
}

const manifestUrlOrigin = "https://manifest.invalid";

function isCanonicalUrlPath(path: string): boolean {
  try {
    decodeURI(path);
    const parsed = new URL(path, manifestUrlOrigin);
    return (
      parsed.origin === manifestUrlOrigin &&
      !parsed.search &&
      !parsed.hash &&
      !path.includes("//") &&
      parsed.pathname === path
    );
  } catch {
    return false;
  }
}

function belongsToBase(base: string, path: string): boolean {
  return base === "/" || path === base || path.startsWith(`${base}/`);
}

function checkReferences(manifest: DeploymentManifestV1): void {
  if (
    !isCanonicalUrlPath(manifest.base) ||
    (manifest.base !== "/" && manifest.base.endsWith("/"))
  ) {
    invalidManifest(`base ${manifest.base} must be a canonical URL path.`);
  }
  const ids = new Set<string>([manifest.artifacts.client.id]);
  for (const artifact of manifest.artifacts.functions) {
    if (ids.has(artifact.id))
      invalidManifest(`duplicate artifact ID ${artifact.id}.`);
    ids.add(artifact.id);
  }
  if (
    manifest.target === "object-storage" &&
    manifest.artifacts.functions.length
  ) {
    invalidManifest("the Object Storage Target cannot emit Function Artifacts.");
  }
  if (manifest.modifiers.apiGateway !== Boolean(manifest.gatewayTemplate)) {
    invalidManifest("the API Gateway modifier and template reference must agree.");
  }
  if (manifest.directInvocation && manifest.modifiers.apiGateway) {
    invalidManifest("direct invocation cannot accompany an API Gateway template.");
  }
  const functionIds = new Set(manifest.artifacts.functions.map(({ id }) => id));
  const staticUrls = new Set<string>();
  const prefix = manifest.base === "/" ? "" : `${manifest.base.slice(1)}/`;
  for (const route of manifest.routes.prerendered) {
    if (
      !isCanonicalUrlPath(route.url) ||
      !belongsToBase(manifest.base, route.url)
    ) {
      invalidManifest(
        `Prerendered Route ${route.url} must be under base ${manifest.base}.`,
      );
    }
    if (
      !route.objectKey.startsWith(prefix) ||
      route.artifactId !== manifest.artifacts.client.id
    ) {
      invalidManifest(
        `Prerendered Route ${route.url} has an invalid Client Artifact reference or Object Storage key.`,
      );
    }
    if (staticUrls.has(route.url))
      invalidManifest(`duplicate Prerendered Route ${route.url}.`);
    staticUrls.add(route.url);
  }
  const onDemandPatterns = new Set<string>();
  for (const route of manifest.routes.onDemand) {
    if (
      !isCanonicalUrlPath(route.pattern) ||
      !belongsToBase(manifest.base, route.pattern)
    ) {
      invalidManifest(
        `On-demand Route ${route.pattern} must be under base ${manifest.base}.`,
      );
    }
    if (!functionIds.has(route.artifactId)) {
      invalidManifest(
        `On-demand Route ${route.pattern} has no matching Function Artifact.`,
      );
    }
    if (onDemandPatterns.has(route.pattern))
      invalidManifest(`duplicate On-demand Route ${route.pattern}.`);
    onDemandPatterns.add(route.pattern);
  }
  if (!manifest.routes.onDemand.length && manifest.artifacts.functions.length) {
    invalidManifest("Function Artifacts need On-demand Routes.");
  }
  const notFoundScopes = new Set<string>();
  for (const scope of manifest.routes.notFound) {
    const expectedUrl = `${scope.scope === "/" ? "" : scope.scope}/404`;
    const matchingPage = manifest.routes.prerendered.some(
      (route) =>
        route.kind === "page" &&
        route.url === scope.url &&
        route.objectKey === scope.objectKey &&
        route.artifactId === scope.artifactId,
    );
    if (
      !isCanonicalUrlPath(scope.scope) ||
      !belongsToBase(manifest.base, scope.scope) ||
      !isCanonicalUrlPath(scope.url) ||
      !belongsToBase(manifest.base, scope.url) ||
      !scope.objectKey.startsWith(prefix) ||
      scope.artifactId !== manifest.artifacts.client.id ||
      (scope.functionArtifactId !== undefined &&
        !functionIds.has(scope.functionArtifactId)) ||
      (scope.url !== expectedUrl && scope.url !== `${expectedUrl}/`) ||
      !matchingPage ||
      notFoundScopes.has(scope.scope)
    ) {
      invalidManifest(
        `404 scope ${scope.scope} has invalid placement or artifact references.`,
      );
    }
    notFoundScopes.add(scope.scope);
  }
}

/** Parses the synchronous, additive v1 Deployment Manifest contract. */
export function parseDeploymentManifest(value: unknown): DeploymentManifestV1 {
  let manifest: DeploymentManifestV1;
  try {
    manifest = Schema.decodeUnknownSync(ManifestV1Schema)(value);
  } catch (error) {
    invalidManifest(String(error));
  }
  checkReferences(manifest);
  return manifest;
}

/** Compile-time contract checking for a generated Manifest. */
export function defineDeploymentManifest(
  manifest: DeploymentManifestV1,
): DeploymentManifestV1 {
  return manifest;
}
