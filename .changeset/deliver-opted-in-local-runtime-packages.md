---
"@astro-yandex-cloud/adapter": patch
---

Deliver opted-in local runtime packages as exact npm archives
without registry substitution. Reject an archive that omits a
file the traced runtime loads, or that loads a file from outside
its package.
