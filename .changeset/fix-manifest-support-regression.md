---
"@astro-yandex-cloud/adapter": patch
---

Remove Function Artifact support claims from the unpublished Deployment Manifest v1 contract and generated output, following #63. Generate the packaged JSON Schema from the source Effect Schema on every build and verify the contract without support claims in clean package consumers.
