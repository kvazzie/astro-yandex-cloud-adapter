# Naming algorithm

[GLOSSARY.md](GLOSSARY.md) defines canonical terms, including
[_Domain Errors_](GLOSSARY.md#domain-error). This document
defines how to derive identifiers and source paths from any such
term. Apply the algorithm to new names and explicit renames;
existing identifiers and paths migrate separately.

## Deriving a stem

1. Start with the complete canonical term from its glossary
   definition heading. Keep plurals that are part of the
   canonical term itself. A directory that groups multiple domain
   elements may use the standard English plural of the term to
   describe its contents. Choose that grammatical number before
   applying the remaining steps. Use the complete noun phrase
   without synonyms, abbreviations, or surrounding domain section
   names.
2. Remove a possessive ending, `'s` or `’s`, without creating
   another word. Treat spaces, hyphens, and other punctuation or
   symbols as word separators. A `+` separates words; it does not
   introduce the word "Plus" or "And".
3. Split the result into letter and digit tokens. Lowercase each
   letter token, then capitalise its first letter. This treats
   acronyms like other words. Preserve digit tokens as written.
4. If the term begins with digit tokens, move that leading
   sequence after the remaining tokens, preserving its order. At
   least one letter token is required.
5. Join the tokens without separators to form PascalCase. For
   camelCase, lowercase the first character of the PascalCase
   stem.

For example,
[_API Gateway Modifier_](GLOSSARY.md#api-gateway-modifier)
produces `ApiGatewayModifier` and `apiGatewayModifier`.
[_Serving Artifact's Target_](GLOSSARY.md#serving-artifacts-target)
produces `ServingArtifactTarget` and `servingArtifactTarget`.
[_404 Scope_](GLOSSARY.md#404-scope) produces `Scope404` and
`scope404`.
[_On-demand 404 Page Error_](GLOSSARY.md#on-demand-404-page-error)
produces `OnDemand404PageError` and `onDemand404PageError`; its
number is already after a letter token.

Use the complete derived stem in every context. A namespace or
directory does not permit dropping words or inventing a
contextual abbreviation. If a term produces an ambiguous or
colliding identifier, resolve the vocabulary in the glossary
before introducing the name. Do not maintain a separate list of
overrides.

## Code identifiers and source paths

Use the PascalCase stem for named domain declarations, including
error types, domain declaration files, and module directories,
such as `Options/`. Use the camelCase form for variables,
properties, and functions. Declaration kind still follows the
project's language conventions; a glossary entry does not require
a class or a new file.

Purely organizational directory labels use lowercase. They group
modules by architectural role or participation in scenarios and
do not denote domain declarations. The PascalCase stem rule
continues to apply to the domain modules inside those groups.

A collection directory such as `Hooks/` groups
[_Hooks_](GLOSSARY.md#hook), while an individual element is a
`Hook`. Its module namespace or default export may also use
`Hooks` when it represents the collection. Plural folder names do
not require plural names for their individual elements.

A concrete error name must identify its established category.
Determine responsibility before naming it; membership in the
catalogue does not prove that it is a _Domain Error_. Include the
category in the canonical glossary name before deriving the
identifier; the `Errors` namespace does not replace it. Preserve
it in derived identifiers and paths rather than appending an
undocumented prefix or suffix during translation.

In this context, concrete _Domain Error_ names end in `Error`.
That category word is part of each concrete canonical term; the
abstract category name does not add `Domain` to it. For example,
[_Unsupported Target Route Error_](GLOSSARY.md#unsupported-target-route-error)
produces `UnsupportedTargetRouteError`. The distinct categories
[_Rejection_](GLOSSARY.md#rejection) and
[_Failure_](GLOSSARY.md#failure) keep their full canonical names.

For
[_Artifact Write Failure_](GLOSSARY.md#artifact-write-failure),
the derived forms are `ArtifactWriteFailure` and
`artifactWriteFailure`. A declaration file would be
`ArtifactWriteFailure.ts`; a module directory would be
`ArtifactWriteFailure/`. The domain's `Errors` subsection and a
code namespace do not add an `Error` prefix or suffix. Add such a
word only if it belongs to the canonical term.

Keep domain rules and behaviour-defining data visible, including
internal domain validation and default
[_Options_](GLOSSARY.md#options). Expressing a rule through a
framework schema does not make it technical. Error representation
through a framework does not change its domain responsibility.

Use a dot-prefix for technical implementation. Named technical
declarations and module directories use PascalCase, such as
`.Tag.ts` and `.SchemaHelpers/`. Helper files use camelCase, such
as `.schemaHelpers.ts`. A dot-prefix identifies technical
responsibility. Public access follows module exports.

Allocate files by domain responsibility. Namespace properties and
small type aliases do not each require their own file. Shared
modules belong where their callers can depend on them according
to the project's module conventions.

## Unique filenames and directory names within a package

Domain filenames and directory names are unique within each
package or application under `packages/` or `apps/`, regardless
of their parent directory. Compare complete file basenames,
including extensions, and directory basenames. In particular,
`src/Options/` and `src/model/Options/` cannot coexist in one
package. Different packages may reuse a name. Technical files and
directories are exempt; technical files include `index.ts`,
`Errors.ts`, shared helpers, and configuration files. Generated
output and third-party dependencies are outside this rule.

Choose names that distinguish responsibilities. For example,
[_Object Storage Target Options_](GLOSSARY.md#object-storage-target-options)
produces `ObjectStorageTargetOptions.ts`. The adapter consumes
independently defined [_Targets_](GLOSSARY.md#target); its own
declarations name the work performed for them. `TargetBuild` is
the current build contract. The
[_Target Build_](GLOSSARY.md#target-build) role and its concrete
variants give the implementation filenames
`ObjectStorageTargetBuild.ts` and
`ObjectStorageCloudFunctionsTargetBuild.ts`. Its Effect Tag lives
in the private technical file `TargetBuild/.Tag.ts`.
Adapter-owned modules, files, and declarations named `Target` or
`ObjectStorageTarget` incorrectly claim the external concept.
References to imported catalogue members retain their external
names. A folder name alone must not carry the distinction between
input options and build behaviour.

Directory modules use `index.ts` as their entrypoint. A module's
error collection uses `Errors.ts` and is exposed by its index as
namespace `Errors`. Repeating these technical filenames is
expected; each concrete domain declaration still uses its
complete canonical name. Consumers import the owning directory
module.

Keep ecosystem-mandated filenames such as `package.json` and
`tsconfig.json` in their prescribed forms. External protocol
identifiers retain their prescribed spellings. Framework concepts
such as Tag and Ref belong in implementation documentation.
