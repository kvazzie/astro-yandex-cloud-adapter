---
"@astro-yandex-cloud/adapter": patch
---

Preserve selected installed dependency contexts, npm's wildcard
choice, and optional bundled declarations. Detect local archives
that omit statically referenced runtime files, including files
selected by URL-decoded export patterns, Node's default import
and require conditions, CommonJS file and directory lookups, and
local package-private imports. Validate relative URL assets based
on import.meta as payload, check alternate percent escapes for
wildcard exports, preserve the resolution scope of bare imports,
and preserve runtime distinctions between exact and patterned
exports, installed and packed import scopes, and CommonJS loader
initializers. Report unpinned external peers of tarball-owned
bundles during planning. Recognize fixed bracket-form loader URLs
and namespace-qualified Astro image calls through their import
bindings.
