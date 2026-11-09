# Native build pipeline and emitted-output processing

Researched on 2026-11-07 and verified on 2026-11-08. Three
parallel investigations covered route evidence, function
partitioning, and build completion. This note records findings,
not an implemented refactor.

## Scope and evidence

The inspected checkout was `feat/complete-beta-routing` at
`b42395f11e9e56d2645b0c4195488df6a2c7be4a`, including its
uncommitted module reorganization. Adapter paths below name that
working tree, not files introduced by this documentation PR. Its
domain glossary is `GLOSSARY.md`; the committed base still keeps
the glossary in `CONTEXT.md`. This note introduces no new domain
terms, Entities, or Value Objects.

Actual dependency resolution gave Astro **7.1.6**, Vite
**8.2.0**, and Rolldown **1.2.3**. Other versions in the pnpm
store were not treated as active dependencies. Context7 supplied
official documentation; because its Astro index covers earlier
releases, exact lifecycle claims were checked against installed
7.1.6 declarations and executable source.

The source references at the end identify those installed package
files. Public documentation and version-specific source evidence
are distinguished from proposed designs and untested migrations.

## Conclusion

Keep using Astro's native pipeline as required by ADR 0002.
Replace unnecessary reconstruction of emitted code with
structured hook data first. Do not assume that moving every
operation into `generateBundle` is either possible or sufficient.
No second application bundler is required for the operations
examined here.

One Astro lifecycle can build several native environments. That
is distinct from an adapter launching another application bundler
after Astro finishes. The installed orchestration and a
disposable observer build showed:

```text
prerender generateBundle
SSR generateBundle, when required
client generateBundle
astro:build:ssr with structured manifest
prerendered pages and optimized images generated
astro:build:generated
additional assets and cleanup
astro:build:done
```

The observer recorded the public hooks, not the internal
rendering calls. The latter ordering was established from the
owning implementation. See [Astro lifecycle
documentation][hooks], installed source references S1-S3, and the
validation record below.

## Operation decisions

| Existing operation                                            | Finding                                                                                     | Proposed treatment                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Recover component identities by parsing `deserializeManifest` | The public SSR hook supplies `manifest.routes[].routeData.route/component`                  | Capture a narrow per-build mapping from `astro:build:ssr`; validate injected/package routes, then delete this parser |
| Detect actual server-island demand                            | Native discovery exists, but its metadata/plugin interface is private                       | Prototype observation and compatibility before replacing emitted-output evidence                                     |
| Find image calls reachable from runtime routes                | Native module/chunk graphs can supply inputs; no public `usesRuntimeImages` flag was found  | Prototype equivalent reachability, including Actions, islands and tree-shaking; imports alone are insufficient       |
| Prune unrelated page/island loaders                           | Public custom inputs exist, but `createApp()` still imports a global page map               | Prototype isolated native output; several wrappers alone do not prove isolation                                      |
| Walk selected local imports and URL assets                    | Native chunk metadata supplies graph information                                            | Compare it with the final selected closure, including assets and late Astro changes, before deleting the walk        |
| Rewrite the compiled handler export to bind policy            | Our handler already accepts policy as its fourth argument                                   | Prototype a plain ESM facade importing the compiled handler; this can eliminate export-name AST discovery            |
| Validate retained runtime imports                             | Requires the final selected files, not necessarily files on disk                            | Can consume final native chunks in memory once partitioning is settled                                               |
| Generate package/lock metadata                                | Constant bundle metadata can be early; install metadata depends on selected runtime imports | Compute from the selected closure; dependency resolution is not another application bundle                           |
| Reconcile final pages, static endpoints and runtime URLs      | Registered routes alone do not establish actual generated output                            | Retain completed-render evidence unless an equivalent observation mechanism is demonstrated                          |
| Compute concrete recursive 404 scopes and copy bodies         | Dynamic prerender paths and completed HTML are needed                                       | Finalize after prerender; a bundler output hook alone is too early                                                   |
| Assign deployable function directories and preview dispatch   | Shared chunks do not automatically make independent directories                             | Keep placement policy; prototype any virtual preview replacement separately                                          |
| Finalize manifest and Gateway template                        | Must describe actual files, route assignments and chosen preparation                        | Keep final reconciliation and writing after required evidence is available                                           |

