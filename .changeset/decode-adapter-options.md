---
"@astro-yandex-cloud/adapter": patch
---

Decode adapter options through the integration's Effect Schema before resolving the build plan. Invalid option values now report the integration options error with schema details in its cause; defaults and option compatibility checks are preserved.
