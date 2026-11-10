# Astro adapter public API and prior art

Primary-source audit, 2026-11-10. Repository base:
`30063ba63209a7edd85527f26e09cf9d34e77a28`, freshly fetched
`origin/feat/complete-beta-routing`. This note records findings;
it does not implement an interface, runtime policy, or narrower
supported-version range.

## Findings

1. **Supplying infrastructure URLs through Pulumi outputs for a
   staged Astro build is already decided.** The future SST
   component owns these outputs; application URLs remain the
   application's responsibility. See [the roadmap][roadmap],
   [issue #69][direct-issue], and the [accepted #63
   decision][decision].
2. **Gateway is this adapter's accepted Yandex support boundary,
   not an inherent Astro Actions requirement.** Direct Yandex
   HTTPS invocation removes incoming `Cookie` and
   `Authorization`. This loses authenticated request context; it
   does not prove that every stateless Action needs cookies. See
   the platform and framework distinction below.
3. **Documented hook data is public API.** This includes
   `astro:build:ssr.manifest`, its documented route/component
   information, and `middlewareEntryPoint`. Even runtime
   `SSRManifest.pageMap` and `serverIslandMappings` are
   documented. Their emitted JavaScript spelling and compiler
   virtual-module acquisition are different contracts. See [the
   pinned public reference][integrations].
4. **Current official adapters inspected here do not demonstrate
   isolated per-route function packaging.** They use a full App
   behind a server entry, a shared SSR function, or a Worker.
   Optional edge middleware and ISR functions are concrete
   exceptions to “one function,” but do not establish per-route
   code exclusion. Historical Vercel did consume public per-route
   entries; that API was subsequently removed.
5. **Public APIs supply useful parts, but no complete supported
   recipe meeting this repository's separate-function contract
   was established.** That is a bounded audit result, not a proof
   that every possible native design is impossible. Copying the
   complete App to several functions is publicly achievable but
   does not exclude unrelated route code and dependencies.

## Earlier decisions and current authority

