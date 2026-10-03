import * as Schema from "effect/Schema";

// Every object in v1 accepts additive fields, including nested route entries.
const extensible = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(
    fields,
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  );

const nonEmpty = Schema.String.pipe(Schema.minLength(1));
const relativePath = nonEmpty.pipe(
  Schema.pattern(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$)).+$/),
);
const urlPath = Schema.String.pipe(
  Schema.pattern(
    /^\/(?:|(?!\.{1,2}(?:\/|$))[^/?#]+(?:\/(?!\.{1,2}(?:\/|$))[^/?#]+)*\/?)$/,
  ),
);
const basePath = Schema.String.pipe(
  Schema.pattern(
    /^\/(?:|(?!\.{1,2}(?:\/|$))[^/?#]+(?:\/(?!\.{1,2}(?:\/|$))[^/?#]+)*)$/,
  ),
);

const clientArtifact = extensible({
  id: nonEmpty,
  path: relativePath,
});
const functionArtifact = extensible({
  id: nonEmpty,
  path: relativePath,
  runtime: Schema.Literal("nodejs22"),
  entrypoint: Schema.Literal("index.handler"),
  support: extensible({
    sharp: Schema.Literal("unsupported", "experimental"),
    runtimeImageTransformation: Schema.Literal("unsupported", "experimental"),
  }),
});
const prerenderedRoute = extensible({
  kind: Schema.Literal("page", "endpoint"),
  url: urlPath,
  objectKey: relativePath,
  artifactId: nonEmpty,
});
const onDemandRoute = extensible({
  kind: Schema.Literal("page", "endpoint"),
  pattern: urlPath,
  artifactId: nonEmpty,
});
const notFoundScope = extensible({
  scope: urlPath,
  url: urlPath,
  objectKey: relativePath,
  artifactId: nonEmpty,
  functionArtifactId: Schema.optional(nonEmpty),
});

export const ManifestV1Schema = extensible({
  schemaVersion: Schema.Literal(1),
  adapter: extensible({ version: nonEmpty }),
  target: Schema.Literal("object-storage", "object-storage-functions"),
  modifiers: extensible({
    apiGateway: Schema.Boolean,
    dependencyStrategy: Schema.optional(Schema.Literal("bundle", "install")),
  }),
  base: basePath,
  assetsPrefix: Schema.optional(nonEmpty),
  artifacts: extensible({
    client: clientArtifact,
    functions: Schema.Array(functionArtifact),
  }),
  routes: extensible({
    prerendered: Schema.Array(prerenderedRoute),
    onDemand: Schema.Array(onDemandRoute),
    notFound: Schema.Array(notFoundScope),
  }),
  directInvocation: Schema.optional(
    extensible({ requestTargetParameter: nonEmpty }),
  ),
  gatewayTemplate: Schema.optional(extensible({ path: relativePath })),
});

export type DeploymentManifestV1 = Schema.Schema.Type<typeof ManifestV1Schema>;
export type PrerenderedRouteRequirement = Schema.Schema.Type<
  typeof prerenderedRoute
>;
export type OnDemandRouteRequirement = Schema.Schema.Type<typeof onDemandRoute>;
