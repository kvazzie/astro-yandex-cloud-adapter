# Effect migration design

Status: design proposal, 2026-10-01. This describes the intended internal shape of the Bare Adapter. It does not change the published interface or implement the open issues.

## The seams that matter

The external module remains `yandexCloud(options): AstroIntegration`. Astro owns the hook lifecycle; the adapter owns Artifact Generation. `parseDeploymentManifest(unknown)` and the JSON Schema remain the Deployment Manifest consumer interface. The generated `index.handler` and Astro preview entrypoint are separate runtime interfaces. A Deployment Product consumes the Manifest and artifacts; it does not call internal build modules.

Use Effect for fallible workflows and acquired resources. Use plain functions for deterministic transformations. An `Effect` value is not evidence that a module is deep. The test is whether a caller can ask for a complete result without knowing the steps inside it.

The current `TargetDriver` has six operations, two of which only forward to `DependencyStrategyPolicy`. Keep the Target-specific seam required by [ADR 0003](adr/0003-concentrate-target-policy-in-target-drivers.md), but call its internal interface `TargetModule`. `Target` remains the selected arrangement defined in `CONTEXT.md`; a `TargetModule` contains the rules that produce that arrangement's artifacts. The ADR's name becomes stale when this rename lands, so update its wording with the implementation. There are two concrete Target modules today. A Serverless Container Target will be a third. Do not add ports for one-off pure helpers or a custom filesystem interface. Temporary directories and real files already give the filesystem a local stand-in.

## Reviewable declarations

These are design types. Final names and Astro type details should be checked while implementing each slice.

```ts
import type { Brand } from "effect";

type RoutingPlan = { kind: "direct" } | { kind: "gateway"; recursive404: boolean };

type BuildPlan =
  | { target: "object-storage"; routing: RoutingPlan }
  | {
      target: "object-storage-functions";
      routing: RoutingPlan;
      dependencyStrategy: DependencyStrategy;
      functionLayout: "shared" | "per-route";
    };

type ArtifactId<K extends "client" | "function"> = string & Brand.Brand<K>;

type ServingArtifact =
  | { kind: "client"; id: ArtifactId<"client">; directory: URL }
  | {
      kind: "function";
      id: ArtifactId<"function">;
      directory: URL;
      entrypoint: "index.handler";
    };

type PlannedRoute =
  | {
      kind: "prerendered";
      routeKind: "page" | "endpoint";
      pattern: string;
      paths: readonly {
        url: string;
        objectKey: string;
        artifactId: ArtifactId<"client">;
      }[];
    }
  | {
      kind: "on-demand";
      routeKind: "page" | "endpoint";
      pattern: string;
      artifactId: ArtifactId<"function">;
    };

interface CompletedBuild {
  config: AstroConfig;
  resolvedRoutes: readonly IntegrationResolvedRoute[];
  astroPages: readonly { pathname: string }[];
  emittedAssets: ReadonlyMap<string, readonly URL[]>;
}

interface AstroBuildConfigPatch {
  build: { client: URL; server: URL; serverEntry: string };
}

type BuildError =
  | { _tag: "InvalidConfiguration"; message: string }
  | { _tag: "UnsupportedRoute"; message: string }
  | { _tag: "InvalidArtifact"; message: string; cause?: unknown }
  | { _tag: "UnresolvedDependency"; message: string; cause?: unknown }
  | { _tag: "InvalidManifest"; message: string; cause?: unknown };

interface TargetModule {
  readonly target: Target;
  astroBuildConfig(
    config: AstroConfig,
  ): Effect.Effect<AstroBuildConfigPatch, BuildError>;
  astroAdapter(
    routes: readonly IntegrationResolvedRoute[],
  ): Effect.Effect<AstroAdapter, BuildError>;
  serverViteConfig(vite: InlineConfig): InlineConfig;
  generateArtifacts(
    build: CompletedBuild,
  ): Effect.Effect<DeploymentManifestV1, BuildError>;
}
```

`BuildPlan` is a discriminated value, not a second hierarchy of classes. It holds validated choices once per integration instance; the Object Storage Target cannot accidentally carry a Function partition choice. Add a Container variant when that Target has real requirements. `TargetModule` owns output layout, route compatibility, Astro capability declarations, and Artifact Generation. Its interface returns the thing each Astro phase needs: build directories, an adapter declaration, server Vite config, or generated artifacts. The integration adds the shared runtime config plugin itself. `generateArtifacts` hides packaging, route reconciliation, Manifest creation, and optional template generation. An implementation may use many private functions and internal seams.

