---
"@astro-yandex-cloud/adapter": patch
---

Include project, integration-injected, and active Astro-internal routes when classifying builds and generating artifacts. Applications configured with Astro `output: "static"` are now classified as Runtime Builds and emit a Function Artifact when features such as server islands require runtime code.
