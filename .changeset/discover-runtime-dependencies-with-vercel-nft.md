---
"@astro-yandex-cloud/adapter": patch
---

Stage Function Artifact runtime dependency discovery with
`@vercel/nft`, as Astro's Vercel and Netlify adapters do, instead of
a custom loader analysis. The public adapter keeps its current
import scanner until the native modules are activated in #113.
Once active, loads that static tracing cannot follow are not
discovered and fail at runtime, and the staged
`includeDependencies` option pins such packages for
`dependencyStrategy: "install"`. See ADR 0011.
