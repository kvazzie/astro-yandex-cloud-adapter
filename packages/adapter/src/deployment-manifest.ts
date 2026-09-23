import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import schema from "./deployment-manifest.schema.json" with { type: "json" };
import type { DeploymentManifestV1 } from "./types.js";

const validate = new Ajv2020({ allErrors: true }).compile<DeploymentManifestV1>(
  schema,
);

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

function validatePlacement(manifest: DeploymentManifestV1): void {
  if (!isCanonicalUrlPath(manifest.base)) {
    invalidManifest(`base ${manifest.base} must be a canonical URL path.`);
  }
  const keyPrefix = manifest.base === "/" ? "" : `${manifest.base.slice(1)}/`;
  const clientRoutes = new Set<string>();
  const clientPaths = new Set<string>();

  for (const file of manifest.artifacts.client.files) {
    if (clientPaths.has(file.path))
      invalidManifest(`duplicate Client Artifact path ${file.path}.`);
    clientPaths.add(file.path);

    const expectedKey = `${keyPrefix}${file.path}`;
    if (file.objectKey !== expectedKey) {
      invalidManifest(
        `Client Artifact file ${file.path} must use Object Storage key ${expectedKey} for base ${manifest.base}.`,
      );
    }
    if (!isCanonicalUrlPath(file.url)) {
      invalidManifest(
        `Client Artifact URL ${file.url} must be a canonical URL path.`,
      );
    }
    if (!belongsToBase(manifest.base, file.url)) {
      invalidManifest(
        `Client Artifact URL ${file.url} must be placed under base ${manifest.base}.`,
      );
    }
    clientRoutes.add(`${file.url}\0${file.objectKey}`);
  }

  for (const route of manifest.routes.prerendered) {
    if (!isCanonicalUrlPath(route.url)) {
      invalidManifest(
        `Prerendered Route URL ${route.url} must be a canonical URL path.`,
      );
    }
    if (!belongsToBase(manifest.base, route.url)) {
      invalidManifest(
        `Prerendered Route URL ${route.url} must be placed under base ${manifest.base}.`,
      );
    }
    if (!clientRoutes.has(`${route.url}\0${route.objectKey}`)) {
      invalidManifest(
        `Prerendered Route ${route.url} must reference an uploaded Client Artifact file.`,
      );
    }
  }

  for (const route of manifest.routes.onDemand) {
    if (!isCanonicalUrlPath(route.pattern)) {
      invalidManifest(
        `On-demand Route pattern ${route.pattern} must be a canonical URL path.`,
      );
    }
    if (!belongsToBase(manifest.base, route.pattern)) {
      invalidManifest(
        `On-demand Route pattern ${route.pattern} must be placed under base ${manifest.base}.`,
      );
    }
  }
}

/** Parses and validates the supported Deployment Manifest contract. */
export function parseDeploymentManifest(value: unknown): DeploymentManifestV1 {
  if (validate(value)) {
    validatePlacement(value);
    return value;
  }

  const details = validate.errors
    ?.map(
      (error: ErrorObject) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
  invalidManifest(details ?? "the value does not match schema version 1.");
}

/** Builds a Deployment Manifest with compile-time contract checking. */
export function defineDeploymentManifest(
  manifest: DeploymentManifestV1,
): DeploymentManifestV1 {
  return manifest;
}
