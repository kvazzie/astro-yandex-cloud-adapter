# Categories × [_Targets_](../GLOSSARY.md#target)

[ADR 0013](adr/0013-retire-separate-functions-and-use-native-astro-app.md)
retires per-route partitioning; Function preparation now keeps
one complete native App. Historical partitioning observations
below are not authorization to reintroduce separate functions.

Categories here mean model families and module roles such as
`Options` and `TargetBuild`. The columns are concrete _Targets_.
The question is where each category has a distinct variant per
_Target_, producing compound names such as
`ObjectStorageTargetOptions` or `ObjectStorageTargetBuild`.

This document describes the current working tree. A category is
not necessarily an Aggregate, Entity, or separate source module.
The accepted layout groups scenario responsibilities under
`mandatory/` and `conditional/`, with `TargetBuild` at the source
root. These groups do not classify modules as domain or
application code.

The two implemented columns correspond to the
[_Object Storage Target_](../GLOSSARY.md#object-storage-target)
and
[_Object Storage + Cloud Functions Target_](../GLOSSARY.md#object-storage--cloud-functions-target).
Their shared enumeration and encoded representations belong to
[targets][catalogue] and [deployment-manifest][encoding]. They
identify the columns rather than another family of build
implementations.

## Categories × targets

| Category                          | `ObjectStorageTarget`                                                                 | `ObjectStorageCloudFunctionsTarget`                                                                            | Does the intersection have a separate named variant?                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Options`                         | `ObjectStorageTargetOptions`: own schema, defaults, and admitted settings.            | `ObjectStorageCloudFunctionsTargetOptions`: own schema, defaults, and admitted settings.                       | **Yes.** Two declared schema variants, composed into one `Options.Schema`.                                                                                                                             |
| `TargetBuild`                     | `make` in `TargetBuild/ObjectStorageTargetBuild.ts`, returning `TargetBuild.of(...)`. | `make` in `TargetBuild/ObjectStorageCloudFunctionsTargetBuild.ts`, returning `TargetBuild.of(...)`.            | **Yes, as implementations.** Two factories implementing the same contract. The two implementation files name their build role explicitly; the Effect Tag contract is private in `TargetBuild/.Tag.ts`. |
| `ArtifactGeneration`              | Calls the common `completeBuild` with a policy rejecting required function output.    | Calls the same `completeBuild` with a policy preparing functions when required.                                | **No separate named variants.** Variant-specific policy is supplied by the two `TargetBuild` implementations.                                                                                          |
| `ClientArtifact`                  | Static artifact described by the common manifest construction.                        | The same artifact kind, alongside any required functions.                                                      | **No.** No separate client-artifact type or preparation module per target.                                                                                                                             |
| `FunctionArtifact`                | Not produced.                                                                         | Prepared when actual on-demand requirements need it; one complete native App.                                  | **No target-indexed family.** One artifact kind with packaging and output preparation operations; absence in the first column is not another implementation.                                           |
| `ApiGatewaySpecificationTemplate` | Optional template describing static routing.                                          | Optional template also describing function routing where applicable.                                           | **No.** One generator consumes the manifest and route plan.                                                                                                                                            |
| `Scope404`                        | Shared scope computation for static fallback handling.                                | The same scope computation; function preparation also copies fallback files and applies policies where needed. | **No.** Function-specific preparation is not a second target-specific scope type.                                                                                                                      |
| `DeploymentManifest`              | Contains the selected target and actual static output.                                | The same schema also describes actual function output and applicable invocation requirements.                  | **No.** One schema and parser with consistency checks, including checks against the target value.                                                                                                      |
| `Hooks`                           | Invokes the selected `TargetBuild`.                                                   | Invokes the selected `TargetBuild`.                                                                            | **No.** One orchestrator. Its runtime configuration helper contains a target-dependent branch, not another orchestrator implementation.                                                                |

Source owners:

- [_Options_](../GLOSSARY.md#options): [common schema][options],
  [storage variant][storage-options], [functions
  variant][functions-options]. Defaults belong to these variants
  and are not an additional category axis.
- `TargetBuild`: [contract and selector][target-build], [storage
  factory][storage-build], [functions factory][functions-build].
  Astro capability declarations, server build configuration, and
  route compatibility are responsibilities inside these
  implementations, not additional categories in this matrix. The
  factories reuse [BuildConfiguration][build-configuration] and
  [RouteRequirements][routes].
- [_Artifact Generation_](../GLOSSARY.md#artifact-generation) and
  [_Client Artifact_](../GLOSSARY.md#client-artifact): [common
  completion and manifest construction][generation].
- [_Function Artifact_](../GLOSSARY.md#function-artifact):
  [preparation contract][function-artifact], with internal
  [complete output reading][partition] and [package/404
  planning][prepare].
- [_API Gateway Specification Template_](../GLOSSARY.md#api-gateway-specification-template):
  [generator][gateway].
- [_404 Scope_](../GLOSSARY.md#404-scope): [scope
  computation][scopes].
- [_Deployment Manifest_](../GLOSSARY.md#deployment-manifest):
  [shared schema][manifest-schema] and [parser][manifest].
- [_Hooks_](../GLOSSARY.md#hook): [orchestrator][hooks] and
  [runtime configuration helper][runtime-config].

## Where compound names arise

The currently implemented repeated decomposition is concentrated
in two rows, `Options` and `TargetBuild`:

| Target                              | `Options` intersection                                                                                                | `TargetBuild` intersection                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ObjectStorageTarget`               | `Options/ObjectStorageTargetOptions.ts` and its `ObjectStorageTargetOptions` declaration.                             | `TargetBuild/ObjectStorageTargetBuild.ts` and its `make` factory. This file implements the storage build strategy.                 |
| `ObjectStorageCloudFunctionsTarget` | `Options/ObjectStorageCloudFunctionsTargetOptions.ts` and its `ObjectStorageCloudFunctionsTargetOptions` declaration. | `TargetBuild/ObjectStorageCloudFunctionsTargetBuild.ts` and its `make` factory. This file implements the functions build strategy. |

These are two parallel families indexed by the same external
target values: input variants and build implementations. Their
pairing is explicit in `TargetBuildLive`, which matches each
options schema and invokes its corresponding factory. It is the
primary intersection to examine when comparing ownership by
category with ownership of build support for each external
target.

The other rows do not currently require an `ObjectStorage...`
implementation name in each cell. A target field, conditional
rule, optional operation, or different input does not by itself
create another named variant. The matrix is not a requirement to
fill every cell with a type or file.

The planned
[_Serverless Container Target_](../GLOSSARY.md#serverless-container-target)
has no enum member, input schema, or build implementation yet.
Its intersections remain unknown until its requirements are
specified. It is a candidate new column, not an implemented one.

## Candidate changes to rank

The agreed planning scope is the entire [roadmap](../ROADMAP.md),
without a calendar deadline. Assess expected recurrence across
that scope rather than changes per month or year. Maintenance is
the agreed primary work stream, ahead of capability development.
The relative recurrence of individual maintenance scenarios is
not established yet. Lifecycle/compiler compatibility, function
packaging, shared routing/404 behaviour, and input decoding and
diagnostics are all agreed to be significant comparison cases. No
different frequency weights are assigned to those four cases.

The expected set of service arrangements is bounded by the
available cloud services. Planned work includes adding the
_Serverless Container Target_ and then developing the supported
arrangements and their architecture. Adding new columns is a
bounded expansion, rather than an expectation of continual growth
in their number.

Adding or removing supported _Targets_ is expected to happen
almost never outside the planned expansion. Ease of those
operations therefore has little weight in choosing the primary
decomposition axis.

Compare structures primarily on correcting defects and preserving
compatibility in supported behaviour. Adding columns and
capabilities still matters, but is not the dominant expected work
stream.

For each scenario, identify one concrete example and evidence of
which categories would need to change together. The expected
impact below is a hypothesis from the current code, not a
commitment to the present structure.

| Scenario                                                            | Categories potentially changing together                                                                                                                         | Question to resolve                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Add another target column.                                          | `Options` and `TargetBuild`, plus the shared catalogue and codec. Extend artifact operations and `DeploymentManifest` only where the new requirements demand it. | What is the cost of these bounded additions relative to recurring changes?                |
| Extend an existing target's settings and build behaviour.           | Its `Options` variant and `TargetBuild` implementation; possibly `FunctionArtifact`, `ArtifactGeneration`, or `DeploymentManifest`.                              | Which planned changes require editing both named intersections for the same target?       |
| Change how all input variants are decoded, defaulted, or diagnosed. | `Options` across target columns, without necessarily changing `TargetBuild`.                                                                                     | How frequently do input-contract changes cut across targets?                              |
| Adapt all builds to an Astro lifecycle or compiler change.          | `Hooks`, `TargetBuild`, and shared build configuration; possibly `ArtifactGeneration`.                                                                           | Which changes affect the common contract, and which affect only concrete implementations? |
| Extend Gateway or recursive 404 behaviour.                          | Relevant `Options` variants, `ApiGatewaySpecificationTemplate`, `Scope404`, and possibly `TargetBuild`, `FunctionArtifact`, or `DeploymentManifest`.             | Do these changes usually cross target columns or remain within one?                       |
| Fix or extend complete function packaging.                          | `FunctionArtifact`, with `Options` or `TargetBuild` only if their contracts change.                                                                              | How much function work stays local without modifying the paired target variants?          |
| Evolve the manifest or add a consumer.                              | `DeploymentManifest` and its consumers; producers only if the required output changes.                                                                           | Which [roadmap](../ROADMAP.md) changes actually require new producer behaviour?           |

Compare further ownership changes against these maintenance
cases. Check whether changes tend to stay within one category
across columns, join several categories within one target, or
combine both patterns. Do not infer the preferred structure
merely from the number or length of compound names.

## Maintenance evidence

These traces describe the current implementation. They identify
where a correction can stay local and where a changed rule would
require coordinated edits; they do not predict defect rates.

| Maintenance case                       | Current locality                                                                                                                                                                                         | Changes that cross owners                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Astro lifecycle/compiler compatibility | [Hooks][hooks] handles callbacks; [adapter description][target-build] and [server build configuration][build-configuration] are shared.                                                                  | A changed `TargetBuild` operation contract reaches its concrete implementations. A callback-only correction need not do so.                                                                                                                        |
| Function packaging                     | [Preparation][prepare] and [complete output reading][partition] own dependency resolution, package/lockfile generation, and output preparation.                                                          | A changed runtime support rule may affect both capability declarations in [build configuration][build-configuration] and actual-output checks in preparation. These use different evidence, so sharing policy does not mean deleting either check. |
| Shared routing/404 behaviour           | [Route requirements][routes] calculate scopes once. Manifest construction, function preparation, and Gateway generation consume that result. [Scope selection][scopes] is shared by handler and preview. | Recognition of custom 404 routes is repeated in route projection and the functions _Target_'s on-demand-404 check. A change to that convention requires reviewing both.                                                                            |
| Input decoding and diagnostics         | [Integration entry][integration] owns common decoding and its diagnostic wrapper; [schema helpers][schema-helpers] own validated-default machinery.                                                      | Both options variants separately express the same rule that `recursive404: true` requires `apiGateway: true`, and repeat the corresponding defaults. A correction to this shared input rule must reach both variants today.                        |

The schema-to-factory pairing in `TargetBuildLive` is
composition, not a duplicate build rule. Likewise, consumers of a
shared route plan do not duplicate the rule that produced it.
Count repeated knowledge separately from references to the same
value.

Some _Target_-specific contracts also cross categories:
`directOrigin` is admitted by the [functions
options][functions-options] and projected into runtime
configuration by the [Hooks helper][runtime-config]. Grouping
only the options schema and build factory would not cover all of
that contract.

## Accepted layout and ownership

Maintenance and bug fixes dominate expected work. Adding or
removing supported targets is expected to happen almost never
outside the planned expansion. Keep input and execution as
separate contracts; the stable pairing of their variants does not
justify large per-target slices merely to remove repeated variant
names.

```text
src/
├── Options/
├── Hooks/
├── TargetBuild/
│   ├── .Tag.ts
│   ├── index.ts
│   ├── Errors.ts
│   ├── ObjectStorageTargetBuild.ts
│   └── ObjectStorageCloudFunctionsTargetBuild.ts
├── mandatory/
│   ├── ArtifactGeneration/
│   │   └── RouteRequirements/
│   └── DeploymentManifest/
└── conditional/
    ├── FunctionArtifact/
    ├── ApiGatewaySpecificationTemplate/
    └── Scope404/
```

`mandatory` and `conditional` are lowercase organizational
labels. They classify participation in build scenarios after
separating integration and scenario coordination. They have no
contracts or corresponding Entity, Aggregate, or Value Object of
their own. Shared does not mean mandatory: a conditional module
can serve several build strategies, runtime, or preview.

The existing `TargetBuild` contract has four operations for Astro
build configuration, adapter capabilities, server Vite
configuration, and artifact generation. It is a selected build
strategy combining integration, application orchestration, and
compatibility rules. Its private `.Tag.ts` contains the Effect
Tag and supporting types. External consumers use the module
index; concrete implementations use that private contract. The
index retains strategy selection and shared Astro configuration
helpers. `Errors.ts` remains the conventional error collection.

`Hooks` coordinates lifecycle stages. The functions build
implementation checks route compatibility, then calls
`FunctionArtifact.planPreparation` and `applyPreparation`. The
preparation module owns complete output reading, cleanup, 404
preparation, policy application, and preview-dispatcher creation.
Its planner reads existing output and computes an inspectable
mutation queue; its executor applies that queue in order.
`mandatory/ArtifactGeneration.completeBuild` coordinates output
inspection, route inspection, selected preparation, and writing
the completed manifest/template. These are several levels of
coordination, not a domain Aggregate.

A domain concept such as a Function Artifact does not make its
entire current preparation module domain code. Domain build and
routing rules, application workflow, and technical file/package
operations may coexist inside current modules. Their separation
requires examining contracts and actual repeated knowledge.
Neither participation frequency nor the presence of I/O or Effect
alone determines the layer.

This layout replaces the earlier `src/model/` direction in
[ADR 0011](adr/0011-organize-the-model-and-root-level-ports.md).
[ADR 0003](adr/0003-concentrate-target-policy-in-target-drivers.md)
describes the implementation. Input schemas and defaults remain
in `Options`; this change does not transfer their ownership. The
independently defined target catalogue and manifest contract
remain in their shared packages under
[ADR 0012](adr/0012-share-the-deployment-manifest-and-target-catalogue.md).
The naming rules in [NAMING-MAP.md](../NAMING-MAP.md) continue to
apply inside the organizational groups.

## Options dependency audit

Outside `Hooks`, eight adapter source files directly import
`Options`. The findings distinguish runtime configuration access
from type-only references:

| Source relative to adapter `src/`                                                                  | Dependency                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                                                                         | Supplies the input schema and decoded options; provides `Options.Tag`. Public exports include inferred configuration types, not the internal schema, tag, or defaults. |
| `TargetBuild/index.ts`                                                                             | Reads `Options.Tag` and selects a build implementation using the concrete schemas.                                                                                     |
| `TargetBuild/ObjectStorageTargetBuild.ts`, `TargetBuild/ObjectStorageCloudFunctionsTargetBuild.ts` | Receive a decoded variant, use its settings, and construct configuration errors from the options error collection.                                                     |
| `TargetBuild/.Tag.ts`, `TargetBuild/Errors.ts`                                                     | Type-only references to target selection and configuration errors.                                                                                                     |
| `mandatory/ArtifactGeneration/index.ts`                                                            | Type-only reference to the target-selection alias.                                                                                                                     |
| `conditional/FunctionArtifact/BuildConfiguration.ts`                                               | Type-only reference to `DependencyStrategy`.                                                                                                                           |

The preparation seam now accepts narrow build facts and explicit
settings. Neither output preparation nor the dependency scanner
imports `Options`. `findRuntimePackageImports` analyses planned
file contents and requires the chosen strategy; both bundle and
install preparation pass it explicitly. Defaults remain private
and schema-validated within `Options`, and are applied at input
decoding. No default objects are exported. Ownership of the
remaining type-only references is a separate design question.

No other workspace package imports the adapter's internal
`Options`. Four tests import that internal module directly:
`tests/unit/adapter.test.ts`,
`tests/unit/deployment-manifest.test.ts`,
`tests/integration/build.test.ts`, and
`tests/unit/function-artifact-plan.test.ts`, which checks default
privacy. Packed-consumer checks use the public `EncodedOptions`
type. These findings do not imply that every options dependency
should be removed: integration entry and strategy selection need
configuration access.

[catalogue]: ../packages/targets/src/index.ts
[encoding]:
  ../packages/deployment-manifest/src/.targetEncoding.ts
[storage-options]:
  ../packages/adapter/src/Options/ObjectStorageTargetOptions.ts
[functions-options]:
  ../packages/adapter/src/Options/ObjectStorageCloudFunctionsTargetOptions.ts
[options]: ../packages/adapter/src/Options/index.ts
[integration]: ../packages/adapter/src/.integration.ts
[schema-helpers]:
  ../packages/adapter/src/Options/.schemaHelpers.ts
[storage-build]:
  ../packages/adapter/src/TargetBuild/ObjectStorageTargetBuild.ts
[functions-build]:
  ../packages/adapter/src/TargetBuild/ObjectStorageCloudFunctionsTargetBuild.ts
[target-build]: ../packages/adapter/src/TargetBuild/index.ts
[build-configuration]:
  ../packages/adapter/src/conditional/FunctionArtifact/BuildConfiguration.ts
[routes]:
  ../packages/adapter/src/mandatory/ArtifactGeneration/RouteRequirements/index.ts
[generation]:
  ../packages/adapter/src/mandatory/ArtifactGeneration/index.ts
[partition]:
  ../packages/adapter/src/conditional/FunctionArtifact/.output.ts
[function-artifact]:
  ../packages/adapter/src/conditional/FunctionArtifact/index.ts
[prepare]:
  ../packages/adapter/src/conditional/FunctionArtifact/Prepare.ts
[scopes]: ../packages/adapter/src/conditional/Scope404/index.ts
[gateway]:
  ../packages/adapter/src/conditional/ApiGatewaySpecificationTemplate/index.ts
[runtime-config]: ../packages/adapter/src/Hooks/.runtimeConfig.ts
[manifest-schema]:
  ../packages/deployment-manifest/src/DeploymentManifest/Schema.ts
[manifest]:
  ../packages/deployment-manifest/src/DeploymentManifest/index.ts
[hooks]: ../packages/adapter/src/Hooks/index.ts
