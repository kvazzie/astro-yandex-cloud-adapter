# Concentrate adapter build policy for [_Targets_](../../GLOSSARY.md#target) in build strategies

[ADR 0011](0011-organize-the-model-and-root-level-ports.md)
records the source grouping: root-level integration and selected
build strategy, common responsibilities in `mandatory`, and
conditional responsibilities in `conditional`. These groups do
not imply that their contents are all domain code.

The adapter provides a concrete build strategy for each supported
_Target_ at the internal `TargetBuild` seam. The contract is
declared inline in the private Effect Context tag in
`TargetBuild/.Tag.ts`. The module index exposes the contract. The
neighboring `ObjectStorageTargetBuild.ts` and
`ObjectStorageCloudFunctionsTargetBuild.ts` modules expose `make`
constructors that accept the decoded
[_options_](../../GLOSSARY.md#options) for their _Target_ and
construct values through `TargetBuild.of`. `TargetBuildLive`
reads `Options.Tag` once in `Layer.effect`, matches the
union-member schemas, and passes the selected variant to its
constructor. Strategy operations capture those _options_ and
return Effects with no remaining requirements. The layer requires
`Options.Tag`.

Constructors run when the layer is built, after the tag has been
initialized, so the selector can import both strategies without
an additional `Effect.sync` wrapper. The build-strategy module
also keeps the common output-directory layout and Astro adapter
description. Each strategy owns output layout, route
compatibility, Astro adapter description, and
[_Artifact Generation_](../../GLOSSARY.md#artifact-generation).
The `Hooks` module translates Astro lifecycle callbacks into
those operations.

Source directories follow the domain vocabulary in `GLOSSARY.md`.
`Options` owns the public input schema, decoded type, and tag.
The schemas for
[_Object Storage Target Options_](../../GLOSSARY.md#object-storage-target-options)
and
[_Object Storage + Cloud Functions Target Options_](../../GLOSSARY.md#object-storage--cloud-functions-target-options)
use those full names for their files and declarations, separating
configuration variants from build behaviour for a concrete
_Target_. Each schema module defines its default _options_ beside
the schema and validates them through that schema. Origin
validation stays in
`Options/ObjectStorageCloudFunctionsTargetOptions.ts`.
`Options/.schemaHelpers.ts` contains the shared Effect helper for
validated defaults. Default values are private implementation
details of `Options`; the module exposes the decoded effective
configuration, not default objects for callers to consume.
Defaults remain schema-validated at module initialization. The
dependency scanner receives its strategy explicitly and has no
runtime dependency on `Options`. `Hooks` implements lifecycle
callbacks and owns their build state. Nested implementation files
are private to their module; shared modules belong at their
callers' common parent instead of being exposed through
re-exports. The technical helper `.emittedModules.ts` lives at
`src/`, shared by common route inspection and function output
preparation. `ArtifactGeneration` owns the completed build, route
requirements and size reporting. `FunctionArtifact` owns
[_dependency_](../../GLOSSARY.md#dependency) resolution,
packaging and complete native output preparation.
`conditional/FunctionArtifact/Prepare.ts` also plans copies of
completed custom 404 pages into page-serving
[_Function Artifacts_](../../GLOSSARY.md#function-artifact) and
constructs their handler policies. The policy type lives in
`conditional/FunctionArtifact/.types.ts`. `Scope404` owns
[_404 Scope_](../../GLOSSARY.md#404-scope) selection and response
handling for static custom 404 pages shared by the Astro handler
and preview. `Hooks` owns the Vite runtime configuration plugin,
its virtual module declaration, and injected locals types.
Technical entrypoints `.astroHandler.ts`, `.preview.ts`, and
`.runtime.ts` live at `src/`; `.runtime.ts` preserves the public
runtime type export. The shared direct request target parameter
lives in `.constants.ts`. The separate
`@astro-yandex-cloud/function-runtime-bridge` package owns
[_Function Runtime Bridge_](../../GLOSSARY.md#function-runtime-bridge)
translation, as described in
[ADR 0008](0008-share-a-cloud-tested-function-runtime-bridge.md).
`DeploymentManifest` now forwards the public contract to the
shared `@astro-yandex-cloud/deployment-manifest` package, which
owns its schema, validation, and target encoding as described in
[ADR 0012](0012-share-the-deployment-manifest-and-target-catalogue.md).
The adapter still produces and writes the manifest, while
`conditional/ApiGatewaySpecificationTemplate/index.ts` owns the
[_API Gateway Specification Template_](../../GLOSSARY.md#api-gateway-specification-template).
The package is already the
[_Bare Adapter_](../../GLOSSARY.md#bare-adapter), so there is no
additional `integration` directory.

`Hooks` uses Effect.Service with an effect constructor that
captures TargetBuild and `Options.Tag`. Its methods return
Effects with no remaining requirements; error types are inferred
from their implementations. Setup provides decoded _options_
through `Layer.succeed(Options.Tag, options)` and supplies
TargetBuildLive to `Hooks.Default`. It builds one `Hooks`
instance per integration. The technical `.integration.ts` module
decodes the public _options_ and executes each
[_hook_](../../GLOSSARY.md#hook) through `Effect.runPromiseExit`.
It retains the existing `IntegrationHookError` representation and
preserves the original typed error in `cause` rather than nesting
it inside a `FiberFailure`. Hook Effects have no remaining
requirements. Configuration and resolved routes are fields of a
private `state` object in the `Hooks` constructor, shared across
that instance's callbacks and isolated from other integrations.
No separate state service is needed because only `Hooks` reads or
updates it. State reads and writes occur inside executing
Effects. Configuration setup resets both fields before a new
build; build completion reports missing configuration through the
Effect error channel.

`FunctionArtifact.planPreparation` reads the complete native App
and computes package metadata, validated imports, final handler
policies, required 404 copies and cleanup of unused server
output. It reads completed output and dependency metadata without
modifying artifact output.
[ADR 0013](0013-retire-separate-functions-and-use-native-astro-app.md)
retires per-route partitioning and its preview dispatcher. Build
compatibility stays in `TargetBuild`; manifest and
Gateway-template construction stay in common completion.

The preparation seam receives narrow completed-build and route
evidence plus the dependency strategy and recursive-404 setting.
It receives neither the whole integration `Options` value nor
target identity. The selected build strategy currently plans and
immediately applies the result:

```ts
Effect.gen(function* () {
  const plan = yield* FunctionArtifact.planPreparation(
    build,
    routePlan,
    {
      dependencyStrategy: options.dependencyStrategy,
      recursive404: options.recursive404,
    },
  );
  return yield* FunctionArtifact.applyPreparation(plan);
});
```

The plan contains an ordered `mutations` queue and
`plannedOutput` describing intended artifacts and route
assignments. Mutations are `writeFile`, `copyFile`, `mkdir`, or
`removeDirectory`. JS transformations and import analysis operate
on computed contents in memory, so writes contain final contents.
Copy mutations refer to unchanged source files. The complete
native App stays in its server directory; no per-route copies or
preview dispatcher are planned.

`applyPreparation` executes those mutations in order and returns
`plannedOutput` only after success. It does not choose policies
or compute transformations. Planning failure leaves artifact
output unchanged. Application stops on the first failed mutation
and preserves its cause; earlier mutations may remain. Automatic
retry, rollback, idempotence, and exactly-once execution are not
part of this contract. Existing broad error representations now
belong to `FunctionArtifact/Errors.ts`; their ownership audit
remains separate work.

The plan can be inspected or discarded for a dry run, but does
not claim that intended artifacts already exist. It lives in
memory for one preparation run and depends on its source files
remaining available until application. Cross-process persistence
and a public dry-run option are outside this change. This is
application workflow; producing commands does not make it a
domain Aggregate.

Artifact preparation uses the local filesystem directly. Tests
use temporary directories and real files; introduce a filesystem
abstraction only when a second useful implementation requires it.

Support an externally defined _Target_ through a concrete build
strategy. Extract shared behavior only after two strategies
demonstrate the need.

[_Unsupported Target Route Error_](../../GLOSSARY.md#unsupported-target-route-error)
is owned by `TargetBuild/Errors.ts`. It records the selected
_Target_ and a nonempty list of incompatible route patterns. Both
early route checks and completed-output inspection use this type
when they establish that the
[_Object Storage Target_](../../GLOSSARY.md#object-storage-target)
cannot serve runtime routes. The presence of an emitted function
alone does not establish route incompatibility and retains a
separate legacy diagnostic.
