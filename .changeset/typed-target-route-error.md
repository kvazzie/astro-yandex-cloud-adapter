---
"@astro-yandex-cloud/adapter": patch
---

Report incompatible Object Storage runtime routes with a
structured `UnsupportedTargetRouteError` containing the selected
target and route patterns. Preserve the original error as the
Astro hook error's cause at both configuration and build
completion.
