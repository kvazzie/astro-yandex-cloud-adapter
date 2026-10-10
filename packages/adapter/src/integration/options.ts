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
    recursive404: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  }),
  Schema.Struct({
    apiGateway: Schema.optionalWith(Schema.Literal(false), {
      default: () => false,
    }),
    recursive404: Schema.optionalWith(Schema.Literal(false), {
      default: () => false,
    }),
  }),
);

const TargetOptionsSchema = Schema.Union(
  Schema.Struct({
    target: Schema.optionalWith(Schema.Literal("object-storage"), {
      default: () => "object-storage",
    }),
    dependencyStrategy: Schema.optionalWith(Schema.Literal("bundle"), {
      default: () => "bundle",
    }),
    functions: Schema.optionalWith(Schema.Literal("shared"), {
      default: () => "shared",
    }),
    directOrigin: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    target: Schema.Literal("object-storage-functions"),
    dependencyStrategy: Schema.optionalWith(Schema.Literal("bundle", "install"), {
      default: () => "bundle",
    }),
    functions: Schema.optionalWith(Schema.Literal("shared", "separate"), {
      default: () => "shared",
    }),
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

/** Maps validated, defaulted options into a compatible Target-specific build plan. */
export function decodeOptionsToBuildPlan(options: Options): BuildPlan {
  const routing = {
    apiGateway: options.apiGateway,
    recursive404: options.recursive404,
  };
  return options.target === "object-storage"
    ? { target: options.target, ...routing }
    : {
        target: options.target,
        dependencyStrategy: options.dependencyStrategy,
        functions: options.functions,
        ...routing,
        ...(options.directOrigin
          ? { directOrigin: options.directOrigin.origin }
          : {}),
      };
}
