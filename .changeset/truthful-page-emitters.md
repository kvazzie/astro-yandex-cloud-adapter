---
"@astro-yandex-cloud/adapter": patch
---

Use Astro's completed-build asset ownership to reconcile
prerendered pages. Overlapping named and rest routes now retain
their actual emitting routes, including custom 404 scopes,
without changing Astro's conflict winner. Report missing or
conflicting page emitter evidence instead of guessing.
