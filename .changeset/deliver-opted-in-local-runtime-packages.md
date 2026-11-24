---
"@astro-yandex-cloud/adapter": patch
---

Deliver opted-in local runtime packages without registry
substitution and preserve loader, lock and image discovery
contexts.

Validate linked package archives against Node’s wildcard export
paths and package-private imports. Check the file selected by a
self-reference, including fallback arrays, and by static wildcard
requests after URL normalization. Allow an omitted manifest only
when the clean artifact preserves its private dependency binding.