Current owners are `mandatory/ArtifactGeneration`, its
`RouteRequirements` and `RuntimeImageRoutes.ts`, and
`conditional/FunctionArtifact` with `Partition/index.ts`,
`Prepare.ts` and `.plan.ts`. Evidence comes from S1-S7 and [the
public adapter interface][adapter]. The proposed treatments are
engineering conclusions, not claims that migrations already pass
tests.

## Why the structured SSR manifest is actionable

`Partition/index.ts` currently reconstructs route/component
identities from serialized JavaScript. Astro builds the same
structured route records, passes them to `astro:build:ssr`, and
only then serializes them into output. The observer build
confirmed that the hook exposes the prerendered `/` component and
the on-demand `/_server-islands/[name]` component. S2, S4.

Proposed change, not applied:

```text
Before: emitted JS -> deserializeManifest AST -> route/component map
After:  public astro:build:ssr manifest -> narrow route/component map
```

This improves locality without inventing a new domain object. The
map can remain private integration build state. A focused
migration must preserve no-SSR-output handling and final
component identities for injected/package routes.

The old `functionPerRoute` option and SSR hook `entryPoints` map
are not available solutions. The latter was removed in Astro 6
after the former's deprecation. See [the migration
guide][migration] and S4.

## Why full native partitioning needs a prototype

The current production `createApp()` imports the global manifest,
which imports the page map containing runtime route loaders.
Adding entrypoints that all call the same handler can therefore
retain unrelated route code. There is no inspected public
`createApp` route-selection argument. S5.

Proposed experiment, not a proven design:

```text
native per-route input
  -> selected route code and required common code
  -> independent function directory
  -> execute route, Actions and island fixtures
  -> verify unrelated code and dependencies are absent
```

Preserve full routing metadata where precedence requires it.
Removing a specific route's metadata can make a retained rest
route incorrectly accept its URL. Existing `allowedRoutes` checks
do not replace precedence.

Native plugins can inspect chunks via `imports`,
`dynamicImports`, `moduleIds` and related metadata. This does not
prove that a snapshot in `generateBundle` is final: Astro injects
serialized manifest data after the native environment builds.
Island maps have different timing; their emitted references are
populated in `renderChunk`. S1, S2, S6; [Vite plugin
documentation][vite].

Astro's plugin `api.buildPostHook` and island
`api.hasServerIslands()` reveal implementation timing, but they
are not public adapter contracts. Do not replace one private
dependency with another and describe it as a supported public
interface.

## Handler policy can be bound without discovering an export name

Our existing `.astroHandler.ts` handler accepts policy as its
fourth argument. A generated ESM facade could call that existing
interface:

```js
// Proposed generated index.js, not an implemented migration.
import { handler as invoke } from "./core-handler.js";

export const handler = (event, context, previewUrl) =>
  invoke(event, context, previewUrl, {
    // Final allowedRoutes and notFound policy go here.
    artifactDirectory: new URL("./index.js", import.meta.url),
  });
```

This removes dependence on a renamed compiled export. It does not
isolate routes by itself. Core-file placement, relative imports,
preview, entrypoint validation and dependency scanning need
tests. Early-known settings may use a virtual module; completed
404 policy must wait for its actual evidence.

## What remains in Artifact Generation

