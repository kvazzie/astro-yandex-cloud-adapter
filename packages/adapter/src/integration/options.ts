import * as Schema from "effect/Schema";

import type { DependencyStrategy, FunctionPartition, Target } from "../types.js";

interface RoutingOptions {
  apiGateway: boolean;
  recursive404: boolean;
}

export type BuildPlan =
  | (RoutingOptions & { target: "object-storage" })
  | (RoutingOptions & {
      target: "object-storage-functions";
      dependencyStrategy: DependencyStrategy;
      functions: FunctionPartition;
      directOrigin?: string;
    });

const optionsSchema = Schema.Struct({
  target: Schema.optional(
    Schema.Literal("object-storage", "object-storage-functions"),
  ),
  dependencyStrategy: Schema.optional(Schema.Literal("bundle", "install")),
  apiGateway: Schema.optional(Schema.Boolean),
  recursive404: Schema.optional(Schema.Boolean),
  functions: Schema.optional(Schema.Literal("shared", "separate")),
  directOrigin: Schema.optional(Schema.String),
});

/** Validates user choices once for the integration instance. */
export function decodeOptions(value: unknown): BuildPlan {
  let options: Schema.Schema.Type<typeof optionsSchema>;
  try {
    options = Schema.decodeUnknownSync(optionsSchema)(value ?? {});
  } catch {
    if (
      typeof value === "object" &&
      value !== null &&
      "target" in value &&
      !(["object-storage", "object-storage-functions"] as unknown[]).includes(
        value.target,
      )
    ) {
      throw new TypeError(
        `Unknown Yandex Cloud adapter target: ${String(value.target)}.`,
      );
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "dependencyStrategy" in value
    ) {
      throw new TypeError(
        `Unknown Yandex Cloud adapter dependency strategy: ${String(value.dependencyStrategy)}.`,
      );
    }
    throw new TypeError("Invalid Yandex Cloud adapter options.");
  }
  const target: Target = options.target ?? "object-storage";
  const routing = {
    apiGateway: options.apiGateway ?? false,
    recursive404: options.recursive404 ?? false,
  };
  if (routing.recursive404 && !routing.apiGateway)
    throw new TypeError("Recursive 404 requires the API Gateway Modifier.");
  let directOrigin: string | undefined;
  if (options.directOrigin !== undefined) {
    try {
      const origin = new URL(options.directOrigin);
      if (
        !["https:", "http:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw new Error("Not an origin");
      directOrigin = origin.origin;
    } catch {
      throw new TypeError(
        "directOrigin must be an explicit HTTP or HTTPS origin without a path, credentials, query, or fragment.",
      );
    }
    if (routing.apiGateway)
      throw new TypeError(
        "directOrigin is only available without the API Gateway Modifier.",
      );
  }
  if (target === "object-storage") {
    if (options.dependencyStrategy && options.dependencyStrategy !== "bundle")
      throw new TypeError(
        `The ${options.dependencyStrategy} dependency strategy requires the Object Storage + Cloud Functions Target.`,
      );
    if (options.functions === "separate" || directOrigin !== undefined)
      throw new TypeError(
        "Function partitioning and directOrigin require the Object Storage + Cloud Functions Target.",
      );
    return { target, ...routing };
  }
  return {
    target,
    dependencyStrategy: options.dependencyStrategy ?? "bundle",
    functions: options.functions ?? "shared",
    ...routing,
    ...(directOrigin ? { directOrigin } : {}),
  };
}
