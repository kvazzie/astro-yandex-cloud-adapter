---
"@astro-yandex-cloud/adapter": patch
---

Stage completed-build route planning and API Gateway template
generation. The public adapter keeps its current route planning
until the native modules are activated in #113. Once active, the
template keeps Astro's route priority where routes overlap,
serves prerendered pages at their canonical URLs, and finds image
and server-island requests by parsing emitted HTML with parse5 as
a browser reads it.
