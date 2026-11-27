---
"@astro-yandex-cloud/adapter": patch
---

Stage npm shrinkwrap pins for runtime dependency preparation. The
public adapter keeps its current resolver, which reads only
`package-lock.json`, until the native modules are activated in
#113.
