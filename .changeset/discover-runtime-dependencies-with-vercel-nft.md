---
"@astro-yandex-cloud/adapter": patch
---

Discover Function Artifact runtime dependencies with `@vercel/nft`,
as Astro's Vercel and Netlify adapters do, instead of a custom
loader analysis. Loads that static tracing cannot follow are not
discovered; list such packages in the new `includeDependencies`
option for `dependencyStrategy: "install"`. See ADR 0011.
