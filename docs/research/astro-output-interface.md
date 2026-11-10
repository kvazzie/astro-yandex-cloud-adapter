# Astro output handling after retiring separate functions

Research reassessment, 2026-11-10. The useful result of this
investigation is now a smaller maintenance scope: keep Astro's
complete native App, retain the existing preparation owners, and
consider read-only runtime-demand inspection independently. The
former recommendation to build a selection-oriented output module
is superseded by the accepted retirement of `separate`.

This PR changes only this report. It records research and design
conclusions for review; it neither implements nor approves a new
compiler interface, runtime policy, or production refactor.

## Authority and inspected snapshots

The decision is recorded in [ADR 0013][retirement-adr]; its
implementation is in open [PR #100][retirement-pr]. It retires
per-route functions and adapter-owned loader pruning,
prioritizing Astro behavior over route-level code isolation. Its
history and criteria for any future return are authoritative;
this report does not create a second retirement decision.

At this revision, `origin/feat/complete-beta-routing` is
`30063ba63209a7edd85527f26e09cf9d34e77a28`, after merged
[contract PR #98][contract-pr]. PR #100 is still open; its
inspected head is `93472decdd7bb77ebc30d920e51b6bb82e21df2d`,
superseding the initial `554d7a6` handoff. Consequently the
post-retirement source references below are pinned to that head,
not described as already merged into this report's base. This
report can be reviewed and merged independently of the
implementation PR.

Other inputs:

- [Public-API/prior-art PR #99][public-pr], inspected at
  `80c06c3f79e108511348fafda2f41c5c1ec94b97`, distinguishes
  public runtime data from generated compiler representation.
- [Contract report][contract] at
  `ca8aa36ebd100896efc01838917731fd50ca8473` records production
  observations against
  `84584c8d9afe5780a8c9fee23f44d13b5a5f1425`.
- [Earlier version of this report][original-design] at `f0ba508`
  preserves the full three-agent comparison and original caller
  sketches. Those selection designs are historical, not pending
  implementation instructions.

The following decision status replaces the old open gate:

| Subject                         | Current authority and consequence                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `functions: "separate"`         | Retired by the user's decision and ADR 0013. Choosing transport, transition closure, or runtime refusal for that arrangement is no longer a prerequisite.                                                                                                                                                                                                                         |
| Astro error outcomes            | The user accepted preserving a returned Astro/application `Response`, including a rest-owned 200 after error recovery. This agrees with the existing [response contract](../domain-errors.md#application-and-response-errors). A universal throw-to-500 override is not selected.                                                                                                 |
| Rejected `app.render()`         | The user accepted an outer HTTP 500 fallback with the original cause retained in diagnostics, without replacing a returned `Response`. This is a recorded conversation decision, not an upstream guarantee. PR #100's [handler snapshot][handler] still returns `app.render` and propagates rejected execution; removing partitioning does not implement this separate follow-up. |
| 404 scope after a rewrite       | Target-path default with an `original` setting remains a preference/sketch, not a completed interface or implementation decision. It is independent of read-only build inspection.                                                                                                                                                                                                |
| Actions and request context     | The user explicitly requires preserving `Cookie` and `Authorization`. The existing Gateway support arrangement remains; retirement does not relax [ADR 0005](../adr/0005-support-direct-and-api-gateway-function-invocation.md).                                                                                                                                                  |
| Resource URLs                   | Staged Pulumi outputs are already decided in [ROADMAP](../../ROADMAP.md#yandex-sst-astro-component) and [issue #69](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/69). URL provisioning is not a new design gate here.                                                                                                                                             |
| Read-only inspection extraction | No production refactor has been approved. The reassessment below withdraws the old broad recommendation and defines only a bounded future candidate.                                                                                                                                                                                                                              |

## Why the selection design lost its purpose

There was an implemented `separate` attempt under
[issue #70](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/70),
not merely an untried idea. Its preparation removed unrelated
loaders while retaining routing metadata. Production experiments
then found two distinct defects on Astro 7.1.6 and 7.4.8:
accepted cross-route rewrites lost target loaders (D1), and
throwing routes lost existing error fallback loaders (D2). The
full reference App and shared output retained those outcomes. The
[report, exact cases and evidence][contract] remain the source
for the bounded results: 36 builds, 780 fresh-process
observations and 168 preview requests. They are not generic
physical-closure or real-cloud proof.

Upstream made a related trade-off. [Astro PR
#11714][astro-removal] removed `functionPerRoute` and its
splitting logic for Astro 5; its [release
explanation][astro-release] cites shared code, reduced benefit
under larger hosting limits, function-count limits, and
incompatibility with request rewrites/i18n domains. Astro 6 then
removed the remaining empty SSR `entryPoints` map. These are
upstream findings, not measurements of this adapter's Yandex
performance.

ADR 0013 chooses a complete App instead of adding another
transition mechanism to the adapter. Its implementation snapshot
has this flow:

```text
native Astro build → complete App + emitted runtime files
  → zero Function Artifacts for a Static-only Build
  → one Function Artifact for a Runtime Build
      → package validation / metadata + retained static 404 policy
      → ordered preparation mutations
  → common manifest / optional Gateway template
```

PR #100 removes `Partition`, loader pruning, per-route allowlists
and the separate preview dispatcher. `functions: "shared"`
remains a compatibility spelling; `separate` and multiple
function records are rejected by its options/schema changes. This
resolves the arrangement choice; it does not claim every runtime
concern has been implemented.

The previous design's central job was selecting independent file
sets. That job no longer belongs in the intended production flow.
A reusable selection index, component-selection interface, or
callback around per-route packaging would now carry retired
requirements. Do not retain them as dormant extension points.
Normal native chunk splitting remains Astro's responsibility.

## Public data versus generated representation

The [primary-source audit][public-audit] and current official
[integration reference][integrations] establish an important
correction to overly broad descriptions of compiler coupling:

| Surface                                                                                                              | Precise status                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `astro:routes:resolved`, `astro:build:setup.pages`, structured route/component data in `astro:build:ssr.manifest`    | Public hook data. #91 already uses structured identities; do not restore a `deserializeManifest` parser. `Hooks` keeping a private per-build map does not make its input private.                                                                         |
| Runtime `SSRManifest.pageMap`, `pageModule`, `serverIslandMappings`, `middleware`, `renderers`                       | Documented public runtime fields. Their existence is not private, and the documented loader wrapper is not categorically private. A runtime shape does not mean the serialized build callback supplies every compiled callable value.                     |
| Emitted `pageMap` / `serverIslandMap` variable spelling, `$n` aliases, loader declaration syntax and chunk placement | Generated representation understood by current parsers. Runtime field documentation does not promise those JavaScript spellings or locations. `serverIslandMap` in emitted code and the documented `serverIslandMappings` field are different references. |
| `virtual:astro:middleware`, `virtual:astro:renderers`, compiler-plugin post-hook acquisition                         | The audit found no documented adapter extension contract for these acquisition mechanisms. Public middleware/renderer registration is a different surface.                                                                                                |
| `createApp()` and native server entry construction                                                                   | Public mechanisms for the complete App. Current official Node/Netlify/Cloudflare/Vercel snapshots follow complete-App paths; Vercel ISR/edge middleware roles do not demonstrate ordinary per-route physical code exclusion.                              |

The audit did not establish a complete public-only Astro 7 recipe
for the former isolated-per-route requirement. It did **not**
prove impossibility. Retirement is a project decision about
compatibility and maintenance cost, not a claim that all runtime
metadata is private or that no future design can work.

Likewise,
[selected-App loader experiments](native-app-loader-expansion.md)
and production pruning are different graphs. The former recipe's
7.4.8 foreign-code retention must not be generalized to every
production output. Keep raw
[recipes](native-app-loader-expansion-recipe.md) and
[results](native-app-loader-expansion-results.json) unchanged;
use ADR 0013 before reconsidering that line of work.

## What output knowledge still exists

The post-retirement paths below were inspected in PR #100; the
island/image readers and dependency scanner are unchanged from
the working base. Removing file selection does not remove these
specific compiler conventions.

| Remaining consumer                                                                                                    | Actual knowledge / behavior                                                                                                                                                  | Owner retained                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`Hooks`](../../packages/adapter/src/Hooks/index.ts)                                                                  | Public SSR route/component identities, resolved routes and completed pages/assets; reset/conflict handling for per-build state                                               | Lifecycle and state stay with `Hooks`.                                                                           |
| [`ArtifactGeneration`](../../packages/adapter/src/mandatory/ArtifactGeneration/index.ts)                              | Entrypoint presence; final client files/HTML; nonempty emitted `serverIslandMap` recognition in entry/island-manifest candidates                                             | Completed evidence, route reconciliation and common completion.                                                  |
| [`RuntimeImageRoutes`](../../packages/adapter/src/mandatory/ArtifactGeneration/RuntimeImageRoutes.ts)                 | Non-prerendered route roots with Actions exception; public component IDs/fallback; emitted map/declaration recognition; reachable `getImage` calls through fixed local edges | Runtime-image demand evidence. Mere registration/import is insufficient.                                         |
| [`FunctionArtifact/.output.ts`][output]                                                                               | Full emitted file inventory and JS contents; compiled handler export alias discovery/binding                                                                                 | Complete output preparation, artifact descriptor and static-404 handler policy mechanics. No component selector. |
| [`Dependency/ImportSpecifier`](../../packages/adapter/src/conditional/FunctionArtifact/Dependency/ImportSpecifier.ts) | Package/native/CommonJS/computed import checks; compiler-specific logger exemption by emitted filename/function/expression                                                   | Strategy validation and diagnostics remain in dependency preparation.                                            |
| [`FunctionArtifact/.plan.ts`][planner] / [`Prepare.ts`][prepare]                                                      | Full output, exact package metadata/lock, retained 404 bodies/policy and ordered writes/copies/cleanup                                                                       | Preparation and package/404 policy; no per-route assignment or preview dispatcher.                               |

The existing
[generic AST helper](../../packages/adapter/src/conditional/FunctionArtifact/.emittedModules.ts)
is already shared. References to it or to one `RoutePlan` do not
duplicate the rule that produced them. Island and image readers
still repeat map recognition; the deleted partitioner no longer
provides a third consumer. Handler binding and the logger
exception are separate conventions with their own consumers.
Moving them all into a new folder would not alone create depth.

## Reassessed recommendation

**Keep the existing observation and preparation owners after
retirement. Do not implement the old A/B/C interfaces.** The
original recommendation A relied partly on leverage across
inspection and multiple selected file projections. That leverage
has changed. No measured repeated-projection cost justifies the
index's lifetime/plumbing; a compiler callback around packaging
would add ordering obligations to a workflow that now reads one
complete file set.

A bounded read-only module remains a possible future improvement,
not an approved next change:

```ts
// Illustrative future candidate only; no declaration is added.
inspectRuntime({ directory, runtimeComponents }): Promise<{
  hasServerIslands: boolean;
  hasRuntimeImages: boolean;
}>;
```

```text
existing entry check → final client evidence
  → island/image evidence → existing reconciliation

possible future seam at the island/image evidence step only
  caller owns route eligibility and public component identities
  implementation owns emitted-map recognition and image traversal
```

Before extracting it, demonstrate a concrete maintenance benefit
for both readers or equivalent public hook evidence that removes
parsing. Public runtime fields are useful evidence sources, but
importing/executing application code at build time is not an
acceptable shortcut. The serialized hook is not automatically a
complete runtime manifest. Equivalence must cover image calls,
unused endpoints, Actions/islands and final-output timing.

Deletion test: a future read-only module earns its keep if
deleting it returns repeated compiler recognition to island and
image inspection. It does not earn credit for the removed
partitioner, N per-route projections, extra forwarding methods,
or a new Output Value Object. It serves one current completion
caller with two distinct evidence calculations, not three
independent production workflows. Prefer no extraction to an
interface that merely renames the two old helper calls.

If this candidate is later authorized, preserve both readers'
current candidate-file scopes and treatment of unrecognized
shapes, inline versus named loader handling, map-holder
exclusions and semantic roots. Entrypoint validation and client
reads retain their phases; island evidence precedes image
evidence; absent runtime output skips both. Return facts for
reconciliation, without choosing compatibility, package strategy
or response policy. Do not expand this candidate with
`selectFiles`, a mutable session, or a preparation callback.

The remaining handler-export binding might independently be
replaced by an ESM facade using the existing fourth handler
argument. That is still an unapproved, separate experiment with
placement/import/package-scanning/preview obligations. PR #100
retains binding for static 404 policy even though it removes
route allowlists. The logger exception likewise remains an
explicit compiler-sensitive packaging rule; this report claims no
complete elimination of compiler coupling.

## Historical three-design comparison

Three fresh-context agents originally examined the same facts and
constraints with different goals. The [complete comparison and
caller sketches][original-design] remain available at their
pre-retirement revision. This compact record preserves why that
work should not become a production plan by inertia.

| Original design / caller sketch                                                | Original leverage and cost                                                                                                               | Disposition after ADR 0013                                                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A, minimal: `inspect → selectFiles → package validation → bindHandler → queue` | Hid compiler grammar behind outcome operations; repeated reads, eager import-fact error precedence and binding order needed care.        | Selection is retired. Withdraw the full recommendation. Read-only inspection and existing static-404 binding are independent questions.              |
| B, extensible: `read index → facts / files(selection A) / files(selection B)`  | Reused captured JS for many independent projections; callers learned index lifetime, referenced-asset availability and handle plumbing.  | Multiple projections no longer justify that interface. Do not introduce an index for hypothetical future targets.                                    |
| C, default caller: `planAstroFunction(files → package callback → binding)`     | Hid compiler choreography for shared/per-route jobs; callback typing and interleaved registry/selection failures enlarged the interface. | Per-route workflow is retired; existing single-output planner already owns the remaining sequence. A compiler callback adds no demonstrated benefit. |

Their original deletion tests, test surfaces and seam placement
were conditional on the old requirements. ADR 0013 changes those
requirements. This reassessment compares depth as caller
leverage, not implementation line counts, and withdraws
conclusions whose consumers disappeared. It does not rerun
DESIGN-IT-TWICE against a feature the user has retired.

## Maintenance and responsibility map

The [maintenance matrix](../target-change-matrix.md) assigns no
relative frequency weights to these four significant scenarios.
Its [PR #100 revision][updated-matrix] removes partitioning; use
the implementation snapshot for the actual remaining calls.

| Scenario                   | Useful locality after retirement                                                                                                                                                     | Work that still crosses owners                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compiler/lifecycle upgrade | Island/image recognition, handler export alias and logger grammar are concrete remaining conventions. A demonstrated change to both readers may justify the bounded inspection seam. | Public hook changes still reach `Hooks`; config/capability changes reach `TargetBuild`; generated handlers and supported-version builds verify behavior.              |
| Function packaging         | Full output, dependency resolution, exact metadata and lockfiles stay in `FunctionArtifact`/`Dependency`. No selected route closure needs calculation.                               | Native dependency support can affect capability declarations and actual-output validation. A future facade that adds imports must preserve package analysis order.    |
| Routing/404/errors         | The complete App owns internal route/error loading; `Scope404`, preparation and runtime integration keep their existing fallback responsibilities.                                   | Accepted outer-500 handling and any future target/original scope setting need explicit runtime work, not a compiler reader. Gateway/authentication guarantees remain. |
| Input diagnostics          | `Options` owns decoding/defaults and rejecting retired `separate`; integration owns hook wrapping.                                                                                   | Compiler read/parse failures retain causes and producer responsibility. A missing promised file must not become an invented user-input restriction.                   |

The intended responsibility map is unchanged except for removing
the retired path:

```text
Options                    accepted configuration / defaults
Hooks                      lifecycle + public build evidence
TargetBuild                compatibility + selected preparation
ArtifactGeneration         final evidence + route reconciliation + completion
FunctionArtifact           complete output + packages / 404 / mutation planning
applyPreparation           ordered filesystem application
Astro App                  native route, rewrite and error-renderer loading
Scope404 / runtime bridge  existing fallback and invocation responsibilities
```

Plan/apply guarantees remain those of
[ADR 0003](../adr/0003-concentrate-target-policy-in-target-drivers.md)
and the [post-retirement planner][planner]: planning reads
without mutating output, computes final JS contents in memory,
and may retain non-JS source references until copying.
Application runs an ordered queue and stops at the first error;
earlier changes may remain. Source-copy availability and
no-function cleanup are still relevant. There is no
separate-source removal followed by preview-dispatcher creation
in the new path. No rollback, idempotence, retry, exactly-once,
atomic snapshot or cross-process guarantee is added. Registry
access remains in preparation; no new filesystem port or
per-Astro-version class is justified.

## Verification and future acceptance surface

This revision edits documentation only. It does not claim to
implement PR #100, the accepted outer error fallback, or an
inspection refactor. Local document formatting, relative file
links, pinned repository-source links and `git diff --check` are
verified for this revision; GitHub CI is reported in the PR. The
inherited local `skills-lock.json` change stays outside the
commit; workspace-wide `pnpm format:check` reports only that
file's existing formatting difference. Production tests/builds
were not rerun for this documentation edit. No new permanent
test/framework or repeated research probe is added.

Existing evidence has distinct scopes:

- The original report's base checks passed 385 tests in 23 files,
  and packed-consumer verification; these are historical results,
  not validation of a new reader or this later implementation.
- PR #100's [function artifact tests][function-tests] exercise
  one complete function, cross-route page/endpoint/middleware
  rewrites, retained custom error loaders, Actions, islands,
  direct endpoints, non-root base, install dependencies and
  static-only output. Those are implementation evidence in that
  PR, not tests run by this documentation edit.
- [Runtime-image tests](../../tests/integration/runtime-image.test.ts)
  still build and execute default/custom endpoint functions and
  inspect resulting image bytes. Existing preparation tests cover
  no mutation during planning, package failure before apply,
  static 404 copies and first-error application behavior.
- The older native and contract recipes/results stay unchanged;
  successful responses, fixture-marker inventories and generic
  physical closure remain separate kinds of evidence.

For any later inspection-only change, use actual public-adapter
builds and generated handlers for active/unused image endpoints,
Actions and on-demand-only islands, final HTML/page
reconciliation, custom static 404 bodies, static-only output and
installed-package execution. Compare unchanged requirements and
response outcomes; helper/AST tests alone are insufficient.
Preserve planning reads and failure phases. Package strategy
validation must retain its `.node`/`.cjs` checks and error order
if import evidence is moved.

Run the existing required checks and supported Astro
compatibility matrix for an authorized production change; do not
infer the whole `^7.1.0` peer range from 7.1.6 alone or weaken
the declared range to fit one parser. Cloud conformance remains
separate. The report itself has no unresolved `separate`
transport gate: merging it records the reassessment and leaves
future production work subject to its own authorization and
acceptance criteria.

## Primary references

Context7 resolved Astro to `/withastro/docs` for this revision. A
scoped runtime-manifest query explicitly confirmed documented
`pageMap` and `pageModule` fields and the serialized SSR hook;
the [pinned public-API audit][public-audit] supplies the
remaining field/acquisition distinctions and versioned source
references. The index includes older-version prose, so neither
generic wording about entrypoints nor a runtime field's presence
overrides the versioned Astro 7 declarations. The upstream
removal PR was also read directly. No new runtime experiment was
needed to reassess a retired design.

[retirement-pr]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/100
[retirement-adr]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/93472decdd7bb77ebc30d920e51b6bb82e21df2d/docs/adr/0013-retire-separate-functions-and-use-native-astro-app.md
[contract-pr]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/98
[contract]: rewrite-error-contract.md
[public-pr]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/99
[public-audit]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/80c06c3f79e108511348fafda2f41c5c1ec94b97/docs/research/astro-adapter-public-api-and-prior-art.md
[original-design]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/f0ba508a38738d0dc260b70a27848247baa02fb4/docs/research/astro-output-interface.md
[astro-removal]: https://github.com/withastro/astro/pull/11714
[astro-release]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/astro/CHANGELOG-v5.md#L3285-L3291
[integrations]:
  https://github.com/withastro/docs/blob/d7657e201db89940b4fbad3704dbb6c0d2b075bf/src/content/docs/en/reference/integrations-reference.mdx
[output]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/93472decdd7bb77ebc30d920e51b6bb82e21df2d/packages/adapter/src/conditional/FunctionArtifact/.output.ts
[planner]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/93472decdd7bb77ebc30d920e51b6bb82e21df2d/packages/adapter/src/conditional/FunctionArtifact/.plan.ts
[prepare]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/93472decdd7bb77ebc30d920e51b6bb82e21df2d/packages/adapter/src/conditional/FunctionArtifact/Prepare.ts
[handler]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/93472decdd7bb77ebc30d920e51b6bb82e21df2d/packages/adapter/src/.astroHandler.ts
[function-tests]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/93472decdd7bb77ebc30d920e51b6bb82e21df2d/tests/integration/function-artifacts.test.ts
[updated-matrix]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/93472decdd7bb77ebc30d920e51b6bb82e21df2d/docs/target-change-matrix.md