Represent `bundle` and `install` as values in `BuildPlan`, then select the relevant Vite configuration and packaging pipe in one Function Artifact module. The current `DependencyStrategyPolicy` repeats the same choice across configuration, packaging, and Sharp claims; it earns no independent seam once those operations move together. Keep Sharp's support statement aligned with the selected strategy and cloud evidence. Add per-package choices only when a real native and JavaScript mix proves their need.

`PlannedRoute` is the internal route model, not the final Manifest schema. A prerendered page or endpoint has an Astro pattern and zero or more concrete paths. For example, `/blog/[slug]` can produce `/blog/a` and `/blog/b`, each with its own Object Storage key; a prerendered `/feed.xml` endpoint produces a Client Artifact file too. The [accepted Manifest decision in #63](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/63#issuecomment-5900071837) calls for concrete URL-to-key entries for prerendered routes. The route plan retains the source pattern and page or endpoint kind; the Manifest projection may omit the pattern if no consumer needs it. [Issue #7](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/7) owns that public choice and the exact JSON Schema.

Astro's `astro:routes:resolved` supplies each pattern and its matching regex. `astro:build:done` supplies generated page pathnames and an `assets` map grouped by route pattern. Its `pages` list does not include prerendered endpoints in the installed Astro 7.1.6 build. Reconciliation must use emitted Client Artifact files and route keyed build evidence, then check for ambiguous or unmatched paths. The current adapter derives prerendered Manifest entries solely from `pages`, so a prerendered endpoint can be absent. Add a fixture that proves both page and endpoint mappings before relying on the new route plan.

`artifactId` references `ServingArtifact.id`. Effect's `Brand.Brand<K>` prevents a Function Artifact ID from filling a Client Artifact reference in TypeScript. Branding does not validate a value at runtime. The actual JSON value is a string, so Manifest validation must also require every reference to resolve to exactly one emitted artifact of the expected kind. IDs identify artifact instances within one build and must be unique across both kinds. The current single Client Artifact might be `client:primary`; a future second Client Artifact receives a different stable ID derived from its logical role. Function IDs likewise use stable roles or route keys. The generator checks collisions instead of relying on a naming convention for correctness. #63 also requires stable Function Artifact IDs, page or endpoint kind, direct invocation metadata, 404 scopes, and optional Gateway template provenance. Do not encode one Function Artifact as an optional object only to change it to an array in #70.

## Deployment Manifest schema

Migrate the Manifest contract to Effect Schema as part of #7. Its declaration is the source for the TypeScript Manifest type, the synchronous `parseDeploymentManifest(unknown)` implementation, and the packaged Draft 2020-12 JSON Schema. Generate the JSON file with `JSONSchema.make(ManifestV1Schema, { target: "jsonSchema2020-12" })`, add the stable published `$id`, and check in the generated file so packed consumers can use it without executing Effect. Keep `defineDeploymentManifest` as a typed identity over the inferred type. Remove AJV from the adapter after the Effect Schema parser passes the existing consumer cases.

The v1 contract accepts unknown additive fields, including fields inside nested objects. Effect Schema's ordinary `Schema.Struct` decoder drops extra keys, and its JSON Schema generator closes the object. Declare each extensible object with an unknown-valued index signature, for example `Schema.Struct(fields, Schema.Record({ key: Schema.String, value: Schema.Unknown }))`. This preserves extras while decoding and permits them in the generated JSON Schema. Keep the `schemaVersion: 1` literal and derive the TypeScript type from the schema rather than maintaining a parallel handwritten interface.

Put representable constraints, such as literal values and path formats, in Effect Schema. Add JSON Schema annotations when a custom refinement needs an equivalent published rule. A second pure check handles relationships JSON Schema cannot express well: unique artifact IDs, references to an artifact of the right kind, base placement, and route key consistency. Run that check after decoding and before either returning a parsed Manifest or writing a generated one. Build completion separately verifies that declared static keys correspond to emitted files. Keep the public parser's `TypeError` behavior and require conformance cases to accept the same additive fields and reject the same invalid known fields through both the parser and the packaged JSON Schema where JSON Schema can express the rule.

## Logical modules and physical placement

| Logical module and interface                                              | Physical home after migration                                                                                          | Pattern and reason                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Astro integration, `yandexCloud(options)`                                 | `src/index.ts`, `src/integration/session.ts`                                                                           | Framework adapter plus a per-integration lifecycle session. Hooks record immutable snapshots and run a short pipe. No module-global build state.                                                                                                                                                                   |
| Options and build plan, `decodeOptions(unknown): BuildPlan`               | `src/integration/options.ts`                                                                                           | Effect Schema at the user-input seam. Defaults and invalid combinations are checked once, including Gateway and 404 rules as they arrive.                                                                                                                                                                          |
| Target module, `TargetModule`                                             | `src/target/module.ts`, `src/target/object-storage.ts`, `src/target/object-storage-functions.ts`; later `container.ts` | One module per Target, with methods named for the result each Astro phase needs. Shared behavior is extracted only after two Targets need it.                                                                                                                                                                      |
| Route requirements, `reconcileRoutes(resolved, assets, files): RoutePlan` | `src/build/routes.ts`                                                                                                  | Deep pure module. It reconciles Astro metadata with emitted evidence and owns route kind, base, precedence, internal route activity, artifact assignment, and later 404 scopes. No hook or Manifest code reclassifies routes independently.                                                                        |
| Artifact generation, `completeBuild(build, plan)`                         | `src/build/complete.ts`                                                                                                | One effectful transaction-shaped workflow. It inspects emitted artifacts, packages Function Artifacts, builds route requirements, validates the Manifest, writes it, and emits optional derived templates. Ordering is visible in this pipe.                                                                       |
| Function packaging, `prepareFunctionArtifact(input)`                      | `src/function/package.ts`, `imports.ts`, `dependencies.ts`, `lockfile.ts`                                              | Deep module around a complete Function Artifact. Acorn traversal and deterministic formatting are pure internals; file scanning and dependency resolution are effects. No caller can write package metadata while skipping validation.                                                                             |
| Package metadata, `resolve(name, version)`                                | `src/function/registry.ts`                                                                                             | Internal port for the true external npm registry, with HTTP and test adapters. The local lockfile lookup precedes this port. Keep Node resolution and graph walking inside Function packaging.                                                                                                                     |
| Manifest contract, `parseDeploymentManifest(unknown)`                     | `src/manifest/schema.ts`, `contract.ts`, `write.ts`; packaged `deployment-manifest.schema.json`                        | Effect Schema is the structural declaration for v1, its TypeScript type, parsing, and packaged Draft 2020-12 JSON Schema. A pure check handles cross-field relationships.                                                                                                                                          |
| Function Runtime Bridge, `invoke(event, context, render)`                 | `src/runtime/bridge.ts`, `server.ts`; later a separate package                                                         | Translation from a Yandex event to a Web Request and from a Web Response to a Yandex result. Pure translation stays pure; asynchronous body reading and Astro rendering are effects. No Astro type enters the future framework-neutral bridge.                                                                     |
| Preview, `startPreview(options)`                                          | `src/preview.ts`, optionally `src/preview/http.ts`                                                                     | Node HTTP adapter. Serve the Client Artifact for Static-only Builds and dispatch between Client and Function Artifacts for Runtime Builds. The listener has an Effect `Scope` that survives until Astro calls `stop`; closing the startup effect's scope immediately would close the server before preview begins. |
| Vite runtime config and generated locals types                            | `src/integration/runtime-config.ts`, `runtime-types.ts`                                                                | Small pure declarations at Vite and Astro seams. They do not need Layers or Effect wrappers.                                                                                                                                                                                                                       |
| Gateway template, `renderGatewayTemplate(routePlan, manifest)`            | `src/gateway/template.ts` when #67 lands                                                                               | Pure projection of the same reconciled route model used by the Manifest, followed by size validation and a file write. Never create a second route classifier.                                                                                                                                                     |

Keep these folders inside the adapter package for now. Extract the Function Runtime Bridge when real-cloud conformance begins, as [ADR 0008](adr/0008-share-a-cloud-tested-function-runtime-bridge.md) says. Extract the Manifest contract only when the SST component or GitHub Action becomes a second real consumer, as [ROADMAP.md](../ROADMAP.md) says. Physical packages should follow deployment and versioning needs, not the presence of `Layer` or `Schema`.

Split the present `src/types.ts` by ownership: public adapter options, public Manifest contract, and runtime invocation types. Move `src/artifacts.ts` into build orchestration, route placement, and Function packaging. `src/install-lockfile.ts` stays a pure formatter behind packaging. Remove `getAstroVersion` from Manifest generation when #7 removes that field. Keep `constants.ts`, the virtual Vite module declaration, and other one-purpose files small; a folder is useful only when it makes a deeper module easier to find.

## Entrypoint pipes

Astro hooks are the build entrypoints. Their bodies should show the phase, inputs, and composition, leaving details behind module interfaces:

```ts
// Shape, not a copy-ready implementation.
"astro:config:setup": ({ config, updateConfig }) =>
  selectedTarget.astroBuildConfig(config).pipe(
    Effect.map((patch) => ({
      ...patch,
      vite: { plugins: [runtimeConfigPlugin(config.site)] },
    })),
    Effect.tap((patch) => Effect.sync(() => updateConfig(patch))),
    mapToAstroHookError,
  );

"astro:routes:resolved": ({ routes }) =>
  session.recordRoutes(routes).pipe(mapToAstroHookError);

"astro:config:done": ({ config, setAdapter }) =>
  session.recordConfig(config).pipe(
    Effect.flatMap((snapshot) => selectedTarget.astroAdapter(snapshot.routes)),
    Effect.tap((adapter) => Effect.sync(() => setAdapter(adapter))),
    mapToAstroHookError,
  );

"astro:build:setup": ({ target, vite, updateConfig }) =>
  target === "server"
    ? Effect.sync(() => updateConfig(selectedTarget.serverViteConfig(vite)))
    : Effect.void;

"astro:build:done": ({ pages, assets }) =>
  session.completedBuild({ astroPages: pages, emittedAssets: assets }).pipe(
    Effect.flatMap((build) => selectedTarget.generateArtifacts(build)),
    mapToAstroHookError,
  );
```

The session contains the resolved config and route snapshot for one integration instance. It rejects `build:done` before `config:done`, resets on Astro restart, and lets the latest `routes:resolved` snapshot replace an earlier one. Use one `Ref` or a small closure internal to this module. Do not pass `config!` and route arrays through the whole codebase. The session is an internal seam because hook calls and build completion need different phase data.

The completion pipe should make the build order equally plain:

```text
inspect emitted output
  -> describe Client Artifact placement
  -> reconcile routes and Serving Artifacts
  -> prepare each emitted Function Artifact
  -> assemble Manifest from those facts
  -> validate Manifest
  -> render optional Gateway template from the same route plan
  -> write final build outputs
```

Use a typed `RoutePlan` as the common input for the Manifest and Gateway template. Do not derive Gateway rules by parsing the Manifest back into an impoverished routing model, or produce two competing maps. The Manifest is the portable projection of the plan. The runbook CLI later reads only that Manifest, as #64 requires.

The generated Function entrypoint has a shorter pipe:

```text
decode invocation -> make Web Request -> Astro render -> encode Web Response
```

Construct the Astro app once per loaded module. Run one Effect per invocation. Keep `Host` over HTTPS, `site` fallback, repeated values, binary bodies, multiple `Set-Cookie` headers, and `Astro.locals.runtime` behavior from the current bridge. Direct Function Invocation's reserved request-target parameter and public-origin check belong before Web Request construction when #69 lands. API Gateway 0.1 path handling remains a distinct input contract. No Layer or Effect runtime should be constructed for each request.

## Where Effect constructs earn their place

| Construct                       | Use here                                                                                                                                       | Avoid here                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Effect.gen`, `pipe`, `flatMap` | Hook workflows, complete build, Function packaging, invocation rendering, preview startup                                                      | One-line pure route and path helpers                                                     |
| `Schema`                        | Adapter options and untrusted external data; the Manifest contract and its generated JSON Schema                                               | Maintaining separate handwritten Manifest types or JSON Schema                           |
| Tagged errors                   | A few caller-actionable failures such as invalid options, unsupported routes, unresolved Dependency, invalid Manifest, and failed artifact I/O | A tagged class for every helper or a generic catch-all `BuildError` that hides the cause |
| `Layer`                         | A real dependency with production and test adapters, chiefly registry HTTP metadata; Node platform implementations if they simplify actual I/O | Every Target module, formatter, route classifier, or static policy value                 |
| `Ref`                           | The integration instance's lifecycle state                                                                                                     | Derived route data that can be passed as immutable values                                |
| `Scope` and `acquireRelease`    | Preview listener and any future watcher or persistent client                                                                                   | File reads, `fetch`, and ordinary Function invocations                                   |

Convert native Promise rejection with `Effect.tryPromise` at I/O calls and retain the original cause. At the Astro seam, format a concise actionable build error. At the Function seam, preserve the handler's expected rejection behavior. Expected failures belong in Effect's error channel; defects should remain defects. A default retry of npm metadata requests would make deterministic builds less predictable, so add retry only with an explicit policy and tests.

`effectify/astro/integration` is installed, but its `defineIntegration` in 0.3.1 runs each hook with a separate `Effect.runPromise`, accepts only hook effects with no remaining requirements, wraps failures as `EffectifyIntegrationHookError`, and logs a generic error. It also returns async hooks. It can be the thin Astro adapter once internal Layers are provided inside the deep modules and build errors remain legible. Prove that behavior against the existing failing-build fixtures before replacing `index.ts`. `effectify/astro/HttpApi` adapts application routes; it has no role in the generated Function handler.

## Migration order and proof

1. Implement the accepted draft Manifest v1 decision from #63 and #7 with Effect Schema. Derive the TypeScript type and packaged JSON Schema from that declaration, replace AJV in the parser, and keep generator and consumer fixtures synchronized. The current `types.ts`, `deployment-manifest.schema.json`, and `artifacts.ts` still describe the older draft. This is unpublished, so #63 permits revising schema version 1 in place. After publication, follow [ADR 0004](adr/0004-version-the-deployment-manifest-contract.md).
2. Define `BuildPlan`, route requirements, `TargetModule`, and error types before moving implementation. Reconcile pages and endpoints in one module. Prove prerendered endpoints appear in the route map and static builds do not promote merely registered internal routes into deployment requirements.
3. Move Function packaging out of the 827-line `artifacts.ts`. Keep `bundle` and `install` behavior and deterministic lockfile bytes. Introduce the registry metadata port only around the external fetch; use existing real-file fixtures elsewhere.
4. Move completion into one Effect pipe and shorten hook bodies. Adopt `effectify` only after its hook error and lifecycle behavior matches Astro's contract. Keep the default export and generated output compatible with the current fixtures.
5. Move the runtime bridge and preview last. Preserve generated-handler and HTTP preview behavior. Measure Function Artifact size and cold-start behavior before adding Effect platform packages to the generated runtime.
6. Add Gateway, direct URL, partitioning, recursive 404, and Container behavior to the route plan and relevant Target module as those issues land. Each feature must change one route model and one target-specific completion path, rather than reopening every Astro hook.

Verification should run through the current external seams: fixture builds through the public adapter, Manifest parsing as an untrusted consumer, generated handlers outside the fixture tree, and packed-consumer preview. Focused pure tests are useful for routing precedence and dependency-graph edge cases. Do not add tests of private pipe steps or Target module call order. The open beta and stable cloud gates remain in [release readiness](release-readiness.md).

## Decisions that should stay visible

- The accepted #63 decision changes the still-unpublished Manifest draft. Current code and parts of #1 and older ADR wording describe the earlier shape. Update the conflicting docs when #7 is implemented; do not quietly treat the old shape as a permanent public contract.
- There is no proven algorithm yet for deciding which registered Astro-internal routes are active in every build. Route reconciliation needs emitted evidence and representative fixtures before Gateway generation or Function partitioning can rely on it.
- The Container Target will justify a new Target module. It does not justify a container-shaped abstraction in today's Object Storage implementation.
- Shared Manifest and runtime packages remain extraction decisions with explicit triggers, not directories created during this refactor.

Effect v3 references: [effects and requirements](https://effect.website/docs/v3/getting-started/the-effect-type), [creating effects](https://effect.website/docs/v3/getting-started/creating-effects), [scopes](https://effect.website/docs/v3/resource-management/scope), [Schema structs](https://effect.website/docs/v3/schema/basic-usage), and [JSON Schema generation](https://effect.website/docs/v3/schema/json-schema). Astro references: [prerendered endpoints](https://docs.astro.build/en/guides/on-demand-rendering/) and [integration hooks](https://docs.astro.build/en/reference/integrations-reference/). Effectify behavior above is based on the installed 0.3.1 declaration and implementation, not an assumption about later releases.
