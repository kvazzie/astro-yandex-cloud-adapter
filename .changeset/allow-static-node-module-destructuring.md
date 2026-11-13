---
"@astro-yandex-cloud/adapter": patch
---

Allow fixed Node module namespace metadata destructuring during
[_Function Artifact_](../GLOSSARY.md#function-artifact) planning
for both dependency strategies. Keep createRequire bindings
tracked in mixed destructuring patterns so computed loads and
escaped loader bindings remain rejected.
