import * as Schema from "effect/Schema";

export const OptionsSchema = Schema.Struct({
  target: Schema.optional(
    Schema.Literal("object-storage", "object-storage-functions"),
  ),
  dependencyStrategy: Schema.optional(Schema.Literal("bundle", "install")),
  apiGateway: Schema.optional(Schema.Boolean),
  recursive404: Schema.optional(Schema.Boolean),
  functions: Schema.optional(Schema.Literal("shared", "separate")),
  directOrigin: Schema.optional(Schema.String),
});

export type Options = Schema.Schema.Type<typeof OptionsSchema>;

const routingFields = {
  apiGateway: Schema.Boolean,
  recursive404: Schema.Boolean,
};

export const BuildPlanSchema = Schema.Union(
  Schema.Struct({
    target: Schema.Literal("object-storage"),
    ...routingFields,
  }),
  Schema.Struct({
    target: Schema.Literal("object-storage-functions"),
    dependencyStrategy: Schema.Literal("bundle", "install"),
    functions: Schema.Literal("shared", "separate"),
    directOrigin: Schema.optional(Schema.String),
    ...routingFields,
  }),
);

export type BuildPlan = Schema.Schema.Type<typeof BuildPlanSchema>;

/** Resolves decoded options into a compatible Target-specific build plan. */
export function decodeOptionsToBuildPlan(options: Options): BuildPlan {
  const target = options.target ?? "object-storage";
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
