# Interpreting Astro compiler output

Conditional design/research draft, 2026-11-10. Production source
is unchanged. The inspected base is
`84584c8d9afe5780a8c9fee23f44d13b5a5f1425`, the merge commit of
[PR #96](https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/96)
into `feat/complete-beta-routing`. The research branch is
`research/astro-output-interface`; its PR targets that working
branch.

## Dependency gate and authority

This document inventories current behavior and compares proposed
interfaces. It does **not** approve a compiler-output interface
or a rewrite/error policy. The dependent contract investigation
must supply its report, evidence, checked SHA, and open
questions; the originating conversation must then record explicit
user decisions on those questions. A report arriving is not
policy acceptance.

Gate checkpoint: **final contract artifacts received and read;
policy gate open**. The source is
[research PR #98](https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/98),
head `ca8aa36ebd100896efc01838917731fd50ca8473`, researched
against the same production base SHA. Its report, JSON and recipe
match that commit byte for byte; their hashes below identify the
evidence read. The PR is open and was not merged or copied into
this branch. The originating conversation's latest checked
instruction authorizes automatic transfer, not a new runtime
policy. This remains a reviewable conditional draft, not a final
implementation handoff.

Decisions reserved for the originating conversation:

1. Choose compatible transition closure/dispatch, an explicit
   build restriction, or explicit runtime refusal for cross-route
   rewrites in `separate`. The existing unannounced compatibility
   gap is a confirmed defect; choosing its remedy is separate
   from acknowledging that defect.
2. Preserve Astro's actual error outcome or explicitly amend it
   to a stricter status rule. Decide error-loader delivery
   independently of ordinary rewrite permission. A reference
   rest-owned 200 after a throw is not automatically an adapter
   defect or an instruction to produce 500.
3. If a transition is refused/unmatched, decide original versus
   target pathname for 404 scope, body/status and middleware
   effects. Keep rejected invocation Promises, returned HTTP
   responses and preview's catch distinct unless a new mapping is
   explicitly chosen.
4. Agree the private compiler/runtime seam and supported-version
   proof obligations, choose the design, then authorize an
   implementation slice. The interpreter must not silently expand
   selected sets, redirect requests, translate failures or reduce
   compatibility to 7.1.6.

The predecessor experiments are evidence, not the production
contract:

- [Native pipeline investigation](native-build-pipeline.md):
  final output is available later than native `generateBundle`;
  its proposed route/component parser removal has since shipped
  in #91.
- [Selected App isolation](native-app-isolation.md), its
  [recipe](native-app-isolation-recipe.md) and
  [results](native-app-isolation-results.json): constrained 7.1.6
  closures work; loader absence alone does not enforce request
  isolation.
- [Loader expansion](native-app-loader-expansion.md), its
  [recipe](native-app-loader-expansion-recipe.md) and
  [results](native-app-loader-expansion-results.json): classic
  middleware and generic renderer acquisition use private virtual
  modules; selected 7.4.8 directories retain foreign code through
  the ambient global manifest import. Initial-request guards also
  fail to enforce the experiment's transition policy. Successful
  responses from rejected closures are not isolation proof.

No selected-App reconstruction is adopted. No second application
bundler is introduced. The declared Astro range remains `^7.1.0`,
with Node `>=22.12.0`; a 7.1.6-only design cannot discharge that
contract. See
[package metadata](../../packages/adapter/package.json),
[README](../../README.md), and
[ADR 0002](../adr/0002-use-astros-build-pipeline-for-runtime-artifacts.md).
The experiments already falsify the simple native-reconstruction
migration; repeating their minimal cases would add no new
evidence here.

## Contract evidence incorporated

The delivered artifacts are the
[contract report](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/ca8aa36ebd100896efc01838917731fd50ca8473/docs/research/rewrite-error-contract.md),
[JSON evidence](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/ca8aa36ebd100896efc01838917731fd50ca8473/docs/research/rewrite-error-contract-results.json)
and
[extractable recipe](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/ca8aa36ebd100896efc01838917731fd50ca8473/docs/research/rewrite-error-contract-recipe.md).
At the checked research head their SHA-256 values are:

| Artifact        | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| Report          | `53f90d7285c39ab537450dc6857760ad8c521742d0fe554530adad99e092c632` |
| JSON            | `ddaa740d927c0f9cda595c1ef20565255d4b53ddd2c7adf5543178ff72f1549f` |
| Recipe document | `fe7851950ccbc8d480dd39ae3b80af8f49bfc8515165176b5578f687390b2522` |

A disposable read-only evidence check verified **36 successful
native builds, 780 fresh-process observations and 168 preview
HTTP requests**, and matched the extracted recipe source to
recorded SHA-256
`014cc11a4ed8ed905e535f2581408c41dc0df7cb7e0b1921e9ca214274302d64`.
The study ran Astro 7.1.6 and 7.4.8 on Node 26.13.0, with real
public-adapter shared/separate output and a full standard
reference App. `toolchainAudit` establishes the compiler actually
resolved Vite **8.3.6** / Rolldown **1.2.16**; top-level Vite
8.3.7 / Rolldown 1.2.18 in those environments are different
resolution facts. The final report also records a fresh
frozen-environment reproduction matching all recorded
response/error/ call/load and preview tuples. This design did not
rerun those experiments. R1–R4 below were checked directly in the
delivered JSON for both versions, not inferred from #96.

| Case                                                                  | Reference / production shared                                        | Production separate                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| R1: endpoint rewrites to another endpoint, no rest/custom errors      | 200, target body                                                     | Empty HTTP 500; target does not execute                                                       |
| R4: middleware rewrites to another endpoint with a rest route present | 200, target executes; initial endpoint may load but does not execute | Rejected Promise; missing rest error loader; neither endpoint executes                        |
| R2: selected endpoint throws with a rest route present                | 200 `REST_ONLY`, original pathname                                   | Rejected Promise; missing `/[...rest]` loader                                                 |
| R3: selected page throws with custom `/500`                           | 500 `CUSTOM500`, original pathname                                   | Rejected Promise; missing `/500` loader; directly invoking the separate `/500` artifact works |

The study separately records working self-rewrites and initial
foreign specific/rest guard 404. Preview converts a rejected
handler Promise into HTTP 500 `Internal Server Error`; that is
not a production handler response. An error-loader rejection can
obscure the earlier missing rewrite target.

[Issue #70](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/70)
requires necessary code/dependencies and representative
shared/separate Astro response equivalence. Its body was read
directly. The
[existing response contract](../domain-errors.md#application-and-response-errors)
preserves the actual Astro/application response and original
error ownership. Accordingly D1 (lost accepted rewrite target)
and D2 (lost error dependency) are production compatibility
defects, not new external-input restrictions. The full-App
rest-owned 200 itself is not the defect. No universal
throw-to-500 policy follows from the prior experiment.

The inventories prove fixture-marker observations, not arbitrary
file closure or deployed security. Original source/dependency
paths remain available in these production experiments.
Conversely #96's selected-App 7.4.8 closure rejection concerns a
different graph; it does not establish failure of production
marker exclusion. Neither result authorizes native
reconstruction. The reference harness does not serve static
client 404 bodies, so the adapter's retained custom 404 HTML is
not a parity defect. Base-prefixed rewrites also differ between
the two Astro versions; no slash-policy generalization follows.

Consequences shared by A/B/C:

```text
initial selected route ≠ complete accepted execution dependency set
ordinary rewrite target ≠ error fallback dependency
file inventory / marker exclusion ≠ permitted-transition policy
```

| Conditional user choice                  | Required design consequence, not an adopted implementation                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compatible execution closure or dispatch | Preparation must specify required transition/error loaders and files, or supply a separately designed runtime dispatch mechanism. A/B component sets can represent a chosen closure, but cannot infer arbitrary dynamic rewrites. C's single-component `ForRoute` would need revision. |
| Explicit build restriction               | Compatibility/diagnostic owners must define and enforce the admitted arrangement before apply; compiler recognition cannot promote missing loaders to a domain rule. Dynamic targets prevent assuming static enumeration is complete.                                                  |
| Explicit runtime refusal                 | Runtime transition handling must implement the agreed status/body/scope semantics. An output interpreter and the existing initial guard cannot enforce this by pruning files. Error-loader delivery is still a separate decision.                                                      |

The first read-only refactor can preserve current observations
without fixing D1/D2. It must explicitly retain those defects as
separate work; no new selection or behavior guarantee is claimed.
The full `selectFiles` interface remains a mechanical file
operation until user-approved execution requirements give
preparation a complete input contract.

## Current callers and knowledge

Paths in this table are relative to `packages/adapter/src/`.
These are source-inspection findings at the base SHA, not new
runtime experiment results.

| Owner / source                                                                                                                                                                                               | Knowledge used today                                                                                       | Responsibility to preserve                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`Hooks/index.ts`](../../packages/adapter/src/Hooks/index.ts)                                                                                                                                                | Resolved routes, structured `manifest.routes[].routeData` identities, completed pages/assets               | Per-integration lifecycle state; reset on setup; conflicting component identities fail. No emitted `deserializeManifest` parser remains.                             |
| [`TargetBuild`](../../packages/adapter/src/TargetBuild/index.ts), its two factories                                                                                                                          | Build directories, capabilities, Vite configuration, selected settings, route compatibility                | Select the build scenario and prepare callback. Early registered-route and completed-output checks use different evidence.                                           |
| [`ArtifactGeneration/index.ts`](../../packages/adapter/src/mandatory/ArtifactGeneration/index.ts)                                                                                                            | `index.js` existence, final client files/HTML, actual pages/assets; `serverIslandMap` convention           | Inspect evidence, reconcile routes, call selected preparation, write the resulting manifest and optional Gateway template.                                           |
| [`RuntimeImageRoutes.ts`](../../packages/adapter/src/mandatory/ArtifactGeneration/RuntimeImageRoutes.ts)                                                                                                     | `pageMap` / `serverIslandMap`, loader identifiers or inline loaders, fixed local imports, `getImage` calls | Image-demand evidence for selected non-prerendered roots, including Actions; registered image endpoints alone do not prove use.                                      |
| [`Partition/index.ts`](../../packages/adapter/src/conditional/FunctionArtifact/Partition/index.ts)                                                                                                           | Page/island map shapes, loader declarations, ESM and URL edges, handler export alias                       | Retain full route metadata for precedence while pruning loader code; derive selected files. Also currently assigns artifact IDs, placement and routes.               |
| [`.emittedModules.ts`](../../packages/adapter/src/conditional/FunctionArtifact/.emittedModules.ts)                                                                                                           | Acorn ESM parsing, syntax traversal, fixed local import/export/dynamic-import and `new URL` edges          | Shared technical implementation; it does not hide loader-map meaning from callers.                                                                                   |
| [`Prepare.ts`](../../packages/adapter/src/conditional/FunctionArtifact/Prepare.ts), [`Dependency/ImportSpecifier.ts`](../../packages/adapter/src/conditional/FunctionArtifact/Dependency/ImportSpecifier.ts) | Entry existence; computed JS contents; bare/native/CommonJS/computed imports; Astro logger exception       | Package-strategy validation, exact metadata/lockfile and 404 copy/policy planning. The logger recognizer is a compiler dependency inside this policy implementation. |
| [`.plan.ts`](../../packages/adapter/src/conditional/FunctionArtifact/.plan.ts)                                                                                                                               | Selected files plus settings, scopes and dependency metadata                                               | Compose the ordered mutation queue, bind the existing handler policy, clean unused output and create preview dispatch.                                               |
| [`.applyMutations.ts`](../../packages/adapter/src/conditional/FunctionArtifact/.applyMutations.ts)                                                                                                           | Existing mutation kinds and their order                                                                    | Apply sequentially, stop on first error, return planned output only after success.                                                                                   |

Current call tree, simplified:

```text
Hooks.buildSsr → per-build routeComponents
Hooks.buildDone → TargetBuild.generateArtifacts → completeBuild
  validateFunctionEntrypoint
  inspectRoutes
    final client files / HTML
    hasServerIslandEntries → emitted AST
    hasRuntimeImageCalls → loader maps / reachable modules / calls
    reconcileRoutes → one RoutePlan
  TargetBuild.prepareArtifacts → planPreparation
    planPartitions → loader pruning / local closure + artifact assignment
    planPackageFiles → import validation / registry / metadata
    planNotFoundArtifacts → existing handler policy / copy plan
    wrapFunctionPolicy → export alias AST edit
    cleanup / preview queue
  applyPreparation → ordered filesystem mutations
  writeDeploymentManifest → manifest + optional Gateway template
```

The genuine repeated convention is recognition of `pageMap` and
`serverIslandMap`, optional `$n` suffixes, map-entry arrays, and
loader declarations. Island presence, image reachability and file
selection ask different questions of that representation. A new
convention currently needs review in three consumers. Their
accepted shapes are not identical: image inspection accepts
inline loaders; page pruning requires a named loader with a
function initializer. Sharing recognition must preserve those
differences until a deliberate compatibility change is
authorized.

References to one `RoutePlan`, scope table, or `routeComponents`
map do not duplicate the rule producing it. The two AST visitors
also differ: dependency inspection tracks ancestors for the
logger exception. Moving generic helpers into a common folder
would leave the compiler rules in the callers and would not pass
the deletion test.

## Responsibility and dependency constraints

[_Target_](../../GLOSSARY.md#target) compatibility remains in
`TargetBuild`; [_Options_](../../GLOSSARY.md#options)
decoding/defaults remain in `Options`.
[_Artifact Generation_](../../GLOSSARY.md#artifact-generation)
retains completed client evidence, route reconciliation and
common completion.
[_Function Artifact_](../../GLOSSARY.md#function-artifact)
preparation retains partition assignments, package strategy,
dependency resolution, static 404 copies, handler-policy values
and preview dispatch. [_404 Scope_](../../GLOSSARY.md#404-scope)
selection remains shared by handler and preview. The
[_Deployment Manifest_](../../GLOSSARY.md#deployment-manifest)
schema stays in its shared package; producer writes remain in the
adapter. These constraints follow
[ADR 0003](../adr/0003-concentrate-target-policy-in-target-drivers.md),
[0011](../adr/0011-organize-the-model-and-root-level-ports.md),
[0012](../adr/0012-share-the-deployment-manifest-and-target-catalogue.md),
and the [maintenance matrix](../target-change-matrix.md).

| Dependency                                             | Category and strategy                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AST, fixed graph computation, route-component mappings | In-process; keep behind the compiler module's interface. Do not export AST nodes for callers to interpret.                                                         |
| Final emitted files and completed HTML                 | Local filesystem I/O, exercised through existing real temporary-directory fixtures. No second useful filesystem implementation justifies a new port.               |
| Astro emitted representation                           | Version-sensitive upstream format; public hooks supply identities, not a stable selected-loader compiler contract. Validate with actual supported-version builds.  |
| Existing dependency registry                           | True external dependency with an existing injected registry interface; remains with package preparation. Compiler interpretation needs no registry/network access. |
| Lifecycle state                                        | Owned by one `Hooks` instance. No global cache, hidden build, or new state service.                                                                                |

All alternatives use final output after `astro:build:done`; an
earlier native chunk snapshot is insufficient. Analysis must not
import or execute the application. Reading and planning do not
mutate output. A plan can contain computed JS text and deferred
copies of unchanged assets; it is not an atomic filesystem
snapshot. Source files must remain available until application.
Required copies precede removal of their source server directory;
preview creation follows that removal. Earlier successful writes
may remain after an apply failure. No rollback, retry,
idempotence, exactly-once, or cross-process guarantee is added.

Existing broad `InvalidArtifact` / `UnresolvedDependency`
wrappers are evidence of current error transport, not a fresh
domain classification. Missing supported compiler output must not
become a new user-input restriction merely to fit a private
recognizer. Preserve causes and operation/path context; use the
[error model](../domain-errors.md) and
[implementation audit](../domain-error-audit.md) before changing
categories.

## Alternatives and selection

Three fresh-context agents received the same base, source paths,
glossary, dependency categories and constraints, with different
design goals: minimum interface, extensibility, and
default-caller convenience. They inspected primary sources
independently. The sketches below are a synthesis of their
conditional candidates, not compiled declarations or approved
changes. Their names are illustrative technical names under the
common `src/` parent, following `NAMING-MAP.md`; none introduces
a domain Output Value Object.

### A. Three explicit operations

The minimum-interface candidate places the seam at
`src/.AstroOutput/index.ts`. `EmittedFile` below is the existing
`PlannedFile` structure, not a new value model.
`HandlerArguments` denotes the existing serializable subset of
`FunctionArtifactPolicy` without `artifactDirectory`.

```ts
// Proposed sketch; types abbreviate existing structural records.
type Selection = "all" | {
  components: readonly string[];
  serverIslands: "all" | "none";
};
type ImportFact = { path: string } & (
  | { kind: "fixed"; specifier: string }
  | { kind: "computed"; compilerRole: "logger-destination" | undefined }
);

inspect({ directory, runtimeComponents }): Promise<{
  hasFunction: boolean; hasServerIslands: boolean; hasRuntimeImages: boolean;
}>;
selectFiles({ directory, loaders: Selection }): Promise<{
  files: readonly EmittedFile[]; imports: readonly ImportFact[];
}>;
bindHandler(files: readonly EmittedFile[], args: HandlerArguments): readonly EmittedFile[];
```

Caller sketch:

```ts
// ArtifactGeneration keeps route eligibility + completed client evidence.
const facts = await AstroOutput.inspect({
  directory: server,
  runtimeComponents,
});
const routePlan = reconcileRoutes({
  ...completedClientEvidence,
  ...facts,
});

// Partition keeps identities, base handling, assignments and loader selection.
const selected = await AstroOutput.selectFiles({
  directory: server,
  loaders,
});
// Preparation retains strategy validation, registry and exact metadata.
const packageFiles = await planPackages(
  selected,
  explicitStrategy,
  appRoot,
  registry,
);
const finalFiles = hasPolicy
  ? AstroOutput.bindHandler(selected.files, policy)
  : selected.files;
// Existing preparation owns destinations, copies, cleanup, preview and queue.
```

Hidden implementation: entry/file conventions, map recognition
and declaration resolution, island/image evidence, loader pruning
in entry or chunks, fixed graph traversal and containment,
import-expression evidence, the Astro logger recognizer, and
handler export discovery/editing. `ImportFact` identifies syntax
evidence; package validation decides whether the existing logger
exemption applies and owns strategy diagnostics. It is the
thinnest part of this interface, not a mandate to build a general
compiler intermediate form.

`"all"` means all emitted files as shared preparation does today,
including unreachable non-JS files. It cannot mean a graph walk
over all page components. Explicit selection preserves all
routing metadata and changes loaders, not transition policy.
Empty components with islands retained represents the current
island-endpoint operation; it does not mean an empty artifact.

Order and errors: inspect final output; stage all route
selections; validate packages; bind supplied policy only when
needed; assemble/apply the existing queue. `inspect` must
preserve absent-entry handling, including the current
access-error ambiguity, rather than silently reclassifying it.
`bindHandler` has no I/O; read operations do real filesystem I/O.
No AST, destination, registry, whole `AstroConfig`, or settings
object crosses the compiler seam. Repeated read/parse work across
calls is a cost; no shared-session lifetime or performance
improvement is promised.

An eager `imports` result can change first-error precedence: the
scanner today rejects `.node`/`.cjs` files before parsing
imports. Likewise, combining entry and demand inspection can
reorder failures relative to final client reads. These are
unresolved interface obligations. Keep import-fact extraction out
of the first slice; preserve existing phases or revise this
candidate before implementation. Moving the logger exception
later is preferable to pretending all compiler knowledge has
already disappeared from preparation.

### B. Indexed, composable output

The extensibility candidate captures final JS text/inventory once
and exposes independent queries and file projections. Normalize
its illustrative module spelling to `src/.AstroOutput/` under the
repository's technical naming rule.

```ts
// Proposed sketch; referenced non-JS assets are still deferred copies.
type FileSelection = { kind: "complete" } | {
  kind: "selected";
  components: readonly string[];
  serverIslands: "retain" | "omit";
};
type IndexedFile = { path: string } & (
  | { contents: string; sourceHref?: string }
  | { sourceHref: string; contents?: never }
);
interface AstroOutputIndex {
  facts(input: { runtimeComponents: readonly string[] }): Readonly<{
    hasServerIslandEntries: boolean; hasRuntimeImageCalls: boolean;
  }>;
  files(selection: FileSelection): readonly IndexedFile[];
}
readAstroOutput(serverDirectory: URL): Promise<AstroOutputIndex>;
```

Caller sketch:

```ts
const output = entry.ok
  ? await readAstroOutput(server)
  : undefined;
const facts = output?.facts({ runtimeComponents });
const routePlan = reconcileRoutes({
  ...completedClientEvidence,
  ...facts,
});
// Additional technical argument through the existing prepare callback/planner.
const prepared = await selectedPreparation(
  build,
  routePlan,
  entry.ok,
  output,
);
// Inside Partition: assignment still precedes projection.
const files = output
  .files(existingExplicitSelection)
  .map(toExistingPlannedFile);
// Existing packages, 404 policy, binding, queue and application follow.
```

The implementation hides declaration indexes, original source
offsets, loader tables, image-call traversal and projected
graphs. Selection B always starts from original captured source,
never from selection A's edited text. Queries can occur in either
order and do no further I/O. Returned href strings avoid exposing
mutable stored URLs; one preparation adapter converts them to the
current `PlannedFile` shape. Private memoization may derive
syntax lazily, but must not reread files after output mutation
begins. Duplicate component IDs are a set; sibling projections
cannot mutate each other.

Its leverage is reusing the same captured compiler evidence for
demand, complete shared inventory and multiple separate
projections. Costs include memory for original and projected JS,
index lifetime, source availability for non-JS copies, and
plumbing a technical argument through
`BuildCompletionPolicy.prepareArtifacts`, `planPreparation` and
`planPartitions`. The existing
`TargetBuild.generateArtifacts(build)` contract need not change.
Original bytes are stable within the index, but construction is
not an atomic filesystem snapshot.

Inventory and JS reads now happen at construction; query
parse/selection failures happen on evaluation. Eager reading can
expose an unrelated unreadable file before the old
demand-specific code would reach it. Laziness cannot erase that
I/O-order change. Neither the current handler binder nor the
Astro logger exception is hidden by this index alone. An optional
import-evidence query on final planned contents could address the
latter, at the same diagnostic-order and vocabulary costs as A.
No open AST visitor/plugin surface or per-version implementation
hierarchy is justified. Its test surface also includes repeatable
queries, selection independence and source lifetime.

### C. Compiler workflow around a caller callback

The caller-oriented candidate places the seam at
`src/.AstroPreparation/index.ts`. The options default is
`shared`/`bundle`; this is a default-based optimization, not a
measured caller-frequency claim.

```ts
// Proposed sketch; absent forRoute means all emitted files, not a new default option.
type ForRoute =
  | { pageComponent: string; serverIslands: "remove" }
  | { pageComponent?: never; serverIslands: "retain" };

planAstroFunction<T>(
  server: URL,
  finish: (files: readonly EmittedFile[]) => Promise<{
    value: T; handlerArgument?: object;
  }>,
  forRoute?: ForRoute,
): Promise<{ files: readonly EmittedFile[]; value: T }>;

observeAstroRuntime(server: URL, runtimeComponents: ReadonlySet<string>): Promise<{
  hasServerIslands: boolean; hasRuntimeImages: boolean;
}>;
```

Default caller sketch:

```ts
const planned = await planAstroFunction(
  server,
  async (files) => ({
    value: await planPackageFiles(
      files,
      strategy,
      appRoot,
      registry,
    ),
    handlerArgument: existingPolicy, // preparation chooses this value
  }),
);
queueExistingWrites(
  planned.files,
  planned.value,
  existing404Copies,
);
```

Separate preparation supplies one `ForRoute` per existing
assigned artifact; no runtime routes means no callback and the
existing deferred cleanup plan. `ArtifactGeneration` calls
`observeAstroRuntime`, then reconciles its own completed client
evidence. Both operations share a private loader decoder.

The implementation hides selection, reads, graph edits and
subsequent handler binding. The callback keeps packages,
metadata, 404 decisions and registry access with preparation. No
graph object or decoder/binder choreography is visible to the
default caller. Successful selection invokes `finish` exactly
once; failed reads/parses invoke it zero times; callback
rejection propagates without a partial result. Input/output file
records remain read-only, with JS contents before binding at
callback time and bound contents at return time. The compiler
operation itself writes no files, but a caller callback can do
external reads. Tests must cover callback order and error
propagation in addition to files and actual handlers.

Costs: control flow crosses the seam twice; opaque `object` loses
policy-shape checking at the technical interface and needs a
serializability contract. The per-route callback loop also
interleaves packages with compiler selection, where today's
`planPartitions` completes selection for **all** routes first. A
first route's registry lookup could run before a second route's
compiler failure. This candidate needs all-route staging or
explicit acceptance of that changed ordering. It leaves the
logger convention in the dependency scanner. Two entry points
alone do not make that extra workflow knowledge disappear.

### Before/after ownership

```text
Before: ArtifactGeneration ── island AST
        RuntimeImageRoutes ─ maps / declarations / image graph
        Partition ────────── maps / edits / closure / export binding + assignments
        Dependency ───────── import syntax / logger grammar + package rules

A: src/.AstroOutput ─ inspect / selectFiles / bindHandler
B: src/.AstroOutput ─ indexed query / selection workflow [conditional]
C: src/.AstroPreparation ─ observe / select → caller callback → binding

All: Hooks lifecycle; TargetBuild compatibility; route reconciliation;
     Partition assignments; preparation packages / 404 / queue;
     executor writes; common manifest / Gateway completion stay with owners.
```

### Comparison and conditional recommendation

| Criterion                         | A: explicit operations                                                                                                  | B: reusable index                                                                                                        | C: callback workflow                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Depth / leverage                  | Each caller asks for an outcome: demand, selected files, supplied argument binding. Compiler grammar stays private.     | Demand and many independent projections reuse captured evidence; most useful when repeated reads are a measured problem. | Shared default asks once and supplies caller-owned finishing work; least choreography for that caller.             |
| Locality                          | Loader/image/binding implementation concentrates; import facts can also remove logger grammar, subject to order review. | Loader/image/projection implementation concentrates; binder/logger remain explicit residuals.                            | Common decoder serves observations and compiler planning; binder is hidden, logger remains outside.                |
| Dependencies and seam cost        | URLs/component identities/file records; repeated reads; no new build-local handle to pass.                              | Add a handle through completion/preparation; retain JS memory and referenced-asset lifetime; no new settings.            | Callback crosses into package/registry work; serialization and exception propagation become interface obligations. |
| Test surface beyond actual builds | Read facts, selected file bytes, binding and preserved phase order.                                                     | Those projections plus independent/repeated queries, captured-source consistency and lifetime.                           | Callback count/order/rejection plus files, binding and all-route staging.                                          |
| Observable ordering risk          | Eager import facts or merged entry/demand inspection can reorder failures.                                              | Eager inventory/reads move failures earlier.                                                                             | Per-route callback interleaves registry reads with later route selection failures.                                 |
| Deletion test                     | Existing inspection, selection and binding callers regain compiler rules.                                               | Inspection and N file projections regain tables/graph logic; handle plumbing alone would disappear.                      | Observation and preparation regain selection/binding choreography; callbacks alone are no evidence of depth.       |

**Conditional preference: A, introduced as one read-only
operation first.** It fits the current owners without a new
handle propagated across orchestration or a callback controlling
package work. It hides concrete compiler knowledge for existing
consumers rather than anticipating new _Targets_. B is credible
if measured repeated reads justify its lifetime/plumbing cost; no
such measurement exists here. C simplifies the default but
creates ordering and typing obligations that are unnecessary for
this first improvement.

This is a recommendation for the originating conversation, not
approval of A's full sketch. In particular, eager import facts
and combined entry validation are not accepted as
behavior-preserving. Keep the existing handler binder and
dependency scanner until their own migrations have a demonstrated
payoff and preserved error phases. A future binding facade has
separate placement/import/preview obligations; it is not bundled
into this proposal.

Deletion test on a hypothetical compiler change: if Astro
relocates a loader table or changes a named loader into an inline
import function, today image inspection and partition editing
must learn the change separately. With the full A implementation,
one private decoder and its editor support demand and
file-selection operations; callers still supply component
identities and explicit selection. Decoder sharing alone does not
prove the editor safely removes unrelated code. Delete the module
and those recognition/edit/closure rules reappear in existing
callers. A facade forwarding to unchanged private parsers would
fail this test.

### Maintenance scenarios

No relative frequencies are invented for the four significant
cases in the maintenance matrix.

| Scenario and concrete change                                                 | A                                                                                                            | B                                                                                | C                                                                                                       | Work remaining with existing owners                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compiler upgrade: map relocation / inline loader; handler alias changes      | Decoder/editor/binder concentrate; preserve demand-specific tolerance.                                       | Decoder/projection concentrate; binder separate.                                 | Decoder/file workflow/binder concentrate; callback contract unchanged.                                  | Public hook/config changes still reach `Hooks`/`TargetBuild`; supported-version builds and independent code-exclusion checks remain necessary.                                                                           |
| Packaging: exact lockfile or native dependency delivery changes              | Package owners consume final selected bytes; import facts need a separate order-preserving migration.        | Same; optional import query if justified.                                        | Callback implementation changes with package rules; compiler workflow must preserve when it is invoked. | `Dependency`, `Prepare`, registry and capability declarations where runtime support changes. Compiler index cannot solve a package graph defect.                                                                         |
| Routing/404: scope/body copies or rewrite/error semantics                    | Supplied policy values change outside interpreter; selection semantics revisit only after accepted contract. | Query selection changes outside index; no hidden rewrite closure.                | Callback supplies new policy; workflow does not choose it.                                              | `RouteRequirements`, `Scope404`, preparation, `.astroHandler.ts`, compatibility and manifest/Gateway where their contracts change. Repeated custom-404 pattern recognition is a different rule, still outside this work. |
| Input diagnostics: invalid option combinations or unreadable compiler output | Options remain local; preserve compiler read/parse cause and current failure phases.                         | Options remain local; construction-versus-query failure timing adds obligations. | Options remain local; distinguish callback failures from compiler/binding failures.                     | Integration wrapping and audited error ownership. Existing broad error classes do not establish a new external-input restriction.                                                                                        |

### Proposed first small refactor, not applied

After the gate and an implementation handoff, extract only
read-only emitted runtime evidence behind one technical
operation. Preserve entrypoint validation and completed client
reads in their current phases.

```ts
// src/.AstroOutput/index.ts — proposed first interface only
inspectRuntime(input: {
  directory: URL;
  runtimeComponents: readonly string[];
}): Promise<{ hasServerIslands: boolean; hasRuntimeImages: boolean }>;

// ArtifactGeneration.inspectRoutes: after existing entry/client reads
const evidence = hasFunction
  ? await inspectRuntime({ directory: server, runtimeComponents })
  : { hasServerIslands: false, hasRuntimeImages: false };
return reconcileRoutes({ ...existingEvidence, ...evidence });
```

Proposed file map:

```text
+ src/.AstroOutput/index.ts              one read-only outcome operation
+ src/.AstroOutput/<private helpers>     actual map/image interpretation
~ mandatory/ArtifactGeneration/index.ts  remove island AST; keep I/O/order/reconcile
~ .../RuntimeImageRoutes.ts              keep semantic root eligibility, lose AST/graph I/O
= conditional/FunctionArtifact/*         no selection/package/binding/apply change yet
= Hooks / Options / TargetBuild         current contracts and state
```

Implement the actual island/image work behind the operation, with
a common private structural decoder, rather than exporting
parse/visit/regex helpers. Keep each observation's candidate
scope, inline/named-loader handling, map-holder exclusion and
tolerant shape behavior. Evaluate island evidence before image
evidence as today; do not add parallel reads or global fail-fast
validation. No-function builds must skip both reads. Root
eligibility and public component fallback remain visible with
route inspection.

This slice yields one outcome interface for two existing
observations and removes compiler interpretation from their
caller. Partition recognition temporarily remains duplicated;
therefore it does **not** complete the full three-consumer
deletion test. The next authorized slice would share that private
decoder with selected-file planning while retaining its stricter
editing preconditions. Do not scaffold all three A operations as
forwarders. Do not move binder/logger code just to make the first
diff larger.

Acceptance for the first slice: identical runtime-demand and
manifest/Gateway requirements, no output or input-route mutation
during observation, retained no-SSR behavior, unchanged failure
phase/cause and applicable build/handler fixtures below. Broader
acceptance waits for the contract study and user choice. No
production source, domain terminology, source naming, or policy
was changed by this report.

## Validation record

This documentation task adds no permanent executable check or
test framework. The archived native experiments were not rerun:
no production behavior or new experimental variable changed. A
disposable hash check extracted the archived JavaScript and
verified both recorded recipe SHA-256 values:
`3ceb48ffada008694051fed5a15619feb8825080c91c17edbbd409aec990c887`
and
`b8b271d711067d1a7a04fe48781c3bd81542094a5cce2b9e17ff1a7499fd31b3`.
This checks evidence integrity, not additional runtime coverage.

Checks for this documentation branch used Node **22.12.0**, pnpm
**10.33.2**, locked Astro **7.1.6**, Vite **8.2.0** and the
repository's existing commands:

- `pnpm install --frozen-lockfile` passed.
- `pnpm check`: typecheck and lint passed; formatting failed
  solely on the pre-existing/setup `skills-lock.json` change.
  That unrelated file is retained locally and excluded from the
  research commit. The aggregate command did not reach its
  tests/final build, so it is not reported as passing.
- `pnpm test` passed separately: build plus **385 tests in 23
  files**.
- `pnpm pack:check` passed separately, including the package
  build, clean application/consumer checks and publish dry run.
  No package was published.
- The new report passed Prettier and `git diff --check`; all
  relative file links were checked for existence with a
  disposable read-only probe.

There is no separate `CONTRIBUTING` or change-workflow document
in this base; `AGENTS.md`, `docs/agents/issue-tracker.md`,
package scripts and `.github/workflows/ci.yml` supply the
applicable workflow. Skills were restored with
`node scripts/setup-skills.mjs`. Only this report belongs in the
PR. CI, its compatibility matrix, the beta rehearsal and local S3
job are reported by GitHub separately; local S3/cloud execution
and an exhaustive peer-range run were not performed in this task.
A documentation-only local test pass does not resolve the
dependency gate or prove a proposed interface.

## Validation plan for a future approved refactor

The interface is the test surface. Use the existing Vitest runner
and fixture conventions. Preserve observable public-adapter and
generated-handler checks; do not layer parser-helper tests on top
of assertions for the same behavior. The
[existing plan tests](../../tests/unit/function-artifact-plan.test.ts)
already use real temporary files and verify read-only planning,
unchanged input route plans, computed writes, deferred copies,
source-removal ordering, empty-output cleanup, dependency failure
before mutation, and stop-on-error with prior writes retained.
Keep those guarantees even if internal functions move.

| Behavior / risk                             | Observable verification                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Static-only output and absent runtime files | `tests/integration/build.test.ts` and `partitioning.test.ts`: no deployable function records/directories for static-only fixtures, including `functions: separate`; preserve no-SSR behavior.                                                                                                    |
| Separate file closure and precedence        | `partitioning.test.ts`: execute independently copied handlers, assert foreign markers/code and unrelated dependencies absent; specific route versus rest route, dynamic and integration-injected routes, non-root base and preview. A 200 alone is insufficient.                                 |
| Islands and Actions                         | `build.test.ts`, `partitioning.test.ts`: active versus unused internal routes, deferred island execution including an island used only on demand, and valid Action execution through Gateway.                                                                                                    |
| Runtime image evidence                      | `runtime-image.test.ts`: build the on-demand page with default and custom endpoint under `/docs`, install copied functions independently, render page and transform an actual image. Retain registered-only endpoint exclusion in `gateway.test.ts`; import presence alone must not activate it. |
| Function packaging                          | `build.test.ts`, `partitioning.test.ts`, `dependencies.test.ts` and `install-lockfile.test.ts`: only selected imports get pinned; install a clean copied artifact; native Sharp remains install-only; injected computed/unresolved imports retain their diagnostic provenance.                   |
| Routing / static 404                        | `recursive-404.test.ts` and `gateway.test.ts`: completed dynamic scopes, retained HTML in page functions, static-only Markdown 404s, root/non-root paths, explicit endpoint 404 response, on-demand custom-404 compatibility.                                                                    |
| Rewrite and error transitions               | Use delivered R1–R4 to distinguish extraction equivalence from a later D1/D2 fix. Existing defects do not become allowed behavior; choose transition handling and error outcomes explicitly before implementing the fix. Keep rejected Promises separate from HTTP responses and preview 500s.   |
| Malformed compiler representation           | Through the chosen interface, supply actual temporary emitted files with one broken convention and assert original output is untouched and a specific operation/cause survives. Do not infer a new input rejection from a failed recognizer.                                                     |

A compiler convention change should first run the focused
actual-build and handler cases, then `pnpm check` and
`pnpm pack:check`. The existing
[CI matrix](../../.github/workflows/ci.yml) also exercises Astro
7.1.0 and latest Astro 7 across supported Node versions;
experimental `next` is not a stable support guarantee. Tests
against one locked version do not establish compatibility for the
whole peer range. The selected-App recipe is a separate research
probe and is not run by normal compatibility CI.

No new class per Astro version, fake filesystem, mock application
renderer, or persistent probe is justified by this design.
Cross-version fixture failures must be investigated without
weakening code-exclusion assertions or narrowing the advertised
range silently. Real cloud execution remains unverified by local
build/handler tests.

## Documentation evidence

Two further scoped Context7 queries covered rewrites/middleware
and custom 500 pages separately. The official docs describe a new
render phase and middleware re-execution for `context.rewrite`,
and runtime custom 500 rendering. They do not establish this
adapter's cross-artifact transport or the experiment's
strict-status policy. See the
[middleware reference](https://github.com/withastro/docs/blob/main/src/content/docs/en/guides/middleware.mdx)
and
[custom error-page documentation](https://github.com/withastro/docs/blob/main/src/content/docs/en/basics/astro-pages.mdx).
Exact observed 7.1.6/7.4.8 differences remain versioned evidence,
not an inference from current unversioned docs.

Context7 resolved Astro to `/withastro/docs`; a scoped query
covered `astro:build:ssr` data/timing versus `astro:build:done`.
Its indexed material includes older versions: it also confirms
that the old `entryPoints` map was removed in Astro 6. The
installed Astro 7.1.6 declaration
`dist/types/public/integrations.d.ts` exposes `manifest`,
`middlewareEntryPoint`, and `logger`, not route-selected output
entries. The current `Hooks` implementation consumes structured
identities directly. No current support claim is inferred solely
from mixed-version documentation.

Primary upstream references:

- [Public integration hooks](https://github.com/withastro/docs/blob/main/src/content/docs/en/reference/integrations-reference.mdx).
- [Astro 6 migration: entryPoints removal](https://github.com/withastro/docs/blob/main/src/content/docs/en/guides/upgrade-to/v6.mdx).
- [Astro 7.1.6 integration declarations](https://unpkg.com/astro@7.1.6/dist/types/public/integrations.d.ts).
- Versioned compiler/runtime sources and the precise 7.1.6/7.4.8
  differences are linked in the
  [loader-expansion evidence](native-app-loader-expansion.md#primary-sources).
