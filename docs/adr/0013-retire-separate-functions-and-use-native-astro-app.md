# Retire separate functions and keep one native Astro App

Accepted on 2026-11-10. A
[_Runtime Build_](../../GLOSSARY.md#runtime-build) for the
[_Object Storage + Cloud Functions Target_](../../GLOSSARY.md#object-storage--cloud-functions-target)
produces one complete
[_Function Artifact_](../../GLOSSARY.md#function-artifact) from
Astro's native App. We retire `functions: "separate"`, per-route
functions, and adapter-owned route-loader pruning rather than
reimplement Astro's removed `functionPerRoute` splitting.
Preserving Astro behavior takes priority over route-level code
isolation.

## Why this was considered and rejected

Separate functions were implemented under
[issue #70](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/70)
to give each route an independently deployable artifact with only
its required runtime code and dependencies. This was a real
attempt, not an untried idea or a deferred feature. The earlier
promise of shared/separate response equivalence is superseded by
this decision: only the complete shared App is supported.

Astro originally supplied per-route compiler entrypoints through
`functionPerRoute`.
[Astro PR #11714](https://github.com/withastro/astro/pull/11714)
removed the option **and the splitting logic** for Astro 5. Its
[release explanation](https://github.com/withastro/astro/blob/1999c842f8c9e2cd577207550359941f6a2e5691/packages/astro/CHANGELOG-v5.md#L3285-L3291)
records three reasons: most route code was shared, larger hosting
size limits reduced the benefit, and the approach could hit
function-count limits and did not work with request rewrites or
i18n domains.
[Astro 6 removed the remaining empty SSR `entryPoints` map](https://docs.astro.build/en/guides/upgrade-to/v6/#removed-entrypoints-on-astrobuildssr-hook-integration-api).
These are upstream reasons, not measured Yandex performance
claims.

Our production
[rewrite/error investigation](../research/rewrite-error-contract.md)
confirmed corresponding compatibility defects on Astro 7.1.6 and
7.4.8: rewrites into a neighboring route lost its loader (D1),
and exceptions could lose the existing `/500` or rest error-route
loader (D2). An initial route guard and a correct incoming
Gateway destination do not supply code needed by subsequent
internal Astro transitions.
[Earlier selected-App experiments](../research/native-app-loader-expansion.md)
also exposed version-sensitive file-closure problems. Those
experiments and the production observations concern different
graphs; neither is proof that every possible per-route design is
impossible.

The
[public-API and adapter audit in PR #99](https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/99)
found that current official adapters retain a complete App behind
a server entry, shared SSR function, or site Worker. Extra ISR
and edge middleware functions do not demonstrate isolated
per-route code. Documented hook and runtime manifest fields
remain public API; this rejection is not based on calling all
output metadata private.

## Consequences

```text
native Astro build -> complete App + all emitted runtime files
                   -> one Function Artifact -> Astro rendering
```

- A [_Static-only Build_](../../GLOSSARY.md#static-only-build)
  still emits no function. All required
  [_On-demand Routes_](../../GLOSSARY.md#on-demand-route) of a
  _Runtime Build_ reference the same artifact.
- `functions: "shared"` remains an optional compatibility
  spelling; `functions: "separate"` is rejected by configuration
  and the draft
  [_Deployment Manifest_](../../GLOSSARY.md#deployment-manifest)
  schema. Multiple _Function Artifacts_ are rejected. The
  unpublished v1 contract is narrowed before publication, not
  reinterpreted as accepting legacy separate builds.
- No route-loader pruning, per-route handler allowlist or preview
  dispatcher is retained as a dormant alternative. Native code
  splitting into chunks remains Astro's responsibility.
- Ordinary rewrites and error rendering use the complete App's
  loaders; the adapter does not add cross-function HTTP dispatch,
  runtime refusal, or a universal exception-to-500 override.
  Outer HTTP fault handling and configurable fallback scope are
  separate concerns, not implemented by removing partitioning.
- The
  [_API Gateway Modifier_](../../GLOSSARY.md#api-gateway-modifier)
  remains required for on-demand pages, Actions and internal
  routes under
  [ADR 0005](0005-support-direct-and-api-gateway-function-invocation.md).
  Direct invocation remains limited to stateless user endpoints.
  This decision does not remove Gateway or staged Pulumi URL
  outputs.
- Earlier research, recipes and recorded results are retained as
  historical evidence. Their `separate` examples no longer
  describe supported options. Partition-selection portions of the
  conditional design in PR #97 need reassessment; its read-only
  runtime inspection question is independent.

## Before proposing separate functions again

Search terms: separate functions, per-route functions, function
per route, `functionPerRoute`, `functions: "separate"`,
partitioning, selected App. Start with this ADR, issue #70, the
D1/D2 production evidence and
[the native pipeline investigation](../research/native-build-pipeline.md).
Do not restart the same parser/pruning experiments without a new
variable.

Reconsider only with a concrete workload and measured benefit
that justify its cost, and new upstream support or an evidenced
design that preserves rewrites, error routes, middleware,
renderers, islands and advertised-version compatibility.
Independently prove deployability and necessary file closure;
several functions containing the full App do not establish code
isolation. A return to this feature requires an explicit decision
superseding this ADR.
