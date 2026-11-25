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
modules selected by emitted module loads, classifying each import
or require by Node's loader rules, and apply package scopes to
retained .js files. Reject registerHooks, escaping archive
imports and unregistered CommonJS extensions that hide runtime
packages; track loader namespaces through conditionals and rest
copies with unresolved keys. Classify Git lock origins and pnpm
catalog entries by their actual source, apply npm's matched
override range, read PAX entry sizes, and require resolve-only
requests to resolve rather than pack their files. Encode literal
braces in Gateway paths, keep padded greedy parameters unique,
slash extensionless prerendered endpoints under trailingSlash
always, follow image wrappers through re-exports, require the
image endpoint only for real image requests, guard server output
removal against the client output, require a regular entrypoint
file, and keep handler wrappers from shadowing the handler.
