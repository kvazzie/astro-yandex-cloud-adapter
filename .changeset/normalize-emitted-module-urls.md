---
"@astro-yandex-cloud/adapter": patch
---

Match Node's file URL resolution when discovering runtime
dependencies. Unresolvable optional local imports no longer
interrupt planning, and empty URL query or fragment markers
preserve the original module identity.
