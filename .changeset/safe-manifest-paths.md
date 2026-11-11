---
"@astro-yandex-cloud/adapter": patch
---

Reject Windows absolute paths, drive-relative paths, backslash
traversal, and ambiguous path segments in the _Deployment
Manifest_ artifact paths and Object Storage keys. Require
relative paths with forward slashes in the parser, encoder, and
packaged JSON Schema, and check local preview 404 paths remain
beneath the _Client Artifact_ directory.
