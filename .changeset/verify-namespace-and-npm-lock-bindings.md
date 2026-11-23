---
"@astro-yandex-cloud/adapter": patch
---

Preserve Node's namespace binding behavior when discovering runtime dependencies. Match npm's workspace override rules and verify that locked local dependencies match their installed sources before archiving them.
