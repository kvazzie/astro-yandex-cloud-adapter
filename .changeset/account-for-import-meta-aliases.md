---
"@astro-yandex-cloud/adapter": patch
---

Track aliases and fixed destructuring of `import.meta.resolve` so
every runtime
[_Dependency_](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/bc184c5891a689768a9fb2fbda1b5596104e38bf/GLOSSARY.md#dependency)
is accounted for before preparing output. Reject dynamic access
and escaped metadata objects before writing an artifact.