The roadmap's Yandex SST component section explicitly commits to
Function and Object Storage/CDN URLs as Pulumi outputs usable in
a staged Astro build. Issue #69 applies that decision to a static
form posting to a Function URL. The permanent #63 decision
comment also assigns generated assets and `public/` URL handling
to the application. These are existing decisions, not a new
proposal from this investigation. Neither source says the future
component is already implemented. [Roadmap][roadmap], [issue
#69][direct-issue], [decision][decision].

Existing responsibility, simplified:

```text
future SST / Pulumi -> resource URLs as outputs
application staged Astro build -> form / asset URLs
adapter build -> artifacts + manifest + optional Gateway template
infrastructure consumer -> resources and request routing
```

The [native-pipeline report](native-build-pipeline.md), the
[latest interface report at f0ba508][design], and the [contract
report at ca8aa36][contract] were read. The pipeline report's
proposal to replace emitted route-identity parsing is historical:
[merged PR #91][identities] already reads structured
route/component identities from the public SSR hook. Calling the
adapter's retained per-build map “private” describes local state,
not the public status of its input.

Authority supplied by the originating conversation supersedes
older reports' still-open error-policy questions: preserve
Astro's returned outcome, and use an outer HTTP 500 fallback with
the original diagnostic cause when `app.render()` rejects. Do not
replace a returned `Response`, including an Astro-selected 200
after error recovery. A configurable fallback based on the
rewrite target pathname remains a design preference/sketch;
transport, closure and implementation are not authorized here.
This conversation decision is not attributed to an upstream API
or silently written into an ADR.

## Why Actions require Gateway here

| Owner                          | Established requirement or limitation                                                                                                                                                                                                                                                                    | Consequence                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yandex direct HTTPS invocation | Incoming `Cookie` and `Authorization` are removed. Raw integration also cannot parse/set HTTP headers and fixes HTTP status to 200. [Platform source][yandex-direct].                                                                                                                                    | Direct invocation cannot transparently preserve normal session/authentication semantics. Raw invocation does not restore the missing HTTP contract. |
| Yandex Gateway integration     | Payload 0.1 carries request URL, headers, multi-value headers, query and body; invocation uses the Gateway-facing host. [Integration source][yandex-gateway], [invocation source][yandex-direct].                                                                                                        | Supplies the request envelope selected by this adapter. Cloud conformance remains unverified by this audit.                                         |
| Astro                          | Actions need a server runtime. The Actions guide shows ordinary RPC/form calls and optional application authorization through cookies, locals and middleware. It does not impose a Yandex Gateway resource or universal session requirement. [Actions guide][actions], [RPC implementation][action-rpc]. | Cookies matter when the application uses them. The simplest unauthenticated Action is not proof of full direct-mode compatibility.                  |
| This repository                | [ADR 0005][direct-adr] and [accepted #63][decision] restrict direct mode to stateless user-defined endpoints; required Actions, server islands and on-demand pages use Gateway. [Issue #69][direct-issue] preserves Astro's origin check for explicit-origin static forms.                               | Gateway is mandatory for these features under the current adapter contract, including a stateless Action. This audit does not relax that boundary.  |

A server-rendering requirement is intrinsic to callable Actions;
Yandex header filtering is a platform restriction; rejecting all
Actions in direct mode is the project's deliberately broader
compatibility boundary. Loss of cookies alone does not logically
prove that every page, island or Action intrinsically needs
Gateway. Conversely, configuring the Function URL through Pulumi
cannot recover headers the platform removed. The earlier
[contract study][contract] and ADR retain the real-cloud
verification limitation.

## What is public, and what is not established as stable

Context7 supplied `/withastro/docs` material for SSR hooks,
custom entries, and Actions. The fetched documentation is pinned
to docs commit `d7657e201db89940b4fbad3704dbb6c0d2b075bf`. It
contains Astro 5/6 migration history and is not by itself Astro 7
executable evidence. Versioned declarations and emitted package
implementation were separately inspected for **7.1.6** and
**7.4.8**; current upstream source at
`1999c842f8c9e2cd577207550359941f6a2e5691` declares Astro
**7.4.8**. [Package metadata][astro-package], [7.1.6
declarations][types-716], [7.4.8 declarations][types-748].

| Surface                                                                                               | Status and precise limit                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `astro:routes:resolved`; `astro:build:setup.pages`                                                    | Public route metadata and documented `PageBuildData` fields, including component/module specifier. Useful inputs to native compilation; not already deployable route handlers. [Reference][integrations].                                                                                                                                          |
| `astro:build:ssr`                                                                                     | Public `manifest: SerializedSSRManifest`, `middlewareEntryPoint`, `logger`. Routes/component metadata are public. Neither inspected Astro 7 declaration has the old route `entryPoints` map. [Reference][integrations], [7.1.6][types-716], [7.4.8][types-748].                                                                                    |
| Runtime `SSRManifest.pageMap`, `pageModule`, `serverIslandMappings`, `renderers`, `middleware`        | Documented runtime object fields. They are not categorically private. But a documented shape does not imply the serialized build callback supplies compiled callable values for every field. [Reference][integrations].                                                                                                                            |
| `middlewareEntryPoint` acquisition                                                                    | Public emitted file URL when edge middleware is selected. Both inspected Astro 7 manifest builders supply it only for edge mode. It is not a classic-middleware discovery URL. [7.1.6 builder][builder-716], [7.4.8 builder][builder-748].                                                                                                         |
| `serverEntrypoint`, custom Vite inputs, `createApp()`                                                 | Public entrypoint construction and standard Request/Response runtime. Documented `createApp` options configure streaming, not route selection. [Adapter reference][adapter], [App reference][app].                                                                                                                                                 |
| Deprecated `entrypointResolution: explicit` / `createExports`                                         | Documented compatibility path accepting the compiled runtime manifest. The inspected implementation passes the full manifest; it does not create a per-route compiler partition. Deprecation is not the same as absence. [Migration][migration-6], [7.4.8 legacy entry][legacy-748].                                                               |
| Parsing emitted `pageMap` / `serverIslandMap` identifiers, `$n` aliases and loader declaration syntax | Knowledge of a generated representation, not guaranteed by the runtime field documentation. Public fields do not promise variable names, chunk placement or syntax. [Page-map generator][pages-source], [existing output audit][design].                                                                                                           |
| `virtual:astro:middleware`, `virtual:astro:renderers`, compiler plugin `api.buildPostHook`            | Inspected internal acquisition/lifecycle details; no documented adapter extension contract was found for these IDs/APIs. Public middleware/renderer registration does not document their compiled virtual modules. [Loader evidence](native-app-loader-expansion.md#acquiring-the-compiled-chain-and-renderer), [builder source][manifest-source]. |

There is an important docs/source mismatch to avoid: the SSR hook
reference's introductory prose still mentions a map of emitted
entries, but its signature omits that map. The explicit [Astro 6
migration][migration-6] says it was removed, following [Astro 5's
`functionPerRoute` deprecation][migration-5]. Astro 5
standardized the default single app entry behavior; it did not
make separate deployable functions automatic. The Astro 7
signatures corroborate the removal.

## Current adapter comparison: follow the entry and its loaders

The four official adapters below were inspected at the **same
upstream commit** `1999c842f8c9e2cd577207550359941f6a2e5691`
(2026-11-10). Versions and Astro peer ranges come from that
commit's package metadata, not assumptions about this project's
locked dependencies. These are source findings, not newly
executed provider deployments.

| Adapter snapshot                     | Entry, loader and packaging wiring                                                                                                                                                                                                                                                                                                                                                                                                                     | What it proves for separate functions                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node **11.1.11**, peer `^7.2.1`      | `serverEntrypoint: @astrojs/node/server.js`; `server.ts` calls `createApp()` once and exports middleware/standalone handlers. [Integration][node-index], [runtime][node-server], [metadata][node-package].                                                                                                                                                                                                                                             | Common App/server output. No per-route deployable-function loop in this integration.                                                                                                                   |
| Vercel **11.0.20**, peer `^7.0.0`    | One configured server entry calls `createApp()`. The builder traces/copies `entryFile` using NFT into `_render.func`. ISR adds `_isr` **from the same entry**; edge middleware uses the public middleware URL and a separate edge bundle. Route definitions select these destinations. [Build/configuration][vercel-index], [runtime][vercel-entry], [tracing][vercel-nft], [metadata][vercel-package].                                                | Shared SSR App, with distinct ISR/middleware roles; not per-route App code exclusion. `buildServerlessFolder` receiving a function name does not establish a unique loader graph.                      |
| Netlify **8.2.12**, peer `^7.0.0`    | `@astrojs/netlify/ssr-function.js` calls `createApp()`. One NFT-traced entry is copied into `.netlify/v1/functions/ssr`; generated `ssr.mjs` declares `path: /*`, `preferStatic: true`, `nodeBundler: none`. Optional edge middleware uses `middlewareEntryPoint` and its own Rolldown build. [Build/configuration][netlify-index], [runtime][netlify-entry], [tracing][netlify-nft], [metadata][netlify-package].                                     | One site SSR function plus optional middleware function. Native output is packaged after Astro; no route-loader partition is demonstrated.                                                             |
| Cloudflare **14.4.6**, peer `^7.4.0` | The Cloudflare Vite plugin/Wrangler configuration defaults `main` to `@astrojs/cloudflare/entrypoints/server`; its exported `fetch` delegates to a handler holding one `createApp()`. Static assets use the asset binding. A build-time prerender Worker is separately configured. [Integration][cloudflare-index], [Wrangler default][cloudflare-wrangler], [entry][cloudflare-entry], [handler][cloudflare-handler], [metadata][cloudflare-package]. | Default site Worker with common App. A transient prerender Worker or user auxiliary Worker is not an isolated function per Astro route. Custom `main` is allowed; this row describes adapter defaults. |

The common factory's inspected implementation imports the global
compiled manifest and constructs `App` from it in both
[7.1.6][entry-716] and [7.4.8][entry-748]. The [native page-map
generator][pages-source] creates dynamic component loaders for
the relevant SSR/prerender environment. These native chunks are
useful code splitting; they are not independently configured HTTP
functions:

```text
route metadata -> Astro native component chunks
                    ^ dynamic loaders
shared manifest -> createApp() -> host handler
host adapter -> function directory / server entry / Worker config
```

Vercel/Netlify demonstrate dependency tracing and provider
packaging of native output, not elimination of all post-build
work. Netlify's separate middleware bundle is also not precedent
for silently overriding this repository's
[native-pipeline ADR](../adr/0002-use-astros-build-pipeline-for-runtime-artifacts.md).

### Historical per-route Vercel, and SST's separate role

Vercel **7.8.2**, Astro peer `^4.2.0`, is a genuine historical
counterexample. At release commit
`01e37765a44c5f1a1c017e89dd661b9074b47a90` (2024-10-17),
`functionPerRoute` opted in to native per-route entries. The SSR
hook supplied `entryPoints`; the adapter looped over
non-prerendered entries, called `buildServerlessFolder` for each,
and routed its pattern to that function. The source already
marked the option deprecated. [Historical
implementation][old-vercel]. This shows a supported mechanism
existed then, not that its removed hook map can be used in
Astro 7.

SST is additionally an infrastructure consumer. At SST commit
`b73c4cdb04f4b583a5e392b384036b9390f74a87` (2026-11-10),
`sst.aws.Astro.buildPlan` reads `dist/sst.buildMeta.json` and
configures one optional server at `dist/server/entry.handler`,
plus assets and optional copied 404 HTML. It requires
`astro-sst >=3.1.2`. [Component source][sst]. The registry's
inspected `astro-sst` **3.1.4** source commit
`5c488cc865d5ea0bfca7ea7adde94884645d684b` (2025-05-13) uses
legacy `createExports(manifest)` and `new NodeApp(manifest)` with
one handler. [Adapter][sst-adapter], [runtime][sst-entry]. This
is older adapter provenance, not proof of current Astro 7
compatibility or native per-route isolation.

## Is there a public supported alternative for our requirement?

The requirement includes independently deployable
[_Function Artifacts_](../../GLOSSARY.md#function-artifact) with
necessary code/dependencies and representative shared/separate
Astro response equivalence, not merely several function names.
[Issue #70][partition-issue], [contract evidence][contract].

| Concrete public approach examined                                                           | Meets the full requirement?                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Several native custom inputs, each calling standard `createApp()`; copy each traced closure | Several independently deployable functions are possible. But each factory imports the full manifest; ordinary tracing retains its reachable page/island loaders. This alone does not meet unrelated-code exclusion. [Entrypoint API][adapter], [factory][entry-748].                                                                                                                 |
| Public setup page IDs + structured SSR metadata + exported `App` / documented loader fields | Useful building blocks for selected Apps. They do not deliver generic compiled classic middleware, renderer and island closures through the serialized hook. The existing probe needed private acquisition and failed file exclusion on 7.4.8. That falsifies that recipe, not every future design. [Loader study](native-app-loader-expansion.md), [manifest builder][builder-748]. |
| Public edge `middlewareEntryPoint`                                                          | Supplies that compiled chain in that mode; does not solve selected page/renderer/island graphs, platform edge execution, or error/rewrite dependencies. [Builder][builder-748], [probe](native-app-loader-expansion.md#acquiring-the-compiled-chain-and-renderer).                                                                                                                   |
| Legacy public compiled-manifest callback, selecting `pageMap` at runtime                    | Gives real runtime loaders, but selection happens after the full loader graph has been bundled. Runtime map filtering is not physical file/code exclusion. The legacy entry imports the global manifest before invoking the callback. [Legacy implementation][legacy-748].                                                                                                           |
| Historical `functionPerRoute` / SSR `entryPoints`                                           | Did meet per-route entry production historically; unavailable in inspected Astro 7. [Historical Vercel][old-vercel], [removal][migration-6].                                                                                                                                                                                                                                         |

**Conclusion:** public API use can replace specific compiler
parsing (as #91 already proves), and can create host entries and
package native closures. This audit does not establish a wholly
public, supported Astro 7 recipe satisfying the complete
separate-function requirement in one native build. It also does
not justify calling all output handling private, adopting a
parser/interpreter design, giving up on native output, or
narrowing supported versions. A positive replacement must
establish loader acquisition **and** physical closure **and**
Astro transition/error semantics across the advertised range. The
existing [contract study][contract] already separates those
obligations; no new experiment is claimed here.

## Validation and limits

This change adds only this note. There is no separate change
workflow/CONTRIBUTING file at this base; `AGENTS.md`,
issue-tracker instructions, package scripts and CI provide the
workflow. Project research/context7 instructions were read;
project skills were already restored in this checkout. The
requested PR skill was found in the installed skills checkout and
used for the PR body. No child agents or new checkouts were
created.

Sources were fetched read-only into a disposable directory and
compared at the exact commits/releases listed above. Local
reports were read, not rerun as experiments. No provider build,
cloud invocation, deployment or production test claim follows
from this source audit. Existing `skills-lock.json` modifications
were present at entry, preserved byte for byte, and excluded from
the commit. Validation used Node 26.12.0 and pnpm 10.33.2:

- The new note passes Prettier 3.9.6, reference/relative-link
  checks and `git diff --check`.
- `pnpm format:check` cannot start its formatter in this
  checkout: `node_modules` is absent and `prettier` is not on its
  script path. Running the existing sibling checkout's Prettier
  3.9.6 directly against this repository reports only the
  inherited `skills-lock.json` formatting difference. No
  dependency or lockfile changes were made to remove these setup
  blockers.
- Production tests/builds were not rerun for this documentation
  change. Required CI, including compatibility, beta rehearsal
  and local S3, remains separate completion evidence.

[roadmap]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/30063ba63209a7edd85527f26e09cf9d34e77a28/ROADMAP.md#L86-L112
[direct-issue]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/69
[decision]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/63#issuecomment-5900071837
[design]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/f0ba508a38738d0dc260b70a27848247baa02fb4/docs/research/astro-output-interface.md
[contract]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/ca8aa36ebd100896efc01838917731fd50ca8473/docs/research/rewrite-error-contract.md
[identities]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/91
[direct-adr]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/30063ba63209a7edd85527f26e09cf9d34e77a28/docs/adr/0005-support-direct-and-api-gateway-function-invocation.md
[partition-issue]:
  https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/70
[integrations]:
  https://github.com/withastro/docs/blob/d7657e201db89940b4fbad3704dbb6c0d2b075bf/src/content/docs/en/reference/integrations-reference.mdx
[adapter]:
  https://github.com/withastro/docs/blob/d7657e201db89940b4fbad3704dbb6c0d2b075bf/src/content/docs/en/reference/adapter-reference.mdx
[app]:
  https://github.com/withastro/docs/blob/d7657e201db89940b4fbad3704dbb6c0d2b075bf/src/content/docs/en/reference/modules/astro-app.mdx
[actions]:
  https://github.com/withastro/docs/blob/d7657e201db89940b4fbad3704dbb6c0d2b075bf/src/content/docs/en/guides/actions.mdx
[migration-5]:
  https://github.com/withastro/docs/blob/d7657e201db89940b4fbad3704dbb6c0d2b075bf/src/content/docs/en/guides/upgrade-to/v5.mdx
[migration-6]:
  https://github.com/withastro/docs/blob/d7657e201db89940b4fbad3704dbb6c0d2b075bf/src/content/docs/en/guides/upgrade-to/v6.mdx
[yandex-direct]:
  https://github.com/yandex-cloud/docs/blob/ed5a25cf834aeeacd405bb2cfbe40f39ff4c3807/en/functions/concepts/function-invoke.md#filtering-message-headers-headers
[yandex-gateway]:
  https://github.com/yandex-cloud/docs/blob/ed5a25cf834aeeacd405bb2cfbe40f39ff4c3807/en/api-gateway/concepts/extensions/cloud-functions.md
[astro-package]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/astro/package.json
[pages-source]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/astro/src/vite-plugin-pages/pages.ts
[manifest-source]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/astro/src/core/build/plugins/plugin-manifest.ts
[action-rpc]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/astro/src/actions/runtime/entrypoints/route.ts
[old-vercel]:
  https://github.com/withastro/adapters/blob/01e37765a44c5f1a1c017e89dd661b9074b47a90/packages/vercel/src/serverless/adapter.ts#L322-L378
[sst]:
  https://github.com/sst/sst/blob/b73c4cdb04f4b583a5e392b384036b9390f74a87/platform/src/components/aws/astro.ts#L408-L485
[sst-adapter]:
  https://github.com/sst/astro-sst/blob/5c488cc865d5ea0bfca7ea7adde94884645d684b/packages/astro-sst/src/adapter.ts
[sst-entry]:
  https://github.com/sst/astro-sst/blob/5c488cc865d5ea0bfca7ea7adde94884645d684b/packages/astro-sst/src/entrypoint.ts
[types-716]:
  https://unpkg.com/astro@7.1.6/dist/types/public/integrations.d.ts
[builder-716]:
  https://unpkg.com/astro@7.1.6/dist/core/build/plugins/plugin-manifest.js
[entry-716]:
  https://unpkg.com/astro@7.1.6/dist/core/app/entrypoints/virtual/prod.js
[types-748]:
  https://unpkg.com/astro@7.4.8/dist/types/public/integrations.d.ts
[builder-748]:
  https://unpkg.com/astro@7.4.8/dist/core/build/plugins/plugin-manifest.js
[entry-748]:
  https://unpkg.com/astro@7.4.8/dist/core/app/entrypoints/virtual/prod.js
[legacy-748]:
  https://unpkg.com/astro@7.4.8/dist/entrypoints/legacy.js
[node-index]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/node/src/index.ts
[node-server]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/node/src/server.ts
[node-package]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/node/package.json
[vercel-index]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/vercel/src/index.ts
[vercel-entry]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/vercel/src/serverless/entrypoint.ts
[vercel-nft]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/vercel/src/lib/nft.ts
[vercel-package]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/vercel/package.json
[netlify-index]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/netlify/src/index.ts
[netlify-entry]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/netlify/src/ssr-function.ts
[netlify-nft]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/netlify/src/lib/nft.ts
[netlify-package]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/netlify/package.json
[cloudflare-index]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/cloudflare/src/index.ts
[cloudflare-wrangler]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/cloudflare/src/wrangler.ts
[cloudflare-entry]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/cloudflare/src/entrypoints/server.ts
[cloudflare-handler]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/cloudflare/src/utils/handler.ts
[cloudflare-package]:
  https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/integrations/cloudflare/package.json
