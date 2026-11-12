# Share the deployment manifest and target catalogue

The
[_Deployment Manifest_](../../GLOSSARY.md#deployment-manifest) is
a contract for the
[_Bare Adapter_](../../GLOSSARY.md#bare-adapter) and independent
[_Deployment Products_](../../GLOSSARY.md#deployment-product).
Give its schema a separate workspace package, and give the shared
[_Target_](../../GLOSSARY.md#target) catalogue its own package.
Consumers must not depend on the adapter to interpret the shared
contract. This follows the product separation in
[ADR 0006](0006-keep-yandex-cloud-astro-products-in-one-monorepo.md)
and
[ADR 0007](0007-use-one-astro-adapter-across-deployment-products.md).

Represent the catalogue as an ordinary numeric `Targets` enum
exported on its declaration. TypeScript does not support
`export default enum`, so use the named `export enum Targets`
declaration. Use TypeScript's automatic numbering, without
explicit numeric assignments. This small package has one source
file, `src/index.ts`, containing the exported enum; no separate
`Targets.ts` or forwarding index is needed. The enumeration
identifies the available variants; execution and build
preparation belong to separate operations. The current
Astro/Vite-specific `TargetBuild` implementation is not part of
this shared enum package.

The adapter builds for the independently defined _Targets_. Its
own modules, files, and declarations name build responsibilities;
`TargetBuild` is its current execution contract. Adapter-owned
`Target` or `ObjectStorageTarget` declarations conflate that work
with the catalogue's concepts. References to imported catalogue
members preserve their external identities. The adapter
implementation now uses `src/TargetBuild/` and concrete
build-role filenames. The local `Options.Target` alias remains a
reference to decoded configuration, with its naming review
outside this source-layout change.

The `Targets` module knows no encoded string representations. The
adapter's [_Options_](../../GLOSSARY.md#options) and the manifest
are independent external contracts, each converting between its
own encoded values and the enum. Their canonical strings should
currently agree as a developer convention; equality of those
strings is not a domain invariant. Choose the manifest-owned
codec: the shared manifest package owns the correspondence table
and exposes its v1 codec through a narrow public export. Adapter
`Options` reuses that codec. A transforming Effect Schema
expresses the conversion with enum members on its `Type` side and
string literals on its `Encoded` side.

The manifest package re-exports the shared catalogue. Adapter
`Options` exposes that same enumeration, and adapter-level
references use the `Options` reference. Other products can obtain
the catalogue through the manifest package. These are aliases of
one enum, not independent copies of target identity: adapter ->
Options -> deployment-manifest -> targets. The adapter therefore
needs no direct dependency on the targets package for this
access. This alias chain does not require model modules to depend
on integration `Options`.

The `Options` reference is internal to the adapter. The adapter's
public entrypoints do not re-export `Targets`; callers supply
encoded string selections. Decoded manifest types still refer to
the shared enum.

Input defaults and option combinations remain in adapter
`Options`. The manifest's decoded value uses the enum, while its
encoded JSON and generated JSON Schema preserve the versioned
string representation. Enum ordinal values are not serialized
into the manifest. The shared manifest package does not import
adapter `Options` to interpret its own data.

The proposed extraction scope includes the schema and inferred
types, synchronous parsing and consistency checks, and generated
JSON Schema. The current parser checks cross-record references
and invariants beyond structural decoding; these checks should
travel with the contract. Artifact inspection, generation, and
filesystem writing remain adapter responsibilities.

The extraction is implemented as private workspace packages
`@astro-yandex-cloud/targets` and
`@astro-yandex-cloud/deployment-manifest`. The adapter bundles
their runtime code and declarations, as it does for the shared
runtime bridge; independent publication remains a separate task.
Existing adapter import paths remain available through facades.
Decoded target types now use the enum; encoded adapter options
and v1 manifest JSON keep their string representation. The
schema-version policy in
[ADR 0004](0004-version-the-deployment-manifest-contract.md)
continues to apply.
