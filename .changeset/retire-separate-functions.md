---
"@astro-yandex-cloud/adapter": minor
---

Retire `functions: "separate"` and keep the complete native Astro
App in one Function Artifact. Existing `functions: "shared"`
remains accepted. Reject the retired value in configuration and
the unpublished Manifest v1 contract. Remove per-route loader
pruning, guards and preview dispatch; ADR 0013 records the
attempted design, upstream removal and revisit criteria.
