---
"@astro-yandex-cloud/adapter": patch
---

Extract HTTP invocation translation into a private
framework-neutral workspace package bundled into the adapter.
Keep Astro rendering, locals, build integration, and 404 handling
in the adapter; preserve the generated handler and public runtime
types.
