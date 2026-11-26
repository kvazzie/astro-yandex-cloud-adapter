---
"@astro-yandex-cloud/adapter": patch
---

Stage delivery of opted-in local runtime packages as exact npm
archives without registry substitution. The adapter options do
not expose the opt-in yet, so a linked local runtime package
still fails the install build. A staged archive is rejected when
it omits a file the traced runtime loads, or loads a file from
outside its package.
