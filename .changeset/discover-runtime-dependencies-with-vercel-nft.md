---
"@astro-yandex-cloud/adapter": patch
---

Discover Function Artifact runtime dependencies with `@vercel/nft`,
as Astro's Vercel and Netlify adapters do, instead of a custom
loader analysis. Loads that static tracing cannot follow are not
discovered and fail at runtime. The `includeDependencies` option
that pins such packages for `dependencyStrategy: "install"` is
staged and not yet accepted by the adapter options. See ADR 0011.
