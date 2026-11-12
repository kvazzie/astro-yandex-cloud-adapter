---
"@astro-yandex-cloud/adapter": minor
---

Retire `functions: "separate"` and keep the complete native Astro
App in one
[_Function Artifact_](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/1d421b0917a4d5bd4e14f55a484bb6485d2be81c/GLOSSARY.md#function-artifact).
Existing `functions: "shared"` remains accepted. Reject the
retired value in configuration and the unpublished Manifest v1
contract. Remove per-route loader pruning, guards and preview
dispatch; ADR 0013 records the attempted design, upstream removal
and revisit criteria.
