---
"@astro-yandex-cloud/adapter": patch
---

Use Astro's completed-build asset ownership to reconcile
prerendered pages. Overlapping named and rest routes now retain
their actual emitting routes, including custom
[_404 Scopes_](../GLOSSARY.md#404-scope), without changing
Astro's conflict winner. Report missing or conflicting page
emitter evidence instead of guessing.
