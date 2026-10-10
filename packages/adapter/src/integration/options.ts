import * as Schema from "effect/Schema";

const HttpOriginSchema = Schema.URL.pipe(
  Schema.filter(
    (origin) =>
      ((origin.protocol === "https:" || origin.protocol === "http:") &&
        !origin.username &&
        !origin.password &&
        origin.pathname === "/" &&
        !origin.search &&
        !origin.hash) ||
      "directOrigin must be an explicit HTTP or HTTPS origin without a path, credentials, query, or fragment.",
  ),
  Schema.brand("HttpOrigin"),
);

const RoutingOptionsSchema = Schema.Union(
  Schema.Struct({
    apiGateway: Schema.Literal(true),
    recursive404: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    apiGateway: Schema.optional(Schema.Literal(false)),
    recursive404: Schema.optional(Schema.Literal(false)),
  }),
);

const TargetOptionsSchema = Schema.Union(
  Schema.Struct({
    target: Schema.optional(Schema.Literal("object-storage")),
    dependencyStrategy: Schema.optional(Schema.Literal("bundle")),
    functions: Schema.optional(Schema.Literal("shared")),
    directOrigin: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    target: Schema.Literal("object-storage-functions"),
    dependencyStrategy: Schema.optional(Schema.Literal("bundle", "install")),
    functions: Schema.optional(Schema.Literal("shared", "separate")),
    directOrigin: Schema.optional(HttpOriginSchema),
  }),
);

export const OptionsSchema = TargetOptionsSchema.pipe(
  Schema.extend(RoutingOptionsSchema),
  Schema.filter((options) =>
    options.apiGateway && options.directOrigin !== undefined
      ? {
          path: ["directOrigin"],
          message:
            "directOrigin is only available without the API Gateway Modifier.",
        }
      : true,
  ),
  Schema.brand("Options"),
);

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
  if (target === "object-storage") {
    return { target, ...routing };
  }
  return {
    target,
    dependencyStrategy: options.dependencyStrategy ?? "bundle",
    functions: options.functions ?? "shared",
    ...routing,
    ...(options.directOrigin ? { directOrigin: options.directOrigin.origin } : {}),
  };
}
