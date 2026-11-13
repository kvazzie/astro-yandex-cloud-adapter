---
"@astro-yandex-cloud/adapter": patch
---

Reject destructured Node module `register` hooks during
[_Function Artifact_](../GLOSSARY.md#function-artifact) planning,
before emitting an artifact with an untracked hook package.
