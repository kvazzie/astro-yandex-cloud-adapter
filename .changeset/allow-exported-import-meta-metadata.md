---
"@astro-yandex-cloud/adapter": patch
---

Allow exported non-loader metadata fields from `import.meta`
while preserving rejection of exported metadata objects and
resolvers. Keep
[_Dependency_](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/bc184c5891a689768a9fb2fbda1b5596104e38bf/GLOSSARY.md#dependency)
validation before writing artifacts.
