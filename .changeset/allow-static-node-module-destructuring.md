---
"@astro-yandex-cloud/adapter": patch
---

Allow fixed Node module namespace metadata destructuring during
[_Function Artifact_](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/bc184c5891a689768a9fb2fbda1b5596104e38bf/GLOSSARY.md#function-artifact)
planning for both dependency strategies. Keep createRequire
bindings tracked in mixed destructuring patterns so computed
loads and escaped loader bindings remain rejected.
