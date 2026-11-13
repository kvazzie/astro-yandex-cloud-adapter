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

`artifacts.client.path`, `artifacts.functions[].path`, and
`gatewayTemplate.path` are relative to the manifest directory.
These fields and both `routes.prerendered[].objectKey` and
`routes.notFound[].objectKey` use nonempty,
forward-slash-separated segments. Absolute paths, backslashes,
colons (including Windows drive prefixes and data streams), NUL,
CR, LF, empty segments, and `.` or `..` segments are rejected by
parsing, encoding, and the generated JSON Schema. Hidden names,
Unicode, and spaces within segments are allowed. This is a
lexical path contract; it does not inspect symlinks or guarantee
every filename is supported by every filesystem.

Object keys follow the same spelling as relative files in the
[_Client Artifact_](../../GLOSSARY.md#client-artifact), prefixed
with `base` without its leading slash when `base` is not `/`. For
example, `about/index.html` becomes `docs/about/index.html` for
`base: "/docs"`. These keys are deliberately a narrower contract
than arbitrary Object Storage keys; consumers must not normalize
them or interpret them as URLs before filesystem use.

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
