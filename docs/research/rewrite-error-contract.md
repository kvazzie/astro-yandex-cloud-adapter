# Rewrites, errors, and Function boundaries

Historical evidence:
[ADR 0013](../adr/0013-retire-separate-functions-and-use-native-astro-app.md)
retires separate functions / `functionPerRoute` after this
investigation. The observations below remain evidence for their
recorded source versions; they are not a current promise to
support `functions: "separate"`.

Research on 2026-11-10 against
`84584c8d9afe5780a8c9fee23f44d13b5a5f1425`, the merge of
[PR #96](https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/96)
into `feat/complete-beta-routing`. `HEAD`, the local base branch,
and the freshly fetched remote base agreed before research. The
main checkout was clean. This checkout already contained a
modified `skills-lock.json`; its original bytes are preserved and
excluded from the PR. Project skills were restored with
`node scripts/setup-skills.mjs`; setup's lockfile side effects
were separated from this work. No production source, root
configuration, dependency declaration, glossary, or ADR changes
are part of this research.

## Result and authority

**The production adapter's initial route guard does not establish
rewrite or error-transition isolation.** Research distinguishes
three subjects: the actual generated production handlers, a full
standard Astro App on identical fixture sources, and the earlier
selected-App experiment in #96. A response proves execution; it
does not prove that only selected files were delivered.

The already promised requirements include preserving actual
Astro/application responses and representative shared/separate
response equivalence. They do not establish a universal rule that
an application `throw` must override Astro's error routing and
become HTTP 500. The latter was deliberately stricter research
policy in #96. No new runtime policy is adopted here.

The remaining sections distinguish observed behavior, violations
of existing guarantees, and choices requiring the user. The
related design task must keep those choices conditional.

## Existing promises, independently of guards

| Guarantee or limit                                                                                                                                                 | Exact primary source                                                                                                                                                                                                                                                                                                                   | Interpretation for transitions                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared and separate modes produce equivalent Astro responses for representative routes; each separate artifact includes required code, dependencies and 404 assets | [Issue #70](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/70), acceptance criteria; [routing guide](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/84584c8d9afe5780a8c9fee23f44d13b5a5f1425/docs/beta-routing.md#runtime-pages-with-separate-functions)                                                     | Packaging must account for the execution needed by an accepted route. An omitted loader is not independently a legitimate user-input restriction. Cross-artifact dispatch mechanics and exhaustive rewrite policy remain unspecified. |
| Actual application/Astro responses retain status; rendering and body-read errors retain their original ownership                                                   | [Error guide](../domain-errors.md#application-and-response-errors), lines 363–376 at the base; [bridge](../../packages/function-runtime-bridge/src/index.ts), `fromWebResponse` and `invoke`                                                                                                                                           | A returned 200 after Astro error routing is distinct from the original throw and must not be called a bridge status-conversion defect. A rejected Promise has no HTTP status.                                                         |
| Correct thrown-error and middleware-error behavior follows Astro                                                                                                   | [Issue #1](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/1), stories 18/23 and Testing Decisions; [issue #4](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/4); [existing generated-handler case](../../tests/integration/build.test.ts), `/api/error` assertion                                          | The existing 500 fixture proves its case, not a universal replacement for custom error pages or a rest endpoint's Response.                                                                                                           |
| Unknown URLs use the nearest explicit static fallback; matched endpoints retain their own 404 response                                                             | [Routing guide](../beta-routing.md#static-pages-through-gateway), lines 52–61; [package guide](../../packages/adapter/README.md), lines 716–735; [issue #68](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/68)                                                                                                          | The initial fallback is established. Original versus rewritten pathname, prerendered-target handling and later-transition fallback need separate decisions/evidence.                                                                  |
| Custom 404 pages are prerendered; page-serving artifacts retain fallback HTML; endpoint-only artifacts are not page servers                                        | Same package guide; [error guide](../domain-errors.md#on-demand-404-page-error); [copy planning](../../packages/adapter/src/conditional/FunctionArtifact/Prepare.ts), lines 93–162                                                                                                                                                     | A static 404 copy does not supply a `/500` runtime loader. Retaining global route metadata also does not supply that loader.                                                                                                          |
| Preserve base, route precedence, actual route/artifact references or reject incompatible Gateway shapes                                                            | [Issue #67](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/67); [Gateway ADR](../adr/0009-derive-gateway-template-from-build-routes.md); [routing guide](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/84584c8d9afe5780a8c9fee23f44d13b5a5f1425/docs/beta-routing.md#runtime-pages-with-separate-functions) | Initial specific/rest selection must remain correct. The Gateway template selects an artifact for the incoming request; it does not re-enter routing for an internal Astro rewrite.                                                   |
| Direct URLs support stateless user endpoints; on-demand pages/internal routes require Gateway                                                                      | [ADR 0005](../adr/0005-support-direct-and-api-gateway-function-invocation.md); [package routing options](../../packages/adapter/README.md#routing-options); [issue #70](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/70)                                                                                               | A packaging choice cannot grant direct page support. Direct endpoint rewrites are tested separately from Gateway page requests.                                                                                                       |
| Preview invokes generated handlers and supplies local URL/origin; a request-level throw is logged and becomes 500                                                  | [Preview guide](../../packages/adapter/README.md#build-inspect-and-preview); [preview error contract](../domain-errors.md#local-preview-errors); [implementation](../../packages/adapter/src/.preview.ts), lines 261–277                                                                                                               | Preview HTTP 500 is not proof that the deployed handler returned 500. Production propagation and preview adaptation are different boundaries.                                                                                         |

The
[accepted routing decision](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/63#issuecomment-5900071837)
and
[amendment to the original beta spec](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/1#issuecomment-5900135178)
supersede conflicting original exclusions in #1. Issue state
alone proves neither implementation nor release readiness.
[Issue #17](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/17)
and
[integration issue #81](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/81)
remain broader acceptance/release evidence requirements.

The support declaration is Astro `^7.1.0`, Node `>=22.12.0`, with
real-cloud compatibility still unverified. Newer Astro's own
engine requirements also apply. Sources:
[root README](../../README.md),
[package metadata](../../packages/adapter/package.json).

## Actual production path and ownership

```text
Options + selected TargetBuild
  -> Hooks / Astro native build
  -> ArtifactGeneration.RouteRequirements: completed routes + scopes
  -> FunctionArtifact.planPreparation
       Partition: shared full output | one route per separate artifact
       Prepare: allowedRoutes + page-only static 404 copies
       applyPreparation: files, bound handler, local dispatcher
  -> Manifest + Gateway template from the same route plan

incoming Gateway or direct event
  -> Function Runtime Bridge: Web Request, target/origin validation
  -> .astroHandler: app.match + initial static fallback / allowlist
  -> app.render: Astro owns subsequent rewrite/error route acquisition
  -> bridge: translate Response or propagate non-request errors

preview HTTP -> static client check -> local dispatcher -> same handler
             -> request-level catch: HTTP 500
```

These are existing owners, not a proposed redesign.
[ADR 0003](../adr/0003-concentrate-target-policy-in-target-drivers.md)
and [the target-change matrix](../target-change-matrix.md) assign
compatibility to `TargetBuild`, completed route evidence to
`RouteRequirements`, preparation/partitioning to
`FunctionArtifact`, and shared static fallback selection to
`Scope404`.
[ADR 0011](../adr/0011-organize-the-model-and-root-level-ports.md)
uses organizational groups; they do not classify errors as domain
outcomes.
[ADR 0012](../adr/0012-share-the-deployment-manifest-and-target-catalogue.md)
keeps the shared manifest schema separate from artifact writing.
[ADR 0010](../adr/0010-offer-bundle-and-install-dependency-strategies.md)
defines delivery strategies, not a transition policy.
[ADR 0002](../adr/0002-use-astros-build-pipeline-for-runtime-artifacts.md)
requires the native build and verification of generated handlers.

Source evidence at the base:

- [`.astroHandler.ts`](../../packages/adapter/src/.astroHandler.ts),
  lines 42–90: initial match, static fallback and `allowedRoutes`
  precede one `app.render`; there is no second adapter guard in
  Astro's internal transitions.
- [`Partition/index.ts`](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/84584c8d9afe5780a8c9fee23f44d13b5a5f1425/packages/adapter/src/conditional/FunctionArtifact/Partition/index.ts),
  lines 84–135 and 225–306: every separate route gets
  `allowedRoutes: [originalPattern]`; full route metadata
  remains, other page loaders are removed. Same selected set
  therefore means a self-rewrite in this configuration, not an
  arbitrary group of routes such as #96's `specific + allowed`.
- [`Prepare.ts`](../../packages/adapter/src/conditional/FunctionArtifact/Prepare.ts),
  lines 107–160: static fallback copies are only assigned to
  artifacts serving pages.
- [`.plan.ts`](../../packages/adapter/src/conditional/FunctionArtifact/.plan.ts),
  `previewMutations`: the dispatcher selects a handler once from
  incoming path and route priority. It does not dispatch a later
  `ctx.rewrite()` to a neighboring handler.
- [`Scope404`](../../packages/adapter/src/conditional/Scope404/index.ts):
  nearest concrete prefix, status 404, no route loader
  acquisition.
- [Bridge `invoke`](../../packages/function-runtime-bridge/src/index.ts),
  lines 330–373: explicit `FunctionRequestError` conversion;
  other renderer/translation errors propagate. The source
  preserves causes rather than turning all failures into 404.

A required transition dependency may be a page/endpoint loader,
compiled middleware, error renderer, or its transitive files.
Shared mode supplies the full map. Separate mode supplies a
single route loader plus retained common code and page fallback
HTML. Initial metadata/guard correctness and physical code
exclusion are independent from whether a later transition can
acquire the loader it requires.

## Experiment record

[The JSON evidence](rewrite-error-contract-results.json) records
**36 successful native builds**, **780 fresh-process handler/App
observations**, and **168 local preview requests**. Six fixture
families run on each of Astro **7.1.6** (the installed version
behind the earlier finding) and **7.4.8** (the latest stable
Astro 7 returned by the registry). Both runs use Node
**26.13.0**, Vite **8.3.6**, Rolldown **1.2.16**, Sharp
**0.34.5**, and `bundle` with Astro's passthrough image service.
Sharp is installed for build resolution; no Sharp runtime support
is claimed. Astro 7.4.8 requires Node `>=22.23.4`; this probe
does not change the repository's declared minimum. Root checks
use Node 22.12.0.

The isolated environments also install top-level Vite 8.3.7 /
Rolldown 1.2.18, but Astro resolves its own Vite 8.3.6 / Rolldown
1.2.16. `toolchainAudit` records package-resolution paths; the
per-run `vite` field is the top-level package, not the compiler
used by Astro. Both Astro versions use the same actual toolchain.
The isolated lockfiles fix the framework/toolchain packages; root
`pnpm-lock.yaml` fixes the adapter's existing dependencies. The
built adapter is copied unchanged into each environment, with
`astro` resolving to that environment. An observer records SSR
Astro module IDs and asserts the requested version for every
build. Fixture sources, full bodies, runtime loader-evaluation
markers (`loads`), executed route markers (`calls`), reference
initial match, manifests, Gateway templates, per-artifact file
inventories/hashes, dependency locks, and source hash are
retained. A page's frontmatter call marker identifies execution,
not a separate module-evaluation event. Middleware rewrites can
load an initial endpoint without executing its handler; the
separate fields preserve that distinction.

[The extractable recipe](rewrite-error-contract-recipe.md) builds
via the public adapter. Reference builds use the standard
`createApp({ streaming: false })` entrypoint with all loaders,
not a manually assembled selected App. Each artifact/App request
runs in a new Node process. Preview calls the actual shipped
`PreviewModule`, its generated dispatcher and generated handlers.
This is local execution of provider-shaped events, not a claim
about a deployed Gateway's response to a rejected invocation.

Fixture names in the JSON:

| Fixture  | Base       | Runtime routes and fallback                                                    |
| -------- | ---------- | ------------------------------------------------------------------------------ |
| `plain`  | `/`        | Specific page, another page, two endpoints; no rest/custom errors              |
| `rest`   | `/`        | Same sources plus normal-returning global rest endpoint; no custom errors      |
| `custom` | `/`        | Same plus prerendered `/404` and on-demand `/500`                              |
| `nested` | `/nested/` | Same as `custom`, including base-free and base-prefixed rewrite payloads       |
| `scoped` | `/nested/` | Same as `nested` without the rest endpoint; real unknown-URL fallback          |
| `direct` | `/nested/` | Only stateless endpoints, including rest; reserved parameter from the manifest |

### Bounded behavior matrix

Rows apply on both recorded versions unless marked. Page and
endpoint rewrites, and middleware rewrites from each initial
route, have the same distinction below. A “foreign” target means
a route assigned to a different artifact in `separate`; it is
inside the full map in `shared`.

| Request / transition                                                      | Full reference App                       | Production `shared`             | Production `separate`                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Normal page / endpoint                                                    | 200, own marker                          | Same                            | Same                                                                       |
| Matched endpoint returns its own 404                                      | 404 `OWN_404`                            | Same                            | Same                                                                       |
| Route rewrites to itself, query removed                                   | 200, middleware reruns                   | Same                            | Same; target stays within the selected set                                 |
| Middleware rewrites to the initial route                                  | 200, only final route executes           | Same                            | Same                                                                       |
| Route or middleware rewrites to `/target`, no rest/error routes (`plain`) | 200 `TARGET_ONLY`                        | Same status/body                | HTTP 500, empty body; target never executes                                |
| Same rewrite with global rest but no custom `/500` (`rest`, `direct`)     | 200 `TARGET_ONLY`                        | Same                            | Rejected Promise: missing component for `/[...rest]` during error recovery |
| Same rewrite with custom `/500` (`custom`, `nested`, `scoped`)            | 200 `TARGET_ONLY`                        | Same                            | Rejected Promise: missing component for `/500`                             |
| Rewrite to `/absent`, no rest/custom errors                               | 404 default Astro HTML                   | Same                            | Same default HTML; no foreign runtime loader required                      |
| Rewrite to `/absent` with rest route                                      | 200 `REST_ONLY`                          | Same                            | Rejected Promise; missing rest or `/500` error loader                      |
| Throw in selected page/endpoint, no rest/error routes                     | HTTP 500, empty body                     | Same                            | Same                                                                       |
| Throw in selected page/endpoint, global rest and no custom `/500`         | **200 `REST_ONLY`** on original pathname | Same                            | Rejected Promise: missing rest loader                                      |
| Throw in selected page/endpoint, custom `/500` exists                     | 500 `CUSTOM500`, original pathname       | Same status/body                | Rejected Promise: missing `/500` loader                                    |
| Request specific `/ep` deliberately sent to rest artifact                 | 200 `EP_ONLY` via full initial match     | Same                            | Initial policy rejects with 404; rest does not execute                     |
| Direct `/404` with retained static page                                   | 404, empty body in this reference setup  | 404 `CUSTOM404`                 | Same custom body when invoking a page artifact; preview serves client HTML |
| Unknown URL, no rest, custom static 404 (`scoped`)                        | 404, empty body in this reference setup  | 404 `CUSTOM404`                 | Page artifact: same custom body; preview also 404 custom body              |
| Base-free `/target` rewrite under `/nested/`                              | 200 `/nested/target`                     | Same                            | Foreign-loader rejection                                                   |
| Base-prefixed `/nested/target` rewrite                                    | 7.1.6 differs from 7.4.8; see below      | Matches its version's reference | 7.1.6 direct: default 404; other recorded cases reject; 7.4.8 rejects      |

Reference App does not receive `prerenderedErrorPageFetch` or
serve its client files. Its empty custom-static-404 body is a
reference-harness boundary. The adapter intentionally supplies
completed static HTML through `Scope404`; that difference is not
an adapter defect. A rewrite to a prerendered 404 can encounter
Astro's forbidden runtime-to-prerendered rewrite handling. The
`scoped` fixture records 500 with no body in full/reference and
shared, and a missing `/500` rejection in separate. Its custom
error page also sees the original rewrite query and can retry it;
do not generalize that result into an unconditional 404 rule.

For the base-prefixed payload, 7.1.6's `nested`/`scoped`
reference and shared runs return empty 500; their custom error
route retries the same query. The endpoint-only `direct` fixture
returns default 404. Astro 7.4.8 reference/shared render
`TARGET_ONLY` at `/nested/target/`. Version-specific rewrite
normalization/validation therefore matters. Only
`trailingSlash: "ignore"` is exercised; no general slash-policy
claim is made.

**Invocation versus preview:** where the generated handler
rejects, preview returns HTTP 500 with `Internal Server Error`.
Where Astro itself returns empty 500 (`plain`), preview preserves
that empty body. A request `/absent` deliberately sent to the
page/endpoint artifact when a global rest exists can get an
initial policy 404; the preview dispatcher instead selects the
rest artifact and returns its normal 200. This is an initial
artifact-selection difference, not a rewrite recovery mechanism.

### Minimal reproductions and loader consequences

Illustrative reduction of the archived fixture (the recipe owns
all exact bytes):

```ts
// src/pages/ep.ts, one selected route in separate mode
export async function GET(ctx) {
  if (ctx.url.searchParams.has("throw")) throw new Error("boom");
  const target = ctx.url.searchParams.get("to");
  if (target) return ctx.rewrite(target);
  return new Response("EP_ONLY");
}
// src/pages/target.ts, another artifact in separate mode
export const GET = () => new Response("TARGET_ONLY");
```

- **R1:** `plain`, `ep-other`, `/ep?to=/target`: reference and
  shared body `TARGET_ONLY|/target|{}|>/ep>/target`; separate
  HTTP 500 with an empty body. Both targets are ordinary accepted
  on-demand endpoints. This is the smallest rewrite
  counterexample.
- **R2:** `rest`, `ep-throw`, `/ep?throw=1`: reference/shared
  body `REST_ONLY|/ep|{"rest":"ep"}|>/ep>/ep`, status 200;
  separate rejects with `Error`, message
  `Unexpectedly unable to find a component instance for route /[...rest]`.
  `/500` matches the retained rest metadata. The rest loader was
  removed, so it never executes in separate.
- **R3:** `custom`, `page-throw`, `/page?throw=1`:
  reference/shared return 500 with `CUSTOM500`; separate rejects
  with `Error`, message
  `Unexpectedly unable to find a component instance for route /500`.
  Requesting the separate `/500` artifact directly succeeds with
  500 and `CUSTOM500`: its file exists in the build but was not
  included as a dependency of the throwing route's artifact.
- **R4:** `rest`, `ep-mw-other`, `/ep?mw=/target`:
  reference/shared load `EP_ONLY` and `TARGET_ONLY`, execute only
  `TARGET_ONLY`, and return 200. Separate loads `EP_ONLY`,
  executes neither endpoint, then rejects on the missing rest
  error loader. The middleware transition is a separate seam from
  an endpoint's `rewrite` call.

`loads` and `calls` expose actual evaluation/execution; the final
missing-error-loader message can obscure the earlier target
loader failure. It must not be read as evidence that the
application initially requested the rest route or `/500`. The
inventories find only `EP_ONLY` among recorded foreign/own route
markers in each separate `/ep` artifact, on both versions. This
excludes those fixture markers; it is not a generic
import-closure, computed-load, asset, or security proof.

### Production results versus selected-App probe #96

| Subject                                                                                            | What it establishes                                                                                                                                     | What must not be inferred                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| This production experiment                                                                         | Actual bridge, policies, pruning, generated dispatcher and preview behavior; confirmed missing transition loaders on both versions                      | Correct arbitrary file closure, cloud rejection mapping, or an adopted cross-function rewrite policy                  |
| Full standard reference here                                                                       | Same fixture's Astro responses, middleware effects and error-route choices with a complete loader map                                                   | Selected-file exclusion or independent per-route deployment                                                           |
| [#96 selected-App experiment](native-app-loader-expansion.md#isolation-policy-rewrites-and-errors) | Its guarded selected-App recipe has transition-policy failures; 7.1.6 copied closures exclude foreign code; unchanged 7.4.8 recipe fails file isolation | A production adapter defect by itself; a universal exception-to-500 contract; or impossibility of every native design |

Production's emitted-output partitioner still excludes the
recorded foreign route markers on 7.4.8, while #96's native
selected-App closure is rejected on that version. These findings
concern different build graphs. Neither cancels the other. The
earlier [pipeline](native-build-pipeline.md),
[isolation](native-app-isolation.md) and
[loader-expansion](native-app-loader-expansion.md) reports and
recipes were read before selecting these production-specific
variables; their already proven minimal closure cases were not
repeated as if they established production behavior.

## Classification and bounded follow-up work

| Classification                                                                                    | Evidence / guarantee                                                                                               | Scope of any later fix                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed compatibility defect D1: accepted cross-route rewrite loses its target in separate mode | R1/R4; #70's required-code packaging and shared/separate response equivalence; public Astro rewrite behavior       | A separate task must resolve the chosen cross-artifact execution contract, then add public-adapter route and middleware cases. The defect is the unannounced incompatibility; no particular dispatch or refusal policy is selected here.                            |
| Confirmed compatibility defect D2: a selected route cannot render its existing error fallback     | R2/R3; actual Astro-response preservation, #1/#4 error compatibility, #70 packaging                                | Track error-transition dependencies independently of ordinary rewrite permission. Regression: selected page and endpoint throw, custom `/500` in another artifact, compare exact reference/shared body/status and propagation. Include rest-as-error-route control. |
| Confirmed initial guard behavior                                                                  | Foreign specific request gets 404 in rest artifact; normal preview selection remains correct                       | Retain global priority metadata and initial guard regression when revising packaging. Does not define internal transition denial.                                                                                                                                   |
| Confirmed response ownership                                                                      | Endpoint `OWN_404`, reference rest-owned 200 after throw, preview's explicit catch                                 | Preserve the actual returned response; do not catch every error as 404 or force every historical throw to 500 without a policy change.                                                                                                                              |
| Documented limits                                                                                 | Direct pages/internal endpoints unsupported; custom 404 prerendered; cloud unverified; preview own error mapping   | No new runtime support or release claim.                                                                                                                                                                                                                            |
| Undefined contract                                                                                | Cross-artifact transport/refusal, later fallback scope/path, strict status overrides, portability of private hooks | User decisions below; design remains conditional.                                                                                                                                                                                                                   |

Under the current broad compatibility promise, dependencies
needed by an accepted execution are packaging obligations. This
does not mean every artifact is allowed to contain every route,
nor that every cross-function transport is approved. Initial code
exclusion, transition permission, and dependency delivery are
separate claims. A future accepted restriction can change the
permitted closure; a private loader-map limit cannot establish
that restriction by itself. The existing
[error ownership audit](../domain-error-audit.md) requires this
producer-versus-input distinction.

Recommended follow-up task wording, not a code change: “Resolve
separate-mode transition compatibility for accepted
route/middleware rewrites and Astro error fallback. Preserve
reference response semantics under the selected user-approved
policy, account for required loaders and transitive files, and
retain initial route precedence, copied 404 behavior and direct
invocation restrictions. Exercise R1–R4 through generated public
adapter fixtures on the affected and current supported versions.”

```text
proposed regression surface, after policy decision
public adapter build -> generated route artifact -> route/middleware transition
  compare reference status/body and original error causes
  independently verify selected code/dependency closure
```

## Validation and limits

- `pnpm install --frozen-lockfile`, `pnpm build`,
  `pnpm typecheck` and `pnpm lint` passed on the repository
  dependency graph.
- Node 22.12.0 `pnpm test` passed: **385 tests in 23 files**.
- Node 22.12.0 `pnpm pack:check` passed, including clean packed
  consumers and publication dry run; no package was published.
- `pnpm check` stopped at `format:check` because the pre-existing
  modified `skills-lock.json` uses a different format. It was not
  silently reformatted or committed. Research files receive their
  own formatting check; CI checks committed contents.
- Both recorded probe runs completed; a disposable JSON verifier
  checked successful builds, own requests/404s, self rewrites,
  reference/shared equality for the principal cases, foreign
  rewrite outcomes, missing custom error loaders, initial
  specific/rest rejection, marker exclusion and the source hash.
- Fresh extraction of the published recipe and both frozen
  environments passed again. All 780 response/error/call/load
  tuples and 168 preview status/body results matched the archived
  run exactly; environment lock bytes were unchanged. Build
  output hashes vary and are not an equality requirement.
- The archive is research evidence, not a new permanent test
  runner/framework. Existing regression conventions stay intact.
- No cloud invocation or local S3 service was run for this
  investigation. Existing CI includes S3, compatibility and
  beta-version rehearsal; its state belongs in the PR handoff.
- No actions, islands, renderer integrations, streaming,
  sessions, assets, package-bearing route, non-string rewrite
  payload, `next(payload)`, recursive nested/dynamic 404 scope,
  slash-policy matrix, or arbitrary computed loads are
  established by these fixtures. Existing tests/source promises
  for those features are not erased by this bounded experiment.
- File inventories and native Astro module IDs are observations,
  not the independent-directory closure proof used in #95/#96.
  Original source/dependency paths remain available during these
  local handler runs. No independent-deployment claim is made.

## Astro primary sources

Context7 resolved `/withastro/docs`; separate scoped queries
covered rewrite/middleware behavior and custom error pages.
Current official docs describe rewrite as another rendering phase
with middleware re-execution, and describe on-demand custom 500
pages. Exact version differences were verified against installed
source and execution, not inferred from unversioned docs.

- [Astro rewrite API](https://docs.astro.build/en/reference/api-reference/#rewrite),
  [middleware rewrites](https://docs.astro.build/en/guides/middleware/#rewriting),
  [custom 500 pages](https://docs.astro.build/en/basics/astro-pages/#custom-500-error-page).
- [7.1.6 route-loader acquisition and rewrite](https://unpkg.com/astro@7.1.6/dist/core/app/pipeline.js),
  `getModuleForRoute`, `tryRewrite`;
  [7.1.6 internal rewrite execution](https://unpkg.com/astro@7.1.6/dist/core/rewrites/handler.js).
- [7.1.6 error route matching](https://unpkg.com/astro@7.1.6/dist/core/errors/default-handler.js),
  `renderError`, `mergeResponses`;
  [7.1.6 routing handler](https://unpkg.com/astro@7.1.6/dist/core/routing/handler.js).
- [7.4.8 production loader/rewrite environment](https://unpkg.com/astro@7.4.8/dist/core/environment/production.js),
  `getModuleForRoute`, `tryRewrite`;
  [7.4.8 error handler](https://unpkg.com/astro@7.4.8/dist/core/errors/default-handler.js),
  [routing handler](https://unpkg.com/astro@7.4.8/dist/core/routing/handler.js).

Repository citations above refer to the researched base. Their
line positions can be inspected with `git show 84584c8:<path>`
and `nl -ba`; no production path was renamed by this PR.

## Decisions reserved for the user

The following are proposed choices, not adopted rules. Their
status must remain visible in the dependent design.

1. **Cross-route rewrites in separate mode.** A full-compatible
   transition closure or explicit dispatch can preserve Astro
   behavior, at the cost of duplicated code/dependencies or a new
   runtime routing mechanism. An explicitly constrained build can
   reject known incompatible partitioning and guide users to
   `shared`; dynamic targets prevent an assumption that all
   rewrites can be statically enumerated. An artifact-local
   runtime refusal is a third choice that narrows compatibility;
   its status/body must be decided explicitly. Recommendation:
   preserve observed Astro behavior as the compatibility goal;
   require an explicit supported boundary before shipping a
   narrower separate mode. Do not silently implement 404 denial.

   ```text
   A -> rewrite(B), B assigned elsewhere
     compatible transition closure / dispatch
     OR explicit build/configuration restriction
     OR explicit runtime refusal with chosen status/body
   ```

2. **Error-route dependencies and status.** Preserve Astro's
   actual error renderer and Response, including rest-owned 200,
   or adopt a stricter rule that a throw always yields 500.
   Recommendation: preserve reference behavior under the current
   response contract; a universal 500 rule needs an explicit
   amendment and regression expectations. Decide whether error
   loaders are part of each selected execution closure even when
   ordinary cross-route rewrites are refused.

   ```text
   route throws -> Astro resolves /500 -> page or rest Response
     preserve Astro outcome | explicitly revise error semantics
   ```

3. **Fallback after an internal transition.** If a rewrite is
   refused or unmatched, choose original versus target pathname
   for scope selection, static fallback versus plain body,
   status, and middleware effects. A copied 404 file is not
   evidence that these rules have been chosen. Recommendation:
   document this separately from initial unknown-URL fallback.
4. **Propagation boundary.** Keep rejected invocation Promises
   distinct from translated HTTP responses and preview 500s, or
   explicitly define a new fault-to-HTTP mapping. Recommendation:
   preserve original cause and never classify a missing promised
   loader as invalid external input merely to fit a 404 guard.
5. **Compiler/runtime integration boundary.** Any private Astro
   transition interception or native selected-file technique must
   be evaluated for supported versions and full closure delivery.
   #96's selected-App file failure on 7.4.8 grants no permission
   to change supported versions or use a second application
   bundler. Recommendation: keep the design conditional until
   choices 1–3 and the corresponding proof obligations are
   agreed.

The glossary needs no new accepted term from this investigation.
If documenting existing guarantees, proposed wording is: “An
initial route-policy rejection and an internal Astro rewrite are
distinct operations; an initial guard alone does not establish
transition isolation.” Put this implementation fact in runtime or
research documentation, not in a glossary definition. No ADR is
amended by this PR. A future narrower rewrite or stricter-error
policy must name its conflict with response compatibility and
record the user's decision explicitly.
