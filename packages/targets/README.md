# Shared [_Target_](../../GLOSSARY.md#target) catalogue

This internal workspace package defines the numeric enum for
_Targets_. Its only source file is `src/index.ts`. It contains no
encoded names or build policies.

Consumers use the named `Targets` export. The
[_Deployment Manifest_](../../GLOSSARY.md#deployment-manifest)
package re-exports the same enum and owns its versioned string
encoding.
