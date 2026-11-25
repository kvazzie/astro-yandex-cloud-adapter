---
"@astro-yandex-cloud/adapter": patch
---

Preserve the identity of URL-qualified ES modules during
dependency discovery. Apply npm's override path base to local
tarballs and retain shared installed workspace packages when
placing lock-backed dependencies.
