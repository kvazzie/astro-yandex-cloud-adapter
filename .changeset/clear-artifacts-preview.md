---
"@astro-yandex-cloud/adapter": patch
---

Fix `astro preview` resolution from the installed adapter package and preserve local HTTP origins for On-demand Route requests. Serve generated Client Artifacts on both Targets, including Static-only Builds without Function Artifacts.

Serve file-format Prerendered Routes at trailing-slash URLs and return a JavaScript content type for `.mjs` browser assets.
