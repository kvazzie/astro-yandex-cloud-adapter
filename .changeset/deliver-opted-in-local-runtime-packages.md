---
"@astro-yandex-cloud/adapter": patch
---

Deliver opted-in local runtime packages without registry
substitution and preserve loader, lock and image discovery
contexts.

Validate linked package archives against Node’s wildcard export
paths and package-private imports. Check the file selected by a
self-reference, including fallback arrays, and by static wildcard
requests after URL normalization. Allow an omitted manifest only
when the clean artifact preserves its private dependency binding.
Validate legacy subpath requests using the emitted loader,
preserve CommonJS private import errors, and follow private
targets into their selected dependency archives.

Preserve directory-only CommonJS lookups and the loader mode of
resolver aliases. Reject missing private dependency bindings and
retain Node’s terminal errors for invalid wildcard captures.
Preserve missing-module fallbacks for private imports and accept
fixed bracket access to the CommonJS resolver. Validate directory
import errors and relative CommonJS resolver targets against the
artifact, and skip files during installed package directory
lookup. Preserve directory errors for package-root imports and
distinguish URL-only resolution. Follow retained CommonJS
directory entrypoints. Determine whether extensionless files are
modules from their load references. Preserve package-root
directory errors, accept BOMs in retained manifests, and validate
bare CommonJS directory requests. Preserve runtime fallbacks for
invalid extensionless dynamic imports and accept BOMs in
installed and archived manifests. Reject extensionless CommonJS
modules selected by emitted module loads.
