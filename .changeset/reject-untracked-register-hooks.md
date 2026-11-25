---
"@astro-yandex-cloud/adapter": patch
---

Reject destructured Node module `register` hooks during
[_Function Artifact_](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/bc184c5891a689768a9fb2fbda1b5596104e38bf/GLOSSARY.md#function-artifact)
planning, before emitting an artifact with an untracked hook
package.
