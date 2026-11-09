---
"@astro-yandex-cloud/adapter": minor
---

Extract the Deployment Manifest contract and target catalogue
into shared workspace packages. Decode target selections to
shared numeric enum members without exposing the Targets
catalogue in the adapter's public API. Add
encodeDeploymentManifest for writing decoded manifests back to
JSON. Encoded adapter options and manifest JSON retain their
string target values; existing manifest import paths remain
available. Preserve malformed URI rejection in the bundled
manifest parser.