[_Artifact Generation_](../../CONTEXT.md#responsibility-boundary)
names the adapter-owned process. It does not require a separately
materialized server output Value Object. The current
`completeBuild` module coordinates evidence collection, route
reconciliation, selected preparation, and final
[_Deployment Manifest_](../../CONTEXT.md#deployment-model) and
Gateway output. Extracting compiler interpretation does not
remove that coordination.

Final HTML still contributes runtime URL evidence. Concrete 404
output and static endpoint assets are produced after native
bundle generation. Plugins can perform I/O, so this is a
data-availability constraint, not an assertion that plugins
cannot write files. S1-S3, S7.

Preserve the preparation contract: planning reads but does not
mutate output; required copies precede removal of their sources;
application stops at the first error. Earlier successful writes
may remain. This work does not introduce rollback or idempotence
guarantees.

## Recommended order and proof obligations

1. Replace route/component reconstruction using the public SSR
   manifest.
2. Prototype the handler facade to remove export rewriting.
3. Prototype native per-route output before committing to a
   module for all current emitted-output transformations.
4. Compare native island/image evidence with current behavior,
   including private-metadata compatibility costs.
5. Keep final page/file reconciliation until equivalent evidence
   is proven.

Use the existing integration behavior as the test surface:
independent function execution and unrelated-code exclusion,
specific/rest precedence, Actions, deferred islands, islands used
only on-demand, non-root base, per-function install dependencies,
runtime images, and static-only builds. These are covered in
`tests/integration/partitioning.test.ts`, `runtime-image.test.ts`
and `build.test.ts` in the inspected working tree. No
native-partitioning prototype or migration was implemented here.

## Validation record

A disposable observer integration built the existing
`server-island` fixture with installed Astro 7.1.6, Vite 8.2.0
and Node 26.13.0. Output/cache were redirected to a temporary
directory. It completed successfully and observed
`generateBundle` for prerender, SSR and client before
`astro:build:ssr`, followed by `astro:build:generated` and
`astro:build:done`. The public SSR manifest contained
route/component identities for `/` and `/_server-islands/[name]`.
This verifies hook timing and data availability for one fixture,
not full feature equivalence.

The fixture logged the existing unsupported-Sharp feature
diagnostic and still completed. No Sharp compatibility claim
follows. The adapter's built package was used unchanged. Existing
full integration and cloud suites were not rerun for this
documentation-only investigation.

## Native multi-entry experiment, 2026-11-09

After #91/#92/#93 merged into the working architecture branch, a
disposable experiment tested whether multiple native entries
around the same `createApp()` handler isolate route code. No
adapter source was modified. The fixture had two on-demand
endpoints returning distinct markers. A Vite plugin restricted to
the SSR environment emitted two named chunks with Rolldown's
`emitFile({ type: 'chunk', id, fileName })`. Both entries
imported the same handler. Astro performed the application build;
the probe did not invoke another bundler or override private
virtual modules.

Observed result on the installed Astro 7.1.6 pipeline:

| Observation                                  | Entry one | Entry two |
| -------------------------------------------- | --------- | --------- |
| Separate entry file emitted                  | Yes       | Yes       |
| Transitive chunk closure includes marker one | Yes       | Yes       |
| Transitive chunk closure includes marker two | Yes       | Yes       |

Calling entry one's handler for `/one` returned HTTP 200 and
`PROBE_ONE_ONLY`; calling it for `/two` returned HTTP 200 and
`PROBE_TWO_ONLY`.

```text
entry one ─┐
           ├─ shared handler / createApp -> global page map -> both routes
entry two ─┘
```

This falsifies the simple proposal that emitting multiple facades
around the existing app entrypoint provides route isolation. It
does not prove that all native partitioning designs are
impossible. File selection must still exclude unrelated code; an
allowlist at invocation time alone does not establish that
exclusion.

The production `createApp()` implementation imports a global
manifest (S5). The exported `App` constructor is a candidate for
further investigation, not a verified feature-preserving
replacement. A package export alone does not establish a
documented per-route compiler contract. Pages, middleware,
Actions, islands, assets and routing precedence remain proof
obligations.

The probe used a minimal custom adapter and endpoints, not the
complete Yandex handler or separately deployed directories. Its
closure inspection used native `imports`/`dynamicImports`
metadata. A default unsupported-Sharp diagnostic was logged; the
build and both endpoint requests nevertheless completed. This
experiment establishes no image-runtime compatibility.

The source and raw results are retained locally outside the
repository at
`~/.local/share/codex/reports/native-isolation-probe/run.mjs` and
`results.json`. Run the probe with Node from the same checkout
environment; its absolute checkout path is explicit in the
source. These are disposable research artifacts, not a new
repository test convention.

## Installed primary source references

Paths are relative to the resolved package root.
Published-package links identify the inspected version rather
than current-main source.

- **S1:** [Astro 7.1.6 static build][s1],
  `dist/core/build/static-build.js:103-128,151-196,217-245,299-303`.
  Environment builds, manifest postprocessing and server-build
  conditions.
- **S2:** [Astro manifest construction][s2],
  `dist/core/build/plugins/plugin-manifest.js:34-60,138-160,239-288`.
  Structured hook data followed by serialized injection.
- **S3:** [Astro page generation][s3],
  `dist/core/build/generate.js:177-206`, plus
  `dist/core/build/index.js:156-182` and
  `dist/integrations/hooks.js:439-473`. Completed prerender/image
  evidence and final hooks.
- **S4:** [Astro public integration declarations][s4],
  `dist/types/public/integrations.d.ts:145-165,318-336`, plus
  `dist/core/app/types.d.ts:37-39,201-215`.
- **S5:** [Astro production app entrypoint][s5],
  `dist/core/app/entrypoints/virtual/prod.js:1-7`, plus
  `dist/manifest/serialized.js:82-115` and
  `dist/vite-plugin-pages/pages.js:40-67`. Global manifest and
  loaders.
- **S6:** [Astro server-island plugin][s6],
  `dist/core/server-islands/vite-plugin-server-islands.js:28-35,84-107,140-165`,
  plus `dist/vite-plugin-astro/index.js:216-232`. Private
  metadata and discovery; emitted-map timing differs from
  serialized-manifest timing.
- **S7:** Inspected adapter working-tree paths:
  `mandatory/ArtifactGeneration/index.ts:61-118,140-227,229-346`,
  `mandatory/ArtifactGeneration/RuntimeImageRoutes.ts`,
  `mandatory/ArtifactGeneration/RouteRequirements/index.ts:104-123`,
  `conditional/FunctionArtifact/Partition/index.ts:184-276,308-496`,
  `conditional/FunctionArtifact/Prepare.ts`, `.plan.ts`, and
  `src/.astroHandler.ts:29-35`. Adapter paths start at
  `packages/adapter/src/` unless already prefixed with `src/`.

[hooks]:
  https://github.com/withastro/docs/blob/main/src/content/docs/en/reference/integrations-reference.mdx
[adapter]:
  https://github.com/withastro/docs/blob/main/src/content/docs/en/reference/adapter-reference.mdx
[migration]:
  https://github.com/withastro/docs/blob/main/src/content/docs/en/guides/upgrade-to/v6.mdx
[vite]:
  https://github.com/vitejs/vite/blob/v8.0.10/docs/guide/api-plugin.md
[s1]:
  https://unpkg.com/astro@7.1.6/dist/core/build/static-build.js
[s2]:
  https://unpkg.com/astro@7.1.6/dist/core/build/plugins/plugin-manifest.js
[s3]: https://unpkg.com/astro@7.1.6/dist/core/build/generate.js
[s4]:
  https://unpkg.com/astro@7.1.6/dist/types/public/integrations.d.ts
[s5]:
  https://unpkg.com/astro@7.1.6/dist/core/app/entrypoints/virtual/prod.js
[s6]:
  https://unpkg.com/astro@7.1.6/dist/core/server-islands/vite-plugin-server-islands.js
