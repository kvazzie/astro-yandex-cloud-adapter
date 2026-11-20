# Error ownership and implementation audit

The [glossary](../GLOSSARY.md) names problems encountered during
build and invocation work, including boundary validation and
domain operation outcomes. Membership in that catalogue does not
by itself make a problem a
[_Domain Error_](../GLOSSARY.md#domain-error); establish
responsibility for each concrete case.

A [_Rejection_](../GLOSSARY.md#rejection) of external
configuration occurs before valid
[_Options_](../GLOSSARY.md#options) exist. A domain operation can
report a _Domain Error_ explicitly admitted by its contract while
preserving valid state. A contradiction in data our
implementation guarantees to produce is a defect in that
implementation. Errors from application rendering and response
processing retain their original source.

An external environment can prevent a required artifact
operation, including through OS permission denial. Preserve that
source in its diagnostic; investigate missing output guaranteed
by our own producer separately. The word
[_Failure_](../GLOSSARY.md#failure) and an error wrapper do not
decide domain ownership.

Use "exception" only for the technical `throw`/`catch` mechanism.
[Detailed explanations](domain-errors.md) describe examples and
recovery. This audit records evidence and unresolved work.

The current `FunctionRequestError` conversion surrounds the
entire `invoke` operation, including the external renderer. Other
errors propagate. A class match therefore describes current
handling rather than proving an error's domain meaning.

Classify each concrete case by its input provenance and the
operation's guarantees before choosing its canonical category and
identifier. Existing names and broad wrappers still need review;
this audit does not authorise relabelling a producer defect as
unsupported user input. Category spelling and implementation
migration follow that review and
[NAMING-MAP.md](../NAMING-MAP.md).

## Typed representation

[_Unsupported Target Route Error_](../GLOSSARY.md#unsupported-target-route-error)
is implemented in
[`TargetBuild/Errors.ts`](../packages/adapter/src/TargetBuild/Errors.ts)
as `UnsupportedTargetRouteError`. Its `_tag` identifies the
error; `target` records the selected
[_Target_](../GLOSSARY.md#target), and the nonempty
`routePatterns` list records incompatible
[_On-demand Routes_](../GLOSSARY.md#on-demand-route). The message
is derived from that data.

The
[_Object Storage Target_](../GLOSSARY.md#object-storage-target)
reports the same type at preliminary route registration and
completed-output inspection. Preliminary checks exclude
prerendered and internal routes. Completed-output inspection can
establish active internal runtime requirements. An emitted
function without a known runtime route still uses the legacy
diagnostic; that evidence alone does not establish this error.

At the Astro boundary, `IntegrationHookError.cause` retains the
original error and its data. The local executor uses
`Effect.runPromiseExit` and `Cause.squash`, avoiding the
`FiberFailure` and second hook wrapper introduced by effectify's
executor. Unexpected callback errors retain their original cause
and do not become compatibility diagnostics. Options decoding
still reports a `ParseError` under the existing hook wrapper.

Other catalogue entries retain their current representations. The
remaining four established _Domain Errors_ still need separate
typed implementations. Boundary _Rejections_ and the unresolved
cases below have not been migrated.

## Catalogue responsibility review

This review accounts for all 21 entries in the earlier catalogue.
Seven are external-input _Rejections_; five describe explicit
compatibility outcomes of valid domain inputs and have canonical
names ending in `Error`. The other nine need operation or
producer evidence; one of those, the former version-conflict
entry, is withdrawn from the glossary as an established domain
problem. These are review decisions, not a type hierarchy.

| Entry                                                                                                   | Responsibility                                       | Input and promised operation                                                                                                                                             | Defect counterexample or remaining evidence                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [_Options Input Rejection_](../GLOSSARY.md#options-input-rejection)                                     | _Rejection_ at configuration decoding                | External adapter configuration is checked before valid `Options.Schema.Type` values are constructed.                                                                     | Our lifecycle or generated configuration becoming invalid is a producer defect; do not reuse this input diagnostic for it.                                                                           |
| [_Build Configuration Rejection_](../GLOSSARY.md#build-configuration-rejection)                         | _Rejection_ at build configuration acceptance        | User-provided Vite settings are checked against the selected strategy before accepting the build setup.                                                                  | An incompatible patch produced by `configureServerBuild` from accepted input violates our own guarantee.                                                                                             |
| [_Unsupported Target Route Error_](../GLOSSARY.md#unsupported-target-route-error)                       | _Domain Error_ from compatibility planning           | Valid execution requirements and a valid selected target cannot yield a serving assignment under the declared capability contract.                                       | Incorrect route classification or loss of completed-build evidence is a planner defect, not proof of incompatibility.                                                                                |
| [_Unsupported Direct Invocation Route Error_](../GLOSSARY.md#unsupported-direct-invocation-route-error) | _Domain Error_ from compatibility planning           | Valid route requirements include pages or internal endpoints, but the selected direct-invocation contract serves stateless user endpoints.                               | Missing feature evidence or a broken generated direct URL is a producer defect.                                                                                                                      |
| [_On-demand 404 Page Error_](../GLOSSARY.md#on-demand-404-page-error)                                   | _Domain Error_ from fallback planning                | A valid 404 route requires request-time execution while the selected fallback contract requires completed HTML.                                                          | Failing to retain or copy an available prerendered page is a different producer or I/O problem.                                                                                                      |
| [_Artifact Read Failure_](../GLOSSARY.md#artifact-read-failure)                                         | Required operation with an external cause            | A required output read is denied or interrupted by the environment. Preserve operation, path, phase, and cause; optional reporting has a separate warning contract.      | A file our producer promised but never emitted is a producer defect. An unreadable file is not evidence that the file was never required.                                                            |
| [_Artifact Write Failure_](../GLOSSARY.md#artifact-write-failure)                                       | Required operation with an external cause            | A required output mutation is prevented by permissions, storage, or another external filesystem condition.                                                               | Wrong generated data or a wrong destination calculated by our code is not made an environment problem by an I/O wrapper.                                                                             |
| [_Unsupported Function Module_](../GLOSSARY.md#unsupported-function-module)                             | Provenance-dependent module acceptance               | An externally emitted `.cjs` file can violate the declared ESM input contract before a usable function graph is accepted.                                                | If a supported build produces this through our own pipeline, investigate compatibility. The extension check alone does not establish a user restriction.                                             |
| [_Unresolved Runtime Import_](../GLOSSARY.md#unresolved-runtime-import)                                 | Producer postcondition or external output acceptance | A supported `bundle` build must deliver its runtime imports. Existing rejection fixtures inject JavaScript assets with package imports through `generateBundle`.         | Those fixtures do not prove that an ordinary supported source import is invalid input. Retaining such an import after promised bundling is a producer problem.                                       |
| [_Unsupported Native Dependency Error_](../GLOSSARY.md#unsupported-native-dependency-error)             | _Domain Error_ from delivery compatibility           | A valid native runtime dependency needs a delivery mechanism that the selected `bundle` strategy does not provide. The declared alternative is `install`.                | An installation or platform-loading problem under `install` is not this strategy incompatibility; preserve that operation and cause.                                                                 |
| [_Unsupported Runtime Dependency Resolution_](../GLOSSARY.md#unsupported-runtime-dependency-resolution) | Provenance-dependent graph acceptance                | Externally injected computed imports cannot be accepted as a fixed enumerable runtime graph under the current input contract.                                            | The fixtures inject script assets. A computed import emitted by an otherwise supported Astro feature needs a compatibility investigation, not an automatic input label.                              |
| [_Dependency Resolution Failure_](../GLOSSARY.md#dependency-resolution-failure)                         | Several operations currently combined                | Distinguish unavailable required installed packages, an installed version not satisfying a supplied requirement, and a registry result with no matching version.         | Suppressed metadata errors do not prove absence. Failure to locate a package that the supported resolution contract can locate is an implementation defect.                                          |
| Former `Dependency Version Conflict`                                                                    | Private graph representation limitation              | The old proposed name `Dependency Version Conflict` describes different selected exact versions rejected by the current name-keyed representation.                       | The existing regression uses overlapping requirements. It does not prove that version requirements are unsatisfiable; see the dedicated finding below.                                               |
| [_Dependency Metadata Failure_](../GLOSSARY.md#dependency-metadata-failure)                             | External I/O or metadata acceptance                  | Separate filesystem and registry access errors from malformed third-party metadata before constructing valid resolved package values.                                    | Malformed metadata generated or shipped by us is a producer defect. Broad JSON casts and swallowed read errors must not determine ownership.                                                         |
| [_Deployment Manifest Input Rejection_](../GLOSSARY.md#deployment-manifest-input-rejection)             | _Rejection_ at a public parser boundary              | An external caller supplies serialized data that cannot be accepted as a valid manifest.                                                                                 | The same check on freshly generated data detects a generation defect when our promised IDs, paths, or references are broken.                                                                         |
| [_Gateway Route Incompatibility Error_](../GLOSSARY.md#gateway-route-incompatibility-error)             | _Domain Error_ from routing compatibility            | Valid route requirements have a demonstrated grammar or winner conflict with the supported Gateway representation. Preserve the conflicting patterns or overlap witness. | Missing planner evidence, malformed internally generated patterns, or inability of our algorithm to establish a promised winner are not proof of a routing impossibility.                            |
| [_Oversized Gateway Template_](../GLOSSARY.md#oversized-gateway-template)                               | Scope to the measured output candidate               | The current formatted candidate exceeds the implemented byte budget. This is evidence about that candidate, not a proof that every faithful encoding would exceed it.    | Unnecessary duplication or missing generation evidence requires producer analysis. Do not relabel every large route plan as invalid user input or assert current cloud limits from this check alone. |
| [_Function Invocation Rejection_](../GLOSSARY.md#function-invocation-rejection)                         | _Rejection_ at request construction                  | The external event does not meet the supported invocation contract; reject it before producing a valid Web request.                                                      | A supported provider event mishandled by the bridge is a compatibility defect. Real-cloud conformance remains pending.                                                                               |
| [_Missing Request Origin Rejection_](../GLOSSARY.md#missing-request-origin-rejection)                   | _Rejection_ of incomplete reconstruction input       | The external event and consumer configuration lack the origin prerequisites for request construction.                                                                    | If our generated configuration drops an accepted origin or the bridge ignores a supported header, investigate its producer; do not blame the caller by default.                                      |
| [_Direct Request Target Rejection_](../GLOSSARY.md#direct-request-target-rejection)                     | _Rejection_ of the provider wrapper                  | The caller supplies a missing, repeated, malformed, or non-local original request target before an application request can be built.                                     | A generated wrapper or manifest advertising a different parameter from its paired handler violates a producer guarantee.                                                                             |
| [_Direct Request Origin Rejection_](../GLOSSARY.md#direct-request-origin-rejection)                     | _Rejection_ at the request trust check               | Incoming browser origin evidence does not satisfy the configured direct-request trust policy.                                                                            | Failure to retain accepted trust configuration is a producer problem. An error thrown later by the renderer does not acquire this boundary ownership.                                                |

The implementation evidence is in the
[option schemas](../packages/adapter/src/Options/index.ts),
[build settings checks](../packages/adapter/src/conditional/FunctionArtifact/BuildConfiguration.ts),
[target policies](../packages/adapter/src/TargetBuild/ObjectStorageCloudFunctionsTargetBuild.ts),
[module inspection](../packages/adapter/src/conditional/FunctionArtifact/Dependency/ImportSpecifier.ts),
[dependency resolution](../packages/adapter/src/conditional/FunctionArtifact/Dependency/index.ts),
[metadata production](../packages/adapter/src/conditional/FunctionArtifact/Dependency/Metadata.ts),
[manifest parser](../packages/adapter/src/mandatory/DeploymentManifest/index.ts),
[Gateway generator](../packages/adapter/src/conditional/ApiGatewaySpecificationTemplate/index.ts),
and
[request bridge](../packages/function-runtime-bridge/src/index.ts).

The
[injected unresolved-import fixture](../tests/fixtures/rejected-unresolved/astro.config.ts)
and
[injected computed-import fixture](../tests/fixtures/rejected-dynamic-import/astro.config.ts)
show user-supplied `generateBundle` assets, not ordinary source
imports that the bundler failed to process. Keep that distinction
when using those tests as evidence for a category.

## Dependency graph representation

`assertCompatibleVersion` rejects any second exact version for a
package name. `ResolvedRuntimeDependency` and `formatNpmLockfile`
currently address packages by name and a single
`node_modules/<name>` location. The existing
[version-conflict regression](../tests/unit/dependencies.test.ts)
installs `shared@1.0.0` under one parent and `shared@2.0.0` under
another; both parents declare `^1.0.0 || ^2.0.0`. This confirms
rejection of a multi-version installed tree, not a proof that no
common version can satisfy the requirements.

npm documents nested installs containing multiple versions of one
package in its
[installation algorithm](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-install.md).
Its
[lockfile writer](https://github.com/npm/cli/blob/latest/workspaces/arborist/lib/shrinkwrap.js)
keys package entries by relative locations. The one-version limit
is therefore a property of our present representation, not an
inherent npm lockfile restriction. This review establishes no
provider-specific requirement for a flat graph.

[ADR 0010](adr/0010-offer-bundle-and-install-dependency-strategies.md)
and the
[public install contract](../packages/adapter/README.md#function-dependencies)
promise exact dependency metadata and a deterministic lockfile;
they do not establish one version per package name. Do not add a
_Domain Error_ merely to preserve that private representation.
The next decision is how the delivery contract preserves the
resolved package graph; changing versions to solve requirements
again is a separate operation with different guarantees. A
supported tree that our promised delivery cannot preserve needs
an implementation fix or an explicit, independently justified
support decision.

## Findings

This section records ownership and diagnostic gaps found by
source inspection. It does not claim that current error classes
already separate these categories, or that each defensive check
has been reproduced by a supported application.

| Site and condition                                                                                                                                                                                                                                          | Classification and evidence                                                                                                                                                                                                                                                                  | Remaining work                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Hooks.buildDone` has no resolved configuration.                                                                                                                                                                                                            | Internal lifecycle guarantee. The current `InvalidConfiguration` name incorrectly suggests user _Options_. The adapter unit test deliberately invokes completion after reset to exercise the guard.                                                                                          | Represent the lifecycle guarantee explicitly and choose its defect-reporting contract before changing error types. ADR 0003 currently records the guard's Effect error channel, so update that decision if the contract changes.                                    |
| `generateApiGatewaySpecificationTemplate.plannedPriority` cannot find route evidence for a generated [_Manifest_](../GLOSSARY.md#deployment-manifest) route.                                                                                                | Internal consistency guarantee. Both the route plan and _Manifest_ come from the adapter's completed-build pipeline. This differs from a genuinely unrepresentable route or oversized template.                                                                                              | Keep this case out of the Gateway domain restriction catalogue; establish a producer regression case before changing handling.                                                                                                                                      |
| `wrapFunctionPolicy` finds a handler already called `__yandexArtifactHandler`.                                                                                                                                                                              | Repeated adapter wrapping violates the operation's sequencing guarantee. The same guard also covers a missing handler, whose producer needs inspection.                                                                                                                                      | Separate the meanings. Establish the provenance of a missing handler rather than classifying the entire guard together.                                                                                                                                             |
| Partitioning cannot identify a resolved route, finds conflicting module identities, cannot recognise a route map/loader, or encounters an escaping emitted module.                                                                                          | Boundary unresolved for each emitted-code condition. A supported Astro build that the adapter fails to handle indicates a compatibility defect. A user transformation outside an explicit supported contract can be a domain restriction. The error message alone establishes neither case.  | Reproduce each relevant emitted shape and identify its producer. No blanket unsupported-transformation rule is established by this audit.                                                                                                                           |
| Route reconciliation cannot match completed pages to files/routes, or finds ambiguous prerendered URLs.                                                                                                                                                     | Ownership depends on provenance. External file removal or unreadability is an environment problem; a contradiction in completed output the adapter claims to support requires a producer/compatibility investigation.                                                                        | Preserve the evidence from Astro and the filesystem; establish a fixture before assigning a narrower cause.                                                                                                                                                         |
| `validateFunctionEntrypoint` catches every `access` error; `completeBuild` uses `ok` as `hasFunction`; `reconcileRoutes` includes [_On-demand Routes_](../GLOSSARY.md#on-demand-route) only when that flag is true.                                         | Confirmed control flow can erase the difference between absence and another OS error. It can suppress required runtime evidence, so the current implementation does not establish reliable artifact error reporting here. No permission-error reproduction was performed for this catalogue. | Distinguish expected absence in a [_Static-only Build_](../GLOSSARY.md#static-only-build) from access errors and a missing required runtime entrypoint. Verify that a [_Runtime Build_](../GLOSSARY.md#runtime-build) cannot silently become a _Static-only Build_. |
| [_Dependency_](../GLOSSARY.md#dependency) lookup catches all module resolution, JSON read/parse, and access errors and returns absence.                                                                                                                     | Confirmed diagnostic gap. A missing package, unreadable metadata, and malformed metadata can become the same resolution error or cause registry fallback.                                                                                                                                    | Preserve the failed operation and cause; distinguish unusable local metadata from a genuinely unavailable _Dependency_.                                                                                                                                             |
| `InvalidManifest` wraps all of `writeDeploymentManifest`; `InvalidArtifact` wraps I/O and emitted-code transformations; `UnresolvedDependency` wraps errors from `planPackageFiles`; `applyPreparation` reports failed mutations through `InvalidArtifact`. | These types combine ownership categories. Package-file writes are now separate from dependency planning, but import inspection, metadata lookup, and resolution still share one wrapper. [_Hook_](../GLOSSARY.md#hook) wrappers add presentation context only.                               | Classify the cause at its operation boundary before changing construction or exported error types.                                                                                                                                                                  |
| `parseDeploymentManifest` checks external values and the adapter's freshly generated _Manifest_.                                                                                                                                                            | Invalid data supplied to the parser by an external caller is a _Rejection_. Broken IDs/references guaranteed by generation are defects. User-supplied configuration that produces a rejected field needs its own provenance check.                                                           | Keep input ownership visible in diagnostics and regression cases.                                                                                                                                                                                                   |
| `invoke` has an `unknown` error channel around translation, `render`, and response conversion.                                                                                                                                                              | Direct-request input validation is bridge-owned. Application rendering and response-stream errors retain their original ownership. Malformed caller events need invocation diagnostics.                                                                                                      | Preserve causes and avoid relabelling every propagated error as a _Domain Error_.                                                                                                                                                                                   |
| `readPackageInfo` cannot find valid name/version metadata for the adapter itself.                                                                                                                                                                           | Missing or malformed metadata in our complete published package violates delivery guarantees. A read error caused by the user's filesystem is an environment problem. The private utility also has a separate generic contract.                                                              | Diagnose packaging versus environment; do not describe malformed adapter metadata as invalid user _Options_.                                                                                                                                                        |

The linked tests provide existing regression entry points, rather
than proof of coverage for every row. Missing cases include
reliable entrypoint permission-error reporting, reporting-read
error recovery through _Hooks_, and the provenance-specific
emitted-code cases above. Changes to these contracts need focused
regression checks; this catalogue does not change runtime
behaviour.

## Regression entry points

Use the existing [adapter](../tests/unit/adapter.test.ts),
[_Manifest_](../tests/unit/deployment-manifest.test.ts),
[_Dependency_](../tests/unit/dependencies.test.ts),
[registry](../tests/unit/registry.test.ts),
[preparation plan](../tests/unit/function-artifact-plan.test.ts),
[runtime](../tests/unit/runtime.test.ts), and
[size report](../tests/unit/build-report.test.ts) tests for
focused checks. Artifact-affecting changes also need application
fixture builds and generated handlers as required by
[ADR 0002](adr/0002-use-astros-build-pipeline-for-runtime-artifacts.md).
The vocabulary work itself changes documentation, not runtime
error handling.
