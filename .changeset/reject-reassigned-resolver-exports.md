---
"@astro-yandex-cloud/adapter": patch
---

Reject exported `import.meta.resolve` keys independently of later
variable initializers. Validate simple and destructured loader
initializers against their binding roles so role-changing `var`
reinitialization cannot hide a runtime
[_Dependency_](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/bc184c5891a689768a9fb2fbda1b5596104e38bf/GLOSSARY.md#dependency).
Preserve bare declarations and reinitialization with the same
loader role.
