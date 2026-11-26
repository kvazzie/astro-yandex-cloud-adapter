---
"@astro-yandex-cloud/adapter": patch
---

Runtime-selected loaders, such as a computed call on a module namespace, are
not discovered or rejected at build time and fail at runtime with "Cannot find
module"; use fixed specifiers. Preserve workspace overrides and verify local source ownership and exact versions when
planning runtime dependency installation.
