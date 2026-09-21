import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import schema from "./deployment-manifest.schema.json" with { type: "json" };
import type { DeploymentManifestV1 } from "./types.js";

const validate = new Ajv2020({ allErrors: true }).compile<DeploymentManifestV1>(
  schema,
);

/** Parses and validates the supported Deployment Manifest contract. */
export function parseDeploymentManifest(value: unknown): DeploymentManifestV1 {
  if (validate(value)) return value;

  const details = validate.errors
    ?.map(
      (error: ErrorObject) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
  throw new TypeError(
    `Invalid Deployment Manifest${details ? `: ${details}` : "."}`,
  );
}
