# Native App isolation with selected loaders

Researched and executed on 2026-11-09 from
`973011de19485903044ffe3878e8d3a1e20a0664`, the head of
`feat/complete-beta-routing` after #91, #92, #93 and #94 merged.
The checkout was clean. This is a feasibility experiment, not a
migration of the
[_Bare Adapter_](../../GLOSSARY.md#bare-adapter).

## Result

**Minimal isolation is confirmed, with an internal
loader-protocol dependency.** One Astro build per fixture
produced two standalone ESM directories. Each contains its
selected route's marker and none of the other route's marker or
source module. Both handlers execute from copies outside the
checkout without `node_modules`. The second fixture also renders
an Astro page and preserves specific/rest precedence under
`/nested/`.

This does not establish a supported public per-route compiler
contract. Package imports and build callbacks are public, but the
probe supplies the `{ page() }` wrapper expected by Astro's
implementation. It also retains a standard global entry during
the build to obtain the structured SSR manifest. That entry is
absent from the standalone directories. S1-S5 below.

Executed flow:

```text
one Astro build per fixture
  standard createApp entry -> global graph -> structured SSR manifest
  public App entry         -> native runtime chunks
  setup.pages source IDs   -> native route chunks

after build completion, no second bundler
  full route metadata + selected loader + native runtime closure
    -> standalone directory one
  full route metadata + other loader + native runtime closure
    -> standalone directory two
```

This changes the variable that failed in
[the #94 experiment](native-build-pipeline.md#native-multi-entry-experiment-2026-11-09):
the standalone entries do not import `createApp()` or the global
page map. Native chunks are copied unchanged; only the final
`index.mjs` glue is new. This respects
[ADR 0002](../adr/0002-use-astros-build-pipeline-for-runtime-artifacts.md).
No production source, domain object, dependency, or test
framework was added.

## Executed cases

Resolved versions were Astro **7.1.6**, Vite **8.2.0**, and
Rolldown **1.2.3**. The complete recipe passed on both Node
**22.12.0** and **26.13.0**, including fresh child processes for
each standalone directory. Each run performs two Astro builds,
one for each fixture, not two builds per selected route.

| Fixture                      | Selected code    | Files including glue | Own request                                                | Foreign request         | Foreign marker anywhere in directory |
| ---------------------------- | ---------------- | -------------------: | ---------------------------------------------------------- | ----------------------- | ------------------------------------ |
| Two endpoints                | `one.ts`         |                    8 | `/one`: 200, `PROBE_ONE_ONLY`                              | `/two`: 404             | Absent                               |
| Two endpoints                | `two.ts`         |                    8 | `/two`: 200, `PROBE_TWO_ONLY`                              | `/one`: 404             | Absent                               |
| Astro page and rest endpoint | `specific.astro` |                   10 | `/nested/specific`: 200, HTML containing `PROBE_PAGE_ONLY` | `/nested/anything`: 404 | Absent                               |
| Astro page and rest endpoint | `[...rest].ts`   |                    9 | `/nested/anything`: 200, `PROBE_REST_ONLY:anything`        | `/nested/specific`: 404 | Absent                               |

All guarded foreign responses have body `Not Found`. The only
external module in these closures is the Node builtin
`node:module`. No runtime package installation was required.
These are Web `Request`/`Response` handlers, not cloud-deployed
[_Function Artifacts_](../../GLOSSARY.md#function-artifact).

## Source-to-loader mapping

The probe captures `pages` from the public `astro:build:setup`
callback. For each fixture source it retains both `component` and
`moduleSpecifier`. The latter is passed directly to native
`emitFile`, without constructing private `virtual:astro:page:*`
identifiers. `preserveSignature: "strict"` keeps the source
namespace exports available. Native `facadeModuleId` values in
the evidence identify the resolved source files. S2, S6.

For example, the executed endpoint mapping is:

```text
component:       src/pages/one.ts
moduleSpecifier: /src/pages/one.ts
emitFile id:     /src/pages/one.ts
emitted entry:   one.mjs
pageMap key:     src/pages/one.ts
loader:         async () => ({ page: () => import('./one.mjs') })
```

`App`, `deserializeManifest` and the `SSRManifest.pageMap` field
are exported/publicly typed. However, `AppPipeline` awaits the
map loader and then calls `.page()` on its result. Astro's own
page plugin manufactures that wrapper. The probe reproduces this
protocol rather than receiving a compiled loader from a public
callback. The types are not a substitute for that evidence:
`pageMap` refers to `ImportComponentInstance`, while
`SinglePageBuiltModule` describes the wrapper separately in the
build declarations. S1-S3.

The public `astro:build:ssr` payload supplies structured
serialized metadata, not the runtime loader assignments. The
probe clones it immediately and deserializes it in each generated
entry. In this version the callback runs only when Astro finds
its serialized global manifest chunk. Keeping the seed entry
satisfies that condition; the probe never imports or overrides a
private virtual module itself. This is an implementation timing
dependency, not a new public guarantee. S4-S5.

## Precedence and the missing-loader negative control

All route records remain in each manifest, including foreign
routes. Both standalone handlers match `/nested/specific` to
`/specific`, not `/[...rest]`. The rest directory rejects that
match before asking Astro to load it.

Executed guard, simplified from the archived recipe:

```js
const routeData = app.match(request);
if (!routeData || !manifest.pageMap.has(routeData.component)) {
  return new Response("Not Found", { status: 404 });
}
return app.render(request, { routeData });
```

The recipe also calls **unguarded** `app.render()` for the
foreign URL in a fresh directory process. The outcomes are the
same on both Node versions:

| Selected code    | Unguarded foreign URL | Observed result                                      |
| ---------------- | --------------------- | ---------------------------------------------------- |
| `one.ts`         | `/two`                | 500, empty body                                      |
| `two.ts`         | `/one`                | 500, empty body                                      |
| `specific.astro` | `/nested/anything`    | Rejected promise: missing component for `/[...rest]` |
| `[...rest].ts`   | `/nested/specific`    | **200**, `PROBE_REST_ONLY:specific`                  |

The last case is a concrete counterexample to treating an absent
loader as access control. `AppPipeline` throws for `/specific`;
`AstroHandler` enters error handling; `DefaultErrorHandler`
resolves `/500` against the same route list, where the rest route
matches. It renders that endpoint with the original pathname, and
the endpoint's `Response` retains status 200. S3, S7-S8. Metadata
preservation is necessary here but does not alone stop error
rerouting. The pre-render guard does. Rewrites and errors arising
_inside_ an allowed route remain untested.

## Closure evidence and reproducibility

- [Archived source and extraction command](native-app-isolation-recipe.md).
- [Recorded results](native-app-isolation-results.json),
  including both Node versions, source-to-entry mappings,
  preserved route metadata, every copied file, byte sizes,
  SHA-256 values, import edges, and all runtime responses.
- Original local working material:
  `~/.local/share/codex/reports/native-app-isolation-probe/`. The
  recipe generates fresh `/tmp/native-app-isolation-*`
  directories and prints their paths. These temporary paths are
  evidence locations, not prerequisites for reproduction.

The closure check walks both native `imports` and
`dynamicImports`, starting at `runtime.mjs` and the selected
source entry. A missing non-builtin edge fails the run. It then:

1. Reads final files after `astro:build:done` and verifies their
   bytes still match the `generateBundle` hashes.
2. Parses their final ESM imports with the already-installed
   TypeScript parser and compares all edges to the native graph.
   Nonliteral dynamic imports and external packages fail the run.
3. Rejects foreign source module IDs in every retained native
   chunk. Scans every copied file and the glue for foreign
   markers, and requires the selected marker to exist.
4. Enumerates the actual standalone directory and checks that it
   contains exactly the recorded files. Native chunks retain
   their relative paths; each directory receives its own copies.
5. Renames the original fixture, including its build output and
   `node_modules` symlink, before invoking the copied handlers in
   fresh processes outside the checkout. `NODE_PATH` and
   `NODE_OPTIONS` are cleared for those processes.

The final glue's two import edges are constructed explicitly and
included in the file inventory. No emitted-code rewriting is
used. The copied files contain no filesystem asset loads for
these fixtures. The emitted Rolldown helper creates a
`createRequire` function, but no retained chunk imports/calls its
export; the transitive server ESM graph needs no packages beyond
Node. Browser runtime code embedded in strings is not exercised.
This is a complete file closure for these fixtures, not a generic
validator for arbitrary computed loads, CSS or asset URLs.

Manifest encryption keys and temporary root paths vary between
runs, so this is behavioral reproducibility, not a byte-for-byte
reproducible-build claim. The recorded hashes identify each
observed run. Both builds log Astro's unsupported-Sharp
diagnostic from the minimal adapter, then complete. The negative
controls also log expected missing-component errors.

## What this does not prove

| Feature                           | Proven here                                                               | Remaining limitation                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Endpoints                         | Two independent endpoint closures and responses                           | No package-bearing endpoint, install strategy or provider invocation                      |
| Astro pages                       | Plain `.astro` output with a frontmatter value                            | No hydrated components or framework renderers                                             |
| Base and precedence               | `/nested/`, specific page versus rest endpoint, guarded foreign rejection | No i18n, redirects, slash-policy matrix, malformed paths, custom 404, or rewrite coverage |
| Actions                           | Nothing                                                                   | Serialized metadata does not acquire the compiled Actions loader                          |
| Server islands                    | Nothing                                                                   | No selected island loader acquisition or island-map pruning proof                         |
| Middleware                        | Only `deserializeManifest`'s default no-op                                | User/injected middleware and edge mode were not wired                                     |
| Renderers                         | Empty renderer list suffices for the plain Astro page                     | React/Vue/etc. compiled renderer acquisition is unproven                                  |
| Custom fetch                      | Default App fetch behavior                                                | The `createApp` call to `setFetchHandler(fetchable)` is not reproduced                    |
| CSS and assets                    | No authored CSS, images, client scripts or external assets                | No asset copying, client closure, image runtime or final asset metadata proof             |
| Sessions, cache and custom logger | Nothing                                                                   | Their runtime loader assignments are omitted                                              |
| Existing adapter behavior         | Adapter source remains unchanged                                          | No bridge, cookies/locals, static 404 scopes, preview, packaging or cloud parity claim    |

The global manifest plugin normally wires the omitted loaders;
the SSR callback alone does not. See S5. Existing
responsibilities in `.astroHandler.ts`, `Hooks`,
`FunctionArtifact/Partition` and
[ADR 0003](../adr/0003-concentrate-target-policy-in-target-drivers.md)
remain unchanged. Shared framework chunks are still substantial;
this experiment proves code exclusion, not optimal size or cold
start performance.

## Repository validation

- The archived probe passed on Node 22.12.0 and 26.13.0 with the
  versions and assertions recorded above.
- `pnpm check` passed with Node 22.12.0 on `PATH`: type checks,
  lint, formatting, build, and **385 tests in 23 files**.
- `pnpm pack:check` passed with the same Node 22.12.0
  environment.
- An earlier `pnpm check` with Node 26.13.0 failed in npm-driven
  checks: project installs reported `EALLOWSCRIPTS`, and the
  package-check setup could not destructure npm's JSON result. No
  npm configuration or project source was changed to work around
  this. The supported Node 22 run passed all those tests.
- Cloud execution and the local S3 suite were not run locally. CI
  status is reported separately in the research PR.

## Next research step

Proposed, not applied: test explicit compiled-loader acquisition
for user middleware and one renderer before considering a
production migration. Keep the same closure and precedence
checks, and record whether acquisition needs private virtual IDs.

```text
public build evidence -> compiled middleware / renderer reference?
  -> selected App
  -> same independent-directory checks
```

If that cannot be done through a supported interface, the next
decision is whether to accept a version-pinned compiler adapter
or ask Astro for a public selected-loader build contract. The
current result does not justify replacing the production
partitioner.

## Primary sources

Context7 selected `/withastro/docs` for official Astro docs and
`/vitejs/vite/v8.0.10` for Vite plugin docs, and
`/rolldown/rolldown` for native chunk emission. The Astro results
still include v6-era wording, including references to removed
entry points. Exact behavior above was checked against the
installed 7.1.6 declarations and implementation, not inferred
from that wording. Rolldown's indexed examples also disagree on
`preserveEntrySignature` versus `preserveSignature`; installed
1.2.3 `EmittedChunk` declares `preserveSignature`, which the
probe uses. No background-agent tool was available in this
session; source inspection was performed in the main session.

- **S1:**
  [Astro 7.1.6 package exports](https://unpkg.com/astro@7.1.6/package.json),
  `./app`, `./app/manifest`, `./app/entrypoint`;
  [entrypoint exports](https://unpkg.com/astro@7.1.6/dist/core/app/entrypoints/index.js);
  [App constructor](https://unpkg.com/astro@7.1.6/dist/core/app/base.js),
  lines 57-64;
  [manifest types](https://unpkg.com/astro@7.1.6/dist/core/app/types.d.ts),
  lines 48-139.
- **S2:**
  [Public build data and wrapper declarations](https://unpkg.com/astro@7.1.6/dist/core/build/types.d.ts),
  lines 17-28 and 42-49;
  [source ID construction](https://unpkg.com/astro@7.1.6/dist/core/build/static-build.js),
  lines 51-60;
  [public integration callbacks](https://unpkg.com/astro@7.1.6/dist/types/public/integrations.d.ts).
- **S3:**
  [Page wrapper generation](https://unpkg.com/astro@7.1.6/dist/vite-plugin-pages/page.js),
  lines 37-43;
  [loader consumption](https://unpkg.com/astro@7.1.6/dist/core/app/pipeline.js),
  lines 70-104.
- **S4:**
  [Manifest callback timing and construction](https://unpkg.com/astro@7.1.6/dist/core/build/plugins/plugin-manifest.js),
  lines 34-60 and 239-288;
  [deserialization and no-op middleware](https://unpkg.com/astro@7.1.6/dist/core/app/manifest.js),
  lines 3-50.
- **S5:**
  [Global runtime loader assignments](https://unpkg.com/astro@7.1.6/dist/manifest/serialized.js),
  lines 82-115;
  [production createApp](https://unpkg.com/astro@7.1.6/dist/core/app/entrypoints/virtual/prod.js),
  lines 1-7.
- **S6:**
  [Vite per-environment plugins](https://github.com/vitejs/vite/blob/v8.0.10/docs/guide/api-environment-plugins.md);
  [Rolldown emitFile](https://rolldown.rs/reference/Interface.PluginContext#emitfile),
  [OutputChunk](https://rolldown.rs/reference/Interface.OutputChunk).
  The probe executes the installed 1.2.3 plugin API.
- **S7:**
  [Astro error transition](https://unpkg.com/astro@7.1.6/dist/core/routing/handler.js),
  `AstroHandler.render` catch block;
  [error route resolution](https://unpkg.com/astro@7.1.6/dist/core/errors/default-handler.js),
  `renderError` and `mergeResponses`;
  [error URL selection](https://unpkg.com/astro@7.1.6/dist/i18n/error-routes.js),
  `getErrorRoutePath`.
- **S8:**
  [Endpoint Response handling](https://unpkg.com/astro@7.1.6/dist/runtime/server/endpoint.js);
  [fetch state](https://unpkg.com/astro@7.1.6/dist/core/fetch/fetch-state.js).
- Official context:
  [adapter reference](https://github.com/withastro/docs/blob/main/src/content/docs/en/reference/adapter-reference.mdx),
  [astro/app reference](https://github.com/withastro/docs/blob/main/src/content/docs/en/reference/modules/astro-app.mdx),
  [v6 entryPoints removal](https://github.com/withastro/docs/blob/main/src/content/docs/en/guides/upgrade-to/v6.mdx).
