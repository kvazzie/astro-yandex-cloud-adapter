# Compiled middleware and renderer acquisition for selected Apps

Executed on 2026-11-09 from
`fa3f27ecb959f0266d89d1b8a49352185237bdb7`, the head of
`feat/complete-beta-routing` after
[PR #95](https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/95).
Its checked head, `a48ca135bd1b0182f22180dc7cfbdde3a51d59e1`, is
an ancestor. The checkout was clean. This extends the
[previous experiment](native-app-isolation.md); its evidence
remains unchanged. No production source, root dependency, machine
configuration, or test framework changed. The
[_Bare Adapter_](../../GLOSSARY.md#bare-adapter) was not
migrated.

## Result

Compiled user and injected middleware, and a real Preact
renderer, can be attached to selected Apps. **The complete
isolation requirement is not met.**

- Astro 7.1.6 produces independent candidate directories,
  including Preact SSR. Allowed rewrites work. Foreign rewrites
  and route errors expose gaps in the initial-request guard.
- Astro 7.4.8 executes the same requests, but every candidate
  directory contains foreign source modules and markers. Its
  public App runtime imports the global manifest transitively.
  Successful responses from these rejected directories do not
  establish code exclusion.
- Classic middleware and generic renderer acquisition use private
  compiler virtual modules. Edge middleware has a public physical
  entry URL, but that does not establish classic acquisition or
  provider edge execution.

Observed flow, with one native Astro build per fixture:

```text
standard seed entry -> structured manifest + full reference App
public App + public setup.pages source IDs
private compiled classic chain / public edge middleware URL
private compiled renderer array
  -> final native graph -> copied directories + selected-loader glue
  -> reference, guarded, unguarded and omitted-loader controls
```

No second application bundler or emitted-code rewrite was used.
This follows
[ADR 0002](../adr/0002-use-astros-build-pipeline-for-runtime-artifacts.md).
The production responsibilities in
[ADR 0003](../adr/0003-concentrate-target-policy-in-target-drivers.md)
remain unchanged. No runtime interception or production
workaround was attempted.

## Versions and provenance

The registry returned Astro 7.4.8 as the current stable Astro 7.
Its [package engines](https://unpkg.com/astro@7.4.8/package.json)
require Node `>=22.23.4`. Both probe runs used Node **26.13.0**,
Linux x64, and pnpm **10.34.9**. They resolved Vite **8.3.7** and
Rolldown **1.2.18**. Assertions check the chosen Astro version,
engines, toolchain and renderer versions; they were not removed.

Both isolated dependency environments pin `@astrojs/preact`
**6.0.0**, Preact **10.29.8**, `preact-render-to-string`
**6.8.2**, and TypeScript **5.9.3**. Holding the integration and
bundler versions constant makes the Astro-version comparison more
useful. This is not a claim about every current integration
version. The complete resolved package graph and both dependency
lockfiles are in the evidence. No runtime package installation is
needed for the accepted 7.1.6 directories; their only external
ESM edge is `node:module`.

The earlier #95 evidence used Vite 8.2.0 and Rolldown 1.2.3. Its
two fixture sources are preserved in this recipe and rerun under
the newly recorded toolchain. New evidence does not replace those
earlier hashes or results.

- [Extractable recipe and commands](native-app-loader-expansion-recipe.md).
- [JSON evidence](native-app-loader-expansion-results.json),
  including source hash, dependency locks, per-file hashes and
  edges, full retained chunk module IDs, route metadata,
  acquisition methods, responses and policy comparisons.
- Archived source SHA-256:
  `b8b271d711067d1a7a04fe48781c3bd81542094a5cce2b9e17ff1a7499fd31b3`.

## Fixture by version

File counts include the generated glue. Each row describes two
selected sets. The expanded fixtures select `specific + allowed`
and `rest + error`. Their base is `/nested/`, with specific
endpoints or a page preceding the rest endpoint. The Preact page
imports an actual JSX component without a hydration directive.
The renderer is registered by the official integration. S1-S5
below.

| Fixture                             | Astro | Files in selected sets | Observed execution                                        | File isolation                         |
| ----------------------------------- | ----- | ---------------------- | --------------------------------------------------------- | -------------------------------------- |
| Original two endpoints              | 7.1.6 | 6 / 6                  | Own 200; guarded foreign 404                              | Accepted                               |
| Original page and rest              | 7.1.6 | 8 / 7                  | Page SSR; specific/rest precedence retained               | Accepted                               |
| User + injected middleware, classic | 7.1.6 | 11 / 11                | Pre/user/post headers and locals; allowed rewrites 200    | Accepted; transition policy fails      |
| User + injected middleware, edge    | 7.1.6 | 10 / 10                | Public edge URL supplies the compiled chain; same effects | Accepted; transition policy fails      |
| Preact page + classic middleware    | 7.1.6 | 16 / 12                | Real component SSR from independent directory             | Accepted; transition policy fails      |
| Original two endpoints              | 7.4.8 | 17 / 17                | Own 200; guarded foreign 404                              | Rejected, foreign code present         |
| Original page and rest              | 7.4.8 | 18 / 18                | Page SSR; specific/rest precedence retained               | Rejected, foreign code present         |
| User + injected middleware, classic | 7.4.8 | 25 / 25                | Pre/user/post effects; allowed rewrites 200               | Rejected; transition policy also fails |
| User + injected middleware, edge    | 7.4.8 | 23 / 23                | Public edge URL supplies the compiled chain; same effects | Rejected; transition policy also fails |
| Preact page + classic middleware    | 7.4.8 | 29 / 28                | Real component SSR from a rejected directory              | Rejected; no independent SSR claim     |

All twenty copied candidates execute in fresh child processes
with original fixture and dependency paths unavailable. For
7.4.8, `runtimeCaveat` explicitly labels execution after closure
rejection. The full standard reference App also executes in a
separate child process per fixture before those paths are
renamed. It has every loader and supplies comparison evidence,
not isolation evidence.

## Acquiring the compiled chain and renderer

| Input               | What the experiment receives                                                                           | Classification                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Classic middleware  | `middlewareEntryPoint === undefined`; explicitly emit a wrapper importing `virtual:astro:middleware`   | Private acquisition                                         |
| Edge middleware     | Physical URL from `astro:build:ssr.middlewareEntryPoint`; use its relative file as a native-graph root | Public acquisition of this mode's entry URL                 |
| User middleware     | Real `src/middleware.ts`, composed into the chain                                                      | Public authoring contract                                   |
| Injected middleware | Public `addMiddleware` with `order: pre` and `order: post`                                             | Public registration, compiled composition supplied by Astro |
| Preact renderer     | Emit a wrapper importing `virtual:astro:renderers`; assign its compiled array to `manifest.renderers`  | Private generic acquisition                                 |

The executed private wrappers are minimal:

```js
export { onRequest } from "virtual:astro:middleware";
export { renderers } from "virtual:astro:renderers";
```

The middleware plugin builds `sequence(pre, user, post)`. Each
injected handler sets its own response header, and user
middleware sets `x-probe-user`. Endpoints return the observed
locals trace `pre>user>post`. The Preact component renders that
trace into HTML. Removing the middleware assignment removes its
headers. Removing the renderer assignment prevents the selected
page's SSR and reaches the missing-rest-loader error. These
controls run in fresh Apps. S2-S4.

The serialized callback manifest contains `renderers: []` in both
versions. Public registration metadata describes renderer
entrypoints; it does not return the compiled runtime references.
Astro's renderer virtual module imports each registered server
entry and assigns its default export as `ssr`. The probe does not
hard-code Preact's server entrypoint. S3-S4.

The public edge URL includes user and injected middleware in the
executed fixtures. It supplies no evidence of independently
deployed edge execution, prerendered middleware behavior, or
classic-mode compiled discovery. Likewise, using private virtual
modules here is a version-bound compiler dependency, not a public
selected-loader compiler contract. The seed-global-entry timing
dependency and `{ page() }` wrapper from #95 remain. S1-S4.

## Isolation policy, rewrites and errors

The probe defines the following policy independently of loader
failures:

```text
initial route or rewrite target in selected set -> render it
initial route or rewrite target outside set    -> 404
an exception inside a selected route           -> 500
```

This last rule is deliberately stricter than the observed default
reference behavior. It expresses the isolation requirement, not
an assertion that Astro enforces it. All route metadata remains
present. The outer guard checks the initial `app.match()` result
against the selected map before `app.render()`. The original
specific/rest negative control still proves that removing this
guard can turn a foreign specific request into a successful rest
response.

Expanded requests use public `ctx.rewrite()` or `Astro.rewrite()`
inside a route, and `ctx.rewrite()` inside user middleware.
Rewrite payloads are `/allowed` and `/anything`; incoming
requests retain `/nested/`. Base-prefixed rewrite payloads and
the slash-policy matrix are not covered by the recorded run. An
exploratory `/nested/allowed` payload returned the default 404 on
7.1.6; the recipe does not generalize from that exploratory
result.

These results repeat on both versions and in all three expanded
fixtures. On 7.4.8 they describe responses from rejected,
contaminated closures.

| Request                                                | Policy for selected set | Full reference App  | Selected App with initial guard                |
| ------------------------------------------------------ | ----------------------- | ------------------- | ---------------------------------------------- |
| Ordinary selected route                                | 200                     | 200                 | 200, middleware observed                       |
| Direct foreign route                                   | 404                     | 200                 | 404, body `Not Found`                          |
| Route rewrite to `allowed`                             | 200                     | 200, allowed marker | 200, allowed marker                            |
| Middleware rewrite to `allowed`                        | 200                     | 200, allowed marker | 200, allowed marker                            |
| Route rewrite to absent rest loader                    | 404                     | 200, rest marker    | Rejected promise, missing rest component       |
| Middleware rewrite to absent rest loader               | 404                     | 200, rest marker    | Rejected promise, missing rest component       |
| Throw inside selected `specific`                       | 500                     | 200, rest marker    | Rejected promise, missing rest component       |
| Throw inside selected `error`, with rest also selected | 500                     | 200, rest marker    | **200**, `PROBE_REST_ONLY:error:pre>user>post` |

The `error` endpoint throws intentionally. Its selected peer rest
endpoint returns normally. That prevents a second throw in the
fallback from hiding the successful-rest-response counterexample.
No catch-all conversion to 404 was added. JSON retains the
original rejected-promise message rather than inventing an HTTP
status for it.

Source explains both failures. Rewrites resolve a new route and
acquire its loader internally. Error handling resolves `/500`
against the retained route list. The rest endpoint can match it
and return its own status 200 with the original pathname.
Preserving metadata and guarding the first match do not enforce
policy at those later transitions. S5-S6.

## Why 7.4.8 fails file isolation

This is a real import dependency, not merely different chunk
names:

```text
astro/app -> App -> BaseApp -> DefaultFetchHandler
  -> core/manifest/ambient.js
  -> #astro-internal/ambient-manifest
  -> virtual:astro:manifest -> global pageMap -> all page loaders
```

Astro resolves the ambient import to its global virtual manifest
during Vite processing. Passing an App-specific manifest changes
request dispatch but does not remove that static import graph.
The copied endpoint-only candidates already include the foreign
endpoint's source and marker. The Preact rest set also contains
the foreign page's JSX component source and marker. S7.

The global manifest's placeholder is replaced after
`generateBundle`, so each 7.4.8 candidate records a changed final
App chunk as well. The checker records both hashes, parses final
edges, and copies the completed bytes verbatim. It continues to
find and report foreign sources instead of weakening the
exclusion assertion or treating the hash mismatch as the only
problem. S4.

The observed failure does not prove that every possible native
configuration fails. It disproves transferring this selected-App
recipe unchanged to 7.4.8. Changing private ambient-manifest
resolution, replacing runtime internals, or accepting a
version-pinned compiler integration would require a separate
architecture decision and experiment. None was applied here.

## Evidence boundaries

Proven by execution:

- Five fixtures on each Astro version, ten native builds total,
  with twenty copied candidates and ten full reference processes.
- Full physical file inventories, final static/dynamic ESM edge
  parsing, native-edge comparison, marker checks, retained chunk
  module-ID checks, and verbatim copying. The glue's imports are
  parsed separately.
- Independent 7.1.6 directories, real middleware and Preact SSR,
  non-root base, precedence, omitted-middleware and
  omitted-renderer controls.
- 7.4.8 foreign-source exclusion failures and the
  transition-policy failures described above. Passing
  reproduction means these negative results were detected and
  asserted.

Source inspection, not broader runtime coverage:

- Generic composition of registered middleware and renderers,
  callback mode gating, ambient import resolution, and the
  changed runtime implementation.
- 7.1.6 uses `AppPipeline`; 7.4.8 uses a production render
  environment and function-based request/error handling. This
  experiment does not establish a portable private interception
  point. S5-S7.

Unknown or outside the fixture:

- Authored CSS, assets, client hydration, arbitrary computed
  filesystem or CommonJS loads, other renderers, and package
  installation strategies. The accepted fixtures need no
  non-builtin runtime packages. The rejected latest graph also
  pulls image-related code; complete delivery of its native or
  computed loads is not claimed merely because page requests
  execute.
- Actions, server islands, custom fetch, sessions/cache, i18n,
  malformed URLs, redirects, a slash-policy matrix, custom 404
  pages, cloud execution, and production adapter parity.
- Byte-identical rebuilds. Manifest keys and temporary paths
  vary. Hashes identify observed files; dependency locks and the
  source hash identify how to reproduce the behavior.

The recipe temporarily renames original paths; it does not create
an OS security boundary. The standard seed entry remains
necessary for structured manifest acquisition. No stable public
compiler contract is inferred from the public App export alone.

## Repository validation

- Both recorded probe runs passed their positive and negative
  assertions on Node 26.13.0, with the exact versions above.
- The complete extraction and reproduction commands passed again
  in fresh dependency environments using the archived frozen
  lockfiles and source.
- `pnpm check` passed on Node 22.12.0, including types, lint,
  formatting, **385 tests in 23 files**, and the package build.
- `pnpm pack:check` passed on Node 22.12.0. Its publication step
  was a dry run.
- The three new documents passed Prettier and `git diff --check`.

The PR reports CI separately. Adapter compatibility CI does not
run the archived experiment and cannot substitute for its
per-version evidence. Local cloud and local S3 execution are
outside this research run.

## Primary sources

Context7 selected `/withastro/docs`; scoped queries covered
middleware, renderer registration and Preact SSR separately.
Exact behavior was checked against installed versioned source. An
independent background source review confirmed the public/private
classification. Registry metadata and installed lockfiles
supplied the actual versions.

- **S1:** Public integration callbacks and `setup.pages`
  evidence:
  [7.1.6 declarations](https://unpkg.com/astro@7.1.6/dist/types/public/integrations.d.ts),
  [7.4.8 declarations](https://unpkg.com/astro@7.4.8/dist/types/public/integrations.d.ts),
  [official adapter reference](https://github.com/withastro/docs/blob/main/src/content/docs/en/reference/adapter-reference.mdx).
- **S2:** Middleware composition, split input and physical URL:
  [7.1.6 middleware plugin](https://unpkg.com/astro@7.1.6/dist/core/middleware/vite-plugin.js),
  [7.4.8 middleware plugin](https://unpkg.com/astro@7.4.8/dist/core/middleware/vite-plugin.js).
- **S3:** Generic compiled renderer construction:
  [7.1.6 renderer plugin](https://unpkg.com/astro@7.1.6/dist/vite-plugin-renderers/index.js),
  [7.4.8 renderer plugin](https://unpkg.com/astro@7.4.8/dist/vite-plugin-renderers/index.js),
  [Preact 6.0.0 registration](https://unpkg.com/@astrojs/preact@6.0.0/dist/index.js),
  [its SSR implementation](https://unpkg.com/@astrojs/preact@6.0.0/dist/server.js),
  [official Preact guide](https://github.com/withastro/docs/blob/main/src/content/docs/en/guides/integrations-guide/preact.mdx).
- **S4:** Mode gate, serialized metadata, post-build replacement
  and loader assignment:
  [7.1.6 manifest build](https://unpkg.com/astro@7.1.6/dist/core/build/plugins/plugin-manifest.js),
  [7.4.8 manifest build](https://unpkg.com/astro@7.4.8/dist/core/build/plugins/plugin-manifest.js),
  [7.1.6 runtime manifest](https://unpkg.com/astro@7.1.6/dist/manifest/serialized.js),
  [7.4.8 runtime manifest](https://unpkg.com/astro@7.4.8/dist/manifest/serialized.js).
- **S5:** Selected loading and rewrite transition:
  [7.1.6 AppPipeline](https://unpkg.com/astro@7.1.6/dist/core/app/pipeline.js),
  [7.4.8 production environment](https://unpkg.com/astro@7.4.8/dist/core/environment/production.js),
  [7.1.6 rewrite handler](https://unpkg.com/astro@7.1.6/dist/core/rewrites/handler.js),
  [7.4.8 rewrite handler](https://unpkg.com/astro@7.4.8/dist/core/rewrites/handler.js).
- **S6:** Error transitions and endpoint response handling:
  [7.1.6 request handler](https://unpkg.com/astro@7.1.6/dist/core/routing/handler.js),
  [7.1.6 default errors](https://unpkg.com/astro@7.1.6/dist/core/errors/default-handler.js),
  [7.4.8 request handler](https://unpkg.com/astro@7.4.8/dist/core/routing/handler.js),
  [7.4.8 default errors](https://unpkg.com/astro@7.4.8/dist/core/errors/default-handler.js),
  [endpoint responses](https://unpkg.com/astro@7.4.8/dist/runtime/server/endpoint.js).
- **S7:** Latest runtime's global import path:
  [BaseApp](https://unpkg.com/astro@7.4.8/dist/core/app/base.js),
  [DefaultFetchHandler](https://unpkg.com/astro@7.4.8/dist/core/fetch/default-handler.js),
  [ambient manifest](https://unpkg.com/astro@7.4.8/dist/core/manifest/ambient.js),
  [Vite ambient alias resolution](https://unpkg.com/astro@7.4.8/dist/manifest/serialized.js).
