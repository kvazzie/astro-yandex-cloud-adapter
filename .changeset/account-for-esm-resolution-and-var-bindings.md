---
"@astro-yandex-cloud/adapter": patch
---

Keep
[_Dependency_](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/bc184c5891a689768a9fb2fbda1b5596104e38bf/GLOSSARY.md#dependency)
metadata complete for fixed `import.meta.resolve` package assets
and runtime loader bindings followed by uninitialized `var`
redeclarations. Reject unaccounted resolver arguments before
writing an artifact.
