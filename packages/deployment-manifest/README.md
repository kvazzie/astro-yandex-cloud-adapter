# Shared [_Deployment Manifest_](../../GLOSSARY.md#deployment-manifest) contract

This internal workspace package owns the versioned _Deployment
Manifest_ schema, parsing, consistency checks, encoding, and
generated JSON Schema. It has no dependency on the
[_Bare Adapter_](../../GLOSSARY.md#bare-adapter), Astro, or Vite.

`parseDeploymentManifest` accepts encoded input and returns a
decoded value whose selected [_Target_](../../GLOSSARY.md#target)
is a numeric enum member. `encodeDeploymentManifest` validates
the decoded value and restores the encoded strings for JSON.
`defineDeploymentManifest` provides compile-time checking only.

The root export provides these operations, the schema, types, and
the shared `Targets` enum. `./schema` exposes the schema and
types. `./v1/target-encoding` provides the narrow v1 target codec
and the same enum for consumers such as adapter
[_Options_](../../GLOSSARY.md#options). Importing that subpath
does not load the complete document parser.

The `./deployment-manifest.schema.json` export describes encoded
JSON. Its schema version and identifier follow
[ADR 0004](../../docs/adr/0004-version-the-deployment-manifest-contract.md).
The source extraction and catalogue ownership follow
[ADR 0012](../../docs/adr/0012-share-the-deployment-manifest-and-target-catalogue.md).
